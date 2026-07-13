import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
