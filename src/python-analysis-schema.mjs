const SINGLE_VALUE_FIELDS = ['material', 'dimensions', 'manufacturer', 'countryOfOrigin', 'handlingPrecautions'];
const MULTI_VALUE_FIELDS = ['colors', 'components'];
const VALID_SOURCES = new Set(['raw_json', 'html', 'ocr', null]);

function checkEvidenceItem(item, path, errors) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (item.file !== null && typeof item.file !== 'string') errors.push(`${path}.file must be a string or null`);
  if (item.sliceIndex !== null && !Number.isInteger(item.sliceIndex)) errors.push(`${path}.sliceIndex must be an integer or null`);
  if (item.text !== null && typeof item.text !== 'string') errors.push(`${path}.text must be a string or null`);
  const allowed = new Set(['file', 'sliceIndex', 'text']);
  for (const key of Object.keys(item)) if (!allowed.has(key)) errors.push(`${path} has unexpected field "${key}"`);
}

function checkFieldCommon(field, path, errors) {
  if (typeof field.confidence !== 'number' || field.confidence < 0 || field.confidence > 1) {
    errors.push(`${path}.confidence must be a number between 0 and 1`);
  }
  if (!VALID_SOURCES.has(field.source)) errors.push(`${path}.source must be one of raw_json/html/ocr/null`);
  if (!Array.isArray(field.evidence)) errors.push(`${path}.evidence must be an array`);
  else field.evidence.forEach((item, index) => checkEvidenceItem(item, `${path}.evidence[${index}]`, errors));
}

// Hand-rolled on purpose (no new JSON-Schema-validator dependency), mirroring
// workers/python/schemas/python-analysis.schema.json field-for-field --
// same independent-second-check philosophy as stage 1's
// validateProductAnalysis. Trusts nothing the Python process printed until
// this passes.
export function validatePythonAnalysis(value) {
  const errors = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: ['result must be a JSON object'] };
  }

  const requiredTopLevel = [...SINGLE_VALUE_FIELDS, ...MULTI_VALUE_FIELDS, 'unresolvedFields', 'ocrMeta'];
  for (const key of requiredTopLevel) if (!(key in value)) errors.push(`missing required top-level field "${key}"`);
  for (const key of Object.keys(value)) if (!requiredTopLevel.includes(key)) errors.push(`unexpected top-level field "${key}"`);

  for (const key of SINGLE_VALUE_FIELDS) {
    const field = value[key];
    if (typeof field !== 'object' || field === null) { errors.push(`${key} must be an object`); continue; }
    if (field.value !== null && typeof field.value !== 'string') errors.push(`${key}.value must be a string or null`);
    checkFieldCommon(field, key, errors);
  }

  for (const key of MULTI_VALUE_FIELDS) {
    const field = value[key];
    if (typeof field !== 'object' || field === null) { errors.push(`${key} must be an object`); continue; }
    if (!Array.isArray(field.values) || field.values.some((v) => typeof v !== 'string')) errors.push(`${key}.values must be an array of strings`);
    checkFieldCommon(field, key, errors);
  }

  if (!Array.isArray(value.unresolvedFields) || value.unresolvedFields.some((v) => typeof v !== 'string')) {
    errors.push('unresolvedFields must be an array of strings');
  }

  const meta = value.ocrMeta;
  if (typeof meta !== 'object' || meta === null) {
    errors.push('ocrMeta must be an object');
  } else {
    if (typeof meta.available !== 'boolean') errors.push('ocrMeta.available must be a boolean');
    if (!Array.isArray(meta.perImage)) errors.push('ocrMeta.perImage must be an array');
  }

  return { valid: errors.length === 0, errors };
}
