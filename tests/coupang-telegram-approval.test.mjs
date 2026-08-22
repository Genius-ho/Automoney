import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleCoupangApprovalCallback,
  notifyPendingCoupangSaleApprovals,
} from '../src/coupang-telegram-approval.mjs';

const telegramConfig = { botToken: 'token', chatId: 'chat' };

function callbackQuery(data) {
  return { id: 'query-1', data, message: { message_id: 987, text: 'original' } };
}

test('notification sends an escaped listing summary and persists the returned Telegram message id', async () => {
  let sent;
  let marked;
  const result = await notifyPendingCoupangSaleApprovals({}, telegramConfig, {
    listPendingImpl: async () => [{
      productDraftId: 119,
      sellerProductId: '16341358344',
      sellerProductName: '<rack & stand>',
      status: 'created',
      salePrice: 42140,
      options: [{ name: 'black', stockQuantity: 1 }, { name: 'white', stockQuantity: 1 }],
    }],
    getLiveProductImpl: async () => ({ data: {
      statusName: 'temporary',
      items: [
        { itemName: 'black', salePrice: 42140, maximumBuyCount: 1 },
        { itemName: 'white', salePrice: 42140, maximumBuyCount: 1 },
      ],
    } }),
    sendTelegramMessageImpl: async (config, text, options) => {
      sent = { config, text, options };
      return { message_id: 987 };
    },
    markNotifiedImpl: async (db, draftId, messageId) => { marked = { draftId, messageId }; },
  });

  assert.deepEqual(result, { notified: 1 });
  assert.match(sent.text, /&lt;rack &amp; stand&gt;/);
  assert.match(sent.text, /42,140/);
  assert.match(sent.text, /temporary/);
  assert.match(sent.text, /black: 1/);
  assert.equal(sent.options.replyMarkup.inline_keyboard[0][0].callback_data, 'approve_cp:119');
  assert.equal(sent.options.replyMarkup.inline_keyboard[0][1].callback_data, 'defer_cp:119');
  assert.deepEqual(marked, { draftId: 119, messageId: 987 });
});

test('notification is a no-op when Telegram is unconfigured', async () => {
  const result = await notifyPendingCoupangSaleApprovals({}, null, {
    listPendingImpl: async () => { throw new Error('must not query'); },
  });
  assert.deepEqual(result, { notified: 0 });
});

test('notification does not mark a row when Telegram returns no message id', async () => {
  let marked = false;
  await assert.rejects(() => notifyPendingCoupangSaleApprovals({}, telegramConfig, {
    listPendingImpl: async () => [{ productDraftId: 119, sellerProductId: '1', options: [] }],
    getLiveProductImpl: async () => ({ data: { statusName: 'temporary', items: [] } }),
    sendTelegramMessageImpl: async () => ({ ok: true }),
    markNotifiedImpl: async () => { marked = true; },
  }), /message id/);
  assert.equal(marked, false);
});

test('approve callback delegates exactly once and completes the queue from live approval status', async () => {
  let approvalCalls = 0;
  const edited = [];
  const updates = [];
  const result = await handleCoupangApprovalCallback({}, telegramConfig, callbackQuery('approve_cp:119'), {
    requestApprovalImpl: async (db, draftId) => {
      approvalCalls += 1;
      assert.equal(draftId, 119);
      return { liveStatusNameBefore: '임시저장', liveStatusNameAfter: '승인완료' };
    },
    getQueueItemByDraftIdImpl: async () => ({ id: 3, status: 'awaiting_sale_approval' }),
    updateQueueItemStatusImpl: async (_db, id, patch) => updates.push({ id, ...patch }),
    answerCallbackQueryImpl: async () => {},
    editTelegramMessageTextImpl: async (config, messageId, text) => edited.push({ messageId, text }),
    sendTelegramMessageImpl: async () => { throw new Error('fallback should not run'); },
  });

  assert.deepEqual(result, { handled: true, action: 'approve', draftId: 119, liveStatusName: '승인완료', queueStatus: 'completed' });
  assert.equal(approvalCalls, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /119/);
  assert.deepEqual(updates, [{ id: 3, status: 'completed', failureStage: null, failureMessage: null }]);
});

test('approve callback keeps approval-pending products in the human wait state', async () => {
  const updates = [];
  const result = await handleCoupangApprovalCallback({}, telegramConfig, callbackQuery('approve_cp:119'), {
    requestApprovalImpl: async () => ({ liveStatusNameAfter: '승인대기중' }),
    getQueueItemByDraftIdImpl: async () => ({ id: 3 }),
    updateQueueItemStatusImpl: async (_db, id, patch) => updates.push({ id, ...patch }),
    answerCallbackQueryImpl: async () => {}, editTelegramMessageTextImpl: async () => {}, sendTelegramMessageImpl: async () => {},
  });
  assert.equal(result.queueStatus, 'awaiting_sale_approval');
  assert.equal(updates[0].status, 'awaiting_sale_approval');
});

test('explicit live rejection marks the queue failed even when approval request refuses', async () => {
  const updates = [];
  const error = Object.assign(new Error('not temporary'), { code: 'NOT_TEMPORARY_SAVED', liveStatusName: '승인반려' });
  const result = await handleCoupangApprovalCallback({}, telegramConfig, callbackQuery('approve_cp:119'), {
    requestApprovalImpl: async () => { throw error; },
    getQueueItemByDraftIdImpl: async () => ({ id: 3 }),
    updateQueueItemStatusImpl: async (_db, id, patch) => updates.push({ id, ...patch }),
    answerCallbackQueryImpl: async () => {}, editTelegramMessageTextImpl: async () => {}, sendTelegramMessageImpl: async () => {},
  });
  assert.equal(result.queueStatus, 'failed');
  assert.deepEqual(updates[0], { id: 3, status: 'failed', failureStage: 'coupang_sale_approval', failureMessage: '승인반려' });
});

test('defer callback performs no Coupang mutation', async () => {
  let approvalCalls = 0;
  const result = await handleCoupangApprovalCallback({}, telegramConfig, callbackQuery('defer_cp:119'), {
    requestApprovalImpl: async () => { approvalCalls += 1; },
    answerCallbackQueryImpl: async () => {},
    editTelegramMessageTextImpl: async () => {},
    sendTelegramMessageImpl: async () => {},
  });
  assert.deepEqual(result, { handled: true, action: 'defer', draftId: 119 });
  assert.equal(approvalCalls, 0);
});

test('approval refusal is shown without retrying and edit failure falls back to a new message', async () => {
  let approvalCalls = 0;
  const fallback = [];
  const refusal = Object.assign(new Error('already requested'), { code: 'ALREADY_REQUESTED' });
  await handleCoupangApprovalCallback({}, telegramConfig, callbackQuery('approve_cp:119'), {
    requestApprovalImpl: async () => { approvalCalls += 1; throw refusal; },
    answerCallbackQueryImpl: async () => { throw new Error('query expired'); },
    editTelegramMessageTextImpl: async () => { throw new Error('message gone'); },
    sendTelegramMessageImpl: async (config, text) => fallback.push(text),
  });
  assert.equal(approvalCalls, 1);
  assert.equal(fallback.length, 1);
  assert.match(fallback[0], /already requested/);
});

test('unrelated and malformed callbacks are ignored', async () => {
  const deps = { requestApprovalImpl: async () => { throw new Error('must not run'); } };
  assert.deepEqual(await handleCoupangApprovalCallback({}, telegramConfig, callbackQuery('approve_po:1'), deps), { handled: false });
  assert.deepEqual(await handleCoupangApprovalCallback({}, telegramConfig, callbackQuery('approve_cp:nope'), deps), { handled: false });
});
