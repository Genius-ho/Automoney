import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchRun,
  findDraftBySupplierProductNo,
  finishBatchRun,
  getBatchRunDetail,
  getLatestBatchRun,
  linkDraftToBatch,
  listBatchRuns,
  recordBatchCandidates,
  updateBatchCandidateStatus,
} from '../src/batch-run-store.mjs';

function fakeRunRow(overrides = {}) {
  return {
    id: '1',
    started_at: '2026-07-20T00:00:00Z',
    finished_at: null,
    status: 'running',
    stage_reached: null,
    error_code: null,
    error_message: null,
    created_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

test('createBatchRun inserts a running row and returns it mapped', async () => {
  const db = { async query() { return { rows: [fakeRunRow()] }; } };
  const run = await createBatchRun(db);
  assert.equal(run.id, 1);
  assert.equal(run.status, 'running');
});

test('finishBatchRun stamps finished_at and writes status/stageReached/error fields', async () => {
  let capturedParams = null;
  const db = {
    async query(sql, params) {
      capturedParams = params;
      return { rows: [fakeRunRow({ status: 'completed', stage_reached: 'scored_preview_only', finished_at: '2026-07-20T01:00:00Z' })] };
    },
  };
  const run = await finishBatchRun(db, 1, { status: 'completed', stageReached: 'scored_preview_only' });
  assert.deepEqual(capturedParams, [1, 'completed', 'scored_preview_only', null, null]);
  assert.equal(run.status, 'completed');
  assert.equal(run.stageReached, 'scored_preview_only');
});

test('recordBatchCandidates inserts one row per candidate and JSON-encodes breakdown/raw fields', async () => {
  const inserted = [];
  const db = {
    async query(sql, params) {
      inserted.push(params);
      return { rows: [{ id: String(inserted.length), batch_run_id: params[0], category_policy_id: params[1], supplier_product_no: params[2], name: params[3], score: params[4], score_breakdown: {}, is_winner: params[6], raw_candidate_json: null, created_at: '2026-07-20T00:00:00Z' }] };
    },
  };
  const candidates = [
    { categoryPolicyId: 1, supplierProductNo: '111', name: 'A', score: 72.5, scoreBreakdown: { profit: 20 }, isWinner: true, rawCandidateJson: { productNo: '111' } },
    { categoryPolicyId: 1, supplierProductNo: '222', name: 'B', score: 40, scoreBreakdown: { profit: 5 }, isWinner: false },
  ];
  const recorded = await recordBatchCandidates(db, 9, candidates);
  assert.equal(recorded.length, 2);
  assert.deepEqual(inserted[0], [9, 1, '111', 'A', 72.5, JSON.stringify({ profit: 20 }), true, JSON.stringify({ productNo: '111' })]);
  assert.deepEqual(inserted[1], [9, 1, '222', 'B', 40, JSON.stringify({ profit: 5 }), false, JSON.stringify(null)]);
});

test('getLatestBatchRun returns null when no runs exist yet', async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await getLatestBatchRun(db), null);
});

test('listBatchRuns respects the limit parameter', async () => {
  let capturedParams = null;
  const db = {
    async query(sql, params) { capturedParams = params; return { rows: [fakeRunRow()] }; },
  };
  await listBatchRuns(db, { limit: 5 });
  assert.deepEqual(capturedParams, [5]);
});

test('getBatchRunDetail returns null for an unknown run, else the run plus its candidates with category names joined in', async () => {
  const db = {
    async query(sql, params) {
      if (sql.includes('from batch_runs where id')) {
        return params[0] === 99 ? { rows: [] } : { rows: [fakeRunRow({ id: String(params[0]) })] };
      }
      return {
        rows: [{
          id: '1', batch_run_id: params[0], category_policy_id: '2', supplier_product_no: '111', name: 'A',
          score: '85', score_breakdown: { profit: 20 }, is_winner: true, raw_candidate_json: null, created_at: '2026-07-20T00:00:00Z',
          category_name: '정리함/수납함', segment_name: '생활/수납',
        }],
      };
    },
  };
  assert.equal(await getBatchRunDetail(db, 99), null);
  const detail = await getBatchRunDetail(db, 1);
  assert.equal(detail.id, 1);
  assert.equal(detail.candidates.length, 1);
  assert.equal(detail.candidates[0].categoryName, '정리함/수납함');
  assert.equal(detail.candidates[0].score, 85);
});

test('updateBatchCandidateStatus only overwrites the fields that were provided and always advances last_processed_at', async () => {
  let capturedParams = null;
  const db = {
    async query(sql, params) {
      capturedParams = params;
      return { rows: [{ id: '11', batch_run_id: '5', category_policy_id: '2', supplier_product_no: '111', name: 'A', score: null, score_breakdown: {}, is_winner: true, raw_candidate_json: null, created_at: '2026-07-20T00:00:00Z', processing_status: 'analysis_completed', draft_id: '501', failure_stage: null, failure_message: null, last_processed_at: '2026-07-20T01:00:00Z', python_ran: true, codex_ran: true, main_image_generated: null, detail_images_generated_count: null, unresolved_fields_count: 1 }] };
    },
  };
  const result = await updateBatchCandidateStatus(db, 11, { processingStatus: 'analysis_completed', draftId: 501, pythonRan: true, codexRan: true, unresolvedFieldsCount: 1 });
  assert.deepEqual(capturedParams, [11, 'analysis_completed', 501, null, null, true, true, null, null, 1]);
  assert.equal(result.processingStatus, 'analysis_completed');
  assert.equal(result.draftId, 501);
  assert.equal(result.unresolvedFieldsCount, 1);
});

test('linkDraftToBatch writes batch_run_id/batch_candidate_id onto the draft', async () => {
  let capturedParams = null;
  const db = { async query(sql, params) { capturedParams = params; return { rows: [] }; } };
  await linkDraftToBatch(db, 501, { batchRunId: 5, batchCandidateId: 11 });
  assert.deepEqual(capturedParams, [501, 5, 11]);
});

test('findDraftBySupplierProductNo returns the existing draft id, or null when none exists', async () => {
  const dbHit = { async query() { return { rows: [{ id: '27' }] }; } };
  assert.equal(await findDraftBySupplierProductNo(dbHit, '45413455'), 27);

  const dbMiss = { async query() { return { rows: [] }; } };
  assert.equal(await findDraftBySupplierProductNo(dbMiss, '99999999'), null);
});
