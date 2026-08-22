import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCoupangLiveStatus,
  handleApprovedImages,
  reconcileCoupangQueue,
} from '../src/image-approval-registration.mjs';

function readyDeps(overrides = {}) {
  const calls = { claims: 0, creates: 0, notifies: 0, updates: [] };
  let registration = null;
  return {
    calls,
    getApprovedMainImageImpl: async () => ({ id: 1 }),
    getApprovedDetailSetImpl: async () => ({ id: 2, images: Array(10).fill({}) }),
    getQueueItemByDraftIdImpl: async () => ({ id: 3, draftId: 119, status: 'awaiting_image_approval' }),
    claimQueueItemStatusImpl: async (_db, draftId, from, to) => {
      calls.claims += 1;
      return calls.claims === 1 ? { id: 3, draftId, status: to, from } : null;
    },
    getRegistrationImpl: async () => registration,
    createDirectRegistrationImpl: async () => {
      calls.creates += 1;
      registration = { productDraftId: 119, sellerProductId: '16341358344', status: 'created' };
      return { registration, sellerProductId: registration.sellerProductId };
    },
    notifyPendingImpl: async () => { calls.notifies += 1; return { notified: 1 }; },
    updateQueueItemStatusImpl: async (_db, id, patch) => { calls.updates.push({ id, ...patch }); return { id, ...patch }; },
    telegramConfig: { botToken: 'test', chatId: '1' },
    coupangClient: { getProduct: async () => ({ data: { statusName: '승인대기중' } }) },
    ...overrides,
  };
}

test('image approval does nothing until both main and detail images are approved', async () => {
  const deps = readyDeps({ getApprovedDetailSetImpl: async () => null });
  const result = await handleApprovedImages({}, 'C:/repo', 118, deps);
  assert.equal(result.outcome, 'not_ready');
  assert.equal(deps.calls.claims, 0);
  assert.equal(deps.calls.creates, 0);
});

test('a lost atomic claim prevents a duplicate registration', async () => {
  const deps = readyDeps({ claimQueueItemStatusImpl: async () => null });
  const result = await handleApprovedImages({}, 'C:/repo', 119, deps);
  assert.equal(result.outcome, 'already_claimed');
  assert.equal(deps.calls.creates, 0);
});

test('concurrent approval callbacks create the Coupang product exactly once', async () => {
  const deps = readyDeps();
  const results = await Promise.all([
    handleApprovedImages({}, 'C:/repo', 119, deps),
    handleApprovedImages({}, 'C:/repo', 119, deps),
  ]);
  assert.deepEqual(results.map((item) => item.outcome).sort(), ['already_claimed', 'awaiting_sale_approval']);
  assert.equal(deps.calls.creates, 1);
  assert.equal(deps.calls.notifies, 1);
});

test('an existing registration is reused and notification advances the queue', async () => {
  const existing = { productDraftId: 119, sellerProductId: '16341358344', status: 'created' };
  const deps = readyDeps({ getRegistrationImpl: async () => existing });
  const result = await handleApprovedImages({}, 'C:/repo', 119, deps);
  assert.equal(result.outcome, 'awaiting_sale_approval');
  assert.equal(result.registration, existing);
  assert.equal(deps.calls.creates, 0);
  assert.equal(deps.calls.notifies, 1);
  assert.deepEqual(deps.calls.updates.at(-1), {
    id: 3, status: 'awaiting_sale_approval', failureStage: null, failureMessage: null,
  });
});

test('notification failure records a safe retryable failure after create', async () => {
  const deps = readyDeps({
    notifyPendingImpl: async () => { throw Object.assign(new Error('raw body with secret'), { code: 'TELEGRAM_DOWN' }); },
  });
  await assert.rejects(() => handleApprovedImages({}, 'C:/repo', 119, deps), /Telegram sale approval notification failed/);
  assert.equal(deps.calls.creates, 1);
  assert.deepEqual(deps.calls.updates.at(-1), {
    id: 3, status: 'failed', failureStage: 'telegram_sale_approval_notification', failureMessage: 'TELEGRAM_DOWN',
  });
});

test('retry after notification failure reuses the linked registration', async () => {
  const existing = { productDraftId: 119, sellerProductId: '16341358344', status: 'created' };
  const deps = readyDeps({
    getQueueItemByDraftIdImpl: async () => ({ id: 3, draftId: 119, status: 'failed' }),
    getRegistrationImpl: async () => existing,
    claimQueueItemStatusImpl: async (_db, draftId, from, to) => ({ id: 3, draftId, status: to, from }),
  });
  const result = await handleApprovedImages({}, 'C:/repo', 119, deps);
  assert.equal(result.outcome, 'awaiting_sale_approval');
  assert.equal(deps.calls.creates, 0);
  assert.equal(deps.calls.notifies, 1);
});

test('live Coupang statuses map to terminal and human-wait queue states', () => {
  assert.deepEqual(classifyCoupangLiveStatus('승인완료'), { status: 'completed' });
  assert.deepEqual(classifyCoupangLiveStatus('승인대기중'), { status: 'awaiting_sale_approval' });
  assert.deepEqual(classifyCoupangLiveStatus('승인반려'), { status: 'failed', failureStage: 'coupang_sale_approval', failureMessage: '승인반려' });
  assert.equal(classifyCoupangLiveStatus('임시저장'), null);
});

test('reconciliation completes a linked approved product without creating another listing', async () => {
  const updates = [];
  let creates = 0;
  const result = await reconcileCoupangQueue({}, {
    listQueueItemsImpl: async () => [{ id: 3, draftId: 119, status: 'awaiting_sale_approval' }],
    getRegistrationImpl: async () => ({ productDraftId: 119, sellerProductId: '16341358344' }),
    getLiveProductImpl: async () => ({ data: { statusName: '승인완료' } }),
    updateQueueItemStatusImpl: async (_db, id, patch) => updates.push({ id, ...patch }),
    createDirectRegistrationImpl: async () => { creates += 1; },
  });
  assert.deepEqual(result, { checked: 1, completed: 1, awaiting: 0, failed: 0, transientErrors: 0 });
  assert.deepEqual(updates, [{ id: 3, status: 'completed', failureStage: null, failureMessage: null }]);
  assert.equal(creates, 0);
});

test('reconciliation keeps transient live-read failures non-terminal', async () => {
  const updates = [];
  const result = await reconcileCoupangQueue({}, {
    listQueueItemsImpl: async () => [{ id: 7, draftId: 117, status: 'awaiting_sale_approval' }],
    getRegistrationImpl: async () => ({ productDraftId: 117, sellerProductId: '1' }),
    getLiveProductImpl: async () => { throw new Error('timeout'); },
    updateQueueItemStatusImpl: async (_db, id, patch) => updates.push({ id, ...patch }),
  });
  assert.equal(result.transientErrors, 1);
  assert.deepEqual(updates, []);
});
