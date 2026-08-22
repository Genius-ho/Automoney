import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createOrderException,
  getOrderException,
  resolveOrderException,
  listOrderExceptionsForAdmin,
} from '../src/order-exception-store.mjs';

function fakeRow(overrides = {}) {
  return {
    id: '1', channel_order_id: '10', supplier_order_id: '5', exception_type: 'CANCEL_NOT_SHIPPED',
    status: 'open', detail: {}, resolution_note: null, resolved_at: null,
    created_at: 't1', updated_at: 't2',
    ...overrides,
  };
}

test('createOrderException upserts on the open-per-channel-order partial unique index', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow()] }; } };
  const result = await createOrderException(db, { channelOrderId: 10, supplierOrderId: 5, exceptionType: 'CANCEL_NOT_SHIPPED', detail: { a: 1 } });
  assert.match(captured.sql, /on conflict \(channel_order_id\) where status = 'open' do update/);
  assert.deepEqual(captured.params, [10, 5, 'CANCEL_NOT_SHIPPED', '{"a":1}']);
  assert.equal(result.exceptionType, 'CANCEL_NOT_SHIPPED');
  assert.equal(result.status, 'open');
});

test('getOrderException returns null when not found', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getOrderException(db, 999), null);
});

test('resolveOrderException sets status=resolved and stores the resolution note', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow({ status: 'resolved', resolution_note: '공급처 취소 완료' })] }; } };
  const result = await resolveOrderException(db, 1, { resolutionNote: '공급처 취소 완료' });
  assert.match(captured.sql, /status = 'resolved'/);
  assert.deepEqual(captured.params, [1, '공급처 취소 완료']);
  assert.equal(result.status, 'resolved');
});

test('listOrderExceptionsForAdmin joins channel_orders and supplier_orders for display', async () => {
  let captured;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [fakeRow({ channel: 'coupang', channel_order_id: '22000009546234', recipient_name: '김철수', domeme_order_no: '73002356', tracking_number: '255593464954' })] };
    },
  };
  const rows = await listOrderExceptionsForAdmin(db, { status: 'open' });
  assert.match(captured.sql, /join channel_orders co on co\.id = oe\.channel_order_id/);
  assert.match(captured.sql, /where oe\.status = \$1/);
  assert.equal(rows[0].channel, 'coupang');
  assert.equal(rows[0].domemeOrderNo, '73002356');
  assert.equal(rows[0].recipientName, '김철수');
});
