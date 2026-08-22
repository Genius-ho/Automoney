// Coupang-keyword sourcing (docs/도매꾹_시즌2_4편 reference video): a human
// spots a keyword on a live Coupang listing, this module searches Domeggook
// for it at a 50% margin and -- if it clears the same bar the 3-day
// discovery cycle uses -- enqueues it into processing_queue so the existing
// 5-minute automation (analysis -> image generation -> QA -> registration,
// see auto-discovery-batch.mjs's runDueProductAutomationStage) picks it up
// exactly like a discovery-batch winner.
//
// Deliberately does NOT create a product_drafts row itself (unlike the
// original version of this module, which called saveEvaluatedCandidate
// directly) -- draft creation belongs to runDraftPreparationStage, which
// runs later when the queue item is actually processed. Landing a draft here
// too would race that stage; auto-discovery-batch.mjs's own winners never do
// this, so this module follows the same "score + record + enqueue" shape as
// collectAndScoreCandidatesForCategory/runCandidateDiscoveryBatch there.
//
// 2026-08-21 사용자 결정: the category_policy safe-segment whitelist stays
// mandatory for the fully-unsupervised 3-day discovery cycle (no human ever
// looks at what it picks), but NOT here -- a human already looked at the
// real Coupang listing before typing this keyword, which is itself the
// safety check the whitelist exists to approximate for the unsupervised
// case. So a keyword is matched against the whitelist only to get a nicer
// categoryName/domeggookCategoryCode when it happens to line up (see
// category-policy-matcher.mjs); an unmatched keyword still proceeds,
// falling back to the UNFILTERED_CATEGORY_NAME bookkeeping row (schema.sql)
// purely to satisfy category_policy_id's not-null FK on
// batch_run_candidates/processing_queue -- it is not a filter.
import { collectAndScoreCandidatesForCategory } from './auto-discovery-batch.mjs';
import { createBatchRun, finishBatchRun, recordBatchCandidates } from './batch-run-store.mjs';
import { getBatchScheduleState } from './batch-schedule-store.mjs';
import { matchCategoryPolicyForKeyword } from './category-policy-matcher.mjs';
import { listActiveCategoryPolicies } from './category-policy-store.mjs';
import { enqueueCandidate, isCandidateActiveOrQueued } from './processing-queue-store.mjs';

export const MARGIN_RATE_FOR_KEYWORD_SOURCING = 0.5;
export const UNFILTERED_CATEGORY_NAME = '쿠팡 키워드 소싱 (미분류)';

export async function sourceCandidatesFromKeywords(domemeClient, keywords, pricingRules, {
  db,
  root = process.cwd(),
  marginRate = MARGIN_RATE_FOR_KEYWORD_SOURCING,
  listActiveCategoryPoliciesImpl = listActiveCategoryPolicies,
  matchCategoryPolicyForKeywordImpl = matchCategoryPolicyForKeyword,
  getBatchScheduleStateImpl = getBatchScheduleState,
  collectAndScoreCandidatesForCategoryImpl = collectAndScoreCandidatesForCategory,
  isCandidateActiveOrQueuedImpl = isCandidateActiveOrQueued,
  createBatchRunImpl = createBatchRun,
  recordBatchCandidatesImpl = recordBatchCandidates,
  enqueueCandidateImpl = enqueueCandidate,
  finishBatchRunImpl = finishBatchRun,
} = {}) {
  const rules = { ...pricingRules, defaultMarginRate: marginRate };
  const [policies, scheduleState] = await Promise.all([
    listActiveCategoryPoliciesImpl(db),
    getBatchScheduleStateImpl(db),
  ]);
  const minPassingScore = scheduleState?.minPassingScore;
  const unfilteredPolicy = policies.find((p) => p.categoryName === UNFILTERED_CATEGORY_NAME);

  const results = [];
  let runId = null;

  try {
    for (const keyword of keywords) {
      try {
        const policy = matchCategoryPolicyForKeywordImpl(policies, keyword) || unfilteredPolicy;
        if (!policy) {
          const error = new Error(`category_policy row "${UNFILTERED_CATEGORY_NAME}" is missing -- run schema.sql`);
          error.code = 'UNFILTERED_CATEGORY_MISSING';
          throw error;
        }

        const scored = await collectAndScoreCandidatesForCategoryImpl(
          { id: policy.id, searchKeywords: [keyword], domeggookCategoryCode: policy.domeggookCategoryCode },
          { domemeClientImpl: domemeClient, pricingRules: rules, rootDir: root, minPassingScore, includeDomeggook: true },
        );

        if (!scored.winner) {
          results.push({ keyword, status: 'no_winner', candidatesEvaluated: scored.candidatesEvaluated, categoryName: policy.categoryName });
          continue;
        }
        if (await isCandidateActiveOrQueuedImpl(db, scored.winner.supplierProductNo)) {
          results.push({ keyword, status: 'already_queued_or_drafted', supplierProductNo: scored.winner.supplierProductNo, categoryName: policy.categoryName });
          continue;
        }

        if (runId == null) runId = (await createBatchRunImpl(db)).id;
        const recorded = await recordBatchCandidatesImpl(
          db,
          runId,
          scored.top.map((entry) => ({ ...entry, categoryPolicyId: policy.id })),
        );
        const winnerRow = recorded.find((row) => row.isWinner);
        await enqueueCandidateImpl(db, {
          batchRunCandidateId: winnerRow.id,
          categoryPolicyId: policy.id,
          supplierProductNo: winnerRow.supplierProductNo,
          name: winnerRow.name,
          score: winnerRow.score,
        });
        results.push({
          keyword,
          status: 'enqueued',
          supplierProductNo: winnerRow.supplierProductNo,
          score: winnerRow.score,
          categoryName: policy.categoryName,
        });
      } catch (error) {
        results.push({ keyword, status: 'error', error: error.message });
      }
    }
  } finally {
    if (runId != null) await finishBatchRunImpl(db, runId, { status: 'completed', stageReached: 'enqueued' });
  }

  return results;
}
