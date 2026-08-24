import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('canonical schema permits Codex provider routing', async () => {
  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /provider_code in \('openai',\s*'google',\s*'anthropic',\s*'custom',\s*'codex'\)/);
});

test('Codex migration creates the provider and converts the generated-image review route', async () => {
  const migration = await readFile(new URL('../migrations/2026-08-24-codex-provider-routing.sql', import.meta.url), 'utf8');
  assert.match(migration, /insert into ai_provider_configs/i);
  assert.match(migration, /'codex'/i);
  assert.match(migration, /generated_image_review/i);
});
