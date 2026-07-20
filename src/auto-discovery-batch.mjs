import { collectCandidates as collectCandidatesReal, evaluateCandidates as evaluateCandidatesReal } from './candidate-collector.mjs';
import { computeCompetitivenessScore as computeCompetitivenessScoreReal } from './competitiveness-score.mjs';
import { getRecentlySelectedCategoryIds, listActiveCategoryPolicies, recordCategorySelections as recordCategorySelectionsReal } from './category-policy-store.mjs';
import { releaseBatchLock as releaseBatchLockReal, tryAcquireBatchLock as tryAcquireBatchLockReal } from './batch-schedule-store.mjs';
import { createBatchRun as createBatchRunReal, finishBatchRun as finishBatchRunReal, recordBatchCandidates as recordBatchCandidatesReal } from './batch-run-store.mjs';

const CANDIDATES_STORED_PER_CATEGORY = 5;

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
      rawCandidateJson: { productNo: entry.candidate.productNo, normalized: entry.candidate.normalized },
    })),
    winner: winner ? { supplierProductNo: winner.candidate.productNo, name: winner.candidate.normalized?.name || null, score: winner.score } : null,
  };
}

// Top-level orchestrator. Never creates product_drafts, never calls any
// image-generation, Coupang, or Naver API -- Stage 1 only selects
// categories, collects/scores candidates, and records a read-only preview.
export async function runAutoDiscoveryBatch(db, {
  rootDir,
  domemeClientImpl,
  pricingRules,
  categoryCount = 3,
  excludeRecentDays = 30,
  targetCandidateCount = 30,
  pageSize = 20,
  scoreContext = {},
  tryAcquireBatchLockImpl = tryAcquireBatchLockReal,
  releaseBatchLockImpl = releaseBatchLockReal,
  createBatchRunImpl = createBatchRunReal,
  finishBatchRunImpl = finishBatchRunReal,
  recordBatchCandidatesImpl = recordBatchCandidatesReal,
  recordCategorySelectionsImpl = recordCategorySelectionsReal,
  selectRandomCategoriesImpl = selectRandomCategories,
  collectAndScoreCandidatesForCategoryImpl = collectAndScoreCandidatesForCategory,
} = {}) {
  const lock = await tryAcquireBatchLockImpl(db);
  if (!lock) {
    return { skipped: true, reason: 'ALREADY_RUNNING' };
  }

  let run = null;
  try {
    run = await createBatchRunImpl(db);
    const categories = await selectRandomCategoriesImpl(db, { count: categoryCount, excludeRecentDays });
    await recordCategorySelectionsImpl(db, run.id, categories.map((category) => category.id));

    const results = [];
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
      await recordBatchCandidatesImpl(db, run.id, result.top.map((candidate) => ({ ...candidate, categoryPolicyId: policy.id })));
      results.push(result);
    }

    const finished = await finishBatchRunImpl(db, run.id, { status: 'completed', stageReached: 'scored_preview_only' });
    return { run: finished, categories: results };
  } catch (error) {
    if (run) {
      await finishBatchRunImpl(db, run.id, { status: 'failed', errorCode: error.code || 'BATCH_FAILED', errorMessage: error.message });
    }
    throw error;
  } finally {
    const nextRunAt = new Date(Date.now() + lock.intervalDays * 24 * 60 * 60 * 1000).toISOString();
    await releaseBatchLockImpl(db, { nextRunAt });
  }
}
