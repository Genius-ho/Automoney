import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchSupplierOrderToChannel, runChannelDispatchSweep } from '../src/channel-dispatch.mjs';

function fakeSupplierOrder(overrides = {}) {
  return { id: 5, channelOrderId: 10, channelShipStatus: 'not_shipped', trackingNumber: '255593464954', carrierCode: 'HYUNDAI', ...overrides };
}

function fakeChannelOrder(overrides = {}) {
  return { id: 10, channel: 'coupang', channelOrderId: '22000009546234', channelOrderItemId: '64253897:3242596358', orderStatus: 'ACCEPT', cancelledAt: null, ...overrides };
}

test('dispatchSupplierOrderToChannel throws NOT_FOUND / NO_TRACKING appropriately', async () => {
  await assert.rejects(
    dispatchSupplierOrderToChannel({}, 1, {}, { getSupplierOrderImpl: async () => null }),
    (e) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
  );
  await assert.rejects(
    dispatchSupplierOrderToChannel({}, 1, {}, { getSupplierOrderImpl: async () => fakeSupplierOrder({ trackingNumber: null }) }),
    (e) => { assert.equal(e.code, 'NO_TRACKING'); return true; },
  );
});

test('dispatchSupplierOrderToChannel is a no-op that returns the row unchanged once already sent', async () => {
  const already = fakeSupplierOrder({ channelShipStatus: 'sent' });
  const result = await dispatchSupplierOrderToChannel({}, 5, {}, { getSupplierOrderImpl: async () => already });
  assert.equal(result, already);
});

test('dispatchSupplierOrderToChannel skips (does not call uploadInvoice) when the channel order was cancelled', async () => {
  let recorded;
  const client = { async uploadInvoice() { throw new Error('should not upload for a cancelled order'); } };
  await dispatchSupplierOrderToChannel({}, 5, { coupangClient: client }, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder({ cancelledAt: '2026-07-26T00:00:00Z' }),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.equal(recorded.channelShipStatus, 'cancelled_skip');
});

test('dispatchSupplierOrderToChannel records unsupported_channel for a non-Coupang order without attempting anything', async () => {
  let recorded;
  await dispatchSupplierOrderToChannel({}, 5, {}, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder({ channel: 'naver' }),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.equal(recorded.channelShipStatus, 'unsupported_channel');
});

test('dispatchSupplierOrderToChannel records mapping_failed for an unrecognized carrier code without calling uploadInvoice', async () => {
  let recorded;
  const client = { async uploadInvoice() { throw new Error('should not upload for an unmapped carrier'); } };
  await dispatchSupplierOrderToChannel({}, 5, { coupangClient: client }, {
    getSupplierOrderImpl: async () => fakeSupplierOrder({ carrierCode: 'SOME_NEW_CARRIER' }),
    getChannelOrderImpl: async () => fakeChannelOrder(),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.equal(recorded.channelShipStatus, 'mapping_failed');
  assert.match(recorded.channelShipError, /SOME_NEW_CARRIER/);
});

test('dispatchSupplierOrderToChannel uploads the invoice with fields parsed from channel_order_item_id, and records success', async () => {
  let uploadArgs;
  let recorded;
  const client = { async uploadInvoice(args) { uploadArgs = args; return {}; } };
  await dispatchSupplierOrderToChannel({}, 5, { coupangClient: client }, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder(),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.equal(uploadArgs.shipmentBoxId, 64253897);
  assert.equal(uploadArgs.vendorItemId, 3242596358);
  assert.equal(uploadArgs.orderId, 22000009546234);
  assert.equal(uploadArgs.deliveryCompanyCode, 'HYUNDAI');
  assert.equal(uploadArgs.invoiceNumber, '255593464954');
  assert.equal(recorded.channelShipStatus, 'sent');
});

test('dispatchSupplierOrderToChannel records a failed upload as channelShipStatus=failed rather than throwing', async () => {
  let recorded;
  const client = { async uploadInvoice() { throw new Error('INVOICE_ALREADY_EXISTS'); } };
  await dispatchSupplierOrderToChannel({}, 5, { coupangClient: client }, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder(),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.equal(recorded.channelShipStatus, 'failed');
  assert.match(recorded.channelShipError, /INVOICE_ALREADY_EXISTS/);
});

test('dispatchSupplierOrderToChannel confirms then dispatches a Naver order, and records success', async () => {
  let confirmArgs;
  let dispatchArgs;
  let recorded;
  const client = {
    async confirmProductOrders(ids) { confirmArgs = ids; return { data: { successProductOrderIds: ids, failProductOrderInfos: [] } }; },
    async dispatchProductOrders(items) { dispatchArgs = items; return { data: { successProductOrderIds: [items[0].productOrderId], failProductOrderInfos: [] } }; },
  };
  await dispatchSupplierOrderToChannel({}, 5, { naverClient: client }, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder({ channel: 'naver', channelOrderItemId: '2026072512345671' }),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.deepEqual(confirmArgs, ['2026072512345671']);
  assert.equal(dispatchArgs[0].productOrderId, '2026072512345671');
  assert.equal(dispatchArgs[0].deliveryMethod, 'DELIVERY');
  assert.equal(dispatchArgs[0].deliveryCompanyCode, 'HYUNDAI');
  assert.equal(dispatchArgs[0].trackingNumber, '255593464954');
  assert.equal(recorded.channelShipStatus, 'sent');
});

test('dispatchSupplierOrderToChannel records a Naver 발주확인 failure without attempting dispatchProductOrders', async () => {
  let dispatchCalled = false;
  let recorded;
  const client = {
    async confirmProductOrders(ids) { return { data: { successProductOrderIds: [], failProductOrderInfos: [{ productOrderId: ids[0], code: 'INVALID_STATUS', message: '이미 발주확인된 주문' }] } }; },
    async dispatchProductOrders() { dispatchCalled = true; return {}; },
  };
  await dispatchSupplierOrderToChannel({}, 5, { naverClient: client }, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder({ channel: 'naver', channelOrderItemId: '2026072512345671' }),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.equal(dispatchCalled, false);
  assert.equal(recorded.channelShipStatus, 'failed');
  assert.match(recorded.channelShipError, /발주확인 실패/);
});

test('dispatchSupplierOrderToChannel records a Naver 발송처리 failure', async () => {
  let recorded;
  const client = {
    async confirmProductOrders(ids) { return { data: { successProductOrderIds: ids, failProductOrderInfos: [] } }; },
    async dispatchProductOrders(items) { return { data: { successProductOrderIds: [], failProductOrderInfos: [{ productOrderId: items[0].productOrderId, code: 'INVALID_DELIVERY_COMPANY', message: '잘못된 택배사' }] } }; },
  };
  await dispatchSupplierOrderToChannel({}, 5, { naverClient: client }, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder({ channel: 'naver', channelOrderItemId: '2026072512345671' }),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.equal(recorded.channelShipStatus, 'failed');
  assert.match(recorded.channelShipError, /발송처리 실패/);
});

test('dispatchSupplierOrderToChannel records unsupported_channel for an unknown channel', async () => {
  let recorded;
  await dispatchSupplierOrderToChannel({}, 5, {}, {
    getSupplierOrderImpl: async () => fakeSupplierOrder(),
    getChannelOrderImpl: async () => fakeChannelOrder({ channel: 'gmarket' }),
    recordChannelShipmentResultImpl: async (db, id, args) => { recorded = args; return { ...fakeSupplierOrder(), ...args }; },
  });
  assert.equal(recorded.channelShipStatus, 'unsupported_channel');
});

test('runChannelDispatchSweep continues past a single dispatch failure', async () => {
  const attempted = [];
  const results = await runChannelDispatchSweep({}, {}, {
    listShippedNotDispatchedImpl: async () => [{ id: 1 }, { id: 2 }],
    dispatchSupplierOrderToChannelImpl: async (db, id) => {
      attempted.push(id);
      if (id === 2) throw new Error('boom');
      return { id: 1, channelShipStatus: 'sent' };
    },
  });
  assert.deepEqual(attempted, [1, 2]);
  assert.equal(results.length, 2);
  assert.equal(results[1].error, 'boom');
});
