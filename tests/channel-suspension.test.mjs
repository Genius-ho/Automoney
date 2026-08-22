import assert from 'node:assert/strict';
import test from 'node:test';

import { suspendCoupangListing, suspendNaverListing, runSupplierMonitorAndSuspendSweep } from '../src/channel-suspension.mjs';

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

test('suspendNaverListing is a no-op when the draft has no linked Naver listing', async () => {
  const result = await suspendNaverListing({}, {}, 46, { getNaverRegistrationImpl: async () => null });
  assert.deepEqual(result, { suspended: false, reason: 'NOT_LINKED' });
});

test('suspendNaverListing calls changeProductStatus with statusType=SUSPENSION on the whole product (no item enumeration)', async () => {
  let statusArgs;
  const client = { async changeProductStatus(originProductNo, args) { statusArgs = { originProductNo, ...args }; } };
  const result = await suspendNaverListing({}, client, 46, {
    getNaverRegistrationImpl: async () => ({ originProductNo: '13620845243' }),
  });
  assert.equal(statusArgs.originProductNo, '13620845243');
  assert.equal(statusArgs.statusType, 'SUSPENSION');
  assert.equal(result.suspended, true);
});

test('suspendNaverListing reports a failure without throwing', async () => {
  const client = { async changeProductStatus() { throw new Error('boom'); } };
  const result = await suspendNaverListing({}, client, 46, {
    getNaverRegistrationImpl: async () => ({ originProductNo: '13620845243' }),
  });
  assert.equal(result.suspended, false);
  assert.match(result.error, /boom/);
});

test('runSupplierMonitorAndSuspendSweep persists every alert (not just SUPPLIER_OUT_OF_STOCK) into supplier_alerts', async () => {
  const persisted = [];
  await runSupplierMonitorAndSuspendSweep({}, {}, {}, {
    runSupplierMonitorSweepImpl: async () => ([
      { supplierProductId: 1, alerts: [{ code: 'SUPPLIER_PRICE_INCREASED', message: '공급가 상승', previousValue: 1700, currentValue: 2200 }] },
      { supplierProductId: 2, alerts: [{ code: 'SUPPLIER_OUT_OF_STOCK', message: '품절' }] },
    ]),
    createSupplierAlertImpl: async (db, args) => { persisted.push(args); return args; },
  });
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].code, 'SUPPLIER_PRICE_INCREASED');
  assert.deepEqual(persisted[0].detail, { previousValue: 1700, currentValue: 2200 });
  assert.equal(persisted[1].code, 'SUPPLIER_OUT_OF_STOCK');
});

test('runSupplierMonitorAndSuspendSweep continues even when persisting an alert fails', async () => {
  const results = await runSupplierMonitorAndSuspendSweep({}, {}, {}, {
    runSupplierMonitorSweepImpl: async () => ([{ supplierProductId: 1, alerts: [{ code: 'SUPPLIER_PRICE_INCREASED', message: 'x' }] }]),
    createSupplierAlertImpl: async () => { throw new Error('db down'); },
  });
  assert.equal(results[0].alerts[0].persistError, 'db down');
});

test('runSupplierMonitorAndSuspendSweep only attempts suspension for SUPPLIER_OUT_OF_STOCK results with a linked draft, on both channels', async () => {
  const coupangSuspended = [];
  const naverSuspended = [];
  const results = await runSupplierMonitorAndSuspendSweep({}, {}, { coupangClient: {}, naverClient: {} }, {
    runSupplierMonitorSweepImpl: async () => ([
      { supplierProductId: 1, alerts: [{ code: 'SUPPLIER_PRICE_INCREASED' }] },
      { supplierProductId: 2, alerts: [{ code: 'SUPPLIER_OUT_OF_STOCK' }] },
    ]),
    findLinkedCoupangProductDraftIdsImpl: async (db, supplierProductId) => (supplierProductId === 2 ? [46] : []),
    findLinkedNaverProductDraftIdsImpl: async (db, supplierProductId) => (supplierProductId === 2 ? [46] : []),
    suspendCoupangListingImpl: async (db, client, draftId) => { coupangSuspended.push(draftId); return { suspended: true, items: [] }; },
    suspendNaverListingImpl: async (db, client, draftId) => { naverSuspended.push(draftId); return { suspended: true }; },
  });
  assert.deepEqual(coupangSuspended, [46]);
  assert.deepEqual(naverSuspended, [46]);
  assert.equal(results[0].coupangSuspensions, undefined);
  assert.equal(results[0].naverSuspensions, undefined);
  assert.deepEqual(results[1].coupangSuspensions, [{ productDraftId: 46, suspended: true, items: [] }]);
  assert.deepEqual(results[1].naverSuspensions, [{ productDraftId: 46, suspended: true }]);
});

test('runSupplierMonitorAndSuspendSweep skips a channel entirely when its client is not provided', async () => {
  const results = await runSupplierMonitorAndSuspendSweep({}, {}, { coupangClient: {} }, {
    runSupplierMonitorSweepImpl: async () => ([{ supplierProductId: 2, alerts: [{ code: 'SUPPLIER_OUT_OF_STOCK' }] }]),
    findLinkedCoupangProductDraftIdsImpl: async () => [46],
    suspendCoupangListingImpl: async () => ({ suspended: true, items: [] }),
    findLinkedNaverProductDraftIdsImpl: async () => { throw new Error('should not be called -- no naverClient given'); },
  });
  assert.deepEqual(results[0].coupangSuspensions, [{ productDraftId: 46, suspended: true, items: [] }]);
  assert.equal(results[0].naverSuspensions, undefined);
});

test('runSupplierMonitorAndSuspendSweep records a suspension failure without throwing', async () => {
  const results = await runSupplierMonitorAndSuspendSweep({}, {}, { coupangClient: {} }, {
    runSupplierMonitorSweepImpl: async () => ([{ supplierProductId: 2, alerts: [{ code: 'SUPPLIER_OUT_OF_STOCK' }] }]),
    findLinkedCoupangProductDraftIdsImpl: async () => [46],
    suspendCoupangListingImpl: async () => { throw new Error('boom'); },
  });
  assert.equal(results[0].coupangSuspensions[0].error, 'boom');
  assert.equal(results[0].coupangSuspensions[0].suspended, false);
});
