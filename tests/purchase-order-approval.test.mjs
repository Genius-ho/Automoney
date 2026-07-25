import assert from 'node:assert/strict';
import test from 'node:test';

import { approveSupplierOrder } from '../src/purchase-order-approval.mjs';
import { DomemePrivateApiError } from '../src/domeme-private-client.mjs';

function fakeSupplierOrder(overrides = {}) {
  return {
    id: 5, channelOrderId: 10, productDraftId: 46, status: 'awaiting_purchase_approval',
    supplierMarket: 'supply', supplierOptionCode: '01', supplierOrderQty: 2,
    ...overrides,
  };
}

function fakeChannelOrder(overrides = {}) {
  return {
    id: 10, channel: 'coupang', channelOrderId: '22000009546234',
    recipientName: '김철수', address: '서울시 강남구 101동 202호', postalCode: '06000', phone: '010-1234-5678',
    deliveryMemo: '문 앞에 놔주세요',
    ...overrides,
  };
}

test('approveSupplierOrder throws NOT_FOUND when the supplier order does not exist', async () => {
  await assert.rejects(
    approveSupplierOrder({}, {}, 1, { getSupplierOrderImpl: async () => null }),
    (error) => { assert.equal(error.code, 'NOT_FOUND'); return true; },
  );
});

test('approveSupplierOrder refuses to approve a supplier order that is not awaiting_purchase_approval', async () => {
  await assert.rejects(
    approveSupplierOrder({}, {}, 1, { getSupplierOrderImpl: async () => fakeSupplierOrder({ status: 'supplier_ordered' }) }),
    (error) => { assert.equal(error.code, 'NOT_APPROVABLE'); return true; },
  );
});

test('approveSupplierOrder re-validates immediately before ordering, and refuses to order if that revalidation now blocks it', async () => {
  let createOrderCalled = false;
  const client = { async createOrder() { createOrderCalled = true; } };
  const result = await approveSupplierOrder({}, client, 5, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder(),
    buildSupplierOrderDraftImpl: async () => ({ id: 5, status: 'validating_supplier', blockReasons: ['SUPPLIER_SOLD_OUT'] }),
  });
  assert.equal(createOrderCalled, false);
  assert.equal(result.status, 'validating_supplier');
});

test('approveSupplierOrder locks, places the real order, and records the domeme order number on success', async () => {
  let createOrderArgs;
  let markedId;
  let recordedSuccess;
  const client = {
    async createOrder(args) { createOrderArgs = args; return { orders: [{ orderNo: 14207678, itemNo: 40170547, recipientName: '김철수' }] }; },
  };
  const result = await approveSupplierOrder({}, client, 5, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder(),
    buildSupplierOrderDraftImpl: async () => fakeSupplierOrder(),
    getDraftOrderingContextImpl: async () => ({ supplierProductNo: '40170547' }),
    markSupplierOrderingImpl: async (db, id) => { markedId = id; return fakeSupplierOrder({ status: 'supplier_ordering' }); },
    getValidDomemeSIdImpl: async () => 'sess-123',
    recordSupplierOrderSuccessImpl: async (db, id, args) => { recordedSuccess = { id, ...args }; return { ...fakeSupplierOrder(), status: 'supplier_ordered' }; },
  });
  assert.equal(markedId, 5);
  assert.equal(createOrderArgs.sId, 'sess-123');
  assert.equal(createOrderArgs.items[0].itemNo, '40170547');
  assert.equal(createOrderArgs.items[0].market, 'supply');
  assert.equal(createOrderArgs.items[0].options[0].code, '01');
  assert.equal(createOrderArgs.deliInfo.name, '김철수');
  assert.equal(createOrderArgs.deliInfo.address2, '');
  assert.deepEqual(recordedSuccess, { id: 5, domemeOrderNo: '14207678' });
  assert.equal(result.status, 'supplier_ordered');
});

test('approveSupplierOrder records a DomemePrivateApiError as a dcode-prefixed failure message, not a thrown exception', async () => {
  let recordedFailure;
  const client = {
    async createOrder() {
      throw new DomemePrivateApiError({ status: 200, operation: 'create_order', dcode: 'TOO_LESS_EMONEY_ERROR', dmessage: '현금성 이머니가 부족합니다' });
    },
  };
  const result = await approveSupplierOrder({}, client, 5, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder(),
    buildSupplierOrderDraftImpl: async () => fakeSupplierOrder(),
    getDraftOrderingContextImpl: async () => ({ supplierProductNo: '40170547' }),
    markSupplierOrderingImpl: async () => fakeSupplierOrder({ status: 'supplier_ordering' }),
    getValidDomemeSIdImpl: async () => 'sess-123',
    recordSupplierOrderFailureImpl: async (db, id, args) => { recordedFailure = { id, ...args }; return { ...fakeSupplierOrder(), status: 'validating_supplier' }; },
  });
  assert.equal(recordedFailure.id, 5);
  assert.match(recordedFailure.failureMessage, /TOO_LESS_EMONEY_ERROR/);
  assert.equal(result.status, 'validating_supplier');
});

test('approveSupplierOrder throws ALREADY_IN_PROGRESS when markSupplierOrdering loses the race (status already moved on)', async () => {
  await assert.rejects(
    approveSupplierOrder({}, {}, 5, {
      getSupplierOrderImpl: async () => fakeSupplierOrder(),
      getChannelOrderImpl: async () => fakeChannelOrder(),
      buildSupplierOrderDraftImpl: async () => fakeSupplierOrder(),
      markSupplierOrderingImpl: async () => null,
    }),
    (error) => { assert.equal(error.code, 'ALREADY_IN_PROGRESS'); return true; },
  );
});
