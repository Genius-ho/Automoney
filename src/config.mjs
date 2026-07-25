import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function loadEnvConfig(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir);
  const domemeApiKey = values.DOMEME_API_KEY;
  if (!domemeApiKey) throw new Error('DOMEME_API_KEY is missing in .env');

  return {
    domemeApiKey,
    domemeEndpoint:
      values.DOMEME_PRODUCT_DETAIL_ENDPOINT ||
      'https://domeggook.com/ssl/api/',
  };
}

// Phase 8 (section 13): separate from the public DOMEME_API_KEY lookup
// endpoint credential above -- the Private API's aid must be issued to the
// same id used to log in (2.3.2 of the order-creation guide), so this reads
// the same DOMEME_API_KEY but additionally requires the real 도매꾹 member
// id/password used for setLogin. Password is never logged (see
// domeme-private-client.mjs's maskSensitive).
export async function loadDomemePrivateConfig(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir);
  const pick = (name) => values[name] || process.env[name];
  const apiKey = pick('DOMEME_API_KEY');
  const loginId = pick('DOMEME_LOGIN_ID');
  const loginPassword = pick('DOMEME_LOGIN_PASSWORD');
  if (!apiKey) throw new Error('DOMEME_API_KEY is missing in .env');
  if (!loginId) throw new Error('DOMEME_LOGIN_ID is missing in .env');
  if (!loginPassword) throw new Error('DOMEME_LOGIN_PASSWORD is missing in .env');
  return { apiKey, loginId, loginPassword };
}

export async function loadDatabaseUrl(rootDir = process.cwd()) {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const values = await loadEnvValues(rootDir);
  const databaseUrl = values.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is missing in .env');
  return databaseUrl;
}

export async function loadAiSecrets(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir);
  const names = ['OPENAI_API_KEY','GOOGLE_API_KEY','ANTHROPIC_API_KEY','AUTOMONEY_CREDENTIAL_MASTER_KEY'];
  return Object.fromEntries(names.map(name => [name, process.env[name] || values[name] || null]));
}

export async function loadNaverConfig(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir);
  const clientId = values.NAVER_CLIENT_ID || process.env.NAVER_CLIENT_ID;
  const clientSecret = values.NAVER_CLIENT_SECRET || process.env.NAVER_CLIENT_SECRET;
  if (!clientId) throw new Error('NAVER_CLIENT_ID is missing in .env');
  if (!clientSecret) throw new Error('NAVER_CLIENT_SECRET is missing in .env');
  return { clientId, clientSecret };
}

// Separate from loadNaverConfig -- NAVER_CLIENT_ID/SECRET there are the
// search/데이터랩 openapi.naver.com keys (market research only, see
// naver-shopping-client.mjs). Registering a real product requires a
// completely different credential pair, issued via the 네이버 커머스API센터
// (commerce.naver.com) app registration, so this stays its own function/env
// var names to make the two impossible to mix up.
export async function loadNaverCommerceConfig(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir);
  const pick = (name) => values[name] || process.env[name];
  const clientId = pick('NAVER_COMMERCE_CLIENT_ID');
  const clientSecret = pick('NAVER_COMMERCE_CLIENT_SECRET');
  const channelId = pick('NAVER_COMMERCE_CHANNEL_ID') || null;
  if (!clientId) throw new Error('NAVER_COMMERCE_CLIENT_ID is missing in .env');
  if (!clientSecret) throw new Error('NAVER_COMMERCE_CLIENT_SECRET is missing in .env');
  return { clientId, clientSecret, channelId };
}

export async function loadR2Config(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir);
  const pick = (name) => values[name] || process.env[name];
  const accountId = pick('R2_ACCOUNT_ID');
  const accessKeyId = pick('R2_ACCESS_KEY_ID');
  const secretAccessKey = pick('R2_SECRET_ACCESS_KEY');
  const bucket = pick('R2_BUCKET');
  const publicBaseUrl = pick('R2_PUBLIC_BASE_URL');
  if (!accountId) throw new Error('R2_ACCOUNT_ID is missing in .env');
  if (!accessKeyId) throw new Error('R2_ACCESS_KEY_ID is missing in .env');
  if (!secretAccessKey) throw new Error('R2_SECRET_ACCESS_KEY is missing in .env');
  if (!bucket) throw new Error('R2_BUCKET is missing in .env');
  if (!publicBaseUrl) throw new Error('R2_PUBLIC_BASE_URL is missing in .env');
  return { accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl };
}

export async function loadCoupangConfig(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir);
  const pick = (name) => values[name] || process.env[name];
  const accessKey = pick('COUPANG_ACCESS_KEY');
  const secretKey = pick('COUPANG_SECRET_KEY');
  const vendorId = pick('COUPANG_VENDOR_ID');
  const vendorUserId = pick('COUPANG_VENDOR_USER_ID') || null;
  if (!accessKey) throw new Error('COUPANG_ACCESS_KEY is missing in .env');
  if (!secretKey) throw new Error('COUPANG_SECRET_KEY is missing in .env');
  if (!vendorId) throw new Error('COUPANG_VENDOR_ID is missing in .env');
  return { accessKey, secretKey, vendorId, vendorUserId };
}

// Codex CLI runs as a local process under the operator's own ChatGPT login --
// no API key is read or required here. Every value has a working default so
// this never throws; Codex being unconfigured/uninstalled/logged-out is a
// runtime *capability* check (see codex-client.mjs), not a startup failure.
export async function loadCodexConfig(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir).catch(() => ({}));
  const pick = (name) => values[name] || process.env[name];
  const sandbox = pick('CODEX_SANDBOX') || 'read-only';
  const concurrency = Number(pick('AI_JOB_CONCURRENCY'));
  return {
    executable: pick('CODEX_EXECUTABLE') || 'codex',
    sandbox,
    concurrency: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1,
    timeoutMs: Number(pick('CODEX_TIMEOUT_MS')) || 180_000,
  };
}

// Data/job directories are resolved relative to rootDir with path.join/
// path.resolve only -- no "\\" or "/" literals -- so the same config works
// unchanged on Windows now and Linux later.
export async function loadJobPathsConfig(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir).catch(() => ({}));
  const pick = (name) => values[name] || process.env[name];
  const dataDir = resolve(rootDir, pick('AUTOMONEY_DATA_DIR') || join('data'));
  const jobDir = resolve(rootDir, pick('AUTOMONEY_JOB_DIR') || join('data', 'jobs'));
  return { dataDir, jobDir };
}

export async function loadPythonConfig(rootDir = process.cwd()) {
  const values = await loadEnvValues(rootDir).catch(() => ({}));
  const pick = (name) => values[name] || process.env[name];
  const timeoutMs = Number(pick('PYTHON_TIMEOUT_MS'));
  return {
    // Defaults here are intentionally the bare command names, never a
    // machine-specific absolute path -- real paths belong in .env only
    // (gitignored), so the same code runs unchanged on Windows and Linux.
    executable: pick('PYTHON_EXECUTABLE') || 'python',
    tesseractExecutable: pick('TESSERACT_EXECUTABLE') || null,
    tessdataPrefix: pick('TESSDATA_PREFIX_DIR') || null,
    ocrLang: pick('OCR_LANG') || 'kor+eng',
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
  };
}

export async function loadProductNumbers(csvPath) {
  const text = await readFile(csvPath, 'utf8');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const firstCells = parseCsvLine(lines[0]).map((cell) => cell.trim());
  const productNoIndex = firstCells.findIndex((cell) =>
    ['product_no', 'productNo', '\uC0C1\uD488\uBC88\uD638'].includes(cell),
  );

  if (productNoIndex >= 0) {
    return lines
      .slice(1)
      .map((line) => parseCsvLine(line)[productNoIndex]?.trim())
      .filter(Boolean);
  }

  return lines.map((line) => parseCsvLine(line)[0]?.trim()).filter(Boolean);
}

export async function loadPricingRules(path) {
  return normalizeRuleKeys(JSON.parse(await readFile(path, 'utf8')));
}

async function loadEnvValues(rootDir) {
  const envPath = existsSync(join(rootDir, '.env')) ? join(rootDir, '.env') : join(rootDir, 'env');
  return parseEnv(await readFile(envPath, 'utf8'));
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '').trim();
    values[key] = value;
  }
  return values;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function normalizeRuleKeys(value) {
  if (Array.isArray(value)) return value.map(normalizeRuleKeys);
  if (!value || typeof value !== 'object') return value;

  const normalized = {};
  for (const [key, innerValue] of Object.entries(value)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    normalized[camelKey] = normalizeRuleKeys(innerValue);
  }
  return normalized;
}
