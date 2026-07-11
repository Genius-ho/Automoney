#!/usr/bin/env node
import { Client } from 'pg';

import { loadDatabaseUrl } from '../src/config.mjs';
import { normalizeImages } from '../src/processing.mjs';

const NEEDLES = [
  '<img',
  'src=',
  'image',
  'img',
  'detail',
  'html',
  'content',
  'desc',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
];

const draftId = readArg('--draftId') || readArg('--id');
const connectionString = await loadDatabaseUrl(process.cwd());
const client = new Client({ connectionString });

try {
  await client.connect();
  const result = await client.query(
    `
      select
        pd.id as draft_id,
        pd.supplier_product_no,
        sp.raw_json
      from product_drafts pd
      join supplier_products sp on sp.id = pd.supplier_product_id
      ${draftId ? 'where pd.id = $1' : ''}
      order by pd.id desc
      limit 1
    `,
    draftId ? [Number(draftId)] : [],
  );
  const row = result.rows[0];
  if (!row) {
    console.log('draftFound=false');
    process.exit(0);
  }

  const raw = row.raw_json || {};
  const candidates = [];
  walk(raw, '$', candidates);

  console.log(`draftId=${row.draft_id}`);
  console.log(`supplierProductNo=${row.supplier_product_no}`);
  console.log(`topLevelKeys=${Object.keys(raw).join(',') || '-'}`);
  console.log(`candidateFieldCount=${candidates.length}`);
  for (const candidate of candidates.slice(0, 80)) {
    console.log(
      [
        `fieldPath=${candidate.fieldPath}`,
        `valueType=${candidate.valueType}`,
        `stringLength=${candidate.stringLength}`,
        `containsImgTag=${candidate.containsImgTag ? 'true' : 'false'}`,
        `imageUrlCount=${candidate.imageUrlCount}`,
      ].join(' | '),
    );
  }
  if (candidates.length > 80) console.log(`truncated=${candidates.length - 80}`);
} finally {
  await client.end().catch(() => {});
}

function walk(value, path, output, depth = 0) {
  if (depth > 12 || value == null) return;
  const valueType = Array.isArray(value) ? 'array' : typeof value;
  const text = stringifyCandidate(value);
  const pathLower = path.toLowerCase();
  const textLower = text.toLowerCase();
  const matched = NEEDLES.some((needle) => pathLower.includes(needle) || textLower.includes(needle));
  if (matched) {
    output.push({
      fieldPath: path,
      valueType,
      stringLength: text.length,
      containsImgTag: decodeBasicHtml(textLower).includes('<img'),
      imageUrlCount: normalizeImages(text).length,
    });
  }

  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, output, depth + 1));
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    walk(inner, `${path}.${key}`, output, depth + 1);
  }
}

function stringifyCandidate(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decodeBasicHtml(value) {
  return String(value || '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
