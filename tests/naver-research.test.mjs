import assert from 'node:assert/strict';
import test from 'node:test';

import { NaverShoppingClient, summarizeShoppingSearch } from '../src/naver-shopping-client.mjs';
import { calculateNaverWinnerScore, checkNaverCompetitionLive } from '../src/naver-research.mjs';

test('NaverShoppingClient calls shopping search API with required headers and params', async () => {
  const calls = [];
  const client = new NaverShoppingClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ total: 1, items: [{ title: '<b>item</b>', mallName: 'mall', link: 'https://example.test', lprice: '1000' }] });
        },
      };
    },
  });

  await client.searchShop({ query: 'storage' });

  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://openapi.naver.com/v1/search/shop.json');
  assert.equal(url.searchParams.get('query'), 'storage');
  assert.equal(url.searchParams.get('display'), '20');
  assert.equal(url.searchParams.get('start'), '1');
  assert.equal(url.searchParams.get('sort'), 'sim');
  assert.equal(url.searchParams.get('exclude'), 'used:rental:cbshop');
  assert.equal(calls[0].options.headers['X-Naver-Client-Id'], 'client-id');
  assert.equal(calls[0].options.headers['X-Naver-Client-Secret'], 'client-secret');
});

test('summarizeShoppingSearch calculates lowest price, average, count, gap, and best item', () => {
  const summary = summarizeShoppingSearch(
    {
      total: 123,
      items: [
        { title: '<b>high</b>', mallName: 'A', link: 'https://a.test', lprice: '12000' },
        { title: '<b>low</b>', mallName: 'B', link: 'https://b.test', lprice: '10000' },
        { title: 'zero', mallName: 'C', link: 'https://c.test', lprice: '0' },
      ],
    },
    10500,
  );

  assert.equal(summary.competitorCount, 123);
  assert.equal(summary.lowestPrice, 10000);
  assert.equal(summary.topPriceAvg, 11000);
  assert.equal(summary.priceGapRate, 0.05);
  assert.deepEqual(summary.bestItem, {
    title: 'low',
    mallName: 'B',
    link: 'https://b.test',
    lprice: 10000,
  });
});

test('calculateNaverWinnerScore handles candidate and reject scoring', () => {
  const good = calculateNaverWinnerScore({
    mySalePrice: 10000,
    lowestPrice: 10000,
    competitorCount: 10,
    expectedProfit: 3500,
  });
  const bad = calculateNaverWinnerScore({
    mySalePrice: 12000,
    lowestPrice: 10000,
    competitorCount: 1000,
    expectedProfit: 1000,
  });

  assert.equal(good.winnerStatus, 'candidate');
  assert.equal(good.winnerScore, 110);
  assert.equal(bad.winnerStatus, 'reject');
  assert.equal(bad.winnerScore, -25);
});

// 2026-08-22 added so the "링크 입력" quick preview's naverCompetition
// dimension (previously always "데이터 없음") can be filled from a real,
// unsaved search -- researchNaverDraft can't be reused here because
// market_research_results.product_draft_id is a not-null FK and this runs
// before any draft exists. No persistence happens; it's just
// searchShop + summarizeShoppingSearch, returned directly.
test('checkNaverCompetitionLive searches by keyword and returns competitorCount/priceGapRate from the live summary, without persisting anything', async () => {
  let receivedQuery = null;
  const client = { searchShop: async ({ query }) => { receivedQuery = query; return { total: 42, items: [{ lprice: '9500', title: 'A', mallName: 'M', link: 'l' }] }; } };
  const result = await checkNaverCompetitionLive(client, '여성 벨트', 10000);

  assert.equal(receivedQuery, '여성 벨트');
  assert.equal(result.competitorCount, 42);
  assert.equal(result.lowestPrice, 9500);
  assert.ok(result.priceGapRate > 0 && result.priceGapRate < 0.1);
});

test('checkNaverCompetitionLive propagates a search failure (callers like product-link-analysis.mjs are responsible for catching and falling back)', async () => {
  const client = { searchShop: async () => { throw new Error('Naver Shopping API failed: HTTP 404'); } };
  await assert.rejects(() => checkNaverCompetitionLive(client, '여성 벨트', 10000), /HTTP 404/);
});
