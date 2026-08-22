import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeProductLinks } from '../src/product-link-analysis.mjs';

// Every test below stubs computeAiScoringContextImpl/loadCodexConfigImpl and
// disables naverTrendEnabled -- their real implementations spawn the actual
// `codex` CLI or hit the real NAVER API HUB, both slow/non-deterministic in
// a unit test (see the dedicated checkNaverTrendLive tests further down).
const noAiScoring = { loadCodexConfigImpl: async () => ({ executable: 'codex' }), computeAiScoringContextImpl: async () => ({}), naverTrendEnabled: false };

test('analyzeProductLinks evaluates every product number and sorts by score, best first', async () => {
  const receivedCandidates = [];
  const results = await analyzeProductLinks({}, ['1', '2'], { defaultMarginRate: 0.25 }, {
    ...noAiScoring,
    evaluateCandidatesImpl: async (client, candidates) => {
      receivedCandidates.push(...candidates);
      return [
        { productNo: '1', normalized: { name: 'A', sourceMarket: 'domeme' }, filter: { filterStatus: 'pass' }, prices: { coupangSalePrice: 10000, coupangExpectedProfit: 2000 } },
        { productNo: '2', normalized: { name: 'B', sourceMarket: 'domeggook' }, filter: { filterStatus: 'needs_review' }, prices: { coupangSalePrice: 20000, coupangExpectedProfit: 5000 } },
      ];
    },
    computeCompetitivenessScoreImpl: (candidate) => ({ score: candidate.productNo === '1' ? 50 : 80, breakdown: {} }),
  });

  assert.deepEqual(receivedCandidates, [{ productNo: '1' }, { productNo: '2' }]);
  assert.deepEqual(results.map((r) => r.productNo), ['2', '1']);
  assert.equal(results[0].score, 80);
  assert.equal(results[0].name, 'B');
  assert.equal(results[0].sourceMarket, 'domeggook');
  assert.equal(results[0].coupangSalePrice, 20000);
});

test('analyzeProductLinks reports a per-link error without throwing or scoring it', async () => {
  const results = await analyzeProductLinks({}, ['1', '2'], {}, {
    ...noAiScoring,
    evaluateCandidatesImpl: async () => [
      { productNo: '1', error: new Error('상품을 찾을 수 없습니다') },
      { productNo: '2', normalized: { name: 'B' }, filter: { filterStatus: 'pass' }, prices: {} },
    ],
    computeCompetitivenessScoreImpl: () => ({ score: 60, breakdown: {} }),
  });

  const errorResult = results.find((r) => r.productNo === '1');
  assert.deepEqual(errorResult, { productNo: '1', status: 'error', error: '상품을 찾을 수 없습니다' });
  const okResult = results.find((r) => r.productNo === '2');
  assert.equal(okResult.status, 'analyzed');
  assert.equal(okResult.score, 60);
});

test('analyzeProductLinks passes the AI-judged context into computeCompetitivenessScore for each non-error candidate', async () => {
  const receivedContexts = [];
  await analyzeProductLinks({}, ['1'], {}, {
    naverTrendEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    computeAiScoringContextImpl: async (candidate) => ({ aiImageQuality: { points: 10, reason: `[AI] for ${candidate.productNo}` } }),
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => { receivedContexts.push(context); return { score: 70, breakdown: {} }; },
  });

  assert.deepEqual(receivedContexts, [{ aiImageQuality: { points: 10, reason: '[AI] for 1' }, naverTrend: null }]);
});

test('analyzeProductLinks skips AI scoring entirely (empty context) when aiScoringEnabled is false, without loading Codex config', async () => {
  const receivedContexts = [];
  await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    naverTrendEnabled: false,
    loadCodexConfigImpl: async () => { throw new Error('must not be called'); },
    computeAiScoringContextImpl: async () => { throw new Error('must not be called'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => { receivedContexts.push(context); return { score: 70, breakdown: {} }; },
  });

  assert.deepEqual(receivedContexts, [{ naverTrend: null }]);
});

test('analyzeProductLinks loads Codex config and passes it through as codexConfig, plus rootDir', async () => {
  let receivedOpts = null;
  await analyzeProductLinks({}, ['1'], {}, {
    rootDir: '/custom/root',
    naverTrendEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    computeAiScoringContextImpl: async (candidate, titles, opts) => { receivedOpts = opts; return {}; },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: {} }),
  });

  assert.equal(receivedOpts.codexConfig.executable, 'codex');
  assert.equal(receivedOpts.rootDir, '/custom/root');
});

test('analyzeProductLinks falls back to an empty (proxy-only) context, not a thrown error, when AI scoring itself rejects', async () => {
  const results = await analyzeProductLinks({}, ['1'], {}, {
    naverTrendEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    computeAiScoringContextImpl: async () => { throw new Error('codex not logged in'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 42, breakdown: {} }),
  });

  assert.equal(results[0].status, 'analyzed');
  assert.equal(results[0].score, 42);
});

test('analyzeProductLinks fetches recent draft titles for the AI duplicate check only when db is provided', async () => {
  const receivedListArgs = [];
  await analyzeProductLinks({}, ['1'], {}, {
    db: { name: 'db' },
    naverTrendEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    listProductDraftsImpl: async (db, opts) => { receivedListArgs.push({ db, opts }); return [{ sellingTitle: '기존 상품 A' }, { sellingTitle: null }, { sellingTitle: '기존 상품 B' }]; },
    computeAiScoringContextImpl: async (candidate, existingDraftTitles) => ({ aiDuplicateRisk: { points: existingDraftTitles.length, reason: 'x' } }),
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => ({ score: context.aiDuplicateRisk.points, breakdown: {} }),
    insertLinkAnalysisHistoryImpl: async () => [],
  });

  assert.equal(receivedListArgs[0].db.name, 'db');
  assert.equal(receivedListArgs[0].opts.limit, 200);
});

test('analyzeProductLinks does not query for existing draft titles when no db is given', async () => {
  await analyzeProductLinks({}, ['1'], {}, {
    naverTrendEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    listProductDraftsImpl: async () => { throw new Error('must not be called without a db'); },
    computeAiScoringContextImpl: async () => ({}),
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 1, breakdown: {} }),
  });
});

test('analyzeProductLinks records analyzed (scored) results to history, with the keyword/source context, when db is provided', async () => {
  const receivedHistoryArgs = [];
  await analyzeProductLinks({}, ['1', '2'], {}, {
    db: { name: 'db' },
    keyword: '여성 벨트',
    source: 'link_input',
    naverTrendEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    computeAiScoringContextImpl: async () => ({}),
    evaluateCandidatesImpl: async () => [
      { productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} },
      { productNo: '2', error: new Error('조회 실패') },
    ],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: { profitMargin: { points: 10, max: 15, reason: 'x' } } }),
    insertLinkAnalysisHistoryImpl: async (db, rows) => { receivedHistoryArgs.push({ db, rows }); return []; },
  });

  assert.equal(receivedHistoryArgs.length, 1);
  assert.equal(receivedHistoryArgs[0].db.name, 'db');
  // Only the analyzed (scored) candidate is recorded -- the errored one has
  // no score to look back on.
  assert.equal(receivedHistoryArgs[0].rows.length, 1);
  assert.equal(receivedHistoryArgs[0].rows[0].supplierProductNo, '1');
  assert.equal(receivedHistoryArgs[0].rows[0].score, 70);
  assert.equal(receivedHistoryArgs[0].rows[0].keyword, '여성 벨트');
  assert.equal(receivedHistoryArgs[0].rows[0].source, 'link_input');
});

test('analyzeProductLinks does not attempt to write history when no db is given', async () => {
  await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    naverTrendEnabled: false,
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: {} }),
    insertLinkAnalysisHistoryImpl: async () => { throw new Error('must not be called without a db'); },
  });
});

test('analyzeProductLinks does not fail the response when the history insert itself rejects', async () => {
  const results = await analyzeProductLinks({}, ['1'], {}, {
    db: { name: 'db' },
    aiScoringEnabled: false,
    naverTrendEnabled: false,
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: {} }),
    insertLinkAnalysisHistoryImpl: async () => { throw new Error('db down'); },
  });
  assert.equal(results[0].score, 70);
});

// 2026-08-22: naverCompetition(경쟁상품수/가격격차)은 개발자센터 쇼핑검색
// API가 대체재 없이 종료돼서 폐기됐다 -- NAVER API HUB 쇼핑 인사이트(클릭
// 트렌드)로 재정의된 naverTrend를 링크 분석 미리보기(draft 없이, 저장 없이)
// 에서 채운다. 쇼핑 인사이트는 category(cat_id)와 깨끗한 검색 키워드가 둘 다
// 필수라 resolveNaverTrendTargetImpl(AI, naver-trend-keyword-resolver.mjs)이
// 후보→{keyword, categoryCode}를 못 구하면(null) 항상 건너뛴다.
test('analyzeProductLinks resolves a keyword+category via AI then looks up the live Naver trend, merging it into the score context as naverTrend', async () => {
  let receivedArgs = null;
  const results = await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    loadNaverApiHubConfigImpl: async () => ({ clientId: 'id', clientSecret: 'secret' }),
    resolveNaverTrendTargetImpl: async (candidate) => (candidate.productNo === '1' ? { keyword: '여성 벨트', categoryCode: '50000000' } : null),
    checkNaverTrendLiveImpl: async (client, keyword, categoryCode) => { receivedArgs = { client, keyword, categoryCode }; return { avgRatio: 80, growthRate: 0.3 }; },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: '버클 슬림 벨트 원피스 여성' }, filter: { filterStatus: 'pass' }, prices: { naverSalePrice: 15000 } }],
    computeCompetitivenessScoreImpl: (candidate, context) => ({ score: context.naverTrend.avgRatio, breakdown: {} }),
  });

  assert.equal(receivedArgs.keyword, '여성 벨트');
  assert.equal(receivedArgs.categoryCode, '50000000');
  assert.equal(results[0].score, 80);
});

test('analyzeProductLinks skips the Naver trend lookup entirely when the AI target resolver returns null, even with Naver configured', async () => {
  const results = await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    loadNaverApiHubConfigImpl: async () => ({ clientId: 'id', clientSecret: 'secret' }),
    resolveNaverTrendTargetImpl: async () => null,
    checkNaverTrendLiveImpl: async () => { throw new Error('must not be called without a resolved target'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => ({ score: context.naverTrend === null ? 1 : 0, breakdown: {} }),
  });
  assert.equal(results[0].score, 1);
});

test('analyzeProductLinks does not attempt a Naver lookup when naverTrendEnabled is false, without loading Naver API HUB config or Codex config', async () => {
  await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    naverTrendEnabled: false,
    loadCodexConfigImpl: async () => { throw new Error('must not be called'); },
    loadNaverApiHubConfigImpl: async () => { throw new Error('must not be called'); },
    resolveNaverTrendTargetImpl: async () => { throw new Error('must not be called'); },
    checkNaverTrendLiveImpl: async () => { throw new Error('must not be called'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 1, breakdown: {} }),
  });
});

test('analyzeProductLinks falls back to naverTrend:null (proxy-only) when Naver API HUB credentials are unconfigured (loadNaverApiHubConfig throws) or the trend lookup itself fails', async () => {
  const unconfigured = await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    resolveNaverTrendTargetImpl: async () => { throw new Error('must not be called without Naver API HUB config'); },
    loadNaverApiHubConfigImpl: async () => { throw new Error('NAVER_API_HUB_CLIENT_ID is missing in .env'); },
    checkNaverTrendLiveImpl: async () => { throw new Error('must not be called'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => ({ score: context.naverTrend === null ? 1 : 0, breakdown: {} }),
  });
  assert.equal(unconfigured[0].score, 1);

  const lookupFailed = await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    resolveNaverTrendTargetImpl: async () => ({ keyword: 'x', categoryCode: '50000000' }),
    loadNaverApiHubConfigImpl: async () => ({ clientId: 'id', clientSecret: 'secret' }),
    checkNaverTrendLiveImpl: async () => { throw new Error('NAVER API HUB request failed: HTTP 401'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => ({ score: context.naverTrend === null ? 1 : 0, breakdown: {} }),
  });
  assert.equal(lookupFailed[0].score, 1);
});
