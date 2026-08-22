import assert from 'node:assert/strict';
import test from 'node:test';

import { NaverApiHubError, fetchShoppingKeywordTrend } from '../src/naver-api-hub-client.mjs';

test('fetchShoppingKeywordTrend posts to the shopping/v1/category/keywords endpoint with NCP-style headers and a single-keyword group', async () => {
  let receivedUrl = null;
  let receivedOptions = null;
  const fetchImpl = async (url, options) => {
    receivedUrl = url;
    receivedOptions = options;
    return { ok: true, text: async () => JSON.stringify({ startDate: '2026-01-01', endDate: '2026-02-01', results: [{ title: '여성 벨트', keyword: ['여성 벨트'], data: [] }] }) };
  };

  const result = await fetchShoppingKeywordTrend(
    { clientId: 'id', clientSecret: 'secret', fetchImpl },
    { keyword: '여성 벨트', category: '50000000', startDate: '2026-01-01', endDate: '2026-02-01', timeUnit: 'month' },
  );

  assert.equal(receivedUrl, 'https://naverapihub.apigw.ntruss.com/shopping/v1/category/keywords');
  assert.equal(receivedOptions.method, 'POST');
  assert.equal(receivedOptions.headers['X-NCP-APIGW-API-KEY-ID'], 'id');
  assert.equal(receivedOptions.headers['X-NCP-APIGW-API-KEY'], 'secret');
  assert.equal(receivedOptions.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(receivedOptions.body), {
    startDate: '2026-01-01',
    endDate: '2026-02-01',
    timeUnit: 'month',
    category: '50000000',
    keyword: [{ name: '여성 벨트', param: ['여성 벨트'] }],
  });
  assert.equal(result.results[0].title, '여성 벨트');
});

test('fetchShoppingKeywordTrend defaults timeUnit to month when not supplied', async () => {
  let receivedOptions = null;
  await fetchShoppingKeywordTrend(
    { clientId: 'id', clientSecret: 'secret', fetchImpl: async (url, options) => { receivedOptions = options; return { ok: true, text: async () => '{}' }; } },
    { keyword: 'x', category: 'y', startDate: '2026-01-01', endDate: '2026-02-01' },
  );
  assert.equal(JSON.parse(receivedOptions.body).timeUnit, 'month');
});

test('fetchShoppingKeywordTrend throws NaverApiHubError with status/body on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, text: async () => JSON.stringify({ error: { errorCode: 401, message: '요청한 API는 이 Application에서 활성화되어 있지 않습니다.' } }) });
  await assert.rejects(
    () => fetchShoppingKeywordTrend({ clientId: 'id', clientSecret: 'secret', fetchImpl }, { keyword: 'x', category: 'y', startDate: '2026-01-01', endDate: '2026-02-01' }),
    (error) => error instanceof NaverApiHubError && /활성화되어 있지 않습니다/.test(error.bodyPreview),
  );
});

test('fetchShoppingKeywordTrend requires clientId/clientSecret', async () => {
  await assert.rejects(
    () => fetchShoppingKeywordTrend({ clientSecret: 'secret' }, { keyword: 'x', category: 'y', startDate: '2026-01-01', endDate: '2026-02-01' }),
    /NAVER_API_HUB_CLIENT_ID is required/,
  );
  await assert.rejects(
    () => fetchShoppingKeywordTrend({ clientId: 'id' }, { keyword: 'x', category: 'y', startDate: '2026-01-01', endDate: '2026-02-01' }),
    /NAVER_API_HUB_CLIENT_SECRET is required/,
  );
});
