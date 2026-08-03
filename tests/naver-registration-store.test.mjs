import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeNaverSpeedgoRegistration,
  getNaverRegistration,
  recordImagesSwapped,
  recordNaverDirectRegistration,
  reserveNaverSpeedgoRegistration,
} from '../src/naver-registration-store.mjs';

test('reserveNaverSpeedgoRegistration inserts one submitting speedgo row', async () => {
  const db = { async query(sql, params) {
    assert.match(sql, /'submitting'/);
    assert.match(sql, /'speedgo_automation'/);
    assert.deepEqual(params, [501, 'hash-1']);
    return { rows: [{ product_draft_id: 501, request_hash: 'hash-1', status: 'submitting', linked_via: 'speedgo_automation' }] };
  } };
  const result = await reserveNaverSpeedgoRegistration(db, 501, { requestHash: 'hash-1' });
  assert.equal(result.action, 'reserved');
  assert.equal(result.registration.status, 'submitting');
});

test('reserveNaverSpeedgoRegistration reports an existing linked row', async () => {
  let queryCount = 0;
  const db = { async query(sql, params) {
    queryCount += 1;
    if (queryCount === 1) return { rows: [] };
    assert.match(sql, /select \* from naver_product_registrations/);
    assert.deepEqual(params, [501]);
    return { rows: [{ product_draft_id: 501, origin_product_no: '7777777777', status: 'created', linked_via: 'speedgo_automation' }] };
  } };
  const result = await reserveNaverSpeedgoRegistration(db, 501, { requestHash: 'hash-1' });
  assert.equal(result.action, 'already_linked');
  assert.equal(result.registration.originProductNo, '7777777777');
});

test('reserveNaverSpeedgoRegistration recovers a same-hash submitting row', async () => {
  let queryCount = 0;
  const db = { async query(sql, params) {
    queryCount += 1;
    if (queryCount === 1) return { rows: [] };
    return { rows: [{ product_draft_id: 501, request_hash: 'hash-1', status: 'submitting', linked_via: 'speedgo_automation' }] };
  } };
  const result = await reserveNaverSpeedgoRegistration(db, 501, { requestHash: 'hash-1' });
  assert.equal(result.action, 'recover');
  assert.equal(result.registration.requestHash, 'hash-1');
});

test('reserveNaverSpeedgoRegistration reports a different-hash conflict without modifying it', async () => {
  let queryCount = 0;
  const db = { async query(sql, params) {
    queryCount += 1;
    if (queryCount === 1) return { rows: [] };
    return { rows: [{ product_draft_id: 501, request_hash: 'hash-other', status: 'submitting', linked_via: 'speedgo_automation' }] };
  } };
  const result = await reserveNaverSpeedgoRegistration(db, 501, { requestHash: 'hash-1' });
  assert.equal(result.action, 'conflict');
  assert.equal(result.registration.requestHash, 'hash-other');
});

test('completeNaverSpeedgoRegistration stores verified ids only on the matching reservation', async () => {
  const db = { async query(sql, params) {
    assert.match(sql, /status = 'created'/);
    assert.match(sql, /status = 'submitting'/);
    assert.match(sql, /linked_via = 'speedgo_automation'/);
    assert.deepEqual(params, [501, 'hash-1', '7777777777', '8888888888']);
    return { rows: [{ product_draft_id: 501, origin_product_no: '7777777777', channel_product_no: '8888888888', status: 'created', linked_via: 'speedgo_automation' }] };
  } };
  const result = await completeNaverSpeedgoRegistration(db, 501, {
    requestHash: 'hash-1', originProductNo: '7777777777', channelProductNo: '8888888888',
  });
  assert.equal(result.originProductNo, '7777777777');
  assert.equal(result.status, 'created');
});

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
