import assert from 'node:assert/strict';
import test from 'node:test';

import {
  upsertSupplierOrderDraft,
  listSupplierOrders,
  listSupplierOrdersForAdmin,
  getSupplierOrder,
  getSupplierOrderByChannelOrderId,
  markSupplierOrdering,
  recordSupplierOrderSuccess,
  recordSupplierOrderFailure,
  recordSupplierOrderCancellation,
  getDraftOrderingContext,
  listOrderedWithoutTracking,
  recordSupplierShipment,
  recordChannelShipmentResult,
  listShippedNotDispatched,
  listSupplierOrdersAwaitingTelegramNotification,
  markSupplierOrderTelegramNotified,
} from '../src/purchase-order-store.mjs';

function fakeRow(overrides = {}) {
  return {
    id: '1', channel_order_id: '10', product_draft_id: '46', supplier_product_id: '900',
    status: 'validating_supplier', block_reasons: [], supplier_option_code: null,
    supplier_order_qty: null, sale_qty: null, sale_price: null, supplier_unit_price: null,
    supplier_shipping_fee: null, estimated_profit: null, supplier_checked_at: null,
    domeme_order_no: null, domeme_order_uid: null, approved_at: null, ordered_at: null,
    failure_message: null, created_at: 't1', updated_at: 't2',
    ...overrides,
  };
}

test('upsertSupplierOrderDraft inserts with the status-guard CASE and serializes block_reasons', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ status: 'awaiting_purchase_approval', block_reasons: [] })] }; } };
  const result = await upsertSupplierOrderDraft(db, {
    channelOrderId: 10, productDraftId: 46, supplierProductId: 900, status: 'awaiting_purchase_approval',
    blockReasons: [], supplierOptionCode: '00', supplierOrderQty: 2, saleQty: 1, salePrice: 19900,
    supplierUnitPrice: 9800, supplierShippingFee: 3000, estimatedProfit: 900,
  });
  assert.match(captured.sql, /on conflict \(channel_order_id\) do update/);
  assert.match(captured.sql, /when supplier_orders\.status in \('supplier_ordering', 'supplier_ordered'\)/);
  assert.equal(captured.params[4], '[]');
  assert.equal(result.status, 'awaiting_purchase_approval');
});

test('listSupplierOrders filters by status when provided', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow()] }; } };
  await listSupplierOrders(db, { status: 'validating_supplier' });
  assert.match(captured.sql, /where status = \$1/);
  assert.deepEqual(captured.params, ['validating_supplier']);
});

test('recordSupplierOrderCancellation sets a terminal status=cancelled, distinct from recordSupplierOrderFailure', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ status: 'cancelled', failure_message: '채널 취소' })] }; } };
  const result = await recordSupplierOrderCancellation(db, 1, { note: '채널 취소' });
  assert.match(captured.sql, /status = 'cancelled'/);
  assert.deepEqual(captured.params, [1, '채널 취소']);
  assert.equal(result.status, 'cancelled');
});

test('listSupplierOrdersForAdmin joins channel_orders and supplier_products for the 13.4 발주안 screen', async () => {
  let captured;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return {
        rows: [fakeRow({
          channel: 'coupang', channel_order_id: '22000009546234', option_info: '블랙', recipient_name: '김철수',
          address: '서울시 강남구', postal_code: '06000', phone: '010-1234-5678', order_status: 'ACCEPT',
          supplier_product_no: '40170547',
        })],
      };
    },
  };
  const rows = await listSupplierOrdersForAdmin(db, { status: 'awaiting_purchase_approval' });
  assert.match(captured.sql, /join channel_orders co on co\.id = so\.channel_order_id/);
  assert.match(captured.sql, /where so\.status = \$1/);
  assert.equal(rows[0].channel, 'coupang');
  assert.equal(rows[0].supplierProductNo, '40170547');
  assert.equal(rows[0].recipientName, '김철수');
});

test('getSupplierOrder and getSupplierOrderByChannelOrderId return null when nothing matches', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getSupplierOrder(db, 1), null);
  assert.equal(await getSupplierOrderByChannelOrderId(db, 1), null);
});

test('markSupplierOrdering only transitions rows currently awaiting_purchase_approval', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ status: 'supplier_ordering' })] }; } };
  const result = await markSupplierOrdering(db, 1);
  assert.match(captured.sql, /where id = \$1 and status = 'awaiting_purchase_approval'/);
  assert.equal(result.status, 'supplier_ordering');
});

test('recordSupplierOrderSuccess stores the domeme order number and clears any prior failure message', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ status: 'supplier_ordered', domeme_order_no: '14207678' })] }; } };
  const result = await recordSupplierOrderSuccess(db, 1, { domemeOrderNo: '14207678' });
  assert.deepEqual(captured.params, [1, '14207678', null]);
  assert.equal(result.status, 'supplier_ordered');
  assert.equal(result.domemeOrderNo, '14207678');
});

test('recordSupplierOrderFailure falls back to validating_supplier (not a terminal state)', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ status: 'validating_supplier', failure_message: 'TOO_LESS_EMONEY_ERROR' })] }; } };
  const result = await recordSupplierOrderFailure(db, 1, { failureMessage: 'TOO_LESS_EMONEY_ERROR' });
  assert.match(captured.sql, /status = 'validating_supplier'/);
  assert.equal(result.status, 'validating_supplier');
  assert.equal(result.failureMessage, 'TOO_LESS_EMONEY_ERROR');
});

test('getDraftOrderingContext joins product_drafts to supplier_products and maps every stored option', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('from product_drafts'))
        return { rows: [{ supplier_product_id: '900', bundle_quantity: '2', min_order_qty: '1', unit_cost_price: '9800', sell_unit_type: 'single', supplier_product_no: '40170547', source_market: 'domeme' }] };
      return { rows: [{ name: '색상', value: '화이트+고정클립', option_code: '00', stock_quantity: '30', additional_price: '0' }] };
    },
  };
  const context = await getDraftOrderingContext(db, 115);
  assert.equal(context.supplierProductNo, '40170547');
  assert.equal(context.bundleQuantity, 2);
  assert.deepEqual(context.options, [{ name: '색상', value: '화이트+고정클립', optionCode: '00', stockQuantity: 30, additionalPrice: 0 }]);
});

test('getDraftOrderingContext returns null when the draft does not exist', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getDraftOrderingContext(db, 999), null);
});

test('listOrderedWithoutTracking only selects supplier_ordered rows with no tracking_number yet', async () => {
  let captured;
  const db = { async query(sql) { captured = sql; return { rows: [fakeRow({ status: 'supplier_ordered' })] }; } };
  const rows = await listOrderedWithoutTracking(db);
  assert.match(captured, /status = 'supplier_ordered' and tracking_number is null/);
  assert.equal(rows[0].status, 'supplier_ordered');
});

test('recordSupplierShipment stores carrier/tracking info', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ carrier_code: 'HYUNDAI', carrier_name: '롯데택배', tracking_number: '255593464954' })] }; } };
  const result = await recordSupplierShipment(db, 1, { carrierCode: 'HYUNDAI', carrierName: '롯데택배', trackingNumber: '255593464954' });
  assert.deepEqual(captured.params, [1, 'HYUNDAI', '롯데택배', '255593464954', null]);
  assert.equal(result.carrierName, '롯데택배');
});

test('listShippedNotDispatched selects shipments with tracking that have not been sent to a channel yet', async () => {
  let captured;
  const db = { async query(sql) { captured = sql; return { rows: [fakeRow({ tracking_number: '255593464954', channel_ship_status: 'mapping_failed' })] }; } };
  const rows = await listShippedNotDispatched(db);
  assert.match(captured, /tracking_number is not null and channel_ship_status <> 'sent'/);
  assert.equal(rows[0].channelShipStatus, 'mapping_failed');
});

test('listSupplierOrdersAwaitingTelegramNotification selects only awaiting_purchase_approval rows never notified', async () => {
  let captured;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [fakeRow({ status: 'awaiting_purchase_approval', channel: 'coupang', channel_order_id: '22000009546234', option_info: '블랙' })] };
    },
  };
  const rows = await listSupplierOrdersAwaitingTelegramNotification(db);
  assert.match(captured.sql, /so\.status = 'awaiting_purchase_approval' and so\.telegram_notified_at is null/);
  assert.equal(rows[0].channel, 'coupang');
  assert.equal(rows[0].optionInfo, '블랙');
});

test('markSupplierOrderTelegramNotified sets telegram_notified_at', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ status: 'awaiting_purchase_approval' })] }; } };
  await markSupplierOrderTelegramNotified(db, 1);
  assert.match(captured.sql, /set telegram_notified_at = now\(\)/);
  assert.deepEqual(captured.params, [1]);
});

test('recordChannelShipmentResult only sets channel_shipped_at when the status is "sent"', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ channel_ship_status: 'mapping_failed' })] }; } };
  await recordChannelShipmentResult(db, 1, { channelShipStatus: 'mapping_failed', channelShipError: 'unmapped carrier CUSTOM_CODE' });
  assert.match(captured.sql, /channel_shipped_at = case when \$3 = 'sent' then now\(\) else channel_shipped_at end/);
  assert.deepEqual(captured.params, [1, null, 'mapping_failed', 'unmapped carrier CUSTOM_CODE']);
});
