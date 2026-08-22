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

test('scoreImageQualityWithAi downloads at most 3 images, runs Codex with them as cwd-local paths + the image-quality JSON schema, scales the score, and cleans up', async () => {
  const images = ['https://a.test/1.jpg', 'https://a.test/2.jpg', 'https://a.test/3.jpg', 'https://a.test/4.jpg'];
  const downloadedUrls = [];
  const cleanedUp = [];
  let receivedArgs = null;
  const result = await scoreImageQualityWithAi(images, {
    config: { executable: 'codex' },
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

test('scoreTextJudgmentsWithAi asks for and scales returnRiskScore only when there are no existing draft titles to compare against, leaving duplicateRisk on the proxy', async () => {
  let receivedPrompt = null;
  const result = await scoreTextJudgmentsWithAi({ name: '유리컵 세트', options: [{ name: '색상', value: '투명' }], sellUnitType: 'single' }, [], {
    config: {},
    runClaudeTextPromptImpl: async ({ prompt }) => { receivedPrompt = prompt; return { rawText: '{"returnRiskScore": 30, "returnRiskReason": "파손 위험 소재"}' }; },
  });

  assert.match(receivedPrompt, /유리컵 세트/);
  assert.doesNotMatch(receivedPrompt, /기존 등록 상품명 목록/);
  assert.equal(result.returnRisk.points, (30 / 100) * WEIGHTS.returnRisk);
  assert.match(result.returnRisk.reason, /^\[AI\] 파손 위험 소재$/);
  // No comparison titles -- duplicateRisk proxy's own default-max-points path.
  assert.equal(result.duplicateRisk.points, WEIGHTS.duplicateRisk);
});

test('scoreTextJudgmentsWithAi asks for and scales both scores when existing draft titles are given', async () => {
  let receivedPrompt = null;
  const result = await scoreTextJudgmentsWithAi({ name: '수납 정리함 대형' }, ['수납 정리함 소형', '벨트'], {
    config: {},
    runClaudeTextPromptImpl: async ({ prompt }) => {
      receivedPrompt = prompt;
      return { rawText: '{"returnRiskScore": 90, "returnRiskReason": "단순 상품", "duplicateScore": 40, "duplicateReason": "기존 소형과 유사"}' };
    },
  });

  assert.match(receivedPrompt, /수납 정리함 소형/);
  assert.match(receivedPrompt, /duplicateScore/);
  assert.equal(result.returnRisk.points, (90 / 100) * WEIGHTS.returnRisk);
  assert.equal(result.duplicateRisk.points, (40 / 100) * WEIGHTS.duplicateRisk);
  assert.match(result.duplicateRisk.reason, /^\[AI\] 기존 소형과 유사$/);
});

test('computeAiScoringContext runs the Codex image call and the Claude text call and returns a context fragment ready for computeCompetitivenessScore', async () => {
  let receivedImageArgs = null;
  let receivedTextArgs = null;
  const context = await computeAiScoringContext(
    { normalized: { name: 'A', images: ['https://a.test/1.jpg'] }, filter: {} },
    ['기존 상품'],
    {
      codexConfig: { executable: 'codex' },
      claudeConfig: { executable: 'claude' },
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
  assert.equal(receivedTextArgs.opts.config.executable, 'claude');
});

test('computeAiScoringContext falls back independently per dimension -- one AI call failing does not affect the other', async () => {
  const context = await computeAiScoringContext(
    { normalized: { name: 'A', images: [] }, filter: {} },
    [],
    {
      codexConfig: {},
      claudeConfig: {},
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
      claudeConfig: {},
      scoreImageQualityWithAiImpl: async () => ({ points: 9, reason: '[AI] good' }),
      scoreTextJudgmentsWithAiImpl: async () => { throw new Error('claude CLI timeout'); },
    },
  );

  assert.deepEqual(context.aiImageQuality, { points: 9, reason: '[AI] good' });
  assert.equal(context.aiReturnRisk.points, WEIGHTS.returnRisk * 0.8); // single-item proxy default
  assert.equal(context.aiDuplicateRisk.points, WEIGHTS.duplicateRisk); // no titles -> proxy default max
});
