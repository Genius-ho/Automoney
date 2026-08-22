import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Codex CLI is a local process authenticated via the operator's own ChatGPT
// login (`codex login`) -- this module never reads or requires an API key.
// Windows can't exec an npm-installed `.cmd` shim without going through a
// shell (`spawn(cmd, args, {shell:false})` fails with EINVAL), so `shell` is
// enabled on win32. That makes Node warn (DEP0190) that array args aren't
// shell-escaped -- which is exactly why every arg passed through this module
// is either a fixed flag or a path this codebase itself constructed (job
// folder paths, schema/output paths). Free-form, potentially
// untrusted/attacker-adjacent text (the prompt, which can embed supplier
// product data) is never passed as an argv item -- it's always written to
// the child's stdin instead, so it never reaches the shell's parser.
function spawnCodex(executable, args, { cwd, spawnImpl = nodeSpawn } = {}) {
  return spawnImpl(executable, args, { cwd, shell: process.platform === 'win32' });
}

// Runs a fast, side-effect-free command to answer "can we use Codex right
// now" without ever throwing -- missing install, expired login, and other
// failures must degrade to a reportable status, not crash the caller (the
// admin server must keep working even if Codex is unavailable).
export async function checkCodexAvailability({ config, spawnImpl } = {}) {
  const executable = config?.executable || 'codex';
  try {
    const versionResult = await runCommand(executable, ['--version'], { spawnImpl });
    if (!versionResult.ok) {
      return { available: false, loggedIn: false, version: null, message: versionResult.output.trim() || `codex --version exited with code ${versionResult.code}` };
    }
    const loginResult = await runCommand(executable, ['login', 'status'], { spawnImpl });
    const loginOutput = loginResult.output.trim();
    const loggedIn = loginResult.ok && /logged in/i.test(loginOutput);
    return {
      available: true,
      loggedIn,
      version: versionResult.output.trim(),
      message: loginOutput || (loggedIn ? 'Logged in' : 'Not logged in'),
    };
  } catch (error) {
    return { available: false, loggedIn: false, version: null, message: error.message || String(error) };
  }
}

function runCommand(executable, args, { spawnImpl, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnCodex(executable, args, { spawnImpl });
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

// Simple FIFO semaphore so at most `config.concurrency` (default 1) Codex
// analyses run at once, per spec section 9 -- queued callers just await
// their turn rather than erroring.
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

// Runs one non-interactive, read-only Codex analysis turn: attaches the
// given images, constrains the response to schemaPath's JSON Schema, and
// captures the final message to outputPath. `cwd` should always be a
// per-draft job folder (never the repo root) so Codex only ever sees that
// one product's own input files, per spec section 3.
export async function runCodexAnalysis({ config, cwd, images = [], schemaPath, outputPath, prompt, spawnImpl }) {
  const executable = config?.executable || 'codex';
  const sandbox = config?.sandbox || 'read-only';
  const timeoutMs = config?.timeoutMs || 180_000;
  const limit = config?.concurrency || 1;

  await acquireSlot(limit);
  try {
    const args = ['exec', '--skip-git-repo-check', '-s', sandbox, '-C', cwd];
    // config.model/reasoningEffort are optional overrides -- omitted (as
    // every existing caller today does) means this CLI's own ~/.codex/
    // config.toml default applies, so this is purely additive.
    if (config?.model) args.push('-m', config.model);
    if (config?.reasoningEffort) args.push('-c', `model_reasoning_effort=${config.reasoningEffort}`);
    for (const imagePath of images) args.push('-i', imagePath);
    args.push('--output-schema', schemaPath, '-o', outputPath, '-');

    const result = await new Promise((resolvePromise) => {
      let child;
      try {
        child = spawnCodex(executable, args, { cwd, spawnImpl });
      } catch (error) {
        resolvePromise({ ok: false, code: null, log: error.message || String(error), timedOut: false });
        return;
      }
      let log = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, code: null, log, timedOut: true });
      }, timeoutMs);
      child.on('error', (error) => finish({ ok: false, code: null, log: (log += `\n${error.message}`), timedOut: false }));
      child.stdout?.on('data', (chunk) => { log += chunk; });
      child.stderr?.on('data', (chunk) => { log += chunk; });
      child.on('close', (code) => finish({ ok: code === 0, code, log, timedOut: false }));
      child.stdin?.write(prompt);
      child.stdin?.end();
    });

    if (!result.ok) {
      return { success: false, log: result.log, timedOut: result.timedOut, exitCode: result.code, analysis: null };
    }

    let analysis;
    try {
      analysis = JSON.parse(await readFile(outputPath, 'utf8'));
    } catch (error) {
      return { success: false, log: `${result.log}\nfailed to read/parse output file: ${error.message}`, timedOut: false, exitCode: result.code, analysis: null };
    }
    return { success: true, log: result.log, timedOut: false, exitCode: result.code, analysis };
  } finally {
    releaseSlot();
  }
}

// Runs one non-interactive Codex turn that is expected to call Codex's own
// built-in image-generation tool and save file(s) somewhere under `cwd`,
// rather than return structured JSON -- so unlike runCodexAnalysis there is
// no --output-schema/-o here. The prompt itself must tell Codex exactly
// where to save each image (relative to `cwd`); the caller is responsible
// for scanning the expected output directory afterward and deciding whether
// enough files actually landed. Shares the same acquireSlot/releaseSlot
// concurrency gate as runCodexAnalysis, so an image-generation run and a
// text-analysis run for two different drafts never execute concurrently.
export async function runCodexImagePrompt({ config, cwd, images = [], prompt, timeoutMs, spawnImpl }) {
  const executable = config?.executable || 'codex';
  const sandbox = config?.sandbox || 'workspace-write';
  const effectiveTimeoutMs = timeoutMs || config?.imageTimeoutMs || 600_000;
  const limit = config?.concurrency || 1;

  await acquireSlot(limit);
  try {
    const args = ['exec', '--skip-git-repo-check', '-s', sandbox, '-C', cwd];
    for (const imagePath of images) args.push('-i', imagePath);
    args.push('-');

    const result = await new Promise((resolvePromise) => {
      let child;
      try {
        child = spawnCodex(executable, args, { cwd, spawnImpl });
      } catch (error) {
        resolvePromise({ ok: false, code: null, log: error.message || String(error), timedOut: false });
        return;
      }
      let log = '';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, code: null, log, timedOut: true });
      }, effectiveTimeoutMs);
      child.on('error', (error) => finish({ ok: false, code: null, log: (log += `\n${error.message}`), timedOut: false }));
      child.stdout?.on('data', (chunk) => { log += chunk; });
      child.stderr?.on('data', (chunk) => { log += chunk; });
      child.on('close', (code) => finish({ ok: code === 0, code, log, timedOut: false }));
      child.stdin?.write(prompt);
      child.stdin?.end();
    });

    return { success: result.ok, log: result.log, timedOut: result.timedOut, exitCode: result.code };
  } finally {
    releaseSlot();
  }
}

// Answers "can this Codex CLI actually call its own image-generation tool
// right now" without guessing -- reads the real `codex features list`
// output for this installation/login rather than assuming stable==available
// for every account. Never throws; an unreadable/unexpected output is
// reported as unavailable with the raw text attached, not silently ignored.
export async function checkCodexImageGenerationAvailable({ config, spawnImpl } = {}) {
  const executable = config?.executable || 'codex';
  const result = await runCommand(executable, ['features', 'list'], { spawnImpl, timeoutMs: 15_000 });
  if (!result.ok) {
    return { available: false, message: result.output.trim() || 'codex features list failed' };
  }
  const line = result.output.split('\n').find((entry) => entry.trim().startsWith('image_generation'));
  if (!line) return { available: false, message: 'image_generation feature not listed by this Codex CLI' };
  const available = /\btrue\b/.test(line);
  return { available, message: line.trim() };
}
