import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSpeedgoRunJournal, redactSpeedgoValue } from '../src/speedgo-artifacts.mjs';

test('redactSpeedgoValue removes nested credentials and bearer tokens', () => {
  const value = redactSpeedgoValue({
    password: 'secret',
    cookie: 'sid=abc',
    headers: { authorization: 'Bearer token-1' },
    nested: [{ accessToken: 'token-2', message: 'Bearer token-3 in text' }],
    safe: 'ok',
  });

  assert.deepEqual(value, {
    password: '[REDACTED]',
    cookie: '[REDACTED]',
    headers: { authorization: '[REDACTED]' },
    nested: [{ accessToken: '[REDACTED]', message: 'Bearer [REDACTED] in text' }],
    safe: 'ok',
  });
});

test('redactSpeedgoValue removes free-form credential assignments and authorization headers', () => {
  const value = redactSpeedgoValue(
    'safe prefix cookie=sid=abc password=secret token=abc secret=abc Authorization: Basic abc Bearer abc safe suffix',
  );

  assert.equal(
    value,
    'safe prefix cookie=[REDACTED] password=[REDACTED] token=[REDACTED] secret=[REDACTED] Authorization: [REDACTED] Bearer [REDACTED] safe suffix',
  );
});

test('journal writes ordered stages and a terminal result JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'speedgo-journal-'));
  try {
    const journal = await createSpeedgoRunJournal({
      artifactDir: dir,
      draftId: 501,
      now: () => new Date('2026-08-04T00:00:00Z'),
    });
    await journal.recordStep('draft_loaded', { supplierProductNo: '49168396' });
    await journal.recordStep('fields_filled', { headers: { authorization: 'Bearer hidden' } });
    await journal.finish({ status: 'completed', originProductNo: '777' });

    const saved = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
    assert.equal(saved.draftId, 501);
    assert.equal(saved.startedAt, '2026-08-04T00:00:00.000Z');
    assert.deepEqual(saved.steps.map((step) => step.stage), ['draft_loaded', 'fields_filled']);
    assert.equal(saved.steps[1].details.headers.authorization, '[REDACTED]');
    assert.equal(saved.result.originProductNo, '777');
    await assert.rejects(access(join(dir, 'result.json.tmp')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('journal records redacted failures and screenshot metadata on the current step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'speedgo-journal-'));
  try {
    const journal = await createSpeedgoRunJournal({
      artifactDir: dir,
      draftId: 502,
      now: () => new Date('2026-08-04T01:02:03Z'),
    });
    await journal.recordStep('submit', { note: 'Bearer secret-token' });
    await journal.setScreenshot('submit', 'screenshots/submit.png', { currentUrl: 'https://example.test/submit' });
    await journal.recordFailure({ code: 'SPEEDGO_FAILED', message: 'cookie=sid=abc Bearer secret-token' });

    const saved = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
    assert.deepEqual(saved.steps[0].screenshot, {
      path: 'screenshots/submit.png',
      currentUrl: 'https://example.test/submit',
    });
    assert.deepEqual(saved.failure, {
      code: 'SPEEDGO_FAILED',
      message: 'cookie=[REDACTED] Bearer [REDACTED]',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('journal derives the default artifact directory from rootDir, draftId, and clock', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'speedgo-root-'));
  try {
    const journal = await createSpeedgoRunJournal({
      rootDir,
      draftId: 503,
      now: () => new Date('2026-08-04T02:03:04Z'),
    });
    await journal.finish({ status: 'failed' });

    const expectedDir = join(rootDir, 'artifacts', 'speedgo', '503', '2026-08-04T02-03-04.000Z');
    const saved = JSON.parse(await readFile(join(expectedDir, 'result.json'), 'utf8'));
    assert.equal(saved.result.status, 'failed');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
