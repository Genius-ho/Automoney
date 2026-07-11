#!/usr/bin/env node
import { loadDatabaseUrl, loadNaverConfig } from '../src/config.mjs';
import { NaverShoppingClient } from '../src/naver-shopping-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { researchNaverDraft } from '../src/naver-research.mjs';

const options = parseArgs(process.argv.slice(2));
const limit = Number(options.limit || 30);
const force = parseBoolean(options.force, false);
const databaseUrl = await loadDatabaseUrl(process.cwd());
const naverConfig = await loadNaverConfig(process.cwd());
const db = await createPgPool(databaseUrl);
const client = new NaverShoppingClient(naverConfig);
const summary = {
  total: 0,
  researched: 0,
  candidate: 0,
  needs_review: 0,
  reject: 0,
  failed: 0,
  skipped: 0,
  rejectReasons: new Map(),
};

try {
  await runSchema(db);
  const drafts = await loadDrafts(db, { ...options, limit });
  summary.total = drafts.length;
  for (const draft of drafts) {
    try {
      if (!force && (await hasExistingResearch(db, draft.id))) {
        summary.skipped += 1;
        continue;
      }
      const research = await researchNaverDraft(db, client, draft, {
        keyword: options.keyword || undefined,
      });
      printItemResult(draft, research);
      summary.researched += 1;
      summary[research.winnerStatus] = (summary[research.winnerStatus] || 0) + 1;
      if (research.winnerStatus === 'reject') countReasons(summary.rejectReasons, research.reasons || []);
    } catch (error) {
      summary.failed += 1;
      countReasons(summary.rejectReasons, [error instanceof Error ? error.message : String(error)]);
    }
  }
  printSummary(summary);
} catch (error) {
  summary.failed += 1;
  printSummary(summary);
  console.log(`researchError=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

async function loadDrafts(db, { draftId, batchId, limit }) {
  const params = [];
  const where = ['(d.status = $1 or d.filter_status = $2)'];
  params.push('draft', 'pass');
  if (draftId) {
    params.push(Number(draftId));
    where.push(`d.id = $${params.length}`);
  }
  if (batchId) {
    params.push(batchId);
    where.push(`d.import_batch_id = $${params.length}`);
  }
  params.push(limit);
  const result = await db.query(
    `
      select
        d.id,
        d.selling_title,
        d.cleaned_name,
        d.raw_name,
        d.naver_sale_price,
        d.naver_expected_profit
      from product_drafts d
      where ${where.join(' and ')}
      order by d.updated_at desc, d.id desc
      limit $${params.length}
    `,
    params,
  );
  return result.rows;
}

async function hasExistingResearch(db, draftId) {
  const result = await db.query(
    'select 1 from market_research_results where product_draft_id = $1 and marketplace = $2',
    [draftId, 'naver'],
  );
  return result.rows.length > 0;
}

function printSummary(value) {
  console.log(`total=${value.total}`);
  console.log(`researched=${value.researched}`);
  console.log(`candidate=${value.candidate}`);
  console.log(`needs_review=${value.needs_review}`);
  console.log(`reject=${value.reject}`);
  console.log(`failed=${value.failed}`);
  console.log(`skipped=${value.skipped}`);
  console.log(`topRejectReasons=${formatTopReasons(value.rejectReasons)}`);
}

function printItemResult(draft, research) {
  console.log(
    [
      `draftId=${draft.id}`,
      `상품=${compact(draft.selling_title || draft.cleaned_name || draft.raw_name || '-')}`,
      `my=${research.mySalePrice ?? '-'}`,
      `lowest=${research.lowestPrice ?? '-'}`,
      `gap=${formatGap(research.priceGapRate)}`,
      `profit=${draft.naver_expected_profit ?? '-'}`,
      `competitors=${research.competitorCount ?? '-'}`,
      `score=${research.winnerScore}`,
      `status=${research.winnerStatus}`,
      `reasons=${(research.reasons || []).map((reason) => reason.split(':')[0]).join(',')}`,
    ].join(' | '),
  );
}

function compact(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function formatGap(value) {
  if (value == null) return '-';
  const percent = Math.round(Number(value) * 1000) / 10;
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) values[key] = 'true';
    else {
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
