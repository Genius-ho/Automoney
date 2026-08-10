import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCoupangRegistration,
  linkCoupangRegistration,
  listCoupangRegistrationsAwaitingTelegramNotification,
  listCoupangRegistrations,
  markCoupangRegistrationTelegramNotified,
  recordApprovalRequested,
  recordImagesSwapped,
  recordLiveSnapshot,
} from '../src/coupang-registration-store.mjs';

test('listCoupangRegistrationsAwaitingTelegramNotification selects only created unrequested unnotified linked rows', async () => {
  let captured;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{
        product_draft_id: '119',
        seller_product_id: '16341358344',
        seller_product_name: 'safe title',
        status: 'created',
        requested: false,
        sale_price: 42140,
        options: [{ name: 'black', stockQuantity: 1 }],
      }] };
    },
  };

  const [row] = await listCoupangRegistrationsAwaitingTelegramNotification(db);

  assert.equal(row.productDraftId, 119);
  assert.equal(row.salePrice, 42140);
  assert.deepEqual(row.options, [{ name: 'black', stockQuantity: 1 }]);
  assert.deepEqual(captured.params, []);
  assert.match(captured.sql, /r\.seller_product_id is not null/);
  assert.match(captured.sql, /r\.status = 'created'/);
  assert.match(captured.sql, /r\.requested = false/);
  assert.match(captured.sql, /r\.telegram_notified_at is null/);
  assert.match(captured.sql, /order by min\(r\.created_at\)/);
});

test('markCoupangRegistrationTelegramNotified stores timestamp and message id', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /telegram_notified_at = now\(\)/);
      assert.match(sql, /telegram_message_id = \$2/);
      assert.deepEqual(params, [119, 987]);
      return { rows: [{ product_draft_id: '119', telegram_notified_at: '2026-08-10T00:00:00Z', telegram_message_id: '987' }] };
    },
  };

  const row = await markCoupangRegistrationTelegramNotified(db, 119, 987);

  assert.equal(row.telegramMessageId, 987);
  assert.equal(row.telegramNotifiedAt, '2026-08-10T00:00:00Z');
});

test('listCoupangRegistrations includes an onlyLinked clause only when requested', async () => {
  const calls = [];
  const db = { async query(sql, params = []) { calls.push({ sql, params }); return { rows: [] }; } };

  await listCoupangRegistrations(db, { onlyLinked: true });
  assert.match(calls[0].sql, /where r\.seller_product_id is not null\s*\n\s*order by/);

  await listCoupangRegistrations(db, {});
  assert.match(calls[1].sql, /where r\.seller_product_id is not null or \(/);
});

test('listCoupangRegistrations maps rows to camelCase', async () => {
  const db = {
    async query() {
      return {
        rows: [{
          product_draft_id: '46',
          selling_title: 'raw title',
          optimized_coupang_title: 'optimized title',
          seller_product_id: '16301910938',
          seller_product_name: '무타공 레일선반',
          linked_via: 'speedgo_lookup',
          status: 'linked',
          requested: false,
          images_swapped_at: null,
          last_synced_at: null,
          live_status_name: null,
          live_total_stock_quantity: null,
          live_sale_price: null,
          approval_requested_at: null,
          approval_response_message: null,
        }],
      };
    },
  };
  const [row] = await listCoupangRegistrations(db);
  assert.deepEqual(row, {
    productDraftId: 46,
    sellingTitle: 'raw title',
    optimizedCoupangTitle: 'optimized title',
    sellerProductId: '16301910938',
    sellerProductName: '무타공 레일선반',
    linkedVia: 'speedgo_lookup',
    status: 'linked',
    requested: false,
    imagesSwappedAt: null,
    lastSyncedAt: null,
    liveStatusName: null,
    liveTotalStockQuantity: null,
    liveSalePrice: null,
    approvalRequestedAt: null,
    approvalResponseMessage: null,
    telegramNotifiedAt: null,
    telegramMessageId: null,
  });
});

test('getCoupangRegistration returns null when no row exists for the draft', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getCoupangRegistration(db, 999), null);
});

test('linkCoupangRegistration requires a sellerProductId and upserts with linked_via=speedgo_lookup', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /on conflict \(product_draft_id\) do update/);
      assert.match(sql, /linked_via = 'speedgo_lookup'/);
      assert.deepEqual(params, [46, '16301910938', '무타공 레일선반', 'speedgo:16301910938']);
      return { rows: [{ product_draft_id: 46, seller_product_id: '16301910938', seller_product_name: '무타공 레일선반', linked_via: 'speedgo_lookup', status: 'linked' }] };
    },
  };
  const result = await linkCoupangRegistration(db, 46, { sellerProductId: '16301910938', sellerProductName: '무타공 레일선반' });
  assert.equal(result.sellerProductId, '16301910938');
  assert.equal(result.linkedVia, 'speedgo_lookup');

  await assert.rejects(() => linkCoupangRegistration(db, 46, {}), /sellerProductId is required/);
});

test('recordImagesSwapped sets status=images_swapped and stamps images_swapped_at', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /status = 'images_swapped', images_swapped_at = now\(\)/);
      assert.deepEqual(params, [46]);
      return { rows: [{ product_draft_id: 46, status: 'images_swapped' }] };
    },
  };
  const result = await recordImagesSwapped(db, 46);
  assert.equal(result.status, 'images_swapped');
});

test('recordLiveSnapshot writes denormalized stock/price/status fields', async () => {
  const db = {
    async query(sql, params) {
      assert.deepEqual(params, [46, '승인완료', 10, 33570, JSON.stringify([{ a: 1 }])]);
      return { rows: [{ product_draft_id: 46, live_status_name: '승인완료', live_total_stock_quantity: 10, live_sale_price: 33570 }] };
    },
  };
  const result = await recordLiveSnapshot(db, 46, { statusName: '승인완료', totalStockQuantity: 10, salePrice: 33570, itemSnapshotJson: [{ a: 1 }] });
  assert.equal(result.liveStatusName, '승인완료');
  assert.equal(result.liveTotalStockQuantity, 10);
});

test('recordApprovalRequested sets status=approval_requested, requested=true, and stamps approval_requested_at', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /status = 'approval_requested'/);
      assert.match(sql, /requested = true/);
      assert.match(sql, /approval_requested_at = now\(\)/);
      assert.deepEqual(params, [27, '{"code":"SUCCESS"}', '승인요청중']);
      return { rows: [{ product_draft_id: 27, status: 'approval_requested', requested: true, live_status_name: '승인요청중', approval_response_message: '{"code":"SUCCESS"}' }] };
    },
  };
  const result = await recordApprovalRequested(db, 27, { statusName: '승인요청중', responseMessage: '{"code":"SUCCESS"}' });
  assert.equal(result.status, 'approval_requested');
  assert.equal(result.requested, true);
  assert.equal(result.liveStatusName, '승인요청중');
  assert.equal(result.approvalResponseMessage, '{"code":"SUCCESS"}');
});
