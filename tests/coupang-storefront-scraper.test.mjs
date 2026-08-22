import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTitleList,
  pickRandom,
  scoutCategory,
  scoutCoupangCategories,
} from '../src/coupang-storefront-scraper.mjs';

// Real page.evaluate() runs its callback inside the browser against a real
// DOM -- a Node-side fake can't execute that callback meaningfully, so
// instead it hands back pre-scripted results in call order (same limitation
// scripts/crawl-rendered-images.js's page.evaluate-heavy code has: DOM
// heuristics are only verified against the live site, orchestration is
// what's unit tested here).
function fakePage({ evaluateResults = [] } = {}) {
  const gotoUrls = [];
  const evaluateArgs = [];
  const queue = [...evaluateResults];
  let currentUrl = '';
  return {
    async goto(url) {
      gotoUrls.push(url);
      currentUrl = url;
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate(fn, arg) {
      evaluateArgs.push(arg);
      if (queue.length === 0) throw new Error('fakePage.evaluate called more times than scripted results were provided');
      return queue.shift();
    },
    url() {
      return currentUrl;
    },
    _gotoUrls: gotoUrls,
    _evaluateArgs: evaluateArgs,
  };
}

function sixStepResults({ topLinks, subLinks, titles }) {
  return [
    topLinks, // readCategoryLinks (homepage)
    subLinks, // readCategoryLinks (top-level landing page)
    true, // applyPriceFilter
    { found: true, clicked: false }, // ensureRecommendedSort
    undefined, // slowScroll
    titles, // readProductTitles
  ];
}

test('pickRandom is deterministic given an injected rng and picks the last item near rng()=1', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(pickRandom(list, () => 0), 'a');
  assert.equal(pickRandom(list, () => 0.99), 'c');
});

test('pickRandom returns null for an empty or missing list', () => {
  assert.equal(pickRandom([]), null);
  assert.equal(pickRandom(undefined), null);
});

test('buildTitleList trims whitespace, drops near-empty entries, and dedupes exact matches', () => {
  const result = buildTitleList(['  여성 벨트  ', '여성 벨트', '', ' ', 'a', '쿨스카프 여름용']);
  assert.deepEqual(result, ['여성 벨트', '쿨스카프 여름용']);
});

test('buildTitleList caps the result at maxTitles', () => {
  const raw = Array.from({ length: 50 }, (_, i) => `title-${i}`);
  const result = buildTitleList(raw, { maxTitles: 5 });
  assert.equal(result.length, 5);
  assert.deepEqual(result, ['title-0', 'title-1', 'title-2', 'title-3', 'title-4']);
});

test('scoutCategory drills into a random top category then a random sub category, applies the price filter, and returns titles', async () => {
  const topLinks = [{ text: '패션', href: 'https://www.coupang.com/np/categories/1' }];
  const subLinks = [{ text: '가방/잡화', href: 'https://www.coupang.com/np/categories/1/2' }];
  const page = fakePage({
    evaluateResults: sixStepResults({ topLinks, subLinks, titles: ['여성 가죽 벨트', '여성 가죽 벨트', '쿨스카프'] }),
  });

  const result = await scoutCategory({ page, priceMin: 9900, rngImpl: () => 0 });

  assert.deepEqual(page._gotoUrls, [
    'https://www.coupang.com/',
    'https://www.coupang.com/np/categories/1',
    'https://www.coupang.com/np/categories/1/2',
  ]);
  assert.deepEqual(result.categoryPath, ['패션', '가방/잡화']);
  assert.deepEqual(result.titles, ['여성 가죽 벨트', '쿨스카프']);
  assert.equal(page._evaluateArgs[2], 9900, 'the configured price floor must reach applyPriceFilter');
});

test('scoutCategory stops at the top-level category when no deeper sub-nav is found', async () => {
  const topLinks = [{ text: '패션', href: 'https://www.coupang.com/np/categories/1' }];
  const page = fakePage({
    evaluateResults: sixStepResults({ topLinks, subLinks: [], titles: ['컵 수거함'] }),
  });

  const result = await scoutCategory({ page, rngImpl: () => 0 });

  assert.deepEqual(page._gotoUrls, ['https://www.coupang.com/', 'https://www.coupang.com/np/categories/1']);
  assert.deepEqual(result.categoryPath, ['패션']);
});

test('scoutCategory throws NO_CATEGORY_LINKS when the homepage has no category nav to pick from', async () => {
  const page = fakePage({ evaluateResults: [[]] });
  await assert.rejects(
    () => scoutCategory({ page }),
    (error) => error.code === 'NO_CATEGORY_LINKS',
  );
});

test('scoutCoupangCategories launches once, dives `count` categories on the same page, and always closes the browser', async () => {
  const topLinks = [{ text: '패션', href: 'https://www.coupang.com/np/categories/1' }];
  const subLinks = [{ text: '가방/잡화', href: 'https://www.coupang.com/np/categories/1/2' }];
  const page = fakePage({
    evaluateResults: [
      ...sixStepResults({ topLinks, subLinks, titles: ['여성 벨트'] }),
      ...sixStepResults({ topLinks, subLinks, titles: ['컵 수거함'] }),
    ],
  });
  let closed = false;
  let newPageCalls = 0;
  const chromiumImpl = {
    launch: async () => ({
      newPage: async () => { newPageCalls += 1; return page; },
      close: async () => { closed = true; },
    }),
  };

  const results = await scoutCoupangCategories({ chromiumImpl, count: 2, jitterRangeMs: [0, 0], rngImpl: () => 0 });

  assert.equal(newPageCalls, 1, 'should reuse a single page across category dives');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].titles, ['여성 벨트']);
  assert.deepEqual(results[1].titles, ['컵 수거함']);
  assert.equal(closed, true);
});

test('scoutCoupangCategories still closes the browser when a dive throws', async () => {
  const page = fakePage({ evaluateResults: [[]] });
  let closed = false;
  const chromiumImpl = {
    launch: async () => ({
      newPage: async () => page,
      close: async () => { closed = true; },
    }),
  };

  await assert.rejects(() => scoutCoupangCategories({ chromiumImpl, count: 1 }));
  assert.equal(closed, true);
});
