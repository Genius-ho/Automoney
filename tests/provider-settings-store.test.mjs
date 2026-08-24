import assert from 'node:assert/strict';
import test from 'node:test';

import { encryptCredential } from '../src/ai/credential-crypto.mjs';
import { listProviderSettings, resolveProviderCredential } from '../src/ai/provider-settings-store.mjs';

const MASTER_KEY = '11'.repeat(32);

function fakeDb(row = null) {
  return {
    async query(sql, params) {
      assert.match(sql, /select \* from ai_provider_configs where provider_code=\$1/);
      assert.deepEqual(params, ['anthropic']);
      return { rows: row ? [row] : [] };
    },
  };
}

function fakeCodexSettingsDb(row) {
  return {
    async query(sql, params) {
      if (/select \* from ai_provider_configs order by provider_code/.test(sql)) return { rows: row ? [row] : [] };
      assert.match(sql, /select \* from ai_provider_configs where provider_code=\$1/);
      assert.deepEqual(params, ['codex']);
      return { rows: row ? [row] : [] };
    },
  };
}

test('resolveProviderCredential decrypts and returns the real DB-stored key when one exists', async () => {
  const encrypted = encryptCredential('sk-real-secret', MASTER_KEY);
  const db = fakeDb({
    api_key_ciphertext: encrypted.ciphertext, api_key_iv: encrypted.iv, api_key_auth_tag: encrypted.authTag,
    base_url: null, default_text_model: null, default_vision_model: 'claude-sonnet-5', default_image_model: null, enabled: true,
  });
  const result = await resolveProviderCredential(db, 'anthropic', { masterKey: MASTER_KEY });
  assert.equal(result.apiKey, 'sk-real-secret');
  assert.equal(result.defaultVisionModel, 'claude-sonnet-5');
  assert.equal(result.enabled, true);
});

test('resolveProviderCredential falls back to environment[ANTHROPIC_API_KEY] when no DB row is configured', async () => {
  const db = fakeDb(null);
  const result = await resolveProviderCredential(db, 'anthropic', { environment: { ANTHROPIC_API_KEY: 'sk-from-env' } });
  assert.equal(result.apiKey, 'sk-from-env');
  assert.equal(result.enabled, false);
});

test('resolveProviderCredential returns apiKey=null when neither DB nor environment has a credential', async () => {
  const db = fakeDb(null);
  const result = await resolveProviderCredential(db, 'anthropic', {});
  assert.equal(result.apiKey, null);
});

test('resolveProviderCredential throws (does not silently mask) when the DB ciphertext cannot be decrypted with the given masterKey', async () => {
  const encrypted = encryptCredential('sk-real-secret', MASTER_KEY);
  const db = fakeDb({ api_key_ciphertext: encrypted.ciphertext, api_key_iv: encrypted.iv, api_key_auth_tag: encrypted.authTag });
  await assert.rejects(() => resolveProviderCredential(db, 'anthropic', { masterKey: '22'.repeat(32) }));
});

test('resolveProviderCredential rejects an unsupported provider code the same way getProvider does', async () => {
  await assert.rejects(
    () => resolveProviderCredential(fakeDb(null), 'not-a-real-provider', {}),
    (error) => error.code === 'UNKNOWN_PROVIDER',
  );
});

test('listProviderSettings reports Codex as a local login provider without an API key', async () => {
  const result = await listProviderSettings(fakeCodexSettingsDb({
    provider_code: 'codex', display_name: 'OpenAI Codex', enabled: true,
    default_text_model: 'gpt-5.6-luna', default_vision_model: 'gpt-5.6-luna', default_image_model: 'gpt-5.6-luna',
    capabilities: ['text_generation', 'vision_analysis', 'image_generation', 'image_edit'],
  }));
  const codex = result.providers.find((provider) => provider.providerCode === 'codex');
  assert.equal(codex.configured, true);
  assert.equal(codex.credentialSource, 'codex_login');
  assert.equal(codex.maskedApiKey, null);
  assert.deepEqual(codex.models, { text: 'gpt-5.6-luna', vision: 'gpt-5.6-luna', image: 'gpt-5.6-luna' });
});
