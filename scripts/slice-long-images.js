#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';
import sharp from 'sharp';

import { loadDatabaseUrl } from '../src/config.mjs';
import { runSchema } from '../src/postgres-store.mjs';
import { buildDetailHtml, cleanProductName } from '../src/processing.mjs';

const SLICE_HEIGHT = readNumberArg('--slice-height', 1600);
const OVERLAP = readNumberArg('--overlap', 50);
const LIMIT = readNumberArg('--limit', 0);
const PUBLIC_ROOT = join(process.cwd(), 'public');
const GENERATED_ROOT = join(PUBLIC_ROOT, 'generated-images', 'drafts');

const connectionString = await loadDatabaseUrl(process.cwd());
const client = new Client({ connectionString });

try {
  await client.connect();
  await runSchema(client);
  assertSharpAvailable();

  const rows = await client.query(
    `
      select
        pi.id,
        pi.product_draft_id,
        pi.supplier_product_no,
        pi.image_index,
        pi.url,
        pi.original_url,
        pi.stored_url,
        pi.image_type,
        pd.selling_title,
        pd.cleaned_name,
        pd.raw_name,
        pd.draft_html,
        pd.generated_detail_html,
        pd.review_memo
      from product_images pi
      join product_drafts pd on pd.id = pi.product_draft_id
      where pi.image_type in ('detail', 'detail_full')
        and pi.parent_image_id is null
      order by pi.product_draft_id, pi.image_index
      ${LIMIT > 0 ? `limit ${LIMIT}` : ''}
    `,
  );

  let checked = 0;
  let longImages = 0;
  let generatedSlices = 0;
  let failed = 0;

  for (const row of rows.rows) {
    checked += 1;
    try {
      const buffer = await downloadImage(row.original_url || row.url);
      const image = sharp(buffer);
      const metadata = await image.metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const aspectRatio = width > 0 ? height / width : null;
      const isLongImage = width > 0 && height > 0 && (height >= 3000 || aspectRatio >= 4);

      await updateImageMetadata(row.id, { width, height, aspectRatio, isLongImage });
      await deleteExistingSlices(row.product_draft_id, row.id);

      if (!isLongImage) continue;
      longImages += 1;
      await markDetailFull(row.id);
      const slices = await createSlices({ row, buffer, width, height });
      generatedSlices += slices.length;
      await insertSlices(row, slices);
      await regenerateDraftHtml(row.product_draft_id);
    } catch (error) {
      failed += 1;
      console.log(`imageProcessFailed draftId=${row.product_draft_id} imageId=${row.id} code=${error.code || error.name || 'ERROR'} message=${error.message}`);
    }
  }

  console.log('postgres=enabled');
  console.log(`checked=${checked}`);
  console.log(`longImages=${longImages}`);
  console.log(`generatedSlices=${generatedSlices}`);
  console.log(`failed=${failed}`);
} catch (error) {
  console.log('postgres=error');
  console.log(`errorCode=${error.code || error.name || 'UNKNOWN'}`);
  console.log(`errorMessage=${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  process.exit(process.exitCode || 0);
}

function assertSharpAvailable() {
  if (!sharp) throw new Error('sharp is not available. Run npm.cmd install sharp and try again.');
}

async function downloadImage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 AutomoneyImageSlicer/1.0', accept: 'image/*,*/*' },
  });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function updateImageMetadata(id, { width, height, aspectRatio, isLongImage }) {
  await client.query(
    `
      update product_images
      set width = $2,
          height = $3,
          aspect_ratio = $4,
          is_long_image = $5
      where id = $1
    `,
    [id, width || null, height || null, aspectRatio, isLongImage],
  );
}

async function markDetailFull(id) {
  await client.query("update product_images set image_type = 'detail_full' where id = $1", [id]);
}

async function deleteExistingSlices(draftId, parentImageId) {
  await client.query(
    'delete from product_images where product_draft_id = $1 and image_type = $2 and parent_image_id = $3',
    [draftId, 'detail_slice', parentImageId],
  );
}

async function createSlices({ row, buffer, width, height }) {
  const draftDir = join(GENERATED_ROOT, String(row.product_draft_id));
  await mkdir(draftDir, { recursive: true });
  const slices = [];
  let top = 0;
  let index = 1;
  while (top < height) {
    const sliceHeight = Math.min(SLICE_HEIGHT, height - top);
    const fileName = `detail-${row.id}-slice-${String(index).padStart(3, '0')}.jpg`;
    const filePath = join(draftDir, fileName);
    await sharp(buffer)
      .extract({ left: 0, top, width, height: sliceHeight })
      .jpeg({ quality: 88 })
      .toFile(filePath);
    const publicUrl = `/generated-images/drafts/${row.product_draft_id}/${fileName}`;
    slices.push({ index, top, width, height: sliceHeight, filePath, publicUrl });
    if (top + sliceHeight >= height) break;
    top += Math.max(1, SLICE_HEIGHT - OVERLAP);
    index += 1;
  }
  return slices;
}

async function insertSlices(parent, slices) {
  const baseIndex = await nextImageIndex(parent.product_draft_id);
  for (const slice of slices) {
    await client.query(
      `
        insert into product_images (
          product_draft_id,
          supplier_product_no,
          image_index,
          url,
          image_type,
          sort_order,
          original_url,
          stored_url,
          width,
          height,
          aspect_ratio,
          is_long_image,
          parent_image_id,
          slice_index,
          source_method
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `,
      [
        parent.product_draft_id,
        parent.supplier_product_no,
        baseIndex + slice.index - 1,
        parent.original_url || parent.url,
        'detail_slice',
        1000 + slice.index,
        parent.original_url || parent.url,
        slice.publicUrl,
        slice.width,
        slice.height,
        slice.height / slice.width,
        false,
        parent.id,
        slice.index,
        'long_slice',
      ],
    );
  }
}

async function nextImageIndex(draftId) {
  const result = await client.query(
    'select coalesce(max(image_index), -1)::int + 1 as next_index from product_images where product_draft_id = $1',
    [draftId],
  );
  return result.rows[0]?.next_index || 0;
}

async function regenerateDraftHtml(draftId) {
  const result = await client.query(
    `
      select
        pd.id,
        pd.selling_title,
        pd.cleaned_name,
        pd.raw_name,
        pd.draft_html,
        pd.generated_detail_html,
        pd.review_memo,
        pd.cost,
        pd.shipping_fee,
        pd.min_order_qty,
        pd.raw_price_field_name,
        pd.raw_price_value,
        pd.shipping_raw_field_name,
        pd.shipping_raw_value,
        pd.sell_unit_type,
        pd.bundle_quantity,
        pd.unit_cost_price,
        pd.bundle_cost_price,
        pd.category_text
      from product_drafts pd
      where pd.id = $1
    `,
    [draftId],
  ).catch(async () =>
    client.query(
      `
        select
          id,
          selling_title,
          cleaned_name,
          raw_name,
          draft_html,
          generated_detail_html,
          review_memo,
          cost,
          shipping_fee,
          min_order_qty,
          raw_price_field_name,
          raw_price_value,
          shipping_raw_field_name,
          shipping_raw_value,
          sell_unit_type,
          bundle_quantity,
          unit_cost_price,
          bundle_cost_price
        from product_drafts
        where id = $1
      `,
      [draftId],
    ),
  );
  const row = result.rows[0];
  if (!row) return;
  const canReplaceGeneratedHtml = !String(row.generated_detail_html || '').trim();
  const images = await client.query(
    `
      select *
      from product_images
      where product_draft_id = $1
      order by coalesce(sort_order, image_index), coalesce(slice_index, 0), image_index
    `,
    [draftId],
  );
  const imageEntries = images.rows.map((image) => ({
    url: image.stored_url || image.url,
    storedUrl: image.stored_url || image.url,
    imageType: image.image_type,
    sortOrder: image.sort_order,
    sliceIndex: image.slice_index,
  }));
  const displayName = row.selling_title || cleanProductName(row.cleaned_name || row.raw_name);
  const html = buildDetailHtml({
    name: displayName,
    images: imageEntries.map((image) => image.storedUrl || image.url),
    imageEntries,
    cost: row.cost,
    shippingFee: row.shipping_fee,
    minOrderQty: row.min_order_qty,
    rawPriceFieldName: row.raw_price_field_name,
    rawPriceValue: row.raw_price_value,
    shippingRawFieldName: row.shipping_raw_field_name,
    shippingRawValue: row.shipping_raw_value,
    sellUnitType: row.sell_unit_type,
    bundleQuantity: row.bundle_quantity,
    unitCostPrice: row.unit_cost_price,
    bundleCostPrice: row.bundle_cost_price,
  });
  await client.query(
    `
      update product_drafts
      set draft_html = $2,
          generated_detail_html = case when $3 then $2 else generated_detail_html end,
          updated_at = now()
      where id = $1
    `,
    [draftId, html, canReplaceGeneratedHtml],
  );
}

function readNumberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}
