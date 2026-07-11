#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadDatabaseUrl, loadEnvConfig, loadPricingRules } from '../src/config.mjs';
import { DomemeApiError, DomemeClient, maskUrl } from '../src/domeme-client.mjs';
import { calculatePrices, cleanProductName, filterProduct, normalizeProduct } from '../src/processing.mjs';
import { createPgPool, runSchema, saveImportResult } from '../src/postgres-store.mjs';

const root = process.cwd();
const options = parseArgs(process.argv.slice(2));
const seedPath = options.keywordsPath || join(root, 'data', 'seed-keywords.json');
const pricingPath = options.pricingPath || join(root, 'pricing-rules.json');
const targetImportCount = Number(options.limit || 30);
const targetCandidateCount = Number(options.candidateLimit || 200);
const pageSize = Number(options.pageSize || 50);
const includeNeedsReview = parseBoolean(options.includeNeedsReview, false);
const includeDomeggook = parseBoolean(options.includeDomeggook, false);
const importBatchId = options.importBatchId || `collect-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const collectedAt = new Date().toISOString();

const config = await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const keywords = await loadKeywords(seedPath, options);
const pricingRules = await loadPricingRules(pricingPath);
const domeme = new DomemeClient({
  apiKey: config.domemeApiKey,
  endpoint: config.domemeEndpoint,
});
const db = await createPgPool(databaseUrl);

const summary = {
  searchedKeywords: keywords,
  candidateCount: 0,
  importedCount: 0,
  pass: 0,
  needs_review: 0,
  blocked: 0,
  failed: 0,
  duplicateSkipped: 0,
  alreadyExistingUpdated: 0,
  inserted: 0,
  updated: 0,
  skippedNeedsReview: 0,
  skippedBlocked: 0,
  domemeCount: 0,
  domeggookCount: 0,
  unknownMarketCount: 0,
  blockedByMinOrderQty: 0,
  skippedDomeggook: 0,
  blockReasonCounts: new Map(),
  reviewReasonCounts: new Map(),
};

try {
  await runSchema(db);
  const candidates = await collectCandidates(domeme, keywords, {
    targetCandidateCount,
    pageSize,
    category: options.category,
    includeDomeggook,
    root,
    summary,
  });
  summary.candidateCount = candidates.length;

  const evaluated = await evaluateCandidates(domeme, candidates, pricingRules);
  for (const item of evaluated) {
    if (item.filter.filterStatus === 'pass') summary.pass += 1;
    else if (item.filter.filterStatus === 'needs_review') summary.needs_review += 1;
    else if (item.filter.filterStatus === 'blocked') summary.blocked += 1;
    else summary.failed += 1;
    if (item.normalized?.sourceMarket === 'domeme') summary.domemeCount += 1;
    else if (item.normalized?.sourceMarket === 'domeggook') summary.domeggookCount += 1;
    else summary.unknownMarketCount += 1;
    if ((item.filter.blockReasons || []).some((reason) => ['blocked_min_order_qty', 'blocked_large_bundle'].includes(reason))) {
      summary.blockedByMinOrderQty += 1;
    }
    if (item.normalized?.sourceMarket === 'domeggook' && !includeDomeggook) summary.skippedDomeggook += 1;
    countReasons(summary.blockReasonCounts, item.filter.blockReasons || []);
    countReasons(summary.reviewReasonCounts, item.filter.reviewReasons || []);
  }
  const importable = evaluated.filter((candidate) =>
    isImportableCandidate(candidate.filter, { includeNeedsReview, includeDomeggook, product: candidate.normalized }),
  );
  summary.skippedNeedsReview = includeNeedsReview ? 0 : evaluated.filter((candidate) => candidate.filter.filterStatus === 'needs_review').length;
  summary.skippedBlocked = evaluated.filter((candidate) => candidate.filter.filterStatus === 'blocked').length;
  for (const item of importable.slice(0, targetImportCount)) {
    const saved = await saveEvaluatedCandidate(db, item, { importBatchId, collectedAt });
    if (saved.saved) {
      summary.importedCount += 1;
      if (saved.dbAction === 'inserted') summary.inserted += 1;
      if (saved.dbAction === 'updated') {
        summary.updated += 1;
        summary.alreadyExistingUpdated += 1;
      }
    } else {
      summary.failed += 1;
    }
  }

  const selectedNos = importable.slice(0, targetImportCount).map((candidate) => candidate.productNo);
  console.log(`searchedKeywords=${summary.searchedKeywords.join(',')}`);
  console.log(`importBatchId=${importBatchId}`);
  console.log(`collectedAt=${collectedAt}`);
  console.log(`candidateCount=${summary.candidateCount}`);
  console.log(`importedCount=${summary.importedCount}`);
  console.log(`pass=${summary.pass}`);
  console.log(`needs_review=${summary.needs_review}`);
  console.log(`blocked=${summary.blocked}`);
  console.log(`failed=${summary.failed}`);
  console.log(`duplicateSkipped=${summary.duplicateSkipped}`);
  console.log(`alreadyExistingUpdated=${summary.alreadyExistingUpdated}`);
  console.log(`inserted=${summary.inserted}`);
  console.log(`updated=${summary.updated}`);
  console.log(`skippedNeedsReview=${summary.skippedNeedsReview}`);
  console.log(`skippedBlocked=${summary.skippedBlocked}`);
  console.log(`domemeCount=${summary.domemeCount}`);
  console.log(`domeggookCount=${summary.domeggookCount}`);
  console.log(`unknownMarketCount=${summary.unknownMarketCount}`);
  console.log(`blockedByMinOrderQty=${summary.blockedByMinOrderQty}`);
  console.log(`skippedDomeggook=${summary.skippedDomeggook}`);
  console.log(`topBlockReasons=${formatTopReasons(summary.blockReasonCounts)}`);
  console.log(`topReviewReasons=${formatTopReasons(summary.reviewReasonCounts)}`);
  console.log(`selectedProductNos=${selectedNos.join(',')}`);
} catch (error) {
  summary.failed += 1;
  console.log(`searchedKeywords=${summary.searchedKeywords.join(',')}`);
  console.log(`candidateCount=${summary.candidateCount}`);
  console.log(`importedCount=${summary.importedCount}`);
  console.log(`pass=${summary.pass}`);
  console.log(`needs_review=${summary.needs_review}`);
  console.log(`blocked=${summary.blocked}`);
  console.log(`failed=${summary.failed}`);
  console.log(`duplicateSkipped=${summary.duplicateSkipped}`);
  console.log(`alreadyExistingUpdated=${summary.alreadyExistingUpdated}`);
  console.log(`inserted=${summary.inserted}`);
  console.log(`updated=${summary.updated}`);
  console.log(`skippedNeedsReview=${summary.skippedNeedsReview}`);
  console.log(`skippedBlocked=${summary.skippedBlocked}`);
  console.log(`domemeCount=${summary.domemeCount}`);
  console.log(`domeggookCount=${summary.domeggookCount}`);
  console.log(`unknownMarketCount=${summary.unknownMarketCount}`);
  console.log(`blockedByMinOrderQty=${summary.blockedByMinOrderQty}`);
  console.log(`skippedDomeggook=${summary.skippedDomeggook}`);
  console.log(`topBlockReasons=${formatTopReasons(summary.blockReasonCounts)}`);
  console.log(`topReviewReasons=${formatTopReasons(summary.reviewReasonCounts)}`);
  console.log(`collectError=${describeError(error)}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

async function collectCandidates(client, keywords, { targetCandidateCount, pageSize, category, includeDomeggook, root, summary }) {
  const seen = new Set();
  const candidates = [];
  const pagesPerKeyword = Math.max(1, Math.ceil(targetCandidateCount / Math.max(1, keywords.length) / pageSize) + 1);

  for (const keyword of keywords) {
    for (let page = 1; page <= pagesPerKeyword && candidates.length < targetCandidateCount; page += 1) {
      const market = includeDomeggook ? '' : 'dome';
      const debugUrl = client.buildProductSearchUrl({ keyword, category, page, size: pageSize, market });
      printSearchRequestDiagnostics(debugUrl);
      let result;
      try {
        result = await client.searchProducts({ keyword, category, page, size: pageSize, market });
      } catch (error) {
        if (error instanceof DomemeApiError) {
          printSearchErrorDiagnostics(error);
          if (error.code === 'FORBIDDEN' || error.status === 403) return loadFallbackCandidates(root);
        }
        throw error;
      }
      for (const candidate of result.candidates) {
        if (seen.has(candidate.productNo)) {
          summary.duplicateSkipped += 1;
          continue;
        }
        seen.add(candidate.productNo);
        candidates.push({ ...candidate, keyword, requestedMarket: market || 'all' });
        if (candidates.length >= targetCandidateCount) break;
      }
      if (result.candidates.length === 0) break;
    }
    if (candidates.length >= targetCandidateCount) break;
  }

  return candidates;
}

async function loadFallbackCandidates(rootDir) {
  const paths = [join(rootDir, 'data', 'manual-candidates.csv'), join(rootDir, 'data', 'test-products.csv')];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const text = await readFile(path, 'utf8');
    const candidates = parseCandidateCsv(text).map((productNo) => ({ productNo, keyword: 'fallback_csv' }));
    console.log(`fallbackMode=csv`);
    console.log(`fallbackPath=${path.replace(rootDir, '.').replaceAll('\\\\', '/')}`);
    console.log(`fallbackCandidateCount=${candidates.length}`);
    return candidates;
  }
  console.log(`fallbackMode=none`);
  console.log(`fallbackCandidateCount=0`);
  return [];
}

function printSearchRequestDiagnostics(url) {
  const parsed = new URL(url);
  console.log(`searchUrl=${maskUrl(url)}`);
  console.log(`searchEndpoint=${parsed.origin + parsed.pathname}`);
  console.log(`searchParam.ver=${parsed.searchParams.get('ver')}`);
  console.log(`searchParam.mode=${parsed.searchParams.get('mode')}`);
  console.log(`searchParam.market=${parsed.searchParams.get('market')}`);
  console.log(`searchParam.kw=${parsed.searchParams.get('kw') || ''}`);
  console.log(`searchParam.sz=${parsed.searchParams.get('sz')}`);
  console.log(`searchParam.pg=${parsed.searchParams.get('pg')}`);
  console.log(`searchParam.so=${parsed.searchParams.get('so')}`);
}

function printSearchErrorDiagnostics(error) {
  const details = parseSearchBody(error.bodyPreview);
  console.log(`searchHttpStatus=${error.status}`);
  console.log(`searchResponse.code=${details.code || ''}`);
  console.log(`searchResponse.message=${details.message || ''}`);
  console.log(`searchResponse.dcode=${details.dcode || error.code || ''}`);
  console.log(`searchResponse.dmessage=${details.dmessage || ''}`);
}

async function evaluateCandidates(client, candidates, pricingRules) {
  const evaluated = [];
  for (const candidate of candidates) {
    try {
      const raw = await client.fetchProductDetail(candidate.productNo);
      const normalized = normalizeProduct(candidate.productNo, raw, {
        requestedMarket: candidate.requestedMarket === 'dome' ? 'dome' : null,
        candidateSource: candidate.source,
      });
      const filter = filterProduct(normalized);
      const cleanedName = cleanProductName(normalized.name);
      const prices = canCalculatePrices(filter)
        ? calculatePrices({ ...normalized, name: cleanedName }, pricingRules)
        : {};
      evaluated.push({
        productNo: candidate.productNo,
        raw,
        normalized,
        filter,
        prices,
        score: scoreCandidate(filter, normalized),
        importable: isImportableCandidate(filter, { includeNeedsReview, includeDomeggook, product: normalized }),
      });
    } catch (error) {
      evaluated.push({
        productNo: candidate.productNo,
        error,
        filter: { filterStatus: 'failed', blockReasons: [], reviewReasons: [] },
        score: 999,
        importable: false,
      });
    }
  }
  return evaluated.sort((a, b) => a.score - b.score || Number(a.productNo) - Number(b.productNo));
}

async function saveEvaluatedCandidate(pool, candidate, { importBatchId, collectedAt }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const saved = await saveImportResult(client, {
      productNo: candidate.productNo,
      raw: candidate.raw,
      normalized: candidate.normalized,
      filter: candidate.filter,
      prices: candidate.prices,
      importBatchId,
      collectedAt,
    });
    await client.query('commit');
    return { saved: true, dbAction: saved.dbAction };
  } catch (error) {
    await client.query('rollback');
    return { saved: false, error };
  } finally {
    client.release();
  }
}

function isImportableCandidate(filter, { includeNeedsReview, includeDomeggook, product } = {}) {
  const excluded = new Set([
    'blocked_low_cost',
    'blocked_low_margin',
    'price_parsing_error',
    'price_invalid_range',
    'missing_or_invalid_cost',
  ]);
  if ((filter.blockReasons || []).some((reason) => ['blocked_min_order_qty', 'blocked_large_bundle'].includes(reason))) return false;
  if ((filter.blockReasons || []).some((reason) => excluded.has(reason))) return false;
  if (product?.sourceMarket === 'domeggook' && !includeDomeggook) return false;
  if ((filter.reviewReasons || []).some((reason) => reason.startsWith('risk_keyword:'))) return false;
  if (filter.filterStatus === 'pass') return true;
  if (filter.filterStatus === 'needs_review') return Boolean(includeNeedsReview);
  return false;
}

function scoreCandidate(filter, product) {
  if (filter.filterStatus === 'pass') return 0;
  if (filter.filterStatus === 'needs_review') return 10 + (filter.reviewReasons || []).length;
  return 100 + (filter.blockReasons || []).length + (product?.options || []).length / 100;
}

function canCalculatePrices(filter) {
  return !(filter.blockReasons || []).some((reason) =>
    ['price_parsing_error', 'price_invalid_range', 'missing_or_invalid_cost'].includes(reason),
  );
}

async function loadKeywords(path, options) {
  if (options.keyword) return [options.keyword];
  if (options.keywords) return options.keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean);
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path} must be a JSON array of keywords`);
  return parsed.map((keyword) => String(keyword).trim()).filter(Boolean);
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      values[key] = 'true';
    } else {
      values[key] = next;
      index += 1;
    }
  }
  return values;
}

function parseBoolean(value, fallback) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function countReasons(map, reasons) {
  for (const reason of reasons) map.set(reason, (map.get(reason) || 0) + 1);
}

function formatTopReasons(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',');
}

function parseCandidateCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const firstCells = splitCsvLine(lines[0]).map((cell) => cell.trim());
  const productNoIndex = firstCells.findIndex((cell) => ['product_no', 'productNo', '상품번호'].includes(cell));
  const dataLines = productNoIndex >= 0 ? lines.slice(1) : lines;
  const index = productNoIndex >= 0 ? productNoIndex : 0;
  const seen = new Set();
  return dataLines
    .map((line) => splitCsvLine(line)[index]?.trim())
    .filter((value) => /^\d+$/.test(value || ''))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
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

function parseSearchBody(bodyPreview) {
  try {
    const parsed = JSON.parse(bodyPreview);
    const error = parsed.errors || parsed.error || {};
    return typeof error === 'object' ? error : { message: String(error) };
  } catch {
    return {};
  }
}

function describeError(error) {
  if (error instanceof DomemeApiError) {
    return `${error.operation}:${error.code || error.status}:${error.bodyPreview || error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
