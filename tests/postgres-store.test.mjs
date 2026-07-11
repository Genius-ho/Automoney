import assert from 'node:assert/strict';
import test from 'node:test';

import { saveImportFailure, saveImportResult } from '../src/postgres-store.mjs';

test('saveImportResult upserts supplier product, draft, options, and images', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('select id from supplier_products')) return { rows: [] };
      if (sql.includes('insert into supplier_products')) return { rows: [{ id: 11 }] };
      if (sql.includes('insert into product_drafts')) return { rows: [{ id: 22 }] };
      return { rows: [] };
    },
  };

  const saved = await saveImportResult(client, {
    productNo: '49168396',
    raw: { item: { title: 'sample product' } },
    normalized: {
      name: 'sample product',
      cost: 10000,
      shippingFee: 3000,
      rawPriceFieldName: 'price.supply',
      rawPriceValue: '10000',
      priceParseStatus: 'ok',
      shippingRawFieldName: 'deli.supply.fee',
      shippingRawValue: '3000',
      shippingParseStatus: 'ok',
      priceTiers: [],
      shippingTiers: [],
      sourceMarket: 'domeme',
      minOrderQty: 1,
      orderUnit: 1,
      supplierProductUrl: 'https://domeggook.com/main/item/itemView.php?no=49168396&market=dome',
      sellUnitType: 'single',
      bundleQuantity: 1,
      unitCostPrice: 10000,
      bundleCostPrice: 10000,
      bundleReason: null,
      images: ['https://example.test/a.jpg', 'https://example.test/b.jpg'],
      options: [{ name: 'color', value: 'black', additionalPrice: 0, raw: { value: 'black' } }],
      detailHtml: '<p>detail</p>',
    },
    filter: {
      filterStatus: 'needs_review',
      blockReasons: [],
      reviewReasons: ['risk_keyword'],
    },
    prices: {
      coupangSalePrice: 18260,
      coupangExpectedProfit: 3251,
      coupangMarginRate: 0.18,
      naverSalePrice: 17290,
      naverExpectedProfit: 3253,
      naverMarginRate: 0.19,
    },
  });

  assert.deepEqual(saved, {
    supplierProductId: 11,
    draftId: 22,
    status: 'needs_review',
    dbAction: 'inserted',
  });
  assert.ok(calls[1].sql.includes('on conflict (supplier_product_no) do update'));
  assert.ok(calls[2].sql.includes('on conflict (supplier_product_no) do update'));
  assert.ok(calls[2].sql.includes("nullif(btrim(product_drafts.generated_detail_html), '') is null"));
  assert.equal(calls[2].sql.includes('product_drafts.generated_detail_html = product_drafts.draft_html'), false);
  assert.equal(calls[1].params[1], 'domeme');
  assert.equal(calls[2].params[15], 1);
  assert.equal(calls[2].params[16], 1);
  assert.equal(calls[2].params[17], 'https://domeggook.com/main/item/itemView.php?no=49168396&market=dome');
  assert.equal(calls[2].params[18], 'single');
  assert.equal(calls[2].params[19], 1);
  assert.equal(calls[2].params[20], 10000);
  assert.equal(calls[2].params[21], 10000);
  assert.equal(calls[2].params[25], 'needs_review');
  assert.equal(calls[2].params[26], '[]');
  assert.equal(calls[2].params[27], '["risk_keyword"]');
  assert.equal(calls.filter((call) => call.sql.includes('insert into product_options')).length, 1);
  assert.equal(calls.filter((call) => call.sql.includes('insert into product_images')).length, 2);
});

test('saveImportResult maps blocked and pass filter statuses to draft status', async () => {
  const statuses = [];
  const client = {
    async query(sql, params = []) {
      if (sql.startsWith('select id from supplier_products')) return { rows: [] };
      if (sql.includes('insert into supplier_products')) return { rows: [{ id: 1 }] };
      if (sql.includes('insert into product_drafts')) {
        statuses.push(params[34]);
        return { rows: [{ id: statuses.length }] };
      }
      return { rows: [] };
    },
  };
  const base = {
    productNo: '1',
    raw: {},
    normalized: { name: 'sample', images: [], options: [] },
    prices: {},
  };

  await saveImportResult(client, {
    ...base,
    filter: { filterStatus: 'blocked', blockReasons: ['blocked_low_margin'], reviewReasons: [] },
  });
  await saveImportResult(client, {
    ...base,
    filter: { filterStatus: 'pass', blockReasons: [], reviewReasons: [] },
  });

  assert.deepEqual(statuses, ['blocked', 'draft']);
});

test('saveImportResult reports updated when the supplier product already exists', async () => {
  const client = {
    async query(sql) {
      if (sql.startsWith('select id from supplier_products')) return { rows: [{ id: 11 }] };
      if (sql.includes('insert into supplier_products')) return { rows: [{ id: 11 }] };
      if (sql.includes('insert into product_drafts')) return { rows: [{ id: 22 }] };
      return { rows: [] };
    },
  };

  const saved = await saveImportResult(client, {
    productNo: '49168396',
    raw: {},
    normalized: { name: 'sample', images: [], options: [] },
    filter: { filterStatus: 'pass', blockReasons: [], reviewReasons: [] },
    prices: {},
  });

  assert.equal(saved.dbAction, 'updated');
});

test('saveImportFailure records failed drafts and reports action', async () => {
  const client = {
    async query(sql) {
      if (sql.startsWith('select id from supplier_products')) return { rows: [] };
      if (sql.includes('insert into supplier_products')) return { rows: [{ id: 11 }] };
      if (sql.includes('insert into product_drafts')) return { rows: [{ id: 22 }] };
      return { rows: [] };
    },
  };

  const saved = await saveImportFailure(client, {
    productNo: '49168396',
    reason: 'network unavailable',
  });

  assert.deepEqual(saved, {
    supplierProductId: 11,
    draftId: 22,
    status: 'failed',
    dbAction: 'inserted',
  });
});
