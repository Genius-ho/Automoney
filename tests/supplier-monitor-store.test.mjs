import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLatestSupplierSnapshot,
  recordSupplierSnapshot,
  listMonitorableSupplierProducts,
} from '../src/supplier-monitor-store.mjs';

test('getLatestSupplierSnapshot returns null when no snapshot exists yet', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getLatestSupplierSnapshot(db, 900), null);
});

test('getLatestSupplierSnapshot maps the most recent row to camelCase', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /order by checked_at desc limit 1/);
      assert.deepEqual(params, [900]);
      return {
        rows: [{
          id: '5', supplier_product_id: '900', supplier_product_no: '49171775',
          unit_cost_price: '9600', shipping_fee: '3000', min_order_qty: '1',
          is_sold_out: false, price_parse_status: 'ok', checked_at: '2026-07-25T00:00:00Z',
        }],
      };
    },
  };
  const result = await getLatestSupplierSnapshot(db, 900);
  assert.equal(result.supplierProductId, 900);
  assert.equal(result.unitCostPrice, 9600);
  assert.equal(result.shippingFee, 3000);
  assert.equal(result.minOrderQty, 1);
  assert.equal(result.isSoldOut, false);
  assert.equal(result.priceParseStatus, 'ok');
});

test('recordSupplierSnapshot inserts a new row with the given values, defaulting missing numbers to null', async () => {
  let captured;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ id: '1', supplier_product_id: '900', supplier_product_no: '49171775', unit_cost_price: null, shipping_fee: null, min_order_qty: null, is_sold_out: true, price_parse_status: 'parsing_error', checked_at: '2026-07-25T00:00:00Z' }] };
    },
  };
  const result = await recordSupplierSnapshot(db, 900, '49171775', { isSoldOut: true, priceParseStatus: 'parsing_error' });
  assert.match(captured.sql, /insert into supplier_snapshots/);
  assert.deepEqual(captured.params, [900, '49171775', null, null, null, true, 'parsing_error']);
  assert.equal(result.isSoldOut, true);
  assert.equal(result.unitCostPrice, null);
});

test('listMonitorableSupplierProducts maps every supplier_products row', async () => {
  const db = {
    async query() {
      return { rows: [{ supplier_product_id: '900', supplier_product_no: '49171775', source_market: 'domeme' }] };
    },
  };
  const result = await listMonitorableSupplierProducts(db);
  assert.deepEqual(result, [{ supplierProductId: 900, supplierProductNo: '49171775', sourceMarket: 'domeme' }]);
});
