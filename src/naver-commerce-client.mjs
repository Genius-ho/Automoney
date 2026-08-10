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

  // Confirmed live 2026-07-24: createOriginProduct rejects any
  // originAreaCode that isn't one of these ~535 codes ("원산지 상세코드 항목이
  // 유효하지 않습니다"), a free-text country string is not accepted. See
  // pickOriginAreaCode in naver-registration-flow.mjs for the client-side
  // match against this list.
  async getOriginAreas() {
    return this.request('GET', '/v1/product-origin-areas', { operation: 'get_origin_areas' });
  }

  async createOriginProduct(payload) {
    return this.request('POST', '/v2/products', { body: payload, operation: 'create_origin_product' });
  }

  async getProduct(originProductNo) {
    return this.request('GET', `/v2/products/origin-products/${originProductNo}`, { operation: 'get_product' });
  }

  async searchProducts(body) {
    return this.request('POST', '/v1/products/search', {
      body,
      operation: 'search_products',
    });
  }

  // "(v2) 원상품 수정" -- confirmed spec, 2026-07-28 (apicenter.commerce.naver.com,
  // pasted directly by the user since the docs site is blocked for both
  // WebFetch and browser navigation in this environment, same as every other
  // Naver spec comment in this file). Keys off originProductNo, the same
  // identifier getProduct()/linkNaverRegistration already use -- unlike the
  // sibling PUT /v2/products/channel-products/{channelProductNo} endpoint,
  // which needs a channelProductNo this app never stores for speedgo-linked
  // listings. Body shape mirrors createOriginProduct's own
  // {originProduct, smartstoreChannelProduct} envelope (Naver's docs confirm
  // originProduct/smartstoreChannelProduct are the same structures across
  // registration, get, and both update endpoints) -- "부분 수정이 아닌 전체
  // 본문 형태가 안전합니다" (a full resubmission, not a partial patch), so
  // mapLiveNaverProductToImageSwapPayload spreads the live GET response
  // rather than building a payload from scratch.
  async updateOriginProduct(originProductNo, payload) {
    return this.request('PUT', `/v2/products/origin-products/${originProductNo}`, {
      body: payload,
      operation: 'update_origin_product',
    });
  }

  // "상품 판매 상태 변경" (automoney_complete_automation_implementation_plan.md
  // 15.2, "주문 전 품절 → 발주 차단 → 채널 판매중지") -- confirmed spec, 2026-07-26
  // (apicenter.commerce.naver.com, pasted directly by the user). Note the v1
  // path -- getProduct()/createOriginProduct() above are v2, this one isn't.
  // Whole-product level (originProductNo), unlike Coupang's per-vendorItemId
  // requirement -- no live item enumeration needed first. Documented
  // transition rule relevant here: SALE/OUTOFSTOCK/WAIT -> SUSPENSION is
  // always valid regardless of current status.
  async changeProductStatus(originProductNo, { statusType, saleStartDate, saleEndDate, stockQuantity } = {}) {
    const body = { statusType };
    if (saleStartDate) body.saleStartDate = saleStartDate;
    if (saleEndDate) body.saleEndDate = saleEndDate;
    if (stockQuantity !== undefined) body.stockQuantity = stockQuantity;
    return this.request('PUT', `/v1/products/origin-products/${originProductNo}/change-status`, {
      body,
      operation: 'change_product_status',
    });
  }

  // createOriginProduct rejects arbitrary external image URLs (R2, or any
  // other host) with "올바른 이미지 파일이 아닙니다" even when the file is a
  // perfectly valid image -- confirmed live 2026-07-24. Naver's own docs
  // (commerce-api-naver/commerce-api discussions #117/#1666) require images
  // to first go through this multipart upload endpoint, whose response URLs
  // are the only ones createOriginProduct actually accepts. The multipart
  // field name must be "imageFiles" for every file, even when uploading more
  // than one in the same request.
  async uploadImages(images) {
    const accessToken = await this.getAccessToken();
    const form = new FormData();
    for (const { buffer, filename, contentType } of images) {
      form.append('imageFiles', new Blob([buffer], { type: contentType }), filename);
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v1/product-images/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new NaverCommerceApiError({ status: response.status, operation: 'upload_images', bodyPreview: previewBody(text), path: '/v1/product-images/upload' });
    }
    return parseJson(text);
  }

  // UNVERIFIED against a real order -- this seller account has no live
  // orders yet (2026-07-25), so unlike every other method in this file,
  // these two have only been probed for "does the enum/param shape get
  // accepted" (confirmed live: lastChangedType admits PAY_WAITING/PAYED/
  // DISPATCHED, rejects DELIVERING; an empty result omits its data array
  // entirely rather than returning `data: []`), not for the actual response
  // field names inside a real order. Treat every field name
  // order-collector.mjs reads off these responses as a best-effort guess
  // until the first real order round-trip confirms or corrects it, the same
  // way naver-payload-builder.mjs's fields started out.
  async listChangedProductOrderIds({ lastChangedFrom, lastChangedType }) {
    return this.request('GET', '/v1/pay-order/seller/product-orders/last-changed-statuses', {
      query: { lastChangedFrom, lastChangedType },
      operation: 'list_changed_product_order_ids',
    });
  }

  async queryProductOrders(productOrderIds) {
    return this.request('POST', '/v1/pay-order/seller/product-orders/query', {
      body: { productOrderIds },
      operation: 'query_product_orders',
    });
  }

  // [주문] 발주 확인 처리 -- confirmed spec, 2026-07-26 (apicenter.commerce.naver.com,
  // pasted directly by the user since the docs site itself is blocked for
  // both WebFetch and browser navigation in this environment). Required
  // before dispatchProductOrders -- a product order's placeOrderStatus only
  // advances once this succeeds. Max 30 productOrderIds per call.
  async confirmProductOrders(productOrderIds) {
    return this.request('POST', '/v1/pay-order/seller/product-orders/confirm', {
      body: { productOrderIds },
      operation: 'confirm_product_orders',
    });
  }

  // [주문] 발송 처리 -- confirmed spec, 2026-07-26 (same source as above).
  // deliveryCompanyCode uses the exact same code set as Coupang's own
  // deliveryCompanyCode (CJGLS/HYUNDAI/HANJIN/KGB/EPOST/... all identical),
  // confirmed by comparing both published tables side by side -- see
  // carrier-code-map.mjs. Max 30 items per call. Response shares the same
  // { timestamp, traceId, data: { successProductOrderIds, failProductOrderInfos } }
  // shape as confirmProductOrders.
  // "옵션 재고(및 가격) 수정" -- confirmed spec, 2026-07-26 (apicenter.commerce.naver.com,
  // pasted directly by the user since the docs site is blocked for WebFetch/
  // browser navigation in this environment). optionInfo is required by
  // Naver's own spec even for a no-option product -- callers should pass
  // through whatever getProduct(originProductNo)'s own
  // originProduct.detailAttribute.optionInfo already contains (confirmed
  // live, 2026-07-26: a real no-option product returns
  // { optionCombinations: [], optionStandards: [], useStockManagement: true }),
  // not reconstruct it from scratch -- this client method itself doesn't
  // guess at that shape, see admin-server.mjs's buildNaverPriceUpdatePayload.
  async updateOptionStock(originProductNo, body) {
    return this.request('PUT', `/v1/products/origin-products/${originProductNo}/option-stock`, {
      body,
      operation: 'update_option_stock',
    });
  }

  async dispatchProductOrders(dispatchProductOrders) {
    return this.request('POST', '/v1/pay-order/seller/product-orders/dispatch', {
      body: { dispatchProductOrders },
      operation: 'dispatch_product_orders',
    });
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
