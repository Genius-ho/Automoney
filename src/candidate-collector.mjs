// Extracted from scripts/collect-candidates.js so the candidate collection
// pipeline (Domeme/Domeggook search -> normalize -> filter -> price ->
// import-worthiness) is importable from src/, not just runnable as a CLI
// script. scripts/collect-candidates.js re-exports/calls these unchanged --
// this is a pure extraction, no behavior change.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DomemeApiError, maskUrl } from './domeme-client.mjs';
import { calculatePrices, cleanProductName, filterProduct, normalizeProduct } from './processing.mjs';
import { saveImportResult } from './postgres-store.mjs';

export async function collectCandidates(client, keywords, { targetCandidateCount, pageSize, category, includeDomeggook, root, summary }) {
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

export async function loadFallbackCandidates(rootDir) {
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

// NOTE: the original script read includeNeedsReview/includeDomeggook as
// top-level script globals here (a latent quirk that only worked because
// this function lived in the same module as those consts). Extracted as
// explicit options so behavior no longer depends on caller module scope.
export async function evaluateCandidates(client, candidates, pricingRules, { includeNeedsReview = false, includeDomeggook = false } = {}) {
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

export async function saveEvaluatedCandidate(pool, candidate, { importBatchId, collectedAt }) {
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
    return { saved: true, dbAction: saved.dbAction, draftId: saved.draftId, supplierProductId: saved.supplierProductId };
  } catch (error) {
    await client.query('rollback');
    return { saved: false, error };
  } finally {
    client.release();
  }
}

export function isImportableCandidate(filter, { includeNeedsReview, includeDomeggook, product } = {}) {
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

export function scoreCandidate(filter, product) {
  if (filter.filterStatus === 'pass') return 0;
  if (filter.filterStatus === 'needs_review') return 10 + (filter.reviewReasons || []).length;
  return 100 + (filter.blockReasons || []).length + (product?.options || []).length / 100;
}

export function canCalculatePrices(filter) {
  return !(filter.blockReasons || []).some((reason) =>
    ['price_parsing_error', 'price_invalid_range', 'missing_or_invalid_cost'].includes(reason),
  );
}

export function countReasons(map, reasons) {
  for (const reason of reasons) map.set(reason, (map.get(reason) || 0) + 1);
}

export function formatTopReasons(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',');
}

export function parseCandidateCsv(text) {
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

export function describeError(error) {
  if (error instanceof DomemeApiError) {
    return `${error.operation}:${error.code || error.status}:${error.bodyPreview || error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
