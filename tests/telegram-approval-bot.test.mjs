import assert from 'node:assert/strict';
import test from 'node:test';

import { notifyPendingPurchaseApprovals, createTelegramApprovalPoller } from '../src/telegram-approval-bot.mjs';

const telegramConfig = { botToken: 't', chatId: 'c' };

test('notifyPendingPurchaseApprovals is a no-op when telegram is unconfigured', async () => {
  const result = await notifyPendingPurchaseApprovals({}, null, {
    listSupplierOrdersAwaitingTelegramNotificationImpl: async () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(result, { notified: 0 });
});

test('notifyPendingPurchaseApprovals sends one message with an approve/skip inline keyboard per pending order, then marks it notified', async () => {
  const order = {
    id: 5, channel: 'coupang', channelOrderId: '22000009546234', optionInfo: '블랙',
    supplierOrderQty: 2, salePrice: 19900, estimatedProfit: 900,
  };
  const sent = [];
  const notifiedIds = [];
  const result = await notifyPendingPurchaseApprovals({}, telegramConfig, {
    listSupplierOrdersAwaitingTelegramNotificationImpl: async () => [order],
    sendTelegramMessageImpl: async (config, text, options) => { sent.push({ config, text, options }); },
    markSupplierOrderTelegramNotifiedImpl: async (db, id) => { notifiedIds.push(id); },
  });
  assert.equal(result.notified, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /채널: coupang/);
  assert.match(sent[0].text, /채널 주문번호: 22000009546234/);
  assert.match(sent[0].text, /옵션: 블랙/);
  assert.match(sent[0].text, /수량: 2/);
  assert.match(sent[0].text, /판매금액: 19,900원/);
  assert.match(sent[0].text, /예상 순이익: 900원/);
  assert.deepEqual(sent[0].options.replyMarkup, {
    inline_keyboard: [[
      { text: '✅ 승인 (실제 발주)', callback_data: 'approve_po:5' },
      { text: '⏭ 보류', callback_data: 'skip_po:5' },
    ]],
  });
  assert.deepEqual(notifiedIds, [5]);
});

test('createTelegramApprovalPoller.pollOnce is a no-op when telegram is unconfigured', async () => {
  const poller = createTelegramApprovalPoller();
  const result = await poller.pollOnce({}, {}, null, {
    getTelegramUpdatesImpl: async () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(result, { processed: 0 });
});

test('pollOnce ignores updates with no callback_query or unrecognized action, without erroring', async () => {
  const poller = createTelegramApprovalPoller();
  const result = await poller.pollOnce({}, {}, telegramConfig, {
    getTelegramUpdatesImpl: async () => [
      { update_id: 1, message: { text: 'hi' } },
      { update_id: 2, callback_query: { id: 'cb1', data: 'unknown_action:1', message: { message_id: 1, text: 'x' } } },
    ],
  });
  assert.deepEqual(result, { processed: 0 });
});

test('pollOnce handles approve_po: calls approveSupplierOrder, answers the callback, and appends the result to the message', async () => {
  const poller = createTelegramApprovalPoller();
  const answered = [];
  const edited = [];
  const result = await poller.pollOnce({}, { fake: true }, telegramConfig, {
    getTelegramUpdatesImpl: async () => [
      { update_id: 10, callback_query: { id: 'cb1', data: 'approve_po:5', message: { message_id: 100, text: '🛒 발주 승인 필요' } } },
    ],
    approveSupplierOrderImpl: async (db, domemeClient, id) => {
      assert.equal(id, 5);
      return { status: 'supplier_ordered', domemeOrderNo: '14207678' };
    },
    answerCallbackQueryImpl: async (config, id, options) => answered.push({ config, id, options }),
    editTelegramMessageTextImpl: async (config, messageId, text) => edited.push({ config, messageId, text }),
  });
  assert.equal(result.processed, 1);
  assert.match(answered[0].options.text, /발주 완료/);
  assert.match(edited[0].text, /🛒 발주 승인 필요/);
  assert.match(edited[0].text, /발주 완료 \(도매매 주문번호 14207678\)/);
  assert.equal(edited[0].messageId, 100);
});

test('pollOnce handles approve_po: reports a blocked/failed result without throwing', async () => {
  const poller = createTelegramApprovalPoller();
  const edited = [];
  await poller.pollOnce({}, {}, telegramConfig, {
    getTelegramUpdatesImpl: async () => [
      { update_id: 11, callback_query: { id: 'cb2', data: 'approve_po:6', message: { message_id: 101, text: 'x' } } },
    ],
    approveSupplierOrderImpl: async () => ({ status: 'validating_supplier', failureMessage: 'TOO_LESS_EMONEY_ERROR' }),
    answerCallbackQueryImpl: async () => {},
    editTelegramMessageTextImpl: async (config, messageId, text) => edited.push(text),
  });
  assert.match(edited[0], /발주 실패\/차단: TOO_LESS_EMONEY_ERROR/);
});

test('pollOnce handles approve_po: catches a thrown error from approveSupplierOrder rather than propagating it', async () => {
  const poller = createTelegramApprovalPoller();
  const edited = [];
  await assert.doesNotReject(() => poller.pollOnce({}, {}, telegramConfig, {
    getTelegramUpdatesImpl: async () => [
      { update_id: 12, callback_query: { id: 'cb3', data: 'approve_po:7', message: { message_id: 102, text: 'x' } } },
    ],
    approveSupplierOrderImpl: async () => { throw new Error('DomemePrivateApiError: boom'); },
    answerCallbackQueryImpl: async () => {},
    editTelegramMessageTextImpl: async (config, messageId, text) => edited.push(text),
  }));
  assert.match(edited[0], /⚠️ 오류: DomemePrivateApiError: boom/);
});

test('pollOnce handles skip_po: answers and edits the message without calling approveSupplierOrder', async () => {
  const poller = createTelegramApprovalPoller();
  const edited = [];
  const result = await poller.pollOnce({}, {}, telegramConfig, {
    getTelegramUpdatesImpl: async () => [
      { update_id: 13, callback_query: { id: 'cb4', data: 'skip_po:8', message: { message_id: 103, text: 'x' } } },
    ],
    approveSupplierOrderImpl: async () => { throw new Error('should not be called'); },
    answerCallbackQueryImpl: async () => {},
    editTelegramMessageTextImpl: async (config, messageId, text) => edited.push(text),
  });
  assert.equal(result.processed, 1);
  assert.match(edited[0], /보류됨/);
});

test('pollOnce still edits the message with the approval result even when answerCallbackQuery fails (e.g. an expired callback query) rather than losing the outcome', async () => {
  const poller = createTelegramApprovalPoller();
  const edited = [];
  const result = await poller.pollOnce({}, {}, telegramConfig, {
    getTelegramUpdatesImpl: async () => [
      { update_id: 14, callback_query: { id: 'cb5', data: 'approve_po:9', message: { message_id: 104, text: 'x' } } },
    ],
    approveSupplierOrderImpl: async () => ({ status: 'supplier_ordered', domemeOrderNo: '999' }),
    answerCallbackQueryImpl: async () => { throw new Error('query is too old'); },
    editTelegramMessageTextImpl: async (config, messageId, text) => edited.push(text),
  });
  assert.equal(result.processed, 1);
  assert.match(edited[0], /발주 완료 \(도매매 주문번호 999\)/);
});

test('pollOnce falls back to sending a brand-new message when editing the original message also fails, so the outcome is never silently lost', async () => {
  const poller = createTelegramApprovalPoller();
  const sent = [];
  const result = await poller.pollOnce({}, {}, telegramConfig, {
    getTelegramUpdatesImpl: async () => [
      { update_id: 15, callback_query: { id: 'cb6', data: 'approve_po:10', message: { message_id: 105, text: 'x' } } },
    ],
    approveSupplierOrderImpl: async () => ({ status: 'supplier_ordered', domemeOrderNo: '1000' }),
    answerCallbackQueryImpl: async () => {},
    editTelegramMessageTextImpl: async () => { throw new Error('message not found'); },
    sendTelegramMessageImpl: async (config, text) => sent.push(text),
  });
  assert.equal(result.processed, 1);
  assert.match(sent[0], /발주 완료 \(도매매 주문번호 1000\)/);
});

test('pollOnce advances its internal offset past every update_id seen, even non-callback ones, so a repeat call does not reprocess them', async () => {
  const poller = createTelegramApprovalPoller();
  const seenOffsets = [];
  await poller.pollOnce({}, {}, telegramConfig, {
    getTelegramUpdatesImpl: async (config, { offset }) => { seenOffsets.push(offset); return [{ update_id: 20, message: {} }]; },
  });
  await poller.pollOnce({}, {}, telegramConfig, {
    getTelegramUpdatesImpl: async (config, { offset }) => { seenOffsets.push(offset); return []; },
  });
  assert.deepEqual(seenOffsets, [undefined, 21]);
});
