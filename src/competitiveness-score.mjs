// 0~100 auto-discovery-batch competitiveness score. 2026-08-22 사용자 결정:
// supplyStability/keywordPopularity was previously scored on a fixed neutral
// half-credit because this codebase has literally no signal for either one
// (no seller rating/order-history data, no search-volume API) -- not even
// AI can judge those without inventing data, so both dimensions were removed
// entirely rather than keep faking a placeholder score. The freed weight
// went to the 3 dimensions ai-competitiveness-scoring.mjs can now actually
// judge (imageQuality/returnRisk/duplicateRisk, 링크 입력 흐름 한정), which
// combined (25) deliberately outweigh profitMargin (15, "가격") per that
// same request. The other 5 dimensions (naverCompetition/costShipping/
// optionComplexity/legalRisk/sourceCompleteness) have a real measured
// signal and are unchanged.
//
// `candidate` is one entry from src/candidate-collector.mjs's
// evaluateCandidates() -- { normalized, filter, prices, productNo }.
// `context` carries optional, batch-run-scoped signals that aren't part of
// the candidate itself: { naverResearch, existingDraftTitles }.

export const WEIGHTS = {
  imageQuality: 10,
  returnRisk: 9,
  duplicateRisk: 6,
  profitMargin: 15,
  naverCompetition: 15,
  legalRisk: 15,
  costShipping: 10,
  optionComplexity: 10,
  sourceCompleteness: 10,
};

// context.aiImageQuality/aiReturnRisk/aiDuplicateRisk let a caller substitute
// an AI-judged {points, reason} for the corresponding proxy dimension below
// -- see ai-competitiveness-scoring.mjs, used only by the manual "링크 입력"
// flow (product-link-analysis.mjs), never by the bulk automated discovery/
// keyword-sourcing flows (auto-discovery-batch.mjs calls this function
// directly with plain context, so it's unaffected and stays proxy-only).
export function computeCompetitivenessScore(candidate, context = {}) {
  const normalized = candidate.normalized || {};
  const filter = candidate.filter || {};
  const prices = candidate.prices || {};

  const parts = {
    imageQuality: context.aiImageQuality || scoreImageQuality(normalized),
    returnRisk: context.aiReturnRisk || scoreReturnRisk(normalized, filter),
    duplicateRisk: context.aiDuplicateRisk || scoreDuplicateRisk(normalized, context.existingDraftTitles),
    profitMargin: scoreProfitMargin(prices),
    naverCompetition: scoreNaverCompetition(context.naverResearch),
    legalRisk: scoreLegalRisk(filter),
    costShipping: scoreCostShipping(normalized),
    optionComplexity: scoreOptionComplexity(normalized),
    sourceCompleteness: scoreSourceCompleteness(normalized, filter),
  };

  const score = Object.values(parts).reduce((sum, part) => sum + part.points, 0);
  const breakdown = Object.fromEntries(
    Object.entries(parts).map(([key, part]) => [key, { points: round1(part.points), max: WEIGHTS[key], reason: part.reason }]),
  );

  return { score: round1(score), breakdown };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function scoreProfitMargin({ coupangExpectedProfit, coupangMarginRate, naverExpectedProfit, naverMarginRate } = {}) {
  const profit = coupangExpectedProfit ?? naverExpectedProfit ?? null;
  const marginRate = coupangMarginRate ?? naverMarginRate ?? null;
  if (profit == null) return { points: 0, reason: '가격 계산 불가 (원가/판매가 정보 부족)' };
  const profitPoints = clamp(profit / 15000, 0, 1) * (WEIGHTS.profitMargin * 0.6);
  const marginPoints = marginRate == null ? 0 : clamp(marginRate / 0.35, 0, 1) * (WEIGHTS.profitMargin * 0.4);
  return { points: profitPoints + marginPoints, reason: `예상순이익=${profit}, 마진율=${marginRate ?? '-'}` };
}

// Naver competitor research (market_research_results) only exists once a
// draft has been created and researched -- a raw Domeggook candidate at
// collection time never has it yet. Neutral (half credit) when absent so
// this dimension doesn't silently zero out every Stage-1 candidate.
function scoreNaverCompetition(naverResearch) {
  if (!naverResearch) return { points: WEIGHTS.naverCompetition * 0.5, reason: '네이버 리서치 데이터 없음 (중립값)' };
  const { competitorCount, priceGapRate } = naverResearch;
  const competitionPoints = competitorCount == null ? WEIGHTS.naverCompetition * 0.25
    : clamp(1 - competitorCount / 50, 0, 1) * (WEIGHTS.naverCompetition * 0.5);
  const pricePoints = priceGapRate == null ? WEIGHTS.naverCompetition * 0.25
    : clamp(1 - Math.abs(priceGapRate), 0, 1) * (WEIGHTS.naverCompetition * 0.5);
  return { points: competitionPoints + pricePoints, reason: `경쟁상품수=${competitorCount ?? '-'}, 가격격차=${priceGapRate ?? '-'}` };
}

function scoreCostShipping({ cost, shippingFee } = {}) {
  if (!Number.isFinite(cost) || cost <= 0) return { points: 0, reason: '공급가 정보 없음' };
  const costPoints = clamp(1 - cost / 50000, 0, 1) * (WEIGHTS.costShipping * 0.7);
  const shippingPoints = clamp(1 - (shippingFee || 0) / 5000, 0, 1) * (WEIGHTS.costShipping * 0.3);
  return { points: costPoints + shippingPoints, reason: `공급가=${cost}, 배송비=${shippingFee ?? 0}` };
}

function scoreOptionComplexity({ options } = {}) {
  const count = Array.isArray(options) ? options.length : 0;
  if (count <= 3) return { points: WEIGHTS.optionComplexity, reason: `옵션 ${count}개 (단순)` };
  if (count <= 10) return { points: WEIGHTS.optionComplexity * 0.5, reason: `옵션 ${count}개 (보통)` };
  return { points: 0, reason: `옵션 ${count}개 (복잡, 등록 위험)` };
}

function scoreLegalRisk(filter = {}) {
  const riskKeywordHits = (filter.reviewReasons || []).filter((reason) => reason.startsWith('risk_keyword:'));
  const hasLegalBlock = (filter.blockReasons || []).some((reason) => reason.startsWith('blocked_'));
  if (riskKeywordHits.length > 0) return { points: 0, reason: `위험 키워드 감지: ${riskKeywordHits.join(',')}` };
  if (hasLegalBlock) return { points: WEIGHTS.legalRisk * 0.3, reason: `차단 사유 존재: ${(filter.blockReasons || []).join(',')}` };
  return { points: WEIGHTS.legalRisk, reason: '위험 키워드/차단 사유 없음' };
}

function scoreSourceCompleteness(normalized = {}, filter = {}) {
  const hasName = Boolean(normalized.name);
  const hasImages = Array.isArray(normalized.images) && normalized.images.length > 0;
  const hasDetailHtml = Boolean(normalized.detailHtml);
  const filled = [hasName, hasImages, hasDetailHtml].filter(Boolean).length;
  return { points: (filled / 3) * WEIGHTS.sourceCompleteness, reason: `원본 완성도 항목 ${filled}/3 (이름/이미지/상세HTML)` };
}

// Proxy: image count is the only signal available pre-registration (no
// resolution/watermark check exists anywhere in src/).
export function scoreImageQuality({ images } = {}) {
  const count = Array.isArray(images) ? images.length : 0;
  const points = clamp(count / 8, 0, 1) * WEIGHTS.imageQuality;
  return { points, reason: `이미지 ${count}장 기준 단순 지표` };
}

// Proxy: bundle-type sell units are harder to process exact returns for.
export function scoreReturnRisk(normalized = {}, filter = {}) {
  if (normalized.sellUnitType === 'bundle' || (filter.reviewReasons || []).includes('bundle_candidate')) {
    return { points: WEIGHTS.returnRisk * 0.4, reason: '묶음(번들) 판매 -- 반품 처리 복잡도 높음' };
  }
  return { points: WEIGHTS.returnRisk * 0.8, reason: '단품 판매 (카테고리 기반 단순 지표)' };
}

// Proxy: word-overlap similarity against existing draft titles -- no
// image-hash or embedding-based near-duplicate detection exists anywhere.
export function scoreDuplicateRisk(normalized = {}, existingDraftTitles = []) {
  if (!normalized.name || !existingDraftTitles?.length) return { points: WEIGHTS.duplicateRisk, reason: '비교 대상 없음 (기본값)' };
  const maxSimilarity = Math.max(...existingDraftTitles.map((title) => titleSimilarity(normalized.name, title)));
  return { points: (1 - maxSimilarity) * WEIGHTS.duplicateRisk, reason: `기존 상품명과 최대 유사도=${round1(maxSimilarity)}` };
}

function titleSimilarity(a, b) {
  const tokensA = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
