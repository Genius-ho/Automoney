import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIDENCE_THRESHOLDS,
  NEVER_GUESS_FIELDS,
  SELLER_FIXED_FIELDS,
  buildAnalysisPrompt,
  classifyConfidence,
  validateProductAnalysis,
} from '../src/product-analysis-schema.mjs';

function validAnalysis(overrides = {}) {
  const fieldWithValue = (value, confidence) => ({ value, confidence, evidence: value ? [{ sourceFile: 'a.jpg', sliceIndex: 1, quote: value, rawJsonPath: null }] : [] });
  const fieldWithValues = (values, confidence) => ({ values, confidence, evidence: values.length ? [{ sourceFile: 'a.jpg', sliceIndex: 1, quote: values[0], rawJsonPath: null }] : [] });
  return {
    material: fieldWithValue('아크릴, 벨벳', 0.94),
    dimensions: fieldWithValue('23.5 x 13.5 x 10.5cm', 0.98),
    colors: fieldWithValues(['베이지', '그레이'], 0.96),
    components: fieldWithValues(['서랍'], 0.9),
    manufacturer: fieldWithValue(null, 0),
    countryOfOrigin: fieldWithValue(null, 0),
    handlingPrecautions: fieldWithValue(null, 0),
    searchTags: ['주얼리함'],
    coupangTitleCandidate: '주얼리함',
    unresolvedFields: ['manufacturer', 'countryOfOrigin'],
    ...overrides,
  };
}

test('classifyConfidence buckets by the documented thresholds', () => {
  assert.equal(classifyConfidence(0.9), 'auto_candidate');
  assert.equal(classifyConfidence(0.95), 'auto_candidate');
  assert.equal(classifyConfidence(0.89), 'needs_review');
  assert.equal(classifyConfidence(0.7), 'needs_review');
  assert.equal(classifyConfidence(0.69), 'unresolved');
  assert.equal(classifyConfidence(0), 'unresolved');
  assert.equal(classifyConfidence(null), 'unresolved');
  assert.equal(CONFIDENCE_THRESHOLDS.autoCandidate, 0.9);
  assert.equal(CONFIDENCE_THRESHOLDS.needsReview, 0.7);
});

test('validateProductAnalysis accepts a well-formed result', () => {
  const result = validateProductAnalysis(validAnalysis());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('validateProductAnalysis rejects a missing required field', () => {
  const analysis = validAnalysis();
  delete analysis.dimensions;
  const result = validateProductAnalysis(analysis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('dimensions')));
});

test('validateProductAnalysis rejects an unexpected top-level field (no silent extra fields like seller-fixed settings)', () => {
  const analysis = validAnalysis({ salePrice: 20930 });
  const result = validateProductAnalysis(analysis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('salePrice')));
});

test('validateProductAnalysis rejects confidence outside 0..1', () => {
  const analysis = validAnalysis();
  analysis.material.confidence = 1.5;
  const result = validateProductAnalysis(analysis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('material.confidence')));
});

test('validateProductAnalysis rejects confidence >= 0.7 with no evidence (a value cannot be trusted without a citation)', () => {
  const analysis = validAnalysis();
  analysis.material = { value: '아크릴', confidence: 0.8, evidence: [] };
  const result = validateProductAnalysis(analysis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('material') && e.includes('no evidence')));
});

test('validateProductAnalysis allows low confidence with no evidence (unresolved fields)', () => {
  const analysis = validAnalysis();
  analysis.manufacturer = { value: null, confidence: 0, evidence: [] };
  const result = validateProductAnalysis(analysis);
  assert.equal(result.valid, true);
});

test('validateProductAnalysis rejects a malformed evidence item', () => {
  const analysis = validAnalysis();
  analysis.dimensions.evidence = [{ sourceFile: 'x.jpg', sliceIndex: 'not-a-number', quote: 'q', rawJsonPath: null }];
  const result = validateProductAnalysis(analysis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('sliceIndex')));
});

test('buildAnalysisPrompt includes the never-guess and seller-fixed field lists so the model sees them every time', () => {
  const prompt = buildAnalysisPrompt({ productSummary: '{}', rawJsonExcerpt: '{}', imageCount: 9 });
  for (const field of NEVER_GUESS_FIELDS) assert.ok(prompt.includes(field), `missing never-guess field: ${field}`);
  for (const field of SELLER_FIXED_FIELDS) assert.ok(prompt.includes(field), `missing seller-fixed field: ${field}`);
  assert.ok(prompt.includes('9장'));
});
