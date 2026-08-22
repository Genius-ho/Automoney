import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveNaverProductDraft,
  resolveCoupangProductDraft,
  mapChannelOrder,
} from '../src/order-supplier-mapper.mjs';

test('resolveNaverProductDraft joins naver_product_registrations to product_drafts on channel_product_no or origin_product_no', async () => {
  let captured;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ product_draft_id: '46', supplier_product_id: '900' }] };
    },
  };
  const match = await resolveNaverProductDraft(db, '13620845243');
  assert.match(captured.sql, /channel_product_no = \$1 or r\.origin_product_no = \$1/);
  assert.deepEqual(captured.params, ['13620845243']);
  assert.deepEqual(match, { productDraftId: 46, supplierProductId: 900 });
});

test('resolveNaverProductDraft returns null with no channelProductId or no matching row', async () => {
  assert.equal(await resolveNaverProductDraft({ query: async () => { throw new Error('should not be called'); } }, null), null);
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await resolveNaverProductDraft(db, '999'), null);
});

test('resolveCoupangProductDraft matches against an already-cached live_item_snapshot_json without calling the client', async () => {
  const db = {
    async query() {
      return {
        rows: [
          { product_draft_id: '46', seller_product_id: '5001', live_item_snapshot_json: [{ vendorItemId: 3242596358 }], supplier_product_id: '900' },
        ],
      };
    },
  };
  let clientCalled = false;
  const client = { async getProduct() { clientCalled = true; return { data: { items: [] } }; } };
  const match = await resolveCoupangProductDraft(db, client, 3242596358);
  assert.deepEqual(match, { productDraftId: 46, supplierProductId: 900 });
  assert.equal(clientCalled, false);
});

test('resolveCoupangProductDraft falls back to a live getProduct() call for rows with no cached snapshot yet, and caches the result', async () => {
  const db = { async query() { return { rows: [{ product_draft_id: '46', seller_product_id: '5001', live_item_snapshot_json: null, supplier_product_id: '900' }] }; } };
  const client = { async getProduct(sellerProductId) {
    assert.equal(sellerProductId, '5001');
    return { data: { statusName: '승인완료', items: [{ vendorItemId: 3242596358, maximumBuyCount: 10, salePrice: 19900 }] } };
  } };
  let snapshotArgs;
  const match = await resolveCoupangProductDraft(db, client, 3242596358, {
    recordLiveSnapshotImpl: async (dbArg, draftId, args) => { snapshotArgs = { draftId, ...args }; },
  });
  assert.deepEqual(match, { productDraftId: 46, supplierProductId: 900 });
  assert.equal(snapshotArgs.draftId, 46);
  assert.equal(snapshotArgs.itemSnapshotJson[0].vendorItemId, 3242596358);
});

test('resolveCoupangProductDraft returns null when no linked product (cached or live) contains the vendorItemId', async () => {
  const db = { async query() { return { rows: [{ product_draft_id: '46', seller_product_id: '5001', live_item_snapshot_json: [{ vendorItemId: 1 }], supplier_product_id: '900' }] }; } };
  const client = { async getProduct() { throw new Error('should not be called -- row already has a cached snapshot'); } };
  assert.equal(await resolveCoupangProductDraft(db, client, 999), null);
});

test('mapChannelOrder is a no-op for an order that is not still mapping_required', async () => {
  const order = { id: 1, channel: 'naver', channelProductId: 'x', supplierMappingStatus: 'mapped' };
  const result = await mapChannelOrder({}, order, { resolveNaverProductDraftImpl: async () => { throw new Error('should not resolve'); } });
  assert.equal(result, order);
});

test('mapChannelOrder is a no-op when channelProductId is missing', async () => {
  const order = { id: 1, channel: 'naver', channelProductId: null, supplierMappingStatus: 'mapping_required' };
  const result = await mapChannelOrder({}, order);
  assert.equal(result, order);
});

test('mapChannelOrder resolves a naver order and persists the mapping', async () => {
  const order = { id: 7, channel: 'naver', channelProductId: '13620845243', supplierMappingStatus: 'mapping_required' };
  let updateArgs;
  const result = await mapChannelOrder({}, order, {
    resolveNaverProductDraftImpl: async () => ({ productDraftId: 46, supplierProductId: 900 }),
    updateChannelOrderMappingImpl: async (db, orderId, args) => { updateArgs = { orderId, ...args }; return { ...order, ...args }; },
  });
  assert.deepEqual(updateArgs, { orderId: 7, supplierMappingStatus: 'mapped', productDraftId: 46, supplierProductId: 900 });
  assert.equal(result.supplierMappingStatus, 'mapped');
});

test('mapChannelOrder resolves a coupang order via the injected client and leaves it mapping_required when nothing matches', async () => {
  const order = { id: 8, channel: 'coupang', channelProductId: '3242596358', supplierMappingStatus: 'mapping_required' };
  const client = {};
  let resolveArgs;
  const result = await mapChannelOrder({}, order, {
    coupangClientImpl: client,
    resolveCoupangProductDraftImpl: async (db, clientArg, vendorItemId) => { resolveArgs = { clientArg, vendorItemId }; return null; },
  });
  assert.equal(resolveArgs.clientArg, client);
  assert.equal(resolveArgs.vendorItemId, '3242596358');
  assert.equal(result, order);
});
