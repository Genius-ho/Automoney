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

// Confirmed 2026-07-26 against Naver Commerce API's own published "상품 주문
// 정보 구조체" schema -- the real per-line shape is
// { order, productOrder, cancel, return, exchange, currentClaim,
// completedClaims, delivery }, not a flat object.
function fakeNaverProductOrderRecord(overrides = {}) {
  return {
    order: { orderId: '2026072500001234', orderDate: '2026-07-25T14:00:00.000+09:00', paymentDate: '2026-07-25T14:00:05.000+09:00' },
    productOrder: {
      productOrderId: '2026072512345671', productOrderStatus: 'PAYED', productId: '13620845243',
      productOption: '블랙', quantity: 1, totalPaymentAmount: 31790, unitPrice: 31790,
      shippingAddress: { name: '김철수', baseAddress: '서울시 강남구', detailedAddress: '101동 202호', zipCode: '06000', tel1: '010-1234-5678' },
    },
    cancel: null,
    ...overrides,
  };
}

test('normalizeNaverOrder reads every field from its confirmed nested position (order/productOrder/shippingAddress)', () => {
  const order = normalizeNaverOrder(fakeNaverProductOrderRecord());
  assert.equal(order.channel, 'naver');
  assert.equal(order.channelOrderId, '2026072500001234');
  assert.equal(order.channelOrderItemId, '2026072512345671');
  assert.equal(order.channelProductId, '13620845243');
  assert.equal(order.optionInfo, '블랙');
  assert.equal(order.orderStatus, 'PAYED');
  assert.equal(order.recipientName, '김철수');
  assert.equal(order.address, '서울시 강남구 101동 202호');
  assert.equal(order.postalCode, '06000');
  assert.equal(order.phone, '010-1234-5678');
  assert.equal(order.salePrice, 31790);
  assert.equal(order.orderedAt, '2026-07-25T14:00:00.000+09:00');
  assert.equal(order.cancelledAt, null);
});

test('normalizeNaverOrder reads cancelledAt from the cancel sub-object\'s cancelCompletedDate', () => {
  const order = normalizeNaverOrder(fakeNaverProductOrderRecord({
    cancel: { claimId: 'C1', claimStatus: 'CANCEL_DONE', cancelCompletedDate: '2026-07-26T09:00:00.000+09:00' },
  }));
  assert.equal(order.cancelledAt, '2026-07-26T09:00:00.000+09:00');
});

test('normalizeNaverOrder falls back to originalProductId when productId is absent', () => {
  const record = fakeNaverProductOrderRecord();
  delete record.productOrder.productId;
  record.productOrder.originalProductId = '13620845243';
  const order = normalizeNaverOrder(record);
  assert.equal(order.channelProductId, '13620845243');
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
    mapChannelOrderImpl: async (db, order) => order,
    acknowledgeCoupangShipmentBoxIdsImpl: async () => {},
  });
  assert.equal(results.length, 2);
  assert.equal(recorded[0].channelOrderItemId, '64253897:3242596358');
  assert.equal(recorded[1].channelOrderId, '111');
});

test('collectCoupangOrders passes the collection client through to the mapper as coupangClientImpl', async () => {
  const client = { async listOrderSheets() { return { data: [fakeOrderSheet()] }; } };
  let mapperArgs;
  const results = await collectCoupangOrders(client, { createdAtFrom: 'a', createdAtTo: 'b' }, {
    db: {},
    recordChannelOrderImpl: async (db, order) => ({ ...order, id: 1, isNew: true }),
    mapChannelOrderImpl: async (db, order, options) => { mapperArgs = options; return { ...order, supplierMappingStatus: 'mapped' }; },
    acknowledgeCoupangShipmentBoxIdsImpl: async () => {},
  });
  assert.equal(mapperArgs.coupangClientImpl, client);
  assert.equal(results[0].supplierMappingStatus, 'mapped');
  assert.equal(results[0].isNew, true);
});

test('collectCoupangOrders acknowledges every distinct shipmentBoxId seen (결제완료 -> 상품준비중), deduped across pages', async () => {
  const client = {
    async listOrderSheets({ nextToken }) {
      if (!nextToken) return { data: [fakeOrderSheet({ shipmentBoxId: 111 })], nextToken: 'page-2' };
      // Same shipmentBoxId reappearing (e.g. a bundled box with 2 items split
      // across pages) must only be acknowledged once.
      return { data: [fakeOrderSheet({ shipmentBoxId: 111 }), fakeOrderSheet({ shipmentBoxId: 222 })], nextToken: undefined };
    },
  };
  const acknowledgedBatches = [];
  await collectCoupangOrders(client, { createdAtFrom: 'a', createdAtTo: 'b' }, {
    db: {},
    recordChannelOrderImpl: async (db, order) => ({ ...order, isNew: true }),
    mapChannelOrderImpl: async (db, order) => order,
    acknowledgeCoupangShipmentBoxIdsImpl: async (c, ids) => { acknowledgedBatches.push(ids); },
  });
  assert.equal(acknowledgedBatches.length, 1);
  assert.deepEqual([...acknowledgedBatches[0]].sort(), [111, 222]);
});

test('collectCoupangOrders does not acknowledge when collecting a non-ACCEPT status', async () => {
  const client = { async listOrderSheets() { return { data: [fakeOrderSheet()] }; } };
  let acknowledgeCalled = false;
  await collectCoupangOrders(client, { createdAtFrom: 'a', createdAtTo: 'b', status: 'DELIVERING' }, {
    db: {},
    recordChannelOrderImpl: async (db, order) => ({ ...order, isNew: true }),
    mapChannelOrderImpl: async (db, order) => order,
    acknowledgeCoupangShipmentBoxIdsImpl: async () => { acknowledgeCalled = true; },
  });
  assert.equal(acknowledgeCalled, false);
});

test('collectCoupangOrders swallows an acknowledgement failure rather than losing already-recorded orders', async () => {
  const client = { async listOrderSheets() { return { data: [fakeOrderSheet()] }; } };
  const results = await collectCoupangOrders(client, { createdAtFrom: 'a', createdAtTo: 'b' }, {
    db: {},
    recordChannelOrderImpl: async (db, order) => ({ ...order, isNew: true }),
    mapChannelOrderImpl: async (db, order) => order,
    acknowledgeCoupangShipmentBoxIdsImpl: async () => { throw new Error('acknowledge failed'); },
  });
  assert.equal(results.length, 1);
});

test('collectCoupangOrders (default acknowledge implementation) chunks into batches of 50 per Coupang\'s documented recommendation', async () => {
  // 51 distinct shipmentBoxIds on a single page, exercising the real
  // (non-injected) acknowledgeCoupangShipmentBoxIds chunking against a
  // mocked client.acknowledgeOrders.
  const sheets = Array.from({ length: 51 }, (_, i) => fakeOrderSheet({ shipmentBoxId: 1000 + i, orderId: 2000 + i }));
  const acknowledgedBatches = [];
  const client = {
    async listOrderSheets() { return { data: sheets }; },
    async acknowledgeOrders(ids) { acknowledgedBatches.push(ids); },
  };
  await collectCoupangOrders(client, { createdAtFrom: 'a', createdAtTo: 'b' }, {
    db: {},
    recordChannelOrderImpl: async (db, order) => ({ ...order, isNew: true }),
    mapChannelOrderImpl: async (db, order) => order,
  });
  assert.equal(acknowledgedBatches.length, 2);
  assert.equal(acknowledgedBatches[0].length, 50);
  assert.equal(acknowledgedBatches[1].length, 1);
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
      return {
        data: [
          { productOrder: { productOrderId: 'A', productOrderStatus: 'PAYED' } },
          { productOrder: { productOrderId: 'B', productOrderStatus: 'PAYED' } },
        ],
      };
    },
  };
  const results = await collectNaverOrders(client, { lastChangedFrom: 'a' }, {
    db: {},
    recordChannelOrderImpl: async (db, order) => { recorded.push(order); return { ...order, isNew: true }; },
    mapChannelOrderImpl: async (db, order) => order,
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
