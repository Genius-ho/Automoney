import assert from 'node:assert/strict';
import test from 'node:test';

import { insertLinkAnalysisHistory, listLinkAnalysisHistory } from '../src/link-analysis-history-store.mjs';

function fakeDb(rows) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows };
    },
  };
}

test('insertLinkAnalysisHistory inserts one row per result and returns [] for an empty/missing list', async () => {
  assert.deepEqual(await insertLinkAnalysisHistory(fakeDb([]), []), []);
  assert.deepEqual(await insertLinkAnalysisHistory(fakeDb([]), undefined), []);
});

test('insertLinkAnalysisHistory serializes scoreBreakdown as jsonb params, defaults missing fields, and maps the returned row back to camelCase', async () => {
  const db = fakeDb([{
    id: 5,
    supplier_product_no: '1',
    name: 'A',
    score: '70.5',
    score_breakdown: { profitMargin: { points: 10, max: 15, reason: 'x' } },
    filter_status: 'pass',
    source_market: 'domeme',
    coupang_sale_price: '10000',
    coupang_expected_profit: '2000',
    keyword: '여성 벨트',
    source: 'link_input',
    analyzed_at: '2026-08-22T00:00:00.000Z',
  }]);

  const inserted = await insertLinkAnalysisHistory(db, [{
    supplierProductNo: '1',
    name: 'A',
    score: 70.5,
    scoreBreakdown: { profitMargin: { points: 10, max: 15, reason: 'x' } },
    filterStatus: 'pass',
    sourceMarket: 'domeme',
    coupangSalePrice: 10000,
    coupangExpectedProfit: 2000,
    keyword: '여성 벨트',
    source: 'link_input',
  }]);

  assert.equal(db.queries.length, 1);
  assert.deepEqual(db.queries[0].params, ['1', 'A', 70.5, JSON.stringify({ profitMargin: { points: 10, max: 15, reason: 'x' } }), 'pass', 'domeme', 10000, 2000, '여성 벨트', 'link_input']);
  assert.deepEqual(inserted, [{
    id: 5,
    supplierProductNo: '1',
    name: 'A',
    score: 70.5,
    scoreBreakdown: { profitMargin: { points: 10, max: 15, reason: 'x' } },
    filterStatus: 'pass',
    sourceMarket: 'domeme',
    coupangSalePrice: 10000,
    coupangExpectedProfit: 2000,
    keyword: '여성 벨트',
    source: 'link_input',
    analyzedAt: '2026-08-22T00:00:00.000Z',
  }]);
});

test('insertLinkAnalysisHistory defaults source to link_input and nulls out unset optional fields', async () => {
  const db = fakeDb([{ id: 1, supplier_product_no: '1', name: null, score: null, score_breakdown: {}, filter_status: null, source_market: null, coupang_sale_price: null, coupang_expected_profit: null, keyword: null, source: 'link_input', analyzed_at: '2026-08-22T00:00:00.000Z' }]);
  await insertLinkAnalysisHistory(db, [{ supplierProductNo: '1' }]);
  assert.deepEqual(db.queries[0].params, ['1', null, null, '{}', null, null, null, null, null, 'link_input']);
});

test('listLinkAnalysisHistory queries most-recent-first with limit/offset and maps rows back to camelCase', async () => {
  const db = fakeDb([{
    id: 5, supplier_product_no: '1', name: 'A', score: '70.5', score_breakdown: {}, filter_status: 'pass',
    source_market: 'domeme', coupang_sale_price: '10000', coupang_expected_profit: '2000', keyword: '벨트',
    source: 'link_input', analyzed_at: '2026-08-22T00:00:00.000Z',
  }]);

  const history = await listLinkAnalysisHistory(db, { limit: 20, offset: 10 });

  assert.match(db.queries[0].sql, /order by analyzed_at desc/);
  assert.deepEqual(db.queries[0].params, [20, 10]);
  assert.equal(history[0].id, 5);
  assert.equal(history[0].score, 70.5);
  assert.equal(history[0].keyword, '벨트');
});

test('listLinkAnalysisHistory defaults to limit 50, offset 0', async () => {
  const db = fakeDb([]);
  await listLinkAnalysisHistory(db);
  assert.deepEqual(db.queries[0].params, [50, 0]);
});
