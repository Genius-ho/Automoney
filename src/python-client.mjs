import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';

// Caps how much of a child process's stdout/stderr this module will ever
// hold in memory -- a runaway or misbehaving Python process can't OOM the
// Node process that spawned it.
const MAX_OUTPUT_BYTES = 2_000_000;

// Only forwards the handful of variables a subprocess actually needs to run
// (locate its own binary, write temp files, resolve Windows system DLLs) --
// never the full parent environment, so DATABASE_URL/API keys/secrets never
// reach the Python process or get echoed into its logs.
function buildSafeChildEnv(extra = {}) {
  const { PATH, Path, SystemRoot, TEMP, TMP, TESSDATA_PREFIX } = process.env;
  return {
    PATH: PATH || Path,
    SystemRoot,
    TEMP,
    TMP,
    ...(TESSDATA_PREFIX ? { TESSDATA_PREFIX } : {}),
    ...extra,
  };
}

function spawnCapped(executable, args, { cwd, env, spawnImpl = nodeSpawn, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      // python.exe is a genuine executable (unlike npm's .cmd shims), so no
      // shell is needed -- args go straight to argv, never through a shell
      // parser.
      child = spawnImpl(executable, args, { cwd, env, shell: false });
    } catch (error) {
      resolvePromise({ ok: false, code: null, stdout: '', stderr: error.message || String(error), truncated: false, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, stdout, stderr, truncated, timedOut: true });
    }, timeoutMs);
    const cap = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_BYTES) { truncated = true; return current; }
      const next = current + chunk;
      if (next.length > MAX_OUTPUT_BYTES) { truncated = true; return next.slice(0, MAX_OUTPUT_BYTES); }
      return next;
    };
    child.on('error', (error) => finish({ ok: false, code: null, stdout, stderr: (stderr += `\n${error.message}`), truncated, timedOut: false }));
    child.stdout?.on('data', (chunk) => { stdout = cap(stdout, chunk.toString()); });
    child.stderr?.on('data', (chunk) => { stderr = cap(stderr, chunk.toString()); });
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr, truncated, timedOut: false }));
    child.stdin?.end();
  });
}

// "Available" here specifically means "a real Python interpreter", not just
// "something answered" -- Windows' python.exe App Execution Alias stub
// (present on a clean Windows install even with no Python installed) runs
// and exits without ever printing a real "Python X.Y.Z" version string, so
// that case is deliberately treated as unavailable rather than crashing
// later when analyze_product.py fails to import.
export async function checkPythonAvailability({ config, spawnImpl } = {}) {
  const executable = config?.executable || 'python';
  const result = await spawnCapped(executable, ['--version'], { spawnImpl, timeoutMs: 10_000, env: buildSafeChildEnv() });
  const combined = `${result.stdout}${result.stderr}`;
  const versionMatch = /Python\s+(\d+\.\d+\.\d+)/i.exec(combined);
  if (result.ok && versionMatch) {
    return { available: true, version: versionMatch[1], message: combined.trim() };
  }
  return {
    available: false,
    version: null,
    message: combined.trim() || `"${executable}" did not behave like a real Python interpreter (Windows Store stub, or not installed)`,
  };
}

// Runs analyze_product.py against one already-built job folder and returns
// its parsed stdout JSON. Never throws for a Python-side failure (missing
// interpreter, missing OCR, script crash, malformed output) -- callers must
// be able to fall back to Codex-only results, per spec section 8's "Python
// 실패 시 기존 Codex 결과 보존" requirement.
export async function runPythonAnalysis({ config, workerDir, jobDir, spawnImpl }) {
  const executable = config?.executable || 'python';
  const scriptPath = join(workerDir, 'analyze_product.py');
  const args = [scriptPath, '--job-dir', jobDir, '--lang', config?.ocrLang || 'kor+eng'];
  if (config?.tesseractExecutable) args.push('--tesseract-cmd', config.tesseractExecutable);
  if (config?.tessdataPrefix) args.push('--tessdata-prefix', config.tessdataPrefix);

  const result = await spawnCapped(executable, args, {
    cwd: workerDir,
    spawnImpl,
    timeoutMs: config?.timeoutMs || 60_000,
    env: buildSafeChildEnv(config?.tessdataPrefix ? { TESSDATA_PREFIX: config.tessdataPrefix } : {}),
  });

  if (!result.ok) {
    return { success: false, analysis: null, log: result.stderr, timedOut: result.timedOut, exitCode: result.code, truncated: result.truncated };
  }

  let analysis;
  try {
    analysis = JSON.parse(result.stdout);
  } catch (error) {
    return { success: false, analysis: null, log: `${result.stderr}\nfailed to parse stdout as JSON: ${error.message}`, timedOut: false, exitCode: result.code, truncated: result.truncated };
  }
  return { success: true, analysis, log: result.stderr, timedOut: false, exitCode: result.code, truncated: result.truncated };
}
