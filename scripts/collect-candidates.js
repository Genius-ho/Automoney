#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadDatabaseUrl, loadEnvConfig, loadPricingRules } from '../src/config.mjs';
import { DomemeClient } from '../src/domeme-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import {
  collectCandidates,
  countReasons,
  describeError,
  evaluateCandidates,
  formatTopReasons,
  isImportableCandidate,
  saveEvaluatedCandidate,
} from '../src/candidate-collector.mjs';

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

  const evaluated = await evaluateCandidates(domeme, candidates, pricingRules, { includeNeedsReview, includeDomeggook });
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
