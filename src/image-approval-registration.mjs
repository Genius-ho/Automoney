import { createDirectRegistration } from './coupang-registration-flow.mjs';
import { getCoupangRegistration } from './coupang-registration-store.mjs';
import { notifyPendingCoupangSaleApprovals } from './coupang-telegram-approval.mjs';
import { getApprovedManualDetailSet } from './manual-ai/detail-workflow-store.mjs';
import { getApprovedManualMainImage } from './manual-ai/workflow-store.mjs';
import {
  claimQueueItemStatus,
  getQueueItemByDraftId,
  listQueueItemsForRegistrationReconciliation,
  updateQueueItemStatus,
} from './processing-queue-store.mjs';

function safeErrorCode(error, fallback) {
  const code = String(error?.code || fallback);
  return /^[A-Z0-9_:-]{1,100}$/.test(code) ? code : fallback;
}

export function classifyCoupangLiveStatus(statusName) {
  const normalized = String(statusName || '').trim();
  if (normalized === '승인완료') return { status: 'completed' };
  if (normalized === '승인대기중') return { status: 'awaiting_sale_approval' };
  if (['승인반려', '반려', '승인거절', '판매승인반려'].includes(normalized)) {
    return { status: 'failed', failureStage: 'coupang_sale_approval', failureMessage: normalized };
  }
  return null;
}

export async function handleApprovedImages(db, rootDir, draftId, {
  getApprovedMainImageImpl = getApprovedManualMainImage,
  getApprovedDetailSetImpl = getApprovedManualDetailSet,
  getQueueItemByDraftIdImpl = getQueueItemByDraftId,
  claimQueueItemStatusImpl = claimQueueItemStatus,
  getRegistrationImpl = getCoupangRegistration,
  createDirectRegistrationImpl = createDirectRegistration,
  notifyPendingImpl = notifyPendingCoupangSaleApprovals,
  updateQueueItemStatusImpl = updateQueueItemStatus,
  coupangConfig = null,
  coupangClient = null,
  telegramConfig = null,
} = {}) {
  const [mainImage, detailSet, queueItem] = await Promise.all([
    getApprovedMainImageImpl(db, draftId),
    getApprovedDetailSetImpl(db, draftId),
    getQueueItemByDraftIdImpl(db, draftId),
  ]);
  if (!mainImage || !detailSet) return { outcome: 'not_ready' };
  if (!queueItem) return { outcome: 'not_queued' };

  const existingBeforeClaim = await getRegistrationImpl(db, draftId);
  const retryable = queueItem.status === 'failed' && existingBeforeClaim?.sellerProductId;
  if (queueItem.status !== 'awaiting_image_approval' && !retryable) return { outcome: 'already_claimed' };

  const claimed = await claimQueueItemStatusImpl(db, draftId, queueItem.status, 'registering');
  if (!claimed) return { outcome: 'already_claimed' };

  let registration = existingBeforeClaim;
  try {
    if (!registration) {
      const created = await createDirectRegistrationImpl(db, rootDir, draftId, {
        mode: 'raw', confirm: true, coupangConfig, clientImpl: coupangClient,
      });
      registration = created.registration || await getRegistrationImpl(db, draftId);
    }
  } catch (error) {
    const failureMessage = safeErrorCode(error, 'COUPANG_REGISTRATION_FAILED');
    await updateQueueItemStatusImpl(db, claimed.id, { status: 'failed', failureStage: 'coupang_registration', failureMessage });
    throw Object.assign(new Error(`Coupang registration failed: ${failureMessage}`), { code: failureMessage });
  }

  try {
    await notifyPendingImpl(db, telegramConfig, { coupangClient });
  } catch (error) {
    const failureMessage = safeErrorCode(error, 'TELEGRAM_NOTIFICATION_FAILED');
    await updateQueueItemStatusImpl(db, claimed.id, {
      status: 'failed', failureStage: 'telegram_sale_approval_notification', failureMessage,
    });
    throw Object.assign(new Error(`Telegram sale approval notification failed: ${failureMessage}`), { code: failureMessage });
  }

  await updateQueueItemStatusImpl(db, claimed.id, {
    status: 'awaiting_sale_approval', failureStage: null, failureMessage: null,
  });
  return { outcome: 'awaiting_sale_approval', registration };
}

export async function reconcileCoupangQueue(db, {
  listQueueItemsImpl = listQueueItemsForRegistrationReconciliation,
  getRegistrationImpl = getCoupangRegistration,
  getLiveProductImpl = null,
  updateQueueItemStatusImpl = updateQueueItemStatus,
  coupangClient = null,
} = {}) {
  const readLive = getLiveProductImpl || (coupangClient ? (sellerProductId) => coupangClient.getProduct(sellerProductId) : null);
  if (!readLive) throw new Error('Coupang live product reader is required');
  const items = await listQueueItemsImpl(db);
  const summary = { checked: 0, completed: 0, awaiting: 0, failed: 0, transientErrors: 0 };
  for (const item of items) {
    summary.checked += 1;
    try {
      const registration = await getRegistrationImpl(db, item.draftId);
      if (!registration?.sellerProductId) continue;
      const live = await readLive(registration.sellerProductId);
      const classified = classifyCoupangLiveStatus(live?.data?.statusName);
      if (!classified) continue;
      await updateQueueItemStatusImpl(db, item.id, {
        status: classified.status,
        failureStage: classified.failureStage || null,
        failureMessage: classified.failureMessage || null,
      });
      if (classified.status === 'completed') summary.completed += 1;
      else if (classified.status === 'awaiting_sale_approval') summary.awaiting += 1;
      else summary.failed += 1;
    } catch {
      summary.transientErrors += 1;
    }
  }
  return summary;
}
