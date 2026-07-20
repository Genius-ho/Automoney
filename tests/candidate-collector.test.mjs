import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DomemeApiError } from '../src/domeme-client.mjs';
import {
  canCalculatePrices,
  collectCandidates,
  evaluateCandidates,
  isImportableCandidate,
  parseCandidateCsv,
  saveEvaluatedCandidate,
  scoreCandidate,
} from '../src/candidate-collector.mjs';

function fakeProductRaw(overrides = {}) {
  return {
    productName: '수납 정리함',
    supplyPrice: '10000',
    deliveryFee: '3000',
    option: [{ name: '색상', values: ['블랙'] }],
    images: ['https://example.test/a.jpg'],
    detailHtml: '<p>상세</p>',
    ...overrides,
  };
}

function fakeClient({ pages = [[{ productNo: '1' }, { productNo: '2' }]], details = {} } = {}) {
  let call = 0;
  return {
    buildProductSearchUrl: () => 'https://example.test/search',
    async searchProducts() {
      const result = { candidates: pages[Math.min(call, pages.length - 1)] || [] };
      call += 1;
      return result;
    },
    async fetchProductDetail(productNo) {
      return details[productNo] || fakeProductRaw();
    },
  };
}

test('collectCandidates dedups by productNo across pages and stops once the target count is reached', async () => {
  const client = fakeClient({ pages: [[{ productNo: '1' }, { productNo: '2' }], [{ productNo: '2' }, { productNo: '3' }], []] });
  const summary = { duplicateSkipped: 0 };
  const candidates = await collectCandidates(client, ['keyword'], {
    targetCandidateCount: 10, pageSize: 50, includeDomeggook: false, root: '/repo', summary,
  });
  assert.deepEqual(candidates.map((c) => c.productNo), ['1', '2', '3']);
  assert.equal(summary.duplicateSkipped, 1);
});

test('collectCandidates falls back to CSV candidates when Domeme returns 403 FORBIDDEN', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'manual-candidates.csv'), 'product_no\n11111\n22222\n', 'utf8');

  const client = {
    buildProductSearchUrl: () => 'https://example.test/search',
    async searchProducts() {
      throw new DomemeApiError({ status: 403, operation: 'product search', code: 'FORBIDDEN' });
    },
  };
  const summary = { duplicateSkipped: 0 };
  const candidates = await collectCandidates(client, ['keyword'], {
    targetCandidateCount: 10, pageSize: 50, includeDomeggook: false, root, summary,
  });
  assert.deepEqual(candidates.map((c) => c.productNo), ['11111', '22222']);
});

test('evaluateCandidates reads includeNeedsReview/includeDomeggook from explicit options, not module-scope globals', async () => {
  const client = fakeClient({ details: { 1: fakeProductRaw({ option: Array.from({ length: 15 }, (_, i) => ({ name: '옵션', values: [`값${i}`] })) }) } });
  const candidates = [{ productNo: '1', requestedMarket: 'dome' }];

  const withoutReview = await evaluateCandidates(client, candidates, {}, { includeNeedsReview: false });
  assert.equal(withoutReview[0].filter.filterStatus, 'needs_review');
  assert.equal(withoutReview[0].importable, false);

  const withReview = await evaluateCandidates(client, candidates, {}, { includeNeedsReview: true });
  assert.equal(withReview[0].importable, true);
});

test('evaluateCandidates records a failed entry (not a thrown error) when fetchProductDetail rejects', async () => {
  const client = {
    async fetchProductDetail() { throw new Error('boom'); },
  };
  const [result] = await evaluateCandidates(client, [{ productNo: '1' }], {});
  assert.equal(result.filter.filterStatus, 'failed');
  assert.equal(result.importable, false);
  assert.ok(result.error instanceof Error);
});

test('isImportableCandidate excludes domeggook-sourced products unless includeDomeggook is set', () => {
  const filter = { filterStatus: 'pass', blockReasons: [], reviewReasons: [] };
  assert.equal(isImportableCandidate(filter, { product: { sourceMarket: 'domeggook' }, includeDomeggook: false }), false);
  assert.equal(isImportableCandidate(filter, { product: { sourceMarket: 'domeggook' }, includeDomeggook: true }), true);
});

test('scoreCandidate ranks pass below needs_review below blocked', () => {
  const pass = scoreCandidate({ filterStatus: 'pass' }, {});
  const review = scoreCandidate({ filterStatus: 'needs_review', reviewReasons: ['a'] }, {});
  const blocked = scoreCandidate({ filterStatus: 'blocked', blockReasons: ['a', 'b'] }, {});
  assert.ok(pass < review);
  assert.ok(review < blocked);
});

test('canCalculatePrices is false when a price-parsing block reason is present', () => {
  assert.equal(canCalculatePrices({ blockReasons: ['price_parsing_error'] }), false);
  assert.equal(canCalculatePrices({ blockReasons: [] }), true);
});

test('parseCandidateCsv recognizes a product_no header and dedups values', () => {
  const rows = parseCandidateCsv('product_no\n111\n222\n111\n');
  assert.deepEqual(rows, ['111', '222']);
});

test('parseCandidateCsv treats headerless CSV as data (first column)', () => {
  const rows = parseCandidateCsv('333\n444\n');
  assert.deepEqual(rows, ['333', '444']);
});

test('saveEvaluatedCandidate returns the created draftId/supplierProductId, not just a save flag -- Stage 2 batch processing needs these to link the new draft to its analysis/image pipeline', async () => {
  const client = {
    async query(sql) {
      if (sql.startsWith('select id from supplier_products')) return { rows: [] };
      if (sql.includes('insert into supplier_products')) return { rows: [{ id: 11 }] };
      if (sql.includes('insert into product_drafts')) return { rows: [{ id: 22 }] };
      return { rows: [] };
    },
  };
  const pool = { async connect() { return { ...client, release() {} }; } };

  const candidate = {
    productNo: '99999',
    raw: { item: { title: 'x' } },
    normalized: { name: '테스트', cost: 10000, shippingFee: 3000, priceParseStatus: 'ok', shippingParseStatus: 'ok', priceTiers: [], shippingTiers: [], sourceMarket: 'domeme', minOrderQty: 1, orderUnit: 1, sellUnitType: 'single', bundleQuantity: 1, unitCostPrice: 10000, bundleCostPrice: 10000, options: [], images: ['https://example.test/a.jpg'], imageEntries: [{ url: 'https://example.test/a.jpg', imageType: 'main' }], detailHtml: '<p>x</p>' },
    filter: { filterStatus: 'pass', blockReasons: [], reviewReasons: [] },
    prices: {},
  };

  const saved = await saveEvaluatedCandidate(pool, candidate, { importBatchId: 'auto-batch-1', collectedAt: new Date().toISOString() });
  assert.equal(saved.saved, true);
  assert.equal(saved.draftId, 22);
  assert.equal(saved.supplierProductId, 11);
});
