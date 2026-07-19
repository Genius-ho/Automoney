const SINGLE_VALUE_FIELDS = ['material', 'dimensions', 'manufacturer', 'countryOfOrigin', 'handlingPrecautions'];
const MULTI_VALUE_FIELDS = ['colors', 'components'];

function normalizeForCompare(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

// Codex tends to write full descriptive phrases ("아크릴 케이스, 벨벳 마감")
// while Python's OCR/keyword pass finds bare terms ("벨벳"). That's
// corroboration, not disagreement -- treat either value containing the
// other (once whitespace/case-normalized) as a match rather than a
// conflict.
function valuesAgree(a, b) {
  const normA = normalizeForCompare(a);
  const normB = normalizeForCompare(b);
  if (!normA || !normB) return false;
  return normA === normB || normA.includes(normB) || normB.includes(normA);
}

function round2(value) { return Math.round(value * 100) / 100; }

function emptySingle() { return { value: null, confidence: 0, evidence: [] }; }
function emptyMulti() { return { values: [], confidence: 0, evidence: [] }; }

// Codex's evidence items use {sourceFile, sliceIndex, quote, rawJsonPath};
// Python's use {file, sliceIndex, text}. Merged evidence keeps both shapes
// as-is, tagged with which engine produced them, rather than forcing one
// shape and losing information.
function tagEvidence(evidence, engine) {
  return (evidence || []).map((item) => ({ engine, ...item }));
}

function mergeSingleField(key, codexField, pythonField, conflicts) {
  const codexHas = codexField?.value != null && String(codexField.value).trim() !== '';
  const pythonHas = pythonField?.value != null && String(pythonField.value).trim() !== '';
  const codexEvidence = tagEvidence(codexField?.evidence, 'codex');
  const pythonEvidence = tagEvidence(pythonField?.evidence, 'python');

  if (!codexHas && !pythonHas) return { ...emptySingle(), sources: [] };
  if (codexHas && !pythonHas) return { value: codexField.value, confidence: codexField.confidence, evidence: codexEvidence, sources: ['codex'] };
  if (!codexHas && pythonHas) return { value: pythonField.value, confidence: pythonField.confidence, evidence: pythonEvidence, sources: [pythonField.source || 'python'] };

  const sameValue = valuesAgree(codexField.value, pythonField.value);
  if (sameValue) {
    return {
      value: codexField.value,
      confidence: round2(Math.min(0.99, Math.max(codexField.confidence, pythonField.confidence) + 0.05)),
      evidence: [...codexEvidence, ...pythonEvidence],
      sources: ['codex', pythonField.source || 'python'],
    };
  }

  conflicts.push({
    field: key,
    candidates: [
      { source: 'codex', value: codexField.value, confidence: codexField.confidence },
      { source: pythonField.source || 'python', value: pythonField.value, confidence: pythonField.confidence },
    ],
  });
  return { value: null, confidence: 0, evidence: [...codexEvidence, ...pythonEvidence], sources: [], conflict: true };
}

function mergeMultiField(key, codexField, pythonField, conflicts) {
  const codexValues = Array.isArray(codexField?.values) ? codexField.values : [];
  const pythonValues = Array.isArray(pythonField?.values) ? pythonField.values : [];
  const codexEvidence = tagEvidence(codexField?.evidence, 'codex');
  const pythonEvidence = tagEvidence(pythonField?.evidence, 'python');

  if (codexValues.length === 0 && pythonValues.length === 0) return { ...emptyMulti(), sources: [] };

  // Multi-value fields are naturally additive (colors/components a product
  // has are a set, not a single fact to arbitrate) -- union them rather
  // than treating a partial-overlap as a conflict. A field only becomes a
  // real conflict if one engine found values and the other found a
  // completely disjoint, non-empty set for the same field (suggesting one
  // of them misread the image entirely).
  const overlaps = codexValues.length === 0 || pythonValues.length === 0
    || codexValues.some((c) => pythonValues.some((p) => valuesAgree(c, p)));

  if (!overlaps) {
    conflicts.push({
      field: key,
      candidates: [
        { source: 'codex', value: codexValues, confidence: codexField.confidence },
        { source: pythonField.source || 'python', value: pythonValues, confidence: pythonField.confidence },
      ],
    });
  }

  const union = [...new Set([...codexValues, ...pythonValues])];
  return {
    values: union,
    confidence: round2(Math.min(0.99, Math.max(codexField?.confidence || 0, pythonField?.confidence || 0) + (overlaps && codexValues.length && pythonValues.length ? 0.05 : 0))),
    evidence: [...codexEvidence, ...pythonEvidence],
    sources: [...new Set([codexValues.length ? 'codex' : null, pythonValues.length ? (pythonField.source || 'python') : null].filter(Boolean))],
    conflict: !overlaps,
  };
}

// Combines stage 1's Codex analysis with the Python worker's OCR/raw_json/
// html candidates into one result. Per spec section 5: never overwrite by
// priority alone -- compare value + confidence + evidence for every field,
// only auto-merge when both engines actually agree, and record disagreement
// in `conflicts` rather than silently picking a winner.
export function mergeAnalysis({ codexAnalysis, pythonAnalysis }) {
  const conflicts = [];
  const merged = {};

  for (const key of SINGLE_VALUE_FIELDS) {
    merged[key] = mergeSingleField(key, codexAnalysis?.[key] || emptySingle(), pythonAnalysis?.[key] || { ...emptySingle(), source: null }, conflicts);
  }
  for (const key of MULTI_VALUE_FIELDS) {
    merged[key] = mergeMultiField(key, codexAnalysis?.[key] || emptyMulti(), pythonAnalysis?.[key] || { ...emptyMulti(), source: null }, conflicts);
  }

  // Python doesn't produce these -- Codex is the only source, passed through.
  merged.searchTags = codexAnalysis?.searchTags || [];
  merged.coupangTitleCandidate = codexAnalysis?.coupangTitleCandidate ?? null;

  // Deliberately NOT seeded from codexAnalysis.unresolvedFields/
  // pythonAnalysis.unresolvedFields -- those reflect each engine's own,
  // now-stale confidence before merging (e.g. Python alone was unsure about
  // "벨벳" at 0.65, but agreeing with Codex's independent read boosts the
  // merged confidence well past the threshold). Unresolved status is
  // recomputed here purely from the merged field's own confidence/conflict.
  const unresolvedFields = new Set();
  for (const key of [...SINGLE_VALUE_FIELDS, ...MULTI_VALUE_FIELDS]) {
    const field = merged[key];
    const isEmpty = 'value' in field ? field.value == null : field.values.length === 0;
    if (field.conflict || field.confidence < 0.7 || isEmpty) unresolvedFields.add(key);
  }

  merged.unresolvedFields = [...unresolvedFields];
  merged.conflicts = conflicts;
  return merged;
}
