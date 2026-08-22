function toBatchRun(row) {
  return {
    id: Number(row.id),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    stageReached: row.stage_reached,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function toBatchRunCandidate(row) {
  return {
    id: Number(row.id),
    batchRunId: Number(row.batch_run_id),
    categoryPolicyId: Number(row.category_policy_id),
    supplierProductNo: row.supplier_product_no,
    name: row.name,
    score: row.score == null ? null : Number(row.score),
    scoreBreakdown: row.score_breakdown || {},
    isWinner: row.is_winner,
    rawCandidateJson: row.raw_candidate_json,
    createdAt: row.created_at,
    processingStatus: row.processing_status ?? null,
    draftId: row.draft_id == null ? null : Number(row.draft_id),
    failureStage: row.failure_stage ?? null,
    failureMessage: row.failure_message ?? null,
    lastProcessedAt: row.last_processed_at ?? null,
    pythonRan: row.python_ran ?? null,
    codexRan: row.codex_ran ?? null,
    mainImageGenerated: row.main_image_generated ?? null,
    detailImagesGeneratedCount: row.detail_images_generated_count ?? null,
    unresolvedFieldsCount: row.unresolved_fields_count ?? null,
  };
}

export async function createBatchRun(db) {
  const result = await db.query(
    `insert into batch_runs (status) values ('running') returning *`,
  );
  return toBatchRun(result.rows[0]);
}

export async function finishBatchRun(db, runId, { status, stageReached = null, errorCode = null, errorMessage = null }) {
  const result = await db.query(
    `update batch_runs set
       status = $2, stage_reached = $3, error_code = $4, error_message = $5, finished_at = now()
     where id = $1
     returning *`,
    [runId, status, stageReached, errorCode, errorMessage],
  );
  return toBatchRun(result.rows[0]);
}

export async function recordBatchCandidates(db, runId, candidates) {
  const recorded = [];
  for (const candidate of candidates) {
    const result = await db.query(
      `insert into batch_run_candidates
         (batch_run_id, category_policy_id, supplier_product_no, name, score, score_breakdown, is_winner, raw_candidate_json)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
       returning *`,
      [
        runId,
        candidate.categoryPolicyId,
        candidate.supplierProductNo,
        candidate.name || null,
        candidate.score ?? null,
        JSON.stringify(candidate.scoreBreakdown || {}),
        candidate.isWinner === true,
        JSON.stringify(candidate.rawCandidateJson || null),
      ],
    );
    recorded.push(toBatchRunCandidate(result.rows[0]));
  }
  return recorded;
}

// Stage 2 pipeline progress for the one candidate per category that was
// selected as winner and is being carried through draft creation ->
// analysis -> image generation. Only fields explicitly passed are
// overwritten (coalesce); last_processed_at always advances.
export async function updateBatchCandidateStatus(db, candidateId, {
  processingStatus, draftId, failureStage, failureMessage,
  pythonRan, codexRan, mainImageGenerated, detailImagesGeneratedCount, unresolvedFieldsCount,
} = {}) {
  const result = await db.query(
    `update batch_run_candidates set
       processing_status = coalesce($2, processing_status),
       draft_id = coalesce($3, draft_id),
       failure_stage = coalesce($4, failure_stage),
       failure_message = coalesce($5, failure_message),
       python_ran = coalesce($6, python_ran),
       codex_ran = coalesce($7, codex_ran),
       main_image_generated = coalesce($8, main_image_generated),
       detail_images_generated_count = coalesce($9, detail_images_generated_count),
       unresolved_fields_count = coalesce($10, unresolved_fields_count),
       last_processed_at = now()
     where id = $1
     returning *`,
    [
      candidateId,
      processingStatus ?? null,
      draftId ?? null,
      failureStage ?? null,
      failureMessage ?? null,
      pythonRan ?? null,
      codexRan ?? null,
      mainImageGenerated ?? null,
      detailImagesGeneratedCount ?? null,
      unresolvedFieldsCount ?? null,
    ],
  );
  return result.rows[0] ? toBatchRunCandidate(result.rows[0]) : null;
}

// Stamps the newly-created draft with where it came from -- the only place
// batch_run_id/batch_candidate_id are ever written, so every other draft
// (manual imports, draft 27/46/64) keeps these null.
export async function linkDraftToBatch(db, draftId, { batchRunId, batchCandidateId }) {
  await db.query(
    'update product_drafts set batch_run_id = $2, batch_candidate_id = $3 where id = $1',
    [draftId, batchRunId, batchCandidateId],
  );
}

// The dedup check Stage 2 must run before ever creating a draft --
// "이미 동일 source_product_id 또는 동일 supplier product가 기존 draft ...에서
// 처리 중이면 중복 생성 금지". product_drafts.supplier_product_no is already
// unique, so any existing row (created manually or by a prior batch run) is
// authoritative regardless of how it got there.
export async function findDraftBySupplierProductNo(db, supplierProductNo) {
  const result = await db.query('select id from product_drafts where supplier_product_no = $1', [String(supplierProductNo)]);
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

// Fetches the full candidate row (including raw_candidate_json) by id --
// the daily processing cycle only stores a lightweight reference
// (batchRunCandidateId) on each processing_queue row, so it looks the full
// candidate back up here rather than duplicating raw_candidate_json into
// processing_queue too.
export async function getBatchRunCandidateById(db, id) {
  const result = await db.query('select * from batch_run_candidates where id = $1', [id]);
  return result.rows[0] ? toBatchRunCandidate(result.rows[0]) : null;
}

export async function getLatestBatchRun(db) {
  const result = await db.query('select * from batch_runs order by id desc limit 1');
  return result.rows[0] ? toBatchRun(result.rows[0]) : null;
}

export async function listBatchRuns(db, { limit = 20 } = {}) {
  const result = await db.query('select * from batch_runs order by id desc limit $1', [limit]);
  return result.rows.map(toBatchRun);
}

export async function getBatchRunDetail(db, runId) {
  const runResult = await db.query('select * from batch_runs where id = $1', [runId]);
  if (!runResult.rows[0]) return null;
  const candidatesResult = await db.query(
    `select brc.*, cp.category_name, cp.segment_name
     from batch_run_candidates brc
     join category_policy cp on cp.id = brc.category_policy_id
     where brc.batch_run_id = $1
     order by brc.category_policy_id, brc.score desc nulls last`,
    [runId],
  );
  return {
    ...toBatchRun(runResult.rows[0]),
    candidates: candidatesResult.rows.map((row) => ({
      ...toBatchRunCandidate(row),
      categoryName: row.category_name,
      segmentName: row.segment_name,
    })),
  };
}
