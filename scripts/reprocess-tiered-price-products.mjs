import { join } from 'node:path';

import { loadDatabaseUrl, loadPricingRules } from '../src/config.mjs';
import { calculatePrices, filterProduct, normalizeProduct } from '../src/processing.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

const root = process.cwd();
const pricingRules = await loadPricingRules(join(root, 'pricing-rules.json'));
const dbUrl = await loadDatabaseUrl(root);
const db = await createPgPool(dbUrl);

const targetSupplierProductIds = (process.argv[2] || '50,51,56,76,3').split(',').map((s) => Number(s.trim()));

function toDraftStatus(filterStatus) {
  if (filterStatus === 'blocked') return 'blocked';
  if (filterStatus === 'needs_review') return 'needs_review';
  return 'draft';
}

try {
  const { rows } = await db.query(
    `select d.id as draft_id, d.supplier_product_id, d.supplier_product_no, d.status as old_status,
            sp.raw_json, sp.source_market
       from product_drafts d
       join supplier_products sp on sp.id = d.supplier_product_id
      where d.supplier_product_id = any($1::int[])
      order by d.supplier_product_id`,
    [targetSupplierProductIds],
  );

  for (const row of rows) {
    const normalized = normalizeProduct(row.supplier_product_no, row.raw_json, { sourceMarket: row.source_market });
    const filter = filterProduct(normalized);
    const prices = calculatePrices(normalized, pricingRules);
    const newStatus = toDraftStatus(filter.filterStatus);

    await db.query(
      `update product_drafts set
         cost = $2,
         shipping_fee = $3,
         raw_price_field_name = $4,
         raw_price_value = $5,
         price_parse_status = $6,
         price_tiers = $7::jsonb,
         min_order_qty = $8,
         order_unit = $9,
         sell_unit_type = $10,
         bundle_quantity = $11,
         unit_cost_price = $12,
         bundle_cost_price = $13,
         bundle_reason = $14,
         filter_status = $15,
         block_reasons = $16::jsonb,
         review_reasons = $17::jsonb,
         coupang_sale_price = $18,
         coupang_expected_profit = $19,
         coupang_margin_rate = $20,
         naver_sale_price = $21,
         naver_expected_profit = $22,
         naver_margin_rate = $23,
         status = $24,
         updated_at = now()
       where id = $1`,
      [
        row.draft_id,
        normalized.cost,
        normalized.shippingFee,
        normalized.rawPriceFieldName,
        normalized.rawPriceValue,
        normalized.priceParseStatus,
        JSON.stringify(normalized.priceTiers || []),
        normalized.minOrderQty,
        normalized.orderUnit,
        normalized.sellUnitType,
        normalized.bundleQuantity,
        normalized.unitCostPrice,
        normalized.bundleCostPrice,
        normalized.bundleReason,
        filter.filterStatus,
        JSON.stringify(filter.blockReasons || []),
        JSON.stringify(filter.reviewReasons || []),
        prices.coupangSalePrice ?? null,
        prices.coupangExpectedProfit ?? null,
        prices.coupangMarginRate ?? null,
        prices.naverSalePrice ?? null,
        prices.naverExpectedProfit ?? null,
        prices.naverMarginRate ?? null,
        newStatus,
      ],
    );

    console.log(
      `draft ${row.draft_id} (supplier_product_id=${row.supplier_product_id}): ` +
        `status ${row.old_status} -> ${newStatus}, ` +
        `cost -> ${normalized.cost} (unitCost=${normalized.unitCostPrice}, minOrderQty=${normalized.minOrderQty}, ` +
        `field=${normalized.rawPriceFieldName}), filterStatus=${filter.filterStatus}, reviewReasons=${JSON.stringify(filter.reviewReasons)}`,
    );
  }
} finally {
  await db.end();
}
