import assert from 'node:assert/strict';
import test from 'node:test';

import anthropicProvider from '../src/ai/providers/anthropic-provider.mjs';

function available({ loggedIn = true } = {}) {
  return async () => ({ available: true, loggedIn, version: '2.1.197', message: loggedIn ? 'Logged in (pro)' : 'Not logged in' });
}

test('analyzeImages throws NO_IMAGES when the images array is empty', async () => {
  await assert.rejects(
    () => anthropicProvider.analyzeImages({}, { images: [], prompt: 'check' }),
    (error) => error.code === 'NO_IMAGES',
  );
});

test('analyzeImages throws MISSING_PROMPT when no prompt is supplied', async () => {
  await assert.rejects(
    () => anthropicProvider.analyzeImages({}, { images: [{ filePath: '/tmp/a.jpg' }] }),
    (error) => error.code === 'MISSING_PROMPT',
  );
});

test('analyzeImages throws CLAUDE_CLI_UNAVAILABLE without calling runReviewImpl when the CLI is not logged in', async () => {
  let called = false;
  await assert.rejects(
    () => anthropicProvider.analyzeImages(
      {},
      { images: [{ filePath: '/tmp/a.jpg' }], prompt: 'check' },
      { checkAvailabilityImpl: available({ loggedIn: false }), runReviewImpl: async () => { called = true; } },
    ),
    (error) => error.code === 'CLAUDE_CLI_UNAVAILABLE' && /Not logged in/.test(error.message),
  );
  assert.equal(called, false);
});

test('analyzeImages passes local file paths (not raw image objects) and the prompt to runReviewImpl, defaulting to the sonnet model', async () => {
  const calls = [];
  const result = await anthropicProvider.analyzeImages(
    {},
    { images: [{ filePath: '/tmp/main.jpg' }, { filePath: '/tmp/detail-01.jpg' }], prompt: 'review these' },
    {
      checkAvailabilityImpl: available(),
      runReviewImpl: async (args) => { calls.push(args); return { model: 'sonnet', rawText: '{"pass":true}', usage: { input_tokens: 5 } }; },
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].images, ['/tmp/main.jpg', '/tmp/detail-01.jpg']);
  assert.equal(calls[0].prompt, 'review these');
  assert.equal(calls[0].config.model, 'sonnet');
  assert.equal(result.rawText, '{"pass":true}');
  assert.equal(result.model, 'sonnet');
  assert.deepEqual(result.usage, { input_tokens: 5 });
});

test('analyzeImages uses config.model over the default when supplied', async () => {
  const calls = [];
  await anthropicProvider.analyzeImages(
    { model: 'opus' },
    { images: [{ filePath: '/tmp/a.jpg' }], prompt: 'x' },
    { checkAvailabilityImpl: available(), runReviewImpl: async (args) => { calls.push(args); return { model: 'opus', rawText: 'ok' }; } },
  );
  assert.equal(calls[0].config.model, 'opus');
});

test('analyzeImages wraps a thrown CLI error as ANTHROPIC_API_ERROR rather than propagating it raw', async () => {
  await assert.rejects(
    () => anthropicProvider.analyzeImages(
      {},
      { images: [{ filePath: '/tmp/a.jpg' }], prompt: 'check' },
      { checkAvailabilityImpl: available(), runReviewImpl: async () => { throw Object.assign(new Error('claude exited with code 1'), { code: 'CLAUDE_CLI_ERROR' }); } },
    ),
    (error) => error.code === 'ANTHROPIC_API_ERROR' && /claude exited with code 1/.test(error.message),
  );
});

test('anthropic provider still has no image_generation/image_edit capability -- reviewer, not generator', () => {
  assert.deepEqual(anthropicProvider.capabilities, ['text_generation', 'vision_analysis']);
});
