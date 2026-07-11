import { summarizeShoppingSearch } from './naver-shopping-client.mjs';
import { buildSkippedDatalabResult } from './naver-datalab-client.mjs';

export function calculateNaverWinnerScore({ mySalePrice, lowestPrice, competitorCount, expectedProfit }) {
  if (!Number.isFinite(Number(mySalePrice)) || !Number.isFinite(Number(lowestPrice)) || Number(lowestPrice) <= 0) {
    return {
      priceGapRate: null,
      winnerScore: 0,
      winnerStatus: 'reject',
      reasons: ['missing_or_invalid_search_price:reject'],
    };
  }

  let score = 50;
  const reasons = [];
  const priceGapRate = (Number(mySalePrice) - Number(lowestPrice)) / Number(lowestPrice);
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

  if (Number.isFinite(Number(competitorCount))) {
    if (Number(competitorCount) < 20) {
      score += 15;
      reasons.push('competitors_under_20:+15');
    } else if (Number(competitorCount) < 100) {
      score += 5;
      reasons.push('competitors_under_100:+5');
    } else if (Number(competitorCount) >= 1000) {
      score -= 15;
      reasons.push('competitors_1000_or_more:-15');
    }
  }

  if (Number.isFinite(Number(expectedProfit))) {
    if (Number(expectedProfit) >= 3000) {
      score += 15;
      reasons.push('expected_profit_3000_or_more:+15');
    } else {
      score -= 30;
      reasons.push('expected_profit_under_3000:-30');
    }
  }

  return { priceGapRate, winnerScore: score, winnerStatus: toNaverWinnerStatus(score), reasons };
}

export async function researchNaverDraft(db, client, draft, { keyword } = {}) {
  const searchKeyword = keyword || draft.selling_title || draft.cleaned_name || draft.raw_name;
  const raw = await client.searchShop({ query: searchKeyword });
  const search = summarizeShoppingSearch(raw, draft.naver_sale_price);
  const score = calculateNaverWinnerScore({
    mySalePrice: draft.naver_sale_price,
    lowestPrice: search.lowestPrice,
    competitorCount: search.competitorCount,
    expectedProfit: draft.naver_expected_profit,
  });
  const datalab = buildSkippedDatalabResult();
  const research = await upsertNaverResearch(db, {
    productDraftId: draft.id,
    keyword: searchKeyword,
    mySalePrice: draft.naver_sale_price,
    topPriceAvg: search.topPriceAvg,
    lowestPrice: search.lowestPrice,
    competitorCount: search.competitorCount,
    priceGapRate: score.priceGapRate,
    winnerScore: score.winnerScore,
    winnerStatus: score.winnerStatus,
    reasons: score.reasons,
    raw: { search, bestItem: search.bestItem, datalabStatus: datalab.datalabStatus, searchRaw: raw },
  });
  return research;
}

export async function upsertNaverResearch(db, research) {
  const result = await db.query(
    `
      insert into market_research_results (
        product_draft_id, marketplace, keyword, my_sale_price, lowest_price, top_price_avg,
        competitor_count, rocket_exists, max_review_count, avg_rating, price_gap_rate,
        winner_score, winner_status, reasons, raw_json, checked_at, updated_at
      )
      values (
        $1, 'naver', $2, $3, $4, $5,
        $6, false, null, null, $7,
        $8, $9, $10::jsonb, $11::jsonb, now(), now()
      )
      on conflict (product_draft_id, marketplace) do update set
        keyword = excluded.keyword,
        my_sale_price = excluded.my_sale_price,
        lowest_price = excluded.lowest_price,
        top_price_avg = excluded.top_price_avg,
        competitor_count = excluded.competitor_count,
        price_gap_rate = excluded.price_gap_rate,
        winner_score = excluded.winner_score,
        winner_status = excluded.winner_status,
        reasons = excluded.reasons,
        raw_json = excluded.raw_json,
        checked_at = now(),
        updated_at = now()
      returning *
    `,
    [
      research.productDraftId,
      research.keyword,
      research.mySalePrice,
      research.lowestPrice,
      research.topPriceAvg,
      research.competitorCount,
      research.priceGapRate,
      research.winnerScore,
      research.winnerStatus,
      JSON.stringify(research.reasons),
      JSON.stringify(research.raw),
    ],
  );
  return toNaverResearch(result.rows[0]);
}

function toNaverResearch(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    marketplace: row.marketplace,
    keyword: row.keyword,
    mySalePrice: row.my_sale_price,
    lowestPrice: row.lowest_price,
    topPriceAvg: row.top_price_avg,
    competitorCount: row.competitor_count,
    priceGapRate: row.price_gap_rate == null ? null : Number(row.price_gap_rate),
    winnerScore: row.winner_score,
    winnerStatus: row.winner_status,
    reasons: row.reasons || [],
    raw: row.raw_json,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNaverWinnerStatus(score) {
  if (score >= 70) return 'candidate';
  if (score >= 40) return 'needs_review';
  return 'reject';
}
