import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKeywordExtractionPrompt,
  extractKeywordsFromTitles,
  parseKeywordExtractionResponse,
  selectFinalKeywords,
} from '../src/coupang-keyword-extractor.mjs';

test('buildKeywordExtractionPrompt numbers each title and never leaks price/image instructions', () => {
  const prompt = buildKeywordExtractionPrompt(['여성 가죽 벨트 3colors', '수면 안대 실크']);
  assert.match(prompt, /1\. 여성 가죽 벨트 3colors/);
  assert.match(prompt, /2\. 수면 안대 실크/);
  assert.match(prompt, /가격과 이미지는 무시/);
});

test('parseKeywordExtractionResponse parses a plain JSON array and dedupes whitespace-insensitive duplicates', () => {
  const result = parseKeywordExtractionResponse('["여성 벨트", "여성벨트", "쿨스카프"]');
  assert.deepEqual(result, ['여성 벨트', '쿨스카프']);
});

test('parseKeywordExtractionResponse unwraps a markdown code fence around the JSON array', () => {
  const result = parseKeywordExtractionResponse('```json\n["컵 수거함","라면 정리함"]\n```');
  assert.deepEqual(result, ['컵 수거함', '라면 정리함']);
});

test('parseKeywordExtractionResponse throws KEYWORD_EXTRACTION_PARSE_ERROR for non-JSON text', () => {
  assert.throws(
    () => parseKeywordExtractionResponse('죄송하지만 답변할 수 없습니다'),
    (error) => error.code === 'KEYWORD_EXTRACTION_PARSE_ERROR',
  );
});

test('parseKeywordExtractionResponse throws KEYWORD_EXTRACTION_PARSE_ERROR when the JSON is not an array', () => {
  assert.throws(
    () => parseKeywordExtractionResponse('{"keyword":"여성 벨트"}'),
    (error) => error.code === 'KEYWORD_EXTRACTION_PARSE_ERROR',
  );
});

test('extractKeywordsFromTitles throws NO_TITLES for an empty list', async () => {
  await assert.rejects(
    () => extractKeywordsFromTitles({ titles: [] }),
    (error) => error.code === 'NO_TITLES',
  );
});

test('extractKeywordsFromTitles sends the built prompt to Codex structured analysis and returns deduped keywords', async () => {
  let receivedRequest;
  const keywords = await extractKeywordsFromTitles({
    titles: ['여성 가죽 벨트', '쿨스카프 여름용'],
    config: { executable: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
    runAnalysisImpl: async (request) => {
      receivedRequest = request;
      return { success: true, analysis: { keywords: ['여성 벨트', '쿨스카프'] } };
    },
  });
  assert.match(receivedRequest.prompt, /여성 가죽 벨트/);
  assert.equal(receivedRequest.config.model, 'gpt-5.6-luna');
  assert.equal(receivedRequest.config.reasoningEffort, 'xhigh');
  assert.deepEqual(keywords, ['여성 벨트', '쿨스카프']);
});

test('extractKeywordsFromTitles reports Codex analysis failure', async () => {
  await assert.rejects(
    () => extractKeywordsFromTitles({
      titles: ['여성 가죽 벨트'],
      config: { executable: 'codex' },
      runAnalysisImpl: async () => ({ success: false, log: 'quota' }),
    }),
    (error) => error.code === 'CODEX_ANALYSIS_ERROR',
  );
});

test('selectFinalKeywords merges batches, dedupes across them, and caps to count', () => {
  const result = selectFinalKeywords([
    ['여성 벨트', '수면 안대'],
    ['여성벨트', '컵 수거함', '라면 정리함'],
  ], 3);
  assert.deepEqual(result, ['여성 벨트', '수면 안대', '컵 수거함']);
});

test('selectFinalKeywords defaults to count 3', () => {
  const result = selectFinalKeywords([['a', 'b', 'c', 'd']]);
  assert.deepEqual(result, ['a', 'b', 'c']);
});
