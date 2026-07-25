import assert from 'node:assert/strict';
import test from 'node:test';

import { startScheduledJobs, stopScheduledJobs, ORDER_TICK_INTERVAL_MS, DISPATCH_TICK_INTERVAL_MS, SUPPLIER_MONITOR_TICK_INTERVAL_MS } from '../src/scheduler.mjs';

test('startScheduledJobs returns no handles (no-op) when config is unavailable', async () => {
  const handles = await startScheduledJobs({}, '/root', { loadSchedulerDepsImpl: async () => null });
  assert.deepEqual(handles, []);
});

test('startScheduledJobs schedules one tick per sweep, with the section-18 intervals', async () => {
  const scheduled = [];
  const handles = await startScheduledJobs({}, '/root', {
    loadSchedulerDepsImpl: async () => ({ coupangClient: {}, naverClient: {}, domemeClient: {}, domemePrivateClient: {} }),
    tickImpl: (label, intervalMs, fn) => { scheduled.push({ label, intervalMs }); return { label }; },
  });
  assert.equal(handles.length, 9);
  const byLabel = Object.fromEntries(scheduled.map((s) => [s.label, s.intervalMs]));
  assert.equal(byLabel.coupangOrders, ORDER_TICK_INTERVAL_MS);
  assert.equal(byLabel.naverOrders, ORDER_TICK_INTERVAL_MS);
  assert.equal(byLabel.coupangReturns, ORDER_TICK_INTERVAL_MS);
  assert.equal(byLabel.naverClaims, ORDER_TICK_INTERVAL_MS);
  assert.equal(byLabel.purchaseOrderValidation, ORDER_TICK_INTERVAL_MS);
  assert.equal(byLabel.shipments, ORDER_TICK_INTERVAL_MS);
  assert.equal(byLabel.dispatch, DISPATCH_TICK_INTERVAL_MS);
  assert.equal(byLabel.cancellationExceptions, DISPATCH_TICK_INTERVAL_MS);
  assert.equal(byLabel.supplierMonitor, SUPPLIER_MONITOR_TICK_INTERVAL_MS);
});

test('stopScheduledJobs clears every handle, and tolerates an empty/undefined list', () => {
  const cleared = [];
  const fakeHandle = (id) => ({ id });
  const originalClearInterval = global.clearInterval;
  global.clearInterval = (handle) => cleared.push(handle.id);
  try {
    stopScheduledJobs([fakeHandle(1), fakeHandle(2)]);
    assert.deepEqual(cleared, [1, 2]);
    assert.doesNotThrow(() => stopScheduledJobs([]));
    assert.doesNotThrow(() => stopScheduledJobs(undefined));
  } finally {
    global.clearInterval = originalClearInterval;
  }
});
