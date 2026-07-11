import assert from 'node:assert/strict';
import test from 'node:test';

import { DomemeApiError, DomemeClient, extractProductCandidates, maskApiKey, maskUrl } from '../src/domeme-client.mjs';

test('DomemeClient fetchProductDetail calls official endpoint with required query parameters', async () => {
  const calls = [];
  const client = new DomemeClient({
    apiKey: 'secret-key',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ productName: '수납함' });
        },
      };
    },
  });

  const raw = await client.fetchProductDetail('49168396');

  assert.deepEqual(raw, { productName: '수납함' });
  const url = new URL(calls[0]);
  assert.equal(url.origin + url.pathname, 'https://domeggook.com/ssl/api/');
  assert.equal(url.searchParams.get('ver'), '4.6');
  assert.equal(url.searchParams.get('mode'), 'getItemView');
  assert.equal(url.searchParams.get('aid'), 'secret-key');
  assert.equal(url.searchParams.has('market'), false);
  assert.equal(url.searchParams.get('om'), 'json');
  assert.equal(url.searchParams.get('no'), '49168396');
});

test('DomemeClient reports HTTP failures with status code', async () => {
  const client = new DomemeClient({
    apiKey: 'secret-key',
    endpoint: 'https://example.test/detail',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async text() {
        return 'server error';
      },
    }),
  });

  await assert.rejects(
    () => client.fetchProductDetail('49168396'),
    (error) => {
      assert.ok(error instanceof DomemeApiError);
      assert.equal(error.status, 500);
      assert.equal(error.productNo, '49168396');
      assert.equal(error.bodyPreview, 'server error');
      return true;
    },
  );
});

test('DomemeClient searchProducts calls search endpoint and extracts product candidates', async () => {
  const calls = [];
  const client = new DomemeClient({
    apiKey: 'secret-key',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            result: {
              items: [
                { no: '1001', title: 'one' },
                { itemNo: '1002', title: 'two' },
                { product_no: '1001', title: 'duplicate' },
              ],
            },
          });
        },
      };
    },
  });

  const result = await client.searchProducts({ keyword: 'storage', page: 2, size: 3 });

  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('ver'), '4.1');
  assert.equal(url.searchParams.get('mode'), 'getItemList');
  assert.equal(url.searchParams.get('aid'), 'secret-key');
  assert.equal(url.searchParams.get('market'), 'dome');
  assert.equal(url.searchParams.get('kw'), 'storage');
  assert.equal(url.searchParams.get('pg'), '2');
  assert.equal(url.searchParams.get('sz'), '3');
  assert.equal(url.searchParams.get('so'), 'rd');
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.productNo),
    ['1001', '1002'],
  );
});

test('DomemeClient searchProducts reports API-level search errors without exposing key', async () => {
  const client = new DomemeClient({
    apiKey: 'secret-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ errors: { code: '403', dcode: 'FORBIDDEN', message: 'denied secret-key' } });
      },
    }),
  });

  await assert.rejects(
    () => client.searchProducts({ keyword: 'storage' }),
    (error) => {
      assert.ok(error instanceof DomemeApiError);
      assert.equal(error.operation, 'product search');
      assert.equal(error.code, 'FORBIDDEN');
      assert.doesNotMatch(error.bodyPreview, /secret-key/);
      return true;
    },
  );
});

test('extractProductCandidates supports nested list shapes and removes duplicates', () => {
  const candidates = extractProductCandidates({
    list: {
      item: [
        { goodsNo: 2001 },
        { goods_no: '2002' },
        { productNo: '2001' },
      ],
    },
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.productNo),
    ['2001', '2002'],
  );
});

test('DomemeClient does not include response bodies in thrown HTTP errors', async () => {
  const client = new DomemeClient({
    apiKey: 'secret-key',
    endpoint: 'https://example.test/detail',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      async text() {
        return 'not found apikey=secret-key';
      },
    }),
  });

  await assert.rejects(
    () => client.fetchProductDetail('49168396'),
    (error) => {
      assert.match(error.message, /HTTP 404/);
      assert.doesNotMatch(error.message, /secret-key/);
      assert.equal(error.bodyPreview, 'not found apikey=secr****');
      assert.doesNotMatch(error.bodyPreview, /secret-key/);
      assert.match(error.maskedUrl, /aid=secr\*\*\*\*/);
      assert.doesNotMatch(error.maskedUrl, /secret-key/);
      return true;
    },
  );
});

test('maskApiKey exposes only first four characters', () => {
  assert.equal(maskApiKey('abcdef123456'), 'abcd****');
  assert.equal(maskApiKey('abc'), '****');
});

test('maskUrl masks only aid query parameter', () => {
  const masked = maskUrl('https://domeggook.com/ssl/api/?aid=abcdef123456&no=49168396');
  assert.equal(masked, 'https://domeggook.com/ssl/api/?aid=abcd****&no=49168396');
});
