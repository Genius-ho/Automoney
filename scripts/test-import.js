#!/usr/bin/env node
import { join } from 'node:path';

import { loadDatabaseUrl, loadEnvConfig, loadPricingRules, loadProductNumbers } from '../src/config.mjs';
import { DomemeApiError, DomemeClient, maskApiKey } from '../src/domeme-client.mjs';
import { createPgPool, runSchema, saveImportResult } from '../src/postgres-store.mjs';
import {
  calculatePrices,
  cleanProductName,
  filterProduct,
  normalizeProduct,
} from '../src/processing.mjs';

const root = process.cwd();
const csvPath = join(root, 'data', 'test-products.csv');
const pricingPath = join(root, 'pricing-rules.json');

const config = await loadEnvConfig(root);
const productNumbers = (await loadProductNumbers(csvPath)).slice(0, 5);
const pricingRules = await loadPricingRules(pricingPath);
let pgPool = null;
let schemaApplied = false;
let databaseUrl = '';
try {
  databaseUrl = await loadDatabaseUrl(root);
  pgPool = await createPgPool(databaseUrl);
  await pgPool.query('select 1');
  console.log('postgres=enabled');
  await runSchema(pgPool);
  schemaApplied = true;
} catch (error) {
  const errorDetails = describeError(error);
  console.log(`postgres=${databaseUrl ? 'error' : 'disabled'}`);
  console.log('schemaApplied=false');
  console.log(`dbSaved=false`);
  console.log('dbAction=skipped');
  console.log('supplierProductId=-');
  console.log('draftId=-');
  console.log(`dbSaveReason=${errorDetails.message}`);
  console.log(`dbErrorName=${errorDetails.name}`);
  console.log(`dbErrorCode=${errorDetails.code}`);
  if (pgPool) await pgPool.end();
  process.exitCode = 1;
  process.exit();
}
const client = new DomemeClient({
  apiKey: config.domemeApiKey,
  endpoint: config.domemeEndpoint,
});

console.log(`Import test: ${productNumbers.length} Domeme products`);
console.log(`Domeme API key: ${maskApiKey(config.domemeApiKey)}`);
console.log(`schemaApplied=${schemaApplied ? 'true' : 'false'}`);

for (const productNo of productNumbers) {
  try {
    const response = await client.fetchProductDetailResponse(productNo);

    const apiError = extractApiError(response.raw);
    if (apiError) {
      console.log(
        [
          `product=${productNo}`,
          `http=${response.status}`,
          'rawName=-',
          'cost=-',
          'shipping=-',
          'images=-',
          'options=-',
          'filter=api_error',
          'coupang=-',
          'smartstore=-',
          `body=${apiError}`,
        ].join(' | '),
      );
      continue;
    }

    const normalized = normalizeProduct(productNo, response.raw);
    const filter = filterProduct(normalized);
    const cleanedName = cleanProductName(normalized.name);
    const canCalculatePrices = !filter.blockReasons.some((reason) =>
      ['price_parsing_error', 'price_invalid_range', 'missing_or_invalid_cost'].includes(reason),
    );
    const prices = canCalculatePrices
      ? calculatePrices({ ...normalized, name: cleanedName }, pricingRules)
      : {};
    const dbSave = await saveToPostgres(pgPool, {
      productNo,
      raw: response.raw,
      normalized,
      filter,
      prices,
    });

    printProductSummary({
      productNo,
      httpStatus: response.status,
      rawName: normalized.name || '-',
      rawPriceFieldName: normalized.rawPriceFieldName || '-',
      rawPriceValue: normalized.rawPriceValue ?? '-',
      priceTiers: normalized.priceTiers,
      minOrderQty: normalized.minOrderQty,
      parsedCost: normalized.cost,
      priceParseStatus: normalized.priceParseStatus,
      shippingRawFieldName: normalized.shippingRawFieldName || '-',
      shippingRawValue: normalized.shippingRawValue ?? '-',
      shippingTiers: normalized.shippingTiers,
      shippingParseStatus: normalized.shippingParseStatus,
      shipping: normalized.shippingFee,
      images: normalized.images.length,
      options: normalized.options.length,
      filterStatus: filter.filterStatus,
      blockReasons: filter.blockReasons,
      reviewReasons: filter.reviewReasons,
      coupangSalePrice: prices.coupangSalePrice ?? '-',
      coupangExpectedProfit: prices.coupangExpectedProfit ?? '-',
      coupangMarginRate: prices.coupangMarginRate ?? '-',
      naverSalePrice: prices.naverSalePrice ?? '-',
      naverExpectedProfit: prices.naverExpectedProfit ?? '-',
      naverMarginRate: prices.naverMarginRate ?? '-',
      dbSave,
    });
  } catch (error) {
    if (error instanceof DomemeApiError) {
      printProductSummary({
        productNo,
        httpStatus: error.status,
        rawName: '-',
        rawPriceFieldName: '-',
        rawPriceValue: '-',
        priceTiers: undefined,
        minOrderQty: '-',
        parsedCost: '-',
        priceParseStatus: 'missing',
        shippingRawFieldName: '-',
        shippingRawValue: '-',
        shippingTiers: undefined,
        shippingParseStatus: 'missing',
        shipping: '-',
        images: '-',
        options: '-',
        filterStatus: 'blocked',
        blockReasons: ['api_error', error.bodyPreview || 'unknown_error'],
        reviewReasons: [],
        coupangSalePrice: '-',
        coupangExpectedProfit: '-',
        coupangMarginRate: '-',
        naverSalePrice: '-',
        naverExpectedProfit: '-',
        naverMarginRate: '-',
      dbSave: { saved: false, reason: 'api_error', draftId: null },
      });
      if (error.status === 404) {
        console.log(`product=${productNo} | maskedUrl=${error.maskedUrl}`);
      }
    } else {
      const reason = error instanceof Error ? error.message : String(error);
      printProductSummary({
        productNo,
        httpStatus: '-',
        rawName: '-',
        rawPriceFieldName: '-',
        rawPriceValue: '-',
        priceTiers: undefined,
        minOrderQty: '-',
        parsedCost: '-',
        priceParseStatus: 'missing',
        shippingRawFieldName: '-',
        shippingRawValue: '-',
        shippingTiers: undefined,
        shippingParseStatus: 'missing',
        shipping: '-',
        images: '-',
        options: '-',
        filterStatus: 'blocked',
        blockReasons: [`failed:${reason}`],
        reviewReasons: [],
        coupangSalePrice: '-',
        coupangExpectedProfit: '-',
        coupangMarginRate: '-',
        naverSalePrice: '-',
        naverExpectedProfit: '-',
        naverMarginRate: '-',
        dbSave: { saved: false, reason: 'import_failed', draftId: null },
      });
    }
  }
}

await pgPool.end();

function extractApiError(raw) {
  const error = raw?.errors || raw?.error;
  if (!error) return null;
  if (typeof error === 'string') return error.slice(0, 300);
  return [
    error.code || error.dcode,
    error.message,
    error.dmessage,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

function describeError(error) {
  const nested = Array.isArray(error?.errors) ? error.errors.find(Boolean) : null;
  return {
    name: error?.name || nested?.name || error?.cause?.name || 'Error',
    code: error?.code || nested?.code || error?.cause?.code || 'UNKNOWN',
    message:
      error?.message ||
      nested?.message ||
      error?.cause?.message ||
      String(error || 'Unknown database error'),
  };
}

function printProductSummary(summary) {
  console.log(`product=${summary.productNo}`);
  console.log(`http=${summary.httpStatus}`);
  console.log(`rawName=${summary.rawName}`);
  console.log(`rawPriceFieldName=${summary.rawPriceFieldName}`);
  console.log(`rawPriceValue=${summary.rawPriceValue}`);
  console.log(`priceParseStatus=${summary.priceParseStatus}`);
  console.log(`priceTiers=${formatTiers(summary.priceTiers)}`);
  console.log(`minOrderQty=${summary.minOrderQty ?? '-'}`);
  console.log(`parsedCost=${summary.parsedCost}`);
  console.log(`cost=${summary.parsedCost}`);
  console.log(`shippingRawFieldName=${summary.shippingRawFieldName}`);
  console.log(`shippingRawValue=${summary.shippingRawValue}`);
  console.log(`shippingParseStatus=${summary.shippingParseStatus}`);
  console.log(`shippingTiers=${formatTiers(summary.shippingTiers)}`);
  console.log(`shipping=${summary.shipping}`);
  console.log(`images=${summary.images}`);
  console.log(`options=${summary.options}`);
  console.log(`filterStatus=${summary.filterStatus}`);
  console.log(`blockReasons=${formatReasons(summary.blockReasons)}`);
  console.log(`reviewReasons=${formatReasons(summary.reviewReasons)}`);
  console.log(`coupangSalePrice=${summary.coupangSalePrice}`);
  console.log(`coupangExpectedProfit=${summary.coupangExpectedProfit}`);
  console.log(`coupangMarginRate=${summary.coupangMarginRate}`);
  console.log(`naverSalePrice=${summary.naverSalePrice}`);
  console.log(`naverExpectedProfit=${summary.naverExpectedProfit}`);
  console.log(`naverMarginRate=${summary.naverMarginRate}`);
  console.log(`dbSaved=${summary.dbSave?.saved ? 'true' : 'false'}`);
  console.log(`dbAction=${summary.dbSave?.dbAction ?? 'skipped'}`);
  console.log(`supplierProductId=${summary.dbSave?.supplierProductId ?? '-'}`);
  console.log(`draftId=${summary.dbSave?.draftId ?? '-'}`);
  if (summary.dbSave?.tableCounts) {
    console.log(`supplierProducts=${summary.dbSave.tableCounts.supplierProducts}`);
    console.log(`productDrafts=${summary.dbSave.tableCounts.productDrafts}`);
    console.log(`productOptions=${summary.dbSave.tableCounts.productOptions}`);
    console.log(`productImages=${summary.dbSave.tableCounts.productImages}`);
  }
  if (!summary.dbSave?.saved && summary.dbSave?.reason) console.log(`dbSaveReason=${summary.dbSave.reason}`);
  console.log('');
}

function formatReasons(reasons = []) {
  return `[${reasons.join(',')}]`;
}

function formatTiers(tiers) {
  if (!tiers || tiers.length === 0) return '[]';
  return `[${tiers.map((tier) => `{minQty:${tier.minQty},price:${tier.price}}`).join(',')}]`;
}

async function saveToPostgres(pool, result) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const saved = await saveImportResult(client, result);
    const tableCounts = await readSavedTableCounts(client, result.productNo, saved.draftId);
    const dbSaved =
      tableCounts.supplierProducts === 1 &&
      tableCounts.productDrafts === 1 &&
      tableCounts.productOptions === (result.normalized.options || []).length &&
      tableCounts.productImages === (result.normalized.images || []).length;
    await client.query('commit');
    return {
      saved: dbSaved,
      dbAction: saved.dbAction,
      supplierProductId: saved.supplierProductId,
      draftId: saved.draftId,
      status: saved.status,
      tableCounts,
    };
  } catch (error) {
    await client.query('rollback');
    const details = describeError(error);
    return {
      saved: false,
      reason: details.message,
      draftId: null,
    };
  } finally {
    client.release();
  }
}

async function readSavedTableCounts(client, productNo, draftId) {
  const supplierProducts = await readCount(
    client,
    'select count(*)::int as count from supplier_products where supplier_product_no = $1',
    [
      String(productNo),
    ],
  );
  const productDrafts = await readCount(
    client,
    'select count(*)::int as count from product_drafts where supplier_product_no = $1',
    [
      String(productNo),
    ],
  );
  const productOptions = await readCount(
    client,
    'select count(*)::int as count from product_options where product_draft_id = $1',
    [draftId],
  );
  const productImages = await readCount(
    client,
    'select count(*)::int as count from product_images where product_draft_id = $1',
    [draftId],
  );
  return { supplierProducts, productDrafts, productOptions, productImages };
}

async function readCount(client, sql, params) {
  const result = await client.query(sql, params);
  return result.rows[0]?.count ?? 0;
}
