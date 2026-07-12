import assert from 'node:assert/strict';
import test from 'node:test';

import { CoupangApiError, CoupangClient, maskAccessKey, signCoupangRequest } from '../src/coupang-client.mjs';

test('signCoupangRequest never embeds the secret key in the authorization header', () => {
  const authorization = signCoupangRequest({
    method: 'GET',
    path: '/v2/providers/openapi/apis/api/v4/vendors/A00000000/shipping-places',
    query: 'pageNum=1&pageSize=50',
    accessKey: 'access-key-value',
    secretKey: 'super-secret-value',
  });
  assert.match(authorization, /^CEA algorithm=HmacSHA256, access-key=access-key-value, signed-date=\d{6}T\d{6}Z, signature=[0-9a-f]{64}$/);
  assert.doesNotMatch(authorization, /super-secret-value/);
});

test('signCoupangRequest produces a different signature for a different secret, same inputs otherwise', () => {
  const base = { method: 'GET', path: '/x', query: '', accessKey: 'ak' };
  const a = signCoupangRequest({ ...base, secretKey: 'secret-one' }).match(/signature=([0-9a-f]+)$/)[1];
  const b = signCoupangRequest({ ...base, secretKey: 'secret-two' }).match(/signature=([0-9a-f]+)$/)[1];
  assert.notEqual(a, b);
});

test('maskAccessKey keeps only the first four characters visible', () => {
  const masked = maskAccessKey('2f3063cf-7c1a-4d0b-8c65-aa128a5e1c85');
  assert.equal(masked.startsWith('2f30'), true);
  assert.equal(masked.includes('7c1a'), false);
  assert.equal(masked.length, '2f3063cf-7c1a-4d0b-8c65-aa128a5e1c85'.length);
  assert.equal(maskAccessKey('ab'), '**');
});

test('CoupangClient signs GET requests with vendor-scoped paths and query params', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: [] }); } };
  };
  const client = new CoupangClient({
    accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl,
  });

  await client.listOutboundShippingPlaces();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api-gateway.coupang.com/v2/providers/marketplace_openapi/apis/api/v1/vendor/shipping-place/outbound?pageNum=1&pageSize=50');
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].init.headers.Authorization, /^CEA algorithm=HmacSHA256, access-key=ak, /);
  assert.doesNotMatch(calls[0].init.headers.Authorization, /sk/);
});

test('CoupangClient.predictCategory posts the product name and returns the parsed body', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: { predictedCategoryId: 12345 } }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  const result = await client.predictCategory('보석함');

  assert.equal(captured.url, 'https://api-gateway.coupang.com/v2/providers/openapi/apis/api/v1/categorization/predict');
  assert.deepEqual(captured.body, { productName: '보석함' });
  assert.equal(result.data.predictedCategoryId, 12345);
});

test('CoupangClient surfaces a non-OK response as CoupangApiError without leaking the secret', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async text() { return JSON.stringify({ message: 'invalid signature' }); },
  });
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  await assert.rejects(
    () => client.listReturnShippingCenters(),
    (error) => {
      assert.ok(error instanceof CoupangApiError);
      assert.equal(error.status, 401);
      assert.equal(error.operation, 'list_return_shipping_centers');
      assert.doesNotMatch(error.bodyPreview, /sk/);
      assert.doesNotMatch(error.message, /sk/);
      return true;
    },
  );
});
