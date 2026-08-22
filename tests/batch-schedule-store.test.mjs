import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeProductStage,
  getBatchScheduleState,
  releaseDiscoveryLock,
  releaseLockOnly,
  releaseProcessingLock,
  tryAcquireBatchLock,
  updateBatchScheduleState,
} from '../src/batch-schedule-store.mjs';

function fakeRow(overrides = {}) {
  return {
    interval_days: 3,
    next_run_at: '2026-07-23T00:00:00Z',
    last_run_at: null,
    is_running: false,
    min_passing_score: 60,
    processing_interval_days: 1,
    processing_next_run_at: '2026-07-21T00:00:00Z',
    processing_last_run_at: null,
    draft_next_run_at: '2026-07-20T22:00:00Z',
    draft_last_run_at: null,
    draft_last_service_date: null,
    draft_last_outcome: null,
    analysis_next_run_at: '2026-07-20T23:00:00Z',
    analysis_last_run_at: null,
    analysis_last_service_date: null,
    analysis_last_outcome: null,
    images_next_run_at: '2026-07-21T00:00:00Z',
    images_last_run_at: null,
    images_last_service_date: null,
    images_last_outcome: null,
    qa_next_run_at: '2026-07-21T02:00:00Z',
    qa_last_run_at: null,
    qa_last_service_date: null,
    qa_last_outcome: null,
    discovery_last_service_date: null,
    discovery_last_outcome: null,
    updated_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

test('getBatchScheduleState returns null when the single row is somehow missing', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getBatchScheduleState(db), null);
});

test('getBatchScheduleState maps independent fixed stage fields', async () => {
  const db = { async query() { return { rows: [fakeRow()] }; } };
  const state = await getBatchScheduleState(db);
  assert.equal(state.draftNextRunAt, '2026-07-20T22:00:00Z');
  assert.equal(state.analysisNextRunAt, '2026-07-20T23:00:00Z');
  assert.equal(state.imagesNextRunAt, '2026-07-21T00:00:00Z');
  assert.equal(state.qaNextRunAt, '2026-07-21T02:00:00Z');
  assert.equal(state.discoveryNextRunAt, '2026-07-23T00:00:00Z');
});

test('completeProductStage updates only the whitelisted stage and releases the lock', async () => {
  let capturedSql;
  let capturedParams;
  const db = { async query(sql, params) { capturedSql = sql; capturedParams = params; return { rows: [fakeRow()] }; } };
  await completeProductStage(db, 'analysis', {
    serviceDate: '2026-08-11', nextRunAt: '2026-08-11T23:00:00Z', outcome: 'no_work',
  });
  assert.match(capturedSql, /analysis_last_service_date/);
  assert.match(capturedSql, /analysis_next_run_at/);
  assert.doesNotMatch(capturedSql, /draft_next_run_at/);
  assert.match(capturedSql, /is_running = false/);
  assert.deepEqual(capturedParams, ['2026-08-11', '2026-08-11T23:00:00Z', 'no_work']);
  await assert.rejects(() => completeProductStage(db, 'unknown', {}), /unknown product stage/);
});

test('completeProductStage handles the imageQa stage using the qa_* column prefix', async () => {
  let capturedSql;
  const db = { async query(sql) { capturedSql = sql; return { rows: [fakeRow()] }; } };
  await completeProductStage(db, 'imageQa', { serviceDate: '2026-08-11', nextRunAt: '2026-08-12T02:00:00Z', outcome: 'success' });
  assert.match(capturedSql, /qa_last_service_date/);
  assert.match(capturedSql, /qa_next_run_at/);
  assert.match(capturedSql, /qa_last_outcome/);
});

test('getBatchScheduleState maps both the discovery and processing schedule fields to camelCase', async () => {
  const db = { async query() { return { rows: [fakeRow()] }; } };
  const state = await getBatchScheduleState(db);
  assert.equal(state.intervalDays, 3);
  assert.equal(state.isRunning, false);
  assert.equal(state.minPassingScore, 60);
  assert.equal(state.processingIntervalDays, 1);
  assert.equal(state.processingNextRunAt, '2026-07-21T00:00:00Z');
});

test('updateBatchScheduleState only overwrites fields that are provided', async () => {
  let capturedParams = null;
  const db = {
    async query(sql, params) {
      capturedParams = params;
      return { rows: [fakeRow({ interval_days: 5 })] };
    },
  };
  await updateBatchScheduleState(db, { intervalDays: 5 });
  assert.deepEqual(capturedParams, [5, null, null, null, null]);
});

test('tryAcquireBatchLock only succeeds when is_running was false (atomic compare-and-set)', async () => {
  let capturedSql = null;
  const db = {
    async query(sql) {
      capturedSql = sql;
      return { rows: [fakeRow({ is_running: true })] };
    },
  };
  const state = await tryAcquireBatchLock(db);
  assert.match(capturedSql, /where id = 1 and is_running = false/);
  assert.equal(state.isRunning, true);
});

test('tryAcquireBatchLock returns null when a batch is already running (no row updated)', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await tryAcquireBatchLock(db), null);
});

test('releaseDiscoveryLock clears is_running and stamps the discovery last_run_at/next_run_at only', async () => {
  let capturedSql = null;
  let capturedParams = null;
  const db = {
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [fakeRow({ is_running: false, last_run_at: '2026-07-20T01:00:00Z' })] };
    },
  };
  const state = await releaseDiscoveryLock(db, { nextRunAt: '2026-07-23T00:00:00Z' });
  assert.equal(state.isRunning, false);
  assert.match(capturedSql, /next_run_at = coalesce/);
  assert.ok(!capturedSql.includes('processing_next_run_at ='));
  assert.deepEqual(capturedParams, [null, '2026-07-23T00:00:00Z']);
});

test('releaseProcessingLock clears is_running and stamps the processing last_run_at/next_run_at only', async () => {
  let capturedSql = null;
  let capturedParams = null;
  const db = {
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [fakeRow({ is_running: false, processing_last_run_at: '2026-07-20T01:00:00Z' })] };
    },
  };
  const state = await releaseProcessingLock(db, { nextRunAt: '2026-07-21T00:00:00Z' });
  assert.equal(state.isRunning, false);
  assert.match(capturedSql, /processing_next_run_at = coalesce/);
  assert.ok(!capturedSql.includes('\n       next_run_at ='));
  assert.deepEqual(capturedParams, [null, '2026-07-21T00:00:00Z']);
});

test('releaseLockOnly clears is_running without touching either schedule', async () => {
  let capturedSql = null;
  const db = { async query(sql) { capturedSql = sql; return { rows: [fakeRow({ is_running: false })] }; } };
  const state = await releaseLockOnly(db);
  assert.equal(state.isRunning, false);
  assert.ok(!capturedSql.includes('next_run_at'));
});
