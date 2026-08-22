// "링크 분석" -- 사람이 도매매/도매꾹에서 직접 후보 상품 여러 개를 찾아 링크로
// 보내면, 각각을 evaluateCandidates(정규화/필터/가격)와 computeCompetitivenessScore
// (3일 자동발굴과 동일한 0~100점 스코어)로 분석만 해서 비교표를 준다. 여기서는
// 아무것도 저장/등록하지 않는다 -- 마음에 드는 걸 고르면 manual-url-import.mjs
// ("URL 등록" 관리자 화면)로 실제 초안을 만드는 건 사람이 직접 한다.
import { evaluateCandidates } from './candidate-collector.mjs';
import { computeCompetitivenessScore } from './competitiveness-score.mjs';

export async function analyzeProductLinks(domemeClient, productNos, pricingRules, {
  evaluateCandidatesImpl = evaluateCandidates,
  computeCompetitivenessScoreImpl = computeCompetitivenessScore,
} = {}) {
  const evaluated = await evaluateCandidatesImpl(
    domemeClient,
    productNos.map((productNo) => ({ productNo })),
    pricingRules,
    { includeNeedsReview: true, includeDomeggook: true },
  );

  const results = evaluated.map((candidate) => {
    if (candidate.error) {
      return { productNo: candidate.productNo, status: 'error', error: candidate.error.message };
    }
    const { score } = computeCompetitivenessScoreImpl(candidate, {});
    return {
      productNo: candidate.productNo,
      status: 'analyzed',
      name: candidate.normalized?.name || null,
      score,
      filterStatus: candidate.filter?.filterStatus,
      sourceMarket: candidate.normalized?.sourceMarket || null,
      coupangSalePrice: candidate.prices?.coupangSalePrice ?? null,
      coupangExpectedProfit: candidate.prices?.coupangExpectedProfit ?? null,
    };
  });

  // productNos keeps the caller's original order; the report itself is
  // sorted best-first since that's the whole point of a comparison table.
  return results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
