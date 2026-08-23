import { summarizeShoppingSearch } from './naver-shopping-client.mjs';
import { buildSkippedDatalabResult } from './naver-datalab-client.mjs';
import { fetchShoppingKeywordTrend } from './naver-api-hub-client.mjs';

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

// 2026-08-22: "링크 입력" 점수의 네이버 경쟁 항목이 항상 "데이터 없음(중립값)"
// 이었던 걸 채우려 했으나, 개발자센터 쇼핑검색 API가 2026-07-31에 대체재 없이
// 완전히 종료된 것으로 확인됨 (공식 공지, NAVER API HUB 카탈로그 둘 다 개별
// 상품 가격/판매처 API가 없음) -- 그래서 "경쟁상품수/가격격차" 방식은 폐기.
// 대신 사용자 결정: NAVER API HUB의 쇼핑 인사이트(카테고리/키워드 클릭 트렌드)로
// "꾸준히 높은 클릭 트렌드인지" + "최근 상승 추세인지" 두 신호를 본다.
// startDate로부터 monthsBack개월치 월간 ratio(0~100, 그 구간 내 상대값)를 받아
// 최근 6개월 평균(꾸준함)과 초반 대비 후반 성장률(momentum 기반 상승세 근사치)을
// 계산한다. category는 네이버쇼핑 cat_id -- 필수 파라미터라 없으면 이 함수를
// 호출하지 않는 게 caller의 책임 (product-link-analysis.mjs는 category를
// 모르면 그냥 건너뛰고 중립 프록시로 남긴다).
//
// 2026-08-23 사용자 지적: "지금부터 2달 뒤"를 알려면 momentum 근사치보다 나은
// 신호가 있다 -- 10개월 전과 12개월 전은 정확히 "2달 뒤"와 "지금"의 작년
// 같은 달(month)이다 (10 = 12 - 2). 그래서 작년에 그 두 달 사이 클릭 트렌드가
// 올랐다면, 계절성(매년 반복되는 수요 패턴)상 올해도 지금부터 2달 뒤에 오를
// 가능성이 momentum 근사치보다 직접적인 힌트가 된다. monthsBack을 13으로
// 늘려 이 계절성 신호(seasonalGrowth)를 같이 계산하고, 작년 데이터가 없는
// (신상품 등) 경우엔 null로 둬서 caller가 momentum 근사치로 대체할 수 있게
// 한다.
export async function checkNaverTrendLive(client, keyword, category, {
  now = new Date(),
  monthsBack = 13,
  fetchShoppingKeywordTrendImpl = fetchShoppingKeywordTrend,
} = {}) {
  const endDate = new Date(now);
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - monthsBack);
  const toDateString = (date) => date.toISOString().slice(0, 10);
  const monthKeyAt = (date, deltaMonths) => {
    const shifted = new Date(date);
    shifted.setMonth(shifted.getMonth() + deltaMonths);
    return shifted.toISOString().slice(0, 7);
  };

  const raw = await fetchShoppingKeywordTrendImpl(client, {
    keyword,
    category,
    startDate: toDateString(startDate),
    endDate: toDateString(endDate),
    timeUnit: 'month',
  });
  const points = (raw?.results?.[0]?.data || [])
    .map((point) => ({ monthKey: String(point.period || '').slice(0, 7), ratio: Number(point.ratio) }))
    .filter((point) => point.monthKey && Number.isFinite(point.ratio));
  if (points.length === 0) return null;

  const avg = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const recentRatios = points.slice(-6).map((point) => point.ratio);
  const avgRatio = avg(recentRatios);
  const half = Math.max(1, Math.floor(recentRatios.length / 2));
  const earlyAvg = avg(recentRatios.slice(0, half));
  const recentAvg = avg(recentRatios.slice(-half));
  const growthRate = earlyAvg > 0 ? (recentAvg - earlyAvg) / earlyAvg : (recentAvg > 0 ? 1 : 0);

  const byMonth = new Map(points.map((point) => [point.monthKey, point.ratio]));
  const nowEquivalentLastYear = byMonth.get(monthKeyAt(now, -12));
  const futureEquivalentLastYear = byMonth.get(monthKeyAt(now, -10));
  const seasonalGrowth = nowEquivalentLastYear != null && futureEquivalentLastYear != null
    ? (nowEquivalentLastYear > 0
      ? (futureEquivalentLastYear - nowEquivalentLastYear) / nowEquivalentLastYear
      : (futureEquivalentLastYear > 0 ? 1 : 0))
    : null;

  return { avgRatio, growthRate, seasonalGrowth, months: recentRatios.length };
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
