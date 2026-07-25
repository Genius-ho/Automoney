import {
  recordChannelOrder,
  tryAcquireOrderCollectionLock,
  releaseOrderCollectionLock,
} from './channel-orders-store.mjs';

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
    postalCode: receiver.postCode ?? null,
    phone: receiver.safeNumber ?? null,
    deliveryMemo: null,
    orderedAt: orderSheet.orderedAt ?? null,
    cancelledAt: null,
    rawJson: item,
  }));
}

// UNVERIFIED field names -- see naver-commerce-client.mjs's
// listChangedProductOrderIds/queryProductOrders comment. Every field is
// looked up under a few plausible candidate names rather than one hardcoded
// guess, the same defensive style processing.mjs's own normalizeProduct
// already uses for uncertain upstream shapes, so a wrong guess on any one
// field doesn't silently produce nulls across the board.
function pick(source, names) {
  for (const name of names) {
    const value = source?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

export function normalizeNaverOrder(productOrder) {
  const order = productOrder.order || productOrder;
  const productOrderId = pick(productOrder, ['productOrderId', 'id']);
  return {
    channel: 'naver',
    channelOrderId: String(pick(order, ['orderId']) ?? productOrderId ?? ''),
    channelOrderItemId: String(productOrderId ?? ''),
    channelProductId: pick(productOrder, ['productId', 'channelProductNo', 'originProductNo']),
    optionInfo: pick(productOrder, ['productOption', 'optionInfo', 'productName']),
    quantity: pick(productOrder, ['quantity']),
    salePrice: pick(productOrder, ['totalPaymentAmount', 'unitPrice', 'productOrderAmount']),
    orderStatus: pick(productOrder, ['productOrderStatus', 'orderStatus']),
    recipientName: pick(productOrder, ['receiverName']),
    address: pick(productOrder, ['baseAddress', 'address']),
    postalCode: pick(productOrder, ['zipCode', 'postalCode']),
    phone: pick(productOrder, ['receiverTel1', 'receiverTel', 'phone']),
    deliveryMemo: pick(productOrder, ['deliveryMemo']),
    orderedAt: pick(order, ['orderDate']) ?? pick(productOrder, ['orderDate', 'paymentDate']),
    cancelledAt: pick(productOrder, ['cancelDate']),
    rawJson: productOrder,
  };
}

// Coupang requires createdAtFrom/createdAtTo/status all explicit, with a
// 24-hour max window per call -- 'ACCEPT' (결제완료) is the one status
// Phase 7 actually needs to collect ("결제완료 신규 주문 식별"); other
// lifecycle statuses (DEPARTURE/DELIVERING/...) matter to Phase 9's
// shipment sync, not this collection step.
export async function collectCoupangOrders(client, { createdAtFrom, createdAtTo, status = 'ACCEPT' }, {
  recordChannelOrderImpl = recordChannelOrder,
  db,
} = {}) {
  const saved = [];
  let nextToken;
  do {
    const response = await client.listOrderSheets({ createdAtFrom, createdAtTo, status, nextToken });
    for (const orderSheet of response.data || []) {
      for (const normalized of normalizeCoupangOrder(orderSheet)) {
        saved.push(await recordChannelOrderImpl(db, normalized));
      }
    }
    nextToken = response.nextToken || undefined;
  } while (nextToken);
  return saved;
}

export async function collectNaverOrders(client, { lastChangedFrom, lastChangedType = 'PAYED' }, {
  recordChannelOrderImpl = recordChannelOrder,
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
    saved.push(await recordChannelOrderImpl(db, normalizeNaverOrder(productOrder)));
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

function toCoupangTimestamp(date) {
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
