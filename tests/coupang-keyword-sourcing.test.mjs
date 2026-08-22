import assert from 'node:assert/strict';
import test from 'node:test';

import { MARGIN_RATE_FOR_KEYWORD_SOURCING, UNFILTERED_CATEGORY_NAME, sourceCandidatesFromKeywords } from '../src/coupang-keyword-sourcing.mjs';

function policy(id, searchKeywords, overrides = {}) {
  return { id, categoryName: `category-${id}`, searchKeywords, domeggookCategoryCode: null, ...overrides };
}

function unfilteredPolicy(overrides = {}) {
  return { id: 99, categoryName: UNFILTERED_CATEGORY_NAME, searchKeywords: [], domeggookCategoryCode: null, ...overrides };
}

function baseDeps(overrides = {}) {
  return {
    db: { name: 'db' },
    listActiveCategoryPoliciesImpl: async () => [policy(1, ['수납정리함']), unfilteredPolicy()],
    getBatchScheduleStateImpl: async () => ({ minPassingScore: 60 }),
    collectAndScoreCandidatesForCategoryImpl: async () => ({
      candidatesEvaluated: 3,
      top: [{ supplierProductNo: '1', name: 'A', score: 80, scoreBreakdown: {}, isWinner: true, rawCandidateJson: {} }],
      winner: { supplierProductNo: '1', name: 'A', score: 80 },
    }),
    isCandidateActiveOrQueuedImpl: async () => false,
    createBatchRunImpl: async () => ({ id: 999 }),
    recordBatchCandidatesImpl: async (db, runId, candidates) => candidates.map((c, i) => ({ id: 100 + i, ...c })),
    enqueueCandidateImpl: async () => ({ id: 1 }),
    finishBatchRunImpl: async () => {},
    ...overrides,
  };
}

test('sourceCandidatesFromKeywords falls back to the unfiltered sentinel category and still searches Domeggook when no whitelist entry matches', async () => {
  let receivedPolicy = null;
  const results = await sourceCandidatesFromKeywords({}, ['홍삼'], {}, baseDeps({
    listActiveCategoryPoliciesImpl: async () => [policy(1, ['수납정리함']), unfilteredPolicy()],
    collectAndScoreCandidatesForCategoryImpl: async (policyArg) => {
      receivedPolicy = policyArg;
      return { candidatesEvaluated: 2, top: [{ supplierProductNo: '5', name: 'H', score: 70, scoreBreakdown: {}, isWinner: true, rawCandidateJson: {} }], winner: { supplierProductNo: '5', name: 'H', score: 70 } };
    },
  }));
  assert.deepEqual(receivedPolicy, { id: 99, searchKeywords: ['홍삼'], domeggookCategoryCode: null });
  assert.deepEqual(results, [{ keyword: '홍삼', status: 'enqueued', supplierProductNo: '5', score: 70, categoryName: UNFILTERED_CATEGORY_NAME }]);
});

test('sourceCandidatesFromKeywords prefers a real whitelist match over the sentinel category when one exists', async () => {
  let receivedPolicy = null;
  await sourceCandidatesFromKeywords({}, ['수납정리함'], {}, baseDeps({
    collectAndScoreCandidatesForCategoryImpl: async (policyArg) => { receivedPolicy = policyArg; return { candidatesEvaluated: 0, top: [], winner: null }; },
  }));
  assert.equal(receivedPolicy.id, 1);
});

test('sourceCandidatesFromKeywords errors per-keyword (not fatally) when the sentinel row itself is missing and no whitelist entry matches', async () => {
  const results = await sourceCandidatesFromKeywords({}, ['홍삼'], {}, baseDeps({
    listActiveCategoryPoliciesImpl: async () => [policy(1, ['수납정리함'])],
    collectAndScoreCandidatesForCategoryImpl: async () => { throw new Error('must not be called'); },
  }));
  assert.equal(results[0].keyword, '홍삼');
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /is missing/);
});

test('sourceCandidatesFromKeywords reports no_winner when nothing clears minPassingScore', async () => {
  const results = await sourceCandidatesFromKeywords({}, ['수납정리함'], {}, baseDeps({
    collectAndScoreCandidatesForCategoryImpl: async () => ({ candidatesEvaluated: 4, top: [], winner: null }),
    createBatchRunImpl: async () => { throw new Error('must not create a batch run with nothing to enqueue'); },
  }));
  assert.deepEqual(results, [{ keyword: '수납정리함', status: 'no_winner', candidatesEvaluated: 4, categoryName: 'category-1' }]);
});

test('sourceCandidatesFromKeywords skips a winner that is already queued or already drafted, without creating a batch run', async () => {
  const results = await sourceCandidatesFromKeywords({}, ['수납정리함'], {}, baseDeps({
    isCandidateActiveOrQueuedImpl: async () => true,
    createBatchRunImpl: async () => { throw new Error('must not create a batch run for a deduped candidate'); },
  }));
  assert.deepEqual(results, [{ keyword: '수납정리함', status: 'already_queued_or_drafted', supplierProductNo: '1', categoryName: 'category-1' }]);
});

test('sourceCandidatesFromKeywords records candidates and enqueues the winner for a matched, scoring, non-duplicate keyword', async () => {
  const recordCalls = [];
  const enqueueCalls = [];
  const results = await sourceCandidatesFromKeywords({ name: 'domeme' }, ['수납정리함'], { platforms: { coupang: { feeRate: 0.11 } } }, baseDeps({
    recordBatchCandidatesImpl: async (db, runId, candidates) => { recordCalls.push({ runId, candidates }); return candidates.map((c, i) => ({ id: 100 + i, ...c })); },
    enqueueCandidateImpl: async (db, args) => { enqueueCalls.push(args); return { id: 1 }; },
  }));

  assert.equal(recordCalls[0].runId, 999);
  assert.equal(recordCalls[0].candidates[0].categoryPolicyId, 1);
  assert.equal(enqueueCalls[0].batchRunCandidateId, 100);
  assert.equal(enqueueCalls[0].categoryPolicyId, 1);
  assert.equal(enqueueCalls[0].supplierProductNo, '1');
  assert.equal(enqueueCalls[0].score, 80);
  assert.deepEqual(results, [{ keyword: '수납정리함', status: 'enqueued', supplierProductNo: '1', score: 80, categoryName: 'category-1' }]);
});

test('sourceCandidatesFromKeywords searches only the given keyword (not the policy\'s full keyword list) with includeDomeggook: true and the margin override', async () => {
  let receivedPolicy = null;
  let receivedOptions = null;
  await sourceCandidatesFromKeywords({}, ['수납정리함'], { defaultMarginRate: 0.25, platforms: {} }, baseDeps({
    listActiveCategoryPoliciesImpl: async () => [policy(1, ['수납정리함', '다용도정리함'], { domeggookCategoryCode: 'cat-code' }), unfilteredPolicy()],
    collectAndScoreCandidatesForCategoryImpl: async (policyArg, options) => {
      receivedPolicy = policyArg;
      receivedOptions = options;
      return { candidatesEvaluated: 0, top: [], winner: null };
    },
  }));
  assert.deepEqual(receivedPolicy, { id: 1, searchKeywords: ['수납정리함'], domeggookCategoryCode: 'cat-code' });
  assert.equal(receivedOptions.includeDomeggook, true);
  assert.equal(receivedOptions.minPassingScore, 60);
  assert.equal(receivedOptions.pricingRules.defaultMarginRate, MARGIN_RATE_FOR_KEYWORD_SOURCING);
});

test('sourceCandidatesFromKeywords respects a custom marginRate override', async () => {
  let receivedOptions = null;
  await sourceCandidatesFromKeywords({}, ['수납정리함'], { defaultMarginRate: 0.25 }, baseDeps({
    marginRate: 0.35,
    collectAndScoreCandidatesForCategoryImpl: async (policyArg, options) => { receivedOptions = options; return { candidatesEvaluated: 0, top: [], winner: null }; },
  }));
  assert.equal(receivedOptions.pricingRules.defaultMarginRate, 0.35);
});

test('sourceCandidatesFromKeywords catches a per-keyword error without stopping the rest of the batch', async () => {
  let call = 0;
  const results = await sourceCandidatesFromKeywords({}, ['수납정리함', '행거'], {}, baseDeps({
    listActiveCategoryPoliciesImpl: async () => [policy(1, ['수납정리함']), policy(2, ['행거']), unfilteredPolicy()],
    collectAndScoreCandidatesForCategoryImpl: async () => {
      call += 1;
      if (call === 1) throw new Error('domeme down');
      return { candidatesEvaluated: 1, top: [{ supplierProductNo: '2', name: 'B', score: 90, scoreBreakdown: {}, isWinner: true, rawCandidateJson: {} }], winner: { supplierProductNo: '2', name: 'B', score: 90 } };
    },
  }));
  assert.equal(results[0].status, 'error');
  assert.equal(results[0].error, 'domeme down');
  assert.equal(results[1].status, 'enqueued');
});

test('sourceCandidatesFromKeywords creates only one batch run shared across multiple enqueued keywords in the same call, and finishes it', async () => {
  let createCalls = 0;
  let finishCalls = [];
  let call = 0;
  await sourceCandidatesFromKeywords({}, ['수납정리함', '행거'], {}, baseDeps({
    listActiveCategoryPoliciesImpl: async () => [policy(1, ['수납정리함']), policy(2, ['행거']), unfilteredPolicy()],
    collectAndScoreCandidatesForCategoryImpl: async () => {
      call += 1;
      return { candidatesEvaluated: 1, top: [{ supplierProductNo: String(call), name: 'X', score: 90, scoreBreakdown: {}, isWinner: true, rawCandidateJson: {} }], winner: { supplierProductNo: String(call), name: 'X', score: 90 } };
    },
    createBatchRunImpl: async () => { createCalls += 1; return { id: 999 }; },
    finishBatchRunImpl: async (db, runId, opts) => { finishCalls.push({ runId, opts }); },
  }));
  assert.equal(createCalls, 1);
  assert.deepEqual(finishCalls, [{ runId: 999, opts: { status: 'completed', stageReached: 'enqueued' } }]);
});

test('sourceCandidatesFromKeywords never creates a batch run at all when every keyword is no-winner or deduped', async () => {
  let createCalls = 0;
  let finishCalls = 0;
  await sourceCandidatesFromKeywords({}, ['수납정리함'], {}, baseDeps({
    collectAndScoreCandidatesForCategoryImpl: async () => ({ candidatesEvaluated: 3, top: [], winner: null }),
    createBatchRunImpl: async () => { createCalls += 1; return { id: 999 }; },
    finishBatchRunImpl: async () => { finishCalls += 1; },
  }));
  assert.equal(createCalls, 0);
  assert.equal(finishCalls, 0);
});
