import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadDatabaseUrl, loadR2Config } from '../src/config.mjs';
import { R2Client } from '../src/r2-client.mjs';
import { createPgPool } from '../src/postgres-store.mjs';
import { exportProductDraft } from '../src/admin-store.mjs';

const root = process.cwd();
const draftId = Number((process.argv.find((arg) => arg.startsWith('--draft=')) || '--draft=64').split('=')[1]);

async function main() {
  const r2Config = await loadR2Config(root);
  const client = new R2Client(r2Config);

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  let draft;
  try {
    draft = await exportProductDraft(db, draftId, 'coupang');
    if (!draft) throw new Error(`draft ${draftId} not found`);
  } finally {
    await db.end();
  }

  if (!Array.isArray(draft.mainImages) || draft.mainImages.length === 0) throw new Error('approved main image missing');
  if (!Array.isArray(draft.approvedAiDetailImages) || draft.approvedAiDetailImages.length !== 10) throw new Error('exactly 10 approved detail images required');

  const sources = [
    { role: 'REPRESENTATION', order: 0, localUrl: draft.mainImages[0] },
    ...draft.approvedAiDetailImages.map((localUrl, index) => ({ role: 'DETAIL', order: index + 1, localUrl })),
  ];
  if (sources.length !== 11) throw new Error(`expected exactly 11 images, got ${sources.length}`);

  console.log(`=== draft ${draftId} 승인 이미지 ${sources.length}장 업로드 (대표 1 + 상세 10) ===`);
  const results = [];
  for (const source of sources) {
    const filePath = join(root, 'public', source.localUrl.replace(/^\/+/, ''));
    const buffer = await readFile(filePath);
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const extension = source.localUrl.split('.').pop();
    const key = `drafts/${draftId}/coupang/${hash}.${extension}`;

    const existing = await client.headObject(key);
    if (existing) {
      console.log(`  [스킵-이미 존재] ${source.role} #${source.order} -> ${existing.publicUrl}`);
      results.push({ ...source, key, publicUrl: existing.publicUrl, uploaded: false });
      continue;
    }

    const { publicUrl } = await client.putObject(key, buffer, 'image/jpeg');
    console.log(`  [업로드] ${source.role} #${source.order} -> ${publicUrl}`);
    results.push({ ...source, key, publicUrl, uploaded: true });
  }

  console.log('\n=== 공개 URL HTTP 상태 확인 ===');
  for (const result of results) {
    const response = await fetch(result.publicUrl);
    result.httpStatus = response.status;
    result.https = result.publicUrl.startsWith('https://');
    console.log(`  ${result.role} #${result.order}: ${result.publicUrl} -> HTTP ${response.status} (https=${result.https})`);
  }

  const allOk = results.every((result) => result.httpStatus === 200 && result.https);
  console.log(`\n전체 11장 HTTPS+200 여부: ${allOk}`);

  await mkdir(`${root}/artifacts`, { recursive: true });
  const outputPath = `${root}/artifacts/coupang-uploaded-images-draft-${draftId}.json`;
  await writeFile(outputPath, JSON.stringify({ draftId, allOk, images: results }, null, 2));
  console.log(`결과 저장: artifacts/coupang-uploaded-images-draft-${draftId}.json`);

  if (!allOk) process.exitCode = 1;
}

main().catch((error) => {
  console.error('coupang:upload-images failed:', error.message);
  process.exitCode = 1;
});
