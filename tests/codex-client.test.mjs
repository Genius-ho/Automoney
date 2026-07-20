import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkCodexAvailability, checkCodexImageGenerationAvailable, runCodexAnalysis, runCodexImagePrompt } from '../src/codex-client.mjs';

// A minimal fake child_process.ChildProcess -- enough surface for
// codex-client.mjs to drive (stdout/stderr 'data', 'error', 'close', a
// writable stdin, and kill()).
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => child.emit('close', null);
  return child;
}

test('checkCodexAvailability reports unavailable without throwing when the executable cannot be spawned (ENOENT)', async () => {
  const spawnImpl = () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); };
  const result = await checkCodexAvailability({ config: { executable: 'codex' }, spawnImpl });
  assert.equal(result.available, false);
  assert.equal(result.loggedIn, false);
  assert.match(result.message, /ENOENT/);
});

test('checkCodexAvailability reports available+loggedIn when version and login status both succeed', async () => {
  let call = 0;
  const spawnImpl = () => {
    call += 1;
    const child = fakeChild();
    queueMicrotask(() => {
      if (call === 1) child.stdout.emit('data', 'codex-cli 0.144.1\n');
      else child.stdout.emit('data', 'Logged in using ChatGPT\n');
      child.emit('close', 0);
    });
    return child;
  };
  const result = await checkCodexAvailability({ config: { executable: 'codex' }, spawnImpl });
  assert.equal(result.available, true);
  assert.equal(result.loggedIn, true);
  assert.equal(result.version, 'codex-cli 0.144.1');
});

test('checkCodexAvailability reports available but not logged in when login status fails/expires', async () => {
  let call = 0;
  const spawnImpl = () => {
    call += 1;
    const child = fakeChild();
    queueMicrotask(() => {
      if (call === 1) { child.stdout.emit('data', 'codex-cli 0.144.1\n'); child.emit('close', 0); }
      else { child.stdout.emit('data', 'Not logged in\n'); child.emit('close', 1); }
    });
    return child;
  };
  const result = await checkCodexAvailability({ config: { executable: 'codex' }, spawnImpl });
  assert.equal(result.available, true);
  assert.equal(result.loggedIn, false);
});

test('runCodexAnalysis returns success:false without touching the output file when the process exits non-zero', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => { child.stderr.emit('data', 'boom'); child.emit('close', 1); });
    return child;
  };
  const result = await runCodexAnalysis({
    config: { executable: 'codex', concurrency: 1, timeoutMs: 5000 },
    cwd: tmpdir(),
    images: [],
    schemaPath: 'schema.json',
    outputPath: join(tmpdir(), 'does-not-exist-codex-test.json'),
    prompt: 'test',
    spawnImpl,
  });
  assert.equal(result.success, false);
  assert.match(result.log, /boom/);
  assert.equal(result.analysis, null);
});

test('runCodexAnalysis parses the JSON the CLI wrote to outputPath on success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-test-'));
  const outputPath = join(dir, 'result.json');
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(async () => {
      await writeFile(outputPath, JSON.stringify({ ok: true }));
      child.emit('close', 0);
    });
    return child;
  };
  try {
    const result = await runCodexAnalysis({
      config: { executable: 'codex', concurrency: 1, timeoutMs: 5000 },
      cwd: dir,
      images: ['a.jpg'],
      schemaPath: 'schema.json',
      outputPath,
      prompt: 'test',
      spawnImpl,
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.analysis, { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCodexAnalysis writes the prompt to stdin, never as a spawn argument', async () => {
  let receivedArgs = null;
  let receivedStdin = '';
  const dir = await mkdtemp(join(tmpdir(), 'codex-test-'));
  const outputPath = join(dir, 'result.json');
  const spawnImpl = (executable, args) => {
    receivedArgs = args;
    const child = fakeChild();
    child.stdin.write = (text) => { receivedStdin += text; };
    queueMicrotask(async () => {
      await writeFile(outputPath, JSON.stringify({ ok: true }));
      child.emit('close', 0);
    });
    return child;
  };
  try {
    await runCodexAnalysis({
      config: { executable: 'codex', concurrency: 1, timeoutMs: 5000 },
      cwd: dir,
      images: [],
      schemaPath: 'schema.json',
      outputPath,
      prompt: 'sensitive supplier text; $(rm -rf /) & echo hi',
      spawnImpl,
    });
    assert.equal(receivedStdin, 'sensitive supplier text; $(rm -rf /) & echo hi');
    assert.ok(!receivedArgs.some((arg) => arg.includes('rm -rf')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCodexAnalysis respects concurrency=1: a second call does not start until the first finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-test-'));
  let active = 0;
  let maxActive = 0;
  try {
    const results = await Promise.all([1, 2, 3].map(async (n) => {
      const outputPath = join(dir, `out-${n}.json`);
      return runCodexAnalysis({
        config: { executable: 'codex', concurrency: 1, timeoutMs: 5000 },
        cwd: dir,
        images: [],
        schemaPath: 'schema.json',
        outputPath,
        prompt: 'test',
        spawnImpl: () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          const child = fakeChild();
          setTimeout(async () => {
            await writeFile(outputPath, JSON.stringify({ n }));
            active -= 1;
            child.emit('close', 0);
          }, 30);
          return child;
        },
      });
    }));
    assert.equal(maxActive, 1, 'no more than one Codex process should run at a time with concurrency=1');
    assert.equal(results.every((r) => r.success), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkCodexImageGenerationAvailable reports true only when the real "image_generation" feature line says true', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', 'apps                                  stable             true\nimage_generation                     stable             true\nmemories                             experimental       false\n');
      child.emit('close', 0);
    });
    return child;
  };
  const result = await checkCodexImageGenerationAvailable({ config: { executable: 'codex' }, spawnImpl });
  assert.equal(result.available, true);
  assert.match(result.message, /image_generation/);
});

test('checkCodexImageGenerationAvailable reports false when the feature line says false, without guessing', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', 'image_generation                     stable             false\n');
      child.emit('close', 0);
    });
    return child;
  };
  const result = await checkCodexImageGenerationAvailable({ config: { executable: 'codex' }, spawnImpl });
  assert.equal(result.available, false);
});

test('checkCodexImageGenerationAvailable reports false when the feature is not listed at all by this CLI version', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => { child.stdout.emit('data', 'apps stable true\n'); child.emit('close', 0); });
    return child;
  };
  const result = await checkCodexImageGenerationAvailable({ config: { executable: 'codex' }, spawnImpl });
  assert.equal(result.available, false);
  assert.match(result.message, /not listed/);
});

test('checkCodexImageGenerationAvailable reports false without throwing when `codex features list` itself fails', async () => {
  const spawnImpl = () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); };
  const result = await checkCodexImageGenerationAvailable({ config: { executable: 'codex' }, spawnImpl });
  assert.equal(result.available, false);
});

test('runCodexImagePrompt attaches every image via -i and writes the prompt to stdin (never as an argv item)', async () => {
  let receivedArgs = null;
  let receivedStdin = '';
  const spawnImpl = (executable, args) => {
    receivedArgs = args;
    const child = fakeChild();
    child.stdin.write = (text) => { receivedStdin += text; };
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const result = await runCodexImagePrompt({
    config: { executable: 'codex', concurrency: 1 },
    cwd: tmpdir(),
    images: ['/tmp/a.jpg', '/tmp/b.jpg'],
    prompt: 'generate a product photo; do not leak this text into argv',
    timeoutMs: 5000,
    spawnImpl,
  });
  assert.equal(result.success, true);
  assert.equal(receivedStdin, 'generate a product photo; do not leak this text into argv');
  assert.deepEqual(receivedArgs.filter((a, i) => receivedArgs[i - 1] === '-i'), ['/tmp/a.jpg', '/tmp/b.jpg']);
  assert.ok(!receivedArgs.includes('--output-schema'), 'image generation has no structured-output schema, unlike runCodexAnalysis');
});

test('runCodexImagePrompt reports timedOut without hanging when the process never exits', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    child.kill = () => {}; // simulate a process that ignores kill, same as runCodexAnalysis's own timeout test intent
    return child;
  };
  const result = await runCodexImagePrompt({
    config: { executable: 'codex', concurrency: 1 },
    cwd: tmpdir(),
    images: [],
    prompt: 'test',
    timeoutMs: 20,
    spawnImpl,
  });
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
});

test('runCodexImagePrompt surfaces a non-zero exit as success:false with the captured log', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => { child.stderr.emit('data', 'image generation tool unavailable'); child.emit('close', 1); });
    return child;
  };
  const result = await runCodexImagePrompt({
    config: { executable: 'codex', concurrency: 1 },
    cwd: tmpdir(),
    images: [],
    prompt: 'test',
    timeoutMs: 5000,
    spawnImpl,
  });
  assert.equal(result.success, false);
  assert.match(result.log, /image generation tool unavailable/);
});
