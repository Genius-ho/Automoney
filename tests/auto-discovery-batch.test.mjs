import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectAndScoreCandidatesForCategory,
  runAutoDiscoveryBatch,
  selectRandomCategories,
} from '../src/auto-discovery-batch.mjs';

function policy(id, overrides = {}) {
  return { id, segmentName: '생활/수납', categoryName: `카테고리${id}`, searchKeywords: ['키워드'], domeggookCategoryCode: null, isActive: true, ...overrides };
}

test('selectRandomCategories prefers categories not selected in the last N days', async () => {
  const active = [policy(1), policy(2), policy(3), policy(4), policy(5)];
  const picked = await selectRandomCategories({}, {
    count: 3,
    listActiveCategoryPoliciesImpl: async () => active,
    getRecentlySelectedCategoryIdsImpl: async () => [1, 2],
  });
  assert.equal(picked.length, 3);
  assert.ok(picked.every((p) => [3, 4, 5].includes(p.id)));
});

test('selectRandomCategories falls back to allowing repeats when the fresh pool is smaller than count', async () => {
  const active = [policy(1), policy(2), policy(3)];
  const picked = await selectRandomCategories({}, {
    count: 3,
    listActiveCategoryPoliciesImpl: async () => active,
    getRecentlySelectedCategoryIdsImpl: async () => [1, 2], // only category 3 is fresh
  });
  assert.equal(picked.length, 3);
  assert.deepEqual(new Set(picked.map((p) => p.id)), new Set([1, 2, 3]));
});

test('selectRandomCategories returns fewer than count when the active pool itself is smaller', async () => {
  const picked = await selectRandomCategories({}, {
    count: 3,
    listActiveCategoryPoliciesImpl: async () => [policy(1)],
    getRecentlySelectedCategoryIdsImpl: async () => [],
  });
  assert.equal(picked.length, 1);
});

function fakeEvaluated(entries) {
  return entries;
}

test('collectAndScoreCandidatesForCategory picks the highest-scoring candidate as winner when it clears minPassingScore', async () => {
  const evaluated = fakeEvaluated([
    { productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' } },
    { productNo: '2', normalized: { name: 'B' }, filter: { filterStatus: 'pass' } },
    { productNo: '3', normalized: { name: 'C' }, filter: { filterStatus: 'blocked' } },
  ]);
  const scores = { 1: 70, 2: 90 };
  const result = await collectAndScoreCandidatesForCategory(policy(1), {
    minPassingScore: 60,
    collectCandidatesImpl: async () => [{ productNo: '1' }, { productNo: '2' }, { productNo: '3' }],
    evaluateCandidatesImpl: async () => evaluated,
    computeCompetitivenessScoreImpl: (candidate) => ({ score: scores[candidate.productNo] ?? 0, breakdown: {} }),
  });

  assert.equal(result.candidatesEvaluated, 3);
  assert.equal(result.top.length, 2); // blocked candidate excluded from scoring entirely
  assert.equal(result.winner.supplierProductNo, '2');
  assert.equal(result.top[0].isWinner, true);
  assert.equal(result.top[1].isWinner, false);
});

test('collectAndScoreCandidatesForCategory reports no winner when the top score is below minPassingScore', async () => {
  const evaluated = fakeEvaluated([{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' } }]);
  const result = await collectAndScoreCandidatesForCategory(policy(1), {
    minPassingScore: 60,
    collectCandidatesImpl: async () => [{ productNo: '1' }],
    evaluateCandidatesImpl: async () => evaluated,
    computeCompetitivenessScoreImpl: () => ({ score: 45, breakdown: {} }),
  });
  assert.equal(result.winner, null);
  assert.equal(result.top[0].isWinner, false);
});

function runAutoDiscoveryBatchDeps(overrides = {}) {
  const calls = { finishBatchRun: [], recordBatchCandidates: [], releaseBatchLock: [] };
  return {
    calls,
    tryAcquireBatchLockImpl: async () => ({ minPassingScore: 60, intervalDays: 3 }),
    releaseBatchLockImpl: async (_db, args) => { calls.releaseBatchLock.push(args); },
    createBatchRunImpl: async () => ({ id: 1 }),
    finishBatchRunImpl: async (_db, runId, args) => { calls.finishBatchRun.push({ runId, ...args }); return { id: runId, ...args }; },
    recordBatchCandidatesImpl: async (_db, runId, candidates) => { calls.recordBatchCandidates.push({ runId, candidates }); },
    recordCategorySelectionsImpl: async () => {},
    selectRandomCategoriesImpl: async () => [policy(1), policy(2), policy(3)],
    collectAndScoreCandidatesForCategoryImpl: async (p) => ({ policy: p, candidatesEvaluated: 5, top: [{ supplierProductNo: '1', name: 'A', score: 80, scoreBreakdown: {}, isWinner: true }], winner: { supplierProductNo: '1', name: 'A', score: 80 } }),
    ...overrides,
  };
}

test('runAutoDiscoveryBatch does nothing (skipped) when the lock is already held', async () => {
  let createCalled = false;
  const result = await runAutoDiscoveryBatch({}, {
    tryAcquireBatchLockImpl: async () => null,
    createBatchRunImpl: async () => { createCalled = true; return { id: 1 }; },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'ALREADY_RUNNING');
  assert.equal(createCalled, false);
});

test('runAutoDiscoveryBatch happy path: creates a run, records category selections, scores each category, finishes completed, releases the lock', async () => {
  const deps = runAutoDiscoveryBatchDeps();
  const result = await runAutoDiscoveryBatch({}, deps);

  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.stageReached, 'scored_preview_only');
  assert.equal(result.categories.length, 3);
  assert.equal(deps.calls.recordBatchCandidates.length, 3);
  assert.equal(deps.calls.releaseBatchLock.length, 1);
  assert.ok(deps.calls.releaseBatchLock[0].nextRunAt);
});

test('runAutoDiscoveryBatch marks the run failed and still releases the lock when a category step throws', async () => {
  const deps = runAutoDiscoveryBatchDeps({
    collectAndScoreCandidatesForCategoryImpl: async () => { throw Object.assign(new Error('domeme down'), { code: 'DOMEME_UNAVAILABLE' }); },
  });
  await assert.rejects(() => runAutoDiscoveryBatch({}, deps), /domeme down/);
  assert.equal(deps.calls.finishBatchRun.length, 1);
  assert.equal(deps.calls.finishBatchRun[0].status, 'failed');
  assert.equal(deps.calls.finishBatchRun[0].errorCode, 'DOMEME_UNAVAILABLE');
  assert.equal(deps.calls.releaseBatchLock.length, 1);
});
