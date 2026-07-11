#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';
import sharp from 'sharp';

import { loadDatabaseUrl } from '../src/config.mjs';
import { archiveFileName, shouldArchiveOriginalImage } from '../src/original-image-archive.mjs';
import { runSchema } from '../src/postgres-store.mjs';

const MIN_BYTES = 10 * 1024;
const MIN_DIMENSION = 100;
const options = parseArgs(process.argv.slice(2));
const client = new Client({ connectionString: await loadDatabaseUrl(process.cwd()) });

let archived = 0;
let skipped = 0;
let failed = 0;
let notFound = 0;

try {
  await client.connect();
  await runSchema(client);
  const rows = await client.query(
    `
      select id, product_draft_id, image_type, source_section, url, original_url, stored_url
      from product_images
      where image_type in ('detail_source_full', 'detail_full')
        and source_section = 'detail'
        ${options.draftId ? 'and product_draft_id = $1' : ''}
      order by product_draft_id, id
      ${options.limit ? `limit ${options.limit}` : ''}
    `,
    options.draftId ? [options.draftId] : [],
  );

  for (const row of rows.rows) {
    const image = toImage(row);
    if (!options.force && !shouldArchiveOriginalImage(image)) {
      skipped += 1;
      continue;
    }
    try {
      const response = await fetch(image.originalUrl, {
        redirect: 'follow',
        headers: { accept: 'image/*,*/*', 'user-agent': 'AutomoneyOriginalImageArchive/1.0' },
      });
      if (!response.ok) {
        const status = response.status === 404 ? 'not_found' : 'archive_failed';
        await markFailure(row.id, status, `archive HTTP ${response.status}`);
        if (status === 'not_found') notFound += 1;
        else failed += 1;
        console.log(`imageId=${row.id} status=${status}`);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('image/')) {
        await markFailure(row.id, 'archive_failed', `archive invalid content-type: ${contentType || 'missing'}`);
        failed += 1;
        console.log(`imageId=${row.id} status=archive_failed`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < MIN_BYTES) {
        await markFailure(row.id, 'broken', `archive file too small: ${buffer.length} bytes`);
        failed += 1;
        console.log(`imageId=${row.id} status=broken`);
        continue;
      }

      const metadata = await sharp(buffer, { animated: true }).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
        await markFailure(row.id, 'broken', `archive image too small: ${width}x${height}`);
        failed += 1;
        console.log(`imageId=${row.id} status=broken`);
        continue;
      }

      const fileName = archiveFileName(image, contentType);
      const directory = join(process.cwd(), 'public', 'original-images', 'drafts', String(row.product_draft_id));
      const filePath = join(directory, fileName);
      const storedUrl = `/original-images/drafts/${row.product_draft_id}/${fileName}`;
      await mkdir(directory, { recursive: true });
      await writeFile(filePath, buffer);
      await client.query(
        `
          update product_images
          set stored_url = $2,
              width = $3,
              height = $4,
              aspect_ratio = $5,
              crawl_status = 'archived',
              crawl_error = null,
              quality_status = 'usable'
          where id = $1
        `,
        [row.id, storedUrl, width, height, height / width],
      );
      archived += 1;
      console.log(`imageId=${row.id} status=archived`);
    } catch (error) {
      await markFailure(row.id, 'archive_failed', `archive ${error.code || error.name || 'ERROR'}: ${error.message}`);
      failed += 1;
      console.log(`imageId=${row.id} status=archive_failed`);
    }
  }

  console.log('postgres=enabled');
  console.log(`total=${rows.rows.length}`);
  console.log(`archived=${archived}`);
  console.log(`skipped=${skipped}`);
  console.log(`notFound=${notFound}`);
  console.log(`failed=${failed}`);
} catch (error) {
  console.log('postgres=error');
  console.log(`errorCode=${error.code || error.name || 'UNKNOWN'}`);
  console.log(`errorMessage=${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

function toImage(row) {
  return {
    id: Number(row.id),
    imageType: row.image_type,
    sourceSection: row.source_section,
    originalUrl: row.original_url || row.url,
    storedUrl: row.stored_url || null,
  };
}

async function markFailure(id, status, message) {
  await client.query(
    `
      update product_images
      set crawl_status = $2,
          crawl_error = $3,
          quality_status = $4
      where id = $1
    `,
    [id, status, message.slice(0, 500), status === 'broken' ? 'broken' : 'archive_failed'],
  );
}

function parseArgs(args) {
  const draftIndex = args.indexOf('--draft-id');
  const limitIndex = args.indexOf('--limit');
  const draftId = draftIndex >= 0 ? Number(args[draftIndex + 1]) : null;
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : null;
  if (draftIndex >= 0 && (!Number.isInteger(draftId) || draftId <= 0)) throw new Error('--draft-id must be a positive integer');
  if (limitIndex >= 0 && (!Number.isInteger(limit) || limit <= 0)) throw new Error('--limit must be a positive integer');
  return { draftId, limit, force: args.includes('--force') };
}
