import assert from 'node:assert/strict';
import test from 'node:test';

import { runCancellationExceptionSweep, attemptSupplierCancellation } from '../src/cancellation-handler.mjs';

test('runCancellationExceptionSweep only queries supplier_ordered rows and skips ones whose channel order is still active', async () => {
  let queriedStatus;
  const created = [];
  const results = await runCancellationExceptionSweep({}, {
    listSupplierOrdersImpl: async (db, { status }) => { queriedStatus = status; return [{ id: 1, channelOrderId: 10 }]; },
    getChannelOrderImpl: async () => ({ id: 10, orderStatus: 'ACCEPT', cancelledAt: null }),
    createOrderExceptionImpl: async (db, args) => { created.push(args); return args; },
  });
  assert.equal(queriedStatus, 'supplier_ordered');
  assert.deepEqual(created, []);
  assert.deepEqual(results, []);
});

test('runCancellationExceptionSweep flags CANCEL_NOT_SHIPPED when the order has no tracking number yet', async () => {
  let created;
  await runCancellationExceptionSweep({}, {
    listSupplierOrdersImpl: async () => [{ id: 1, channelOrderId: 10, trackingNumber: null, domemeOrderNo: '73002356' }],
    getChannelOrderImpl: async () => ({ id: 10, orderStatus: 'CANCELLED', cancelledAt: '2026-07-26T00:00:00Z' }),
    createOrderExceptionImpl: async (db, args) => { created = args; return args; },
  });
  assert.equal(created.exceptionType, 'CANCEL_NOT_SHIPPED');
  assert.equal(created.channelOrderId, 10);
  assert.equal(created.supplierOrderId, 1);
});

test('runCancellationExceptionSweep flags CANCEL_ALREADY_SHIPPED when a tracking number is already on file', async () => {
  let created;
  await runCancellationExceptionSweep({}, {
    listSupplierOrdersImpl: async () => [{ id: 1, channelOrderId: 10, trackingNumber: '255593464954', domemeOrderNo: '73002356' }],
    getChannelOrderImpl: async () => ({ id: 10, orderStatus: 'CANCELLED', cancelledAt: '2026-07-26T00:00:00Z' }),
    createOrderExceptionImpl: async (db, args) => { created = args; return args; },
  });
  assert.equal(created.exceptionType, 'CANCEL_ALREADY_SHIPPED');
});

test('runCancellationExceptionSweep continues past a single failure', async () => {
  const results = await runCancellationExceptionSweep({}, {
    listSupplierOrdersImpl: async () => [{ id: 1, channelOrderId: 10 }, { id: 2, channelOrderId: 11 }],
    getChannelOrderImpl: async (db, channelOrderId) => {
      if (channelOrderId === 11) throw new Error('boom');
      return { id: 10, orderStatus: 'ACCEPT' };
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].error, 'boom');
});

function fakeException(overrides = {}) {
  return { id: 1, status: 'open', exceptionType: 'CANCEL_NOT_SHIPPED', supplierOrderId: 5, detail: { domemeOrderNo: '73002356' }, ...overrides };
}

test('attemptSupplierCancellation validates the exception before calling domeme: NOT_FOUND / NOT_OPEN / WRONG_EXCEPTION_TYPE / NO_ORDER_NUMBER', async () => {
  await assert.rejects(
    attemptSupplierCancellation({}, {}, 1, {}, { getOrderExceptionImpl: async () => null }),
    (e) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
  );
  await assert.rejects(
    attemptSupplierCancellation({}, {}, 1, {}, { getOrderExceptionImpl: async () => fakeException({ status: 'resolved' }) }),
    (e) => { assert.equal(e.code, 'NOT_OPEN'); return true; },
  );
  await assert.rejects(
    attemptSupplierCancellation({}, {}, 1, {}, { getOrderExceptionImpl: async () => fakeException({ exceptionType: 'CANCEL_ALREADY_SHIPPED' }) }),
    (e) => { assert.equal(e.code, 'WRONG_EXCEPTION_TYPE'); return true; },
  );
  await assert.rejects(
    attemptSupplierCancellation({}, {}, 1, {}, { getOrderExceptionImpl: async () => fakeException({ detail: {} }) }),
    (e) => { assert.equal(e.code, 'NO_ORDER_NUMBER'); return true; },
  );
});

test('attemptSupplierCancellation calls domeme cancelOrder, records the supplier-order cancellation, and resolves the exception on success', async () => {
  let cancelArgs;
  let cancelled;
  let resolved;
  const client = { async cancelOrder(args) { cancelArgs = args; return { result: 'complete' }; } };
  const result = await attemptSupplierCancellation({}, client, 1, { sId: 'sess-123', memo: '고객 취소' }, {
    getOrderExceptionImpl: async () => fakeException(),
    recordSupplierOrderCancellationImpl: async (db, id, args) => { cancelled = { id, ...args }; return { id, status: 'cancelled' }; },
    resolveOrderExceptionImpl: async (db, id, args) => { resolved = { id, ...args }; return { id, status: 'resolved', ...args }; },
  });
  assert.equal(cancelArgs.orderNo, '73002356');
  assert.equal(cancelArgs.sId, 'sess-123');
  assert.equal(cancelled.id, 5);
  assert.equal(resolved.id, 1);
  assert.equal(result.status, 'resolved');
});

test('attemptSupplierCancellation leaves the exception open and returns the domeme result when cancellation is not confirmed', async () => {
  const client = { async cancelOrder() { return { result: 'false' }; } };
  const result = await attemptSupplierCancellation({}, client, 1, { sId: 'sess-123' }, {
    getOrderExceptionImpl: async () => fakeException(),
    recordSupplierOrderCancellationImpl: async () => { throw new Error('should not record a cancellation that was not confirmed'); },
    resolveOrderExceptionImpl: async () => { throw new Error('should not resolve an exception that was not confirmed'); },
  });
  assert.equal(result.domemeResult.result, 'false');
});
