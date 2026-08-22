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
// 2026-08-22 사용자 요청: 전부 Codex(ChatGPT 로그인 기반, Claude 사용량과
// 무관한 별도 토큰 풀)로 돌리고, model=gpt-5.6-luna / reasoning effort=xhigh
// 고정. (이전에는 이미지 품질만 Codex, 반품/중복 위험은 Claude였는데 이제
// 셋 다 Codex.) runCodexAnalysis는 자유 텍스트 프롬프트가 아니라 실제 JSON
// Schema 파일로 응답 형태를 구조적으로 강제하고, cwd 안의 이미지만 읽을 수
// 있다 (다운로드한 임시 이미지를 cwd 자체로 쓰면 됨 -- 실제 상품으로 검증
// 완료).
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { runCodexAnalysis } from './codex-client.mjs';
import { loadRemoteImageForVision } from './generated-image-qa.mjs';
import { WEIGHTS, scoreDuplicateRisk, scoreImageQuality, scoreReturnRisk } from './competitiveness-score.mjs';

const MAX_IMAGES_FOR_QUALITY_REVIEW = 3;
const IMAGE_QUALITY_SCHEMA_PATH = 'schemas/image-quality-score.schema.json';
const RISK_JUDGMENT_SCHEMA_PATH = 'schemas/return-duplicate-risk-score.schema.json';
const CODEX_MODEL = 'gpt-5.6-luna';
const CODEX_REASONING_EFFORT = 'xhigh';

// Every call in this file uses this fixed model/effort regardless of
// whatever a caller's loaded codexConfig otherwise carries (executable/
// sandbox/concurrency/timeoutMs) -- codex-client.mjs's runCodexAnalysis only
// adds -m/-c model_reasoning_effort= when these fields are present, so every
// other Codex usage in this codebase (image generation, product analysis)
// is unaffected and keeps using its own configured/default model.
function withScoringModel(config) {
  return { ...config, model: CODEX_MODEL, reasoningEffort: CODEX_REASONING_EFFORT };
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
      config: withScoringModel(config),
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

// One combined text-only Codex call for returnRisk + duplicateRisk -- both
// are pure text-reasoning judgments over the same product info, so bundling
// them into a single call halves the AI-call count (and therefore latency)
// per candidate versus calling them separately.
// returnRisk: 100 = 반품/교환 위험 매우 낮음, 0 = 매우 높음 (사이즈 의존적
// 의류, 파손 위험 소재, 전자기기 등은 낮게).
// duplicateRisk: 100 = 기존 등록 상품들과 완전히 차별화됨, 0 = 사실상 동일
// 상품. existingDraftTitles가 비어있으면 비교 대상이 없으므로 이 항목은
// 기존 프록시(기본 만점)로 남겨둔다 -- AI에게 물어봐도 비교할 게 없다.
export async function scoreTextJudgmentsWithAi(normalized, existingDraftTitles, {
  config,
  rootDir = process.cwd(),
  runCodexAnalysisImpl = runCodexAnalysis,
} = {}) {
  const titles = Array.isArray(existingDraftTitles) ? existingDraftTitles.filter(Boolean) : [];
  const optionsText = (normalized.options || []).map((o) => `${o.name || ''}:${o.value || ''}`).join(', ') || '없음';
  // 스키마가 duplicateScore/duplicateReason을 항상 required로 요구한다
  // (OpenAI structured output: additionalProperties:false면 properties의
  // 모든 키가 required에 있어야 함 -- 2026-08-22 실제로 이 조건 위반해서
  // invalid_json_schema 400 에러 재현됨). 그래서 "생략"이 아니라 "비교
  // 대상 없으면 null" 로 항상 두 필드를 요구한다.
  const duplicateSection = titles.length > 0
    ? `기존 등록 상품명 목록:\n${titles.map((t) => `- ${t}`).join('\n')}\n\n신규 상품이 위 기존 상품들과 얼마나 차별화되는지(중복 아닌 정도) duplicateScore로 0~100점, duplicateReason도 함께 평가해라 (100=완전히 다른 상품, 0=사실상 동일 상품).`
    : '2. 비교할 기존 상품 목록이 없으므로 duplicateScore와 duplicateReason은 null로 답해라.';

  const prompt = `너는 이커머스 상품 리스크 분석가다. 아래 신규 상품 정보를 보고 판단해라.

상품명: ${normalized.name || '-'}
옵션: ${optionsText}
판매단위: ${normalized.sellUnitType || '-'}

1. 이 상품이 실제 판매됐을 때 반품/교환 위험이 얼마나 낮은지 returnRiskScore로 0~100점, returnRiskReason도 함께 평가해라 (100=위험 매우 낮음, 0=위험 매우 높음). 사이즈/색상처럼 사람마다 다르게 느껴지는 옵션이 많거나, 파손 위험 소재(유리/도자기 등)거나, 전자기기처럼 불량 가능성이 있으면 낮게 평가해라.
${duplicateSection}`;

  const outputPath = join(tmpdir(), `automoney-codex-risk-judgment-${randomUUID()}.json`);
  try {
    const result = await runCodexAnalysisImpl({
      config: withScoringModel(config),
      cwd: tmpdir(),
      images: [],
      schemaPath: resolve(rootDir, RISK_JUDGMENT_SCHEMA_PATH),
      outputPath,
      prompt,
    });
    if (!result.success) {
      throw Object.assign(new Error(result.log || 'Codex risk judgment failed'), { code: 'CODEX_RISK_JUDGMENT_FAILED' });
    }
    const { returnRiskScore, returnRiskReason, duplicateScore, duplicateReason } = result.analysis;
    const returnRisk = { points: toPoints(returnRiskScore, WEIGHTS.returnRisk), reason: `[AI] ${returnRiskReason || returnRiskScore + '점'}` };
    const duplicateRisk = duplicateScore != null
      ? { points: toPoints(duplicateScore, WEIGHTS.duplicateRisk), reason: `[AI] ${duplicateReason || duplicateScore + '점'}` }
      : scoreDuplicateRisk(normalized, existingDraftTitles);
    return { returnRisk, duplicateRisk };
  } finally {
    await rm(outputPath, { force: true });
  }
}

// Orchestrates both AI calls for one candidate, each independently falling
// back to its competitiveness-score.mjs proxy on failure so a single AI
// hiccup degrades one dimension, not the whole analysis. Returns a context
// fragment ready to spread into computeCompetitivenessScore's context arg.
export async function computeAiScoringContext(candidate, existingDraftTitles, {
  codexConfig,
  rootDir = process.cwd(),
  scoreImageQualityWithAiImpl = scoreImageQualityWithAi,
  scoreTextJudgmentsWithAiImpl = scoreTextJudgmentsWithAi,
} = {}) {
  const normalized = candidate.normalized || {};
  const filter = candidate.filter || {};

  const [imageQualityResult, textJudgmentsResult] = await Promise.allSettled([
    scoreImageQualityWithAiImpl(normalized.images, { config: codexConfig, rootDir }),
    scoreTextJudgmentsWithAiImpl(normalized, existingDraftTitles, { config: codexConfig, rootDir }),
  ]);

  const aiImageQuality = imageQualityResult.status === 'fulfilled' ? imageQualityResult.value : scoreImageQuality(normalized);
  const textJudgments = textJudgmentsResult.status === 'fulfilled' ? textJudgmentsResult.value : null;
  const aiReturnRisk = textJudgments ? textJudgments.returnRisk : scoreReturnRisk(normalized, filter);
  const aiDuplicateRisk = textJudgments ? textJudgments.duplicateRisk : scoreDuplicateRisk(normalized, existingDraftTitles);

  return { aiImageQuality, aiReturnRisk, aiDuplicateRisk };
}
