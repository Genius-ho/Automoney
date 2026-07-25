import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCoupangOrder,
  normalizeNaverOrder,
  collectCoupangOrders,
  collectNaverOrders,
  runCoupangOrderCollection,
  runNaverOrderCollection,
  maskOrderForLog,
} from '../src/order-collector.mjs';

// Confirmed live shape, 2026-07-25 (Coupang's own documented v5 ordersheets
// response) -- see coupang-client.mjs's listOrderSheets comment.
function fakeOrderSheet(overrides = {}) {
  return {
    shipmentBoxId: 64253897,
    orderId: 22000009546234,
    orderedAt: '2026-07-25T14:17:13.973885+09:00',
    orderer: { name: '홍길동', email: 'x@example.test', safeNumber: '010-0000-0000' },
    paidAt: '2026-07-25T14:17:13.973885+09:00',
    status: 'ACCEPT',
    receiver: { name: '김철수', safeNumber: '010-1234-5678', addr1: '서울시 강남구', addr2: '101동 202호', postCode: '06000' },
    orderItems: [
      {
        vendorItemId: 3242596358,
        vendorItemName: '무타공 수납 정리함 - 블랙',
        shippingCount: 1,
        salesPrice: { currencyCode: 'KRW', units: 19900, nanos: 0 },
        orderPrice: { currencyCode: 'KRW', units: 19900, nanos: 0 },
        discountPrice: { currencyCode: 'KRW', units: 500, nanos: 0 },
        cancelCount: 0,
        holdCountForCancel: 0,
      },
    ],
    deliveryCompanyName: 'CJ 대한통운',
    invoiceNumber: null,
    shipmentType: 'THIRD_PARTY',
    isCod: false,
    ...overrides,
  };
}

test('normalizeCoupangOrder flattens each orderItem into its own record, keyed by shipmentBoxId:vendorItemId', () => {
  const [order] = normalizeCoupangOrder(fakeOrderSheet());
  assert.equal(order.channel, 'coupang');
  assert.equal(order.channelOrderId, '22000009546234');
  assert.equal(order.channelOrderItemId, '64253897:3242596358');
  assert.equal(order.channelProductId, '3242596358');
  assert.equal(order.optionInfo, '무타공 수납 정리함 - 블랙');
  assert.equal(order.quantity, 1);
  assert.equal(order.salePrice, 19900);
  assert.equal(order.orderStatus, 'ACCEPT');
  assert.equal(order.recipientName, '김철수');
  assert.equal(order.address, '서울시 강남구 101동 202호');
  assert.equal(order.postalCode, '06000');
  assert.equal(order.phone, '010-1234-5678');
  assert.equal(order.orderedAt, '2026-07-25T14:17:13.973885+09:00');
});

test('normalizeCoupangOrder produces one record per orderItem when a shipment box bundles several vendorItemIds', () => {
  const sheet = fakeOrderSheet({
    orderItems: [
      { vendorItemId: 1, vendorItemName: 'A', shippingCount: 1, orderPrice: { units: 10000 } },
      { vendorItemId: 2, vendorItemName: 'B', shippingCount: 2, orderPrice: { units: 20000 } },
    ],
  });
  const orders = normalizeCoupangOrder(sheet);
  assert.equal(orders.length, 2);
  assert.equal(orders[0].channelOrderItemId, '64253897:1');
  assert.equal(orders[1].channelOrderItemId, '64253897:2');
  assert.equal(orders[1].quantity, 2);
});

test('normalizeNaverOrder reads its (unverified) candidate field names defensively', () => {
  const order = normalizeNaverOrder({
    productOrderId: '2026072512345671',
    productOrderStatus: 'PAYED',
    productId: '13620845243',
    quantity: 1,
    totalPaymentAmount: 31790,
    receiverName: '김철수',
    baseAddress: '서울시 강남구',
    zipCode: '06000',
    receiverTel1: '010-1234-5678',
    paymentDate: '2026-07-25T14:00:00.000+09:00',
  });
  assert.equal(order.channel, 'naver');
  assert.equal(order.channelOrderItemId, '2026072512345671');
  assert.equal(order.channelProductId, '13620845243');
  assert.equal(order.orderStatus, 'PAYED');
  assert.equal(order.recipientName, '김철수');
  assert.equal(order.salePrice, 31790);
});

test('collectCoupangOrders pages through nextToken and records one row per flattened order line', async () => {
  const recorded = [];
  const client = {
    async listOrderSheets({ nextToken }) {
      if (!nextToken) return { data: [fakeOrderSheet()], nextToken: 'page-2' };
      return { data: [fakeOrderSheet({ shipmentBoxId: 999, orderId: 111 })], nextToken: undefined };
    },
  };
  const results = await collectCoupangOrders(client, { createdAtFrom: 'a', createdAtTo: 'b' }, {
    db: {},
    recordChannelOrderImpl: async (db, order) => { recorded.push(order); return { ...order, isNew: true }; },
  });
  assert.equal(results.length, 2);
  assert.equal(recorded[0].channelOrderItemId, '64253897:3242596358');
  assert.equal(recorded[1].channelOrderId, '111');
});

test('collectNaverOrders is a no-op (no queryProductOrders call) when last-changed-statuses reports nothing', async () => {
  let queryCalled = false;
  const client = {
    async listChangedProductOrderIds() { return { timestamp: '2026-07-25T00:00:00Z', traceId: 'x' }; }, // real empty shape, confirmed live -- no `data` key at all
    async queryProductOrders() { queryCalled = true; return { data: [] }; },
  };
  const results = await collectNaverOrders(client, { lastChangedFrom: 'a' }, { db: {} });
  assert.deepEqual(results, []);
  assert.equal(queryCalled, false);
});

test('collectNaverOrders fetches full details for every changed productOrderId and records them', async () => {
  const recorded = [];
  const client = {
    async listChangedProductOrderIds() { return { data: [{ productOrderId: 'A' }, { productOrderId: 'B' }] }; },
    async queryProductOrders(ids) {
      assert.deepEqual(ids, ['A', 'B']);
      return { data: [{ productOrderId: 'A', productOrderStatus: 'PAYED' }, { productOrderId: 'B', productOrderStatus: 'PAYED' }] };
    },
  };
  const results = await collectNaverOrders(client, { lastChangedFrom: 'a' }, {
    db: {},
    recordChannelOrderImpl: async (db, order) => { recorded.push(order); return { ...order, isNew: true }; },
  });
  assert.equal(results.length, 2);
  assert.equal(recorded[0].channelOrderItemId, 'A');
  assert.equal(recorded[1].channelOrderItemId, 'B');
});

test('maskOrderForLog masks name/phone/address but leaves everything else (including DB fields) intact', () => {
  const masked = maskOrderForLog({
    channel: 'coupang', recipientName: '김철수', phone: '010-1234-5678', address: '서울시 강남구 101동 202호', quantity: 1,
  });
  assert.equal(masked.recipientName, '김**');
  assert.equal(masked.phone, '010-****-5678');
  assert.equal(masked.address, '서울시 ***');
  assert.equal(masked.quantity, 1);
});

test('maskOrderForLog tolerates missing PII fields without throwing', () => {
  const masked = maskOrderForLog({ channel: 'coupang' });
  assert.equal(masked.recipientName, undefined);
  assert.equal(masked.phone, undefined);
  assert.equal(masked.address, undefined);
});

test('runCoupangOrderCollection skips (never throws) when the coupang lock is already held', async () => {
  const result = await runCoupangOrderCollection({}, {}, {
    tryAcquireOrderCollectionLockImpl: async () => null,
  });
  assert.deepEqual(result, { skipped: true, reason: 'ALREADY_RUNNING' });
});

test('runCoupangOrderCollection uses a 30-minute lookback on the very first run, then overlaps 5 minutes past lastSuccessAt on later runs', async () => {
  const calls = [];
  const now = new Date('2026-07-25T12:00:00.000Z');
  await runCoupangOrderCollection({}, {}, {
    tryAcquireOrderCollectionLockImpl: async () => ({ channel: 'coupang', lastSuccessAt: null }),
    releaseOrderCollectionLockImpl: async () => {},
    collectCoupangOrdersImpl: async (client, args) => { calls.push(args); return []; },
    now: () => now,
  });
  assert.equal(calls[0].createdAtFrom, '2026-07-25T20:30+09:00'); // 30 min before 12:00 UTC, rendered in +09:00
  assert.equal(calls[0].createdAtTo, '2026-07-25T21:00+09:00');
  assert.equal(calls[0].status, 'ACCEPT');

  await runCoupangOrderCollection({}, {}, {
    tryAcquireOrderCollectionLockImpl: async () => ({ channel: 'coupang', lastSuccessAt: '2026-07-25T11:50:00.000Z' }),
    releaseOrderCollectionLockImpl: async () => {},
    collectCoupangOrdersImpl: async (client, args) => { calls.push(args); return []; },
    now: () => now,
  });
  assert.equal(calls[1].createdAtFrom, '2026-07-25T20:45+09:00'); // 11:50 - 5min overlap = 11:45 UTC = 20:45 KST
});

test('runCoupangOrderCollection always releases the lock, even after a successful collection, and reports new vs. already-seen counts', async () => {
  let released = null;
  const result = await runCoupangOrderCollection({}, {}, {
    tryAcquireOrderCollectionLockImpl: async () => ({ channel: 'coupang', lastSuccessAt: null }),
    releaseOrderCollectionLockImpl: async (db, channel, args) => { released = { channel, ...args }; },
    collectCoupangOrdersImpl: async () => [{ isNew: true }, { isNew: false }],
  });
  assert.equal(result.checked, 2);
  assert.equal(result.newCount, 1);
  assert.equal(released.channel, 'coupang');
  assert.ok(released.successAt);
});

test('runNaverOrderCollection skips when the naver lock is already held, and always releases after collecting', async () => {
  const skipped = await runNaverOrderCollection({}, {}, { tryAcquireOrderCollectionLockImpl: async () => null });
  assert.deepEqual(skipped, { skipped: true, reason: 'ALREADY_RUNNING' });

  let released = false;
  const result = await runNaverOrderCollection({}, {}, {
    tryAcquireOrderCollectionLockImpl: async () => ({ channel: 'naver', lastSuccessAt: null }),
    releaseOrderCollectionLockImpl: async () => { released = true; },
    collectNaverOrdersImpl: async () => [{ isNew: true }],
  });
  assert.equal(result.checked, 1);
  assert.equal(result.newCount, 1);
  assert.equal(released, true);
});
