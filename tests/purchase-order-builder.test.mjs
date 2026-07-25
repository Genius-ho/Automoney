import assert from 'node:assert/strict';
import test from 'node:test';

import { matchSupplierOption, buildSupplierOrderDraft, runSupplierOrderValidationSweep } from '../src/purchase-order-builder.mjs';

test('matchSupplierOption returns code "00" for a single-option product regardless of the free text', () => {
  assert.deepEqual(matchSupplierOption([], '아무 텍스트'), { optionCode: '00', stockQuantity: null, additionalPrice: 0 });
});

test('matchSupplierOption finds the one stored option whose value appears in the channel order text', () => {
  const options = [
    { name: '색상', value: '화이트+고정클립', optionCode: '00' },
    { name: '색상', value: '블랙+고정클립', optionCode: '01' },
  ];
  const match = matchSupplierOption(options, '무타공 수납 정리함 - 블랙+고정클립');
  assert.equal(match.optionCode, '01');
});

test('matchSupplierOption returns null (ambiguous/no match) when zero or multiple options match', () => {
  const options = [{ name: '색상', value: '화이트', optionCode: '00' }, { name: '색상', value: '블랙', optionCode: '01' }];
  assert.equal(matchSupplierOption(options, '전혀 다른 설명'), null);
  assert.equal(matchSupplierOption(options, ''), null);
  assert.equal(matchSupplierOption(options, null), null);
});

function fakeChannelOrder(overrides = {}) {
  return {
    id: 10, channel: 'coupang', productDraftId: 46, supplierProductId: 900,
    quantity: 1, salePrice: 19900, optionInfo: '무타공 수납 정리함 - 블랙',
    recipientName: '김철수', address: '서울시 강남구', postalCode: '06000', phone: '010-1234-5678',
    orderStatus: 'ACCEPT', cancelledAt: null,
    ...overrides,
  };
}

function fakeContext(overrides = {}) {
  return {
    supplierProductId: 900, supplierProductNo: '40170547', sourceMarket: 'domeme',
    bundleQuantity: 1, minOrderQty: 1, unitCostPrice: 9800, sellUnitType: 'single',
    options: [
      { name: '색상', value: '화이트', optionCode: '00', stockQuantity: 30, additionalPrice: 0 },
      { name: '색상', value: '블랙', optionCode: '01', stockQuantity: 12, additionalPrice: 0 },
    ],
    ...overrides,
  };
}

test('buildSupplierOrderDraft requires an already-mapped channel order', async () => {
  await assert.rejects(
    buildSupplierOrderDraft({}, {}, fakeChannelOrder({ productDraftId: null })),
    /already-mapped/,
  );
});

test('buildSupplierOrderDraft is a no-op that returns the existing row when a supplier order is already in flight or placed', async () => {
  const existing = { id: 5, status: 'supplier_ordered' };
  const result = await buildSupplierOrderDraft({}, {}, fakeChannelOrder(), {
    getSupplierOrderByChannelOrderIdImpl: async () => existing,
  });
  assert.equal(result, existing);
});

test('buildSupplierOrderDraft blocks ORDER_CANCELLED and ADDRESS_INCOMPLETE without needing a live supplier fetch', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder({ cancelledAt: '2026-07-25T00:00:00Z', address: null }), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext(),
    fetchProductDetailImpl: async () => { throw new Error('should not fetch live for a cancelled/bad-address order path -- still fetches, but result should be blocked regardless'); },
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.ok(upserted.blockReasons.includes('ORDER_CANCELLED'));
  assert.ok(upserted.blockReasons.includes('ADDRESS_INCOMPLETE'));
  assert.equal(upserted.status, 'validating_supplier');
});

test('buildSupplierOrderDraft blocks OPTION_MISMATCH when the free-text option cannot be matched to exactly one stored option', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder({ optionInfo: '알 수 없는 옵션 설명' }), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext(),
    fetchProductDetailImpl: async () => ({ domeggook: { basis: { status: '판매중' } } }),
    normalizeProductImpl: () => ({ isSoldOut: false, minOrderQty: 1, priceParseStatus: 'ok', unitCostPrice: 9800, shippingParseStatus: 'ok', shippingFee: 3000, rawPriceFieldName: 'price.supply', options: [] }),
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.ok(upserted.blockReasons.includes('OPTION_MISMATCH'));
  assert.equal(upserted.status, 'validating_supplier');
});

test('buildSupplierOrderDraft blocks SUPPLIER_SOLD_OUT when the live product itself is sold out', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder(), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext(),
    fetchProductDetailImpl: async () => ({ domeggook: { basis: { status: '판매중' } } }),
    normalizeProductImpl: () => ({ isSoldOut: true, minOrderQty: 1, priceParseStatus: 'ok', unitCostPrice: 9800, shippingParseStatus: 'ok', shippingFee: 3000, rawPriceFieldName: 'price.supply', options: [{ optionCode: '01', stockQuantity: 12 }] }),
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.ok(upserted.blockReasons.includes('SUPPLIER_SOLD_OUT'));
});

test('buildSupplierOrderDraft blocks SUPPLIER_SALE_STOPPED when the live basis.status is not 판매중', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder(), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext(),
    fetchProductDetailImpl: async () => ({ domeggook: { basis: { status: '판매중지' } } }),
    normalizeProductImpl: () => ({ isSoldOut: false, minOrderQty: 1, priceParseStatus: 'ok', unitCostPrice: 9800, shippingParseStatus: 'ok', shippingFee: 3000, rawPriceFieldName: 'price.supply', options: [{ optionCode: '01', stockQuantity: 12 }] }),
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.ok(upserted.blockReasons.includes('SUPPLIER_SALE_STOPPED'));
});

test('buildSupplierOrderDraft blocks LOSS_AT_CURRENT_PRICE when the live supplier price now exceeds the sale price', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder({ salePrice: 9000 }), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext(),
    fetchProductDetailImpl: async () => ({ domeggook: { basis: { status: '판매중' } } }),
    normalizeProductImpl: () => ({ isSoldOut: false, minOrderQty: 1, priceParseStatus: 'ok', unitCostPrice: 15000, shippingParseStatus: 'ok', shippingFee: 3000, rawPriceFieldName: 'price.supply', options: [{ optionCode: '01', stockQuantity: 12 }] }),
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.ok(upserted.blockReasons.includes('LOSS_AT_CURRENT_PRICE'));
  assert.equal(upserted.estimatedProfit, 9000 - 15000 - 3000);
});

test('buildSupplierOrderDraft computes supplierOrderQty as saleQty x bundleQuantity (12.4 MOQ example) and reaches awaiting_purchase_approval when everything checks out', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder({ quantity: 2, salePrice: 50000 }), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext({ bundleQuantity: 2 }),
    fetchProductDetailImpl: async () => ({ domeggook: { basis: { status: '판매중' } } }),
    normalizeProductImpl: () => ({ isSoldOut: false, minOrderQty: 1, priceParseStatus: 'ok', unitCostPrice: 9800, shippingParseStatus: 'ok', shippingFee: 3000, rawPriceFieldName: 'price.supply', options: [{ optionCode: '01', stockQuantity: 12 }] }),
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.deepEqual(upserted.blockReasons, []);
  assert.equal(upserted.status, 'awaiting_purchase_approval');
  assert.equal(upserted.saleQty, 2);
  assert.equal(upserted.supplierOrderQty, 4);
  assert.equal(upserted.supplierOptionCode, '01');
  assert.equal(upserted.supplierMarket, 'supply');
});

// Every collected product is listed on both 도매꾹(dome) and 도매매(supply) --
// confirmed live, 2026-07-25 -- so the market can only be resolved from
// which price field the fresh live re-fetch actually matched, never
// guessed from a static per-product label.
test('buildSupplierOrderDraft resolves supplierMarket to "dome" when the live re-fetch priced off price.dome', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder(), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext(),
    fetchProductDetailImpl: async () => ({ domeggook: { basis: { status: '판매중' } } }),
    normalizeProductImpl: () => ({ isSoldOut: false, minOrderQty: 1, priceParseStatus: 'ok', unitCostPrice: 11800, shippingParseStatus: 'ok', shippingFee: 3000, rawPriceFieldName: 'price.dome', options: [{ optionCode: '01', stockQuantity: 12 }] }),
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.equal(upserted.supplierMarket, 'dome');
  assert.equal(upserted.blockReasons.includes('MARKET_UNRESOLVED'), false);
});

test('buildSupplierOrderDraft blocks MARKET_UNRESOLVED when the live re-fetch priced off neither price.dome nor price.supply', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder(), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext(),
    fetchProductDetailImpl: async () => ({ domeggook: { basis: { status: '판매중' } } }),
    normalizeProductImpl: () => ({ isSoldOut: false, minOrderQty: 1, priceParseStatus: 'ok', unitCostPrice: 9800, shippingParseStatus: 'ok', shippingFee: 3000, rawPriceFieldName: 'cost', options: [{ optionCode: '01', stockQuantity: 12 }] }),
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.ok(upserted.blockReasons.includes('MARKET_UNRESOLVED'));
  assert.equal(upserted.supplierMarket, null);
});

test('buildSupplierOrderDraft blocks SUPPLIER_FETCH_FAILED but still upserts a draft when the live re-check itself fails', async () => {
  let upserted;
  await buildSupplierOrderDraft({}, {}, fakeChannelOrder(), {
    getSupplierOrderByChannelOrderIdImpl: async () => null,
    getDraftOrderingContextImpl: async () => fakeContext(),
    fetchProductDetailImpl: async () => { throw new Error('network error'); },
    upsertSupplierOrderDraftImpl: async (db, args) => { upserted = args; return { ...args }; },
  });
  assert.ok(upserted.blockReasons.includes('SUPPLIER_FETCH_FAILED'));
  assert.equal(upserted.status, 'validating_supplier');
});

test('runSupplierOrderValidationSweep only processes mapped channel orders and continues past a single build failure', async () => {
  let queriedStatus;
  const built = [];
  const results = await runSupplierOrderValidationSweep({}, {}, {
    listChannelOrdersImpl: async (db, { supplierMappingStatus }) => {
      queriedStatus = supplierMappingStatus;
      return [{ id: 1 }, { id: 2 }];
    },
    buildSupplierOrderDraftImpl: async (db, client, channelOrder) => {
      built.push(channelOrder.id);
      if (channelOrder.id === 2) throw new Error('boom');
      return { id: 10, channelOrderId: 1 };
    },
  });
  assert.equal(queriedStatus, 'mapped');
  assert.deepEqual(built, [1, 2]);
  assert.equal(results.length, 2);
  assert.equal(results[1].error, 'boom');
});
