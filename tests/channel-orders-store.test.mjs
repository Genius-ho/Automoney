import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordChannelOrder,
  listChannelOrders,
  getOrderCollectionState,
  tryAcquireOrderCollectionLock,
  releaseOrderCollectionLock,
} from '../src/channel-orders-store.mjs';

function fakeRow(overrides = {}) {
  return {
    id: '1', channel: 'coupang', channel_order_id: '22000009546234', channel_order_item_id: '64253897:3242596358',
    channel_product_id: '3242596358', option_info: '블랙', quantity: '1', sale_price: '19900', order_status: 'ACCEPT',
    recipient_name: '홍길동', address: '서울시 강남구', postal_code: '06000', phone: '010-1234-5678',
    delivery_memo: null, ordered_at: '2026-07-25T00:00:00Z', cancelled_at: null,
    supplier_mapping_status: 'mapping_required', supplier_product_id: null,
    created_at: '2026-07-25T00:00:00Z', updated_at: '2026-07-25T00:00:00Z', is_new: true,
    ...overrides,
  };
}

test('recordChannelOrder upserts on (channel, channel_order_item_id) and reports isNew from xmax', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow()] }; } };
  const result = await recordChannelOrder(db, {
    channel: 'coupang', channelOrderId: '22000009546234', channelOrderItemId: '64253897:3242596358',
    channelProductId: '3242596358', optionInfo: '블랙', quantity: 1, salePrice: 19900, orderStatus: 'ACCEPT',
    recipientName: '홍길동', address: '서울시 강남구', postalCode: '06000', phone: '010-1234-5678',
    orderedAt: '2026-07-25T00:00:00Z', rawJson: { a: 1 },
  });
  assert.match(captured.sql, /on conflict \(channel, channel_order_item_id\) do update/);
  assert.equal(result.isNew, true);
  assert.equal(result.channelOrderItemId, '64253897:3242596358');
  assert.equal(result.quantity, 1);
});

test('recordChannelOrder reports isNew=false when the upsert hit an existing row', async () => {
  const db = { async query() { return { rows: [fakeRow({ is_new: false })] }; } };
  const result = await recordChannelOrder(db, { channel: 'coupang', channelOrderId: 'x', channelOrderItemId: 'y' });
  assert.equal(result.isNew, false);
});

test('listChannelOrders filters by channel and supplierMappingStatus when provided', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [fakeRow()] }; } };
  await listChannelOrders(db, { channel: 'coupang', supplierMappingStatus: 'mapping_required' });
  assert.match(captured.sql, /channel = \$1/);
  assert.match(captured.sql, /supplier_mapping_status = \$2/);
  assert.deepEqual(captured.params, ['coupang', 'mapping_required']);
});

test('getOrderCollectionState returns null for an unknown channel', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getOrderCollectionState(db, 'unknown'), null);
});

test('tryAcquireOrderCollectionLock only succeeds when the channel is not already running (WHERE is_running = false)', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [{ channel: 'coupang', last_success_at: null }] }; } };
  const result = await tryAcquireOrderCollectionLock(db, 'coupang');
  assert.match(captured.sql, /where channel = \$1 and is_running = false/);
  assert.equal(result.channel, 'coupang');
});

test('tryAcquireOrderCollectionLock returns null when the channel is already running', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await tryAcquireOrderCollectionLock(db, 'coupang'), null);
});

test('releaseOrderCollectionLock clears is_running and records the success timestamp', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [{ channel: 'coupang', last_success_at: '2026-07-25T00:00:00Z' }] }; } };
  const result = await releaseOrderCollectionLock(db, 'coupang', { successAt: '2026-07-25T00:00:00Z' });
  assert.match(captured.sql, /is_running = false/);
  assert.deepEqual(captured.params, ['coupang', '2026-07-25T00:00:00Z']);
  assert.equal(result.lastSuccessAt, '2026-07-25T00:00:00Z');
});
