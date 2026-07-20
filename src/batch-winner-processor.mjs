import { saveEvaluatedCandidate } from './candidate-collector.mjs';
import { sliceLongDetailImagesForDraft } from './image-slicer.mjs';
import { applyProductAnalysis, getLatestAnalysisRun, runProductAnalysis } from './product-analysis-orchestrator.mjs';
import { generateDetailImageSet, generateMainImage } from './manual-ai/codex-image-runner.mjs';
import { findDraftBySupplierProductNo, linkDraftToBatch, updateBatchCandidateStatus } from './batch-run-store.mjs';

const QUOTA_LOG_PATTERN = /rate.?limit|usage limit|quota exceeded|429/i;

// Only these 4 analysis fields are ever requested for auto-apply.
// manufacturer/countryOfOrigin/handlingPrecautions are deliberately never
// included here -- "법적/인증 정보는 자동 확정 금지" -- they stay in the
// analysis run for a human to review and apply manually later via the
// existing admin UI, exactly like any manually-created draft.
const AUTO_APPLY_FIELDS = { material: true, dimensions: true, searchTags: true, colors: true };

function isQuotaLimited(codeOrLog) {
  return QUOTA_LOG_PATTERN.test(String(codeOrLog || ''));
}

// One winner candidate, start to finish: draft creation-or-reuse ->
// detail-image slicing -> Python/Codex analysis -> safe-field auto-apply ->
// main image -> detail image set -> awaiting_image_approval. Every step
// updates batch_run_candidates.processing_status so a partial failure is
// visible in the admin UI without needing to re-read logs. Never calls any
// Coupang/Naver API, never approves an image, never touches draft
// 27/46/64 (a different supplier_product_no by construction -- dedup would
// skip this candidate entirely if it ever collided).
//
// "draft 생성 또는 기존 draft 재사용": candidateRow.draftId is only ever set
// by THIS function's own earlier updateBatchCandidateStatusImpl call (once
// draft_created fires), so its presence means this exact candidate already
// has its own draft from a prior attempt (e.g. resumed the next day after a
// quota pause) -- reuse it directly rather than running the dedup check,
// which would otherwise wrongly treat the candidate's own draft as a
// collision with itself and report a false skipped_duplicate.
export async function processWinnerCandidate(db, candidateRow, {
  rootDir,
  jobDir,
  codexConfig,
  pythonConfig,
  jobPathsConfig = {},
  batchRunId,
  saveEvaluatedCandidateImpl = saveEvaluatedCandidate,
  findDraftBySupplierProductNoImpl = findDraftBySupplierProductNo,
  linkDraftToBatchImpl = linkDraftToBatch,
  updateBatchCandidateStatusImpl = updateBatchCandidateStatus,
  sliceLongDetailImagesForDraftImpl = sliceLongDetailImagesForDraft,
  runProductAnalysisImpl = runProductAnalysis,
  getLatestAnalysisRunImpl = getLatestAnalysisRun,
  applyProductAnalysisImpl = applyProductAnalysis,
  generateMainImageImpl = generateMainImage,
  generateDetailImageSetImpl = generateDetailImageSet,
} = {}) {
  let draftId = candidateRow.draftId || null;

  if (!draftId) {
    const existingDraftId = await findDraftBySupplierProductNoImpl(db, candidateRow.supplierProductNo);
    if (existingDraftId) {
      await updateBatchCandidateStatusImpl(db, candidateRow.id, {
        processingStatus: 'failed',
        failureStage: 'draft_creation',
        failureMessage: `이미 존재하는 draft(#${existingDraftId})와 동일한 supplier_product_no -- 중복 생성 건너뜀`,
      });
      return { outcome: 'skipped_duplicate', draftId: existingDraftId };
    }

    const saved = await saveEvaluatedCandidateImpl(db, candidateRow.rawCandidateJson, {
      importBatchId: `auto-batch-${batchRunId}`,
      collectedAt: new Date().toISOString(),
    });
    if (!saved.saved) {
      await updateBatchCandidateStatusImpl(db, candidateRow.id, {
        processingStatus: 'failed',
        failureStage: 'draft_creation',
        failureMessage: saved.error?.message || 'draft 생성 실패',
      });
      return { outcome: 'failed', stage: 'draft_creation' };
    }
    draftId = saved.draftId;
    await linkDraftToBatchImpl(db, draftId, { batchRunId, batchCandidateId: candidateRow.id });
    await updateBatchCandidateStatusImpl(db, candidateRow.id, { processingStatus: 'draft_created', draftId });
  }

  // Best-effort: analysis's own NO_DETAIL_IMAGES check is the authoritative
  // "원본 이미지 부족" failure signal below, so a slicing hiccup here isn't
  // itself fatal to the candidate.
  await sliceLongDetailImagesForDraftImpl(db, draftId, { rootDir }).catch(() => {});

  await updateBatchCandidateStatusImpl(db, candidateRow.id, { processingStatus: 'analysis_running' });
  // Resume case: if a prior attempt on this same draft already completed
  // analysis successfully (e.g. the quota limit hit during image
  // generation instead), reuse that result rather than spending another
  // round of Codex analysis calls re-doing work that already succeeded.
  const priorRun = await getLatestAnalysisRunImpl(db, draftId);
  const run = priorRun?.status === 'success' ? priorRun : await runProductAnalysisImpl({ db, rootDir, draftId, codexConfig, pythonConfig, jobPathsConfig });
  if (run.status !== 'success') {
    const failureMessage = run.errorMessage || run.codexErrorMessage || run.pythonErrorMessage || run.errorCode || 'analysis failed';
    await updateBatchCandidateStatusImpl(db, candidateRow.id, {
      processingStatus: 'failed',
      failureStage: 'analysis',
      failureMessage,
      pythonRan: run.pythonStatus === 'success',
      codexRan: run.codexStatus === 'success',
    });
    const quotaLimited = run.codexErrorCode === 'CODEX_RATE_LIMIT' || isQuotaLimited(run.errorMessage);
    return { outcome: 'failed', stage: 'analysis', draftId, errorCode: run.errorCode, quotaLimited };
  }
  const unresolvedFieldsCount = run.mergedAnalysis?.unresolvedFields?.length ?? 0;
  await updateBatchCandidateStatusImpl(db, candidateRow.id, {
    processingStatus: 'analysis_completed',
    pythonRan: run.pythonStatus === 'success',
    codexRan: true,
    unresolvedFieldsCount,
  });

  // Never invented, never legally sensitive -- applyProductAnalysis's own
  // gate (confidence/evidence/conflict) still decides what actually lands;
  // this only requests the 4 safe fields, never manufacturer/countryOfOrigin.
  await applyProductAnalysisImpl(db, draftId, { runId: run.id, fields: AUTO_APPLY_FIELDS }).catch(() => {});

  await updateBatchCandidateStatusImpl(db, candidateRow.id, { processingStatus: 'image_generation_running' });

  let mainImageResult;
  try {
    mainImageResult = await generateMainImageImpl(db, rootDir, jobDir, draftId, { codexConfig });
  } catch (error) {
    await updateBatchCandidateStatusImpl(db, candidateRow.id, {
      processingStatus: 'failed',
      failureStage: 'image_generation_main',
      failureMessage: error.message,
      mainImageGenerated: false,
    });
    return { outcome: 'failed', stage: 'image_generation_main', draftId, errorCode: error.code, quotaLimited: isQuotaLimited(error.log) };
  }

  try {
    await generateDetailImageSetImpl(db, rootDir, jobDir, draftId, { codexConfig });
  } catch (error) {
    await updateBatchCandidateStatusImpl(db, candidateRow.id, {
      processingStatus: 'failed',
      failureStage: 'image_generation_detail',
      failureMessage: error.message,
      mainImageGenerated: true,
      detailImagesGeneratedCount: error.actualCount ?? null,
    });
    return { outcome: 'failed', stage: 'image_generation_detail', draftId, errorCode: error.code, quotaLimited: isQuotaLimited(error.log) };
  }

  await updateBatchCandidateStatusImpl(db, candidateRow.id, {
    processingStatus: 'awaiting_image_approval',
    mainImageGenerated: true,
    detailImagesGeneratedCount: 10,
  });
  return { outcome: 'success', draftId, mainImageResult };
}
