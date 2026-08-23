import assert from 'node:assert/strict';
import test from 'node:test';

import { NaverShoppingClient, summarizeShoppingSearch } from '../src/naver-shopping-client.mjs';
import { calculateNaverWinnerScore, checkNaverTrendLive } from '../src/naver-research.mjs';

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

// 2026-08-22: naverCompetition(경쟁상품수/가격격차)은 개발자센터 쇼핑검색
// API가 2026-07-31에 대체재 없이 완전히 종료돼서 폐기됐다 (공식 공지 확인,
// checkNaverCompetitionLive/NaverShoppingClient.searchShop도 그 API에
// 의존했으므로 함께 죽음). 대신 NAVER API HUB 쇼핑 인사이트(월별 클릭
// ratio)로 "꾸준히 높은지" + "최근 상승 추세인지" 두 신호를 계산한다 --
// researchNaverDraft처럼 저장하지 않고 draft 없이 바로 쓸 수 있다.
test('checkNaverTrendLive queries a monthsBack window ending at `now` and returns avgRatio/growthRate from the monthly ratio series', async () => {
  let receivedArgs = null;
  const client = { clientId: 'id', clientSecret: 'secret' };
  const result = await checkNaverTrendLive(client, '여성 벨트', '50000000', {
    now: new Date('2026-08-22'),
    monthsBack: 4,
    fetchShoppingKeywordTrendImpl: async (c, args) => {
      receivedArgs = args;
      return { results: [{ title: '여성 벨트', keyword: ['여성 벨트'], data: [
        { period: '2026-04-01', ratio: 20 },
        { period: '2026-05-01', ratio: 30 },
        { period: '2026-06-01', ratio: 60 },
        { period: '2026-07-01', ratio: 90 },
      ] }] };
    },
  });

  assert.equal(receivedArgs.keyword, '여성 벨트');
  assert.equal(receivedArgs.category, '50000000');
  assert.equal(receivedArgs.timeUnit, 'month');
  assert.equal(receivedArgs.startDate, '2026-04-22');
  assert.equal(receivedArgs.endDate, '2026-08-22');
  assert.equal(result.months, 4);
  assert.equal(result.avgRatio, 50); // (20+30+60+90)/4
  // early half avg (20+30)/2=25, recent half avg (60+90)/2=75 -> +200% growth
  assert.equal(result.growthRate, 2);
  // only 4 months back -- no 작년 동일시기 data to compute seasonalGrowth from
  assert.equal(result.seasonalGrowth, null);
});

// 2026-08-23 사용자 지적: 10개월 전과 12개월 전은 정확히 "지금부터 2달 뒤"와
// "지금"의 작년 같은 달이다 (10 = 12 - 2) -- momentum 근사치보다 계절성이
// 더 직접적인 힌트. monthsBack이 13개월 이상이면 이 두 지점의 실측 성장률을
// seasonalGrowth로 계산한다.
test('checkNaverTrendLive computes seasonalGrowth from the same calendar months one year ago (now-12 vs now-10, i.e. "now" and "2 months from now")', async () => {
  const result = await checkNaverTrendLive({}, '여성 벨트', '50000000', {
    now: new Date('2026-08-22'),
    fetchShoppingKeywordTrendImpl: async () => ({ results: [{ title: '여성 벨트', keyword: ['여성 벨트'], data: [
      { period: '2025-08-01', ratio: 40 }, // now-12 (작년 이맘때 = "지금"의 작년 동월)
      { period: '2025-09-01', ratio: 50 },
      { period: '2025-10-01', ratio: 80 }, // now-10 (작년의 "2달 뒤"에 해당하는 달)
      { period: '2025-11-01', ratio: 50 },
      { period: '2025-12-01', ratio: 50 },
      { period: '2026-01-01', ratio: 50 },
      { period: '2026-02-01', ratio: 50 },
      { period: '2026-03-01', ratio: 20 },
      { period: '2026-04-01', ratio: 30 },
      { period: '2026-05-01', ratio: 30 },
      { period: '2026-06-01', ratio: 60 },
      { period: '2026-07-01', ratio: 90 },
      { period: '2026-08-01', ratio: 90 },
    ] }] }),
  });

  // seasonalGrowth = (80-40)/40 = +100%
  assert.equal(result.seasonalGrowth, 1);
  // avgRatio/growthRate are still derived from only the most recent 6 months
  // (2026-03 ~ 2026-08), unaffected by the extra year of history fetched
  assert.equal(result.months, 6);
  assert.equal(result.avgRatio, (20 + 30 + 30 + 60 + 90 + 90) / 6);
  assert.ok(Math.abs(result.growthRate - 2) < 1e-9);
});

test('checkNaverTrendLive leaves seasonalGrowth null when only one of the two year-ago anchor months has data', async () => {
  const result = await checkNaverTrendLive({}, 'x', 'y', {
    now: new Date('2026-08-22'),
    fetchShoppingKeywordTrendImpl: async () => ({ results: [{ title: 'x', keyword: ['x'], data: [
      { period: '2025-10-01', ratio: 80 }, // now-10 present
      { period: '2026-08-01', ratio: 90 }, // now-12 (2025-08) missing
    ] }] }),
  });
  assert.equal(result.seasonalGrowth, null);
});

test('checkNaverTrendLive returns null (not an error) when the API responds with no data points for the window', async () => {
  const result = await checkNaverTrendLive({}, 'x', 'y', {
    fetchShoppingKeywordTrendImpl: async () => ({ results: [{ title: 'x', keyword: ['x'], data: [] }] }),
  });
  assert.equal(result, null);
});

test('checkNaverTrendLive propagates an API failure (callers like product-link-analysis.mjs are responsible for catching and falling back)', async () => {
  await assert.rejects(
    () => checkNaverTrendLive({}, '여성 벨트', '50000000', {
      fetchShoppingKeywordTrendImpl: async () => { throw new Error('NAVER API HUB request failed: HTTP 401'); },
    }),
    /HTTP 401/,
  );
});
