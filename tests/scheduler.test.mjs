import assert from 'node:assert/strict';
import test from 'node:test';

import { startScheduledJobs, stopScheduledJobs, tick, ORDER_TICK_INTERVAL_MS, DISPATCH_TICK_INTERVAL_MS, SUPPLIER_MONITOR_TICK_INTERVAL_MS, TELEGRAM_APPROVAL_POLL_INTERVAL_MS } from '../src/scheduler.mjs';

function fakeSetInterval(callback) {
  const promise = callback();
  return { unref: () => {}, promise };
}

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
  assert.equal(handles.length, 11);
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
  assert.equal(byLabel.purchaseOrderTelegramNotify, ORDER_TICK_INTERVAL_MS);
  assert.equal(byLabel.telegramApprovalPoll, TELEGRAM_APPROVAL_POLL_INTERVAL_MS);
});

test('tick sends a telegram critical alert (labeled scheduler.<label>) when fn rejects', async () => {
  const alerts = [];
  const sendCriticalAlertImpl = async (telegramConfig, label, message) => {
    alerts.push({ telegramConfig, label, message });
  };
  const telegramConfig = { botToken: 't', chatId: 'c' };
  const handle = tick('coupangOrders', 1000, () => { throw new Error('boom'); }, {
    setIntervalImpl: fakeSetInterval,
    telegramConfig,
    sendCriticalAlertImpl,
  });
  await handle.promise;
  assert.deepEqual(alerts, [{ telegramConfig, label: 'scheduler.coupangOrders', message: 'boom' }]);
});

test('tick does not send an alert when fn succeeds', async () => {
  const alerts = [];
  const sendCriticalAlertImpl = async (...args) => alerts.push(args);
  const handle = tick('coupangOrders', 1000, () => ({ ok: true }), {
    setIntervalImpl: fakeSetInterval,
    sendCriticalAlertImpl,
  });
  await handle.promise;
  assert.equal(alerts.length, 0);
});

test('tick swallows a failure from sendCriticalAlertImpl itself rather than crashing the tick', async () => {
  const sendCriticalAlertImpl = async () => { throw new Error('telegram down'); };
  const handle = tick('coupangOrders', 1000, () => { throw new Error('boom'); }, {
    setIntervalImpl: fakeSetInterval,
    sendCriticalAlertImpl,
  });
  await assert.doesNotReject(handle.promise);
});

test('startScheduledJobs passes the loaded telegramConfig through to every tickImpl call', async () => {
  const telegramConfig = { botToken: 't', chatId: 'c' };
  const seen = [];
  await startScheduledJobs({}, '/root', {
    loadSchedulerDepsImpl: async () => ({ coupangClient: {}, naverClient: {}, domemeClient: {}, domemePrivateClient: {}, telegramConfig }),
    tickImpl: (label, intervalMs, fn, opts) => { seen.push(opts?.telegramConfig); return { label }; },
  });
  assert.equal(seen.length, 11);
  assert.ok(seen.every((config) => config === telegramConfig));
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
