import assert from 'node:assert/strict';
import test from 'node:test';

import { processProduct, processProducts } from '../src/pipeline.mjs';

test('processProduct saves raw response and successful product draft to PostgreSQL store', async () => {
  const db = createMockPgClient();
  const client = {
    async fetchProductDetail() {
      return {
        productName: '고급 바나나',
        supplyPrice: '6000',
        deliveryFee: '1000',
        images: ['https://example.test/a.jpg'],
        detailHtml: '<p>상세</p>',
      };
    },
  };
  const pricingRules = {
    defaultMarginRate: 0.25,
    platforms: {
      coupang: { feeRate: 0.11, roundTo: 10 },
      smartstore: { feeRate: 0.06, roundTo: 10 },
    },
  };

  const result = await processProduct({ productNo: '49168396', client, db, pricingRules });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.productNo, '49168396');
  assert.equal(result.coupangPrice, 9840);
  assert.equal(result.smartstorePrice, 9310);
  assert.ok(db.calls.some((call) => call.sql.includes('insert into supplier_products')));
  assert.ok(db.calls.some((call) => call.sql.includes('insert into product_drafts')));
  assert.ok(db.calls.some((call) => call.sql.includes('insert into product_images')));
});

test('processProduct stores failed draft when API fetch fails', async () => {
  const db = createMockPgClient();
  const client = {
    async fetchProductDetail() {
      throw new Error('network unavailable');
    },
  };

  const result = await processProduct({
    productNo: '50307216',
    client,
    db,
    pricingRules: { platforms: {} },
  });

  assert.equal(result.status, 'FAILED');
  assert.equal(result.reason, 'network unavailable');
  const draftCall = db.calls.find((call) => call.sql.includes('insert into product_drafts'));
  assert.equal(draftCall.params[25], 'blocked');
  assert.equal(draftCall.params[26], '["api_error","network unavailable"]');
  assert.equal(draftCall.params[34], 'failed');
});

test('processProducts continues after a failed product', async () => {
  const db = createMockPgClient();
  const client = {
    async fetchProductDetail(productNo) {
      if (productNo === '50307216') throw new Error('temporary API error');
      return {
        productName: '고급 바나나',
        supplyPrice: '6000',
        images: ['https://example.test/a.jpg'],
      };
    },
  };

  const results = await processProducts({
    productNumbers: ['50307216', '49168396'],
    client,
    db,
    pricingRules: {
      platforms: {
        coupang: { feeRate: 0.11, roundTo: 10 },
        smartstore: { feeRate: 0.06, roundTo: 10 },
      },
    },
  });

  assert.deepEqual(
    results.map((result) => result.status),
    ['FAILED', 'SUCCESS'],
  );
});

function createMockPgClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('insert into supplier_products')) return { rows: [{ id: calls.length }] };
      if (sql.includes('insert into product_drafts')) return { rows: [{ id: calls.length }] };
      return { rows: [] };
    },
  };
}
