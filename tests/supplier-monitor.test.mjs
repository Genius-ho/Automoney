import assert from 'node:assert/strict';
import test from 'node:test';

import { diffSnapshots, checkSupplierProduct, runSupplierMonitorSweep } from '../src/supplier-monitor.mjs';

function snapshot(overrides = {}) {
  return {
    unitCostPrice: 10000,
    shippingFee: 3000,
    minOrderQty: 1,
    isSoldOut: false,
    priceParseStatus: 'ok',
    ...overrides,
  };
}

test('diffSnapshots returns no alerts on the very first check (nothing to compare against yet)', () => {
  assert.deepEqual(diffSnapshots(null, snapshot()), []);
});

test('diffSnapshots returns no alerts when nothing changed', () => {
  assert.deepEqual(diffSnapshots(snapshot(), snapshot()), []);
});

test('diffSnapshots flags a supplier going out of stock', () => {
  const alerts = diffSnapshots(snapshot({ isSoldOut: false }), snapshot({ isSoldOut: true }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, 'SUPPLIER_OUT_OF_STOCK');
});

test('diffSnapshots flags a supplier coming back in stock', () => {
  const alerts = diffSnapshots(snapshot({ isSoldOut: true }), snapshot({ isSoldOut: false }));
  assert.equal(alerts[0].code, 'SUPPLIER_BACK_IN_STOCK');
});

test('diffSnapshots flags a price increase distinctly from a price decrease', () => {
  const increased = diffSnapshots(snapshot({ unitCostPrice: 10000 }), snapshot({ unitCostPrice: 12000 }));
  assert.equal(increased[0].code, 'SUPPLIER_PRICE_INCREASED');
  assert.equal(increased[0].previousValue, 10000);
  assert.equal(increased[0].currentValue, 12000);

  const decreased = diffSnapshots(snapshot({ unitCostPrice: 10000 }), snapshot({ unitCostPrice: 8000 }));
  assert.equal(decreased[0].code, 'SUPPLIER_PRICE_DECREASED');
});

test('diffSnapshots flags a MOQ change', () => {
  const alerts = diffSnapshots(snapshot({ minOrderQty: 1 }), snapshot({ minOrderQty: 2 }));
  assert.equal(alerts[0].code, 'SUPPLIER_MOQ_CHANGED');
  assert.equal(alerts[0].previousValue, 1);
  assert.equal(alerts[0].currentValue, 2);
});

test('diffSnapshots flags a newly-broken price parse, but not one that was already broken', () => {
  const newlyBroken = diffSnapshots(snapshot({ priceParseStatus: 'ok' }), snapshot({ priceParseStatus: 'parsing_error', unitCostPrice: null }));
  assert.ok(newlyBroken.some((a) => a.code === 'SUPPLIER_DATA_ERROR'));

  const stillBroken = diffSnapshots(snapshot({ priceParseStatus: 'parsing_error', unitCostPrice: null }), snapshot({ priceParseStatus: 'parsing_error', unitCostPrice: null }));
  assert.ok(!stillBroken.some((a) => a.code === 'SUPPLIER_DATA_ERROR'));
});

test('diffSnapshots never compares prices when either side failed to parse (0 is not a real price)', () => {
  // A parse failure means unitCostPrice is null (extractCurrentState's job),
  // not 0 -- but guard the diff itself too, since a bare 0 must never read
  // as a real price drop.
  const alerts = diffSnapshots(snapshot({ unitCostPrice: null }), snapshot({ unitCostPrice: 10000 }));
  assert.ok(!alerts.some((a) => a.code.startsWith('SUPPLIER_PRICE_')));
});

test('checkSupplierProduct fetches, normalizes, records a new snapshot, and diffs against the prior one', async () => {
  const recorded = [];
  const client = { async fetchProductDetail() { return { productName: 'hook', supplyPrice: '12000', deliveryFee: '3000', images: ['https://example.test/a.jpg'] }; } };
  const result = await checkSupplierProduct(
    { /* db */ },
    client,
    { supplierProductId: 900, supplierProductNo: '49171775', sourceMarket: 'domeme' },
    {
      getLatestSupplierSnapshotImpl: async () => snapshot({ unitCostPrice: 10000 }),
      recordSupplierSnapshotImpl: async (db, id, no, current) => { recorded.push({ id, no, current }); return { ...current, id: 1, supplierProductId: id, supplierProductNo: no, checkedAt: '2026-07-25T00:00:00Z' }; },
    },
  );
  assert.equal(recorded[0].id, 900);
  assert.equal(recorded[0].no, '49171775');
  assert.equal(recorded[0].current.unitCostPrice, 12000);
  assert.equal(result.alerts[0].code, 'SUPPLIER_PRICE_INCREASED');
  assert.equal(result.current.unitCostPrice, 12000);
});

test('checkSupplierProduct never lets a price-parse failure read as a real price (0)', async () => {
  const client = { async fetchProductDetail() { return { productName: 'hook', images: ['https://example.test/a.jpg'] }; } };
  const result = await checkSupplierProduct(
    {},
    client,
    { supplierProductId: 900, supplierProductNo: '49171775', sourceMarket: 'domeme' },
    {
      getLatestSupplierSnapshotImpl: async () => snapshot({ unitCostPrice: 10000 }),
      recordSupplierSnapshotImpl: async (db, id, no, current) => ({ ...current, id: 1, supplierProductId: id, supplierProductNo: no, checkedAt: null }),
    },
  );
  assert.equal(result.current.unitCostPrice, null);
  assert.ok(!result.alerts.some((a) => a.code.startsWith('SUPPLIER_PRICE_')));
});

test('runSupplierMonitorSweep continues past a single product fetch failure and reports it as an alert', async () => {
  const products = [
    { supplierProductId: 1, supplierProductNo: 'A', sourceMarket: 'domeme' },
    { supplierProductId: 2, supplierProductNo: 'B', sourceMarket: 'domeme' },
  ];
  const results = await runSupplierMonitorSweep({}, {}, {
    listMonitorableSupplierProductsImpl: async () => products,
    checkSupplierProductImpl: async (db, client, product) => {
      if (product.supplierProductNo === 'A') throw new Error('network timeout');
      return { supplierProductId: product.supplierProductId, supplierProductNo: product.supplierProductNo, alerts: [] };
    },
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].alerts[0].code, 'SUPPLIER_FETCH_ERROR');
  assert.equal(results[0].error, 'network timeout');
  assert.equal(results[1].supplierProductNo, 'B');
});
