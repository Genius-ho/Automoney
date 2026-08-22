import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeAiScoringContext,
  scoreImageQualityWithAi,
  scoreTextJudgmentsWithAi,
} from '../src/ai-competitiveness-scoring.mjs';
import { WEIGHTS } from '../src/competitiveness-score.mjs';

test('scoreImageQualityWithAi falls back to the proxy without calling Codex when there are no images', async () => {
  const result = await scoreImageQualityWithAi([], {
    config: {},
    runCodexAnalysisImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.points, 0);
  assert.match(result.reason, /이미지 0장/);
});

test('scoreImageQualityWithAi downloads at most 3 images, runs Codex with the fixed model/reasoningEffort override + the image-quality JSON schema, scales the score, and cleans up', async () => {
  const images = ['https://a.test/1.jpg', 'https://a.test/2.jpg', 'https://a.test/3.jpg', 'https://a.test/4.jpg'];
  const downloadedUrls = [];
  const cleanedUp = [];
  let receivedArgs = null;
  const result = await scoreImageQualityWithAi(images, {
    config: { executable: 'codex', concurrency: 2 },
    rootDir: '/home/ho/automoney',
    loadRemoteImageForVisionImpl: async (url) => {
      downloadedUrls.push(url);
      return { filePath: `/tmp/${url.split('/').pop()}`, cleanup: async () => cleanedUp.push(url) };
    },
    runCodexAnalysisImpl: async (args) => {
      receivedArgs = args;
      return { success: true, analysis: { score: 80, reason: '선명하고 구도가 좋음' } };
    },
  });

  assert.deepEqual(downloadedUrls, images.slice(0, 3));
  assert.equal(receivedArgs.images.length, 3);
  assert.match(receivedArgs.schemaPath, /schemas\/image-quality-score\.schema\.json$/);
  assert.ok(receivedArgs.outputPath);
  // Fixed model/effort override, applied on top of whatever the caller's
  // codexConfig otherwise carries (executable/concurrency preserved here).
  assert.equal(receivedArgs.config.model, 'gpt-5.6-luna');
  assert.equal(receivedArgs.config.reasoningEffort, 'xhigh');
  assert.equal(receivedArgs.config.executable, 'codex');
  assert.equal(receivedArgs.config.concurrency, 2);
  assert.equal(result.points, (80 / 100) * WEIGHTS.imageQuality);
  assert.match(result.reason, /^\[AI\] 선명하고 구도가 좋음$/);
  assert.deepEqual(cleanedUp, images.slice(0, 3));
});

test('scoreImageQualityWithAi propagates a Codex failure (the caller, computeAiScoringContext, is what falls back to the proxy) but still cleans up the downloaded temp files', async () => {
  const cleanedUp = [];
  await assert.rejects(
    () => scoreImageQualityWithAi(['https://a.test/1.jpg'], {
      config: {},
      loadRemoteImageForVisionImpl: async () => ({ filePath: '/tmp/x.jpg', cleanup: async () => cleanedUp.push('x') }),
      runCodexAnalysisImpl: async () => ({ success: false, log: 'codex not logged in' }),
    }),
    (error) => error.code === 'CODEX_IMAGE_QUALITY_FAILED' && /codex not logged in/.test(error.message),
  );
  assert.deepEqual(cleanedUp, ['x']);
});

test('scoreTextJudgmentsWithAi asks Codex for returnRisk, tells it to answer duplicateScore/duplicateReason as null when there are no existing draft titles, and leaves duplicateRisk on the proxy when it does', async () => {
  let receivedArgs = null;
  const result = await scoreTextJudgmentsWithAi({ name: '유리컵 세트', options: [{ name: '색상', value: '투명' }], sellUnitType: 'single' }, [], {
    config: { executable: 'codex' },
    rootDir: '/home/ho/automoney',
    runCodexAnalysisImpl: async (args) => {
      receivedArgs = args;
      return { success: true, analysis: { returnRiskScore: 30, returnRiskReason: '파손 위험 소재', duplicateScore: null, duplicateReason: null } };
    },
  });

  assert.match(receivedArgs.prompt, /유리컵 세트/);
  assert.match(receivedArgs.prompt, /duplicateScore와 duplicateReason은 null로 답해라/);
  assert.match(receivedArgs.schemaPath, /schemas\/return-duplicate-risk-score\.schema\.json$/);
  assert.equal(receivedArgs.config.model, 'gpt-5.6-luna');
  assert.equal(receivedArgs.config.reasoningEffort, 'xhigh');
  assert.equal(result.returnRisk.points, (30 / 100) * WEIGHTS.returnRisk);
  assert.match(result.returnRisk.reason, /^\[AI\] 파손 위험 소재$/);
  // Codex answered null (as instructed) -- duplicateRisk proxy's own
  // default-max-points path, not an AI-judged value.
  assert.equal(result.duplicateRisk.points, WEIGHTS.duplicateRisk);
});

test('scoreTextJudgmentsWithAi asks for and scales both scores when existing draft titles are given', async () => {
  let receivedArgs = null;
  const result = await scoreTextJudgmentsWithAi({ name: '수납 정리함 대형' }, ['수납 정리함 소형', '벨트'], {
    config: {},
    runCodexAnalysisImpl: async (args) => {
      receivedArgs = args;
      return { success: true, analysis: { returnRiskScore: 90, returnRiskReason: '단순 상품', duplicateScore: 40, duplicateReason: '기존 소형과 유사' } };
    },
  });

  assert.match(receivedArgs.prompt, /수납 정리함 소형/);
  assert.match(receivedArgs.prompt, /duplicateScore로 0~100점/);
  assert.equal(result.returnRisk.points, (90 / 100) * WEIGHTS.returnRisk);
  assert.equal(result.duplicateRisk.points, (40 / 100) * WEIGHTS.duplicateRisk);
  assert.match(result.duplicateRisk.reason, /^\[AI\] 기존 소형과 유사$/);
});

test('scoreTextJudgmentsWithAi propagates a Codex failure', async () => {
  await assert.rejects(
    () => scoreTextJudgmentsWithAi({ name: 'A' }, [], {
      config: {},
      runCodexAnalysisImpl: async () => ({ success: false, log: 'codex timeout' }),
    }),
    (error) => error.code === 'CODEX_RISK_JUDGMENT_FAILED' && /codex timeout/.test(error.message),
  );
});

test('computeAiScoringContext runs both Codex calls (image + text judgments) with the same codexConfig/rootDir and returns a context fragment ready for computeCompetitivenessScore', async () => {
  let receivedImageArgs = null;
  let receivedTextArgs = null;
  const context = await computeAiScoringContext(
    { normalized: { name: 'A', images: ['https://a.test/1.jpg'] }, filter: {} },
    ['기존 상품'],
    {
      codexConfig: { executable: 'codex' },
      rootDir: '/home/ho/automoney',
      scoreImageQualityWithAiImpl: async (images, opts) => { receivedImageArgs = { images, opts }; return { points: 8, reason: '[AI] good' }; },
      scoreTextJudgmentsWithAiImpl: async (normalized, titles, opts) => { receivedTextArgs = { normalized, titles, opts }; return { returnRisk: { points: 7, reason: '[AI] safe' }, duplicateRisk: { points: 5, reason: '[AI] unique' } }; },
    },
  );

  assert.deepEqual(context, {
    aiImageQuality: { points: 8, reason: '[AI] good' },
    aiReturnRisk: { points: 7, reason: '[AI] safe' },
    aiDuplicateRisk: { points: 5, reason: '[AI] unique' },
  });
  assert.equal(receivedImageArgs.opts.config.executable, 'codex');
  assert.equal(receivedImageArgs.opts.rootDir, '/home/ho/automoney');
  assert.equal(receivedTextArgs.opts.config.executable, 'codex');
  assert.equal(receivedTextArgs.opts.rootDir, '/home/ho/automoney');
});

test('computeAiScoringContext falls back independently per dimension -- one AI call failing does not affect the other', async () => {
  const context = await computeAiScoringContext(
    { normalized: { name: 'A', images: [] }, filter: {} },
    [],
    {
      codexConfig: {},
      scoreImageQualityWithAiImpl: async () => { throw new Error('codex not logged in'); },
      scoreTextJudgmentsWithAiImpl: async () => ({ returnRisk: { points: 7, reason: '[AI] safe' }, duplicateRisk: { points: 5, reason: '[AI] unique' } }),
    },
  );

  // imageQuality fell back to the real proxy (0 images -> 0 points), text
  // judgments succeeded and were used as-is.
  assert.equal(context.aiImageQuality.points, 0);
  assert.deepEqual(context.aiReturnRisk, { points: 7, reason: '[AI] safe' });
  assert.deepEqual(context.aiDuplicateRisk, { points: 5, reason: '[AI] unique' });
});

test('computeAiScoringContext falls back to both proxies when the text-judgments call fails', async () => {
  const context = await computeAiScoringContext(
    { normalized: { name: 'A', images: [], sellUnitType: 'single' }, filter: {} },
    [],
    {
      codexConfig: {},
      scoreImageQualityWithAiImpl: async () => ({ points: 9, reason: '[AI] good' }),
      scoreTextJudgmentsWithAiImpl: async () => { throw new Error('codex timeout'); },
    },
  );

  assert.deepEqual(context.aiImageQuality, { points: 9, reason: '[AI] good' });
  assert.equal(context.aiReturnRisk.points, WEIGHTS.returnRisk * 0.8); // single-item proxy default
  assert.equal(context.aiDuplicateRisk.points, WEIGHTS.duplicateRisk); // no titles -> proxy default max
});
