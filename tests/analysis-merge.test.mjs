import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeAnalysis } from '../src/analysis-merge.mjs';

function codexField(value, confidence, evidence = []) { return { value, confidence, evidence }; }
function codexMulti(values, confidence, evidence = []) { return { values, confidence, evidence }; }
function pyField(value, confidence, source, evidence = []) { return { value, confidence, source, evidence }; }
function pyMulti(values, confidence, source, evidence = []) { return { values, confidence, source, evidence }; }

test('mergeAnalysis boosts confidence and combines evidence when both engines agree on the same value', () => {
  const codexAnalysis = { material: codexField('아크릴 케이스, 벨벳 마감', 0.94, [{ sourceFile: 's1.jpg', sliceIndex: 1, quote: '아크릴', rawJsonPath: null }]) };
  const pythonAnalysis = { material: pyField('벨벳', 0.65, 'ocr', [{ file: 's5.jpg', sliceIndex: 5, text: '벨벳' }]) };
  const merged = mergeAnalysis({ codexAnalysis, pythonAnalysis });
  assert.equal(merged.material.value, '아크릴 케이스, 벨벳 마감');
  assert.ok(merged.material.confidence > 0.94, 'agreement should boost confidence above either engine alone');
  assert.equal(merged.material.evidence.length, 2, 'evidence from both engines must be preserved, not just the winning one');
  assert.deepEqual(merged.material.sources, ['codex', 'ocr']);
  assert.equal(merged.material.conflict, undefined);
});

test('mergeAnalysis records a conflicts entry and leaves the field unresolved when values genuinely disagree', () => {
  const codexAnalysis = { dimensions: codexField('23.5cm x 13.5cm x 10.5cm', 0.98) };
  const pythonAnalysis = { dimensions: pyField('23.5cm x 13.5cm x 05~100cm', 0.6, 'ocr') };
  const merged = mergeAnalysis({ codexAnalysis, pythonAnalysis });
  assert.equal(merged.dimensions.value, null, 'a genuine disagreement must not be auto-resolved to either candidate');
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].field, 'dimensions');
  assert.equal(merged.conflicts[0].candidates.length, 2);
  assert.ok(merged.unresolvedFields.includes('dimensions'));
});

test('mergeAnalysis unions multi-value fields (colors/components) rather than treating partial overlap as conflict', () => {
  const codexAnalysis = { components: codexMulti(['3단 서랍형 보석함', '벨벳 서랍 내장'], 0.97) };
  const pythonAnalysis = { components: pyMulti(['서랍', '손잡이'], 0.55, 'ocr') };
  const merged = mergeAnalysis({ codexAnalysis, pythonAnalysis });
  assert.deepEqual(merged.components.values, ['3단 서랍형 보석함', '벨벳 서랍 내장', '서랍', '손잡이']);
  assert.equal(merged.components.conflict, false);
  assert.ok(!merged.unresolvedFields.includes('components'));
});

test('mergeAnalysis flags a genuine multi-value conflict when the two engines found completely disjoint, non-empty sets', () => {
  const codexAnalysis = { colors: codexMulti(['베이지', '그레이'], 0.9) };
  const pythonAnalysis = { colors: pyMulti(['블랙', '레드'], 0.6, 'ocr') };
  const merged = mergeAnalysis({ codexAnalysis, pythonAnalysis });
  assert.equal(merged.colors.conflict, true);
  assert.equal(merged.conflicts.some((c) => c.field === 'colors'), true);
});

test('mergeAnalysis prefers whichever engine actually has a value when the other is empty', () => {
  const codexAnalysis = { manufacturer: codexField(null, 0) };
  const pythonAnalysis = { manufacturer: pyField('쓰러담아 협력사', 0.95, 'raw_json') };
  const merged = mergeAnalysis({ codexAnalysis, pythonAnalysis });
  assert.equal(merged.manufacturer.value, '쓰러담아 협력사');
  assert.equal(merged.manufacturer.confidence, 0.95);
  assert.deepEqual(merged.manufacturer.sources, ['raw_json']);
});

test('mergeAnalysis with no pythonAnalysis (null) preserves the existing Codex result unchanged -- Python failure must not lose or corrupt it', () => {
  const codexAnalysis = {
    material: codexField('아크릴 케이스, 벨벳 마감', 0.94),
    dimensions: codexField('23.5cm x 13.5cm x 10.5cm', 0.98),
    colors: codexMulti(['베이지', '그레이', '투명'], 0.96),
    searchTags: ['주얼리함'],
    coupangTitleCandidate: '3단 아크릴 벨벳 주얼리 보석함',
  };
  const merged = mergeAnalysis({ codexAnalysis, pythonAnalysis: null });
  assert.equal(merged.material.value, '아크릴 케이스, 벨벳 마감');
  assert.equal(merged.material.confidence, 0.94);
  assert.equal(merged.dimensions.value, '23.5cm x 13.5cm x 10.5cm');
  assert.deepEqual(merged.colors.values, ['베이지', '그레이', '투명']);
  assert.deepEqual(merged.searchTags, ['주얼리함']);
  assert.equal(merged.coupangTitleCandidate, '3단 아크릴 벨벳 주얼리 보석함');
  assert.equal(merged.conflicts.length, 0);
});

// Fixture values are the actual results this codebase produced running the
// real pipeline against draft 64 on 2026-07-19 (npm run analyze:product --
// draft=64), trimmed to the fields under regression here.
test('mergeAnalysis reproduces the draft 64 expected result: 아크릴/벨벳, 23.5x13.5x10.5cm, 베이지/그레이', () => {
  const codexAnalysis = {
    material: codexField('아크릴 케이스, 벨벳 마감', 0.94, [
      { sourceFile: 'detail-3369-slice-001.jpg', sliceIndex: 1, quote: '투명한 아크릴 케이스로 깔끔한 정리가 가능한 3단 서랍 보석함입니다.', rawJsonPath: null },
      { sourceFile: 'detail-3369-slice-005.jpg', sliceIndex: 5, quote: '서랍 전체 벨벳원단으로 제작되어 고급스러운 느낌을 줍니다.', rawJsonPath: null },
    ]),
    dimensions: codexField('23.5cm x 13.5cm x 10.5cm', 0.98, [
      { sourceFile: 'detail-3369-slice-009.jpg', sliceIndex: 9, quote: '23.5cm / 13.5cm / 10.5cm', rawJsonPath: null },
    ]),
    colors: codexMulti(['베이지', '그레이', '투명'], 0.96, [
      { sourceFile: 'detail-3369-slice-009.jpg', sliceIndex: 9, quote: '베이지', rawJsonPath: null },
      { sourceFile: 'detail-3369-slice-009.jpg', sliceIndex: 9, quote: '그레이', rawJsonPath: null },
    ]),
    manufacturer: codexField(null, 0),
    countryOfOrigin: codexField(null, 0),
    handlingPrecautions: codexField('재는 위치에 따라 0.5~1cm 오차가 있을 수 있습니다.', 0.95, [
      { sourceFile: 'detail-3369-slice-009.jpg', sliceIndex: 9, quote: '※재는 위치에 따라 0.5~1cm 오차가 있을 수 있습니다※', rawJsonPath: null },
    ]),
    components: codexMulti(['3단 서랍형 보석함', '아크릴 상단 케이스', '벨벳 서랍 내장', '칸막이 트레이', '반지 수납 홈', '크리스탈 손잡이'], 0.97),
    unresolvedFields: ['manufacturer', 'countryOfOrigin'],
  };
  const pythonAnalysis = {
    material: pyField('벨벳', 0.65, 'ocr', [
      { file: 'detail-3369-slice-001.jpg', sliceIndex: 1, text: '벨벳' },
      { file: 'detail-3369-slice-005.jpg', sliceIndex: 5, text: '벨벳' },
    ]),
    dimensions: pyField(null, 0, null),
    manufacturer: pyField('쓰러담아 협력사', 0.95, 'raw_json', [{ file: null, sliceIndex: null, text: 'domeggook.detail.manufacturer=쓰러담아 협력사' }]),
    countryOfOrigin: pyField('수입산_아시아_중국', 0.95, 'raw_json'),
    handlingPrecautions: pyField('※재는위치에따라05~100오차가있을수있습니다※', 0.55, 'ocr', [
      { file: 'detail-3369-slice-009.jpg', sliceIndex: 9, text: '※재는위치에따라05~100오차가있을수있습니다※' },
    ]),
    colors: pyMulti([], 0, null),
    components: pyMulti(['서랍', '손잡이'], 0.55, 'ocr'),
    unresolvedFields: ['material', 'dimensions', 'colors', 'components', 'handlingPrecautions'],
  };

  const merged = mergeAnalysis({ codexAnalysis, pythonAnalysis });

  assert.ok(merged.material.value.includes('아크릴') && merged.material.value.includes('벨벳'));
  const materialSliceIndexes = merged.material.evidence.map((e) => e.sliceIndex);
  assert.ok(materialSliceIndexes.includes(1), 'must retain slice-001 acrylic evidence');
  assert.ok(materialSliceIndexes.includes(5), 'must retain slice-005 velvet evidence');

  assert.equal(merged.dimensions.value, '23.5cm x 13.5cm x 10.5cm');
  const dimensionSliceIndexes = merged.dimensions.evidence.map((e) => e.sliceIndex);
  assert.ok(dimensionSliceIndexes.includes(9), 'must retain slice-009 measurement evidence');

  assert.ok(merged.colors.values.includes('베이지'));
  assert.ok(merged.colors.values.includes('그레이'));

  // manufacturer/countryOfOrigin come from raw_json (a real cited source),
  // not a guess -- Codex correctly abstained and Python's structured-field
  // read fills them in with full provenance.
  assert.equal(merged.manufacturer.value, '쓰러담아 협력사');
  assert.equal(merged.manufacturer.sources[0], 'raw_json');

  // The one genuine OCR-vs-Codex mismatch (digit misread "0.5~1cm" -> OCR
  // "05~100") must surface as a conflict, not be silently papered over.
  assert.ok(merged.conflicts.some((c) => c.field === 'handlingPrecautions'));
  assert.ok(merged.unresolvedFields.includes('handlingPrecautions'));
});
