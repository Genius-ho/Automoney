import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOptimizedTitles,
  buildRegistrationOptimization,
  cleanSourceTitle,
  extractLeadingSupplierLabels,
  scoreKeywords,
} from '../src/registration-optimization.mjs';

test('extractLeadingSupplierLabels pulls any leading bracket label, not a hardcoded brand list', () => {
  assert.deepEqual(
    extractLeadingSupplierLabels('[쓰러담아] 주얼리 보석함 3단 주얼리함'),
    { labels: ['쓰러담아'], remainder: '주얼리 보석함 3단 주얼리함' },
  );
  assert.deepEqual(
    extractLeadingSupplierLabels('[어떤새로운공급처] 처음 보는 브랜드 상품명'),
    { labels: ['어떤새로운공급처'], remainder: '처음 보는 브랜드 상품명' },
  );
  assert.deepEqual(
    extractLeadingSupplierLabels('[공급처][이벤트] 상품명'),
    { labels: ['공급처', '이벤트'], remainder: '상품명' },
  );
  assert.deepEqual(
    extractLeadingSupplierLabels('브랜드 표기 없는 상품명'),
    { labels: [], remainder: '브랜드 표기 없는 상품명' },
  );
});

test('cleanSourceTitle removes a supplied supplier label in both bracketed and bare form', () => {
  assert.equal(
    cleanSourceTitle('쓰러담아 협력사 주얼리 보석함 [쓰러담아] 수납함', ['쓰러담아']),
    '협력사 주얼리 보석함 수납함',
  );
  assert.equal(cleanSourceTitle('당일출고 특가 무료배송 실속형 정리함'), '실속형 정리함');
  assert.equal(cleanSourceTitle('실속형특가정리함'), '실속형특가정리함', 'must not strip noise words embedded inside a longer token');
});

test('scoreKeywords ranks by how many distinct listings use a word, not raw repeat count', () => {
  const scored = scoreKeywords([
    '보석함 수납함',
    '보석함 정리함',
    '보석함 정리함 정리함 정리함',
  ]);
  const byKeyword = Object.fromEntries(scored.map((entry) => [entry.keyword, entry]));
  assert.equal(byKeyword.보석함.documentFrequency, 3);
  assert.equal(byKeyword.보석함.score, 1);
  assert.equal(byKeyword.정리함.documentFrequency, 2);
  assert.ok(byKeyword.정리함.score < byKeyword.보석함.score);
  assert.equal(byKeyword.수납함.documentFrequency, 1);
});

test('scoreKeywords excludes supplier labels, stopwords, short tokens, and pure digits', () => {
  const scored = scoreKeywords(['쓰러담아 및 겸용 1 ab 정리함 0.1'], ['쓰러담아']);
  const keywords = scored.map((entry) => entry.keyword);
  assert.ok(!keywords.includes('쓰러담아'));
  assert.ok(!keywords.includes('및'));
  assert.ok(!keywords.includes('겸용'));
  assert.ok(!keywords.includes('1'));
  assert.ok(keywords.includes('정리함'));
});

test('buildOptimizedTitles never reintroduces a removed supplier label', () => {
  const result = buildOptimizedTitles({
    draft: { sellUnitType: 'single' },
    selectedKeywords: ['악세사리', '주얼리함', '보석함', '수납함', '주얼리', '3단'],
    baseKeyword: '주얼리 보석함 3단 주얼리함 악세사리 보관 서랍 수납함',
    removedSupplierLabels: ['쓰러담아'],
  });
  assert.doesNotMatch(result.coupangTitle, /쓰러담아/);
  assert.doesNotMatch(result.naverTitle, /쓰러담아/);
});

function draft64LikeContext() {
  const draft = {
    sellingTitle: '[쓰러담아] 주얼리 보석함 3단 주얼리함 악세사리 보관 서랍 수납함',
    rawName: '[쓰러담아] 주얼리 보석함 3단 주얼리함 악세사리 보관 서랍 수납함',
    supplierMarket: 'domeme',
    supplierProductNo: 'DOM-1',
    sellUnitType: 'single',
    options: [],
    images: [],
    categoryText: '',
  };
  const naverResearch = {
    lowestPrice: 19000,
    competitorCount: 4,
    raw: {
      searchRaw: {
        total: 4,
        items: [
          { title: '쓰러담아 주얼리 보석함 3단 주얼리함 악세사리 보관 서랍 수납함' },
          { title: '쓰러담아 주얼리 보석함 3단 주얼리함 악세사리 보관 서랍 수납함' },
          { title: '[쓰러담아] 주얼리 보석함 3단 주얼리함 악세사리 보관 서랍 수납함' },
          { title: '쓰러담아 협력사 주얼리 보석함 3단 주얼리함 악세사리 보관 서랍 주얼리보관함 0.1 수납함' },
        ],
      },
    },
  };
  return { draft, naverResearch };
}

test('a previous seller label like [쓰러담아] no longer survives into keywords or optimized titles', () => {
  const { draft, naverResearch } = draft64LikeContext();
  const optimization = buildRegistrationOptimization({ draft, naverResearch });

  assert.deepEqual(optimization.seo.removedSupplierLabels, ['쓰러담아']);
  assert.doesNotMatch(optimization.seo.baseKeyword, /쓰러담아/);
  assert.ok(!optimization.seo.generatedKeywords.includes('쓰러담아'));
  assert.ok(!optimization.seo.generatedKeywords.includes('[쓰러담아]'));
  assert.doesNotMatch(optimization.titles.coupangTitle, /쓰러담아/);
  assert.doesNotMatch(optimization.titles.naverTitle, /쓰러담아/);

  assert.ok(optimization.seo.keywordScores.length > 0);
  for (const entry of optimization.seo.keywordScores) {
    assert.ok(entry.score > 0 && entry.score <= 1);
    assert.ok(entry.documentFrequency >= 1);
  }
  const topKeyword = optimization.seo.keywordScores[0];
  assert.equal(topKeyword.score, 1, 'the words shared by the base title and every competitor listing should score highest');
  assert.equal(topKeyword.documentFrequency, 5);
  assert.ok(['악세사리', '주얼리함', '보석함', '수납함', '주얼리', '3단', '보관', '서랍'].includes(topKeyword.keyword));
});

test('originalProductName-equivalent raw title is never mutated by the optimization pass', () => {
  const { draft, naverResearch } = draft64LikeContext();
  const rawNameBefore = draft.rawName;
  buildRegistrationOptimization({ draft, naverResearch });
  assert.equal(draft.rawName, rawNameBefore);
  assert.equal(draft.rawName, '[쓰러담아] 주얼리 보석함 3단 주얼리함 악세사리 보관 서랍 수납함');
});
