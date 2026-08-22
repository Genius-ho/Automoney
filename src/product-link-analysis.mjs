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
//
// 같은 이유(사람이 링크 몇 개만 보는 미리보기)로 네이버 경쟁 항목도 여기서는
// 실시간 조회한다 -- checkNaverCompetitionLive (naver-research.mjs), draft가
// 없어도 되는 저장 없는 검색. 원래 늘 "데이터 없음(중립값)"이었던 걸 실제
// 신호로 채운다.
import { evaluateCandidates } from './candidate-collector.mjs';
import { computeCompetitivenessScore } from './competitiveness-score.mjs';
import { computeAiScoringContext } from './ai-competitiveness-scoring.mjs';
import { loadCodexConfig, loadNaverConfig } from './config.mjs';
import { listProductDrafts } from './admin-store.mjs';
import { insertLinkAnalysisHistory } from './link-analysis-history-store.mjs';
import { checkNaverCompetitionLive } from './naver-research.mjs';
import { NaverShoppingClient } from './naver-shopping-client.mjs';

const EXISTING_TITLES_LIMIT = 200;

export async function analyzeProductLinks(domemeClient, productNos, pricingRules, {
  db = null,
  rootDir = process.cwd(),
  aiScoringEnabled = true,
  naverResearchEnabled = true,
  // keyword: the GUI's "키워드 검색" input (or a Telegram keyword, if ever
  // wired) that led the human to these links, purely for history context --
  // null for a bare link paste with no preceding keyword search. source:
  // 'link_input' (GUI) or 'telegram' (링크 답장) -- see link_analysis_history.
  keyword = null,
  source = 'link_input',
  evaluateCandidatesImpl = evaluateCandidates,
  computeCompetitivenessScoreImpl = computeCompetitivenessScore,
  computeAiScoringContextImpl = computeAiScoringContext,
  loadCodexConfigImpl = loadCodexConfig,
  loadNaverConfigImpl = loadNaverConfig,
  checkNaverCompetitionLiveImpl = checkNaverCompetitionLive,
  listProductDraftsImpl = listProductDrafts,
  insertLinkAnalysisHistoryImpl = insertLinkAnalysisHistory,
} = {}) {
  const evaluated = await evaluateCandidatesImpl(
    domemeClient,
    productNos.map((productNo) => ({ productNo })),
    pricingRules,
    { includeNeedsReview: true, includeDomeggook: true },
  );

  // All 3 AI dimensions go through Codex now (loadCodexConfigImpl) -- see
  // ai-competitiveness-scoring.mjs's header comment.
  let codexConfig = null;
  let existingDraftTitles = [];
  if (aiScoringEnabled) {
    codexConfig = await loadCodexConfigImpl(rootDir).catch(() => null);
    if (db) {
      existingDraftTitles = await listProductDraftsImpl(db, { limit: EXISTING_TITLES_LIMIT })
        .then((drafts) => (drafts || []).map((d) => d.sellingTitle).filter(Boolean))
        .catch(() => []);
    }
  }

  // loadNaverConfig throws (not returns null) when NAVER_CLIENT_ID/SECRET
  // are unset -- caught the same way every other optional credential here
  // is, so an unconfigured Naver search just leaves this dimension on its
  // existing neutral proxy instead of failing the whole analysis.
  const naverClient = naverResearchEnabled
    ? await loadNaverConfigImpl(rootDir).then((config) => new NaverShoppingClient(config)).catch(() => null)
    : null;

  const results = await Promise.all(evaluated.map(async (candidate) => {
    if (candidate.error) {
      return { productNo: candidate.productNo, status: 'error', error: candidate.error.message };
    }
    // AI-scoring failures (CLI unavailable, timeout, etc.) never fail the
    // whole candidate -- computeAiScoringContext itself already degrades
    // each dimension independently to its formula proxy.
    const [aiContext, naverResearch] = await Promise.all([
      codexConfig
        ? computeAiScoringContextImpl(candidate, existingDraftTitles, { codexConfig, rootDir }).catch(() => ({}))
        : Promise.resolve({}),
      naverClient && candidate.normalized?.name
        ? checkNaverCompetitionLiveImpl(naverClient, candidate.normalized.name, candidate.prices?.naverSalePrice).catch(() => null)
        : Promise.resolve(null),
    ]);
    const { score, breakdown } = computeCompetitivenessScoreImpl(candidate, { ...aiContext, naverResearch });
    return {
      productNo: candidate.productNo,
      status: 'analyzed',
      name: candidate.normalized?.name || null,
      score,
      // breakdown's imageQuality/returnRisk/duplicateRisk reasons are
      // prefixed "[AI] " when ai-competitiveness-scoring.mjs actually judged
      // them (vs. the plain competitiveness-score.mjs proxy on failure/CLI
      // unavailable) -- exposed so the GUI/사용자 can see, per dimension,
      // whether AI was actually consulted rather than silently falling back.
      breakdown,
      filterStatus: candidate.filter?.filterStatus,
      sourceMarket: candidate.normalized?.sourceMarket || null,
      coupangSalePrice: candidate.prices?.coupangSalePrice ?? null,
      coupangExpectedProfit: candidate.prices?.coupangExpectedProfit ?? null,
    };
  }));

  // Best-effort -- a history-write failure (db down, etc.) must never turn
  // an otherwise-successful analysis into an error response. Only analyzed
  // (scored) results are recorded; an 'error' result has no score to look
  // back on later.
  if (db) {
    const analyzed = results.filter((r) => r.status === 'analyzed');
    if (analyzed.length > 0) {
      await insertLinkAnalysisHistoryImpl(db, analyzed.map((r) => ({ ...r, supplierProductNo: r.productNo, keyword, source })))
        .catch((error) => console.error(`productLinkAnalysis.historyInsertFailed=${error.message}`));
    }
  }

  // productNos keeps the caller's original order; the report itself is
  // sorted best-first since that's the whole point of a comparison table.
  return results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
