import { readFile } from 'node:fs/promises';

import { buildDetailHtml, cleanProductName } from './processing.mjs';

export async function createPgPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL save');
  const { Pool } = await import('pg');
  return new Pool({ connectionString });
}

export async function runSchema(client, schemaPath = 'schema.sql') {
  await client.query(await readFile(schemaPath, 'utf8'));
}

export async function saveImportResult(client, result) {
  const { productNo, raw, normalized, filter, prices, importBatchId, collectedAt } = result;
  const existed = await supplierProductExists(client, productNo);
  const detailHtml = normalized.detailHtml || null;
  const supplierProduct = await upsertSupplierProduct(client, productNo, raw, detailHtml, normalized.sourceMarket);
  const draftStatus = toDraftStatus(filter.filterStatus);
  const cleanedName = cleanProductName(normalized.name);
  const sellingTitle = buildBundleDisplayProductName(cleanedName, normalized);
  const draftHtml = buildDetailHtml({ ...normalized, name: sellingTitle });
  const draft = await upsertProductDraft(client, {
    supplierProductId: supplierProduct.id,
    productNo,
    normalized,
    filter,
    prices,
    cleanedName,
    sellingTitle,
    draftStatus,
    draftHtml,
    importBatchId,
    collectedAt,
  });

  await replaceOptions(client, draft.id, productNo, normalized.options || []);
  await replaceImages(client, draft.id, productNo, normalized.imageEntries || normalized.images || []);

  return {
    supplierProductId: supplierProduct.id,
    draftId: draft.id,
    status: draftStatus,
    dbAction: existed ? 'updated' : 'inserted',
  };
}

export async function saveImportFailure(client, { productNo, reason }) {
  const existed = await supplierProductExists(client, productNo);
  const supplierProduct = await upsertSupplierProduct(client, productNo, { error: reason }, null, 'unknown');
  const draft = await upsertProductDraft(client, {
    supplierProductId: supplierProduct.id,
    productNo,
    normalized: { name: null, images: [], options: [] },
    filter: { filterStatus: 'blocked', blockReasons: ['api_error', reason], reviewReasons: [] },
    prices: {},
    cleanedName: null,
    draftStatus: 'failed',
    draftHtml: null,
  });

  await replaceOptions(client, draft.id, productNo, []);
  await replaceImages(client, draft.id, productNo, []);
  return {
    supplierProductId: supplierProduct.id,
    draftId: draft.id,
    status: 'failed',
    dbAction: existed ? 'updated' : 'inserted',
  };
}

function toDraftStatus(filterStatus) {
  if (filterStatus === 'blocked') return 'blocked';
  if (filterStatus === 'needs_review') return 'needs_review';
  return 'draft';
}

async function supplierProductExists(client, productNo) {
  const result = await client.query(
    'select id from supplier_products where supplier_product_no = $1',
    [String(productNo)],
  );
  return result.rows.length > 0;
}

async function upsertSupplierProduct(client, productNo, raw, originalDetailHtml, sourceMarket = 'unknown') {
  const result = await client.query(
    `
      insert into supplier_products (
        supplier,
        supplier_product_no,
        source_market,
        raw_json,
        original_detail_html,
        fetched_at,
        updated_at
      )
      values ('domeme', $1, $2, $3::jsonb, $4, now(), now())
      on conflict (supplier_product_no) do update set
        source_market = excluded.source_market,
        raw_json = excluded.raw_json,
        original_detail_html = excluded.original_detail_html,
        fetched_at = now(),
        updated_at = now()
      returning id
    `,
    [String(productNo), sourceMarket || 'unknown', JSON.stringify(raw), originalDetailHtml],
  );
  return result.rows[0];
}

async function upsertProductDraft(client, draft) {
  const n = draft.normalized;
  const f = draft.filter;
  const p = draft.prices || {};
  const result = await client.query(
    `
      insert into product_drafts (
        supplier_product_id,
        supplier_product_no,
        raw_name,
        cleaned_name,
        selling_title,
        cost,
        shipping_fee,
        raw_price_field_name,
        raw_price_value,
        price_parse_status,
        shipping_raw_field_name,
        shipping_raw_value,
        shipping_parse_status,
        price_tiers,
        shipping_tiers,
        min_order_qty,
        order_unit,
        supplier_product_url,
        sell_unit_type,
        bundle_quantity,
        unit_cost_price,
        bundle_cost_price,
        bundle_reason,
        image_count,
        option_count,
        filter_status,
        block_reasons,
        review_reasons,
        coupang_sale_price,
        coupang_expected_profit,
        coupang_margin_rate,
        naver_sale_price,
        naver_expected_profit,
        naver_margin_rate,
        status,
        draft_html,
        generated_detail_html,
        import_batch_id,
        collected_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25, $26, $27::jsonb, $28::jsonb,
        $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, now()
      )
      on conflict (supplier_product_no) do update set
        supplier_product_id = excluded.supplier_product_id,
        raw_name = excluded.raw_name,
        cleaned_name = excluded.cleaned_name,
        selling_title = coalesce(product_drafts.selling_title, excluded.selling_title),
        cost = excluded.cost,
        shipping_fee = excluded.shipping_fee,
        raw_price_field_name = excluded.raw_price_field_name,
        raw_price_value = excluded.raw_price_value,
        price_parse_status = excluded.price_parse_status,
        shipping_raw_field_name = excluded.shipping_raw_field_name,
        shipping_raw_value = excluded.shipping_raw_value,
        shipping_parse_status = excluded.shipping_parse_status,
        price_tiers = excluded.price_tiers,
        shipping_tiers = excluded.shipping_tiers,
        min_order_qty = excluded.min_order_qty,
        order_unit = excluded.order_unit,
        supplier_product_url = excluded.supplier_product_url,
        sell_unit_type = excluded.sell_unit_type,
        bundle_quantity = excluded.bundle_quantity,
        unit_cost_price = excluded.unit_cost_price,
        bundle_cost_price = excluded.bundle_cost_price,
        bundle_reason = excluded.bundle_reason,
        image_count = excluded.image_count,
        option_count = excluded.option_count,
        filter_status = excluded.filter_status,
        block_reasons = excluded.block_reasons,
        review_reasons = excluded.review_reasons,
        coupang_sale_price = excluded.coupang_sale_price,
        coupang_expected_profit = excluded.coupang_expected_profit,
        coupang_margin_rate = excluded.coupang_margin_rate,
        naver_sale_price = excluded.naver_sale_price,
        naver_expected_profit = excluded.naver_expected_profit,
        naver_margin_rate = excluded.naver_margin_rate,
        status = excluded.status,
        draft_html = excluded.draft_html,
        generated_detail_html = case
          when nullif(btrim(product_drafts.generated_detail_html), '') is null then excluded.generated_detail_html
          else product_drafts.generated_detail_html
        end,
        import_batch_id = coalesce(excluded.import_batch_id, product_drafts.import_batch_id),
        collected_at = coalesce(excluded.collected_at, product_drafts.collected_at),
        updated_at = now()
      returning id
    `,
    [
      draft.supplierProductId,
      String(draft.productNo),
      n.name || null,
      draft.cleanedName || null,
      draft.sellingTitle || draft.cleanedName || null,
      n.cost || 0,
      n.shippingFee || 0,
      n.rawPriceFieldName || null,
      n.rawPriceValue == null ? null : String(n.rawPriceValue),
      n.priceParseStatus || null,
      n.shippingRawFieldName || null,
      n.shippingRawValue == null ? null : String(n.shippingRawValue),
      n.shippingParseStatus || null,
      JSON.stringify(n.priceTiers || []),
      JSON.stringify(n.shippingTiers || []),
      n.minOrderQty || 1,
      n.orderUnit || 1,
      n.supplierProductUrl || null,
      n.sellUnitType || 'single',
      n.bundleQuantity || 1,
      n.unitCostPrice ?? n.cost ?? null,
      n.bundleCostPrice ?? n.cost ?? null,
      n.bundleReason || null,
      (n.images || []).length,
      (n.options || []).length,
      f.filterStatus,
      JSON.stringify(f.blockReasons || []),
      JSON.stringify(f.reviewReasons || []),
      p.coupangSalePrice ?? null,
      p.coupangExpectedProfit ?? null,
      p.coupangMarginRate ?? null,
      p.naverSalePrice ?? null,
      p.naverExpectedProfit ?? null,
      p.naverMarginRate ?? null,
      draft.draftStatus,
      draft.draftHtml,
      draft.draftHtml,
      draft.importBatchId ?? null,
      draft.collectedAt ?? null,
    ],
  );
  return result.rows[0];
}

function buildDisplayProductName(name, product) {
  const value = String(name || '').trim();
  if (product.sellUnitType !== 'bundle') return value;
  const suffix = `${product.bundleQuantity || product.minOrderQty || 1}개 세트`;
  return value.endsWith(suffix) ? value : `${value} ${suffix}`;
}

function buildBundleDisplayProductName(name, product) {
  const value = String(name || '').trim();
  if (product.sellUnitType !== 'bundle') return value;
  const suffix = `${product.bundleQuantity || product.minOrderQty || 1}\uAC1C \uC138\uD2B8`;
  return value.endsWith(suffix) ? value : `${value} ${suffix}`;
}

async function replaceOptions(client, draftId, productNo, options) {
  await client.query('delete from product_options where product_draft_id = $1', [draftId]);
  for (const [index, option] of options.entries()) {
    await client.query(
      `
        insert into product_options (
          product_draft_id,
          supplier_product_no,
          option_index,
          name,
          value,
          additional_price,
          stock_quantity,
          option_code,
          raw_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        draftId,
        String(productNo),
        index,
        option.name || null,
        option.value || null,
        option.additionalPrice || 0,
        option.stockQuantity ?? null,
        option.optionCode ?? null,
        JSON.stringify(option.raw ?? option),
      ],
    );
  }
}

async function replaceImages(client, draftId, productNo, images) {
  await client.query('delete from product_images where product_draft_id = $1', [draftId]);
  for (const [index, image] of images.entries()) {
    const entry = typeof image === 'string' ? { url: image, imageType: index === 0 ? 'main' : 'unknown' } : image;
    const url = entry.url || entry.originalUrl || entry.storedUrl;
    if (!url) continue;
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
        draftId,
        String(productNo),
        index,
        url,
        entry.imageType || entry.image_type || 'unknown',
        entry.sortOrder ?? entry.sort_order ?? index,
        entry.originalUrl || entry.original_url || url,
        entry.storedUrl || entry.stored_url || url,
        entry.sourceMethod || entry.source_method || 'api',
      ],
    );
  }
}
