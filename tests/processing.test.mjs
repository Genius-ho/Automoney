import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadEnvConfig, loadPricingRules, loadProductNumbers } from '../src/config.mjs';
import {
  buildDetailHtml,
  calculatePrices,
  cleanProductName,
  filterProduct,
  normalizeProduct,
} from '../src/processing.mjs';

test('loadEnvConfig reads DOMEME_API_KEY', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  await writeFile(join(root, 'env'), 'DOMEME_API_KEY="  domeme-key  "\nDOME_API_KEY=legacy-key\n', 'utf8');

  const config = await loadEnvConfig(root);

  assert.equal(config.domemeApiKey, 'domeme-key');
  assert.equal(config.domemeEndpoint, 'https://domeggook.com/ssl/api/');
});

test('loadEnvConfig rejects legacy DOME_API_KEY without DOMEME_API_KEY', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  await writeFile(join(root, 'env'), 'DOME_API_KEY=legacy-key\n', 'utf8');

  await assert.rejects(() => loadEnvConfig(root), /DOMEME_API_KEY is missing/);
});

test('loadProductNumbers supports a product_no header and plain lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  const headerCsv = join(root, 'with-header.csv');
  const plainCsv = join(root, 'plain.csv');
  await writeFile(headerCsv, 'product_no\n49168396\n50307216\n', 'utf8');
  await writeFile(plainCsv, '53521979\n66374244\n', 'utf8');

  assert.deepEqual(await loadProductNumbers(headerCsv), ['49168396', '50307216']);
  assert.deepEqual(await loadProductNumbers(plainCsv), ['53521979', '66374244']);
});

test('loadProductNumbers supports Korean product number header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  const csv = join(root, 'korean-header.csv');
  await writeFile(csv, '\uC0C1\uD488\uBC88\uD638\n49168396\n', 'utf8');

  assert.deepEqual(await loadProductNumbers(csv), ['49168396']);
});

test('normalizeProduct extracts fields without inventing brand certification or efficacy', () => {
  const raw = {
    productName: '[브랜드]  고급 수납함  ',
    supplyPrice: '10000',
    deliveryFee: '3000',
    option: [{ name: '색상', values: ['블랙'] }],
    images: ['https://example.test/a.jpg'],
    detailHtml: '<p>상세</p>',
  };

  const normalized = normalizeProduct('49168396', raw);

  assert.equal(normalized.productNo, '49168396');
  assert.equal(normalized.name, '[브랜드] 고급 수납함');
  assert.equal(normalized.cost, 10000);
  assert.equal(normalized.rawPriceFieldName, 'supplyPrice');
  assert.equal(normalized.rawPriceValue, '10000');
  assert.equal(normalized.priceParseStatus, 'ok');
  assert.equal(normalized.shippingFee, 3000);
  assert.equal(normalized.shippingRawFieldName, 'deliveryFee');
  assert.equal(normalized.shippingRawValue, '3000');
  assert.equal(normalized.shippingParseStatus, 'ok');
  assert.deepEqual(normalized.options, [
    { name: '색상', value: '', additionalPrice: 0, raw: { name: '색상', values: ['블랙'] } },
  ]);
  assert.deepEqual(normalized.images, ['https://example.test/a.jpg']);
  assert.equal(normalized.detailHtml, '<p>상세</p>');
  assert.equal(normalized.brand, null);
  assert.equal(normalized.certification, null);
  assert.equal(normalized.efficacy, null);
});

test('normalizeProduct keeps option additional prices in structured form', () => {
  const normalized = normalizeProduct('49168396', {
    productName: '옵션 상품',
    supplyPrice: '10000',
    images: ['https://example.test/a.jpg'],
    options: [
      { name: '기본', value: '블랙', addPrice: '0' },
      { name: '대형', value: '화이트', addPrice: '2500' },
    ],
  });

  assert.deepEqual(normalized.options, [
    { name: '기본', value: '블랙', additionalPrice: 0, raw: { name: '기본', value: '블랙', addPrice: '0' } },
    {
      name: '대형',
      value: '화이트',
      additionalPrice: 2500,
      raw: { name: '대형', value: '화이트', addPrice: '2500' },
    },
  ]);
});

test('normalizeProduct supports official domeggook getItemView response structure', () => {
  const normalized = normalizeProduct('49168396', {
    domeggook: {
      basis: { title: '공식 상품명' },
      price: { supply: '10000' },
      deli: { supply: { type: '고정배송비', fee: '3000' } },
      thumb: { original: 'https://example.test/original.jpg' },
      desc: { contents: '<p>상세</p>' },
      selectOpt: {
        set: [{ name: '선택', opts: ['스킨', '로션'], domPrice: ['0', '2500'] }],
      },
    },
  });

  assert.equal(normalized.name, '공식 상품명');
  assert.equal(normalized.cost, 10000);
  assert.equal(normalized.rawPriceFieldName, 'price.supply');
  assert.equal(normalized.rawPriceValue, '10000');
  assert.equal(normalized.priceParseStatus, 'ok');
  assert.equal(normalized.shippingFee, 3000);
  assert.equal(normalized.shippingRawFieldName, 'deli.supply.fee');
  assert.equal(normalized.shippingRawValue, '3000');
  assert.equal(normalized.shippingParseStatus, 'ok');
  assert.deepEqual(normalized.images, ['https://example.test/original.jpg']);
  assert.equal(normalized.detailHtml, '<p>상세</p>');
  assert.deepEqual(normalized.options, [
    { name: '선택', value: '스킨', additionalPrice: 0, raw: { name: '선택', value: '스킨', additionalPrice: '0' } },
    {
      name: '선택',
      value: '로션',
      additionalPrice: 2500,
      raw: { name: '선택', value: '로션', additionalPrice: '2500' },
    },
  ]);
});

test('normalizeProduct reads the domeme order-option-code from selectOpt.data (confirmed live shape, 2026-07-25), not just set[].opts[]', () => {
  const normalized = normalizeProduct('40170547', {
    domeggook: {
      basis: { title: '옵션 상품' },
      price: { supply: '9800' },
      thumb: { original: 'https://example.test/original.jpg' },
      selectOpt: JSON.stringify({
        type: 'combination',
        set: [{ name: '색상', opts: ['화이트+고정클립', '블랙+고정클립'], domPrice: ['0', '0'] }],
        data: {
          '00': { name: '화이트+고정클립', domPrice: '0', qty: '30' },
          '01': { name: '블랙+고정클립', domPrice: '0', qty: '12' },
        },
      }),
    },
  });

  assert.deepEqual(normalized.options, [
    {
      name: '색상',
      value: '화이트+고정클립',
      additionalPrice: 0,
      optionCode: '00',
      stockQuantity: 30,
      raw: { name: '색상', value: '화이트+고정클립', additionalPrice: '0', optionCode: '00', stockQuantity: '30' },
    },
    {
      name: '색상',
      value: '블랙+고정클립',
      additionalPrice: 0,
      optionCode: '01',
      stockQuantity: 12,
      raw: { name: '색상', value: '블랙+고정클립', additionalPrice: '0', optionCode: '01', stockQuantity: '12' },
    },
  ]);
});

test('normalizeProduct deduplicates thumbnail variants and includes detail images', () => {
  const normalized = normalizeProduct('49168396', {
    domeggook: {
      basis: { title: '이미지 상품' },
      price: { supply: '10000' },
      thumb: {
        small: 'https://cdn.example.test/product_100x100.jpg',
        large: 'https://cdn.example.test/product_500x500.jpg',
        original: 'https://cdn.example.test/product.jpg',
      },
      desc: {
        contents:
          '<p>상세</p><img src="https://cdn.example.test/detail-1.jpg"><img src="https://cdn.example.test/product.jpg?cache=1">',
      },
    },
  });

  assert.deepEqual(normalized.images, [
    'https://cdn.example.test/product.jpg',
    'https://cdn.example.test/detail-1.jpg',
  ]);
});

test('normalizeProduct parses tiered price and shipping strings', () => {
  const normalized = normalizeProduct('53521979', {
    domeggook: {
      basis: { title: '회전식 스낵박스' },
      price: { supply: '1+3500|10+3200' },
      deli: { supply: { type: '수량별비례', tbl: '10+3500|10+3500' } },
      thumb: { original: 'https://example.test/a.jpg' },
    },
  });

  assert.equal(normalized.rawPriceFieldName, 'price.supply');
  assert.equal(normalized.rawPriceValue, '1+3500|10+3200');
  assert.equal(normalized.cost, 3500);
  assert.equal(normalized.priceParseStatus, 'tiered_price');
  assert.deepEqual(normalized.priceTiers, [
    { minQty: 1, price: 3500 },
    { minQty: 10, price: 3200 },
  ]);
  assert.equal(normalized.minOrderQty, 1);
  assert.equal(normalized.shippingFee, 3500);
  assert.equal(normalized.shippingRawFieldName, 'deli.supply.tbl');
  assert.equal(normalized.shippingRawValue, '10+3500|10+3500');
  assert.equal(normalized.shippingParseStatus, 'tiered_price');
  assert.deepEqual(normalized.shippingTiers, [
    { minQty: 10, price: 3500 },
    { minQty: 10, price: 3500 },
  ]);
});

test('normalizeProduct prefers domeggook tiered dome price over the misleading flat supply price', () => {
  const normalized = normalizeProduct('56', {
    domeggook: {
      basis: { title: '무타공 레일선반' },
      qty: { domeMoq: '2', domeUnit: 1, inventory: '95', supplyUnit: 1 },
      price: { dome: '2+9950|5+9500', supply: 10800, labeledPrice: { useLabeledPrice: false } },
      thumb: { original: 'https://example.test/a.jpg' },
    },
  });

  assert.equal(normalized.rawPriceFieldName, 'price.dome');
  assert.equal(normalized.rawPriceValue, '2+9950|5+9500');
  assert.equal(normalized.unitCostPrice, 9950);
  assert.equal(normalized.priceParseStatus, 'tiered_price');
  assert.equal(normalized.minOrderQty, 2);
  assert.equal(normalized.sellUnitType, 'bundle');
  assert.equal(normalized.bundleQuantity, 2);
  assert.equal(normalized.bundleCostPrice, 19900);
  assert.equal(normalized.cost, 19900);

  const filter = filterProduct(normalized);
  assert.equal(filter.filterStatus, 'needs_review');
  assert.ok(filter.reviewReasons.includes('bundle_candidate'));
});

test('filterProduct returns status and reasons for pass and blocked products', () => {
  const good = {
    name: '수납함',
    cost: 20000,
    shippingFee: 3000,
    priceParseStatus: 'ok',
    images: ['https://example.test/a.jpg'],
    options: [],
    isSoldOut: false,
  };

  assert.deepEqual(filterProduct(good), {
    accepted: true,
    reason: 'pass',
    filterStatus: 'pass',
    filterReasons: [],
    blockReasons: [],
    reviewReasons: [],
  });
  assert.deepEqual(filterProduct({ ...good, cost: 0 }), {
    accepted: false,
    reason: 'missing_or_invalid_cost',
    filterStatus: 'blocked',
    filterReasons: ['missing_or_invalid_cost'],
    blockReasons: ['missing_or_invalid_cost'],
    reviewReasons: [],
  });
  assert.equal(filterProduct({ ...good, images: [] }).filterStatus, 'blocked');
});

test('filterProduct blocks parsing errors and low cost, reviews risk keywords and complex options', () => {
  const base = {
    name: '일반 상품',
    categoryText: '생활용품',
    cost: 20000,
    shippingFee: 3000,
    priceParseStatus: 'ok',
    images: ['https://example.test/a.jpg'],
    options: [],
    isSoldOut: false,
  };

  assert.deepEqual(filterProduct({ ...base, priceParseStatus: 'parsing_error' }).filterReasons, [
    'price_parsing_error',
  ]);
  assert.deepEqual(filterProduct({ ...base, cost: 1500 }).filterReasons, [
    'blocked_low_cost',
    'blocked_low_margin',
  ]);
  assert.deepEqual(filterProduct({ ...base, name: '릴랙시아 옴므 스킨 로션' }).filterReasons, [
    'risk_keyword:스킨',
    'risk_keyword:로션',
  ]);
  assert.deepEqual(filterProduct({ ...base, options: Array.from({ length: 11 }, () => ({})) }).filterReasons, [
    'needs_review_complex_options',
  ]);
  assert.deepEqual(
    filterProduct({ ...base, cost: 5400, shippingFee: 2800, options: Array.from({ length: 11 }, () => ({})) })
      .filterReasons,
    ['blocked_low_margin', 'needs_review_complex_options'],
  );
  assert.deepEqual(
    filterProduct({ ...base, cost: 5400, shippingFee: 2800, options: Array.from({ length: 11 }, () => ({})) })
      .blockReasons,
    ['blocked_low_margin'],
  );
  assert.deepEqual(
    filterProduct({ ...base, cost: 5400, shippingFee: 2800, options: Array.from({ length: 11 }, () => ({})) })
      .reviewReasons,
    ['needs_review_complex_options'],
  );
  assert.deepEqual(filterProduct({ ...base, options: Array.from({ length: 31 }, () => ({})) }).filterReasons, [
    'blocked_too_many_options',
  ]);
});

test('normalizeProduct and filterProduct classify supplier market and order quantities', () => {
  const domeme = normalizeProduct(
    '49168396',
    { productName: 'sample', supplyPrice: '20000', images: ['https://example.test/a.jpg'], minOrderQty: 1 },
    { requestedMarket: 'dome' },
  );
  const domemeMoq = normalizeProduct(
    '49168397',
    { productName: 'sample', supplyPrice: '10000', images: ['https://example.test/a.jpg'], minOrderQty: 2 },
    { requestedMarket: 'dome' },
  );
  const domeggook = normalizeProduct('49168398', {
    productName: 'sample',
    market: 'domeggook',
    supplyPrice: '20000',
    images: ['https://example.test/a.jpg'],
    minOrderQty: 1,
  });
  const unknown = normalizeProduct('49168399', {
    productName: 'sample',
    supplyPrice: '20000',
    images: ['https://example.test/a.jpg'],
  });

  assert.equal(domeme.sourceMarket, 'domeme');
  assert.equal(domeme.minOrderQty, 1);
  assert.equal(filterProduct(domeme).filterStatus, 'pass');
  assert.equal(domemeMoq.sellUnitType, 'bundle');
  assert.equal(domemeMoq.bundleQuantity, 2);
  assert.equal(domemeMoq.unitCostPrice, 10000);
  assert.equal(domemeMoq.bundleCostPrice, 20000);
  assert.equal(filterProduct(domemeMoq).filterStatus, 'needs_review');
  assert.ok(filterProduct(domemeMoq).reviewReasons.includes('bundle_candidate'));
  assert.equal(filterProduct(domeggook).filterStatus, 'needs_review');
  assert.ok(filterProduct(domeggook).reviewReasons.includes('needs_review_source_market'));
  assert.equal(filterProduct(unknown).filterStatus, 'needs_review');
  assert.ok(filterProduct(unknown).reviewReasons.includes('needs_review_source_market_unknown'));
});

test('low cost min order products become bundle candidates', () => {
  const bundle = normalizeProduct(
    '49168400',
    { productName: 'hook', supplyPrice: '2500', deliveryFee: '3000', images: ['https://example.test/a.jpg'], minOrderQty: 2 },
    { requestedMarket: 'dome' },
  );
  const largeBundle = normalizeProduct(
    '49168401',
    { productName: 'hook', supplyPrice: '2500', deliveryFee: '3000', images: ['https://example.test/a.jpg'], minOrderQty: 5 },
    { requestedMarket: 'dome' },
  );
  const prices = calculatePrices(bundle, {
    defaultMarginRate: 0.25,
    platforms: {
      coupang: { feeRate: 0.11, roundTo: 10 },
      smartstore: { feeRate: 0.06, roundTo: 10 },
    },
  });
  const filter = filterProduct(bundle);

  assert.equal(bundle.sellUnitType, 'bundle');
  assert.equal(bundle.bundleQuantity, 2);
  assert.equal(bundle.unitCostPrice, 2500);
  assert.equal(bundle.bundleCostPrice, 5000);
  assert.equal(bundle.cost, 5000);
  assert.equal(filter.filterStatus, 'needs_review');
  assert.ok(filter.reviewReasons.includes('bundle_candidate'));
  assert.ok(!filter.blockReasons.includes('blocked_min_order_qty'));
  assert.equal(prices.coupang, 11240);
  assert.equal(filterProduct(largeBundle).filterStatus, 'blocked');
  assert.ok(filterProduct(largeBundle).blockReasons.includes('blocked_large_bundle'));
});

// automoney_complete_automation_implementation_plan.md 8.3: "MOQ 3 이상은
// 원칙적으로 자동등록 후보에서 제외한다" -- this used to only block at >=5,
// silently letting MOQ 3/4 bundles through as a mere review flag instead.
test('MOQ 3 and MOQ 4 are blocked as large bundles, not just flagged for review', () => {
  const moq3 = normalizeProduct(
    '49168402',
    { productName: 'hook', supplyPrice: '2500', images: ['https://example.test/a.jpg'], minOrderQty: 3 },
    { requestedMarket: 'dome' },
  );
  const moq4 = normalizeProduct(
    '49168403',
    { productName: 'hook', supplyPrice: '2500', images: ['https://example.test/a.jpg'], minOrderQty: 4 },
    { requestedMarket: 'dome' },
  );
  assert.equal(filterProduct(moq3).filterStatus, 'blocked');
  assert.ok(filterProduct(moq3).blockReasons.includes('blocked_large_bundle'));
  assert.equal(filterProduct(moq4).filterStatus, 'blocked');
  assert.ok(filterProduct(moq4).blockReasons.includes('blocked_large_bundle'));
});

// Plan 8.2's 2-set conditions (총 공급원가 15,000원 이하, 예상 판매가 35,000원
// 이하 권장) were never checked at all before -- a bundle only had to clear
// the generic profit floor, so an expensive 2-set (like the real draft 24 in
// this project's DB: bundleCostPrice 29,260) passed with no signal.
test('an MOQ 2 bundle over the 15,000 cost / 35,000 sale-price ceilings is flagged for review, not silently passed', () => {
  const cheapBundle = normalizeProduct(
    '49168404',
    { productName: 'hook', supplyPrice: '3000', images: ['https://example.test/a.jpg'], minOrderQty: 2 },
    { requestedMarket: 'dome' },
  );
  const expensiveBundle = normalizeProduct(
    '49168405',
    { productName: 'shelf', supplyPrice: '14000', images: ['https://example.test/a.jpg'], minOrderQty: 2 },
    { requestedMarket: 'dome' },
  );
  assert.equal(cheapBundle.bundleCostPrice, 6000);
  const cheapFilter = filterProduct(cheapBundle);
  assert.ok(!cheapFilter.reviewReasons.includes('needs_review_bundle_cost_over_15000'));
  assert.ok(!cheapFilter.reviewReasons.includes('needs_review_bundle_sale_over_35000'));

  assert.equal(expensiveBundle.bundleCostPrice, 28000);
  const expensiveFilter = filterProduct(expensiveBundle);
  assert.equal(expensiveFilter.filterStatus, 'needs_review'); // still review, not a hard block -- the plan phrases both ceilings as "권장" (recommended), not "금지"
  assert.ok(expensiveFilter.reviewReasons.includes('needs_review_bundle_cost_over_15000'));
  assert.ok(expensiveFilter.reviewReasons.includes('needs_review_bundle_sale_over_35000'));
});

test('calculatePrices uses rules for each marketplace', () => {
  const normalized = { cost: 10000, shippingFee: 3000 };
  const rules = {
    defaultMarginRate: 0.25,
    platforms: {
      coupang: { feeRate: 0.11, roundTo: 10 },
      smartstore: { feeRate: 0.06, roundTo: 10 },
    },
  };

  const prices = calculatePrices(normalized, rules);

  assert.equal(prices.coupang, 18260);
  assert.equal(prices.smartstore, 17290);
  assert.deepEqual(prices.optionAdjustments, {
    coupang: [],
    smartstore: [],
  });
});

test('calculatePrices includes shipping fee once and exposes option price adjustments', () => {
  const normalized = {
    cost: 10000,
    shippingFee: 3000,
    options: [{ name: '대형', value: '화이트', additionalPrice: 2500 }],
  };
  const rules = {
    defaultMarginRate: 0.25,
    includeShippingFeeInPrice: true,
    platforms: {
      coupang: { feeRate: 0.11, roundTo: 10 },
      smartstore: { feeRate: 0.06, roundTo: 10 },
    },
  };

  const prices = calculatePrices(normalized, rules);

  assert.equal(prices.coupang, 18260);
  assert.equal(prices.smartstore, 17290);
  assert.deepEqual(prices.optionAdjustments, {
    coupang: [{ name: '대형', value: '화이트', additionalPrice: 3520 }],
    smartstore: [{ name: '대형', value: '화이트', additionalPrice: 3330 }],
  });
  assert.equal(prices.coupangSalePrice, 18260);
  assert.equal(prices.naverSalePrice, 17290);
  assert.equal(prices.coupangExpectedProfit, 3251);
  assert.equal(prices.naverExpectedProfit, 3253);
  assert.equal(prices.coupangMarginRate, 0.18);
  assert.equal(prices.naverMarginRate, 0.19);
});

test('cleanProductName removes common source noise', () => {
  assert.equal(
    cleanProductName('[\uBB34\uB8CC\uBC30\uC1A1]  \uACE0\uAE09   \uC218\uB0A9\uD568  \uB2F9\uC77C\uBC1C\uC1A1'),
    '\uACE0\uAE09 \uC218\uB0A9\uD568',
  );
});

test('buildDetailHtml uses template order: section, title, images, source detail, closing section', () => {
  const html = buildDetailHtml({
    name: '고급 수납함',
    images: ['https://example.test/a.jpg'],
    detailHtml: '<p>원본 상세</p>',
  });

  assert.match(html, /고급 수납함/);
  assert.match(html, /https:\/\/example\.test\/a\.jpg/);
  assert.match(html, /<p>원본 상세<\/p>/);
  assert.ok(html.indexOf('<section') < html.indexOf('<h1>'));
  assert.ok(html.indexOf('<h1>') < html.indexOf('<img'));
  assert.ok(html.indexOf('<img') < html.indexOf('<p>원본 상세<\/p>'));
  assert.ok(html.trim().endsWith('</section>'));
});

test('loadPricingRules reads JSON and normalizes snake_case rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  const path = join(root, 'pricing-rules.json');
  await writeFile(path, JSON.stringify({ default_margin_rate: 0.2 }), 'utf8');

  assert.deepEqual(await loadPricingRules(path), { defaultMarginRate: 0.2 });
});
