import assert from 'node:assert/strict';
import test from 'node:test';

import { collectNaverClaims, runNaverClaimDetectionSweep } from '../src/naver-claim-collector.mjs';

function fakeRecord(overrides = {}) {
  return { productOrder: { productOrderId: 'A', claimType: null, claimStatus: null }, ...overrides };
}

test('collectNaverClaims returns an empty array without calling the API when there are no ids', async () => {
  const client = { async queryProductOrders() { throw new Error('should not be called'); } };
  assert.deepEqual(await collectNaverClaims({}, client, []), []);
});

test('collectNaverClaims is a no-op for a record with no claimType', async () => {
  const client = { async queryProductOrders() { return { data: [fakeRecord()] }; } };
  let createCalled = false;
  const results = await collectNaverClaims({}, client, ['A'], {
    findChannelOrderByItemIdImpl: async () => 10,
    createOrderExceptionImpl: async () => { createCalled = true; },
  });
  assert.equal(createCalled, false);
  assert.deepEqual(results, []);
});

test('collectNaverClaims skips a record with no matching channel_orders row', async () => {
  const client = { async queryProductOrders() { return { data: [fakeRecord({ productOrder: { productOrderId: 'A', claimType: 'CANCEL' } })] }; } };
  let createCalled = false;
  await collectNaverClaims({}, client, ['A'], {
    findChannelOrderByItemIdImpl: async () => null,
    createOrderExceptionImpl: async () => { createCalled = true; },
  });
  assert.equal(createCalled, false);
});

test('collectNaverClaims maps claimType CANCEL to CANCEL_NOT_SHIPPED or CANCEL_ALREADY_SHIPPED by the linked supplier order\'s tracking number', async () => {
  const client = { async queryProductOrders() { return { data: [fakeRecord({ productOrder: { productOrderId: 'A', claimType: 'CANCEL', claimStatus: 'CANCEL_REQUEST' } })] }; } };

  let createdNotShipped;
  await collectNaverClaims({}, client, ['A'], {
    findChannelOrderByItemIdImpl: async () => 10,
    getSupplierOrderByChannelOrderIdImpl: async () => ({ id: 5, trackingNumber: null, domemeOrderNo: '73002356' }),
    createOrderExceptionImpl: async (db, args) => { createdNotShipped = args; return args; },
  });
  assert.equal(createdNotShipped.exceptionType, 'CANCEL_NOT_SHIPPED');

  let createdShipped;
  await collectNaverClaims({}, client, ['A'], {
    findChannelOrderByItemIdImpl: async () => 10,
    getSupplierOrderByChannelOrderIdImpl: async () => ({ id: 5, trackingNumber: '255593464954' }),
    createOrderExceptionImpl: async (db, args) => { createdShipped = args; return args; },
  });
  assert.equal(createdShipped.exceptionType, 'CANCEL_ALREADY_SHIPPED');
});

test('collectNaverClaims maps claimType RETURN and EXCHANGE to their own exception types', async () => {
  const returnClient = { async queryProductOrders() { return { data: [fakeRecord({ productOrder: { productOrderId: 'A', claimType: 'RETURN' } })] }; } };
  let createdReturn;
  await collectNaverClaims({}, returnClient, ['A'], {
    findChannelOrderByItemIdImpl: async () => 10,
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    createOrderExceptionImpl: async (db, args) => { createdReturn = args; return args; },
  });
  assert.equal(createdReturn.exceptionType, 'RETURN_REQUESTED');

  const exchangeClient = { async queryProductOrders() { return { data: [fakeRecord({ productOrder: { productOrderId: 'A', claimType: 'EXCHANGE' } })] }; } };
  let createdExchange;
  await collectNaverClaims({}, exchangeClient, ['A'], {
    findChannelOrderByItemIdImpl: async () => 10,
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    createOrderExceptionImpl: async (db, args) => { createdExchange = args; return args; },
  });
  assert.equal(createdExchange.exceptionType, 'EXCHANGE_REQUESTED');
});

test('collectNaverClaims continues past a single item failure', async () => {
  const client = {
    async queryProductOrders() {
      return {
        data: [
          fakeRecord({ productOrder: { productOrderId: 'A', claimType: 'CANCEL' } }),
          fakeRecord({ productOrder: { productOrderId: 'B', claimType: 'CANCEL' } }),
        ],
      };
    },
  };
  const results = await collectNaverClaims({}, client, ['A', 'B'], {
    findChannelOrderByItemIdImpl: async (db, id) => { if (id === 'B') throw new Error('boom'); return 10; },
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    createOrderExceptionImpl: async (db, args) => args,
  });
  assert.equal(results.length, 2);
  assert.equal(results[1].error, 'boom');
});

test('runNaverClaimDetectionSweep batches ids in groups and merges results', async () => {
  const batches = [];
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
  const results = await runNaverClaimDetectionSweep({}, {}, {
    listNaverChannelOrderItemIdsImpl: async () => ids,
    collectNaverClaimsImpl: async (db, client, chunk) => { batches.push(chunk.length); return chunk.map((id) => ({ id })); },
  });
  assert.deepEqual(batches, [100, 100, 50]);
  assert.equal(results.length, 250);
});
