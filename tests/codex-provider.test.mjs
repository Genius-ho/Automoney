import assert from 'node:assert/strict';
import test from 'node:test';

import codex from '../src/ai/providers/codex-provider.mjs';

test('codex provider exposes local-session text and vision capabilities', () => {
  assert.deepEqual(codex.capabilities, [
    'text_generation', 'vision_analysis', 'image_generation', 'image_edit',
  ]);
});

test('codex provider maps unavailable CLI to a reportable provider error', async () => {
  await assert.rejects(
    () => codex.analyzeImages({ executable: 'codex' }, {
      images: [{ filePath: '/tmp/a.jpg' }], prompt: 'review', schemaPath: 'schema.json', outputPath: '/tmp/result.json', cwd: '/tmp',
    }, {
      checkAvailabilityImpl: async () => ({ available: false, loggedIn: false, message: 'not logged in' }),
    }),
    (error) => error.code === 'CODEX_CLI_UNAVAILABLE',
  );
});

test('codex provider passes structured text analysis through with configured model', async () => {
  let request;
  const result = await codex.generateText({ model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' }, {
    prompt: 'extract keywords', schemaPath: 'schema.json', outputPath: '/tmp/result.json', cwd: '/tmp',
  }, {
    checkAvailabilityImpl: async () => ({ available: true, loggedIn: true }),
    runAnalysisImpl: async (value) => {
      request = value;
      return { success: true, analysis: { keywords: ['여성 벨트'] }, log: '' };
    },
  });
  assert.deepEqual(result.analysis, { keywords: ['여성 벨트'] });
  assert.equal(request.config.model, 'gpt-5.6-luna');
  assert.equal(request.config.reasoningEffort, 'xhigh');
});
