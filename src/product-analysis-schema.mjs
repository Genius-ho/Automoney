// Fields Codex must never guess -- always null/unresolved unless a source
// document states them verbatim. Enforced by prompt instructions; the
// validator here can only check structure, not truthfulness, so this list
// exists mainly to keep the prompt text and any future policy checks in
// one place instead of duplicated inline strings.
export const NEVER_GUESS_FIELDS = [
  'KC 인증',
  '법적 인증',
  '제조국',
  '제조사',
  '배터리 및 안전 관련 정보',
  '원산지',
];

// Fields Automoney's own seller-config supplies -- Codex is never asked for
// these and must not be prompted to decide them per product.
export const SELLER_FIXED_FIELDS = [
  'brand', 'manufacturerFallback', 'outboundShippingPlace', 'returnCenter',
  'deliveryCompany', 'remoteAreaDeliverable', 'salePrice', 'stockQuantity',
  'sellerContact', 'asPhoneNumber', 'consumerServicePhoneNumber',
  'r2Config', 'requested', 'sellerProductId',
];

export const CONFIDENCE_THRESHOLDS = { autoCandidate: 0.9, needsReview: 0.7 };

export function classifyConfidence(confidence) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 'unresolved';
  if (confidence >= CONFIDENCE_THRESHOLDS.autoCandidate) return 'auto_candidate';
  if (confidence >= CONFIDENCE_THRESHOLDS.needsReview) return 'needs_review';
  return 'unresolved';
}

const SINGLE_VALUE_FIELDS = ['material', 'dimensions', 'manufacturer', 'countryOfOrigin', 'handlingPrecautions'];
const MULTI_VALUE_FIELDS = ['colors', 'components'];

function isEvidenceItem(item, path, errors) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of ['sourceFile', 'quote', 'rawJsonPath']) {
    if (item[key] !== null && typeof item[key] !== 'string') errors.push(`${path}.${key} must be a string or null`);
  }
  if (item.sliceIndex !== null && !Number.isInteger(item.sliceIndex)) errors.push(`${path}.sliceIndex must be an integer or null`);
  const allowedKeys = new Set(['sourceFile', 'sliceIndex', 'quote', 'rawJsonPath']);
  for (const key of Object.keys(item)) if (!allowedKeys.has(key)) errors.push(`${path} has unexpected field "${key}"`);
}

function checkConfidenceAndEvidence(field, path, errors) {
  if (typeof field.confidence !== 'number' || field.confidence < 0 || field.confidence > 1) {
    errors.push(`${path}.confidence must be a number between 0 and 1`);
  }
  if (!Array.isArray(field.evidence)) {
    errors.push(`${path}.evidence must be an array`);
  } else {
    field.evidence.forEach((item, index) => isEvidenceItem(item, `${path}.evidence[${index}]`, errors));
  }
  // A confidence above "unresolved" without any evidence is a policy
  // violation, not just a shape problem -- confidence has to come from
  // something citable (spec section 4/6).
  if (typeof field.confidence === 'number' && field.confidence >= CONFIDENCE_THRESHOLDS.needsReview && Array.isArray(field.evidence) && field.evidence.length === 0) {
    errors.push(`${path} has confidence >= ${CONFIDENCE_THRESHOLDS.needsReview} but no evidence`);
  }
}

// Hand-rolled on purpose (no new JSON-Schema-validator dependency) -- mirrors
// schemas/product-analysis.schema.json field-for-field, plus the one rule a
// generic JSON Schema can't express: non-trivial confidence requires
// evidence. Codex's own --output-schema already constrains the shape at
// generation time; this is the independent, un-trusting second check this
// codebase's "결과 JSON 검증" requirement calls for.
export function validateProductAnalysis(value) {
  const errors = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: ['result must be a JSON object'] };
  }

  const requiredTopLevel = [...SINGLE_VALUE_FIELDS, ...MULTI_VALUE_FIELDS, 'searchTags', 'coupangTitleCandidate', 'unresolvedFields'];
  for (const key of requiredTopLevel) if (!(key in value)) errors.push(`missing required top-level field "${key}"`);
  for (const key of Object.keys(value)) if (!requiredTopLevel.includes(key)) errors.push(`unexpected top-level field "${key}"`);

  for (const key of SINGLE_VALUE_FIELDS) {
    const field = value[key];
    if (typeof field !== 'object' || field === null) { errors.push(`${key} must be an object`); continue; }
    if (field.value !== null && typeof field.value !== 'string') errors.push(`${key}.value must be a string or null`);
    checkConfidenceAndEvidence(field, key, errors);
  }

  for (const key of MULTI_VALUE_FIELDS) {
    const field = value[key];
    if (typeof field !== 'object' || field === null) { errors.push(`${key} must be an object`); continue; }
    if (!Array.isArray(field.values) || field.values.some((v) => typeof v !== 'string')) errors.push(`${key}.values must be an array of strings`);
    checkConfidenceAndEvidence(field, key, errors);
  }

  if (!Array.isArray(value.searchTags) || value.searchTags.some((v) => typeof v !== 'string')) errors.push('searchTags must be an array of strings');
  if (value.coupangTitleCandidate !== null && typeof value.coupangTitleCandidate !== 'string') errors.push('coupangTitleCandidate must be a string or null');
  if (!Array.isArray(value.unresolvedFields) || value.unresolvedFields.some((v) => typeof v !== 'string')) errors.push('unresolvedFields must be an array of strings');

  return { valid: errors.length === 0, errors };
}

// Builds the actual instruction text sent to Codex over stdin. Encodes spec
// sections 4-6: cite evidence, never guess the listed fields, respect
// source priority, and never invent seller-fixed settings.
export function buildAnalysisPrompt({ productSummary, rawJsonExcerpt, imageCount }) {
  return [
    '너는 한국 이커머스 상품 등록을 돕는 분석 보조 도구다. 입력으로 주어진 원본 텍스트와 첨부된 상세페이지 이미지만 근거로 사용해라.',
    '',
    '=== 분석 우선순위 (반드시 이 순서로 확인) ===',
    '1. 도매매 raw_json과 API 필드',
    '2. 기존 HTML 텍스트',
    '3. (Python OCR 결과는 이번 단계에는 제공되지 않음)',
    '4. 첨부된 상세페이지 이미지 (텍스트/그래픽 판독)',
    '5. 그래도 확인 불가능한 항목은 null로 두고 unresolvedFields에 기록',
    '',
    '=== 절대 추정 금지 (원문/이미지에 명시된 문구가 없으면 반드시 null) ===',
    ...NEVER_GUESS_FIELDS.map((f) => `- ${f}`),
    '',
    '=== confidence 기준 ===',
    `- ${CONFIDENCE_THRESHOLDS.autoCandidate} 이상: 근거가 명확한 자동 입력 후보`,
    `- ${CONFIDENCE_THRESHOLDS.needsReview}~${CONFIDENCE_THRESHOLDS.autoCandidate} 미만: 사용자 확인 필요`,
    `- ${CONFIDENCE_THRESHOLDS.needsReview} 미만 또는 근거 없음: 미확정(value/values는 null 또는 빈 배열, confidence는 낮게)`,
    '- confidence가 0.7 이상인데 evidence가 비어 있으면 안 된다. 반드시 근거를 evidence에 남겨라.',
    '',
    '=== evidence 기록 규칙 ===',
    '각 evidence 항목에는 가능한 만큼 채워라: sourceFile(파일명), sliceIndex(이미지 순번, 정수 또는 null), quote(실제 확인한 문구, 원문 그대로), rawJsonPath(raw_json 내 필드 경로, 예: domeggook.detail.size).',
    '이미지에서 확인한 경우 sourceFile과 sliceIndex를 채우고 quote에 이미지에서 읽은 문구를 적어라. raw_json에서 확인한 경우 rawJsonPath를 채워라.',
    '',
    '=== 여러 출처가 서로 다른 값을 말하면 ===',
    '자동으로 하나를 확정하지 말고 confidence를 0.7 미만으로 낮추고 unresolvedFields에 그 필드명을 추가해라.',
    '',
    '=== 절대 다루지 않는 값 (판매자 설정값이므로 결과에 포함하지 마라) ===',
    ...SELLER_FIXED_FIELDS.map((f) => `- ${f}`),
    '',
    `=== 입력 요약 ===`,
    `상품 요약: ${productSummary}`,
    `원본 raw_json 발췌: ${rawJsonExcerpt}`,
    `첨부 이미지 개수: ${imageCount}장 (각 이미지는 첨부 순서대로 1부터 sliceIndex 번호를 매겨 evidence에 사용해라)`,
    '',
    '=== 출력 ===',
    '반드시 주어진 JSON Schema를 그대로 따르는 JSON 객체 하나만 출력해라. 다른 설명 텍스트는 출력하지 마라.',
  ].join('\n');
}
