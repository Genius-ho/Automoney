// checkNaverTrendLive (naver-research.mjs) needs a clean search keyword and
// a 네이버쇼핑 대분류 cat_id per candidate -- neither exists on a candidate
// today. The raw scraped product title (candidate.normalized.name) is a
// keyword-stuffed listing title ("버클 슬림 벨트 원피스 데일리 코디 포인트
// 패션 허리띠 여성 골드 체인 체인벨트 여자"), not something a real shopper
// types, and Shopping Insight returns no data points at all for it even
// with the right category -- confirmed live 2026-08-22. 사용자 요청(2026-08-22):
// 후보마다 Codex에게 상품명을 주고 짧은 검색 키워드와 카테고리를 매번 추출하게
// 한다.
//
// The 11 categoryCode values in schemas/naver-trend-target.schema.json are
// the classic 네이버 데이터랩 쇼핑인사이트 대분류 목록 (패션의류=50000000
// 부터 면세점=50000010까지) -- the discontinued 개발자센터 문서가 이걸 공개
// 문서화했었지만 그 사이트 자체가 접근 불가라 이 세션에서 전체 표를 재확인은
// 못 했다. 틀린 카테고리를 골라도 checkNaverTrendLive는 그냥 데이터 없음(null,
// 중립값)으로 떨어질 뿐 (카테고리/키워드가 실제로 안 맞으면 에러가 아니라
// 빈 데이터가 온다는 것도 이 세션에서 실제 호출로 확인함) 지금의 "항상 건너뜀"
// 보다 나쁠 게 없다.
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { runCodexAnalysis } from './codex-client.mjs';
import { withScoringModel } from './ai-competitiveness-scoring.mjs';

const SCHEMA_PATH = 'schemas/naver-trend-target.schema.json';

const CATEGORY_LABELS = [
  ['50000000', '패션의류'],
  ['50000001', '패션잡화'],
  ['50000002', '화장품/미용'],
  ['50000003', '디지털/가전'],
  ['50000004', '가구/인테리어'],
  ['50000005', '출산/육아'],
  ['50000006', '식품'],
  ['50000007', '스포츠/레저'],
  ['50000008', '생활/건강'],
  ['50000009', '여가/생활편의'],
  ['50000010', '면세점'],
];

function buildPrompt(name) {
  const categoryList = CATEGORY_LABELS.map(([code, label]) => `${code}: ${label}`).join('\n');
  return `아래는 이커머스 상품의 원본 상품명이다 (브랜드/사이즈/색상/수량이 뒤섞인 판매용 제목).

상품명: ${name}

1. 실제 쇼핑객이 네이버쇼핑에서 이 상품을 찾을 때 입력할 법한 짧고 깨끗한 검색 키워드를 keyword로 답해라. 브랜드명, 사이즈, 색상, 수량/세트 표현은 빼고, 2~4어절의 핵심 상품 종류만 남겨라.
2. 이 상품이 아래 11개 네이버쇼핑 대분류 중 어디에 가장 잘 맞는지 categoryCode로 답해라.

${categoryList}`;
}

// candidate -> {keyword, categoryCode} via a single Codex call, or null on
// any failure (unparseable response, CLI unavailable, timeout) -- callers
// treat null exactly like "couldn't resolve a category", i.e. skip the
// Naver trend lookup and leave that dimension on its neutral proxy.
export async function resolveNaverTrendTarget(candidate, {
  config,
  rootDir = process.cwd(),
  runCodexAnalysisImpl = runCodexAnalysis,
} = {}) {
  const name = candidate?.normalized?.name;
  if (!name) return null;

  const outputPath = join(tmpdir(), `automoney-codex-naver-trend-target-${randomUUID()}.json`);
  try {
    const result = await runCodexAnalysisImpl({
      config: withScoringModel(config),
      cwd: tmpdir(),
      images: [],
      schemaPath: resolve(rootDir, SCHEMA_PATH),
      outputPath,
      prompt: buildPrompt(name),
    });
    if (!result.success) return null;
    const { keyword, categoryCode } = result.analysis || {};
    if (!keyword || !categoryCode) return null;
    return { keyword, categoryCode };
  } catch {
    return null;
  } finally {
    await rm(outputPath, { force: true });
  }
}
