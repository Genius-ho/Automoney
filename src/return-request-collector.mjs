import { toCoupangTimestamp } from './order-collector.mjs';
import { tryAcquireOrderCollectionLock, releaseOrderCollectionLock } from './channel-orders-store.mjs';
import { getSupplierOrderByChannelOrderId } from './purchase-order-store.mjs';
import { createOrderException } from './order-exception-store.mjs';

// automoney_complete_automation_implementation_plan.md section 15.1/15.3
// (Phase 10): Coupang's order-sheet status (channel_orders.order_status)
// only ever tracks the FULFILLMENT lifecycle (ACCEPT/INSTRUCT/DEPARTURE/...)
// -- a real cancellation or return never shows up there at all, it lives
// entirely in this separate returnRequests API. order-collector.mjs's
// normalizeCoupangOrder always sets cancelledAt: null for exactly this
// reason (there was nothing in the ordersheets response to read it from).
// This sweep is Coupang's actual source of truth for both 15.1's "채널
// 주문 취소" detection and 15.3's "반품·교환" queue -- both route through the
// same order_exceptions table 15.1 already uses (RETURN never gets
// auto-processed either way, "모든 반품·교환은 관리자 예외 큐로 보낸다").
//
// Exchange (교환) is a genuinely separate Coupang API family (its own
// list/confirm/reject/invoice endpoints) -- not implemented here. A 교환
// shows up through returnRequests as a RETURN entry today and lands in the
// same queue as a real return; distinguishing it needs the dedicated
// exchange-request API, left for a follow-up.
async function findChannelOrderId(db, { channel, channelOrderId, channelProductId }) {
  const result = await db.query(
    'select id from channel_orders where channel = $1 and channel_order_id = $2 and channel_product_id = $3 limit 1',
    [channel, channelOrderId, channelProductId],
  );
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

export async function collectCoupangReturnRequests(db, client, { createdAtFrom, createdAtTo, cancelType }, {
  findChannelOrderIdImpl = findChannelOrderId,
  getSupplierOrderByChannelOrderIdImpl = getSupplierOrderByChannelOrderId,
  createOrderExceptionImpl = createOrderException,
} = {}) {
  return collectOneType(db, client, { createdAtFrom, createdAtTo, cancelType }, {
    findChannelOrderIdImpl, getSupplierOrderByChannelOrderIdImpl, createOrderExceptionImpl,
  });
}

async function collectOneType(db, client, { createdAtFrom, createdAtTo, cancelType }, {
  findChannelOrderIdImpl, getSupplierOrderByChannelOrderIdImpl, createOrderExceptionImpl,
}) {
  const response = await client.listReturnRequests({ createdAtFrom, createdAtTo, cancelType });
  const results = [];
  for (const record of response.data || []) {
    for (const item of record.returnItems || []) {
      if (!item.vendorItemId) continue;
      try {
        const channelOrderId = await findChannelOrderIdImpl(db, {
          channel: 'coupang',
          channelOrderId: String(record.orderId),
          channelProductId: String(item.vendorItemId),
        });
        if (!channelOrderId) continue;

        const supplierOrder = await getSupplierOrderByChannelOrderIdImpl(db, channelOrderId);
        const exceptionType = record.receiptType === 'CANCEL'
          ? (supplierOrder?.trackingNumber ? 'CANCEL_ALREADY_SHIPPED' : 'CANCEL_NOT_SHIPPED')
          : 'RETURN_REQUESTED';

        results.push(await createOrderExceptionImpl(db, {
          channelOrderId,
          supplierOrderId: supplierOrder?.id ?? null,
          exceptionType,
          detail: {
            receiptId: record.receiptId,
            receiptType: record.receiptType,
            receiptStatus: record.receiptStatus,
            cancelReason: record.cancelReason,
            faultByType: record.faultByType,
            releaseStatus: item.releaseStatus,
            domemeOrderNo: supplierOrder?.domemeOrderNo ?? null,
          },
        }));
      } catch (error) {
        results.push({ orderId: record.orderId, vendorItemId: item.vendorItemId, error: error.message });
      }
    }
  }
  return results;
}

const OVERLAP_MINUTES = 5;
const DEFAULT_LOOKBACK_MINUTES = 30;

// Same lock-and-overlap shape as order-collector.mjs's
// runCoupangOrderCollection -- reuses the same order_collection_state table
// under a distinct channel key ('coupang_returns') rather than a new table,
// since the concurrency/overlap semantics are identical.
export async function runCoupangReturnRequestCollection(db, client, {
  tryAcquireOrderCollectionLockImpl = tryAcquireOrderCollectionLock,
  releaseOrderCollectionLockImpl = releaseOrderCollectionLock,
  collectCoupangReturnRequestsImpl = collectCoupangReturnRequests,
  now = () => new Date(),
} = {}) {
  const lock = await tryAcquireOrderCollectionLockImpl(db, 'coupang_returns');
  if (!lock) return { skipped: true, reason: 'ALREADY_RUNNING' };
  try {
    const nowDate = now();
    const windowStart = lock.lastSuccessAt
      ? new Date(new Date(lock.lastSuccessAt).getTime() - OVERLAP_MINUTES * 60_000)
      : new Date(nowDate.getTime() - DEFAULT_LOOKBACK_MINUTES * 60_000);
    const window = { createdAtFrom: toCoupangTimestamp(windowStart), createdAtTo: toCoupangTimestamp(nowDate) };
    const [returns, cancels] = await Promise.all([
      collectCoupangReturnRequestsImpl(db, client, { ...window, cancelType: 'RETURN' }),
      collectCoupangReturnRequestsImpl(db, client, { ...window, cancelType: 'CANCEL' }),
    ]);
    return { skipped: false, flagged: returns.length + cancels.length };
  } finally {
    await releaseOrderCollectionLockImpl(db, 'coupang_returns', { successAt: new Date().toISOString() });
  }
}
