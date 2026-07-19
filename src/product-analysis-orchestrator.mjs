import { readFile, writeFile } from 'node:fs/promises';

import { checkCodexAvailability, runCodexAnalysis } from './codex-client.mjs';
import { checkPythonAvailability, runPythonAnalysis } from './python-client.mjs';
import { buildAnalysisInputPackage } from './product-job-folder.mjs';
import { buildAnalysisPrompt, classifyConfidence, validateProductAnalysis } from './product-analysis-schema.mjs';
import { validatePythonAnalysis } from './python-analysis-schema.mjs';
import { mergeAnalysis } from './analysis-merge.mjs';
import { getProductDraft } from './admin-store.mjs';

const RAW_JSON_EXCERPT_LIMIT = 4000;
const SINGLE_VALUE_FIELDS = ['material', 'dimensions', 'manufacturer', 'countryOfOrigin', 'handlingPrecautions'];
// 제조국/제조사 are the "법적 인증·제조국·제조사" fields the apply policy hard-blocks
// without evidence -- handlingPrecautions/material/dimensions are reviewable but
// not legally sensitive in the same way, so they're not in this set.
const LEGAL_FIELDS = new Set(['manufacturer', 'countryOfOrigin']);

function classifyCodexRunFailure({ timedOut, log, invalidResult }) {
  const text = String(log || '');
  if (timedOut) return 'CODEX_TIMEOUT';
  if (/rate.?limit|usage limit|quota exceeded|429/i.test(text)) return 'CODEX_RATE_LIMIT';
  if (/not logged in|login required|401 unauthorized/i.test(text)) return 'CODEX_LOGIN_REQUIRED';
  if (invalidResult || /failed to read\/parse output file/i.test(text)) return 'CODEX_INVALID_JSON';
  return 'CODEX_FAILED';
}

function classifyPythonRunFailure({ timedOut, log }) {
  const text = String(log || '');
  if (timedOut) return 'PYTHON_TIMEOUT';
  if (/failed to parse stdout as json/i.test(text)) return 'PYTHON_INVALID_JSON';
  return 'PYTHON_FAILED';
}

function toRunSummary(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    runNumber: row.run_number,
    status: row.status,
    pythonStatus: row.python_status,
    pythonErrorCode: row.python_error_code,
    pythonErrorMessage: row.python_error_message,
    codexStatus: row.codex_status,
    codexErrorCode: row.codex_error_code,
    codexErrorMessage: row.codex_error_message,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toRunDetail(row) {
  return {
    ...toRunSummary(row),
    pythonAnalysis: row.python_analysis_json || null,
    codexAnalysis: row.codex_analysis_json || null,
    mergedAnalysis: row.merged_analysis_json || null,
  };
}

// Kicks off one Codex+Python analysis run for a draft and records every
// outcome (success or a specific failure) as a new row -- re-running never
// overwrites or deletes a prior run, satisfying "분석 재실행 시 이전 결과
// 이력 보존". The job-folder JSON files (python/codex/merged-analysis.json)
// still get written by the same underlying library calls the CLI script
// uses, then snapshotted into the row so history survives the next re-run
// overwriting those files on disk.
export async function runProductAnalysis({
  db,
  rootDir,
  draftId,
  codexConfig,
  pythonConfig,
  jobPathsConfig = {},
  checkCodexAvailabilityImpl = checkCodexAvailability,
  checkPythonAvailabilityImpl = checkPythonAvailability,
  buildAnalysisInputPackageImpl = buildAnalysisInputPackage,
  runPythonAnalysisImpl = runPythonAnalysis,
  runCodexAnalysisImpl = runCodexAnalysis,
  writeFileImpl = writeFile,
  readFileImpl = readFile,
}) {
  const inserted = await db.query(
    `insert into product_analysis_runs (product_draft_id, run_number, status, python_status, codex_status)
     select $1, coalesce(max(run_number), 0) + 1, 'running', 'skipped', 'pending'
       from product_analysis_runs where product_draft_id = $1
     returning *`,
    [draftId],
  );
  let run = inserted.rows[0];

  const finalize = async (patch) => {
    const fields = Object.keys(patch);
    const setSql = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
    const result = await db.query(
      `update product_analysis_runs set ${setSql}, finished_at = now() where id = $1 returning *`,
      [run.id, ...fields.map((field) => patch[field])],
    );
    run = result.rows[0];
    return run;
  };

  try {
    const codexAvailability = await checkCodexAvailabilityImpl({ config: codexConfig });
    if (!codexAvailability.available) {
      return toRunDetail(await finalize({
        status: 'failed', codex_status: 'failed',
        codex_error_code: 'CODEX_NOT_AVAILABLE', codex_error_message: codexAvailability.message,
        error_code: 'CODEX_NOT_AVAILABLE', error_message: codexAvailability.message,
      }));
    }
    if (!codexAvailability.loggedIn) {
      return toRunDetail(await finalize({
        status: 'failed', codex_status: 'failed',
        codex_error_code: 'CODEX_LOGIN_REQUIRED', codex_error_message: codexAvailability.message,
        error_code: 'CODEX_LOGIN_REQUIRED', error_message: codexAvailability.message,
      }));
    }

    const pythonAvailability = await checkPythonAvailabilityImpl({ config: pythonConfig });

    const pkg = await buildAnalysisInputPackageImpl({ db, rootDir, jobDir: jobPathsConfig.jobDir, draftId });
    if (pkg.detailImagePaths.length === 0) {
      return toRunDetail(await finalize({
        status: 'failed',
        error_code: 'NO_DETAIL_IMAGES', error_message: '로컬에 보관된 상세페이지 원본 이미지가 없어 분석을 진행할 수 없습니다.',
      }));
    }

    let pythonAnalysis = null;
    let pythonStatus = 'skipped';
    let pythonErrorCode = pythonAvailability.available ? null : 'PYTHON_NOT_AVAILABLE';
    let pythonErrorMessage = pythonAvailability.available ? null : pythonAvailability.message;
    if (pythonAvailability.available) {
      const pythonResult = await runPythonAnalysisImpl({ config: pythonConfig, workerDir: `${rootDir}/workers/python`, jobDir: pkg.paths.root });
      await writeFileImpl(pkg.paths.pythonLogPath, pythonResult.log || '');
      if (pythonResult.success) {
        const validation = validatePythonAnalysis(pythonResult.analysis);
        if (validation.valid) {
          pythonAnalysis = pythonResult.analysis;
          pythonStatus = 'success';
          await writeFileImpl(pkg.paths.pythonAnalysisPath, JSON.stringify(pythonAnalysis, null, 2));
        } else {
          pythonStatus = 'failed';
          pythonErrorCode = 'PYTHON_INVALID_JSON';
          pythonErrorMessage = validation.errors.join('; ');
        }
      } else {
        pythonStatus = 'failed';
        pythonErrorCode = classifyPythonRunFailure(pythonResult);
        pythonErrorMessage = pythonResult.log;
      }
    }

    const rawJsonExcerpt = (await readFileImpl(pkg.paths.rawJsonPath, 'utf8')).slice(0, RAW_JSON_EXCERPT_LIMIT);
    const prompt = buildAnalysisPrompt({
      productSummary: JSON.stringify(pkg.productSummary),
      rawJsonExcerpt,
      imageCount: pkg.detailImagePaths.length,
    });
    const codexResult = await runCodexAnalysisImpl({
      config: codexConfig,
      cwd: pkg.paths.root,
      images: pkg.detailImagePaths,
      schemaPath: `${rootDir}/schemas/product-analysis.schema.json`,
      outputPath: pkg.paths.codexAnalysisPath,
      prompt,
    });
    await writeFileImpl(pkg.paths.codexLogPath, codexResult.log || '');
    if (!codexResult.success) {
      const codexErrorCode = classifyCodexRunFailure(codexResult);
      return toRunDetail(await finalize({
        status: 'failed', python_status: pythonStatus, python_error_code: pythonErrorCode, python_error_message: pythonErrorMessage,
        codex_status: 'failed', codex_error_code: codexErrorCode, codex_error_message: codexResult.log,
        error_code: codexErrorCode, error_message: codexResult.log,
        python_analysis_json: pythonAnalysis,
      }));
    }
    const codexValidation = validateProductAnalysis(codexResult.analysis);
    if (!codexValidation.valid) {
      return toRunDetail(await finalize({
        status: 'failed', python_status: pythonStatus, python_error_code: pythonErrorCode, python_error_message: pythonErrorMessage,
        codex_status: 'failed', codex_error_code: 'CODEX_INVALID_JSON', codex_error_message: codexValidation.errors.join('; '),
        error_code: 'CODEX_INVALID_JSON', error_message: codexValidation.errors.join('; '),
        python_analysis_json: pythonAnalysis,
      }));
    }

    const merged = mergeAnalysis({ codexAnalysis: codexResult.analysis, pythonAnalysis });
    await writeFileImpl(pkg.paths.mergedAnalysisPath, JSON.stringify(merged, null, 2));

    return toRunDetail(await finalize({
      status: 'success',
      python_status: pythonStatus, python_error_code: pythonErrorCode, python_error_message: pythonErrorMessage,
      codex_status: 'success', codex_error_code: null, codex_error_message: null,
      error_code: null, error_message: null,
      python_analysis_json: pythonAnalysis,
      codex_analysis_json: codexResult.analysis,
      merged_analysis_json: merged,
    }));
  } catch (error) {
    return toRunDetail(await finalize({
      status: 'failed',
      error_code: 'UNEXPECTED_ERROR', error_message: error.message || String(error),
    }));
  }
}

export async function listAnalysisRuns(db, draftId) {
  const result = await db.query(
    `select id, product_draft_id, run_number, status, python_status, python_error_code, python_error_message,
            codex_status, codex_error_code, codex_error_message, error_code, error_message, started_at, finished_at
       from product_analysis_runs where product_draft_id = $1 order by run_number desc`,
    [draftId],
  );
  return result.rows.map(toRunSummary);
}

export async function getAnalysisRun(db, draftId, runId) {
  const result = await db.query('select * from product_analysis_runs where id = $1 and product_draft_id = $2', [runId, draftId]);
  return result.rows[0] ? toRunDetail(result.rows[0]) : null;
}

export async function getLatestAnalysisRun(db, draftId) {
  const result = await db.query(
    'select * from product_analysis_runs where product_draft_id = $1 order by run_number desc limit 1',
    [draftId],
  );
  return result.rows[0] ? toRunDetail(result.rows[0]) : null;
}

function normalizeColorToken(value) {
  return String(value ?? '').trim();
}

// Splits the merged analysis's "colors" field into values that actually
// match one of this draft's real sale option values (색상 등) vs values that
// don't -- e.g. a jewelry box that's "베이지/그레이" as sale options but also
// described as "투명" (the acrylic case). Only the first group may ever
// become a sale-option candidate; the second is appearance/material
// description and must never be proposed as a new option value (spec
// section 3: "'투명'을 판매 옵션으로 자동 추가하지 말 것").
export function splitColorCandidates(colorsField, draftOptions = []) {
  const optionValues = new Set(draftOptions.map((option) => normalizeColorToken(option.value)).filter(Boolean));
  const values = colorsField?.values || [];
  const saleColorCandidates = values.filter((value) => optionValues.has(normalizeColorToken(value)));
  const appearanceTraits = values.filter((value) => !optionValues.has(normalizeColorToken(value)));
  return { saleColorCandidates, appearanceTraits };
}

function evaluateSingleField(key, field) {
  const confidence = field?.confidence ?? 0;
  const evidence = field?.evidence || [];
  const hasValue = field?.value != null && String(field.value).trim() !== '';
  const tier = classifyConfidence(confidence);
  let blockedReason = null;
  // Order matters: a conflict field from mergeAnalysis always has value=null
  // (see analysis-merge.mjs's mergeSingleField), so conflict must be checked
  // before the generic "no value" case -- otherwise every real conflict
  // would be misreported as NO_VALUE (not forceable) instead of
  // CONFLICT_NEEDS_CONFIRMATION (forceable with explicit confirmation).
  if (LEGAL_FIELDS.has(key) && evidence.length === 0) blockedReason = 'NO_EVIDENCE_LEGAL_FIELD';
  else if (field?.conflict) blockedReason = 'CONFLICT_NEEDS_CONFIRMATION';
  else if (!hasValue) blockedReason = 'NO_VALUE';
  else if (tier === 'unresolved') blockedReason = 'UNRESOLVED_NEEDS_CONFIRMATION';
  return {
    key,
    value: field?.value ?? null,
    confidence,
    sources: field?.sources || [],
    evidence,
    conflict: Boolean(field?.conflict),
    tier,
    legalField: LEGAL_FIELDS.has(key),
    autoSelected: blockedReason === null && tier === 'auto_candidate',
    blockedReason,
    // Legal fields with no evidence can never be forced through -- every
    // other block reason can be overridden by the caller explicitly listing
    // the field in `forceFields` when applying.
    forceable: blockedReason !== null && blockedReason !== 'NO_EVIDENCE_LEGAL_FIELD' && blockedReason !== 'NO_VALUE',
  };
}

// Builds the per-field apply-eligibility view the admin UI renders
// (checkbox pre-checked/disabled state, badge text) and the apply endpoint
// re-derives independently before writing anything, so the two can never
// drift apart.
export function buildApplyPreview(run, draft) {
  const merged = run?.mergedAnalysis;
  if (!merged) return null;
  const fields = Object.fromEntries(SINGLE_VALUE_FIELDS.map((key) => [key, evaluateSingleField(key, merged[key])]));
  const colors = splitColorCandidates(merged.colors, draft?.options || []);
  return {
    fields,
    colors: {
      ...colors,
      confidence: merged.colors?.confidence ?? 0,
      conflict: Boolean(merged.colors?.conflict),
      evidence: merged.colors?.evidence || [],
    },
    searchTags: merged.searchTags || [],
    unresolvedFields: merged.unresolvedFields || [],
    conflicts: merged.conflicts || [],
  };
}

// Never touches product_options (or any other draft field) directly --
// applying is purely "record what the user accepted" so the debug/export
// views can surface it as a candidate. DB is left untouched unless this is
// called, and only touches the fields the caller explicitly selected AND
// that pass the same gate buildApplyPreview shows in the UI.
export async function applyProductAnalysis(db, draftId, { runId, fields = {}, forceFields = [], getProductDraftImpl = getProductDraft }) {
  const run = await getAnalysisRun(db, draftId, runId);
  if (!run) throw Object.assign(new Error('Analysis run not found for this draft'), { code: 'RUN_NOT_FOUND' });
  if (run.status !== 'success' || !run.mergedAnalysis) {
    throw Object.assign(new Error('This analysis run did not complete successfully and has no mergeable result'), { code: 'RUN_NOT_APPLICABLE' });
  }
  const draft = await getProductDraftImpl(db, draftId);
  if (!draft) throw Object.assign(new Error('Product draft not found'), { code: 'DRAFT_NOT_FOUND' });

  const merged = run.mergedAnalysis;
  const forced = new Set(forceFields);
  const appliedValues = {};
  const appliedFieldNames = [];
  const blockedFields = [];

  for (const key of SINGLE_VALUE_FIELDS) {
    if (!fields[key]) continue;
    const evaluation = evaluateSingleField(key, merged[key]);
    if (evaluation.blockedReason && !(evaluation.forceable && forced.has(key))) {
      blockedFields.push({ field: key, reason: evaluation.blockedReason });
      continue;
    }
    appliedValues[key] = evaluation.value;
    appliedFieldNames.push(key);
  }

  if (fields.searchTags) {
    const searchTags = merged.searchTags || [];
    if (searchTags.length === 0) {
      blockedFields.push({ field: 'searchTags', reason: 'NO_VALUE' });
    } else {
      appliedValues.searchTags = searchTags;
      appliedFieldNames.push('searchTags');
    }
  }

  if (fields.colors) {
    const split = splitColorCandidates(merged.colors, draft.options || []);
    const colorsConflict = Boolean(merged.colors?.conflict);
    const colorsTier = classifyConfidence(merged.colors?.confidence ?? 0);
    if ((colorsConflict || colorsTier === 'unresolved') && !forced.has('colors')) {
      blockedFields.push({ field: 'colors', reason: colorsConflict ? 'CONFLICT_NEEDS_CONFIRMATION' : 'UNRESOLVED_NEEDS_CONFIRMATION' });
    } else {
      appliedValues.saleColors = split.saleColorCandidates;
      appliedValues.appearanceTraits = split.appearanceTraits;
      appliedFieldNames.push('colors');
    }
  }

  if (appliedFieldNames.length === 0) {
    return { applied: await getAppliedAnalysis(db, draftId), appliedFields: [], blockedFields };
  }

  const existing = await getAppliedAnalysis(db, draftId);
  const next = {
    material: appliedFieldNames.includes('material') ? appliedValues.material : existing?.material ?? null,
    dimensions: appliedFieldNames.includes('dimensions') ? appliedValues.dimensions : existing?.dimensions ?? null,
    manufacturer: appliedFieldNames.includes('manufacturer') ? appliedValues.manufacturer : existing?.manufacturer ?? null,
    countryOfOrigin: appliedFieldNames.includes('countryOfOrigin') ? appliedValues.countryOfOrigin : existing?.countryOfOrigin ?? null,
    handlingPrecautions: appliedFieldNames.includes('handlingPrecautions') ? appliedValues.handlingPrecautions : existing?.handlingPrecautions ?? null,
    saleColors: appliedFieldNames.includes('colors') ? appliedValues.saleColors : existing?.saleColors ?? [],
    appearanceTraits: appliedFieldNames.includes('colors') ? appliedValues.appearanceTraits : existing?.appearanceTraits ?? [],
    searchTags: appliedFieldNames.includes('searchTags') ? appliedValues.searchTags : existing?.searchTags ?? [],
  };
  const mergedAppliedFieldNames = [...new Set([...(existing?.appliedFields || []), ...appliedFieldNames])];

  const result = await db.query(
    `insert into product_analysis_applied (
       product_draft_id, analysis_run_id, material, dimensions, manufacturer, country_of_origin, handling_precautions,
       sale_colors, appearance_traits, search_tags, applied_fields, applied_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb, now(), now())
     on conflict (product_draft_id) do update set
       analysis_run_id = excluded.analysis_run_id,
       material = excluded.material,
       dimensions = excluded.dimensions,
       manufacturer = excluded.manufacturer,
       country_of_origin = excluded.country_of_origin,
       handling_precautions = excluded.handling_precautions,
       sale_colors = excluded.sale_colors,
       appearance_traits = excluded.appearance_traits,
       search_tags = excluded.search_tags,
       applied_fields = excluded.applied_fields,
       applied_at = now(),
       updated_at = now()
     returning *`,
    [
      draftId, runId, next.material, next.dimensions, next.manufacturer, next.countryOfOrigin, next.handlingPrecautions,
      JSON.stringify(next.saleColors), JSON.stringify(next.appearanceTraits), JSON.stringify(next.searchTags),
      JSON.stringify(mergedAppliedFieldNames),
    ],
  );
  return { applied: toAppliedAnalysis(result.rows[0]), appliedFields: appliedFieldNames, blockedFields };
}

function toAppliedAnalysis(row) {
  if (!row) return null;
  return {
    productDraftId: Number(row.product_draft_id),
    analysisRunId: Number(row.analysis_run_id),
    material: row.material,
    dimensions: row.dimensions,
    manufacturer: row.manufacturer,
    countryOfOrigin: row.country_of_origin,
    handlingPrecautions: row.handling_precautions,
    saleColors: row.sale_colors || [],
    appearanceTraits: row.appearance_traits || [],
    searchTags: row.search_tags || [],
    appliedFields: row.applied_fields || [],
    appliedAt: row.applied_at,
    updatedAt: row.updated_at,
  };
}

export async function getAppliedAnalysis(db, draftId) {
  const result = await db.query('select * from product_analysis_applied where product_draft_id = $1', [draftId]);
  return result.rows[0] ? toAppliedAnalysis(result.rows[0]) : null;
}
