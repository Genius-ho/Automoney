import assert from 'node:assert/strict';
import test from 'node:test';

import { suspendCoupangListing, runSupplierMonitorAndSuspendSweep } from '../src/channel-suspension.mjs';

test('suspendCoupangListing is a no-op when the draft has no linked Coupang listing', async () => {
  const result = await suspendCoupangListing({}, {}, 46, { getCoupangRegistrationImpl: async () => null });
  assert.deepEqual(result, { suspended: false, reason: 'NOT_LINKED', items: [] });
});

test('suspendCoupangListing fetches the live product and suspends every vendorItemId found', async () => {
  let suspendedIds = [];
  const client = {
    async getProduct() { return { data: { items: [{ vendorItemId: 1 }, { vendorItemId: 2 }] } }; },
    async suspendSale(vendorItemId) { suspendedIds.push(vendorItemId); },
  };
  const result = await suspendCoupangListing({}, client, 46, {
    getCoupangRegistrationImpl: async () => ({ sellerProductId: '12345' }),
  });
  assert.deepEqual(suspendedIds, [1, 2]);
  assert.equal(result.suspended, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items.every((i) => i.ok), true);
});

test('suspendCoupangListing continues past a single item failure and still reports partial success', async () => {
  const client = {
    async getProduct() { return { data: { items: [{ vendorItemId: 1 }, { vendorItemId: 2 }] } }; },
    async suspendSale(vendorItemId) { if (vendorItemId === 2) throw new Error('boom'); },
  };
  const result = await suspendCoupangListing({}, client, 46, {
    getCoupangRegistrationImpl: async () => ({ sellerProductId: '12345' }),
  });
  assert.equal(result.suspended, true);
  assert.equal(result.items[0].ok, true);
  assert.equal(result.items[1].ok, false);
  assert.match(result.items[1].error, /boom/);
});

test('runSupplierMonitorAndSuspendSweep only attempts suspension for SUPPLIER_OUT_OF_STOCK results with a linked draft', async () => {
  const suspended = [];
  const results = await runSupplierMonitorAndSuspendSweep({}, {}, {}, {
    runSupplierMonitorSweepImpl: async () => ([
      { supplierProductId: 1, alerts: [{ code: 'SUPPLIER_PRICE_INCREASED' }] },
      { supplierProductId: 2, alerts: [{ code: 'SUPPLIER_OUT_OF_STOCK' }] },
    ]),
    findLinkedCoupangProductDraftIdsImpl: async (db, supplierProductId) => (supplierProductId === 2 ? [46] : []),
    suspendCoupangListingImpl: async (db, client, draftId) => { suspended.push(draftId); return { suspended: true, items: [] }; },
  });
  assert.deepEqual(suspended, [46]);
  assert.equal(results[0].coupangSuspensions, undefined);
  assert.deepEqual(results[1].coupangSuspensions, [{ productDraftId: 46, suspended: true, items: [] }]);
});

test('runSupplierMonitorAndSuspendSweep records a suspension failure without throwing', async () => {
  const results = await runSupplierMonitorAndSuspendSweep({}, {}, {}, {
    runSupplierMonitorSweepImpl: async () => ([{ supplierProductId: 2, alerts: [{ code: 'SUPPLIER_OUT_OF_STOCK' }] }]),
    findLinkedCoupangProductDraftIdsImpl: async () => [46],
    suspendCoupangListingImpl: async () => { throw new Error('boom'); },
  });
  assert.equal(results[0].coupangSuspensions[0].error, 'boom');
  assert.equal(results[0].coupangSuspensions[0].suspended, false);
});
