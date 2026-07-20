import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBatchScheduleState,
  releaseBatchLock,
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
    updated_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

test('getBatchScheduleState returns null when the single row is somehow missing', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getBatchScheduleState(db), null);
});

test('getBatchScheduleState maps the row to camelCase', async () => {
  const db = { async query() { return { rows: [fakeRow()] }; } };
  const state = await getBatchScheduleState(db);
  assert.equal(state.intervalDays, 3);
  assert.equal(state.isRunning, false);
  assert.equal(state.minPassingScore, 60);
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
  assert.deepEqual(capturedParams, [5, null, null]);
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

test('releaseBatchLock clears is_running and stamps last_run_at', async () => {
  let capturedParams = null;
  const db = {
    async query(sql, params) {
      capturedParams = params;
      return { rows: [fakeRow({ is_running: false, last_run_at: '2026-07-20T01:00:00Z' })] };
    },
  };
  const state = await releaseBatchLock(db, { nextRunAt: '2026-07-23T00:00:00Z' });
  assert.equal(state.isRunning, false);
  assert.deepEqual(capturedParams, [null, '2026-07-23T00:00:00Z']);
});
