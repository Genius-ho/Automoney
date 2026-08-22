// "링크 분석" -- 사람이 도매매/도매꾹에서 직접 후보 상품 여러 개를 찾아 링크로
// 보내면, 각각을 evaluateCandidates(정규화/필터/가격)와 computeCompetitivenessScore
// (3일 자동발굴과 동일한 0~100점 스코어)로 분석만 해서 비교표를 준다. 여기서는
// 아무것도 저장/등록하지 않는다 -- 마음에 드는 걸 고르면 manual-url-import.mjs
// ("URL 등록" 관리자 화면)로 실제 초안을 만드는 건 사람이 직접 한다.
//
// 2026-08-22 사용자 요청: 이미지 품질/반품 리스크/중복 위험은 (프로그램으로는
// 못 채우니) AI가 직접 판단하게 한다 -- ai-competitiveness-scoring.mjs. 사람이
// 링크를 몇 개 붙여넣는 이 수동 흐름에서만 켜져 있다 (자동발굴/키워드소싱은
// collectAndScoreCandidatesForCategory가 이 모듈을 거치지 않고 computeCompetitivenessScore를
// 직접 호출하므로 영향 없음 -- 후보 20~30개마다 AI 호출이 곱해지는 걸 피하기 위함).
// db가 주어지면 중복위험 AI 판단용으로 최근 등록된 draft 제목들을 같이 넘긴다.
import { evaluateCandidates } from './candidate-collector.mjs';
import { computeCompetitivenessScore } from './competitiveness-score.mjs';
import { computeAiScoringContext } from './ai-competitiveness-scoring.mjs';
import { loadClaudeCliConfig } from './config.mjs';
import { listProductDrafts } from './admin-store.mjs';

const EXISTING_TITLES_LIMIT = 200;

export async function analyzeProductLinks(domemeClient, productNos, pricingRules, {
  db = null,
  rootDir = process.cwd(),
  aiScoringEnabled = true,
  evaluateCandidatesImpl = evaluateCandidates,
  computeCompetitivenessScoreImpl = computeCompetitivenessScore,
  computeAiScoringContextImpl = computeAiScoringContext,
  loadClaudeCliConfigImpl = loadClaudeCliConfig,
  listProductDraftsImpl = listProductDrafts,
} = {}) {
  const evaluated = await evaluateCandidatesImpl(
    domemeClient,
    productNos.map((productNo) => ({ productNo })),
    pricingRules,
    { includeNeedsReview: true, includeDomeggook: true },
  );

  let claudeCliConfig = null;
  let existingDraftTitles = [];
  if (aiScoringEnabled) {
    claudeCliConfig = await loadClaudeCliConfigImpl(rootDir).catch(() => null);
    if (db) {
      existingDraftTitles = await listProductDraftsImpl(db, { limit: EXISTING_TITLES_LIMIT })
        .then((drafts) => (drafts || []).map((d) => d.sellingTitle).filter(Boolean))
        .catch(() => []);
    }
  }

  const results = await Promise.all(evaluated.map(async (candidate) => {
    if (candidate.error) {
      return { productNo: candidate.productNo, status: 'error', error: candidate.error.message };
    }
    // AI-scoring failures (CLI unavailable, timeout, etc.) never fail the
    // whole candidate -- computeAiScoringContext itself already degrades
    // each dimension independently to its formula proxy.
    const aiContext = claudeCliConfig
      ? await computeAiScoringContextImpl(candidate, existingDraftTitles, { config: claudeCliConfig }).catch(() => ({}))
      : {};
    const { score } = computeCompetitivenessScoreImpl(candidate, aiContext);
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
  }));

  // productNos keeps the caller's original order; the report itself is
  // sorted best-first since that's the whole point of a comparison table.
  return results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
