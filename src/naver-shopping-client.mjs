export class NaverShoppingApiError extends Error {
  constructor({ status, bodyPreview }) {
    super(`Naver Shopping API failed: HTTP ${status}`);
    this.name = 'NaverShoppingApiError';
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

export class NaverShoppingClient {
  constructor({
    clientId,
    clientSecret,
    endpoint = 'https://openapi.naver.com/v1/search/shop.json',
    fetchImpl = globalThis.fetch,
  }) {
    if (!clientId) throw new Error('NAVER_CLIENT_ID is required');
    if (!clientSecret) throw new Error('NAVER_CLIENT_SECRET is required');
    if (!fetchImpl) throw new Error('fetch implementation is required');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
  }

  async searchShop({ query, display = 20, start = 1, sort = 'sim', exclude = 'used:rental:cbshop' }) {
    const url = new URL(this.endpoint);
    url.search = new URLSearchParams({
      query,
      display: String(display),
      start: String(start),
      sort,
      exclude,
    }).toString();
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        'X-Naver-Client-Id': this.clientId,
        'X-Naver-Client-Secret': this.clientSecret,
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new NaverShoppingApiError({ status: response.status, bodyPreview: previewBody(body) });
    }
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`Naver Shopping API returned invalid JSON: ${error.message}`);
    }
  }
}

export function summarizeShoppingSearch(raw, mySalePrice) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const pricedItems = items
    .map((item) => ({ item, price: Number(item?.lprice) }))
    .filter(({ price }) => Number.isFinite(price) && price > 0);
  const lowest = pricedItems.reduce((best, current) => (!best || current.price < best.price ? current : best), null);
  const topPrices = pricedItems.slice(0, 20).map(({ price }) => price);
  const topPriceAvg = topPrices.length
    ? Math.round(topPrices.reduce((sum, price) => sum + price, 0) / topPrices.length)
    : null;
  return {
    competitorCount: Number(raw?.total || 0),
    lowestPrice: lowest?.price ?? null,
    topPriceAvg,
    priceGapRate:
      lowest?.price && Number.isFinite(Number(mySalePrice))
        ? (Number(mySalePrice) - lowest.price) / lowest.price
        : null,
    bestItem: lowest
      ? {
          title: stripHtml(lowest.item.title || ''),
          mallName: lowest.item.mallName || '',
          link: lowest.item.link || '',
          lprice: lowest.price,
        }
      : null,
  };
}

function previewBody(body, limit = 300) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, '').trim();
}
