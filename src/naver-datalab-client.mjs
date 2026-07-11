export class NaverDatalabClient {
  constructor({
    clientId,
    clientSecret,
    endpoint = 'https://openapi.naver.com/v1/datalab/shopping/categories',
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

  async fetchShoppingInsight(payload) {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Naver-Client-Id': this.clientId,
        'X-Naver-Client-Secret': this.clientSecret,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Naver Datalab API failed: HTTP ${response.status}`);
    return JSON.parse(text);
  }
}

export function buildSkippedDatalabResult({ reason = 'skipped_no_category' } = {}) {
  return { datalabStatus: reason, datalab: null };
}
