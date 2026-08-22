// NAVER API HUB (NCP) -- 2026-08-22부터 사용. 기존 개발자센터
// openapi.naver.com 검색 API(구 naver-shopping-client.mjs)와는 완전히 다른
// 서비스: 베이스 URL도, 인증 헤더도, 발급 계정(NCP)도 다르다. 개발자센터
// 쇼핑검색 API는 2026-07-31에 대체재 없이 종료됐고(공식 공지 확인됨), 이걸
// 대신할 개별 상품 가격/판매처 API는 NAVER API HUB에도 없다 -- 여기서 쓸 수
// 있는 건 쇼핑 인사이트(카테고리/키워드 클릭 트렌드)뿐이라, naverCompetition
// 점수는 "경쟁상품수/가격격차"가 아니라 "이 키워드 클릭 트렌드가 꾸준히
// 높은지 + 상승 추세인지"로 재정의됐다 (naver-research.mjs의
// checkNaverTrendLive 참고).
const NAVER_API_HUB_BASE = 'https://naverapihub.apigw.ntruss.com';

export class NaverApiHubError extends Error {
  constructor({ status, bodyPreview }) {
    super(`NAVER API HUB request failed: HTTP ${status}`);
    this.name = 'NaverApiHubError';
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

// keyword: 검색어 하나 (요청 바디는 여러 키워드 그룹을 받을 수 있지만, 여기서는
// 후보 상품 하나씩 개별 조회하므로 1개만 보낸다). category: 네이버쇼핑 cat_id
// (필수 -- 없으면 호출하지 않는 게 caller의 책임, 이 함수는 그대로 넘긴다).
export async function fetchShoppingKeywordTrend({ clientId, clientSecret, fetchImpl = globalThis.fetch }, {
  keyword,
  category,
  startDate,
  endDate,
  timeUnit = 'month',
}) {
  if (!clientId) throw new Error('NAVER_API_HUB_CLIENT_ID is required');
  if (!clientSecret) throw new Error('NAVER_API_HUB_CLIENT_SECRET is required');
  const response = await fetchImpl(`${NAVER_API_HUB_BASE}/shopping/v1/category/keywords`, {
    method: 'POST',
    headers: {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY': clientSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      startDate,
      endDate,
      timeUnit,
      category,
      keyword: [{ name: keyword, param: [keyword] }],
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) throw new NaverApiHubError({ status: response.status, bodyPreview: bodyText.slice(0, 300) });
  return JSON.parse(bodyText);
}
