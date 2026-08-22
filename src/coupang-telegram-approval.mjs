import {
  listCoupangRegistrationsAwaitingTelegramNotification,
  markCoupangRegistrationTelegramNotified,
} from './coupang-registration-store.mjs';
import { requestCoupangSaleApproval } from './coupang-registration-flow.mjs';
import { classifyCoupangLiveStatus } from './image-approval-registration.mjs';
import { getQueueItemByDraftId, updateQueueItemStatus } from './processing-queue-store.mjs';
import {
  answerCallbackQuery,
  editTelegramMessageText,
  escapeHtml,
  sendTelegramMessage,
} from './telegram-notifier.mjs';

const COPY = Object.freeze({
  heading: '\uD83D\uDED2 <b>\uCFE0\uD321 \uD310\uB9E4\uC2B9\uC778 \uC694\uCCAD \uD544\uC694</b>',
  approve: '\uCFE0\uD321 \uD310\uB9E4\uC2B9\uC778 \uC694\uCCAD',
  defer: '\uBCF4\uB958',
  approved: '\u2705 \uCFE0\uD321 \uD310\uB9E4\uC2B9\uC778 \uC694\uCCAD \uC644\uB8CC',
  deferred: '\u23F8 \uBCF4\uB958\uB428 (\uC678\uBD80 \uC0C1\uD0DC \uBCC0\uACBD \uC5C6\uC74C)',
});

function approvalKeyboard(draftId) {
  return {
    inline_keyboard: [[
      { text: COPY.approve, callback_data: `approve_cp:${draftId}` },
      { text: COPY.defer, callback_data: `defer_cp:${draftId}` },
    ]],
  };
}

function formatListingMessage(registration, live) {
  const data = live?.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const salePrice = items[0]?.salePrice ?? registration.salePrice;
  const optionLines = items.length > 0
    ? items.map((item) => `${escapeHtml(item.itemName || '-')}: ${item.maximumBuyCount ?? '-'}`)
    : (registration.options || []).map((item) => `${escapeHtml(item.name || '-')}: ${item.stockQuantity ?? '-'}`);
  return [
    COPY.heading,
    `Draft: ${registration.productDraftId}`,
    `sellerProductId: ${escapeHtml(registration.sellerProductId)}`,
    `\uC0C1\uD488\uBA85: ${escapeHtml(registration.sellerProductName || '-')}`,
    `\uCFE0\uD321 \uC0C1\uD0DC: ${escapeHtml(data.statusName || registration.status || '-')}`,
    `\uD310\uB9E4\uAC00: ${salePrice == null ? '-' : Number(salePrice).toLocaleString('ko-KR')}\uC6D0`,
    `\uC635\uC158 \uC7AC\uACE0:\n${optionLines.join('\n') || '-'}`,
  ].join('\n');
}

export async function notifyPendingCoupangSaleApprovals(db, telegramConfig, {
  coupangClient = null,
  listPendingImpl = listCoupangRegistrationsAwaitingTelegramNotification,
  getLiveProductImpl = coupangClient ? (sellerProductId) => coupangClient.getProduct(sellerProductId) : null,
  sendTelegramMessageImpl = sendTelegramMessage,
  markNotifiedImpl = markCoupangRegistrationTelegramNotified,
} = {}) {
  if (!telegramConfig) return { notified: 0 };
  if (!getLiveProductImpl) throw new Error('Coupang live product reader is required');
  const pending = await listPendingImpl(db);
  let notified = 0;
  for (const registration of pending) {
    const live = await getLiveProductImpl(registration.sellerProductId);
    const sent = await sendTelegramMessageImpl(
      telegramConfig,
      formatListingMessage(registration, live),
      { replyMarkup: approvalKeyboard(registration.productDraftId) },
    );
    const messageId = sent?.message_id;
    if (!Number.isInteger(Number(messageId))) throw new Error('Telegram notification returned no message id');
    await markNotifiedImpl(db, registration.productDraftId, Number(messageId));
    notified += 1;
  }
  return { notified };
}

async function presentResult(telegramConfig, query, resultText, {
  answerCallbackQueryImpl,
  editTelegramMessageTextImpl,
  sendTelegramMessageImpl,
}) {
  try {
    await answerCallbackQueryImpl(telegramConfig, query.id, { text: resultText.slice(0, 200) });
  } catch (error) {
    console.error(`coupangTelegramApproval.answerCallbackQueryFailed=${error.message}`);
  }
  const originalText = escapeHtml(query.message?.text || '');
  const rendered = `${originalText}\n\n${escapeHtml(resultText)}`;
  try {
    await editTelegramMessageTextImpl(telegramConfig, query.message?.message_id, rendered);
  } catch (error) {
    console.error(`coupangTelegramApproval.editMessageFailed=${error.message}`);
    try {
      await sendTelegramMessageImpl(telegramConfig, escapeHtml(resultText));
    } catch (fallbackError) {
      console.error(`coupangTelegramApproval.fallbackSendFailed=${fallbackError.message}`);
    }
  }
}

export async function handleCoupangApprovalCallback(db, telegramConfig, query, {
  requestApprovalImpl = requestCoupangSaleApproval,
  answerCallbackQueryImpl = answerCallbackQuery,
  editTelegramMessageTextImpl = editTelegramMessageText,
  sendTelegramMessageImpl = sendTelegramMessage,
  coupangClient = null,
  coupangConfig = null,
  getQueueItemByDraftIdImpl = getQueueItemByDraftId,
  updateQueueItemStatusImpl = updateQueueItemStatus,
} = {}) {
  const [action, idText] = String(query?.data || '').split(':');
  const draftId = Number(idText);
  if (!['approve_cp', 'defer_cp'].includes(action) || !Number.isInteger(draftId) || draftId <= 0) {
    return { handled: false };
  }
  const presentation = { answerCallbackQueryImpl, editTelegramMessageTextImpl, sendTelegramMessageImpl };
  if (action === 'defer_cp') {
    await presentResult(telegramConfig, query, COPY.deferred, presentation);
    return { handled: true, action: 'defer', draftId };
  }

  let resultText;
  let liveStatusName = null;
  let queueStatus = null;
  try {
    const approval = await requestApprovalImpl(db, draftId, { clientImpl: coupangClient, coupangConfig });
    liveStatusName = approval?.liveStatusNameAfter ?? null;
    resultText = `${COPY.approved} (draft ${draftId})`;
  } catch (error) {
    liveStatusName = error?.liveStatusName ?? null;
    resultText = `\u26A0\uFE0F \uC2B9\uC778 \uC694\uCCAD \uC548 \uB428: ${error.message}`;
  }
  const classified = classifyCoupangLiveStatus(liveStatusName);
  if (classified) {
    queueStatus = classified.status;
    const queueItem = await getQueueItemByDraftIdImpl(db, draftId);
    if (queueItem) {
      await updateQueueItemStatusImpl(db, queueItem.id, {
        status: classified.status,
        failureStage: classified.failureStage || null,
        failureMessage: classified.failureMessage || null,
      });
    }
  }
  await presentResult(telegramConfig, query, resultText, presentation);
  return { handled: true, action: 'approve', draftId, liveStatusName, queueStatus };
}
