// Extracted (single-draft scope) from scripts/slice-long-images.js's
// per-image loop, so a freshly batch-created draft can be sliced
// immediately without waiting for that script's full-table sweep. A
// product's detail page is often ONE very tall image on Domeggook/Domeme
// (sliced into several detail_slice pieces below), but some suppliers
// instead provide several separate normal-sized detail images (confirmed
// live via Stage 2 auto-discovery batch candidates -- e.g. 8 photos around
// 800x1300px, none tall enough to count as "long"). Either way,
// product-job-folder.mjs's buildAnalysisInputPackage only ever reads
// image_type='detail_slice' rows, so a normal-sized detail image is copied
// through as its own single slice rather than being silently dropped --
// without this, any draft using the "several separate photos" format would
// never have analyzable detail images at all.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SLICE_HEIGHT = 1600;
const OVERLAP = 50;
const LONG_IMAGE_MIN_HEIGHT = 3000;
const LONG_IMAGE_MIN_ASPECT_RATIO = 4;

export async function sliceLongDetailImagesForDraft(db, draftId, { rootDir, fetchImpl = globalThis.fetch, loadSharpImpl } = {}) {
  const generatedRoot = join(resolve(rootDir), 'public', 'generated-images', 'drafts');
  const sharp = loadSharpImpl ? await loadSharpImpl() : (await import('sharp')).default;

  const rows = await db.query(
    `select id, product_draft_id, supplier_product_no, image_index, url, original_url, stored_url, image_type
     from product_images
     where product_draft_id = $1 and image_type in ('detail', 'detail_full') and parent_image_id is null
     order by image_index`,
    [draftId],
  );

  let checked = 0;
  let longImages = 0;
  let generatedSlices = 0;
  let directSlices = 0;
  let failed = 0;
  const failures = [];

  for (const row of rows.rows) {
    checked += 1;
    try {
      const response = await fetchImpl(row.original_url || row.url, {
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 AutomoneyImageSlicer/1.0', accept: 'image/*,*/*' },
      });
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const image = sharp(buffer);
      const metadata = await image.metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const aspectRatio = width > 0 ? height / width : null;
      const isLongImage = width > 0 && height > 0 && (height >= LONG_IMAGE_MIN_HEIGHT || aspectRatio >= LONG_IMAGE_MIN_ASPECT_RATIO);

      await db.query(
        'update product_images set width = $2, height = $3, aspect_ratio = $4, is_long_image = $5 where id = $1',
        [row.id, width || null, height || null, aspectRatio, isLongImage],
      );

      const draftDir = join(generatedRoot, String(draftId));
      await mkdir(draftDir, { recursive: true });

      if (isLongImage) {
        longImages += 1;
        await db.query("update product_images set image_type = 'detail_full' where id = $1", [row.id]);
        await db.query('delete from product_images where product_draft_id = $1 and image_type = $2 and parent_image_id = $3', [draftId, 'detail_slice', row.id]);

        const nextIndexResult = await db.query('select coalesce(max(image_index), -1)::int + 1 as next_index from product_images where product_draft_id = $1', [draftId]);
        const baseIndex = nextIndexResult.rows[0]?.next_index || 0;

        let top = 0;
        let sliceIndex = 1;
        while (top < height) {
          const sliceHeight = Math.min(SLICE_HEIGHT, height - top);
          const fileName = `detail-${row.id}-slice-${String(sliceIndex).padStart(3, '0')}.jpg`;
          const filePath = join(draftDir, fileName);
          await sharp(buffer).extract({ left: 0, top, width, height: sliceHeight }).jpeg({ quality: 88 }).toFile(filePath);
          const publicUrl = `/generated-images/drafts/${draftId}/${fileName}`;
          await db.query(
            `insert into product_images (
               product_draft_id, supplier_product_no, image_index, url, image_type, sort_order,
               original_url, stored_url, width, height, aspect_ratio, is_long_image, parent_image_id, slice_index, source_method
             ) values ($1,$2,$3,$4,'detail_slice',$5,$6,$7,$8,$9,$10,false,$11,$12,'long_slice')`,
            [
              draftId, row.supplier_product_no, baseIndex + sliceIndex - 1, row.original_url || row.url,
              1000 + sliceIndex, row.original_url || row.url, publicUrl, width, sliceHeight, sliceHeight / width,
              row.id, sliceIndex,
            ],
          );
          generatedSlices += 1;
          if (top + sliceHeight >= height) break;
          top += Math.max(1, SLICE_HEIGHT - OVERLAP);
          sliceIndex += 1;
        }
        continue;
      }

      // Not a long scrolling page -- a normal-sized detail photo among
      // several separate ones. Copy it through as its own single
      // detail_slice (re-encoded to jpeg for consistency with the sliced
      // path) rather than dropping it, so it's still analyzable.
      if (width <= 0 || height <= 0) continue; // metadata read failed -- nothing usable to copy
      await db.query('delete from product_images where product_draft_id = $1 and image_type = $2 and parent_image_id = $3', [draftId, 'detail_slice', row.id]);
      const nextIndexResult = await db.query('select coalesce(max(image_index), -1)::int + 1 as next_index from product_images where product_draft_id = $1', [draftId]);
      const baseIndex = nextIndexResult.rows[0]?.next_index || 0;
      const fileName = `detail-${row.id}-slice-001.jpg`;
      const filePath = join(draftDir, fileName);
      await sharp(buffer).jpeg({ quality: 88 }).toFile(filePath);
      const publicUrl = `/generated-images/drafts/${draftId}/${fileName}`;
      await db.query(
        `insert into product_images (
           product_draft_id, supplier_product_no, image_index, url, image_type, sort_order,
           original_url, stored_url, width, height, aspect_ratio, is_long_image, parent_image_id, slice_index, source_method
         ) values ($1,$2,$3,$4,'detail_slice',$5,$6,$7,$8,$9,$10,false,$11,1,'direct_copy')`,
        [draftId, row.supplier_product_no, baseIndex, row.original_url || row.url, 1000, row.original_url || row.url, publicUrl, width, height, aspectRatio, row.id],
      );
      directSlices += 1;
    } catch (error) {
      failed += 1;
      failures.push({ imageId: row.id, message: error.message });
    }
  }

  return { checked, longImages, generatedSlices, directSlices, failed, failures };
}
