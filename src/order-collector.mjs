import {
  recordChannelOrder,
  tryAcquireOrderCollectionLock,
  releaseOrderCollectionLock,
} from './channel-orders-store.mjs';
import { mapChannelOrder } from './order-supplier-mapper.mjs';

// automoney_complete_automation_implementation_plan.md section 12 (Phase 7):
// 쿠팡·네이버 주문 자동 수집. Read-only against each channel's order API,
// normalizes into one row per order LINE, and hands off to
// channel-orders-store's upsert (dedup by channel + channel_order_item_id).
// Never places a supplier order itself -- that's Phase 8, gated on the
// mapping this module leaves as 'mapping_required'.

// Confirmed live schema (2026-07-25, Coupang's documented v5 ordersheets
// response): one shipment box can bundle several vendorItemIds, so this
// flattens orderItems out into one normalized record per line. There is no
// single "orderItemId" field the way the plan's dedup-key wording assumed --
// `${shipmentBoxId}:${vendorItemId}` is the real per-line unique key.
export function normalizeCoupangOrder(orderSheet) {
  const receiver = orderSheet.receiver || {};
  // Coupang's own receiver already splits addr1/addr2 -- kept separately
  // (rather than joined-then-discarded) so purchase-order-approval.mjs's
  // deliInfo can supply Domeme's required address2 without having to guess
  // a split back out of free text later.
  const address = [receiver.addr1, receiver.addr2].filter(Boolean).join(' ') || null;
  return (orderSheet.orderItems || []).map((item) => ({
    channel: 'coupang',
    channelOrderId: String(orderSheet.orderId),
    channelOrderItemId: `${orderSheet.shipmentBoxId}:${item.vendorItemId}`,
    channelProductId: item.vendorItemId == null ? null : String(item.vendorItemId),
    optionInfo: item.vendorItemName ?? null,
    quantity: item.shippingCount ?? null,
    salePrice: item.orderPrice?.units ?? item.salesPrice?.units ?? null,
    orderStatus: orderSheet.status ?? null,
    recipientName: receiver.name ?? null,
    address,
    address1: receiver.addr1 ?? null,
    address2: receiver.addr2 ?? null,
    postalCode: receiver.postCode ?? null,
    phone: receiver.safeNumber ?? null,
    deliveryMemo: null,
    orderedAt: orderSheet.orderedAt ?? null,
    cancelledAt: null,
    rawJson: item,
  }));
}

// Confirmed 2026-07-26 against Naver Commerce API's own published "상품 주문
// 정보 구조체" schema (apicenter.commerce.naver.com, pasted directly by the
// user since the docs site is blocked for WebFetch/browser navigation in
// this environment) -- replaces the earlier UNVERIFIED field-guessing pass.
// Each queryProductOrders() result is `{ order, productOrder, cancel,
// return, exchange, currentClaim, completedClaims, delivery }`, NOT a flat
// object -- the previous version read every field straight off the outer
// wrapper (e.g. `productOrderId`, `productOrderStatus`, `baseAddress`)
// instead of `.productOrder.*`/`.productOrder.shippingAddress.*`, so it was
// silently reading nulls for nearly everything except `orderId` (order.*
// was, by luck, already being unwrapped correctly).
export function normalizeNaverOrder(record) {
  const order = record.order || {};
  const po = record.productOrder || {};
  const shipping = po.shippingAddress || {};
  // Same split-then-discard fix as normalizeCoupangOrder above -- Naver's
  // shippingAddress already separates baseAddress/detailedAddress.
  const address = [shipping.baseAddress, shipping.detailedAddress].filter(Boolean).join(' ') || null;
  // 15.1 (Phase 10): the current claim (if any) on this line is right here
  // on the same object Phase 7 already fetches -- no separate collection
  // sweep needed the way Coupang required (see return-request-collector.mjs's
  // header comment for why Coupang's own order status can't carry this).
  const cancelInfo = record.cancel || record.currentClaim?.cancel || null;

  return {
    channel: 'naver',
    channelOrderId: String(order.orderId ?? po.productOrderId ?? ''),
    channelOrderItemId: String(po.productOrderId ?? ''),
    channelProductId: po.productId != null ? String(po.productId) : (po.originalProductId != null ? String(po.originalProductId) : null),
    optionInfo: po.productOption || po.productName || null,
    quantity: po.quantity ?? null,
    salePrice: po.totalPaymentAmount ?? po.unitPrice ?? null,
    orderStatus: po.productOrderStatus || null,
    recipientName: shipping.name || null,
    address,
    address1: shipping.baseAddress || null,
    address2: shipping.detailedAddress || null,
    postalCode: shipping.zipCode || null,
    phone: shipping.tel1 || shipping.tel2 || null,
    deliveryMemo: po.shippingMemo || null,
    orderedAt: order.orderDate || order.paymentDate || null,
    cancelledAt: cancelInfo?.cancelCompletedDate || null,
    rawJson: record,
  };
}

// "상품준비중 처리" (발주서 확인) -- confirmed spec, 2026-08-14
// (developers.coupang.com/ko/api/shipments/changing-the-status-to-product-in-preparation):
// Coupang only accepts still-ACCEPT shipmentBoxIds, and recommends 50 or
// fewer per call, hence the chunking.
async function acknowledgeCoupangShipmentBoxIds(client, shipmentBoxIds) {
  for (let i = 0; i < shipmentBoxIds.length; i += 50) {
    await client.acknowledgeOrders(shipmentBoxIds.slice(i, i + 50));
  }
}

// Coupang requires createdAtFrom/createdAtTo/status all explicit, with a
// 24-hour max window per call -- 'ACCEPT' (결제완료) is the one status
// Phase 7 actually needs to collect ("결제완료 신규 주문 식별"); other
// lifecycle statuses (DEPARTURE/DELIVERING/...) matter to Phase 9's
// shipment sync, not this collection step. Every ACCEPT shipmentBoxId seen
// here also gets acknowledged (결제완료 -> 상품준비중) so a human never has to
// do that step manually in WING -- best-effort: a failure here must not
// roll back orders already recorded/mapped above, since it only blocks
// shipping prep timing, not correctness of what got collected.
export async function collectCoupangOrders(client, { createdAtFrom, createdAtTo, status = 'ACCEPT' }, {
  recordChannelOrderImpl = recordChannelOrder,
  mapChannelOrderImpl = mapChannelOrder,
  acknowledgeCoupangShipmentBoxIdsImpl = acknowledgeCoupangShipmentBoxIds,
  db,
} = {}) {
  const saved = [];
  const shipmentBoxIds = new Set();
  let nextToken;
  do {
    const response = await client.listOrderSheets({ createdAtFrom, createdAtTo, status, nextToken });
    for (const orderSheet of response.data || []) {
      if (orderSheet.shipmentBoxId != null) shipmentBoxIds.add(Number(orderSheet.shipmentBoxId));
      for (const normalized of normalizeCoupangOrder(orderSheet)) {
        const recorded = await recordChannelOrderImpl(db, normalized);
        const mapped = await mapChannelOrderImpl(db, recorded, { coupangClientImpl: client });
        saved.push({ ...mapped, isNew: recorded.isNew });
      }
    }
    nextToken = response.nextToken || undefined;
  } while (nextToken);

  if (status === 'ACCEPT' && shipmentBoxIds.size > 0) {
    try {
      await acknowledgeCoupangShipmentBoxIdsImpl(client, [...shipmentBoxIds]);
    } catch (error) {
      console.error(`orderCollector.acknowledgeFailed=${error.message}`);
    }
  }
  return saved;
}

export async function collectNaverOrders(client, { lastChangedFrom, lastChangedType = 'PAYED' }, {
  recordChannelOrderImpl = recordChannelOrder,
  mapChannelOrderImpl = mapChannelOrder,
  db,
} = {}) {
  const changed = await client.listChangedProductOrderIds({ lastChangedFrom, lastChangedType });
  const productOrderIds = (changed.data || [])
    .map((entry) => entry.productOrderId)
    .filter(Boolean);
  if (productOrderIds.length === 0) return [];

  const detail = await client.queryProductOrders(productOrderIds);
  const orders = detail.data || detail.productOrders || [];
  const saved = [];
  for (const productOrder of orders) {
    const recorded = await recordChannelOrderImpl(db, normalizeNaverOrder(productOrder));
    const mapped = await mapChannelOrderImpl(db, recorded);
    saved.push({ ...mapped, isNew: recorded.isNew });
  }
  return saved;
}

// 12.1: "조회 구간을 일부 겹치되 유니크 키로 중복 제거" -- re-check the last few
// minutes of the previous window on every run rather than picking up
// exactly where the last one left off, so a status change or a
// slightly-late-to-appear order right at the boundary is never missed. The
// upsert dedup (channel_order_item_id) makes the overlap itself harmless.
const OVERLAP_MINUTES = 5;
const DEFAULT_LOOKBACK_MINUTES = 30;

export function toCoupangTimestamp(date) {
  // Coupang's documented format is minute-precision with an explicit +09:00
  // offset (e.g. "2025-07-29T00:00+09:00") -- this app always runs KST-
  // adjacent to Korean marketplaces, so +09:00 is hardcoded rather than
  // read off the host's own timezone.
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}+09:00`;
}

// Same lock-and-release shape as auto-discovery-batch.mjs's runDailyProcessingBatch
// -- "동시 실행 금지" (12.1). Skips entirely (never throws) when a previous
// run for this channel is still marked as running.
export async function runCoupangOrderCollection(db, client, {
  tryAcquireOrderCollectionLockImpl = tryAcquireOrderCollectionLock,
  releaseOrderCollectionLockImpl = releaseOrderCollectionLock,
  collectCoupangOrdersImpl = collectCoupangOrders,
  now = () => new Date(),
} = {}) {
  const lock = await tryAcquireOrderCollectionLockImpl(db, 'coupang');
  if (!lock) return { skipped: true, reason: 'ALREADY_RUNNING' };
  try {
    const nowDate = now();
    const windowStart = lock.lastSuccessAt
      ? new Date(new Date(lock.lastSuccessAt).getTime() - OVERLAP_MINUTES * 60_000)
      : new Date(nowDate.getTime() - DEFAULT_LOOKBACK_MINUTES * 60_000);
    const saved = await collectCoupangOrdersImpl(client, {
      createdAtFrom: toCoupangTimestamp(windowStart),
      createdAtTo: toCoupangTimestamp(nowDate),
      status: 'ACCEPT',
    }, { db });
    return { skipped: false, checked: saved.length, newCount: saved.filter((o) => o.isNew).length };
  } finally {
    await releaseOrderCollectionLockImpl(db, 'coupang', { successAt: new Date().toISOString() });
  }
}

export async function runNaverOrderCollection(db, client, {
  tryAcquireOrderCollectionLockImpl = tryAcquireOrderCollectionLock,
  releaseOrderCollectionLockImpl = releaseOrderCollectionLock,
  collectNaverOrdersImpl = collectNaverOrders,
  now = () => new Date(),
} = {}) {
  const lock = await tryAcquireOrderCollectionLockImpl(db, 'naver');
  if (!lock) return { skipped: true, reason: 'ALREADY_RUNNING' };
  try {
    const nowDate = now();
    const windowStart = lock.lastSuccessAt
      ? new Date(new Date(lock.lastSuccessAt).getTime() - OVERLAP_MINUTES * 60_000)
      : new Date(nowDate.getTime() - DEFAULT_LOOKBACK_MINUTES * 60_000);
    const saved = await collectNaverOrdersImpl(client, {
      lastChangedFrom: windowStart.toISOString(),
      lastChangedType: 'PAYED',
    }, { db });
    return { skipped: false, checked: saved.length, newCount: saved.filter((o) => o.isNew).length };
  } finally {
    await releaseOrderCollectionLockImpl(db, 'naver', { successAt: new Date().toISOString() });
  }
}

// Masks recipient name/phone/address for anything that gets logged or shown
// on an admin summary screen (automoney_complete_automation_implementation_plan.md
// section 21: "고객 이름·주소·전화번호 로그 마스킹") -- the DB row itself keeps
// the real values (channel-orders-store), only display/log output goes
// through this.
export function maskOrderForLog(order) {
  return {
    ...order,
    recipientName: maskName(order.recipientName),
    phone: maskPhone(order.phone),
    address: maskAddress(order.address),
  };
}

function maskName(name) {
  if (!name) return name;
  if (name.length <= 1) return '*';
  return `${name[0]}${'*'.repeat(name.length - 1)}`;
}

function maskPhone(phone) {
  if (!phone) return phone;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 7) return '*'.repeat(String(phone).length);
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

function maskAddress(address) {
  if (!address) return address;
  const parts = String(address).split(' ');
  return parts.length <= 1 ? '***' : `${parts[0]} ***`;
}
