import assert from 'node:assert/strict';
import test from 'node:test';

import { collectCoupangReturnRequests, runCoupangReturnRequestCollection } from '../src/return-request-collector.mjs';

function fakeReturnRequest(overrides = {}) {
  return {
    receiptId: 900001, orderId: 22000009546234, receiptType: 'RETURN', receiptStatus: 'RETURNS_UNCHECKED',
    cancelReason: '단순 변심', faultByType: 'CUSTOMER',
    returnItems: [{ vendorItemId: 3242596358, releaseStatus: 'Y' }],
    ...overrides,
  };
}

test('collectCoupangReturnRequests skips items with no matching channel_orders row, without creating an exception', async () => {
  const client = { async listReturnRequests() { return { data: [fakeReturnRequest()] }; } };
  let createCalled = false;
  const results = await collectCoupangReturnRequests({}, client, { createdAtFrom: 'a', createdAtTo: 'b' }, {
    findChannelOrderIdImpl: async () => null,
    createOrderExceptionImpl: async () => { createCalled = true; },
  });
  assert.equal(createCalled, false);
  assert.deepEqual(results, []);
});

test('collectCoupangReturnRequests flags RETURN_REQUESTED for a receiptType=RETURN record', async () => {
  const client = { async listReturnRequests() { return { data: [fakeReturnRequest()] }; } };
  let created;
  await collectCoupangReturnRequests({}, client, { createdAtFrom: 'a', createdAtTo: 'b', cancelType: 'RETURN' }, {
    findChannelOrderIdImpl: async () => 10,
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    createOrderExceptionImpl: async (db, args) => { created = args; return args; },
  });
  assert.equal(created.exceptionType, 'RETURN_REQUESTED');
  assert.equal(created.channelOrderId, 10);
  assert.equal(created.detail.faultByType, 'CUSTOMER');
});

test('collectCoupangReturnRequests distinguishes CANCEL_NOT_SHIPPED from CANCEL_ALREADY_SHIPPED by the linked supplier order\'s tracking number', async () => {
  const client = { async listReturnRequests() { return { data: [fakeReturnRequest({ receiptType: 'CANCEL' })] }; } };

  let createdNotShipped;
  await collectCoupangReturnRequests({}, client, { createdAtFrom: 'a', createdAtTo: 'b', cancelType: 'CANCEL' }, {
    findChannelOrderIdImpl: async () => 10,
    getSupplierOrderByChannelOrderIdImpl: async () => ({ id: 5, trackingNumber: null, domemeOrderNo: '73002356' }),
    createOrderExceptionImpl: async (db, args) => { createdNotShipped = args; return args; },
  });
  assert.equal(createdNotShipped.exceptionType, 'CANCEL_NOT_SHIPPED');
  assert.equal(createdNotShipped.detail.domemeOrderNo, '73002356');

  let createdShipped;
  await collectCoupangReturnRequests({}, client, { createdAtFrom: 'a', createdAtTo: 'b', cancelType: 'CANCEL' }, {
    findChannelOrderIdImpl: async () => 10,
    getSupplierOrderByChannelOrderIdImpl: async () => ({ id: 5, trackingNumber: '255593464954' }),
    createOrderExceptionImpl: async (db, args) => { createdShipped = args; return args; },
  });
  assert.equal(createdShipped.exceptionType, 'CANCEL_ALREADY_SHIPPED');
});

test('collectCoupangReturnRequests continues past a single item failure', async () => {
  const client = {
    async listReturnRequests() {
      return {
        data: [
          fakeReturnRequest({ orderId: 1, returnItems: [{ vendorItemId: 1, releaseStatus: 'N' }] }),
          fakeReturnRequest({ orderId: 2, returnItems: [{ vendorItemId: 2, releaseStatus: 'N' }] }),
        ],
      };
    },
  };
  const results = await collectCoupangReturnRequests({}, client, { createdAtFrom: 'a', createdAtTo: 'b' }, {
    findChannelOrderIdImpl: async (db, { channelOrderId }) => { if (channelOrderId === '2') throw new Error('boom'); return 10; },
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    createOrderExceptionImpl: async (db, args) => args,
  });
  assert.equal(results.length, 2);
  assert.equal(results[1].error, 'boom');
});

test('runCoupangReturnRequestCollection skips when the coupang_returns lock is already held', async () => {
  const result = await runCoupangReturnRequestCollection({}, {}, { tryAcquireOrderCollectionLockImpl: async () => null });
  assert.deepEqual(result, { skipped: true, reason: 'ALREADY_RUNNING' });
});

test('runCoupangReturnRequestCollection calls collectCoupangReturnRequests twice (RETURN and CANCEL), releases the lock, and sums flagged counts', async () => {
  const calls = [];
  let released = null;
  const result = await runCoupangReturnRequestCollection({}, {}, {
    tryAcquireOrderCollectionLockImpl: async () => ({ channel: 'coupang_returns', lastSuccessAt: null }),
    releaseOrderCollectionLockImpl: async (db, channel, args) => { released = { channel, ...args }; },
    collectCoupangReturnRequestsImpl: async (db, client, args) => { calls.push(args.cancelType); return args.cancelType === 'CANCEL' ? [{ id: 1 }] : [{ id: 2 }, { id: 3 }]; },
  });
  assert.deepEqual(calls.sort(), ['CANCEL', 'RETURN']);
  assert.equal(result.skipped, false);
  assert.equal(result.flagged, 3);
  assert.equal(released.channel, 'coupang_returns');
  assert.ok(released.successAt);
});
