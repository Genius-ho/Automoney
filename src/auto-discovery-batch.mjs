import { collectCandidates as collectCandidatesReal, evaluateCandidates as evaluateCandidatesReal } from './candidate-collector.mjs';
import { computeCompetitivenessScore as computeCompetitivenessScoreReal } from './competitiveness-score.mjs';
import { getRecentlySelectedCategoryIds, listActiveCategoryPolicies, recordCategorySelections as recordCategorySelectionsReal } from './category-policy-store.mjs';
import {
  completeProductStage as completeProductStageReal,
  getBatchScheduleState as getBatchScheduleStateReal,
  releaseDiscoveryLock as releaseDiscoveryLockReal,
  releaseLockOnly as releaseLockOnlyReal,
  releaseProcessingLock as releaseProcessingLockReal,
  tryAcquireBatchLock as tryAcquireBatchLockReal,
} from './batch-schedule-store.mjs';
import { selectOldestDueStage as selectOldestDueStageReal } from './product-automation-schedule.mjs';
import {
  createBatchRun as createBatchRunReal,
  finishBatchRun as finishBatchRunReal,
  getBatchRunCandidateById as getBatchRunCandidateByIdReal,
  recordBatchCandidates as recordBatchCandidatesReal,
  updateBatchCandidateStatus as updateBatchCandidateStatusReal,
} from './batch-run-store.mjs';
import {
  countActiveQueueItems as countActiveQueueItemsReal,
  enqueueCandidate as enqueueCandidateReal,
  getNextAnalysisItem as getNextAnalysisItemReal,
  getNextImageItem as getNextImageItemReal,
  getNextQueuedItem as getNextQueuedItemReal,
  getNextQueueItem as getNextQueueItemReal,
  isCandidateActiveOrQueued as isCandidateActiveOrQueuedReal,
  recordQueueItemPause as recordQueueItemPauseReal,
  updateQueueItemStatus as updateQueueItemStatusReal,
} from './processing-queue-store.mjs';
import { analyzeWinnerCandidate as analyzeWinnerCandidateReal, generateWinnerCandidateImages as generateWinnerCandidateImagesReal, prepareCandidateDraft as prepareCandidateDraftReal, processWinnerCandidate as processWinnerCandidateReal } from './batch-winner-processor.mjs';

const CANDIDATES_STORED_PER_CATEGORY = 5;

export async function runDueProductAutomationStage(db, deps = {}, {
  now = new Date(),
  getBatchScheduleStateImpl = getBatchScheduleStateReal,
  selectOldestDueStageImpl = selectOldestDueStageReal,
  tryAcquireBatchLockImpl = tryAcquireBatchLockReal,
  completeProductStageImpl = completeProductStageReal,
  runDraftPreparationStageImpl = runDraftPreparationStage,
  runAnalysisStageImpl = runAnalysisStage,
  runImageGenerationStageImpl = runImageGenerationStage,
  runCandidateDiscoveryBatchImpl = runCandidateDiscoveryBatch,
} = {}) {
  const state = await getBatchScheduleStateImpl(db);
  const due = selectOldestDueStageImpl(state, now);
  if (!due) return { skipped: true, reason: 'NOT_DUE' };

  const days = due.stage === 'discovery' ? Number(state?.intervalDays || 3) : 1;
  const nextRunAt = new Date(due.dueAt.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  try {
    let outcome;
    if (due.stage === 'discovery') {
      outcome = await runCandidateDiscoveryBatchImpl(db, deps);
    } else {
      const lock = await tryAcquireBatchLockImpl(db);
      if (!lock) return { skipped: true, reason: 'ALREADY_RUNNING' };
      const runners = { draft: runDraftPreparationStageImpl, analysis: runAnalysisStageImpl, images: runImageGenerationStageImpl };
      outcome = await runners[due.stage](db, deps);
    }
    const outcomeLabel = outcome?.outcome || (outcome?.skipped ? `skipped:${outcome.reason}` : 'completed');
    await completeProductStageImpl(db, due.stage, { serviceDate: due.serviceDate, nextRunAt, outcome: outcomeLabel });
    return { stage: due.stage, outcome };
  } catch (error) {
    await completeProductStageImpl(db, due.stage, { serviceDate: due.serviceDate, nextRunAt, outcome: `failed:${error.code || error.message}` });
    throw error;
  }
}

// "전체 카테고리에서 무작위로 고르되 ... 최근 30일 동안 선택한 카테고리는
// 가능하면 다시 선택하지 않는다" -- prefers the pool of categories NOT
// selected in the last `excludeRecentDays` days; only falls back to
// allowing a repeat when that pool is too small to fill `count` (the user's
// own "가능하면", not an absolute rule).
export async function selectRandomCategories(db, {
  count = 3,
  excludeRecentDays = 30,
  listActiveCategoryPoliciesImpl = listActiveCategoryPolicies,
  getRecentlySelectedCategoryIdsImpl = getRecentlySelectedCategoryIds,
} = {}) {
  const active = await listActiveCategoryPoliciesImpl(db);
  const recentIds = new Set(await getRecentlySelectedCategoryIdsImpl(db, { withinDays: excludeRecentDays }));
  const fresh = active.filter((policy) => !recentIds.has(policy.id));
  const pool = fresh.length >= count ? fresh : active;
  return shuffle(pool).slice(0, count);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Collects + scores candidates for one category, picks the single highest
// scorer, and reports "not selected" (winner: null) rather than forcing a
// pick when nothing clears minPassingScore -- "기준 미달이면 해당
// 카테고리에서는 상품을 선정하지 않는다 ... 3개를 억지로 채우지 않는다".
export async function collectAndScoreCandidatesForCategory(policy, {
  domemeClientImpl,
  pricingRules,
  rootDir,
  minPassingScore,
  targetCandidateCount = 30,
  pageSize = 20,
  scoreContext = {},
  collectCandidatesImpl = collectCandidatesReal,
  evaluateCandidatesImpl = evaluateCandidatesReal,
  computeCompetitivenessScoreImpl = computeCompetitivenessScoreReal,
}) {
  const summary = { duplicateSkipped: 0 };
  const raw = await collectCandidatesImpl(domemeClientImpl, policy.searchKeywords, {
    targetCandidateCount,
    pageSize,
    category: policy.domeggookCategoryCode || undefined,
    includeDomeggook: false,
    root: rootDir,
    summary,
  });

  const evaluated = await evaluateCandidatesImpl(domemeClientImpl, raw, pricingRules, { includeNeedsReview: true, includeDomeggook: false });
  const scorable = evaluated.filter((item) => item.filter.filterStatus === 'pass' || item.filter.filterStatus === 'needs_review');

  const scored = scorable
    .map((candidate) => ({ candidate, ...computeCompetitivenessScoreImpl(candidate, scoreContext) }))
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, CANDIDATES_STORED_PER_CATEGORY);
  const winner = top.length > 0 && top[0].score >= minPassingScore ? top[0] : null;

  return {
    policy,
    candidatesEvaluated: evaluated.length,
    top: top.map((entry, index) => ({
      supplierProductNo: entry.candidate.productNo,
      name: entry.candidate.normalized?.name || null,
      score: entry.score,
      scoreBreakdown: entry.breakdown,
      isWinner: winner != null && index === 0,
      // Full candidate (raw/normalized/filter/prices), not just a display
      // summary -- the daily processing cycle's processWinnerCandidate feeds
      // this straight into saveEvaluatedCandidate to create the draft, so it
      // must be everything that function needs, exactly as
      // evaluateCandidates() produced it.
      rawCandidateJson: {
        productNo: entry.candidate.productNo,
        raw: entry.candidate.raw,
        normalized: entry.candidate.normalized,
        filter: entry.candidate.filter,
        prices: entry.candidate.prices,
      },
    })),
    winner: winner ? { supplierProductNo: winner.candidate.productNo, name: winner.candidate.normalized?.name || null, score: winner.score } : null,
  };
}

// Light cycle (every 3 days by default, no Codex usage at all): select
// categories, score candidates, enqueue each category's winner into
// processing_queue (dedup-checked against both the active queue and
// existing drafts) -- never creates a draft, never runs analysis or image
// generation. "큐에 미완료 상품이 있으면 새 후보 발굴보다 기존 큐 처리를
// 우선": if any non-failed queue item still exists, this cycle does no
// discovery work at all this tick (still advances next_run_at so it simply
// re-checks next time, rather than spinning).
export async function runCandidateDiscoveryBatch(db, {
  rootDir,
  domemeClientImpl,
  pricingRules,
  categoryCount = 3,
  excludeRecentDays = 30,
  targetCandidateCount = 30,
  pageSize = 20,
  scoreContext = {},
  tryAcquireBatchLockImpl = tryAcquireBatchLockReal,
  releaseDiscoveryLockImpl = releaseDiscoveryLockReal,
  releaseLockOnlyImpl = releaseLockOnlyReal,
  createBatchRunImpl = createBatchRunReal,
  finishBatchRunImpl = finishBatchRunReal,
  recordBatchCandidatesImpl = recordBatchCandidatesReal,
  recordCategorySelectionsImpl = recordCategorySelectionsReal,
  selectRandomCategoriesImpl = selectRandomCategories,
  collectAndScoreCandidatesForCategoryImpl = collectAndScoreCandidatesForCategory,
  countActiveQueueItemsImpl = countActiveQueueItemsReal,
  isCandidateActiveOrQueuedImpl = isCandidateActiveOrQueuedReal,
  enqueueCandidateImpl = enqueueCandidateReal,
} = {}) {
  const lock = await tryAcquireBatchLockImpl(db);
  if (!lock) return { skipped: true, reason: 'ALREADY_RUNNING' };

  const backlog = await countActiveQueueItemsImpl(db);
  if (backlog > 0) {
    const nextRunAt = new Date(Date.now() + lock.intervalDays * 24 * 60 * 60 * 1000).toISOString();
    await releaseDiscoveryLockImpl(db, { nextRunAt });
    return { skipped: true, reason: 'QUEUE_BACKLOG', backlog };
  }

  let run = null;
  try {
    run = await createBatchRunImpl(db);
    const categories = await selectRandomCategoriesImpl(db, { count: categoryCount, excludeRecentDays });
    await recordCategorySelectionsImpl(db, run.id, categories.map((category) => category.id));

    const results = [];
    const enqueued = [];
    for (const policy of categories) {
      const result = await collectAndScoreCandidatesForCategoryImpl(policy, {
        domemeClientImpl,
        pricingRules,
        rootDir,
        minPassingScore: lock.minPassingScore,
        targetCandidateCount,
        pageSize,
        scoreContext,
      });
      const recorded = await recordBatchCandidatesImpl(db, run.id, result.top.map((candidate) => ({ ...candidate, categoryPolicyId: policy.id })));
      results.push(result);
      const winnerRow = recorded.find((row) => row.isWinner);
      if (!winnerRow) continue;
      if (await isCandidateActiveOrQueuedImpl(db, winnerRow.supplierProductNo)) continue; // dedup: already queued or already has a draft
      const queued = await enqueueCandidateImpl(db, {
        batchRunCandidateId: winnerRow.id, categoryPolicyId: policy.id,
        supplierProductNo: winnerRow.supplierProductNo, name: winnerRow.name, score: winnerRow.score,
      });
      enqueued.push(queued);
    }

    const finished = await finishBatchRunImpl(db, run.id, { status: 'completed', stageReached: 'enqueued' });
    return { run: finished, categories: results, enqueued };
  } catch (error) {
    if (run) {
      await finishBatchRunImpl(db, run.id, { status: 'failed', errorCode: error.code || 'BATCH_FAILED', errorMessage: error.message });
    }
    throw error;
  } finally {
    const nextRunAt = new Date(Date.now() + lock.intervalDays * 24 * 60 * 60 * 1000).toISOString();
    await releaseDiscoveryLockImpl(db, { nextRunAt });
  }
}

// A candidate's fine-grained batch_run_candidates.processing_status, mapped
// onto the coarser processing_queue.status vocabulary the admin UI and
// getNextQueueItem's resume logic use. 'failed' is deliberately not mapped
// here -- runDailyProcessingBatch decides the final queue status itself
// after processWinnerCandidate returns, since a quota-limited stop must
// leave the queue item at its last in-progress stage (resumable tomorrow),
// not force it to 'failed' (terminal) the way every other failure does.
// 'draft_created' is set by draft preparation before any analysis begins.
function mapCandidateStatusToQueueStatus(processingStatus) {
  if (processingStatus === 'analysis_running') return 'analyzing';
  if (processingStatus === 'analysis_completed') return 'analysis_completed';
  if (processingStatus === 'image_generation_running') return 'generating_images';
  if (processingStatus === 'awaiting_image_approval') return 'awaiting_image_approval';
  return null;
}

export async function runDraftPreparationStage(db, {
  rootDir,
  getNextQueuedItemImpl = getNextQueuedItemReal,
  getBatchRunCandidateByIdImpl = getBatchRunCandidateByIdReal,
  prepareCandidateDraftImpl = prepareCandidateDraftReal,
  updateQueueItemStatusImpl = updateQueueItemStatusReal,
} = {}) {
  const queueItem = await getNextQueuedItemImpl(db);
  if (!queueItem) return { skipped: true, reason: 'QUEUE_EMPTY' };
  const candidate = await getBatchRunCandidateByIdImpl(db, queueItem.batchRunCandidateId);
  const outcome = await prepareCandidateDraftImpl(db, candidate, { rootDir, batchRunId: candidate.batchRunId });
  if (outcome.outcome === 'ready') await updateQueueItemStatusImpl(db, queueItem.id, { status: 'draft_created', draftId: outcome.draftId, startedAt: queueItem.startedAt || new Date().toISOString() });
  else await updateQueueItemStatusImpl(db, queueItem.id, { status: 'failed', draftId: outcome.draftId, failureStage: 'draft_creation', failureMessage: outcome.outcome });
  return { queueItemId: queueItem.id, ...outcome };
}

async function runImprovementStage(db, queueItem, processor, deps, activeStatus, successStatus) {
  if (!queueItem) return { skipped: true, reason: 'QUEUE_EMPTY' };
  if (queueItem.status !== activeStatus) {
    await deps.updateQueueItemStatusImpl(db, queueItem.id, { status: activeStatus, draftId: queueItem.draftId, startedAt: queueItem.startedAt || new Date().toISOString() });
  }
  const candidate = await deps.getBatchRunCandidateByIdImpl(db, queueItem.batchRunCandidateId);
  const mirror = async (dbArg, candidateId, patch) => {
    const result = await deps.updateBatchCandidateStatusImpl(dbArg, candidateId, patch);
    const status = mapCandidateStatusToQueueStatus(patch.processingStatus);
    if (status) await deps.updateQueueItemStatusImpl(dbArg, queueItem.id, { status, draftId: patch.draftId });
    return result;
  };
  const outcome = await processor(db, candidate, { ...deps, updateBatchCandidateStatusImpl: mirror });
  if (outcome.outcome === 'success') await deps.updateQueueItemStatusImpl(db, queueItem.id, { status: successStatus, draftId: outcome.draftId });
  else if (outcome.quotaLimited) await deps.recordQueueItemPauseImpl(db, queueItem.id, { failureStage: outcome.stage, failureMessage: outcome.errorCode || 'quota limited' });
  else await deps.updateQueueItemStatusImpl(db, queueItem.id, { status: 'failed', failureStage: outcome.stage, failureMessage: outcome.errorCode || 'unknown failure' });
  return { queueItemId: queueItem.id, ...outcome };
}

function improvementDeps(deps) {
  return {
    ...deps,
    getBatchRunCandidateByIdImpl: deps.getBatchRunCandidateByIdImpl || getBatchRunCandidateByIdReal,
    updateBatchCandidateStatusImpl: deps.updateBatchCandidateStatusImpl || updateBatchCandidateStatusReal,
    updateQueueItemStatusImpl: deps.updateQueueItemStatusImpl || updateQueueItemStatusReal,
    recordQueueItemPauseImpl: deps.recordQueueItemPauseImpl || recordQueueItemPauseReal,
  };
}

export async function runAnalysisStage(db, deps = {}) {
  const resolved = improvementDeps(deps);
  const item = await (deps.getNextAnalysisItemImpl || getNextAnalysisItemReal)(db);
  return runImprovementStage(db, item, deps.analyzeWinnerCandidateImpl || analyzeWinnerCandidateReal, resolved, 'analyzing', 'analysis_completed');
}

export async function runImageGenerationStage(db, deps = {}) {
  const resolved = improvementDeps({
    ...deps,
    jobDir: deps.jobDir || deps.jobPathsConfig?.jobDir,
  });
  const item = await (deps.getNextImageItemImpl || getNextImageItemReal)(db);
  return runImprovementStage(db, item, deps.generateWinnerCandidateImagesImpl || generateWinnerCandidateImagesReal, resolved, 'generating_images', 'awaiting_image_approval');
}

export async function runNextProductAutomationStage(db, deps = {}) {
  const lock = await (deps.tryAcquireBatchLockImpl || tryAcquireBatchLockReal)(db);
  if (!lock) return { skipped: true, reason: 'ALREADY_RUNNING' };
  try {
    const item = await (deps.getNextQueueItemImpl || getNextQueueItemReal)(db);
    if (!item) return { skipped: true, reason: 'QUEUE_EMPTY' };
    if (item.status === 'queued') return runDraftPreparationStage(db, deps);
    if (item.status === 'draft_created' || item.status === 'analyzing') return runAnalysisStage(db, deps);
    return runImageGenerationStage(db, deps);
  } finally {
    await (deps.releaseLockOnlyImpl || releaseLockOnlyReal)(db);
  }
}

// Heavy cycle (daily by default), one of two things per tick -- never both,
// capping real work (Codex usage, and now also a brand-new draft) at once
// per day regardless of how many items discovery has queued:
//
// 1. Resume anything already mid-flight in the "개선" stage (analyzing /
//    generating_images) via processWinnerCandidate. This is the one place
//    Codex actually gets called.
// 2. Otherwise, if nothing is mid-flight, prepare exactly one fresh queued
//    candidate's draft (prepareCandidateDraft -- no Codex, no Coupang/Naver
//    call) and land it at 'ready_for_registration', where it waits for a
//    human to click "지금 등록" (see coupang-registration-flow.mjs's raw
//    mode + admin-server.mjs's /api/auto-batch/queue/:id/register). Items
//    already sitting at 'ready_for_registration' are invisible to
//    getNextQueueItem (it only looks at analyzing/generating_images/queued),
//    so this cycle neither advances nor blocks on them -- it just leaves
//    them for the admin and, once nothing else is in progress, prepares the
//    next-highest-score queued item instead.
export async function runDailyProcessingBatch(db, {
  rootDir,
  jobDir,
  codexConfig,
  pythonConfig,
  jobPathsConfig = {},
  tryAcquireBatchLockImpl = tryAcquireBatchLockReal,
  releaseProcessingLockImpl = releaseProcessingLockReal,
  getNextQueueItemImpl = getNextQueueItemReal,
  updateQueueItemStatusImpl = updateQueueItemStatusReal,
  recordQueueItemPauseImpl = recordQueueItemPauseReal,
  updateBatchCandidateStatusImpl = updateBatchCandidateStatusReal,
  getBatchRunCandidateByIdImpl = getBatchRunCandidateByIdReal,
  prepareCandidateDraftImpl = prepareCandidateDraftReal,
  processWinnerCandidateImpl = processWinnerCandidateReal,
} = {}) {
  const lock = await tryAcquireBatchLockImpl(db);
  if (!lock) return { skipped: true, reason: 'ALREADY_RUNNING' };

  try {
    const queueItem = await getNextQueueItemImpl(db);
    if (!queueItem) return { skipped: true, reason: 'QUEUE_EMPTY' };

    const candidateRow = await getBatchRunCandidateByIdImpl(db, queueItem.batchRunCandidateId);

    if (queueItem.status === 'queued') {
      const prepared = await prepareCandidateDraftImpl(db, candidateRow, { rootDir, batchRunId: candidateRow.batchRunId });
      if (prepared.outcome === 'ready') {
        await updateQueueItemStatusImpl(db, queueItem.id, { status: 'draft_created', draftId: prepared.draftId, startedAt: queueItem.startedAt || new Date().toISOString() });
      } else if (prepared.outcome === 'skipped_duplicate') {
        await updateQueueItemStatusImpl(db, queueItem.id, { status: 'failed', failureStage: 'draft_creation', failureMessage: '이미 존재하는 draft와 동일한 상품 -- 건너뜀', draftId: prepared.draftId });
      } else {
        await updateQueueItemStatusImpl(db, queueItem.id, { status: 'failed', failureStage: 'draft_creation', failureMessage: 'draft 준비 실패' });
      }
      return { queueItemId: queueItem.id, ...prepared };
    }

    await updateQueueItemStatusImpl(db, queueItem.id, { status: 'analyzing', startedAt: queueItem.startedAt || new Date().toISOString() });

    // Fans every batch_run_candidates status update processWinnerCandidate
    // already makes out to processing_queue too, so the queue's coarse
    // status always mirrors the candidate's fine-grained progress live --
    // without this, processWinnerCandidate itself needs no changes at all.
    const mirroringStatusImpl = async (dbArg, candidateId, patch) => {
      const result = await updateBatchCandidateStatusImpl(dbArg, candidateId, patch);
      const queueStatus = mapCandidateStatusToQueueStatus(patch.processingStatus);
      if (queueStatus) await updateQueueItemStatusImpl(dbArg, queueItem.id, { status: queueStatus, draftId: patch.draftId });
      return result;
    };

    const outcome = await processWinnerCandidateImpl(db, candidateRow, {
      rootDir, jobDir: jobDir || jobPathsConfig.jobDir, codexConfig, pythonConfig, jobPathsConfig,
      updateBatchCandidateStatusImpl: mirroringStatusImpl,
    });

    if (outcome.outcome === 'success') {
      await updateQueueItemStatusImpl(db, queueItem.id, { status: 'awaiting_image_approval', draftId: outcome.draftId });
    } else if (outcome.quotaLimited) {
      // Leave status at whatever in-progress stage the mirror last set --
      // resumed tomorrow by getNextQueueItem, not retried today.
      await recordQueueItemPauseImpl(db, queueItem.id, { failureStage: outcome.stage, failureMessage: `Codex 사용량 한도로 일시중단: ${outcome.errorCode || ''}` });
    } else {
      await updateQueueItemStatusImpl(db, queueItem.id, { status: 'failed', failureStage: outcome.stage, failureMessage: outcome.errorCode || 'unknown failure' });
    }

    return { queueItemId: queueItem.id, ...outcome };
  } finally {
    const nextRunAt = new Date(Date.now() + lock.processingIntervalDays * 24 * 60 * 60 * 1000).toISOString();
    await releaseProcessingLockImpl(db, { nextRunAt });
  }
}
