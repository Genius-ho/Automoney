import assert from 'node:assert/strict';
import test from 'node:test';

import { createNonOverlappingRunner, startScheduledJobs, stopScheduledJobs, tick, msUntilNextDailyTime, ORDER_TICK_INTERVAL_MS, DISPATCH_TICK_INTERVAL_MS, SUPPLIER_MONITOR_TICK_INTERVAL_MS, TELEGRAM_APPROVAL_POLL_INTERVAL_MS, DAILY_SUMMARY_TICK_INTERVAL_MS, COUPANG_KEYWORD_REQUEST_TICK_INTERVAL_MS, COUPANG_KEYWORD_REQUEST_HOUR_KST, COUPANG_KEYWORD_REQUEST_MINUTE_KST } from '../src/scheduler.mjs';

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
    setTimeoutImpl: (fn) => { fn(); return {}; },
  });
  assert.equal(handles.length, 14);
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
  assert.equal(byLabel.coupangSaleApprovalTelegramNotify, ORDER_TICK_INTERVAL_MS);
  assert.equal(byLabel.telegramApprovalPoll, TELEGRAM_APPROVAL_POLL_INTERVAL_MS);
  assert.equal(byLabel.dailySummary, DAILY_SUMMARY_TICK_INTERVAL_MS);
  assert.equal(byLabel.coupangKeywordRequest, COUPANG_KEYWORD_REQUEST_TICK_INTERVAL_MS);
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

test('tick skips a second overlapping run instead of starting it concurrently', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fn = async () => { calls += 1; await pending; return { ok: true }; };
  let callback;
  const handle = tick('coupangOrders', 1000, fn, {
    setIntervalImpl: (cb) => { callback = cb; return { unref: () => {}, promise: cb() }; },
  });
  // Simulate the interval firing again while the first run is still pending
  // (e.g. a slow network call outliving intervalMs) -- this must not start a
  // second concurrent fn() call.
  const second = callback();
  release();
  await handle.promise;
  await second;
  assert.equal(calls, 1);
});

test('tick with consecutiveFailuresBeforeAlert > 1 stays silent through isolated failures and only alerts once the threshold is reached', async () => {
  const alerts = [];
  const sendCriticalAlertImpl = async (...args) => alerts.push(args);
  let callback;
  const handle = tick('telegramApprovalPoll', 15_000, () => { throw new Error('gateway timeout'); }, {
    setIntervalImpl: (cb) => { callback = cb; return { unref: () => {}, promise: cb() }; },
    sendCriticalAlertImpl,
    consecutiveFailuresBeforeAlert: 3,
  });
  await handle.promise; // failure 1
  assert.equal(alerts.length, 0);
  await callback(); // failure 2
  assert.equal(alerts.length, 0);
  await callback(); // failure 3 -- threshold reached
  assert.equal(alerts.length, 1);
  assert.match(alerts[0][2], /gateway timeout/);
});

test('tick resets the consecutive-failure count after a success, so a later isolated failure does not immediately alert', async () => {
  const alerts = [];
  const sendCriticalAlertImpl = async (...args) => alerts.push(args);
  let shouldFail = true;
  let callback;
  const handle = tick('telegramApprovalPoll', 15_000, () => {
    if (shouldFail) throw new Error('gateway timeout');
    return { ok: true };
  }, {
    setIntervalImpl: (cb) => { callback = cb; return { unref: () => {}, promise: cb() }; },
    sendCriticalAlertImpl,
    consecutiveFailuresBeforeAlert: 2,
  });
  await handle.promise; // failure 1 of 2 -- no alert yet
  shouldFail = false;
  await callback(); // success -- resets the counter
  shouldFail = true;
  await callback(); // failure 1 of 2 again (not failure 2 overall)
  assert.equal(alerts.length, 0);
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

test('startScheduledJobs raises telegramApprovalPoll\'s consecutiveFailuresBeforeAlert above every other tick\'s default', async () => {
  const seen = {};
  await startScheduledJobs({}, '/root', {
    loadSchedulerDepsImpl: async () => ({ coupangClient: {}, naverClient: {}, domemeClient: {}, domemePrivateClient: {} }),
    tickImpl: (label, intervalMs, fn, opts) => { seen[label] = opts?.consecutiveFailuresBeforeAlert; return { label }; },
    setTimeoutImpl: (fn) => { fn(); return {}; },
  });
  assert.equal(seen.telegramApprovalPoll, 4);
  assert.equal(seen.coupangOrders, undefined);
  assert.equal(seen.dailySummary, undefined);
});

test('startScheduledJobs passes the loaded telegramConfig through to every tickImpl call', async () => {
  const telegramConfig = { botToken: 't', chatId: 'c' };
  const seen = [];
  await startScheduledJobs({}, '/root', {
    loadSchedulerDepsImpl: async () => ({ coupangClient: {}, naverClient: {}, domemeClient: {}, domemePrivateClient: {}, telegramConfig }),
    tickImpl: (label, intervalMs, fn, opts) => { seen.push(opts?.telegramConfig); return { label }; },
    setTimeoutImpl: (fn) => { fn(); return {}; },
  });
  assert.equal(seen.length, 14);
  assert.ok(seen.every((config) => config === telegramConfig));
});

test('startScheduledJobs uses one shared callback router and passes Coupang to notification and polling jobs', async () => {
  const jobs = new Map();
  const coupangClient = { kind: 'coupang' };
  const domemePrivateClient = { kind: 'domeme-private' };
  const domemeClient = { kind: 'domeme-search' };
  const pricingRules = { defaultMarginRate: 0.25 };
  const telegramConfig = { botToken: 't', chatId: 'c' };
  const notificationCalls = [];
  const pollCalls = [];
  const reconciliationCalls = [];
  await startScheduledJobs({ kind: 'db' }, '/root', {
    loadSchedulerDepsImpl: async () => ({ coupangClient, naverClient: {}, domemeClient, domemePrivateClient, pricingRules, telegramConfig }),
    tickImpl: (label, intervalMs, fn) => { jobs.set(label, fn); return { label }; },
    notifyPendingCoupangSaleApprovalsImpl: async (...args) => { notificationCalls.push(args); return { notified: 1 }; },
    reconcileCoupangQueueImpl: async (...args) => { reconciliationCalls.push(args); return { checked: 0 }; },
    createTelegramCallbackRouterImpl: () => ({
      pollOnce: async (...args) => { pollCalls.push(args); return { processed: 0 }; },
    }),
    setTimeoutImpl: (fn) => { fn(); return {}; },
  });

  await jobs.get('coupangSaleApprovalTelegramNotify')();
  await jobs.get('telegramApprovalPoll')();

  assert.equal(notificationCalls[0][1], telegramConfig);
  assert.equal(notificationCalls[0][2].coupangClient, coupangClient);
  assert.equal(reconciliationCalls.length, 1);
  assert.equal(reconciliationCalls[0][1].coupangClient, coupangClient);
  assert.equal(pollCalls[0][1].coupangClient, coupangClient);
  assert.equal(pollCalls[0][1].domemeClient, domemePrivateClient);
  assert.equal(pollCalls[0][1].domemeSearchClient, domemeClient);
  assert.equal(pollCalls[0][1].pricingRules, pricingRules);
  assert.equal(pollCalls[0][1].rootDir, '/root');
  assert.equal(pollCalls[0][2], telegramConfig);
});

test('startScheduledJobs wires coupangKeywordRequest to requestDailyCoupangKeywords with the loaded telegramConfig', async () => {
  const jobs = new Map();
  const telegramConfig = { botToken: 't', chatId: 'c' };
  const requestCalls = [];
  await startScheduledJobs({}, '/root', {
    loadSchedulerDepsImpl: async () => ({ coupangClient: {}, naverClient: {}, domemeClient: {}, domemePrivateClient: {}, telegramConfig }),
    tickImpl: (label, intervalMs, fn) => { jobs.set(label, fn); return { label }; },
    requestDailyCoupangKeywordsImpl: async (...args) => { requestCalls.push(args); },
    setTimeoutImpl: (fn) => { fn(); return {}; },
  });
  await jobs.get('coupangKeywordRequest')();
  assert.deepEqual(requestCalls, [[telegramConfig]]);
});

test('startScheduledJobs delays coupangKeywordRequest\'s first registration until the next occurrence of the configured KST time, not an immediate 24h tick', async () => {
  let receivedDelayMs = null;
  await startScheduledJobs({}, '/root', {
    loadSchedulerDepsImpl: async () => ({ coupangClient: {}, naverClient: {}, domemeClient: {}, domemePrivateClient: {} }),
    tickImpl: (label, intervalMs, fn) => ({ label }),
    setTimeoutImpl: (fn, delayMs) => { receivedDelayMs = delayMs; return {}; },
    nowImpl: () => new Date(2026, 7, 21, 10, 43, 0),
  });
  // 10:43 is already past today's 10:00 target -> next occurrence is tomorrow's 10:00.
  assert.equal(receivedDelayMs, msUntilNextDailyTime(COUPANG_KEYWORD_REQUEST_HOUR_KST, COUPANG_KEYWORD_REQUEST_MINUTE_KST, new Date(2026, 7, 21, 10, 43, 0)));
  assert.ok(receivedDelayMs > 0);
});

test('startScheduledJobs uses coupangKeywordRequestDelayMsOverride when supplied, bypassing the computed KST-time delay', async () => {
  let receivedDelayMs = null;
  await startScheduledJobs({}, '/root', {
    loadSchedulerDepsImpl: async () => ({ coupangClient: {}, naverClient: {}, domemeClient: {}, domemePrivateClient: {} }),
    tickImpl: (label, intervalMs, fn) => ({ label }),
    setTimeoutImpl: (fn, delayMs) => { receivedDelayMs = delayMs; return {}; },
    coupangKeywordRequestDelayMsOverride: 12345,
  });
  assert.equal(receivedDelayMs, 12345);
});

test('non-overlapping reconciliation skips a second invocation while the first is pending', async () => {
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const run = createNonOverlappingRunner(async () => { calls += 1; await pending; return { checked: 1 }; });
  const first = run();
  const second = await run();
  assert.deepEqual(second, { skipped: true, reason: 'ALREADY_RUNNING' });
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { checked: 1 });
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

test('msUntilNextDailyTime rolls to tomorrow when the target time already passed today', () => {
  const now = new Date(2026, 7, 21, 10, 43, 0);
  const ms = msUntilNextDailyTime(10, 0, now);
  const expected = new Date(2026, 7, 22, 10, 0, 0).getTime() - now.getTime();
  assert.equal(ms, expected);
});

test('msUntilNextDailyTime targets later today when the target time has not passed yet', () => {
  const now = new Date(2026, 7, 21, 9, 15, 0);
  const ms = msUntilNextDailyTime(10, 0, now);
  const expected = new Date(2026, 7, 21, 10, 0, 0).getTime() - now.getTime();
  assert.equal(ms, expected);
});

test('msUntilNextDailyTime treats an exact match on the target time as already passed (rolls to tomorrow)', () => {
  const now = new Date(2026, 7, 21, 10, 0, 0);
  const ms = msUntilNextDailyTime(10, 0, now);
  const expected = new Date(2026, 7, 22, 10, 0, 0).getTime() - now.getTime();
  assert.equal(ms, expected);
});
