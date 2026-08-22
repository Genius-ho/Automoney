import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeProductLinks } from '../src/product-link-analysis.mjs';

// Every test below stubs computeAiScoringContextImpl/loadClaudeCliConfigImpl
// -- their real implementations spawn the actual `claude` CLI, which is slow
// and non-deterministic in a unit test (confirmed: ~15s/candidate when left
// unmocked, since the real subprocess spawn/failure path isn't instant).
const noAiScoring = { loadClaudeCliConfigImpl: async () => ({ executable: 'claude' }), computeAiScoringContextImpl: async () => ({}) };

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
    loadClaudeCliConfigImpl: async () => ({ executable: 'claude' }),
    computeAiScoringContextImpl: async (candidate) => ({ aiImageQuality: { points: 10, reason: `[AI] for ${candidate.productNo}` } }),
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => { receivedContexts.push(context); return { score: 70, breakdown: {} }; },
  });

  assert.deepEqual(receivedContexts, [{ aiImageQuality: { points: 10, reason: '[AI] for 1' } }]);
});

test('analyzeProductLinks skips AI scoring entirely (empty context) when aiScoringEnabled is false, without loading Claude CLI or Codex config', async () => {
  const receivedContexts = [];
  await analyzeProductLinks({}, ['1'], {}, {
    aiScoringEnabled: false,
    loadClaudeCliConfigImpl: async () => { throw new Error('must not be called'); },
    loadCodexConfigImpl: async () => { throw new Error('must not be called'); },
    computeAiScoringContextImpl: async () => { throw new Error('must not be called'); },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: (candidate, context) => { receivedContexts.push(context); return { score: 70, breakdown: {} }; },
  });

  assert.deepEqual(receivedContexts, [{}]);
});

test('analyzeProductLinks loads both Claude and Codex config and passes them through as claudeConfig/codexConfig, plus rootDir', async () => {
  let receivedOpts = null;
  await analyzeProductLinks({}, ['1'], {}, {
    rootDir: '/custom/root',
    loadClaudeCliConfigImpl: async () => ({ executable: 'claude' }),
    loadCodexConfigImpl: async () => ({ executable: 'codex' }),
    computeAiScoringContextImpl: async (candidate, titles, opts) => { receivedOpts = opts; return {}; },
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: {} }),
  });

  assert.equal(receivedOpts.claudeConfig.executable, 'claude');
  assert.equal(receivedOpts.codexConfig.executable, 'codex');
  assert.equal(receivedOpts.rootDir, '/custom/root');
});

test('analyzeProductLinks falls back to an empty (proxy-only) context, not a thrown error, when AI scoring itself rejects', async () => {
  const results = await analyzeProductLinks({}, ['1'], {}, {
    loadClaudeCliConfigImpl: async () => ({ executable: 'claude' }),
    computeAiScoringContextImpl: async () => { throw new Error('claude CLI not logged in'); },
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
    loadClaudeCliConfigImpl: async () => ({ executable: 'claude' }),
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
    loadClaudeCliConfigImpl: async () => ({ executable: 'claude' }),
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
    loadClaudeCliConfigImpl: async () => ({ executable: 'claude' }),
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
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: {} }),
    insertLinkAnalysisHistoryImpl: async () => { throw new Error('must not be called without a db'); },
  });
});

test('analyzeProductLinks does not fail the response when the history insert itself rejects', async () => {
  const results = await analyzeProductLinks({}, ['1'], {}, {
    db: { name: 'db' },
    aiScoringEnabled: false,
    evaluateCandidatesImpl: async () => [{ productNo: '1', normalized: { name: 'A' }, filter: { filterStatus: 'pass' }, prices: {} }],
    computeCompetitivenessScoreImpl: () => ({ score: 70, breakdown: {} }),
    insertLinkAnalysisHistoryImpl: async () => { throw new Error('db down'); },
  });
  assert.equal(results[0].score, 70);
});
