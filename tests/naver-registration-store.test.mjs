import assert from 'node:assert/strict';
import test from 'node:test';

import { getNaverRegistration, recordImagesSwapped, recordNaverDirectRegistration } from '../src/naver-registration-store.mjs';

test('getNaverRegistration returns null when no row exists for the draft', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getNaverRegistration(db, 999), null);
});

test('getNaverRegistration maps a found row to camelCase', async () => {
  const db = {
    async query() {
      return { rows: [{ origin_product_no: '7777777777', channel_product_no: '8888888888', status: 'created', created_at: null, updated_at: null }] };
    },
  };
  const result = await getNaverRegistration(db, 501);
  assert.equal(result.productDraftId, 501);
  assert.equal(result.originProductNo, '7777777777');
  assert.equal(result.channelProductNo, '8888888888');
  assert.equal(result.status, 'created');
});

test('recordNaverDirectRegistration requires originProductNo and requestHash', async () => {
  const db = { async query() { return { rows: [] }; } };
  await assert.rejects(() => recordNaverDirectRegistration(db, 501, { requestHash: 'abc' }), /originProductNo is required/);
  await assert.rejects(() => recordNaverDirectRegistration(db, 501, { originProductNo: '123' }), /requestHash is required/);
});

test('recordNaverDirectRegistration inserts with status=created and on-conflict-do-nothing dedup', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /on conflict \(product_draft_id\) do nothing/);
      assert.deepEqual(params, [501, '7777777777', '8888888888', 'hash123']);
      return { rows: [{ origin_product_no: '7777777777', channel_product_no: '8888888888', status: 'created' }] };
    },
  };
  const result = await recordNaverDirectRegistration(db, 501, { originProductNo: '7777777777', channelProductNo: '8888888888', requestHash: 'hash123' });
  assert.equal(result.originProductNo, '7777777777');
  assert.equal(result.status, 'created');
});

test('recordNaverDirectRegistration returns null (not the existing row) when a conflict blocked the insert', async () => {
  const db = { async query() { return { rows: [] }; } };
  const result = await recordNaverDirectRegistration(db, 501, { originProductNo: '123', requestHash: 'hash' });
  assert.equal(result, null);
});

test('recordImagesSwapped sets status=images_swapped and stamps images_swapped_at', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /status = 'images_swapped'/);
      assert.match(sql, /images_swapped_at = now\(\)/);
      assert.deepEqual(params, [501]);
      return { rows: [{ origin_product_no: '7777777777', status: 'images_swapped', images_swapped_at: '2026-07-28T00:00:00.000Z' }] };
    },
  };
  const result = await recordImagesSwapped(db, 501);
  assert.equal(result.status, 'images_swapped');
  assert.equal(result.imagesSwappedAt, '2026-07-28T00:00:00.000Z');
});

test('recordImagesSwapped returns null when no row exists for the draft', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await recordImagesSwapped(db, 999), null);
});
