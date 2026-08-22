// AI-assisted scoring for the 3 competitiveness dimensions that have no real
// programmatic signal today (imageQuality/returnRisk/duplicateRisk) --
// user explicitly asked (2026-08-22) that whatever a plain program can't
// judge should be checked by AI instead of a fixed proxy/neutral value.
//
// Deliberately scoped to the manual "링크 입력" flow only
// (product-link-analysis.mjs) -- NOT the bulk automated discovery/keyword-
// sourcing flows (auto-discovery-batch.mjs / coupang-keyword-sourcing.mjs),
// which score 20-30 candidates per run and would multiply an AI call's
// latency/cost by that count. A human pasting a handful of links at once can
// afford a few-seconds-per-link AI call; the unattended pipeline should not
// silently get slower or costlier. Achieved simply by never wiring this
// module into auto-discovery-batch.mjs's own computeCompetitivenessScore
// calls -- see that function's context.aiImageQuality/etc. override comment.
//
// Every function here degrades to competitiveness-score.mjs's existing
// formula-based proxy on any failure (CLI unavailable, not logged in,
// timeout, unparseable response) so one AI hiccup never fails the whole
// link analysis -- same resilience posture as generated-image-qa.mjs.
//
// 2026-08-22 사용자 요청: 이미지 품질 판단은 Claude가 아니라 Codex(ChatGPT
// 로그인 기반, 별도 토큰 소모 -- Claude 사용량과 무관)로 돌린다. 반품/중복
// 위험은 텍스트만 보는 싼 호출이라 그대로 Claude에 남겨둔다. runCodexAnalysis
// 는 Claude의 자유 텍스트 프롬프트 방식과 달리 실제 JSON Schema 파일(스키마
// 자체가 형태를 강제하므로 Claude에서 겪은 "이미지 개수만큼 JSON을 따로
// 내놓는" 문제가 구조적으로 발생하지 않는다) + cwd(read-only 샌드박스에서도
// 그 안의 이미지는 읽을 수 있음, Claude의 --add-dir와 달리 이미지를 cwd
// 안에 두기만 하면 됨 -- 확인 완료) + outputPath를 요구해 claude-cli-client.mjs
// 보다 호출부가 조금 더 무겁다.
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { runClaudeTextPrompt } from './claude-cli-client.mjs';
import { runCodexAnalysis } from './codex-client.mjs';
import { loadRemoteImageForVision } from './generated-image-qa.mjs';
import { WEIGHTS, scoreDuplicateRisk, scoreImageQuality, scoreReturnRisk } from './competitiveness-score.mjs';

const MAX_IMAGES_FOR_QUALITY_REVIEW = 3;
const IMAGE_QUALITY_SCHEMA_PATH = 'schemas/image-quality-score.schema.json';

function parseAiScore(rawText, fields) {
  // Non-greedy -- our JSON schemas here are always flat (no nested braces),
  // so this takes the first complete {...} object and ignores anything
  // Claude appends after it (defense in depth alongside the prompt itself
  // now explicitly asking for exactly one object regardless of image count).
  const match = rawText.match(/\{[\s\S]*?\}/);
  if (!match) throw Object.assign(new Error('AI scoring response did not contain JSON'), { code: 'UNPARSEABLE_AI_SCORE' });
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (error) {
    throw Object.assign(new Error(`AI scoring response JSON failed to parse: ${error.message}`), { code: 'UNPARSEABLE_AI_SCORE' });
  }
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw Object.assign(new Error(`AI scoring response missing/invalid numeric 0-100 field "${field}"`), { code: 'INVALID_AI_SCORE_SHAPE' });
    }
  }
  return parsed;
}

function toPoints(score0to100, weight) {
  return Math.min(100, Math.max(0, score0to100)) / 100 * weight;
}

// 100 = 이커머스 대표/상세 이미지로서 매우 매력적이고 고품질, 0 = 매우 부실.
// Downloads at most MAX_IMAGES_FOR_QUALITY_REVIEW images to os.tmpdir() (same
// loadRemoteImageForVision generated-image-qa.mjs uses for Naver competitor
// thumbnails) and runs Codex with that same tmpdir as cwd so it can read
// them, and always cleans up (downloaded images + the JSON output file),
// success or failure.
export async function scoreImageQualityWithAi(images, {
  config,
  rootDir = process.cwd(),
  runCodexAnalysisImpl = runCodexAnalysis,
  loadRemoteImageForVisionImpl = loadRemoteImageForVision,
} = {}) {
  const urls = (Array.isArray(images) ? images : []).slice(0, MAX_IMAGES_FOR_QUALITY_REVIEW);
  if (urls.length === 0) return scoreImageQuality({ images });

  const downloaded = await Promise.all(urls.map((url) => loadRemoteImageForVisionImpl(url)));
  const outputPath = join(tmpdir(), `automoney-codex-image-quality-${randomUUID()}.json`);
  try {
    const prompt = '너는 이커머스 상품 이미지 품질 평가자다. 첨부된 이미지 전체를 하나의 상품 이미지 세트로 보고, 실제 쿠팡/네이버 판매용 대표·상세 이미지로서 얼마나 매력적이고 고품질인지(선명도, 구도, 배경, 정보 전달력 종합) 0~100점으로 평가해라. 이미지별로 따로 평가하지 말고 세트 전체에 대해 단 하나의 점수만 매겨라.';
    const result = await runCodexAnalysisImpl({
      config,
      cwd: tmpdir(),
      images: downloaded.map((d) => d.filePath),
      schemaPath: resolve(rootDir, IMAGE_QUALITY_SCHEMA_PATH),
      outputPath,
      prompt,
    });
    if (!result.success) {
      throw Object.assign(new Error(result.log || 'Codex image quality analysis failed'), { code: 'CODEX_IMAGE_QUALITY_FAILED' });
    }
    const { score, reason } = result.analysis;
    return { points: toPoints(score, WEIGHTS.imageQuality), reason: `[AI] ${reason || score + '점'}` };
  } finally {
    await Promise.all(downloaded.map((d) => d.cleanup?.()));
    await rm(outputPath, { force: true });
  }
}

// One combined text-only call for returnRisk + duplicateRisk -- both are
// pure text-reasoning judgments over the same product info, so bundling
// them into a single Claude CLI invocation halves the AI-call count (and
// therefore latency) per candidate versus calling them separately.
// returnRisk: 100 = 반품/교환 위험 매우 낮음, 0 = 매우 높음 (사이즈 의존적
// 의류, 파손 위험 소재, 전자기기 등은 낮게).
// duplicateRisk: 100 = 기존 등록 상품들과 완전히 차별화됨, 0 = 사실상 동일
// 상품. existingDraftTitles가 비어있으면 비교 대상이 없으므로 이 항목은
// 기존 프록시(기본 만점)로 남겨둔다 -- AI에게 물어봐도 비교할 게 없다.
export async function scoreTextJudgmentsWithAi(normalized, existingDraftTitles, {
  config,
  runClaudeTextPromptImpl = runClaudeTextPrompt,
} = {}) {
  const titles = Array.isArray(existingDraftTitles) ? existingDraftTitles.filter(Boolean) : [];
  const optionsText = (normalized.options || []).map((o) => `${o.name || ''}:${o.value || ''}`).join(', ') || '없음';
  const duplicateSection = titles.length > 0
    ? `기존 등록 상품명 목록:\n${titles.map((t) => `- ${t}`).join('\n')}\n\n신규 상품이 위 기존 상품들과 얼마나 차별화되는지(중복 아닌 정도) duplicateScore로 0~100점 평가해라 (100=완전히 다른 상품, 0=사실상 동일 상품).`
    : '';

  const prompt = `너는 이커머스 상품 리스크 분석가다. 아래 신규 상품 정보를 보고 판단해라.

상품명: ${normalized.name || '-'}
옵션: ${optionsText}
판매단위: ${normalized.sellUnitType || '-'}

1. 이 상품이 실제 판매됐을 때 반품/교환 위험이 얼마나 낮은지 returnRiskScore로 0~100점 평가해라 (100=위험 매우 낮음, 0=위험 매우 높음). 사이즈/색상처럼 사람마다 다르게 느껴지는 옵션이 많거나, 파손 위험 소재(유리/도자기 등)거나, 전자기기처럼 불량 가능성이 있으면 낮게 평가해라.
${duplicateSection}

반드시 아래 JSON 형식으로만 답해라 (다른 텍스트 없이, duplicateScore는 비교 대상이 있을 때만 포함):
{"returnRiskScore": 0~100 사이 정수, "returnRiskReason": "한 문장 이유"${titles.length > 0 ? ', "duplicateScore": 0~100 사이 정수, "duplicateReason": "한 문장 이유"' : ''}}`;

  const result = await runClaudeTextPromptImpl({ config, prompt });
  const requiredFields = titles.length > 0 ? ['returnRiskScore', 'duplicateScore'] : ['returnRiskScore'];
  const parsed = parseAiScore(result.rawText, requiredFields);

  const returnRisk = { points: toPoints(parsed.returnRiskScore, WEIGHTS.returnRisk), reason: `[AI] ${parsed.returnRiskReason || parsed.returnRiskScore + '점'}` };
  const duplicateRisk = titles.length > 0
    ? { points: toPoints(parsed.duplicateScore, WEIGHTS.duplicateRisk), reason: `[AI] ${parsed.duplicateReason || parsed.duplicateScore + '점'}` }
    : scoreDuplicateRisk(normalized, existingDraftTitles);

  return { returnRisk, duplicateRisk };
}

// Orchestrates both AI calls for one candidate, each independently falling
// back to its competitiveness-score.mjs proxy on failure so a single AI
// hiccup degrades one dimension, not the whole analysis. Returns a context
// fragment ready to spread into computeCompetitivenessScore's context arg.
// codexConfig drives imageQuality (Codex), claudeConfig drives the
// returnRisk+duplicateRisk text call (Claude) -- separate providers, see
// this file's header comment for why.
export async function computeAiScoringContext(candidate, existingDraftTitles, {
  codexConfig,
  claudeConfig,
  rootDir = process.cwd(),
  scoreImageQualityWithAiImpl = scoreImageQualityWithAi,
  scoreTextJudgmentsWithAiImpl = scoreTextJudgmentsWithAi,
} = {}) {
  const normalized = candidate.normalized || {};
  const filter = candidate.filter || {};

  const [imageQualityResult, textJudgmentsResult] = await Promise.allSettled([
    scoreImageQualityWithAiImpl(normalized.images, { config: codexConfig, rootDir }),
    scoreTextJudgmentsWithAiImpl(normalized, existingDraftTitles, { config: claudeConfig }),
  ]);

  const aiImageQuality = imageQualityResult.status === 'fulfilled' ? imageQualityResult.value : scoreImageQuality(normalized);
  const textJudgments = textJudgmentsResult.status === 'fulfilled' ? textJudgmentsResult.value : null;
  const aiReturnRisk = textJudgments ? textJudgments.returnRisk : scoreReturnRisk(normalized, filter);
  const aiDuplicateRisk = textJudgments ? textJudgments.duplicateRisk : scoreDuplicateRisk(normalized, existingDraftTitles);

  return { aiImageQuality, aiReturnRisk, aiDuplicateRisk };
}
