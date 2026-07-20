// 0~100 auto-discovery-batch competitiveness score. Weights were agreed with
// the user: 6 dimensions with a real existing data signal are weighted by
// actual measured values; 5 dimensions with no signal anywhere in this
// codebase today (supply stability, image quality, return risk, near-
// duplicate detection, keyword popularity) use simple proxies or a fixed
// neutral contribution, clearly labeled in the breakdown so the admin
// preview can show *why* a candidate scored the way it did rather than
// hiding the fact that a dimension has no real data behind it yet.
//
// `candidate` is one entry from src/candidate-collector.mjs's
// evaluateCandidates() -- { normalized, filter, prices, productNo }.
// `context` carries optional, batch-run-scoped signals that aren't part of
// the candidate itself: { naverResearch, existingDraftTitles, keywordPopularity }.

const WEIGHTS = {
  profitMargin: 20,
  naverCompetition: 15,
  costShipping: 10,
  optionComplexity: 10,
  legalRisk: 15,
  sourceCompleteness: 10,
  supplyStability: 5,
  imageQuality: 5,
  returnRisk: 5,
  duplicateRisk: 3,
  keywordPopularity: 2,
};

export function computeCompetitivenessScore(candidate, context = {}) {
  const normalized = candidate.normalized || {};
  const filter = candidate.filter || {};
  const prices = candidate.prices || {};

  const parts = {
    profitMargin: scoreProfitMargin(prices),
    naverCompetition: scoreNaverCompetition(context.naverResearch),
    costShipping: scoreCostShipping(normalized),
    optionComplexity: scoreOptionComplexity(normalized),
    legalRisk: scoreLegalRisk(filter),
    sourceCompleteness: scoreSourceCompleteness(normalized, filter),
    supplyStability: scoreSupplyStabilityNeutral(),
    imageQuality: scoreImageQuality(normalized),
    returnRisk: scoreReturnRisk(normalized, filter),
    duplicateRisk: scoreDuplicateRisk(normalized, context.existingDraftTitles),
    keywordPopularity: scoreKeywordPopularity(context.keywordPopularity),
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

// No supplier-stability signal exists anywhere in this codebase (no seller
// rating, order-history, or stock-stability data). Fixed neutral half-credit
// until that data source exists -- never silently invented.
function scoreSupplyStabilityNeutral() {
  return { points: WEIGHTS.supplyStability * 0.5, reason: '공급 안정성 데이터 없음 (중립값)' };
}

// Proxy: image count is the only signal available pre-registration (no
// resolution/watermark check exists anywhere in src/).
function scoreImageQuality({ images } = {}) {
  const count = Array.isArray(images) ? images.length : 0;
  const points = clamp(count / 8, 0, 1) * WEIGHTS.imageQuality;
  return { points, reason: `이미지 ${count}장 기준 단순 지표` };
}

// Proxy: bundle-type sell units are harder to process exact returns for.
function scoreReturnRisk(normalized = {}, filter = {}) {
  if (normalized.sellUnitType === 'bundle' || (filter.reviewReasons || []).includes('bundle_candidate')) {
    return { points: WEIGHTS.returnRisk * 0.4, reason: '묶음(번들) 판매 -- 반품 처리 복잡도 높음' };
  }
  return { points: WEIGHTS.returnRisk * 0.8, reason: '단품 판매 (카테고리 기반 단순 지표)' };
}

// Proxy: word-overlap similarity against existing draft titles -- no
// image-hash or embedding-based near-duplicate detection exists anywhere.
function scoreDuplicateRisk(normalized = {}, existingDraftTitles = []) {
  if (!normalized.name || !existingDraftTitles?.length) return { points: WEIGHTS.duplicateRisk, reason: '비교 대상 없음 (기본값)' };
  const maxSimilarity = Math.max(...existingDraftTitles.map((title) => titleSimilarity(normalized.name, title)));
  return { points: (1 - maxSimilarity) * WEIGHTS.duplicateRisk, reason: `기존 상품명과 최대 유사도=${round1(maxSimilarity)}` };
}

function scoreKeywordPopularity(keywordPopularity) {
  if (keywordPopularity == null) return { points: WEIGHTS.keywordPopularity * 0.5, reason: '키워드 인기도 데이터 없음 (중립값)' };
  return { points: clamp(keywordPopularity, 0, 1) * WEIGHTS.keywordPopularity, reason: `키워드 인기도=${keywordPopularity}` };
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
