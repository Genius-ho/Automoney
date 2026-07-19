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
