import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { runCodexAnalysis } from './codex-client.mjs';

const KEYWORD_SCHEMA_PATH = 'schemas/keyword-extraction.schema.json';

// Mirrors the manual workflow: look only at product *titles* (never price or
// image) from a Coupang 추천순 listing and pull out the core product-type
// keyword each title is selling -- not the brand, size, color, or bundle
// count. The model is asked for diverse keywords so near-synonyms (e.g.
// "여성 허리띠" vs "여성 벨트") collapse to one.
export function buildKeywordExtractionPrompt(titles) {
  const titleList = titles.map((title, index) => `${index + 1}. ${title}`).join('\n');
  return [
    '아래는 쿠팡 상품 목록 제목이다. 가격과 이미지는 무시하고 제목 텍스트만 보고,',
    '각 제목이 실제로 팔고 있는 핵심 상품 종류를 나타내는 키워드를 뽑아라.',
    '',
    '규칙:',
    '- 브랜드명, 사이즈, 색상, 수량/세트 표현은 제외한다.',
    '- 같은 상품을 가리키는 유사어(예: "여성 허리띠"와 "여성 벨트")는 하나로 합친다.',
    '- 최대한 다양한 상품 종류가 나오도록 하고, 최소 3개 이상 뽑는다.',
    '- 각 키워드는 2~4어절의 한국어 명사구로 작성한다.',
    '',
    titleList,
    '',
    '다른 설명 없이 JSON 문자열 배열로만 답하라. 예: ["여성 벨트","쿨스카프","컵 수거함"]',
  ].join('\n');
}

// Tolerates the model wrapping its JSON answer in a markdown code fence
// despite the "다른 설명 없이" instruction -- cheaper than retrying the call.
export function parseKeywordExtractionResponse(rawText) {
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenceMatch ? fenceMatch[1] : rawText;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseError) {
    const error = new Error(`Failed to parse keyword extraction response as JSON: ${parseError.message}`);
    error.code = 'KEYWORD_EXTRACTION_PARSE_ERROR';
    throw error;
  }
  if (!Array.isArray(parsed)) {
    const error = new Error('Keyword extraction response was not a JSON array');
    error.code = 'KEYWORD_EXTRACTION_PARSE_ERROR';
    throw error;
  }

  return dedupeKeywords(parsed.map((keyword) => String(keyword).trim()).filter(Boolean));
}

export function dedupeKeywords(keywords) {
  const seen = new Set();
  const result = [];
  for (const keyword of keywords) {
    const key = keyword.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
  }
  return result;
}

export async function extractKeywordsFromTitles({ titles, config, rootDir = process.cwd(), runAnalysisImpl = runCodexAnalysis } = {}) {
  if (!Array.isArray(titles) || titles.length === 0) {
    const error = new Error('extractKeywordsFromTitles requires at least one title');
    error.code = 'NO_TITLES';
    throw error;
  }

  const prompt = buildKeywordExtractionPrompt(titles);
  const tempRoot = await mkdtemp(join(tmpdir(), `automoney-codex-keywords-${randomUUID()}-`));
  const outputPath = join(tempRoot, 'result.json');
  try {
    const result = await runAnalysisImpl({
      config,
      cwd: tempRoot,
      images: [],
      schemaPath: resolve(rootDir, KEYWORD_SCHEMA_PATH),
      outputPath,
      prompt,
    });
    if (!result.success) {
      throw Object.assign(new Error(result.log || 'Codex keyword extraction failed'), { code: 'CODEX_ANALYSIS_ERROR' });
    }
    if (!Array.isArray(result.analysis?.keywords)) {
      throw Object.assign(new Error('Codex keyword extraction returned an invalid keywords array'), { code: 'CODEX_INVALID_OUTPUT' });
    }
    return dedupeKeywords(result.analysis.keywords.map((keyword) => String(keyword).trim()).filter(Boolean));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

// Merges keyword batches collected across multiple category dives and picks
// the first `count` distinct ones -- same dedupe rule as within a single
// batch, so a keyword rediscovered in a second category doesn't cost a slot.
export function selectFinalKeywords(keywordBatches, count = 3) {
  const merged = dedupeKeywords(keywordBatches.flat());
  return merged.slice(0, count);
}
