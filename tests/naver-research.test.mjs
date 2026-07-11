import assert from 'node:assert/strict';
import test from 'node:test';

import { NaverShoppingClient, summarizeShoppingSearch } from '../src/naver-shopping-client.mjs';
import { calculateNaverWinnerScore } from '../src/naver-research.mjs';

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
