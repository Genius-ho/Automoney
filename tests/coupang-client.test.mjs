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

test('CoupangClient.createProduct posts the payload to the seller-products endpoint', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method, body: JSON.parse(init.body) };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 'SUCCESS', data: 12345 }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  const result = await client.createProduct({ sellerProductName: 'x', requested: false });

  assert.equal(captured.url, 'https://api-gateway.coupang.com/v2/providers/seller_api/apis/api/v1/marketplace/seller-products');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, { sellerProductName: 'x', requested: false });
  assert.equal(result.data, 12345);
});

test('CoupangClient.updateProduct PUTs the full payload to the same seller-products path used for creation', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method, body: JSON.parse(init.body) };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 'SUCCESS', data: 16301574570 }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  const result = await client.updateProduct({ sellerProductId: 16301574570, sellerProductName: 'x' });

  assert.equal(captured.url, 'https://api-gateway.coupang.com/v2/providers/seller_api/apis/api/v1/marketplace/seller-products');
  assert.equal(captured.method, 'PUT');
  assert.deepEqual(captured.body, { sellerProductId: 16301574570, sellerProductName: 'x' });
  assert.equal(result.data, 16301574570);
});

test('CoupangClient.requestApproval PUTs to the approvals endpoint with no request body', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method, body: init.body };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 'SUCCESS', message: 'accepted' }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  const result = await client.requestApproval(16301574570);

  assert.equal(captured.url, 'https://api-gateway.coupang.com/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/16301574570/approvals');
  assert.equal(captured.method, 'PUT');
  assert.equal(captured.body, undefined);
  assert.equal(result.message, 'accepted');
});

test('CoupangClient.getProduct queries the seller-products endpoint by id', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 'SUCCESS', data: { sellerProductId: 12345, statusName: '저장' } }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  const result = await client.getProduct(12345);

  assert.equal(captured.url, 'https://api-gateway.coupang.com/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/12345');
  assert.equal(captured.method, 'GET');
  assert.equal(result.data.statusName, '저장');
});

test('CoupangClient.listOrderSheets queries the v5 ordersheets endpoint with the required params', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 200, data: [], nextToken: null }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  const result = await client.listOrderSheets({ createdAtFrom: '2026-07-25T00:00+09:00', createdAtTo: '2026-07-25T23:59+09:00', status: 'ACCEPT' });

  assert.equal(captured.method, 'GET');
  assert.match(captured.url, /\/v2\/providers\/openapi\/apis\/api\/v5\/vendors\/A00000000\/ordersheets\?/);
  assert.match(captured.url, /status=ACCEPT/);
  assert.match(captured.url, /searchType=timeFrame/);
  assert.deepEqual(result.data, []);
});

test('CoupangClient.searchBrand posts brandName/countPerPage/page to the brands/search endpoint', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method, body: JSON.parse(init.body) };
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: [{ brandId: 'KR-5', brandName: '와우픽', isUIDRequired: false, allowedUIDTypes: [] }] }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  const result = await client.searchBrand('와우픽');

  assert.equal(captured.url, 'https://api-gateway.coupang.com/v2/providers/seller_api/apis/api/v1/marketplace/brands/search');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, { brandName: '와우픽', countPerPage: 10, page: 1 });
  assert.equal(result.data[0].brandId, 'KR-5');
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

test('CoupangClient.uploadInvoice POSTs a single-entry orderSheetInvoiceApplyDtos to the v4 invoices endpoint', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method, body: JSON.parse(init.body) };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 200, data: { responseCode: 200, responseList: [{ shipmentBoxId: 64253897, succeed: true }] } }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  const result = await client.uploadInvoice({
    shipmentBoxId: 64253897, orderId: 22000009546234, vendorItemId: 3242596358,
    deliveryCompanyCode: 'HYUNDAI', invoiceNumber: '255593464954',
  });

  assert.equal(captured.method, 'POST');
  assert.match(captured.url, /\/v2\/providers\/openapi\/apis\/api\/v4\/vendors\/A00000000\/orders\/invoices$/);
  assert.equal(captured.body.vendorId, 'A00000000');
  assert.deepEqual(captured.body.orderSheetInvoiceApplyDtos, [{
    shipmentBoxId: 64253897, orderId: 22000009546234, vendorItemId: 3242596358,
    deliveryCompanyCode: 'HYUNDAI', invoiceNumber: '255593464954', splitShipping: false, preSplitShipped: false,
  }]);
  assert.equal(result.data.responseList[0].succeed, true);
});

test('CoupangClient.suspendSale/resumeSale PUT the vendor-items sales stop/resume endpoints with no body', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method, body: init.body };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 'SUCCESS', message: 'Sale has been suspended.' }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  await client.suspendSale(3242596358);
  assert.equal(captured.method, 'PUT');
  assert.match(captured.url, /\/v2\/providers\/seller_api\/apis\/api\/v1\/marketplace\/vendor-items\/3242596358\/sales\/stop$/);
  assert.equal(captured.body, undefined);

  await client.resumeSale(3242596358);
  assert.match(captured.url, /\/sales\/resume$/);
});

test('CoupangClient.listReturnRequests queries the v6 returnRequests endpoint with searchType/createdAtFrom/createdAtTo/cancelType', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 200, data: [], nextToken: null }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  await client.listReturnRequests({ createdAtFrom: '2026-07-25T00:00', createdAtTo: '2026-07-25T23:59', cancelType: 'CANCEL' });

  assert.equal(captured.method, 'GET');
  assert.match(captured.url, /\/v2\/providers\/openapi\/apis\/api\/v6\/vendors\/A00000000\/returnRequests\?/);
  assert.match(captured.url, /searchType=timeFrame/);
  assert.match(captured.url, /cancelType=CANCEL/);
});

test('CoupangClient.updateItemPrice PUTs price as a path segment with no body, omitting forceSalePriceUpdate by default', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init.method, body: init.body };
    return { ok: true, status: 200, async text() { return JSON.stringify({ code: 'SUCCESS', message: 'Completed price change.', data: null }); } };
  };
  const client = new CoupangClient({ accessKey: 'ak', secretKey: 'sk', vendorId: 'A00000000', fetchImpl });

  await client.updateItemPrice(3572784698, 49000);
  assert.equal(captured.method, 'PUT');
  assert.match(captured.url, /\/v2\/providers\/seller_api\/apis\/api\/v1\/marketplace\/vendor-items\/3572784698\/prices\/49000$/);
  assert.equal(captured.body, undefined);

  await client.updateItemPrice(3572784698, 49000, { forceSalePriceUpdate: true });
  assert.match(captured.url, /forceSalePriceUpdate=true/);
});

