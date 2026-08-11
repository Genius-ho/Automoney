import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countActiveQueueItems,
  claimQueueItemStatus,
  enqueueCandidate,
  getQueueItemByDraftId,
  getNextAnalysisItem,
  getNextImageItem,
  getNextQueuedItem,
  getNextQueueItem,
  isCandidateActiveOrQueued,
  listQueueItemsForRegistrationReconciliation,
  listQueue,
  recordQueueItemPause,
  updateQueueItemStatus,
} from '../src/processing-queue-store.mjs';

function fakeRow(overrides = {}) {
  return {
    id: '1', batch_run_candidate_id: '5', category_policy_id: '2', supplier_product_no: '111', name: 'A',
    score: '80', status: 'queued', draft_id: null, failure_stage: null, failure_message: null,
    queued_at: '2026-07-23T00:00:00Z', started_at: null, updated_at: '2026-07-23T00:00:00Z',
    ...overrides,
  };
}

test('isCandidateActiveOrQueued is true when an active (non-failed) queue row exists for the supplier_product_no', async () => {
  const db = { async query(sql) { return sql.includes('processing_queue') ? { rows: [{ x: 1 }] } : { rows: [] }; } };
  assert.equal(await isCandidateActiveOrQueued(db, '111'), true);
});

test('stage selectors each query only their eligible queue status', async () => {
  const sqls = [];
  const db = { async query(sql) { sqls.push(sql); return { rows: [fakeRow()] }; } };
  await getNextQueuedItem(db);
  await getNextAnalysisItem(db);
  await getNextImageItem(db);
  assert.match(sqls[0], /status = 'queued'/);
  assert.match(sqls[1], /status in \('draft_created', 'analyzing'\)/);
  assert.match(sqls[2], /status in \('analysis_completed', 'generating_images'\)/);
  assert.ok(sqls.every((sql) => !sql.includes('ready_for_registration')));
});

test('isCandidateActiveOrQueued is true when a draft already exists, even if the queue has no active row', async () => {
  const db = { async query(sql) { return sql.includes('processing_queue') ? { rows: [] } : { rows: [{ x: 1 }] }; } };
  assert.equal(await isCandidateActiveOrQueued(db, '111'), true);
});

test('isCandidateActiveOrQueued is false when neither an active queue row nor a draft exists', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await isCandidateActiveOrQueued(db, '111'), false);
});

test('enqueueCandidate inserts a queued row', async () => {
  let capturedParams = null;
  const db = { async query(sql, params) { capturedParams = params; return { rows: [fakeRow()] }; } };
  const item = await enqueueCandidate(db, { batchRunCandidateId: 5, categoryPolicyId: 2, supplierProductNo: '111', name: 'A', score: 80 });
  assert.deepEqual(capturedParams, [5, 2, '111', 'A', 80]);
  assert.equal(item.status, 'queued');
});

test('countActiveQueueItems counts only machine-actionable backlog states', async () => {
  let capturedSql = null;
  const db = { async query(sql) { capturedSql = sql; return { rows: [{ count: 2 }] }; } };
  const count = await countActiveQueueItems(db);
  assert.match(capturedSql, /status in \('queued', 'draft_created', 'analyzing', 'analysis_completed', 'generating_images', 'registering'\)/);
  assert.equal(count, 2);
});

test('getQueueItemByDraftId returns the queue row linked to a draft', async () => {
  let capturedParams = null;
  const db = { async query(_sql, params) { capturedParams = params; return { rows: [fakeRow({ draft_id: '119' })] }; } };
  const item = await getQueueItemByDraftId(db, 119);
  assert.deepEqual(capturedParams, [119]);
  assert.equal(item.draftId, 119);
});

test('claimQueueItemStatus atomically compares the current status before transitioning', async () => {
  let capturedSql = null;
  let capturedParams = null;
  const db = { async query(sql, params) { capturedSql = sql; capturedParams = params; return { rows: [fakeRow({ draft_id: '119', status: 'registering' })] }; } };
  const item = await claimQueueItemStatus(db, 119, 'awaiting_image_approval', 'registering');
  assert.match(capturedSql, /where draft_id = \$1 and status = \$2/);
  assert.deepEqual(capturedParams, [119, 'awaiting_image_approval', 'registering']);
  assert.equal(item.status, 'registering');
});

test('claimQueueItemStatus returns null when another approval already claimed the row', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await claimQueueItemStatus(db, 119, 'awaiting_image_approval', 'registering'), null);
});

test('listQueueItemsForRegistrationReconciliation returns non-terminal linked registrations', async () => {
  let capturedSql = null;
  const db = { async query(sql) { capturedSql = sql; return { rows: [fakeRow({ draft_id: '119', status: 'awaiting_sale_approval' })] }; } };
  const items = await listQueueItemsForRegistrationReconciliation(db);
  assert.match(capturedSql, /join coupang_product_registrations/);
  assert.match(capturedSql, /not in \('completed', 'failed'\)/);
  assert.equal(items[0].draftId, 119);
});

test('listQueue filters by status when provided', async () => {
  let capturedParams = null;
  const db = { async query(sql, params) { capturedParams = params; return { rows: [fakeRow()] }; } };
  await listQueue(db, { status: 'awaiting_image_approval' });
  assert.deepEqual(capturedParams, ['awaiting_image_approval']);
});

test('getNextQueueItem resumes an in-progress item before ever picking a fresh queued one', async () => {
  const db = {
    async query(sql) {
      if (sql.includes("in ('draft_created', 'analyzing', 'analysis_completed', 'generating_images')")) return { rows: [fakeRow({ id: '9', status: 'generating_images' })] };
      return { rows: [fakeRow({ id: '1' })] };
    },
  };
  const item = await getNextQueueItem(db);
  assert.equal(item.id, 9);
  assert.equal(item.status, 'generating_images');
});

test('getNextQueueItem falls back to the highest-scoring queued item when nothing is in progress', async () => {
  const db = {
    async query(sql) {
      if (sql.includes("in ('draft_created', 'analyzing', 'analysis_completed', 'generating_images')")) return { rows: [] };
      return { rows: [fakeRow({ id: '3', score: '91' })] };
    },
  };
  const item = await getNextQueueItem(db);
  assert.equal(item.id, 3);
  assert.equal(item.score, 91);
});

test('getNextQueueItem returns null when the queue is entirely empty', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getNextQueueItem(db), null);
});

test('updateQueueItemStatus only overwrites fields that were provided', async () => {
  let capturedParams = null;
  const db = { async query(sql, params) { capturedParams = params; return { rows: [fakeRow({ status: 'analyzing' })] }; } };
  const item = await updateQueueItemStatus(db, 1, { status: 'analyzing', startedAt: '2026-07-23T01:00:00Z' });
  assert.deepEqual(capturedParams, [1, 'analyzing', null, null, null, '2026-07-23T01:00:00Z', true, false, false, false, true]);
  assert.equal(item.status, 'analyzing');
});

test('updateQueueItemStatus can explicitly clear stale failure metadata', async () => {
  let capturedParams = null;
  const db = { async query(_sql, params) { capturedParams = params; return { rows: [fakeRow({ status: 'awaiting_sale_approval' })] }; } };
  await updateQueueItemStatus(db, 1, { status: 'awaiting_sale_approval', failureStage: null, failureMessage: null });
  assert.deepEqual(capturedParams, [1, 'awaiting_sale_approval', null, null, null, null, true, false, true, true, false]);
});

test('recordQueueItemPause writes failure metadata without forcing a status change', async () => {
  let capturedSql = null;
  const db = { async query(sql, params) { capturedSql = sql; return { rows: [fakeRow({ status: 'generating_images', failure_message: 'usage limit' })] }; } };
  const item = await recordQueueItemPause(db, 1, { failureStage: 'image_generation_detail', failureMessage: 'usage limit' });
  assert.ok(!capturedSql.includes('status ='));
  assert.equal(item.status, 'generating_images');
  assert.equal(item.failureMessage, 'usage limit');
});
