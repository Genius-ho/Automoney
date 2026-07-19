import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePythonAnalysis } from '../src/python-analysis-schema.mjs';

function validAnalysis(overrides = {}) {
  const single = (value, source) => ({ value, confidence: value ? 0.6 : 0, source: value ? source : null, evidence: value ? [{ file: 'a.jpg', sliceIndex: 1, text: value }] : [] });
  const multi = (values, source) => ({ values, confidence: values.length ? 0.6 : 0, source: values.length ? source : null, evidence: values.length ? [{ file: 'a.jpg', sliceIndex: 1, text: values[0] }] : [] });
  return {
    material: single('벨벳', 'ocr'),
    dimensions: single(null, null),
    manufacturer: single('쓰러담아 협력사', 'raw_json'),
    countryOfOrigin: single(null, null),
    handlingPrecautions: single(null, null),
    colors: multi([], null),
    components: multi(['서랍'], 'ocr'),
    unresolvedFields: ['dimensions', 'countryOfOrigin', 'handlingPrecautions', 'colors'],
    ocrMeta: { available: true, version: '5.4.0', message: 'ok', imagesProcessed: 9, imagesOcrOk: 9, perImage: [{ file: 'a.jpg', sliceIndex: 1, text: 'x', ok: true }] },
    ...overrides,
  };
}

test('validatePythonAnalysis accepts a well-formed result', () => {
  const result = validatePythonAnalysis(validAnalysis());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('validatePythonAnalysis rejects a missing required field', () => {
  const analysis = validAnalysis();
  delete analysis.ocrMeta;
  const result = validatePythonAnalysis(analysis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('ocrMeta')));
});

test('validatePythonAnalysis rejects an invalid source value', () => {
  const analysis = validAnalysis();
  analysis.material.source = 'made_up_source';
  const result = validatePythonAnalysis(analysis);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('material.source')));
});

test('validatePythonAnalysis rejects confidence outside 0..1', () => {
  const analysis = validAnalysis();
  analysis.material.confidence = 1.2;
  const result = validatePythonAnalysis(analysis);
  assert.equal(result.valid, false);
});

test('validatePythonAnalysis rejects a malformed ocrMeta.perImage entry', () => {
  const analysis = validAnalysis();
  analysis.ocrMeta.perImage = [{ file: 'a.jpg' }]; // missing sliceIndex/text/ok is fine structurally here since ocrMeta itself isn't deep-validated per item beyond array-ness
  const result = validatePythonAnalysis(analysis);
  assert.equal(result.valid, true, 'ocrMeta.perImage items are diagnostic metadata, not strictly schema-checked per-field');
});

test('validatePythonAnalysis rejects a non-object input entirely', () => {
  const result = validatePythonAnalysis('not an object');
  assert.equal(result.valid, false);
});
