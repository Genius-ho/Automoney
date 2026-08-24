import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadCodexConfig } from '../src/config.mjs';

async function tempRootWithEnv(values) {
  const root = await mkdtemp(join(tmpdir(), 'automoney-config-codex-'));
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await writeFile(join(root, '.env'), lines.join('\n'));
  return root;
}

test('loadCodexConfig defaults to the requested Luna xhigh target', async () => {
  const root = await tempRootWithEnv({});
  try {
    const config = await loadCodexConfig(root);
    assert.equal(config.model, 'gpt-5.6-luna');
    assert.equal(config.reasoningEffort, 'xhigh');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadCodexConfig accepts model and reasoning overrides', async () => {
  const root = await tempRootWithEnv({
    CODEX_MODEL: 'gpt-5.6-terra',
    CODEX_REASONING_EFFORT: 'high',
  });
  try {
    const config = await loadCodexConfig(root);
    assert.equal(config.model, 'gpt-5.6-terra');
    assert.equal(config.reasoningEffort, 'high');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
