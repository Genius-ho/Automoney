import { createHmac } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api-gateway.coupang.com';

export class CoupangApiError extends Error {
  constructor({ status, operation, bodyPreview, path }) {
    super(`Coupang API failed: HTTP ${status} operation=${operation}`);
    this.name = 'CoupangApiError';
    this.status = status;
    this.operation = operation;
    this.bodyPreview = bodyPreview;
    this.path = path;
  }
}

export class CoupangClient {
  constructor({
    accessKey,
    secretKey,
    vendorId,
    vendorUserId = null,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
  }) {
    if (!accessKey) throw new Error('COUPANG_ACCESS_KEY is required');
    if (!secretKey) throw new Error('COUPANG_SECRET_KEY is required');
    if (!vendorId) throw new Error('COUPANG_VENDOR_ID is required');
    if (!fetchImpl) throw new Error('fetch implementation is required');
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.vendorId = vendorId;
    this.vendorUserId = vendorUserId;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, { query = {}, body, operation } = {}) {
    const queryString = new URLSearchParams(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== null),
    ).toString();
    const authorization = signCoupangRequest({
      method,
      path,
      query: queryString,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
    });
    const url = `${this.baseUrl}${path}${queryString ? `?${queryString}` : ''}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new CoupangApiError({
        status: response.status,
        operation: operation || `${method} ${path}`,
        bodyPreview: previewBody(text),
        path,
      });
    }
    return parseJson(text);
  }

  async listOutboundShippingPlaces({ pageNum = 1, pageSize = 50 } = {}) {
    return this.request('GET', '/v2/providers/marketplace_openapi/apis/api/v1/vendor/shipping-place/outbound', {
      query: { pageNum, pageSize },
      operation: 'list_outbound_shipping_places',
    });
  }

  async listReturnShippingCenters({ pageNum = 1, pageSize = 50 } = {}) {
    return this.request('GET', `/v2/providers/openapi/apis/api/v4/vendors/${this.vendorId}/returnShippingCenters`, {
      query: { pageNum, pageSize },
      operation: 'list_return_shipping_centers',
    });
  }

  async predictCategory(productName) {
    return this.request('POST', '/v2/providers/openapi/apis/api/v1/categorization/predict', {
      body: { productName },
      operation: 'predict_category',
    });
  }

  async getCategoryMeta(displayCategoryCode) {
    return this.request('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${displayCategoryCode}`, {
      operation: 'get_category_meta',
    });
  }

  // "브랜드 검색" -- confirmed spec, 2026-07-28 (developers.coupang.com). Not
  // just a name->brandId lookup: isUIDRequired/allowedUIDTypes tell the
  // caller whether this brand needs a GTIN or MPN on every item at all (see
  // resolveBrandIdentifier in coupang-payload-builder.mjs), which is the
  // actual reason this call has to happen before every registration now.
  async searchBrand(brandName, { countPerPage = 10, page = 1 } = {}) {
    return this.request('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/brands/search', {
      body: { brandName, countPerPage, page },
      operation: 'search_brand',
    });
  }

  async createProduct(payload) {
    return this.request('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', {
      body: payload,
      operation: 'create_product',
    });
  }

  async getProduct(sellerProductId) {
    return this.request('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`, {
      operation: 'get_product',
    });
  }

  // Response envelope is { code, message, nextToken, data: [...] } -- data is
  // a plain array (confirmed against a live call), not a { content: [...] }
  // wrapper like some other list endpoints use.
  async listSellerProducts({ sellerProductName, statusCode, pageNum = 1, maxPerPage = 20 } = {}) {
    return this.request('GET', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', {
      query: { vendorId: this.vendorId, sellerProductName, statusCode, pageNum, maxPerPage },
      operation: 'list_seller_products',
    });
  }

  // Coupang's modify endpoint takes the same path as create (no id in the
  // URL) and requires the *entire* product JSON resubmitted, with
  // sellerProductId (and each item's sellerProductItemId) included so it's
  // recognized as an update rather than a new product.
  async updateProduct(payload) {
    return this.request('PUT', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', {
      body: payload,
      operation: 'update_product',
    });
  }

  // Sale-approval request: no request body, just the signed PUT itself.
  async requestApproval(sellerProductId) {
    return this.request('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/approvals`, {
      operation: 'request_approval',
    });
  }

  // "발주서 목록 조회(분단위 전체)" -- confirmed live schema (2026-07-25):
  // response is { code, message, data: [...], nextToken }, each data[] entry
  // a whole shipment box (shipmentBoxId, orderId, orderer, receiver,
  // orderItems: [{ vendorItemId, vendorItemName, shippingCount, ... }]), NOT
  // one row per line item -- order-collector.mjs flattens orderItems out
  // into one row per line. createdAtFrom/createdAtTo/status are all
  // required by Coupang; max 24-hour window per call.
  async listOrderSheets({ createdAtFrom, createdAtTo, status, searchType = 'timeFrame', nextToken } = {}) {
    return this.request('GET', `/v2/providers/openapi/apis/api/v5/vendors/${this.vendorId}/ordersheets`, {
      query: { createdAtFrom, createdAtTo, status, searchType, nextToken },
      operation: 'list_order_sheets',
    });
  }

  // "송장업로드 처리" (automoney_complete_automation_implementation_plan.md
  // 14.4) -- confirmed spec, 2026-07-26 (developers.coupang.com): moves a
  // shipmentBoxId from 상품준비중 to 배송지시. orderSheetInvoiceApplyDtos is an
  // array so several shipmentBoxIds could be uploaded in one call, but this
  // app always does one order at a time, matching every other per-row
  // processing step (order-collector, purchase-order-builder, ...).
  async uploadInvoice({ shipmentBoxId, orderId, vendorItemId, deliveryCompanyCode, invoiceNumber, splitShipping = false, preSplitShipped = false, estimatedShippingDate } = {}) {
    return this.request('POST', `/v2/providers/openapi/apis/api/v4/vendors/${this.vendorId}/orders/invoices`, {
      body: {
        vendorId: this.vendorId,
        orderSheetInvoiceApplyDtos: [{
          shipmentBoxId,
          orderId,
          vendorItemId,
          deliveryCompanyCode,
          invoiceNumber,
          splitShipping,
          preSplitShipped,
          ...(estimatedShippingDate ? { estimatedShippingDate } : {}),
        }],
      },
      operation: 'upload_invoice',
    });
  }

  // "상품 아이템별 판매 중지" (automoney_complete_automation_implementation_plan.md
  // 15.2, "주문 전 품절 → 발주 차단 → 채널 판매중지") -- confirmed spec, 2026-07-26
  // (developers.coupang.com). No request body; response is just {code, message}.
  async suspendSale(vendorItemId) {
    return this.request('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/sales/stop`, {
      operation: 'suspend_sale',
    });
  }

  async resumeSale(vendorItemId) {
    return this.request('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/sales/resume`, {
      operation: 'resume_sale',
    });
  }

  // "반품/취소 요청 목록 조회" (automoney_complete_automation_implementation_plan.md
  // 15.1/15.3) -- confirmed spec, 2026-07-26 (developers.coupang.com).
  // cancelType defaults to "RETURN" server-side if omitted -- there is no
  // single call that returns both RETURN and CANCEL records, so
  // return-request-collector.mjs calls this twice per sweep. nextToken is
  // documented as unsupported together with searchType=timeFrame (unlike
  // listOrderSheets, which does page through timeFrame results) -- no
  // pagination loop here, one call per collection window.
  async listReturnRequests({ createdAtFrom, createdAtTo, status, cancelType, searchType = 'timeFrame' } = {}) {
    return this.request('GET', `/v2/providers/openapi/apis/api/v6/vendors/${this.vendorId}/returnRequests`, {
      query: { searchType, createdAtFrom, createdAtTo, status, cancelType },
      operation: 'list_return_requests',
    });
  }

  // "상품 아이템별 가격 변경" -- confirmed spec, 2026-07-26 (developers.coupang.com).
  // Price is a PATH segment, not a body field; no request body at all. 10원
  // increments only. forceSalePriceUpdate bypasses Coupang's normal
  // percentage-change guardrail -- default false (let Coupang reject an
  // unusually large jump rather than silently forcing it through).
  async updateItemPrice(vendorItemId, price, { forceSalePriceUpdate = false, apMinSalePrice, apActive } = {}) {
    return this.request('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/prices/${price}`, {
      query: { forceSalePriceUpdate: forceSalePriceUpdate || undefined, apMinSalePrice, apActive },
      operation: 'update_item_price',
    });
  }
}

// Coupang Wing Open API custom HMAC scheme: the signed message is the
// concatenation of signed-date + METHOD + path + rawQueryString (no
// separators), HMAC-SHA256'd with the secret key and hex-encoded. Neither the
// secret key nor the resulting signature is ever logged by callers of this
// function — only the returned Authorization header string is used directly
// in the request, never printed.
export function signCoupangRequest({ method, path, query = '', accessKey, secretKey }) {
  const signedDate = formatSignedDate(new Date());
  const message = `${signedDate}${String(method).toUpperCase()}${path}${query}`;
  const signature = createHmac('sha256', secretKey).update(message).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

export function maskAccessKey(value) {
  const text = String(value || '');
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(text.length - 4)}`;
}

function formatSignedDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(2);
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${yy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Coupang API returned invalid JSON: ${error.message}`);
  }
}

function previewBody(body, limit = 800) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
