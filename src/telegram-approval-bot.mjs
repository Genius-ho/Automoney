// 13.4 발주 승인 버튼's Telegram counterpart: the same approveSupplierOrder
// action the admin UI's confirm-gated button calls, reachable from a
// Telegram inline keyboard so real-money approval isn't stuck waiting for
// someone at the admin screen. "보류" (skip) intentionally takes no action
// on the row -- same "자동 처리 금지" caution as Phase 10's manual-only
// exceptions (see cancellation-handler.mjs) -- it only stops re-prompting
// this callback, the admin screen remains the way to actually decide later.
import {
  listSupplierOrdersAwaitingTelegramNotification,
  markSupplierOrderTelegramNotified,
} from './purchase-order-store.mjs';
import { approveSupplierOrder } from './purchase-order-approval.mjs';
import {
  sendTelegramMessage,
  getTelegramUpdates,
  answerCallbackQuery,
  editTelegramMessageText,
  escapeHtml,
} from './telegram-notifier.mjs';

function formatApprovalMessage(order) {
  const money = (value) => (value == null ? '-' : `${Number(value).toLocaleString()}원`);
  return [
    '🛒 <b>발주 승인 필요</b>',
    `채널: ${escapeHtml(order.channel)}`,
    `채널 주문번호: ${escapeHtml(order.channelOrderId)}`,
    `옵션: ${escapeHtml(order.optionInfo || '-')}`,
    `수량: ${order.supplierOrderQty ?? '-'}`,
    `판매금액: ${money(order.salePrice)}`,
    `예상 순이익: ${money(order.estimatedProfit)}`,
  ].join('\n');
}

function approvalKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: '✅ 승인 (실제 발주)', callback_data: `approve_po:${id}` },
      { text: '⏭ 보류', callback_data: `skip_po:${id}` },
    ]],
  };
}

// Runs on the same 30-minute cadence as purchaseOrderValidation (section
// 18) -- reads whatever that sweep most recently upserted rather than
// being chained to it directly, since telegram_notified_at makes this
// naturally idempotent regardless of tick ordering.
export async function notifyPendingPurchaseApprovals(db, telegramConfig, {
  listSupplierOrdersAwaitingTelegramNotificationImpl = listSupplierOrdersAwaitingTelegramNotification,
  markSupplierOrderTelegramNotifiedImpl = markSupplierOrderTelegramNotified,
  sendTelegramMessageImpl = sendTelegramMessage,
} = {}) {
  if (!telegramConfig) return { notified: 0 };
  const pending = await listSupplierOrdersAwaitingTelegramNotificationImpl(db);
  for (const order of pending) {
    await sendTelegramMessageImpl(telegramConfig, formatApprovalMessage(order), { replyMarkup: approvalKeyboard(order.id) });
    await markSupplierOrderTelegramNotifiedImpl(db, order.id);
  }
  return { notified: pending.length };
}

// Everything below the approveSupplierOrderImpl call is just relaying that
// already-final result back to Telegram -- a real order can genuinely have
// been placed by the time answerCallbackQuery or editMessageText throws
// (confirmed live: a callback answered after Telegram's response window
// closes fails with "query is too old"), so none of these notification
// steps may ever look like the approval itself failed, and one failing
// must not stop the others (or crash the caller's update loop) from
// running. editMessageText failing falls back to a brand-new message so
// the outcome is never silently lost.
async function notifyResult(telegramConfig, query, resultText, impls) {
  const { answerCallbackQueryImpl, editTelegramMessageTextImpl, sendTelegramMessageImpl } = impls;
  try {
    await answerCallbackQueryImpl(telegramConfig, query.id, { text: resultText.slice(0, 200) });
  } catch (error) {
    console.error(`telegramApprovalBot.answerCallbackQueryFailed=${error.message}`);
  }
  try {
    await editTelegramMessageTextImpl(
      telegramConfig,
      query.message.message_id,
      `${query.message.text}\n\n${escapeHtml(resultText)}`,
    );
  } catch (error) {
    console.error(`telegramApprovalBot.editMessageFailed=${error.message}`);
    try {
      await sendTelegramMessageImpl(telegramConfig, escapeHtml(resultText));
    } catch (fallbackError) {
      console.error(`telegramApprovalBot.fallbackSendFailed=${fallbackError.message}`);
    }
  }
}

async function handleApprove(db, domemeClient, telegramConfig, query, id, impls) {
  const { approveSupplierOrderImpl } = impls;
  let resultText;
  try {
    const result = await approveSupplierOrderImpl(db, domemeClient, id);
    resultText = result.status === 'supplier_ordered'
      ? `✅ 발주 완료 (도매매 주문번호 ${result.domemeOrderNo})`
      : `❌ 발주 실패/차단: ${result.failureMessage || JSON.stringify(result.blockReasons || [])}`;
  } catch (error) {
    resultText = `⚠️ 오류: ${error.message}`;
  }
  await notifyResult(telegramConfig, query, resultText, impls);
}

async function handleSkip(telegramConfig, query, impls) {
  await notifyResult(telegramConfig, query, '⏭ 보류됨 (변경 없음, 관리자 화면에서 처리)', impls);
}

export async function handlePurchaseOrderApprovalCallback(db, domemeClient, telegramConfig, query, {
  approveSupplierOrderImpl = approveSupplierOrder,
  answerCallbackQueryImpl = answerCallbackQuery,
  editTelegramMessageTextImpl = editTelegramMessageText,
  sendTelegramMessageImpl = sendTelegramMessage,
} = {}) {
  const [action, idText] = String(query?.data || '').split(':');
  const id = Number(idText);
  if (!['approve_po', 'skip_po'].includes(action) || !Number.isInteger(id) || id <= 0) return { handled: false };
  const impls = { approveSupplierOrderImpl, answerCallbackQueryImpl, editTelegramMessageTextImpl, sendTelegramMessageImpl };
  if (action === 'approve_po') await handleApprove(db, domemeClient, telegramConfig, query, id, impls);
  else await handleSkip(telegramConfig, query, impls);
  return { handled: true, action: action === 'approve_po' ? 'approve' : 'defer', id };
}

// Long-polling via getUpdates, not a webhook -- this app has no public
// HTTPS endpoint on the Windows dev box it currently runs on (see
// scheduler.mjs's own header comment on why this stays interim). offset is
// held in the closure so repeated pollOnce calls from one scheduler tick
// don't reprocess the same callback_query twice; it resets on process
// restart, which only risks replaying whatever callback taps landed in the
// last getUpdates window Telegram hasn't GC'd yet (bounded, non-money-moving
// worst case: a "보류" replay, or approveSupplierOrder's own re-validation
// simply finding nothing left to approve).
export function createTelegramApprovalPoller() {
  let offset;

  async function pollOnce(db, domemeClient, telegramConfig, {
    getTelegramUpdatesImpl = getTelegramUpdates,
    approveSupplierOrderImpl = approveSupplierOrder,
    answerCallbackQueryImpl = answerCallbackQuery,
    editTelegramMessageTextImpl = editTelegramMessageText,
    sendTelegramMessageImpl = sendTelegramMessage,
  } = {}) {
    if (!telegramConfig) return { processed: 0 };
    const updates = await getTelegramUpdatesImpl(telegramConfig, { offset });
    let processed = 0;
    for (const update of updates) {
      offset = update.update_id + 1;
      const query = update.callback_query;
      if (!query || !query.data) continue;
      const result = await handlePurchaseOrderApprovalCallback(db, domemeClient, telegramConfig, query, {
        approveSupplierOrderImpl, answerCallbackQueryImpl, editTelegramMessageTextImpl, sendTelegramMessageImpl,
      });
      if (result.handled) processed += 1;
    }
    return { processed };
  }

  return { pollOnce };
}
