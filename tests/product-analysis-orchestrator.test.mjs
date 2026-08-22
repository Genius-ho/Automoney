import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyProductAnalysis,
  buildApplyPreview,
  getAppliedAnalysis,
  getLatestAnalysisRun,
  listAnalysisRuns,
  runProductAnalysis,
  splitColorCandidates,
} from '../src/product-analysis-orchestrator.mjs';

// In-memory stand-in for the two new tables, following this codebase's
// existing "sql.includes(...) + call recording" mock style (see
// tests/postgres-store.test.mjs) rather than a real Postgres connection --
// no test in this repo touches a live DB.
function makeFakeDb() {
  const runs = [];
  let appliedRow = null;
  let nextId = 1;
  const calls = [];

  function applyDynamicSet(sql, params, row) {
    const setClause = /set (.+) where/is.exec(sql)[1];
    const fields = setClause.split(',').map((part) => part.trim().split('=')[0].trim()).filter((f) => f !== 'finished_at');
    fields.forEach((field, index) => { row[field] = params[index + 1]; });
    row.finished_at = new Date().toISOString();
  }

  return {
    calls,
    runs,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const s = sql.trim();

      if (s.startsWith('insert into product_analysis_runs')) {
        const draftId = params[0];
        const maxRun = runs.filter((r) => r.product_draft_id === draftId).reduce((max, r) => Math.max(max, r.run_number), 0);
        const row = {
          id: nextId++, product_draft_id: draftId, run_number: maxRun + 1,
          status: 'running', python_status: 'skipped', python_error_code: null, python_error_message: null,
          codex_status: 'pending', codex_error_code: null, codex_error_message: null,
          error_code: null, error_message: null,
          python_analysis_json: null, codex_analysis_json: null, merged_analysis_json: null,
          started_at: new Date().toISOString(), finished_at: null,
        };
        runs.push(row);
        return { rows: [row] };
      }
      if (s.startsWith('update product_analysis_runs')) {
        const row = runs.find((r) => r.id === params[0]);
        applyDynamicSet(s, params, row);
        return { rows: [row] };
      }
      if (s.includes('from product_analysis_runs where product_draft_id = $1 order by run_number desc limit 1')) {
        const list = runs.filter((r) => r.product_draft_id === params[0]).sort((a, b) => b.run_number - a.run_number);
        return { rows: list.slice(0, 1) };
      }
      if (s.includes('from product_analysis_runs where product_draft_id = $1 order by run_number desc')) {
        const list = runs.filter((r) => r.product_draft_id === params[0]).sort((a, b) => b.run_number - a.run_number);
        return { rows: list };
      }
      if (s.startsWith('select * from product_analysis_runs where id = $1 and product_draft_id = $2')) {
        const row = runs.find((r) => r.id === params[0] && r.product_draft_id === params[1]);
        return { rows: row ? [row] : [] };
      }
      if (s.startsWith('insert into product_analysis_applied')) {
        appliedRow = {
          product_draft_id: params[0], analysis_run_id: params[1], material: params[2], dimensions: params[3],
          manufacturer: params[4], country_of_origin: params[5], handling_precautions: params[6],
          sale_colors: JSON.parse(params[7]), appearance_traits: JSON.parse(params[8]), search_tags: JSON.parse(params[9]),
          applied_fields: JSON.parse(params[10]), applied_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        return { rows: [appliedRow] };
      }
      if (s.startsWith('select * from product_analysis_applied where product_draft_id = $1')) {
        return { rows: appliedRow ? [appliedRow] : [] };
      }
      if (s.startsWith('select * from product_drafts where id = $1')) {
        return { rows: [] };
      }
      throw new Error(`unhandled query in fake db: ${s}`);
    },
  };
}

const CODEX_SUCCESS = {
  material: { value: '아크릴, 벨벳', confidence: 0.86, evidence: [{ sourceFile: 'a.jpg', sliceIndex: 1, quote: '아크릴', rawJsonPath: null }] },
  dimensions: { value: '23.5cm x 13.5cm x 10.5cm', confidence: 0.98, evidence: [{ sourceFile: 'a.jpg', sliceIndex: 9, quote: '23.5cm', rawJsonPath: null }] },
  manufacturer: { value: null, confidence: 0, evidence: [] },
  countryOfOrigin: { value: null, confidence: 0, evidence: [] },
  handlingPrecautions: { value: null, confidence: 0, evidence: [] },
  colors: { values: ['베이지', '그레이', '투명'], confidence: 0.95, evidence: [{ sourceFile: 'a.jpg', sliceIndex: 9, quote: '베이지', rawJsonPath: null }] },
  components: { values: [], confidence: 0, evidence: [] },
  searchTags: ['주얼리보석함'],
  coupangTitleCandidate: null,
  unresolvedFields: [],
};

const PYTHON_SUCCESS = {
  material: { value: '벨벳', confidence: 0.65, source: 'ocr', evidence: [{ file: 'a.jpg', sliceIndex: 1, text: '벨벳' }] },
  dimensions: { value: null, confidence: 0, source: null, evidence: [] },
  manufacturer: { value: '쓰러담아 협력사', confidence: 0.95, source: 'raw_json', evidence: [{ file: null, sliceIndex: null, text: 'domeggook.detail.manufacturer=쓰러담아 협력사' }] },
  countryOfOrigin: { value: null, confidence: 0, source: null, evidence: [] },
  handlingPrecautions: { value: null, confidence: 0, source: null, evidence: [] },
  colors: { values: [], confidence: 0, source: null, evidence: [] },
  components: { values: [], confidence: 0, source: null, evidence: [] },
  unresolvedFields: [],
  ocrMeta: { available: true, perImage: [] },
};

function baseDeps({ codexAnalysis = CODEX_SUCCESS, pythonAnalysis = PYTHON_SUCCESS } = {}) {
  return {
    checkCodexAvailabilityImpl: async () => ({ available: true, loggedIn: true, version: '1.0', message: 'Logged in' }),
    checkPythonAvailabilityImpl: async () => ({ available: true, version: '3.12.0', message: 'Python 3.12.0' }),
    buildAnalysisInputPackageImpl: async () => ({
      paths: {
        root: 'job-root', rawJsonPath: 'job-root/input/raw.json', pythonLogPath: 'job-root/logs/python.log',
        pythonAnalysisPath: 'job-root/output/python-analysis.json', codexLogPath: 'job-root/logs/codex.log',
        codexAnalysisPath: 'job-root/output/codex-analysis.json', mergedAnalysisPath: 'job-root/output/merged-analysis.json',
      },
      productSummary: { id: 64 },
      detailImagePaths: ['job-root/input/detail-slices/a.jpg'],
    }),
    runPythonAnalysisImpl: async () => ({ success: true, analysis: pythonAnalysis, log: '', timedOut: false, exitCode: 0 }),
    runCodexAnalysisImpl: async () => ({ success: true, analysis: codexAnalysis, log: '', timedOut: false, exitCode: 0 }),
    // No real job folder exists on disk for these fake draft ids -- writes/reads
    // are stubbed the same way this codebase injects fetchImpl/spawnImpl
    // elsewhere, rather than mocking node:fs/promises's ESM exports (which
    // Node's test runner can't redefine).
    writeFileImpl: async () => {},
    readFileImpl: async () => '{}',
  };
}

test('runProductAnalysis on success merges Python+Codex and stores a success row, never touching disk paths outside the job folder', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({ db, rootDir: '/repo', draftId: 64, ...baseDeps() });
  assert.equal(run.status, 'success');
  assert.equal(run.runNumber, 1);
  assert.equal(run.pythonStatus, 'success');
  assert.equal(run.codexStatus, 'success');
  assert.equal(run.mergedAnalysis.material.value, '아크릴, 벨벳');
  assert.equal(run.mergedAnalysis.dimensions.value, '23.5cm x 13.5cm x 10.5cm');
  assert.deepEqual(run.mergedAnalysis.colors.values, ['베이지', '그레이', '투명']);
});

test('runProductAnalysis records a new run (never overwrites) on re-run, preserving history', async () => {
  const db = makeFakeDb();
  const first = await runProductAnalysis({ db, rootDir: '/repo', draftId: 64, ...baseDeps() });
  const second = await runProductAnalysis({ db, rootDir: '/repo', draftId: 64, ...baseDeps() });
  assert.equal(first.runNumber, 1);
  assert.equal(second.runNumber, 2);
  const history = await listAnalysisRuns(db, 64);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((r) => r.runNumber), [2, 1]);
});

test('runProductAnalysis fails fast with CODEX_NOT_AVAILABLE without ever calling Python or the job-package builder', async () => {
  const db = makeFakeDb();
  let pythonCalled = false;
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps(),
    checkCodexAvailabilityImpl: async () => ({ available: false, loggedIn: false, version: null, message: 'codex: command not found' }),
    checkPythonAvailabilityImpl: async () => { pythonCalled = true; return { available: true, version: '3.12.0', message: '' }; },
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, 'CODEX_NOT_AVAILABLE');
  assert.equal(pythonCalled, false);
});

test('runProductAnalysis distinguishes an expired/missing Codex login from Codex being uninstalled', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps(),
    checkCodexAvailabilityImpl: async () => ({ available: true, loggedIn: false, version: '1.0', message: 'Not logged in' }),
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, 'CODEX_LOGIN_REQUIRED');
});

test('runProductAnalysis reports NO_DETAIL_IMAGES and never invokes Codex/Python when the draft has no local detail images', async () => {
  const db = makeFakeDb();
  let codexCalled = false;
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps(),
    buildAnalysisInputPackageImpl: async () => ({ paths: {}, productSummary: {}, detailImagePaths: [] }),
    runCodexAnalysisImpl: async () => { codexCalled = true; return { success: true, analysis: CODEX_SUCCESS, log: '', timedOut: false }; },
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, 'NO_DETAIL_IMAGES');
  assert.equal(codexCalled, false);
});

test('runProductAnalysis proceeds Codex-only (non-fatal) when Python is not installed', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps(),
    checkPythonAvailabilityImpl: async () => ({ available: false, version: null, message: 'Windows Store stub' }),
  });
  assert.equal(run.status, 'success');
  assert.equal(run.pythonStatus, 'skipped');
  assert.equal(run.pythonErrorCode, 'PYTHON_NOT_AVAILABLE');
  assert.equal(run.codexStatus, 'success');
});

test('runProductAnalysis classifies a Codex timeout distinctly from a generic failure', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps(),
    runCodexAnalysisImpl: async () => ({ success: false, analysis: null, log: 'still running', timedOut: true, exitCode: null }),
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.codexErrorCode, 'CODEX_TIMEOUT');
});

test('runProductAnalysis classifies a Codex usage-limit message distinctly', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps(),
    runCodexAnalysisImpl: async () => ({ success: false, analysis: null, log: 'Error: usage limit reached for this plan', timedOut: false, exitCode: 1 }),
  });
  assert.equal(run.codexErrorCode, 'CODEX_RATE_LIMIT');
});

test('runProductAnalysis reports CODEX_INVALID_JSON when the schema validator rejects the result', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps({ codexAnalysis: { ...CODEX_SUCCESS, searchTags: 'not-an-array' } }),
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCode, 'CODEX_INVALID_JSON');
});

test('splitColorCandidates separates real sale-option colors from appearance/material traits and never invents a new option', () => {
  const colorsField = { values: ['베이지', '그레이', '투명'] };
  const draftOptions = [{ name: '주얼리 보석함', value: '베이지' }, { name: '주얼리 보석함', value: '그레이' }];
  const { saleColorCandidates, appearanceTraits } = splitColorCandidates(colorsField, draftOptions);
  assert.deepEqual(saleColorCandidates, ['베이지', '그레이']);
  assert.deepEqual(appearanceTraits, ['투명']);
});

test('buildApplyPreview blocks a legal field (manufacturer/countryOfOrigin) with no evidence and marks it non-forceable', () => {
  const run = {
    mergedAnalysis: {
      material: { value: 'x', confidence: 0.5, evidence: [] },
      dimensions: { value: null, confidence: 0, evidence: [] },
      manufacturer: { value: '알수없음', confidence: 0.8, evidence: [] },
      countryOfOrigin: { value: null, confidence: 0, evidence: [] },
      handlingPrecautions: { value: null, confidence: 0, evidence: [] },
      colors: { values: [], confidence: 0 },
      searchTags: [],
    },
  };
  const preview = buildApplyPreview(run, { options: [] });
  assert.equal(preview.fields.manufacturer.blockedReason, 'NO_EVIDENCE_LEGAL_FIELD');
  assert.equal(preview.fields.manufacturer.forceable, false);
});

test('buildApplyPreview marks a conflicting field as blocked-but-forceable, and an auto_candidate field as pre-selected', () => {
  const run = {
    mergedAnalysis: {
      material: { value: null, confidence: 0, evidence: [], conflict: true },
      dimensions: { value: '23.5cm x 13.5cm x 10.5cm', confidence: 0.98, evidence: [{ sourceFile: 'a', sliceIndex: 1, quote: 'x' }] },
      manufacturer: { value: null, confidence: 0, evidence: [] },
      countryOfOrigin: { value: null, confidence: 0, evidence: [] },
      handlingPrecautions: { value: null, confidence: 0, evidence: [] },
      colors: { values: [], confidence: 0 },
      searchTags: [],
    },
  };
  const preview = buildApplyPreview(run, { options: [] });
  assert.equal(preview.fields.material.blockedReason, 'CONFLICT_NEEDS_CONFIRMATION');
  assert.equal(preview.fields.material.forceable, true);
  assert.equal(preview.fields.dimensions.tier, 'auto_candidate');
  assert.equal(preview.fields.dimensions.autoSelected, true);
});

test('applyProductAnalysis writes only the requested, gate-passing fields, blocks the unresolved one, and never touches product_options', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({ db, rootDir: '/repo', draftId: 64, ...baseDeps() });
  const draftOptions = [{ name: '주얼리 보석함', value: '베이지' }, { name: '주얼리 보석함', value: '그레이' }];

  const result = await applyProductAnalysis(db, 64, {
    runId: run.id,
    fields: { material: true, dimensions: true, manufacturer: true, colors: true, searchTags: true, handlingPrecautions: true },
    getProductDraftImpl: async () => ({ id: 64, options: draftOptions }),
  });

  assert.deepEqual(result.appliedFields.sort(), ['colors', 'dimensions', 'manufacturer', 'material', 'searchTags'].sort());
  assert.deepEqual(result.blockedFields, [{ field: 'handlingPrecautions', reason: 'NO_VALUE' }]);
  assert.deepEqual(result.applied.saleColors, ['베이지', '그레이']);
  assert.deepEqual(result.applied.appearanceTraits, ['투명']);

  const optionsQueries = db.calls.filter((c) => c.sql.includes('product_options'));
  assert.equal(optionsQueries.length, 0, 'applyProductAnalysis must never query/write product_options');
});

test('applyProductAnalysis blocks a legal field with no evidence even when the caller tries to force it', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps({
      codexAnalysis: { ...CODEX_SUCCESS, manufacturer: { value: '알수없음', confidence: 0.5, evidence: [] } },
      pythonAnalysis: { ...PYTHON_SUCCESS, manufacturer: { value: null, confidence: 0, source: null, evidence: [] } },
    }),
  });

  const result = await applyProductAnalysis(db, 64, {
    runId: run.id,
    fields: { manufacturer: true },
    forceFields: ['manufacturer'],
    getProductDraftImpl: async () => ({ id: 64, options: [] }),
  });

  assert.deepEqual(result.appliedFields, []);
  assert.deepEqual(result.blockedFields, [{ field: 'manufacturer', reason: 'NO_EVIDENCE_LEGAL_FIELD' }]);
});

// Confirmed live 2026-08-15, draft 8: Python OCR read material as "면"
// (cotton -- a misread), Codex read "ABS" off the same product's spec label
// (confidence 0.99). Forcing the conflicted field through with no fieldValues
// entry used to silently write null (discarding both candidates); it must
// now block with a distinct reason instead.
test('applyProductAnalysis blocks a forced conflict with CONFLICT_VALUE_NOT_SPECIFIED when no fieldValues entry picks a candidate', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps({
      codexAnalysis: { ...CODEX_SUCCESS, material: { value: 'ABS', confidence: 0.99, evidence: [{ sourceFile: 'a.jpg', sliceIndex: 19, quote: '재질 ABS', rawJsonPath: null }] } },
      pythonAnalysis: { ...PYTHON_SUCCESS, material: { value: '면', confidence: 0.6, source: 'ocr', evidence: [{ file: 'a.jpg', sliceIndex: 8, text: '면' }] } },
    }),
  });

  const result = await applyProductAnalysis(db, 64, {
    runId: run.id,
    fields: { material: true },
    forceFields: ['material'],
    getProductDraftImpl: async () => ({ id: 64, options: [] }),
  });

  assert.deepEqual(result.appliedFields, []);
  assert.deepEqual(result.blockedFields, [{ field: 'material', reason: 'CONFLICT_VALUE_NOT_SPECIFIED' }]);
});

test('applyProductAnalysis applies the fieldValues-specified candidate when forcing a genuine conflict', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64,
    ...baseDeps({
      codexAnalysis: { ...CODEX_SUCCESS, material: { value: 'ABS', confidence: 0.99, evidence: [{ sourceFile: 'a.jpg', sliceIndex: 19, quote: '재질 ABS', rawJsonPath: null }] } },
      pythonAnalysis: { ...PYTHON_SUCCESS, material: { value: '면', confidence: 0.6, source: 'ocr', evidence: [{ file: 'a.jpg', sliceIndex: 8, text: '면' }] } },
    }),
  });

  const result = await applyProductAnalysis(db, 64, {
    runId: run.id,
    fields: { material: true },
    forceFields: ['material'],
    fieldValues: { material: 'ABS' },
    getProductDraftImpl: async () => ({ id: 64, options: [] }),
  });

  assert.deepEqual(result.appliedFields, ['material']);
  assert.equal(result.applied.material, 'ABS');
});

test('applyProductAnalysis rejects applying against a run that failed or has no merged result', async () => {
  const db = makeFakeDb();
  const run = await runProductAnalysis({
    db, rootDir: '/repo', draftId: 64, ...baseDeps(),
    checkCodexAvailabilityImpl: async () => ({ available: false, loggedIn: false, version: null, message: 'missing' }),
  });
  await assert.rejects(
    () => applyProductAnalysis(db, 64, { runId: run.id, fields: { material: true } }),
    (error) => error.code === 'RUN_NOT_APPLICABLE',
  );
});

test('getLatestAnalysisRun and getAppliedAnalysis return null (not throw) when nothing has run yet', async () => {
  const db = makeFakeDb();
  assert.equal(await getLatestAnalysisRun(db, 999), null);
  assert.equal(await getAppliedAnalysis(db, 999), null);
});
