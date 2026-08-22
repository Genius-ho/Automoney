import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSupplierAlert,
  listSupplierAlerts,
  acknowledgeSupplierAlert,
  countOpenSupplierAlerts,
} from '../src/supplier-alert-store.mjs';

function fakeRow(overrides = {}) {
  return {
    id: '1', supplier_product_id: '35', code: 'SUPPLIER_PRICE_INCREASED', message: '공급가 상승: 1700 -> 2200',
    status: 'open', detail: {}, created_at: 't1', acknowledged_at: null,
    ...overrides,
  };
}

test('createSupplierAlert inserts and serializes detail', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow()] }; } };
  const result = await createSupplierAlert(db, { supplierProductId: 35, code: 'SUPPLIER_PRICE_INCREASED', message: '공급가 상승: 1700 -> 2200', detail: { previousValue: 1700, currentValue: 2200 } });
  assert.deepEqual(captured.params, [35, 'SUPPLIER_PRICE_INCREASED', '공급가 상승: 1700 -> 2200', '{"previousValue":1700,"currentValue":2200}']);
  assert.equal(result.code, 'SUPPLIER_PRICE_INCREASED');
});

test('listSupplierAlerts joins supplier_products and filters by status', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ supplier_product_no: '50307216' })] }; } };
  const alerts = await listSupplierAlerts(db, { status: 'open' });
  assert.match(captured.sql, /join supplier_products sp on sp\.id = sa\.supplier_product_id/);
  assert.deepEqual(captured.params, ['open']);
  assert.equal(alerts[0].supplierProductNo, '50307216');
});

test('acknowledgeSupplierAlert sets status=acknowledged', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ status: 'acknowledged' })] }; } };
  const result = await acknowledgeSupplierAlert(db, 1);
  assert.match(captured.sql, /status = 'acknowledged'/);
  assert.equal(result.status, 'acknowledged');
});

test('countOpenSupplierAlerts returns a number', async () => {
  const db = { async query() { return { rows: [{ count: '3' }] }; } };
  assert.equal(await countOpenSupplierAlerts(db), 3);
});
