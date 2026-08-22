import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDailySummary, formatDailySummaryMessage, sendDailySummary } from '../src/daily-summary.mjs';

function fakeDb(counts) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes('coupang_product_registrations') && sql.includes("linked_via = 'direct_api'")) return { rows: [{ count: counts.coupangRegisteredToday ?? 0 }] };
      if (sql.includes('coupang_product_registrations') && sql.includes('images_swapped_at')) return { rows: [{ count: counts.coupangImagesSwappedToday ?? 0 }] };
      if (sql.includes('naver_product_registrations') && sql.includes("linked_via = 'speedgo_link'")) return { rows: [{ count: counts.naverLinkedToday ?? 0 }] };
      if (sql.includes('naver_product_registrations') && sql.includes('images_swapped_at')) return { rows: [{ count: counts.naverImagesSwappedToday ?? 0 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('buildDailySummary queries KST-day-bounded counts for both channels, registrations and image swaps', async () => {
  const db = fakeDb({ coupangRegisteredToday: 2, coupangImagesSwappedToday: 1, naverLinkedToday: 3, naverImagesSwappedToday: 1 });
  const summary = await buildDailySummary(db);
  assert.deepEqual(summary, { coupangRegisteredToday: 2, coupangImagesSwappedToday: 1, naverLinkedToday: 3, naverImagesSwappedToday: 1 });
  assert.equal(db.queries.length, 4);
  for (const sql of db.queries) assert.match(sql, /at time zone 'Asia\/Seoul'/);
});

test('formatDailySummaryMessage renders every count on its own line with the Korean labels', () => {
  const text = formatDailySummaryMessage({ coupangRegisteredToday: 2, coupangImagesSwappedToday: 0, naverLinkedToday: 1, naverImagesSwappedToday: 4 });
  assert.match(text, /쿠팡 신규 등록\(API\): 2건/);
  assert.match(text, /쿠팡 이미지 교체: 0건/);
  assert.match(text, /네이버 스피드고 연결: 1건/);
  assert.match(text, /네이버 이미지 교체: 4건/);
});

test('sendDailySummary is a no-op when telegram is unconfigured, never touching the db', async () => {
  let dbTouched = false;
  const db = { async query() { dbTouched = true; } };
  const result = await sendDailySummary(db, null);
  assert.equal(result, null);
  assert.equal(dbTouched, false);
});

test('sendDailySummary builds the summary and sends it as one telegram message', async () => {
  const telegramConfig = { botToken: 't', chatId: 'c' };
  const summary = { coupangRegisteredToday: 1, coupangImagesSwappedToday: 2, naverLinkedToday: 0, naverImagesSwappedToday: 0 };
  let sentArgs;
  const result = await sendDailySummary({}, telegramConfig, {
    buildDailySummaryImpl: async () => summary,
    sendTelegramMessageImpl: async (config, text) => { sentArgs = { config, text }; return { message_id: 5 }; },
  });
  assert.equal(sentArgs.config, telegramConfig);
  assert.match(sentArgs.text, /쿠팡 신규 등록\(API\): 1건/);
  assert.deepEqual(result, { message_id: 5 });
});
