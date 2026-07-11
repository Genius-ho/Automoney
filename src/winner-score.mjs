export function calculateWinnerScore({
  mySalePrice,
  lowestPrice,
  competitorCount,
  rocketExists,
  maxReviewCount,
  expectedProfit,
}) {
  let score = 50;
  const reasons = [];
  const priceGapRate = calculatePriceGapRate(mySalePrice, lowestPrice);

  if (priceGapRate !== null) {
    if (priceGapRate <= 0) {
      score += 30;
      reasons.push('my_price_at_or_below_lowest:+30');
    } else if (priceGapRate <= 0.05) {
      score += 15;
      reasons.push('my_price_within_5_percent:+15');
    } else if (priceGapRate >= 0.1) {
      score -= 30;
      reasons.push('my_price_10_percent_or_more_expensive:-30');
    }
  }

  if (rocketExists === true) {
    score -= 25;
    reasons.push('rocket_competitor_exists:-25');
  } else if (rocketExists === false) {
    score += 20;
    reasons.push('no_rocket_competitor:+20');
  }

  if (Number.isFinite(maxReviewCount)) {
    if (maxReviewCount < 100) {
      score += 15;
      reasons.push('max_reviews_under_100:+15');
    } else if (maxReviewCount >= 1000) {
      score -= 20;
      reasons.push('max_reviews_1000_or_more:-20');
    }
  }

  if (Number.isFinite(competitorCount)) {
    if (competitorCount < 20) {
      score += 10;
      reasons.push('competitors_under_20:+10');
    } else if (competitorCount >= 100) {
      score -= 15;
      reasons.push('competitors_100_or_more:-15');
    }
  }

  if (Number.isFinite(expectedProfit)) {
    if (expectedProfit >= 3000) {
      score += 15;
      reasons.push('expected_profit_3000_or_more:+15');
    } else {
      score -= 30;
      reasons.push('expected_profit_under_3000:-30');
    }
  }

  return {
    priceGapRate,
    winnerScore: score,
    winnerStatus: toWinnerStatus(score),
    reasons,
  };
}

function calculatePriceGapRate(mySalePrice, lowestPrice) {
  if (!Number.isFinite(mySalePrice) || !Number.isFinite(lowestPrice) || lowestPrice <= 0) return null;
  return (mySalePrice - lowestPrice) / lowestPrice;
}

function toWinnerStatus(score) {
  if (score >= 80) return 'strong_candidate';
  if (score >= 60) return 'candidate';
  if (score >= 40) return 'needs_review';
  return 'reject';
}
