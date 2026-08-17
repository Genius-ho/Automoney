import assert from 'node:assert/strict';
import test from 'node:test';

import { encryptCredential } from '../src/ai/credential-crypto.mjs';
import { resolveProviderCredential } from '../src/ai/provider-settings-store.mjs';

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
