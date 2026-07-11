export class DomemeApiError extends Error {
  constructor({ status, productNo, operation = 'product detail', bodyPreview, maskedUrl, code }) {
    super(`Domeme API failed: HTTP ${status} operation=${operation}${productNo ? ` product=${productNo}` : ''}`);
    this.name = 'DomemeApiError';
    this.status = status;
    this.productNo = productNo == null ? null : String(productNo);
    this.operation = operation;
    this.bodyPreview = bodyPreview;
    this.maskedUrl = maskedUrl;
    this.code = code || null;
  }
}

export class DomemeClient {
  constructor({
    apiKey,
    endpoint = 'https://domeggook.com/ssl/api/',
    fetchImpl = globalThis.fetch,
  }) {
    if (!apiKey) throw new Error('Domeme API key is required');
    if (!endpoint) throw new Error('Domeme product detail endpoint is required');
    if (!fetchImpl) throw new Error('fetch implementation is required');

    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
  }

  async fetchProductDetail(productNo) {
    const response = await this.fetchProductDetailResponse(productNo);
    return response.raw;
  }

  async fetchProductDetailResponse(productNo) {
    const url = this.buildProductDetailUrl(productNo);
    const response = await this.fetchImpl(url, { method: 'GET' });
    const body = await response.text();
    if (!response.ok) {
      throw new DomemeApiError({
        status: response.status,
        productNo,
        operation: 'product detail',
        bodyPreview: previewBody(body, this.apiKey),
        maskedUrl: maskUrl(url),
      });
    }

    try {
      return {
        status: response.status,
        raw: JSON.parse(body),
        maskedUrl: maskUrl(url),
      };
    } catch (error) {
      throw new Error(`Domeme API returned invalid JSON for product ${productNo}: ${error.message}`);
    }
  }

  async searchProducts({ keyword, category, page = 1, size = 50, market = 'dome' } = {}) {
    const url = this.buildProductSearchUrl({ keyword, category, page, size, market });
    const response = await this.fetchImpl(url, { method: 'GET' });
    const body = await response.text();
    if (!response.ok) {
      throw new DomemeApiError({
        status: response.status,
        operation: 'product search',
        bodyPreview: previewBody(body, this.apiKey),
        maskedUrl: maskUrl(url),
      });
    }

    let raw;
    try {
      raw = JSON.parse(body);
    } catch (error) {
      throw new Error(`Domeme API returned invalid JSON for product search: ${error.message}`);
    }

    const apiError = extractApiError(raw);
    if (apiError) {
      throw new DomemeApiError({
        status: Number(apiError.code || 200),
        operation: 'product search',
        bodyPreview: previewBody(JSON.stringify(raw), this.apiKey),
        maskedUrl: maskUrl(url),
        code: apiError.dcode || apiError.code || null,
      });
    }

    return {
      raw,
      candidates: extractProductCandidates(raw),
      maskedUrl: maskUrl(url),
    };
  }

  buildProductDetailUrl(productNo) {
    const url = new URL(this.endpoint);
    const params = new URLSearchParams({
      ver: '4.6',
      mode: 'getItemView',
      aid: this.apiKey,
      om: 'json',
      no: String(productNo),
    });
    url.search = params.toString();
    return url;
  }

  buildProductSearchUrl({ keyword, category, page = 1, size = 50, market = 'dome' } = {}) {
    const url = new URL(this.endpoint);
    const params = new URLSearchParams({
      ver: process.env.DOMEME_PRODUCT_LIST_VERSION || '4.1',
      mode: process.env.DOMEME_PRODUCT_SEARCH_MODE || 'getItemList',
      aid: this.apiKey,
      om: 'json',
      pg: String(page),
      sz: String(size),
      so: process.env.DOMEME_PRODUCT_LIST_SORT || 'rd',
    });
    const selectedMarket = market ?? process.env.DOMEME_PRODUCT_LIST_MARKET ?? 'dome';
    if (selectedMarket) params.set('market', String(selectedMarket));
    if (keyword) params.set(process.env.DOMEME_PRODUCT_SEARCH_KEYWORD_PARAM || 'kw', String(keyword));
    if (category) params.set(process.env.DOMEME_PRODUCT_SEARCH_CATEGORY_PARAM || 'ca', String(category));
    url.search = params.toString();
    return url;
  }
}

export function extractProductCandidates(raw) {
  const values = [];
  collectCandidateValues(raw, values);
  const seen = new Set();
  return values
    .map((value) => ({
      productNo: String(value.productNo || '').trim(),
      source: value.source,
    }))
    .filter((value) => /^\d+$/.test(value.productNo))
    .filter((value) => {
      if (seen.has(value.productNo)) return false;
      seen.add(value.productNo);
      return true;
    });
}

export function maskApiKey(apiKey) {
  const value = String(apiKey || '');
  if (value.length < 4) return '****';
  return `${value.slice(0, 4)}****`;
}

export function maskUrl(input) {
  const url = new URL(input);
  const aid = url.searchParams.get('aid');
  if (aid !== null) url.searchParams.set('aid', maskApiKey(aid));
  return url.toString();
}

function previewBody(body, apiKey, limit = 300) {
  const compact = String(body || '').replace(/\s+/g, ' ').trim();
  const masked = apiKey ? compact.replaceAll(String(apiKey), maskApiKey(apiKey)) : compact;
  return masked.slice(0, limit);
}

function extractApiError(raw) {
  const error = raw?.errors || raw?.error;
  if (!error) return null;
  if (typeof error === 'string') return { code: 'ERROR', message: error };
  return error;
}

function collectCandidateValues(value, output) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCandidateValues(item, output);
    return;
  }
  if (typeof value !== 'object') return;

  const direct = firstCandidateNo(value);
  if (direct) output.push({ productNo: direct, source: value });

  for (const inner of Object.values(value)) {
    if (inner && typeof inner === 'object') collectCandidateValues(inner, output);
  }
}

function firstCandidateNo(value) {
  for (const key of ['no', 'itemNo', 'item_no', 'productNo', 'product_no', 'goodsNo', 'goods_no']) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) return candidate;
  }
  return null;
}
