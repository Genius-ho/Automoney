import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeProductLinks } from '../src/product-link-analysis.mjs';

// Every test below stubs computeAiScoringContextImpl/loadCodexConfigImpl and
// disables naverResearchEnabled -- their real implementations spawn the
// actual `codex` CLI or hit the real Naver Shopping API, both slow/
// non-deterministic (or, for Naver, outright broken in this environment --
// see the dedicated checkNaverCompetitionLive tests below) in a unit test.
const noAiScoring = { loadCodexConfigImpl: async () => ({ executable: 'codex' }), computeAiScoringContextImpl: async () => ({}), naverResearchEnabled: false };

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
    naverResearchEnabled: false,
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    computeAiScoringContextImpl: async (candidate) => ({ aiImageQuality: { points: 10, reason: `[AI] for ${candidate.productNo}` } }),
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => { receivedContexts.push(context); return { score: 70, breakdown: {} }; },
  });

  assert.deepEqual(receivedContexts, [{ aiImageQuality: { points: 10, reason: '[AI] for 1' }, naverResearch: null }]);
});

test('analyzeProductLinks skips AI scoring entirely (empty context) when aiScoringEnabled is false, without loading Codex config', async () => {
  const receivedContexts = [];
  await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    naverResearchEnabled: false,
    loadCodexConfigImpl: async () => { throw new Error('must not be called'); },
    computeAiScoringContextImpl: async () => { throw new Error('must not be called'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => { receivedContexts.push(context); return { score: 70, breakdown: {} }; },
  });

  assert.deepEqual(receivedContexts, [{ naverResearch: null }]);
});

test('analyzeProductLinks loads Codex config and passes it through as codexConfig, plus rootDir', async () => {
  let receivedOpts = null;
  await analyzeProductLinks({}, ['1'], {}, {
    rootDir: '/custom/root',
    naverResearchEnabled: false,
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
    naverResearchEnabled: false,
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
    naverResearchEnabled: false,
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
    naverResearchEnabled: false,
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
    naverResearchEnabled: false,
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
    naverResearchEnabled: false,
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: {} }),
    insertLinkAnalysisHistoryImpl: async () => { throw new Error('must not be called without a db'); },
  });
});

test('analyzeProductLinks does not fail the response when the history insert itself rejects', async () => {
  const results = await analyzeProductLinks({}, ['1'], {}, {
    db: { name: 'db' },
    aiScoringEnabled: false,
    naverResearchEnabled: false,
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: {} }),
    insertLinkAnalysisHistoryImpl: async () => { throw new Error('db down'); },
  });
  assert.equal(results[0].score, 70);
});

// 2026-08-22 사용자 요청: naverCompetition이 "링크 입력"에서 늘 "데이터 없음"
// 이었던 걸 실시간 검색으로 채운다 -- draft가 없어도 되는, 저장 없는 검색.
test('analyzeProductLinks looks up live Naver competition by the candidate\'s own name and naverSalePrice, merging it into the score context as naverResearch', async () => {
  let receivedArgs = null;
  const results = await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    loadNaverConfigImpl: async () => ({ clientId: 'id', clientSecret: 'secret' }),
    checkNaverCompetitionLiveImpl: async (client, keyword, mySalePrice) => { receivedArgs = { client, keyword, mySalePrice }; return { competitorCount: 5, priceGapRate: 0.02 }; },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: '여성 벨트' }, filter: { filterStatus: 'pass' }, prices: { naverSalePrice: 15000 } }],
    computeCompetitivenessScoreImpl: (candidate, context) => ({ score: context.naverResearch.competitorCount, breakdown: {} }),
  });

  assert.equal(receivedArgs.keyword, '여성 벨트');
  assert.equal(receivedArgs.mySalePrice, 15000);
  assert.equal(results[0].score, 5);
});

test('analyzeProductLinks does not attempt a Naver lookup when naverResearchEnabled is false, without loading Naver config', async () => {
  await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    naverResearchEnabled: false,
    loadNaverConfigImpl: async () => { throw new Error('must not be called'); },
    checkNaverCompetitionLiveImpl: async () => { throw new Error('must not be called'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 1, breakdown: {} }),
  });
});

test('analyzeProductLinks falls back to naverResearch:null (proxy-only) when Naver credentials are unconfigured (loadNaverConfig throws) or the search itself fails', async () => {
  const unconfigured = await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    loadNaverConfigImpl: async () => { throw new Error('NAVER_CLIENT_ID is missing in .env'); },
    checkNaverCompetitionLiveImpl: async () => { throw new Error('must not be called'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => ({ score: context.naverResearch === null ? 1 : 0, breakdown: {} }),
  });
  assert.equal(unconfigured[0].score, 1);

  const searchFailed = await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    loadNaverConfigImpl: async () => ({ clientId: 'id', clientSecret: 'secret' }),
    checkNaverCompetitionLiveImpl: async () => { throw new Error('Naver Shopping API failed: HTTP 404'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => ({ score: context.naverResearch === null ? 1 : 0, breakdown: {} }),
  });
  assert.equal(searchFailed[0].score, 1);
});
