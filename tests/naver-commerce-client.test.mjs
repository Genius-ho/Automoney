import assert from 'node:assert/strict';
import test from 'node:test';

import { NaverCommerceApiError, NaverCommerceClient, signNaverCommerceRequest } from '../src/naver-commerce-client.mjs';

function tokenFetchImpl({ accessToken = 'token-abc', expiresIn = 3600 } = {}) {
  return async (url) => {
    if (String(url).includes('/v1/oauth2/token')) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ access_token: accessToken, token_type: 'bearer', expires_in: expiresIn }); } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('signNaverCommerceRequest bcrypt-hashes clientId_timestamp using clientSecret as the salt, then base64-encodes it', () => {
  const { timestampMs, signature } = signNaverCommerceRequest({ clientId: 'client-1', clientSecret: '$2a$10$abcdefghijklmnopqrstuv', timestampMs: 1700000000000 });
  assert.equal(timestampMs, 1700000000000);
  assert.match(signature, /^[A-Za-z0-9+/]+=*$/); // valid base64
  assert.doesNotMatch(Buffer.from(signature, 'base64').toString('utf8'), /client-1_1700000000000$/); // it's a bcrypt hash, not the plaintext
});

test('signNaverCommerceRequest produces a different signature for a different secret, same inputs otherwise', () => {
  const a = signNaverCommerceRequest({ clientId: 'client-1', clientSecret: '$2a$10$aaaaaaaaaaaaaaaaaaaaaa', timestampMs: 1 }).signature;
  const b = signNaverCommerceRequest({ clientId: 'client-1', clientSecret: '$2a$10$bbbbbbbbbbbbbbbbbbbbbb', timestampMs: 1 }).signature;
  assert.notEqual(a, b);
});

test('NaverCommerceClient requires clientId/clientSecret at construction', () => {
  assert.throws(() => new NaverCommerceClient({ clientId: null, clientSecret: 'x' }), /NAVER_COMMERCE_CLIENT_ID/);
  assert.throws(() => new NaverCommerceClient({ clientId: 'x', clientSecret: null }), /NAVER_COMMERCE_CLIENT_SECRET/);
});

test('NaverCommerceClient fetches an access token before its first real call, and reuses it for a second call', async () => {
  let tokenCalls = 0;
  let productCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/v1/oauth2/token')) {
      tokenCalls += 1;
      return { ok: true, status: 200, async text() { return JSON.stringify({ access_token: 'token-abc', expires_in: 3600 }); } };
    }
    productCalls += 1;
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: { originProductNo: 999 } }); } };
  };
  const client = new NaverCommerceClient({ clientId: 'client-1', clientSecret: '$2b$10$j7fv77w6f6U3cxYt80fLJ.', fetchImpl });

  await client.getProduct(999);
  await client.getProduct(999);

  assert.equal(tokenCalls, 1); // cached, not re-fetched
  assert.equal(productCalls, 2);
});

test('NaverCommerceClient re-fetches the access token once it has expired', async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/v1/oauth2/token')) {
      tokenCalls += 1;
      return { ok: true, status: 200, async text() { return JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 0 }); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: {} }); } };
  };
  const client = new NaverCommerceClient({ clientId: 'client-1', clientSecret: '$2b$10$j7fv77w6f6U3cxYt80fLJ.', fetchImpl });

  await client.getProduct(1);
  await client.getProduct(1);

  assert.equal(tokenCalls, 2); // expires_in: 0 means already-expired by the safety margin
});

test('NaverCommerceClient.createOriginProduct posts the payload with a bearer token, never the client secret', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/v1/oauth2/token')) return tokenFetchImpl()(url);
    captured = { url: String(url), method: init.method, body: JSON.parse(init.body), authorization: init.headers.Authorization };
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: { originProductNo: 12345 } }); } };
  };
  const client = new NaverCommerceClient({ clientId: 'client-1', clientSecret: '$2b$10$j7fv77w6f6U3cxYt80fLJ.', fetchImpl });

  const result = await client.createOriginProduct({ originProduct: { name: 'x' } });

  assert.equal(captured.url, 'https://api.commerce.naver.com/external/v2/products');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, { originProduct: { name: 'x' } });
  assert.equal(captured.authorization, 'Bearer token-abc');
  assert.doesNotMatch(captured.authorization, /secret-1/);
  assert.equal(result.data.originProductNo, 12345);
});

test('NaverCommerceClient.searchCategories queries by keyword', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/v1/oauth2/token')) return tokenFetchImpl()(url);
    captured = { url: String(url), method: init.method };
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: [{ categoryId: '50000000', name: '수납/정리' }] }); } };
  };
  const client = new NaverCommerceClient({ clientId: 'client-1', clientSecret: '$2b$10$j7fv77w6f6U3cxYt80fLJ.', fetchImpl });

  const result = await client.searchCategories('수납정리함');

  assert.equal(captured.url, 'https://api.commerce.naver.com/external/v1/categories?searchKeyword=%EC%88%98%EB%82%A9%EC%A0%95%EB%A6%AC%ED%95%A8');
  assert.equal(result.data[0].categoryId, '50000000');
});

test('NaverCommerceClient surfaces a non-OK response as NaverCommerceApiError without leaking the secret', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/v1/oauth2/token')) return tokenFetchImpl()(url);
    return { ok: false, status: 401, async text() { return JSON.stringify({ message: 'invalid signature' }); } };
  };
  const client = new NaverCommerceClient({ clientId: 'client-1', clientSecret: '$2b$10$j7fv77w6f6U3cxYt80fLJ.', fetchImpl });

  await assert.rejects(
    () => client.getProduct(1),
    (error) => {
      assert.ok(error instanceof NaverCommerceApiError);
      assert.equal(error.status, 401);
      assert.equal(error.operation, 'get_product');
      assert.doesNotMatch(error.bodyPreview, /secret-1/);
      return true;
    },
  );
});

test('NaverCommerceClient surfaces a failed token request as NaverCommerceApiError', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, async text() { return JSON.stringify({ error: 'invalid_client' }); } });
  const client = new NaverCommerceClient({ clientId: 'client-1', clientSecret: '$2b$10$j7fv77w6f6U3cxYt80fLJ.', fetchImpl });

  await assert.rejects(
    () => client.getProduct(1),
    (error) => {
      assert.ok(error instanceof NaverCommerceApiError);
      assert.equal(error.operation, 'oauth2_token');
      return true;
    },
  );
});
