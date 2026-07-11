import { Client } from 'pg';

import { loadDatabaseUrl } from '../src/config.mjs';
import { runSchema } from '../src/postgres-store.mjs';
import { buildDetailHtml, cleanProductName, normalizeProduct, normalizeProductImageEntries } from '../src/processing.mjs';

let connectionString = '';
try {
  connectionString = await loadDatabaseUrl(process.cwd());
} catch {
  console.log('postgres=disabled');
  console.log('updatedDrafts=0');
  process.exit(0);
}

const client = new Client({ connectionString });
const fetchPages = !process.argv.includes('--no-page-fetch');
const delayMs = readNumberArg('--delay-ms', 300);

try {
  await client.connect();
  await runSchema(client);
  const rows = await client.query(
    `
      select
        pd.id as draft_id,
        pd.supplier_product_no,
        pd.selling_title,
        pd.draft_html,
        pd.generated_detail_html,
        pd.review_memo,
        pd.supplier_product_url,
        sp.raw_json,
        sp.source_market
      from product_drafts pd
      join supplier_products sp on sp.id = pd.supplier_product_id
      order by pd.id
    `,
  );

  let updatedDrafts = 0;
  let totalImages = 0;
  let regeneratedHtml = 0;
  let fetchedPages = 0;
  let pageFetchFailed = 0;
  let detailImageDrafts = 0;
  for (const row of rows.rows) {
    const normalized = normalizeProduct(row.supplier_product_no, row.raw_json, {
      requestedMarket: row.source_market === 'domeme' ? 'dome' : undefined,
      sourceMarket: row.source_market,
    });
    let pageHtml = '';
    if (fetchPages && !hasDetailImages(normalized.imageEntries) && row.supplier_product_url) {
      await delay(delayMs);
      const pageResult = await fetchSupplierProductPageHtml(row.supplier_product_url);
      if (pageResult.ok) {
        pageHtml = pageResult.html;
        fetchedPages += 1;
      } else {
        pageFetchFailed += 1;
      }
      await client.query(
        `
          update supplier_products
          set supplier_page_fetch_status = $2,
              supplier_page_fetch_error = $3,
              supplier_page_fetched_at = now()
          where supplier_product_no = $1
        `,
        [
          String(row.supplier_product_no),
          pageResult.ok ? 'ok' : 'supplier_page_fetch_failed',
          pageResult.ok ? null : `${pageResult.statusCode || 'ERR'} ${pageResult.reason || ''}`.trim(),
        ],
      );
    }
    const imageEntries = normalizeProductImageEntries({
      mainSource: normalized.imageEntries?.filter((image) => image.imageType === 'main').map((image) => image.url),
      detailHtml: normalized.detailHtml,
      pageHtml,
    });
    const images = imageEntries.map((image) => image.url);
    const displayName = row.selling_title || cleanProductName(normalized.name);
    const nextDraftHtml = buildDetailHtml({ ...normalized, name: displayName, images, imageEntries });
    const canReplaceGeneratedHtml = !String(row.generated_detail_html || '').trim();
    await client.query('begin');
    try {
      await client.query('delete from product_images where product_draft_id = $1', [row.draft_id]);
      for (const [index, image] of imageEntries.entries()) {
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
              source_method
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            row.draft_id,
            String(row.supplier_product_no),
            index,
            image.url,
            image.imageType || 'unknown',
            image.sortOrder ?? index,
            image.originalUrl || image.url,
            image.storedUrl || image.url,
            'api',
          ],
        );
      }
      await client.query(
        `
          update product_drafts
          set image_count = $2,
              draft_html = $3,
              generated_detail_html = case when $4 then $3 else generated_detail_html end,
              updated_at = now()
          where id = $1
        `,
        [row.draft_id, images.length, nextDraftHtml, canReplaceGeneratedHtml],
      );
      await client.query('commit');
      updatedDrafts += 1;
      totalImages += images.length;
      if (canReplaceGeneratedHtml) regeneratedHtml += 1;
      if (hasDetailImages(imageEntries)) detailImageDrafts += 1;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }

  console.log('postgres=enabled');
  console.log(`updatedDrafts=${updatedDrafts}`);
  console.log(`totalImages=${totalImages}`);
  console.log(`regeneratedHtml=${regeneratedHtml}`);
  console.log(`detailImageDrafts=${detailImageDrafts}`);
  console.log(`fetchedPages=${fetchedPages}`);
  console.log(`pageFetchFailed=${pageFetchFailed}`);
} catch (error) {
  console.log('postgres=error');
  console.log(`errorCode=${error.code || error.name || 'UNKNOWN'}`);
  console.log(`errorMessage=${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

export async function fetchSupplierProductPageHtml(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 AutomoneyImageDiagnostics/1.0',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) {
      return { ok: false, statusCode: response.status, reason: response.statusText || 'HTTP error' };
    }
    const contentType = response.headers.get('content-type') || '';
    const html = await response.text();
    if (!/html/i.test(contentType) && !/<html|<img/i.test(html)) {
      return { ok: false, statusCode: response.status, reason: 'non_html_response' };
    }
    return { ok: true, statusCode: response.status, html };
  } catch (error) {
    return { ok: false, statusCode: error.code || error.name || 'FETCH_ERROR', reason: error.message };
  }
}

function hasDetailImages(images = []) {
  return images.some((image) => image.imageType === 'detail');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function readNumberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}
