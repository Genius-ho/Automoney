import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectAndScoreCandidatesForCategory,
  runCandidateDiscoveryBatch,
  runDailyProcessingBatch,
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

function discoveryDeps(overrides = {}) {
  const calls = { finishBatchRun: [], recordBatchCandidates: [], releaseDiscoveryLock: [], releaseLockOnly: [], enqueueCandidate: [] };
  let nextCandidateId = 1;
  return {
    calls,
    tryAcquireBatchLockImpl: async () => ({ minPassingScore: 60, intervalDays: 3 }),
    releaseDiscoveryLockImpl: async (_db, args) => { calls.releaseDiscoveryLock.push(args); },
    releaseLockOnlyImpl: async () => { calls.releaseLockOnly.push(true); },
    createBatchRunImpl: async () => ({ id: 1 }),
    finishBatchRunImpl: async (_db, runId, args) => { calls.finishBatchRun.push({ runId, ...args }); return { id: runId, ...args }; },
    recordBatchCandidatesImpl: async (_db, runId, candidates) => {
      calls.recordBatchCandidates.push({ runId, candidates });
      return candidates.map((c) => ({ ...c, id: nextCandidateId++ }));
    },
    recordCategorySelectionsImpl: async () => {},
    selectRandomCategoriesImpl: async () => [policy(1), policy(2), policy(3)],
    collectAndScoreCandidatesForCategoryImpl: async (p) => ({ policy: p, candidatesEvaluated: 5, top: [{ supplierProductNo: `sp-${p.id}`, name: 'A', score: 80, scoreBreakdown: {}, isWinner: true }], winner: { supplierProductNo: `sp-${p.id}`, name: 'A', score: 80 } }),
    countActiveQueueItemsImpl: async () => 0,
    isCandidateActiveOrQueuedImpl: async () => false,
    enqueueCandidateImpl: async (_db, args) => { calls.enqueueCandidate.push(args); return { id: 100 + calls.enqueueCandidate.length, ...args }; },
    ...overrides,
  };
}

test('runCandidateDiscoveryBatch does nothing (skipped) when the lock is already held', async () => {
  let createCalled = false;
  const result = await runCandidateDiscoveryBatch({}, {
    tryAcquireBatchLockImpl: async () => null,
    createBatchRunImpl: async () => { createCalled = true; return { id: 1 }; },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'ALREADY_RUNNING');
  assert.equal(createCalled, false);
});

test('runCandidateDiscoveryBatch skips discovery entirely (no Codex, no draft creation) when the queue already has a backlog', async () => {
  const deps = discoveryDeps({ countActiveQueueItemsImpl: async () => 2 });
  let createCalled = false;
  const result = await runCandidateDiscoveryBatch({}, { ...deps, createBatchRunImpl: async () => { createCalled = true; return { id: 1 }; } });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'QUEUE_BACKLOG');
  assert.equal(result.backlog, 2);
  assert.equal(createCalled, false);
  assert.equal(deps.calls.releaseDiscoveryLock.length, 1);
});

test('runCandidateDiscoveryBatch happy path: scores each category and enqueues each winner (never creates a draft, never calls Codex)', async () => {
  const deps = discoveryDeps();
  const result = await runCandidateDiscoveryBatch({}, deps);

  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.stageReached, 'enqueued');
  assert.equal(result.categories.length, 3);
  assert.equal(deps.calls.recordBatchCandidates.length, 3);
  assert.equal(deps.calls.enqueueCandidate.length, 3); // one winner per category
  assert.equal(result.enqueued.length, 3);
  assert.equal(deps.calls.releaseDiscoveryLock.length, 1);
  assert.ok(deps.calls.releaseDiscoveryLock[0].nextRunAt);
});

test('runCandidateDiscoveryBatch skips a winner that is already queued or already drafted (dedup), without throwing', async () => {
  const deps = discoveryDeps({ isCandidateActiveOrQueuedImpl: async (_db, no) => no === 'sp-2' });
  const result = await runCandidateDiscoveryBatch({}, deps);
  assert.equal(deps.calls.enqueueCandidate.length, 2); // category 2's winner was skipped as a dup
  assert.equal(result.enqueued.length, 2);
});

test('runCandidateDiscoveryBatch reports enqueued even when no category clears minPassingScore (nothing to enqueue)', async () => {
  const deps = discoveryDeps({
    collectAndScoreCandidatesForCategoryImpl: async (p) => ({ policy: p, candidatesEvaluated: 5, top: [], winner: null }),
  });
  const result = await runCandidateDiscoveryBatch({}, deps);
  assert.equal(result.enqueued.length, 0);
  assert.equal(deps.calls.enqueueCandidate.length, 0);
});

test('runCandidateDiscoveryBatch marks the run failed and still releases the lock when a category step throws', async () => {
  const deps = discoveryDeps({
    collectAndScoreCandidatesForCategoryImpl: async () => { throw Object.assign(new Error('domeme down'), { code: 'DOMEME_UNAVAILABLE' }); },
  });
  await assert.rejects(() => runCandidateDiscoveryBatch({}, deps), /domeme down/);
  assert.equal(deps.calls.finishBatchRun.length, 1);
  assert.equal(deps.calls.finishBatchRun[0].status, 'failed');
  assert.equal(deps.calls.finishBatchRun[0].errorCode, 'DOMEME_UNAVAILABLE');
  assert.equal(deps.calls.releaseDiscoveryLock.length, 1);
  assert.equal(deps.calls.enqueueCandidate.length, 0);
});

function queueItem(overrides = {}) {
  return { id: 7, batchRunCandidateId: 5, supplierProductNo: '111', name: 'A', score: 80, status: 'queued', startedAt: null, ...overrides };
}

function processingDeps(overrides = {}) {
  const calls = { updateQueueItemStatus: [], recordQueueItemPause: [], releaseProcessingLock: [], processWinnerCandidate: [] };
  return {
    calls,
    tryAcquireBatchLockImpl: async () => ({ processingIntervalDays: 1 }),
    releaseProcessingLockImpl: async (_db, args) => { calls.releaseProcessingLock.push(args); },
    getNextQueueItemImpl: async () => queueItem(),
    updateQueueItemStatusImpl: async (_db, id, patch) => { calls.updateQueueItemStatus.push({ id, ...patch }); },
    recordQueueItemPauseImpl: async (_db, id, patch) => { calls.recordQueueItemPause.push({ id, ...patch }); },
    updateBatchCandidateStatusImpl: async () => {},
    getBatchRunCandidateByIdImpl: async () => ({ id: 5, batchRunId: 1, supplierProductNo: '111', rawCandidateJson: {} }),
    processWinnerCandidateImpl: async (_db, candidateRow, opts) => { calls.processWinnerCandidate.push({ candidateRow, opts }); return { outcome: 'success', draftId: 501 }; },
    ...overrides,
  };
}

test('runDailyProcessingBatch does nothing (skipped) when the lock is already held', async () => {
  const result = await runDailyProcessingBatch({}, { tryAcquireBatchLockImpl: async () => null });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'ALREADY_RUNNING');
});

test('runDailyProcessingBatch does nothing (skipped) and releases the lock when the queue is empty', async () => {
  const deps = processingDeps({ getNextQueueItemImpl: async () => null });
  const result = await runDailyProcessingBatch({}, deps);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'QUEUE_EMPTY');
  assert.equal(deps.calls.releaseProcessingLock.length, 1);
});

test('runDailyProcessingBatch processes exactly one queue item and marks it awaiting_approval on success', async () => {
  const deps = processingDeps();
  const result = await runDailyProcessingBatch({}, deps);

  assert.equal(deps.calls.processWinnerCandidate.length, 1);
  assert.equal(result.outcome, 'success');
  const finalUpdate = deps.calls.updateQueueItemStatus.find((u) => u.status === 'awaiting_approval');
  assert.ok(finalUpdate);
  assert.equal(finalUpdate.draftId, 501);
  assert.equal(deps.calls.releaseProcessingLock.length, 1);
});

test('runDailyProcessingBatch marks the queue item failed (terminal) on a non-quota failure', async () => {
  const deps = processingDeps({
    processWinnerCandidateImpl: async () => ({ outcome: 'failed', stage: 'analysis', errorCode: 'NO_DETAIL_IMAGES', quotaLimited: false }),
  });
  await runDailyProcessingBatch({}, deps);
  const failUpdate = deps.calls.updateQueueItemStatus.find((u) => u.status === 'failed');
  assert.ok(failUpdate);
  assert.equal(failUpdate.failureStage, 'analysis');
  assert.equal(deps.calls.recordQueueItemPause.length, 0);
});

test('runDailyProcessingBatch pauses (does not force failed) the queue item on a quota-limited stop, so it resumes tomorrow', async () => {
  const deps = processingDeps({
    processWinnerCandidateImpl: async () => ({ outcome: 'failed', stage: 'image_generation_detail', errorCode: 'CODEX_RATE_LIMIT', quotaLimited: true }),
  });
  await runDailyProcessingBatch({}, deps);
  assert.equal(deps.calls.recordQueueItemPause.length, 1);
  assert.equal(deps.calls.recordQueueItemPause[0].failureStage, 'image_generation_detail');
  assert.ok(!deps.calls.updateQueueItemStatus.some((u) => u.status === 'failed'));
});

test('runDailyProcessingBatch marks the queue item failed when processWinnerCandidate reports a duplicate draft', async () => {
  const deps = processingDeps({
    processWinnerCandidateImpl: async () => ({ outcome: 'skipped_duplicate', draftId: 27 }),
  });
  await runDailyProcessingBatch({}, deps);
  const failUpdate = deps.calls.updateQueueItemStatus.find((u) => u.status === 'failed');
  assert.ok(failUpdate);
  assert.equal(failUpdate.failureStage, 'draft_creation');
  assert.equal(failUpdate.draftId, 27);
});

test('runDailyProcessingBatch mirrors processWinnerCandidate progress updates onto the queue item live', async () => {
  const deps = processingDeps({
    processWinnerCandidateImpl: async (db, candidateRow, opts) => {
      await opts.updateBatchCandidateStatusImpl(db, candidateRow.id, { processingStatus: 'image_generation_running' });
      return { outcome: 'success', draftId: 501 };
    },
  });
  await runDailyProcessingBatch({}, deps);
  assert.ok(deps.calls.updateQueueItemStatus.some((u) => u.status === 'generating_images'));
});
