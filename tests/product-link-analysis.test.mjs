import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeProductLinks } from '../src/product-link-analysis.mjs';

test('analyzeProductLinks evaluates every product number and sorts by score, best first', async () => {
  const receivedCandidates = [];
  const results = await analyzeProductLinks({}, ['1', '2'], { defaultMarginRate: 0.25 }, {
    evaluateCandidatesImpl: async (client, candidates) => {
      receivedCandidates.push(...candidates);
      return [
        { productNo: '1', normalized: { name: 'A', sourceMarket: 'domeme' }, filter: { filterStatus: 'pass' }, prices: { coupangSalePrice: 10000, coupangExpectedProfit: 2000 } },
        { productNo: '2', normalized: { name: 'B', sourceMarket: 'domeggook' }, filter: { filterStatus: 'needs_review' }, prices: { coupangSalePrice: 20000, coupangExpectedProfit: 5000 } },
      ];
    },
    computeCompetitivenessScoreImpl: (candidate) => ({ score: candidate.productNo === '1' ? 50 : 80, breakdown: {} }),
  });

  assert.deepEqual(receivedCandidates, [{ productNo: '1' }, { productNo: '2' }]);
  assert.deepEqual(results.map((r) => r.productNo), ['2', '1']);
  assert.equal(results[0].score, 80);
  assert.equal(results[0].name, 'B');
  assert.equal(results[0].sourceMarket, 'domeggook');
  assert.equal(results[0].coupangSalePrice, 20000);
});

test('analyzeProductLinks reports a per-link error without throwing or scoring it', async () => {
  const results = await analyzeProductLinks({}, ['1', '2'], {}, {
    evaluateCandidatesImpl: async () => [
      { productNo: '1', error: new Error('상품을 찾을 수 없습니다') },
      { productNo: '2', normalized: { name: 'B' }, filter: { filterStatus: 'pass' }, prices: {} },
    ],
    computeCompetitivenessScoreImpl: () => ({ score: 60, breakdown: {} }),
  });

  const errorResult = results.find((r) => r.productNo === '1');
  assert.deepEqual(errorResult, { productNo: '1', status: 'error', error: '상품을 찾을 수 없습니다' });
  const okResult = results.find((r) => r.productNo === '2');
  assert.equal(okResult.status, 'analyzed');
  assert.equal(okResult.score, 60);
});
