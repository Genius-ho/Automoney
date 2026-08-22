import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramCallbackRouter } from '../src/telegram-callback-router.mjs';

test('one shared offset routes purchase-order and Coupang callbacks exactly once', async () => {
  const seenOffsets = [];
  const routed = [];
  let call = 0;
  const router = createTelegramCallbackRouter();
  const impls = {
    getTelegramUpdatesImpl: async (config, { offset }) => {
      seenOffsets.push(offset);
      call += 1;
      if (call > 1) return [];
      return [
        { update_id: 21, callback_query: { id: 'po', data: 'approve_po:7' } },
        { update_id: 22, callback_query: { id: 'cp', data: 'approve_cp:119' } },
      ];
    },
    handlePurchaseOrderImpl: async (db, client, config, query) => {
      if (!query.data.startsWith('approve_po:')) return { handled: false };
      routed.push(query.data);
      return { handled: true };
    },
    handleCoupangImpl: async (db, config, query) => {
      if (!query.data.startsWith('approve_cp:')) return { handled: false };
      routed.push(query.data);
      return { handled: true };
    },
  };

  const first = await router.pollOnce({}, { domemeClient: {}, coupangClient: {} }, { botToken: 't', chatId: 'c' }, impls);
  const second = await router.pollOnce({}, { domemeClient: {}, coupangClient: {} }, { botToken: 't', chatId: 'c' }, impls);

  assert.deepEqual(first, { processed: 2 });
  assert.deepEqual(second, { processed: 0 });
  assert.deepEqual(routed, ['approve_po:7', 'approve_cp:119']);
  assert.deepEqual(seenOffsets, [undefined, 23]);
});

test('router advances past non-callback updates and ignores unknown callback prefixes', async () => {
  const offsets = [];
  let call = 0;
  const router = createTelegramCallbackRouter();
  const impls = {
    getTelegramUpdatesImpl: async (config, { offset }) => {
      offsets.push(offset);
      call += 1;
      return call === 1
        ? [{ update_id: 30, message: {} }, { update_id: 31, callback_query: { data: 'unknown:1' } }]
        : [];
    },
    handlePurchaseOrderImpl: async () => ({ handled: false }),
    handleCoupangImpl: async () => ({ handled: false }),
  };
  assert.deepEqual(await router.pollOnce({}, {}, { botToken: 't' }, impls), { processed: 0 });
  assert.deepEqual(await router.pollOnce({}, {}, { botToken: 't' }, impls), { processed: 0 });
  assert.deepEqual(offsets, [undefined, 32]);
});

test('router is a no-op when Telegram is unconfigured', async () => {
  const router = createTelegramCallbackRouter();
  assert.deepEqual(await router.pollOnce({}, {}, null, {
    getTelegramUpdatesImpl: async () => { throw new Error('must not fetch'); },
  }), { processed: 0 });
});

test('router routes a plain-text update to the keyword-message handler with the search client/pricing rules deps, separate from the private domemeClient', async () => {
  let call = 0;
  const router = createTelegramCallbackRouter();
  const received = [];
  const impls = {
    getTelegramUpdatesImpl: async () => {
      call += 1;
      if (call > 1) return [];
      return [{ update_id: 40, message: { text: '여성 벨트', chat: { id: 1 } } }];
    },
    handlePurchaseOrderImpl: async () => { throw new Error('must not be called for a plain message'); },
    handleCoupangImpl: async () => { throw new Error('must not be called for a plain message'); },
    handleCoupangKeywordMessageImpl: async (db, domemeSearchClient, pricingRules, config, message, deps) => {
      received.push({ domemeSearchClient, pricingRules, message, deps });
      return { handled: true };
    },
  };
  const result = await router.pollOnce(
    {},
    { domemeClient: { name: 'private' }, domemeSearchClient: { name: 'search' }, pricingRules: { defaultMarginRate: 0.25 }, rootDir: '/root' },
    { botToken: 't', chatId: '1' },
    impls,
  );
  assert.deepEqual(result, { processed: 1 });
  assert.equal(received[0].domemeSearchClient.name, 'search');
  assert.deepEqual(received[0].pricingRules, { defaultMarginRate: 0.25 });
  assert.equal(received[0].message.text, '여성 벨트');
  assert.equal(received[0].deps.rootDir, '/root');
});

test('router routes an import_link callback to the product-link-import handler with the search client/pricing rules/rootDir deps', async () => {
  let call = 0;
  const router = createTelegramCallbackRouter();
  const received = [];
  const impls = {
    getTelegramUpdatesImpl: async () => {
      call += 1;
      if (call > 1) return [];
      return [{ update_id: 50, callback_query: { id: 'i1', data: 'import_link:49168396' } }];
    },
    handlePurchaseOrderImpl: async () => ({ handled: false }),
    handleCoupangImpl: async () => ({ handled: false }),
    handleProductLinkImportImpl: async (db, domemeSearchClient, pricingRules, rootDir, config, query) => {
      received.push({ domemeSearchClient, pricingRules, rootDir, query });
      return { handled: true };
    },
  };
  const result = await router.pollOnce(
    {},
    { domemeClient: { name: 'private' }, domemeSearchClient: { name: 'search' }, pricingRules: { defaultMarginRate: 0.25 }, rootDir: '/root' },
    { botToken: 't', chatId: '1' },
    impls,
  );
  assert.deepEqual(result, { processed: 1 });
  assert.equal(received[0].domemeSearchClient.name, 'search');
  assert.deepEqual(received[0].pricingRules, { defaultMarginRate: 0.25 });
  assert.equal(received[0].rootDir, '/root');
  assert.equal(received[0].query.data, 'import_link:49168396');
});

test('router does not count an unhandled plain-text update', async () => {
  const router = createTelegramCallbackRouter();
  let call = 0;
  const result = await router.pollOnce({}, {}, { botToken: 't' }, {
    getTelegramUpdatesImpl: async () => { call += 1; return call > 1 ? [] : [{ update_id: 41, message: { text: '/start', chat: { id: 1 } } }]; },
    handleCoupangKeywordMessageImpl: async () => ({ handled: false }),
  });
  assert.deepEqual(result, { processed: 0 });
});
