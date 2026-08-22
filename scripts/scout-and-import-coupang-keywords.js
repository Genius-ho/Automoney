#!/usr/bin/env node
// Sources product candidates the way the reference workflow does it:
// Coupang first, Domeggook second. Scrapes a few random Coupang categories
// (price floor 9,900원, 추천순 ranking, titles only) for keywords, then runs
// those keywords through sourceCandidatesFromKeywords (coupang-keyword-sourcing.mjs)
// with Domeggook enabled and a 50% margin target instead of the platform
// default. Matches get scored and enqueued into processing_queue exactly
// like a 3-day discovery-batch winner, so the existing 5-minute automation
// (analysis/images/QA/registration) picks them up unchanged.
//
// 2026-08-21 사용자 결정: sourceCandidatesFromKeywords no longer filters --
// that's specifically because a human types/reviews the keyword in the
// Telegram flow (coupang-keyword-telegram.mjs). This script's keywords are
// AI-extracted from scraped titles with no per-keyword human review (same
// unsupervised risk profile as the 3-day discovery cycle), so it applies the
// category_policy safe-segment whitelist itself, here, before sourcing.
import { loadClaudeCliConfig, loadDatabaseUrl, loadEnvConfig, loadPricingRules } from '../src/config.mjs';
import { DomemeClient } from '../src/domeme-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { matchCategoryPolicyForKeyword } from '../src/category-policy-matcher.mjs';
import { listActiveCategoryPolicies } from '../src/category-policy-store.mjs';
import { sourceCandidatesFromKeywords } from '../src/coupang-keyword-sourcing.mjs';
import { scoutCoupangCategories } from '../src/coupang-storefront-scraper.mjs';
import { extractKeywordsFromTitles, selectFinalKeywords } from '../src/coupang-keyword-extractor.mjs';

const root = process.cwd();
const options = parseArgs(process.argv.slice(2));
const categoryCount = Number(options.categories || 2);
const finalKeywordCount = Number(options.count || 3);
const priceMin = Number(options.priceMin || 9900);
const marginRate = Number(options.marginRate ?? 0.5);
const headful = options.headful === 'true';

const config = await loadEnvConfig(root);
const claudeCliConfig = await loadClaudeCliConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const basePricingRules = await loadPricingRules(options.pricingPath || `${root}/pricing-rules.json`);

const domeme = new DomemeClient({ apiKey: config.domemeApiKey, endpoint: config.domemeEndpoint });
const db = await createPgPool(databaseUrl);

const summary = {
  scoutedCategories: [],
  scoutedTitleCount: 0,
  finalKeywords: [],
  enqueuedCount: 0,
  heldKeywords: [],
};

try {
  await runSchema(db);

  console.log(`scouting Coupang categories=${categoryCount} priceMin=${priceMin} headful=${headful}`);
  const dives = await scoutCoupangCategories({ count: categoryCount, priceMin, headful });
  const keywordBatches = [];
  for (const dive of dives) {
    summary.scoutedCategories.push(dive.categoryPath.join(' > '));
    summary.scoutedTitleCount += dive.titles.length;
    console.log(`category=${dive.categoryPath.join(' > ')} titles=${dive.titles.length}`);
    if (dive.titles.length === 0) continue;
    const keywords = await extractKeywordsFromTitles({ titles: dive.titles, config: claudeCliConfig });
    console.log(`category=${dive.categoryPath.join(' > ')} extractedKeywords=${keywords.join(',')}`);
    keywordBatches.push(keywords);
  }

  const finalKeywords = selectFinalKeywords(keywordBatches, finalKeywordCount);
  summary.finalKeywords = finalKeywords;
  console.log(`finalKeywords=${finalKeywords.join(',')}`);

  const activePolicies = await listActiveCategoryPolicies(db);
  const whitelistedKeywords = finalKeywords.filter((keyword) => {
    const matched = matchCategoryPolicyForKeyword(activePolicies, keyword);
    if (!matched) console.log(`keyword=${keyword} status=category_not_whitelisted`);
    return Boolean(matched);
  });
  summary.heldKeywords = finalKeywords.filter((keyword) => !whitelistedKeywords.includes(keyword));

  const sourcingResults = await sourceCandidatesFromKeywords(domeme, whitelistedKeywords, basePricingRules, {
    db,
    root,
    marginRate,
  });
  for (const result of sourcingResults) {
    if (result.status === 'enqueued') {
      summary.enqueuedCount += 1;
      console.log(
        `keyword=${result.keyword} status=enqueued supplierProductNo=${result.supplierProductNo} score=${result.score} categoryName=${result.categoryName}`,
      );
    } else {
      summary.heldKeywords.push(result.keyword);
      console.log(`keyword=${result.keyword} status=${result.status} ${result.error ? `error=${result.error}` : `categoryName=${result.categoryName || ''} candidatesEvaluated=${result.candidatesEvaluated ?? ''}`}`);
    }
  }

  console.log(`scoutedCategories=${summary.scoutedCategories.join('|')}`);
  console.log(`scoutedTitleCount=${summary.scoutedTitleCount}`);
  console.log(`finalKeywords=${summary.finalKeywords.join(',')}`);
  console.log(`enqueuedCount=${summary.enqueuedCount}`);
  console.log(`heldKeywords=${summary.heldKeywords.join(',')}`);
} catch (error) {
  console.log(`scoutError=${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
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
