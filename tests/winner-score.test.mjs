import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateWinnerScore } from '../src/winner-score.mjs';

test('calculateWinnerScore rewards low price, no rocket, low reviews, low competition, and profit', () => {
  const result = calculateWinnerScore({
    mySalePrice: 10000,
    lowestPrice: 10000,
    competitorCount: 10,
    rocketExists: false,
    maxReviewCount: 50,
    expectedProfit: 3500,
  });

  assert.equal(result.priceGapRate, 0);
  assert.equal(result.winnerScore, 140);
  assert.equal(result.winnerStatus, 'strong_candidate');
  assert.ok(result.reasons.includes('my_price_at_or_below_lowest:+30'));
});

test('calculateWinnerScore rejects expensive products with rocket, high reviews, high competition, and low profit', () => {
  const result = calculateWinnerScore({
    mySalePrice: 12000,
    lowestPrice: 10000,
    competitorCount: 100,
    rocketExists: true,
    maxReviewCount: 1000,
    expectedProfit: 2500,
  });

  assert.equal(result.priceGapRate, 0.2);
  assert.equal(result.winnerScore, -70);
  assert.equal(result.winnerStatus, 'reject');
  assert.ok(result.reasons.includes('my_price_10_percent_or_more_expensive:-30'));
});
