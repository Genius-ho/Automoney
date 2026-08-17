import { spawn as nodeSpawn } from 'node:child_process';

// Claude Code CLI is a local process authenticated via the operator's own
// Claude subscription login (`claude auth status`) -- this module never
// reads or requires an API key. Same win32/shell reasoning as
// codex-client.mjs: spawn(cmd, args, {shell:false}) fails with EINVAL for an
// npm-installed .cmd shim on Windows, so shell is enabled there only. Every
// arg passed through this module is either a fixed flag or a config value
// this codebase itself constructed -- free-form, potentially untrusted text
// (the review prompt, which can embed supplier product data) is never
// passed as an argv item, only ever written to the child's stdin.
function spawnClaude(executable, args, { cwd, spawnImpl = nodeSpawn } = {}) {
  return spawnImpl(executable, args, { cwd, shell: process.platform === 'win32' });
}

function runCommand(executable, args, { spawnImpl, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnClaude(executable, args, { spawnImpl });
    } catch (error) {
      resolvePromise({ ok: false, code: null, output: error.message || String(error) });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, output: `${output}\n(timed out after ${timeoutMs}ms)` });
    }, timeoutMs);
    child.on('error', (error) => finish({ ok: false, code: null, output: error.message || String(error) }));
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => finish({ ok: code === 0, code, output }));
    child.stdin?.end();
  });
}

// Runs a fast, side-effect-free command to answer "can we use Claude Code
// right now" without ever throwing -- missing install, expired login, and
// other failures must degrade to a reportable status, not crash the caller.
// `claude auth status` prints JSON by default (no --output-format flag
// needed -- confirmed against the real installed CLI).
export async function checkClaudeCliAvailability({ config, spawnImpl } = {}) {
  const executable = config?.executable || 'claude';
  try {
    const versionResult = await runCommand(executable, ['--version'], { spawnImpl });
    if (!versionResult.ok) {
      return { available: false, loggedIn: false, version: null, message: versionResult.output.trim() || `claude --version exited with code ${versionResult.code}` };
    }
    const authResult = await runCommand(executable, ['auth', 'status'], { spawnImpl });
    let loggedIn = false;
    let message = authResult.output.trim();
    if (authResult.ok) {
      try {
        const parsed = JSON.parse(authResult.output);
        loggedIn = parsed.loggedIn === true;
        message = loggedIn ? `Logged in (${parsed.subscriptionType || parsed.authMethod || 'unknown'})` : 'Not logged in';
      } catch {
        loggedIn = /logged in/i.test(message) && !/not logged in/i.test(message);
      }
    }
    return { available: true, loggedIn, version: versionResult.output.trim(), message: message || (loggedIn ? 'Logged in' : 'Not logged in') };
  } catch (error) {
    return { available: false, loggedIn: false, version: null, message: error.message || String(error) };
  }
}

// Simple FIFO semaphore so at most `config.concurrency` (default 1) Claude
// CLI calls run at once -- kept as a separate counter from
// codex-client.mjs's so an image-generation run (Codex) and an
// image-review run (Claude) never wait on each other's slot.
let activeCount = 0;
const waiters = [];
async function acquireSlot(limit) {
  if (activeCount < limit) { activeCount += 1; return; }
  await new Promise((resolvePromise) => waiters.push(resolvePromise));
  activeCount += 1;
}
function releaseSlot() {
  activeCount -= 1;
  const next = waiters.shift();
  if (next) next();
}

// Runs one non-interactive Claude Code turn to review the given local image
// files against `prompt`. `images` are absolute local file paths -- unlike
// Codex's `-i` flag, Claude Code just needs the path referenced as plain
// text within the prompt for it to read the file (confirmed live against
// the real CLI). --allowedTools '' still permits it to read those
// referenced files while blocking every other tool, which keeps a
// prompt that embeds supplier-provided text from being able to trigger
// arbitrary tool use.
export async function runClaudeVisionReview({ config, images = [], prompt, spawnImpl }) {
  const executable = config?.executable || 'claude';
  const model = config?.model || 'sonnet';
  const effort = config?.effort || 'medium';
  const timeoutMs = config?.timeoutMs || 180_000;
  const limit = config?.concurrency || 1;

  if (!Array.isArray(images) || images.length === 0) {
    const error = new Error('runClaudeVisionReview requires at least one image');
    error.code = 'NO_IMAGES';
    throw error;
  }
  if (!prompt) {
    const error = new Error('runClaudeVisionReview requires a prompt');
    error.code = 'MISSING_PROMPT';
    throw error;
  }

  const imageList = images.map((path, index) => `${index + 1}. ${path}`).join('\n');
  const fullPrompt = `아래 이미지 파일들을 각각 읽고 검수하라:\n${imageList}\n\n${prompt}`;

  await acquireSlot(limit);
  try {
    const args = ['-p', '--output-format', 'json', '--model', model, '--effort', effort, '--allowedTools', ''];

    const result = await new Promise((resolvePromise) => {
      let child;
      try {
        child = spawnClaude(executable, args, { spawnImpl });
      } catch (error) {
        resolvePromise({ ok: false, code: null, output: error.message || String(error), timedOut: false });
        return;
      }
      let output = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, code: null, output, timedOut: true });
      }, timeoutMs);
      child.on('error', (error) => finish({ ok: false, code: null, output: (output += `\n${error.message}`), timedOut: false }));
      child.stdout?.on('data', (chunk) => { output += chunk; });
      child.stderr?.on('data', (chunk) => { output += chunk; });
      child.on('close', (code) => finish({ ok: code === 0, code, output, timedOut: false }));
      child.stdin?.write(fullPrompt);
      child.stdin?.end();
    });

    if (result.timedOut) {
      const error = new Error(`Claude CLI review timed out after ${timeoutMs}ms`);
      error.code = 'CLAUDE_CLI_TIMEOUT';
      throw error;
    }
    if (!result.ok) {
      const error = new Error(result.output.trim() || `claude exited with code ${result.code}`);
      error.code = 'CLAUDE_CLI_ERROR';
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.output);
    } catch (parseError) {
      const error = new Error(`Failed to parse claude CLI output as JSON: ${parseError.message}`);
      error.code = 'CLAUDE_CLI_ERROR';
      throw error;
    }
    if (parsed.is_error) {
      const error = new Error(typeof parsed.result === 'string' ? parsed.result : 'Claude CLI reported is_error');
      error.code = 'CLAUDE_CLI_ERROR';
      throw error;
    }
    if (typeof parsed.result !== 'string' || !parsed.result) {
      const error = new Error('Claude CLI response contained no result text');
      error.code = 'CLAUDE_CLI_ERROR';
      throw error;
    }

    return { model, rawText: parsed.result, usage: parsed.usage || null };
  } finally {
    releaseSlot();
  }
}
