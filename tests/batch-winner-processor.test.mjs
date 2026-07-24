import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareCandidateDraft, processWinnerCandidate } from '../src/batch-winner-processor.mjs';

function candidateRow(overrides = {}) {
  return {
    id: 11,
    supplierProductNo: '99999',
    rawCandidateJson: { productNo: '99999', raw: { a: 1 }, normalized: { name: '테스트 상품' }, filter: { filterStatus: 'pass' }, prices: {} },
    ...overrides,
  };
}

function prepareBaseDeps(overrides = {}) {
  const statusUpdates = [];
  return {
    batchRunId: 5,
    rootDir: '/repo',
    findDraftBySupplierProductNoImpl: async () => null,
    saveEvaluatedCandidateImpl: async () => ({ saved: true, draftId: 501, dbAction: 'inserted' }),
    linkDraftToBatchImpl: async () => {},
    updateBatchCandidateStatusImpl: async (_db, candidateId, patch) => { statusUpdates.push({ candidateId, ...patch }); return null; },
    sliceLongDetailImagesForDraftImpl: async () => ({ checked: 1, longImages: 1, generatedSlices: 3, failed: 0, failures: [] }),
    statusUpdates,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  const statusUpdates = [];
  return {
    rootDir: '/repo',
    jobDir: '/repo/data/jobs',
    updateBatchCandidateStatusImpl: async (_db, candidateId, patch) => { statusUpdates.push({ candidateId, ...patch }); return null; },
    getLatestAnalysisRunImpl: async () => null,
    runProductAnalysisImpl: async () => ({ status: 'success', pythonStatus: 'success', codexStatus: 'success', mergedAnalysis: { unresolvedFields: ['manufacturer'] } }),
    applyProductAnalysisImpl: async () => ({ appliedFields: ['material', 'dimensions'], blockedFields: [{ field: 'manufacturer', reason: 'NO_EVIDENCE_LEGAL_FIELD' }] }),
    generateMainImageImpl: async () => ({ result: { id: 1 }, generatedFileCount: 1 }),
    generateDetailImageSetImpl: async () => ({ result: { id: 1 }, generatedFileCount: 10 }),
    statusUpdates,
    ...overrides,
  };
}

test('prepareCandidateDraft skips (never creates a draft) when a draft with the same supplier_product_no already exists', async () => {
  const deps = prepareBaseDeps({ findDraftBySupplierProductNoImpl: async () => 27 });
  let createCalled = false;
  const outcome = await prepareCandidateDraft({}, candidateRow(), {
    ...deps,
    saveEvaluatedCandidateImpl: async () => { createCalled = true; return { saved: true, draftId: 999 }; },
  });
  assert.equal(outcome.outcome, 'skipped_duplicate');
  assert.equal(outcome.draftId, 27);
  assert.equal(createCalled, false);
  assert.equal(deps.statusUpdates[0].failureStage, 'draft_creation');
});

test('prepareCandidateDraft reuses its own already-created draft on resume instead of running the dedup check (which would wrongly report a duplicate)', async () => {
  let dedupCalled = false;
  let createCalled = false;
  const deps = prepareBaseDeps({
    findDraftBySupplierProductNoImpl: async () => { dedupCalled = true; return 117; }, // would be a false positive if ever consulted
    saveEvaluatedCandidateImpl: async () => { createCalled = true; return { saved: true, draftId: 999 }; },
  });
  const outcome = await prepareCandidateDraft({}, candidateRow({ draftId: 117 }), deps);
  assert.equal(dedupCalled, false);
  assert.equal(createCalled, false);
  assert.equal(outcome.outcome, 'ready');
  assert.equal(outcome.draftId, 117);
  // draft_created is never re-emitted on resume -- it already fired on the prior attempt.
  assert.ok(!deps.statusUpdates.some((u) => u.processingStatus === 'draft_created'));
});

test('prepareCandidateDraft creates a draft, links it to the batch, and slices detail images', async () => {
  const deps = prepareBaseDeps();
  const outcome = await prepareCandidateDraft({}, candidateRow(), deps);
  assert.equal(outcome.outcome, 'ready');
  assert.equal(outcome.draftId, 501);
  assert.deepEqual(deps.statusUpdates.map((u) => u.processingStatus).filter(Boolean), ['draft_created']);
});

test('processWinnerCandidate throws if called without a prepared draftId', async () => {
  await assert.rejects(
    () => processWinnerCandidate({}, candidateRow(), baseDeps()),
    (error) => error.code === 'DRAFT_NOT_PREPARED',
  );
});

test('processWinnerCandidate skips re-running analysis on resume when a prior attempt on this draft already completed it successfully', async () => {
  let analysisCalled = false;
  const deps = baseDeps({
    getLatestAnalysisRunImpl: async () => ({ id: 9, status: 'success', pythonStatus: 'success', codexStatus: 'success', mergedAnalysis: { unresolvedFields: [] } }),
    runProductAnalysisImpl: async () => { analysisCalled = true; return { status: 'success', pythonStatus: 'success', codexStatus: 'success', mergedAnalysis: { unresolvedFields: [] } }; },
  });
  const outcome = await processWinnerCandidate({}, candidateRow({ draftId: 117 }), deps);
  assert.equal(analysisCalled, false);
  assert.equal(outcome.outcome, 'success');
});

test('processWinnerCandidate runs the improvement pipeline end to end and lands on awaiting_image_approval', async () => {
  const deps = baseDeps();
  const outcome = await processWinnerCandidate({}, candidateRow({ draftId: 501 }), deps);

  assert.equal(outcome.outcome, 'success');
  assert.equal(outcome.draftId, 501);
  const statuses = deps.statusUpdates.map((u) => u.processingStatus).filter(Boolean);
  assert.deepEqual(statuses, ['analysis_running', 'analysis_completed', 'image_generation_running', 'awaiting_image_approval']);
  const finalUpdate = deps.statusUpdates[deps.statusUpdates.length - 1];
  assert.equal(finalUpdate.mainImageGenerated, true);
  assert.equal(finalUpdate.detailImagesGeneratedCount, 10);
});

test('processWinnerCandidate never requests manufacturer/countryOfOrigin/handlingPrecautions for auto-apply', async () => {
  let appliedFields = null;
  const deps = baseDeps({
    applyProductAnalysisImpl: async (_db, _draftId, { fields }) => { appliedFields = fields; return { appliedFields: [], blockedFields: [] }; },
  });
  await processWinnerCandidate({}, candidateRow({ draftId: 501 }), deps);
  assert.deepEqual(appliedFields, { material: true, dimensions: true, searchTags: true, colors: true });
  assert.equal(appliedFields.manufacturer, undefined);
  assert.equal(appliedFields.countryOfOrigin, undefined);
  assert.equal(appliedFields.handlingPrecautions, undefined);
});

test('processWinnerCandidate stops before image generation and records failure when analysis fails', async () => {
  const deps = baseDeps({
    runProductAnalysisImpl: async () => ({ status: 'failed', errorCode: 'NO_DETAIL_IMAGES', errorMessage: '로컬 원본 이미지가 없습니다', pythonStatus: 'skipped', codexStatus: 'failed' }),
  });
  let imageGenCalled = false;
  const outcome = await processWinnerCandidate({}, candidateRow({ draftId: 501 }), {
    ...deps,
    generateMainImageImpl: async () => { imageGenCalled = true; return {}; },
  });
  assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.stage, 'analysis');
  assert.equal(imageGenCalled, false);
  const failedUpdate = deps.statusUpdates.find((u) => u.processingStatus === 'failed');
  assert.equal(failedUpdate.failureStage, 'analysis');
});

test('processWinnerCandidate reports quotaLimited when the analysis run hit a Codex rate limit', async () => {
  const deps = baseDeps({
    runProductAnalysisImpl: async () => ({ status: 'failed', errorCode: 'CODEX_RATE_LIMIT', codexErrorCode: 'CODEX_RATE_LIMIT', errorMessage: 'usage limit reached' }),
  });
  const outcome = await processWinnerCandidate({}, candidateRow({ draftId: 501 }), deps);
  assert.equal(outcome.quotaLimited, true);
});

test('processWinnerCandidate records failure and stops at image_generation_main without attempting detail images', async () => {
  const deps = baseDeps({
    generateMainImageImpl: async () => { throw Object.assign(new Error('login required'), { code: 'CODEX_LOGIN_REQUIRED' }); },
  });
  let detailCalled = false;
  const outcome = await processWinnerCandidate({}, candidateRow({ draftId: 501 }), {
    ...deps,
    generateDetailImageSetImpl: async () => { detailCalled = true; return {}; },
  });
  assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.stage, 'image_generation_main');
  assert.equal(detailCalled, false);
});

test('processWinnerCandidate records a partial detail-image failure with the actual generated count for resume', async () => {
  const deps = baseDeps({
    generateDetailImageSetImpl: async () => { throw Object.assign(new Error('insufficient'), { code: 'DETAIL_IMAGE_COUNT_INSUFFICIENT', actualCount: 6 }); },
  });
  const outcome = await processWinnerCandidate({}, candidateRow({ draftId: 501 }), deps);
  assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.stage, 'image_generation_detail');
  const failedUpdate = deps.statusUpdates.find((u) => u.processingStatus === 'failed');
  assert.equal(failedUpdate.detailImagesGeneratedCount, 6);
  assert.equal(failedUpdate.mainImageGenerated, true);
});
