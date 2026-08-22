import assert from 'node:assert/strict';
import test from 'node:test';

import { extractShipmentInfo, collectSupplierShipment, runShipmentCollectionSweep } from '../src/shipment-collector.mjs';

test('extractShipmentInfo reads carrier code/name/tracking number/ship date from a real getOrderView shape', () => {
  const orderDetail = {
    orderNo: 'OR73002356',
    delivery: { method: '택배', who: '선결제', fee: '3000', company: 'HYUNDAI', companyName: '롯데택배', code: '255593464954', date: 1777987620, dateStart: '1778024130' },
  };
  assert.deepEqual(extractShipmentInfo(orderDetail), {
    carrierCode: 'HYUNDAI', carrierName: '롯데택배', trackingNumber: '255593464954', shippedAt: new Date(1778024130 * 1000).toISOString(),
  });
});

test('extractShipmentInfo returns null when the supplier has not shipped yet (no tracking code)', () => {
  assert.equal(extractShipmentInfo({ delivery: { company: 'HYUNDAI', code: '' } }), null);
  assert.equal(extractShipmentInfo({ delivery: {} }), null);
  assert.equal(extractShipmentInfo({}), null);
});

test('extractShipmentInfo tolerates a missing/zero dateStart without crashing', () => {
  const result = extractShipmentInfo({ delivery: { company: 'HYUNDAI', companyName: '롯데택배', code: '123', dateStart: '0' } });
  assert.equal(result.shippedAt, null);
});

test('collectSupplierShipment is a no-op when the supplier order has no domeme order number yet', async () => {
  const result = await collectSupplierShipment({}, {}, { id: 5, domemeOrderNo: null });
  assert.equal(result, null);
});

test('collectSupplierShipment fetches the order via a valid session and records the shipment', async () => {
  let getOrderArgs;
  let recorded;
  const client = { async getOrder(args) { getOrderArgs = args; return { delivery: { company: 'HYUNDAI', companyName: '롯데택배', code: '255593464954', dateStart: '1778024130' } }; } };
  const result = await collectSupplierShipment({}, client, { id: 5, domemeOrderNo: '73002356' }, {
    getValidDomemeSIdImpl: async () => 'sess-123',
    recordSupplierShipmentImpl: async (db, id, shipment) => { recorded = { id, ...shipment }; return recorded; },
  });
  assert.equal(getOrderArgs.sId, 'sess-123');
  assert.equal(getOrderArgs.orderNo, '73002356');
  assert.equal(recorded.id, 5);
  assert.equal(recorded.trackingNumber, '255593464954');
  assert.equal(result, recorded);
});

test('collectSupplierShipment returns null (leaves it for next sweep) when not shipped yet, without recording anything', async () => {
  const client = { async getOrder() { return { delivery: { company: 'HYUNDAI', code: '' } }; } };
  const result = await collectSupplierShipment({}, client, { id: 5, domemeOrderNo: '73002356' }, {
    getValidDomemeSIdImpl: async () => 'sess-123',
    recordSupplierShipmentImpl: async () => { throw new Error('should not record when not shipped yet'); },
  });
  assert.equal(result, null);
});

test('runShipmentCollectionSweep continues past a single lookup failure', async () => {
  const collected = [];
  const results = await runShipmentCollectionSweep({}, {}, {
    listOrderedWithoutTrackingImpl: async () => [{ id: 1 }, { id: 2 }],
    collectSupplierShipmentImpl: async (db, client, order) => {
      collected.push(order.id);
      if (order.id === 2) throw new Error('boom');
      return { id: 10 };
    },
  });
  assert.deepEqual(collected, [1, 2]);
  assert.equal(results.length, 2);
  assert.equal(results[1].error, 'boom');
});
