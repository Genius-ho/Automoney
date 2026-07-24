import bcrypt from 'bcryptjs';

const DEFAULT_BASE_URL = 'https://api.commerce.naver.com/external';
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

export class NaverCommerceApiError extends Error {
  constructor({ status, operation, bodyPreview, path }) {
    super(`Naver Commerce API failed: HTTP ${status} operation=${operation}`);
    this.name = 'NaverCommerceApiError';
    this.status = status;
    this.operation = operation;
    this.bodyPreview = bodyPreview;
    this.path = path;
  }
}

// Naver Commerce API's own OAuth2 client_credentials scheme (distinct from a
// plain client_credentials grant): the signed value is
// `${clientId}_${timestampMs}`, bcrypt-hashed USING clientSecret AS THE SALT
// (not a normal bcrypt salt round), then base64-encoded -- see
// apicenter.commerce.naver.com's 인증 문서. A pure-JS bcrypt (no native
// bindings) keeps this portable across the planned Windows -> Linux move.
export function signNaverCommerceRequest({ clientId, clientSecret, timestampMs = Date.now() }) {
  const password = `${clientId}_${timestampMs}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  return { timestampMs, signature: Buffer.from(hashed, 'utf8').toString('base64') };
}

export class NaverCommerceClient {
  constructor({
    clientId,
    clientSecret,
    channelId = null,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
  }) {
    if (!clientId) throw new Error('NAVER_COMMERCE_CLIENT_ID is required');
    if (!clientSecret) throw new Error('NAVER_COMMERCE_CLIENT_SECRET is required');
    if (!fetchImpl) throw new Error('fetch implementation is required');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.channelId = channelId;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.tokenCache = null; // { accessToken, expiresAt }
  }

  // Token is cached in memory until shortly before its declared expiry --
  // every other method calls this first rather than each managing its own
  // token, so a registration flow making several calls in a row never
  // re-authenticates more than once.
  async getAccessToken() {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + TOKEN_EXPIRY_SAFETY_MARGIN_MS) {
      return this.tokenCache.accessToken;
    }
    const { timestampMs, signature } = signNaverCommerceRequest({ clientId: this.clientId, clientSecret: this.clientSecret });
    const body = new URLSearchParams({
      client_id: this.clientId,
      timestamp: String(timestampMs),
      client_secret_sign: signature,
      grant_type: 'client_credentials',
      type: 'SELF',
    });
    const response = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new NaverCommerceApiError({ status: response.status, operation: 'oauth2_token', bodyPreview: previewBody(text), path: '/v1/oauth2/token' });
    }
    const parsed = parseJson(text);
    this.tokenCache = { accessToken: parsed.access_token, expiresAt: Date.now() + Number(parsed.expires_in || 0) * 1000 };
    return this.tokenCache.accessToken;
  }

  async request(method, path, { query = {}, body, operation } = {}) {
    const accessToken = await this.getAccessToken();
    const queryString = new URLSearchParams(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== null),
    ).toString();
    const url = `${this.baseUrl}${path}${queryString ? `?${queryString}` : ''}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new NaverCommerceApiError({ status: response.status, operation: operation || `${method} ${path}`, bodyPreview: previewBody(text), path });
    }
    return parseJson(text);
  }

  async searchCategories(keyword) {
    return this.request('GET', '/v1/categories', { query: { searchKeyword: keyword }, operation: 'search_categories' });
  }

  async getCategoryAttributes(categoryId) {
    return this.request('GET', `/v1/categories/${categoryId}/attributes`, { operation: 'get_category_attributes' });
  }

  async createOriginProduct(payload) {
    return this.request('POST', '/v2/products', { body: payload, operation: 'create_origin_product' });
  }

  async getProduct(originProductNo) {
    return this.request('GET', `/v2/products/origin-products/${originProductNo}`, { operation: 'get_product' });
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Naver Commerce API returned invalid JSON: ${error.message}`);
  }
}

function previewBody(body, limit = 800) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
