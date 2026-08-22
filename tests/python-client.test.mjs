import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkPythonAvailability, runPythonAnalysis } from '../src/python-client.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  // Real child_process.kill() sends a signal; the 'close' event (if any)
  // only arrives later, asynchronously, after the OS actually reaps the
  // process -- never synchronously inside kill() itself. A no-op here
  // matches that: the caller's own timeout-driven finish() is what resolves
  // the promise, not a synthesized close.
  child.kill = () => {};
  return child;
}

test('checkPythonAvailability reports unavailable without throwing when the executable cannot be spawned (ENOENT)', async () => {
  const spawnImpl = () => { throw Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' }); };
  const result = await checkPythonAvailability({ config: { executable: 'python' }, spawnImpl });
  assert.equal(result.available, false);
  assert.match(result.message, /ENOENT/);
});

test('checkPythonAvailability treats the Windows Store app-alias stub (no real version string) as unavailable', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => { child.stdout.emit('data', 'Python\r\n'); child.emit('close', 49); });
    return child;
  };
  const result = await checkPythonAvailability({ config: { executable: 'python' }, spawnImpl });
  assert.equal(result.available, false);
});

test('checkPythonAvailability reports the real version when a genuine interpreter answers', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => { child.stdout.emit('data', 'Python 3.12.10\n'); child.emit('close', 0); });
    return child;
  };
  const result = await checkPythonAvailability({ config: { executable: 'python' }, spawnImpl });
  assert.equal(result.available, true);
  assert.equal(result.version, '3.12.10');
});

test('runPythonAnalysis parses valid JSON from stdout', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ material: { value: '벨벳', confidence: 0.6 } }));
      child.emit('close', 0);
    });
    return child;
  };
  const result = await runPythonAnalysis({ config: { executable: 'python' }, workerDir: '/workers/python', jobDir: '/jobs/draft-1', spawnImpl });
  assert.equal(result.success, true);
  assert.equal(result.analysis.material.value, '벨벳');
});

test('runPythonAnalysis rejects malformed JSON on stdout instead of crashing', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => { child.stdout.emit('data', 'not json {{{'); child.emit('close', 0); });
    return child;
  };
  const result = await runPythonAnalysis({ config: { executable: 'python' }, workerDir: '/workers/python', jobDir: '/jobs/draft-1', spawnImpl });
  assert.equal(result.success, false);
  assert.equal(result.analysis, null);
  assert.match(result.log, /failed to parse stdout as JSON/);
});

test('runPythonAnalysis reports timedOut and does not hang when the process never exits', async () => {
  const spawnImpl = () => fakeChild(); // never emits 'close' on its own
  const result = await runPythonAnalysis({
    config: { executable: 'python', timeoutMs: 30 },
    workerDir: '/workers/python',
    jobDir: '/jobs/draft-1',
    spawnImpl,
  });
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
});

test('runPythonAnalysis works with a job directory path that contains spaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'automoney jobs '));
  try {
    let receivedArgs = null;
    const spawnImpl = (executable, args) => {
      receivedArgs = args;
      const child = fakeChild();
      queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ ok: true })); child.emit('close', 0); });
      return child;
    };
    const result = await runPythonAnalysis({ config: { executable: 'python' }, workerDir: '/workers/python', jobDir: dir, spawnImpl });
    assert.equal(result.success, true);
    assert.ok(receivedArgs.includes(dir), 'the space-containing path must be passed as a single argv item, not split');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runPythonAnalysis caps captured stdout/stderr instead of buffering unbounded output', async () => {
  const hugeChunk = 'x'.repeat(1_000_000);
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      for (let i = 0; i < 5; i += 1) child.stderr.emit('data', hugeChunk);
      child.emit('close', 1);
    });
    return child;
  };
  const result = await runPythonAnalysis({ config: { executable: 'python' }, workerDir: '/workers/python', jobDir: '/jobs/draft-1', spawnImpl });
  assert.equal(result.truncated, true);
  assert.ok(result.log.length <= 2_000_000);
});

test('runPythonAnalysis never passes the parent process env wholesale to the child (no secret leakage)', async () => {
  process.env.AUTOMONEY_TEST_SECRET = 'do-not-leak';
  let receivedEnv = null;
  const spawnImpl = (executable, args, options) => {
    receivedEnv = options.env;
    const child = fakeChild();
    queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ ok: true })); child.emit('close', 0); });
    return child;
  };
  try {
    await runPythonAnalysis({ config: { executable: 'python' }, workerDir: '/workers/python', jobDir: '/jobs/draft-1', spawnImpl });
    assert.equal(receivedEnv.AUTOMONEY_TEST_SECRET, undefined);
  } finally {
    delete process.env.AUTOMONEY_TEST_SECRET;
  }
});
