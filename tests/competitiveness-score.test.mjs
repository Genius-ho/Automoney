import assert from 'node:assert/strict';
import test from 'node:test';

import { WEIGHTS, computeCompetitivenessScore } from '../src/competitiveness-score.mjs';

function strongCandidate(overrides = {}) {
  return {
    normalized: {
      name: '수납 정리함 대형',
      options: [{ name: '색상', values: ['블랙'] }],
      images: Array.from({ length: 10 }, (_, i) => `https://example.test/${i}.jpg`),
      detailHtml: '<p>상세</p>',
      cost: 8000,
      shippingFee: 0,
      sellUnitType: 'single',
    },
    filter: { filterStatus: 'pass', blockReasons: [], reviewReasons: [] },
    prices: { coupangExpectedProfit: 15000, coupangMarginRate: 0.35 },
    ...overrides,
  };
}

test('computeCompetitivenessScore returns 0-100 with a breakdown covering all 9 dimensions', () => {
  const { score, breakdown } = computeCompetitivenessScore(strongCandidate());
  assert.ok(score >= 0 && score <= 100);
  assert.equal(Object.keys(breakdown).length, 9);
  for (const part of Object.values(breakdown)) {
    assert.ok(part.points >= 0 && part.points <= part.max);
    assert.equal(typeof part.reason, 'string');
  }
});

test('supplyStability/keywordPopularity dimensions were removed entirely (no real signal exists for either, even for AI)', () => {
  const { breakdown } = computeCompetitivenessScore(strongCandidate());
  assert.equal(breakdown.supplyStability, undefined);
  assert.equal(breakdown.keywordPopularity, undefined);
});

test('the 3 AI-judgeable dimensions (imageQuality/returnRisk/duplicateRisk) combined outweigh profitMargin ("가격")', () => {
  const aiTotal = WEIGHTS.imageQuality + WEIGHTS.returnRisk + WEIGHTS.duplicateRisk;
  assert.ok(aiTotal > WEIGHTS.profitMargin, `AI dimensions (${aiTotal}) must outweigh profitMargin (${WEIGHTS.profitMargin})`);
});

test('WEIGHTS still sum to exactly 100', () => {
  const total = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  assert.equal(total, 100);
});

test('a strong candidate (good profit, simple options, no risk keywords, many images) scores well above a weak one', () => {
  const strong = computeCompetitivenessScore(strongCandidate());

  const weak = computeCompetitivenessScore({
    normalized: {
      name: '위험 상품',
      options: Array.from({ length: 20 }, (_, i) => ({ name: '옵션', values: [`${i}`] })),
      images: [],
      detailHtml: '',
      cost: 45000,
      shippingFee: 4000,
      sellUnitType: 'bundle',
    },
    filter: { filterStatus: 'needs_review', blockReasons: [], reviewReasons: ['risk_keyword:전기'] },
    prices: {},
  });

  assert.ok(strong.score > weak.score);
  assert.ok(weak.score < 40);
  assert.ok(strong.score > 60);
});

test('a risk-keyword hit zeroes out the legal-risk dimension entirely', () => {
  const { breakdown } = computeCompetitivenessScore(strongCandidate({
    filter: { filterStatus: 'needs_review', blockReasons: [], reviewReasons: ['risk_keyword:의료'] },
  }));
  assert.equal(breakdown.legalRisk.points, 0);
});

test('missing price data yields 0 profit-margin points instead of throwing', () => {
  const { breakdown } = computeCompetitivenessScore(strongCandidate({ prices: {} }));
  assert.equal(breakdown.profitMargin.points, 0);
});

test('duplicateRisk drops toward 0 when the candidate title strongly overlaps an existing draft title', () => {
  const { breakdown } = computeCompetitivenessScore(
    strongCandidate({ normalized: { ...strongCandidate().normalized, name: '수납 정리함 대형 세트' } }),
    { existingDraftTitles: ['수납 정리함 대형'] },
  );
  assert.ok(breakdown.duplicateRisk.points < breakdown.duplicateRisk.max * 0.5);
});

test('naverTrend rewards a high, growing click-trend ratio and gives a neutral half-credit when no trend data is present', () => {
  const strong = computeCompetitivenessScore(strongCandidate(), {
    naverTrend: { avgRatio: 90, growthRate: 0.4 },
  });
  assert.ok(strong.breakdown.naverTrend.points > strong.breakdown.naverTrend.max * 0.8);

  const noData = computeCompetitivenessScore(strongCandidate());
  assert.equal(noData.breakdown.naverTrend.points, noData.breakdown.naverTrend.max * 0.5);
});

test('naverTrend gives a low score for a low, declining click-trend ratio', () => {
  const { breakdown } = computeCompetitivenessScore(strongCandidate(), {
    naverTrend: { avgRatio: 5, growthRate: -0.4 },
  });
  assert.ok(breakdown.naverTrend.points < breakdown.naverTrend.max * 0.2);
});
