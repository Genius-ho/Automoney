import { getSupplierOrderByChannelOrderId } from './purchase-order-store.mjs';
import { createOrderException } from './order-exception-store.mjs';

// automoney_complete_automation_implementation_plan.md section 15.1/15.3
// (Phase 10), Naver side: unlike Coupang (see return-request-collector.mjs's
// header comment -- cancellation there needed a whole separate API), Naver's
// current claim state is embedded directly in the SAME "상품 주문 정보 구조체"
// object order-collector.mjs's queryProductOrders() already fetches --
// confirmed 2026-07-26 against Naver's own published schema, pasted
// directly by the user (apicenter.commerce.naver.com is blocked for both
// WebFetch and browser navigation in this environment).
// productOrder.claimType is the current claim on this line, if any: 'CANCEL'
// | 'RETURN' | 'EXCHANGE' (not independently confirmed against a real
// order -- no real order has occurred yet on either channel -- so an
// unrecognized claimType is skipped rather than guessed at, the same
// caution as everywhere else uncertain field values are read in this app).
function detectExceptionType(record, supplierOrder) {
  const claimType = record?.productOrder?.claimType;
  if (!claimType) return null;
  if (claimType === 'CANCEL') return supplierOrder?.trackingNumber ? 'CANCEL_ALREADY_SHIPPED' : 'CANCEL_NOT_SHIPPED';
  if (claimType === 'RETURN') return 'RETURN_REQUESTED';
  if (claimType === 'EXCHANGE') return 'EXCHANGE_REQUESTED';
  return null;
}

async function findChannelOrderByItemId(db, channelOrderItemId) {
  const result = await db.query(
    `select id from channel_orders where channel = 'naver' and channel_order_item_id = $1 limit 1`,
    [channelOrderItemId],
  );
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

// Re-queries a specific batch of already-known productOrderIds (rather than
// polling for "what changed", the way order-collector.mjs's own collection
// does) -- claim detection needs a fresh read of exactly the orders this app
// already has on file, not a time-window scan.
export async function collectNaverClaims(db, client, channelOrderItemIds, {
  findChannelOrderByItemIdImpl = findChannelOrderByItemId,
  getSupplierOrderByChannelOrderIdImpl = getSupplierOrderByChannelOrderId,
  createOrderExceptionImpl = createOrderException,
} = {}) {
  if (!channelOrderItemIds || channelOrderItemIds.length === 0) return [];
  const detail = await client.queryProductOrders(channelOrderItemIds);
  const records = detail.data || [];
  const results = [];
  for (const record of records) {
    const productOrderId = record?.productOrder?.productOrderId;
    if (!record?.productOrder?.claimType) continue; // cheap check first -- no claim, nothing to look up
    try {
      const channelOrderId = await findChannelOrderByItemIdImpl(db, String(productOrderId));
      if (!channelOrderId) continue;

      const supplierOrder = await getSupplierOrderByChannelOrderIdImpl(db, channelOrderId);
      const exceptionType = detectExceptionType(record, supplierOrder);
      if (!exceptionType) continue;

      results.push(await createOrderExceptionImpl(db, {
        channelOrderId,
        supplierOrderId: supplierOrder?.id ?? null,
        exceptionType,
        detail: {
          claimType: record.productOrder.claimType,
          claimStatus: record.productOrder.claimStatus,
          domemeOrderNo: supplierOrder?.domemeOrderNo ?? null,
        },
      }));
    } catch (error) {
      results.push({ productOrderId, error: error.message });
    }
  }
  return results;
}

async function listNaverChannelOrderItemIds(db) {
  const result = await db.query(`select channel_order_item_id from channel_orders where channel = 'naver' order by ordered_at desc nulls last`);
  return result.rows.map((row) => row.channel_order_item_id);
}

const BATCH_SIZE = 100;

// No lock/time-window bookkeeping needed here (unlike order-collector.mjs's
// or return-request-collector.mjs's sweeps) -- this just re-checks every
// known Naver order id in fixed-size batches, which is naturally idempotent
// and cheap at this app's current order volume.
export async function runNaverClaimDetectionSweep(db, client, {
  listNaverChannelOrderItemIdsImpl = listNaverChannelOrderItemIds,
  collectNaverClaimsImpl = collectNaverClaims,
} = {}) {
  const ids = await listNaverChannelOrderItemIdsImpl(db);
  const results = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    results.push(...await collectNaverClaimsImpl(db, client, chunk));
  }
  return results;
}
