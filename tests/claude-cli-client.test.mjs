import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { checkClaudeCliAvailability, runClaudeVisionReview } from '../src/claude-cli-client.mjs';

// A minimal fake child_process.ChildProcess -- enough surface for
// claude-cli-client.mjs to drive (stdout/stderr 'data', 'error', 'close', a
// writable stdin, and kill()), same shape as codex-client.test.mjs's fake.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => child.emit('close', null);
  return child;
}

test('checkClaudeCliAvailability reports unavailable without throwing when the executable cannot be spawned (ENOENT)', async () => {
  const spawnImpl = () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); };
  const result = await checkClaudeCliAvailability({ config: { executable: 'claude' }, spawnImpl });
  assert.equal(result.available, false);
  assert.equal(result.loggedIn, false);
  assert.match(result.message, /ENOENT/);
});

test('checkClaudeCliAvailability reports available+loggedIn when version succeeds and auth status JSON says loggedIn:true', async () => {
  let call = 0;
  const spawnImpl = () => {
    call += 1;
    const child = fakeChild();
    queueMicrotask(() => {
      if (call === 1) child.stdout.emit('data', '2.1.197 (Claude Code)\n');
      else child.stdout.emit('data', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }));
      child.emit('close', 0);
    });
    return child;
  };
  const result = await checkClaudeCliAvailability({ config: { executable: 'claude' }, spawnImpl });
  assert.equal(result.available, true);
  assert.equal(result.loggedIn, true);
  assert.equal(result.version, '2.1.197 (Claude Code)');
  assert.match(result.message, /pro/);
});

test('checkClaudeCliAvailability reports available but not logged in when auth status JSON says loggedIn:false', async () => {
  let call = 0;
  const spawnImpl = () => {
    call += 1;
    const child = fakeChild();
    queueMicrotask(() => {
      if (call === 1) child.stdout.emit('data', '2.1.197 (Claude Code)\n');
      else child.stdout.emit('data', JSON.stringify({ loggedIn: false }));
      child.emit('close', 0);
    });
    return child;
  };
  const result = await checkClaudeCliAvailability({ config: { executable: 'claude' }, spawnImpl });
  assert.equal(result.available, true);
  assert.equal(result.loggedIn, false);
});

test('runClaudeVisionReview writes the image list + prompt to stdin, never as a spawn argument', async () => {
  let receivedArgs = null;
  let receivedStdin = '';
  const spawnImpl = (executable, args) => {
    receivedArgs = args;
    const child = fakeChild();
    child.stdin.write = (text) => { receivedStdin += text; };
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ is_error: false, result: '{"pass":true,"issues":[]}', usage: { input_tokens: 1 } }));
      child.emit('close', 0);
    });
    return child;
  };
  const result = await runClaudeVisionReview({
    config: { executable: 'claude', model: 'sonnet', timeoutMs: 5000 },
    images: ['/tmp/main.jpg', '/tmp/detail-01.jpg'],
    prompt: 'sensitive supplier text; $(rm -rf /) & echo hi',
    spawnImpl,
  });
  assert.match(receivedStdin, /1\. \/tmp\/main\.jpg/);
  assert.match(receivedStdin, /2\. \/tmp\/detail-01\.jpg/);
  assert.match(receivedStdin, /sensitive supplier text; \$\(rm -rf \/\) & echo hi/);
  assert.ok(!receivedArgs.some((arg) => arg.includes('rm -rf')), 'untrusted prompt text must never reach argv');
  assert.equal(result.rawText, '{"pass":true,"issues":[]}');
  assert.equal(result.model, 'sonnet');
  assert.deepEqual(result.usage, { input_tokens: 1 });
});

test('runClaudeVisionReview passes --allowedTools \'\', the configured model, and defaults --effort to medium', async () => {
  let receivedArgs = null;
  const spawnImpl = (executable, args) => {
    receivedArgs = args;
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ is_error: false, result: 'ok' }));
      child.emit('close', 0);
    });
    return child;
  };
  await runClaudeVisionReview({ config: { executable: 'claude', model: 'sonnet' }, images: ['/tmp/a.jpg'], prompt: 'x', spawnImpl });
  assert.deepEqual(receivedArgs, ['-p', '--output-format', 'json', '--model', 'sonnet', '--effort', 'medium', '--allowedTools', '']);
});

test('runClaudeVisionReview uses config.effort over the default when supplied', async () => {
  let receivedArgs = null;
  const spawnImpl = (executable, args) => {
    receivedArgs = args;
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ is_error: false, result: 'ok' }));
      child.emit('close', 0);
    });
    return child;
  };
  await runClaudeVisionReview({ config: { executable: 'claude', model: 'sonnet', effort: 'high' }, images: ['/tmp/a.jpg'], prompt: 'x', spawnImpl });
  assert.deepEqual(receivedArgs.slice(receivedArgs.indexOf('--effort'), receivedArgs.indexOf('--effort') + 2), ['--effort', 'high']);
});

test('runClaudeVisionReview throws CLAUDE_CLI_ERROR when the response has is_error:true', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }));
      child.emit('close', 0);
    });
    return child;
  };
  await assert.rejects(
    () => runClaudeVisionReview({ config: { executable: 'claude', model: 'sonnet' }, images: ['/tmp/a.jpg'], prompt: 'x', spawnImpl }),
    (error) => error.code === 'CLAUDE_CLI_ERROR' && /Not logged in/.test(error.message),
  );
});

test('runClaudeVisionReview throws CLAUDE_CLI_ERROR when the process exits non-zero', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    queueMicrotask(() => { child.stderr.emit('data', 'boom'); child.emit('close', 1); });
    return child;
  };
  await assert.rejects(
    () => runClaudeVisionReview({ config: { executable: 'claude', model: 'sonnet' }, images: ['/tmp/a.jpg'], prompt: 'x', spawnImpl }),
    (error) => error.code === 'CLAUDE_CLI_ERROR' && /boom/.test(error.message),
  );
});

test('runClaudeVisionReview throws CLAUDE_CLI_TIMEOUT and kills the child when the process never exits', async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = fakeChild();
    child.kill = () => { killed = true; };
    return child;
  };
  await assert.rejects(
    () => runClaudeVisionReview({ config: { executable: 'claude', model: 'sonnet', timeoutMs: 20 }, images: ['/tmp/a.jpg'], prompt: 'x', spawnImpl }),
    (error) => error.code === 'CLAUDE_CLI_TIMEOUT',
  );
  assert.equal(killed, true);
});

test('runClaudeVisionReview throws NO_IMAGES when the images array is empty', async () => {
  await assert.rejects(
    () => runClaudeVisionReview({ config: { executable: 'claude' }, images: [], prompt: 'x' }),
    (error) => error.code === 'NO_IMAGES',
  );
});

test('runClaudeVisionReview throws MISSING_PROMPT when no prompt is supplied', async () => {
  await assert.rejects(
    () => runClaudeVisionReview({ config: { executable: 'claude' }, images: ['/tmp/a.jpg'] }),
    (error) => error.code === 'MISSING_PROMPT',
  );
});

test('runClaudeVisionReview respects concurrency=1: a second call does not start until the first finishes', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await Promise.all([1, 2, 3].map((n) => runClaudeVisionReview({
    config: { executable: 'claude', model: 'sonnet', concurrency: 1, timeoutMs: 5000 },
    images: ['/tmp/a.jpg'],
    prompt: `test-${n}`,
    spawnImpl: () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const child = fakeChild();
      setTimeout(() => {
        active -= 1;
        child.stdout.emit('data', JSON.stringify({ is_error: false, result: `result-${n}` }));
        child.emit('close', 0);
      }, 30);
      return child;
    },
  })));
  assert.equal(maxActive, 1, 'no more than one Claude CLI process should run at a time with concurrency=1');
  assert.equal(results.length, 3);
});
