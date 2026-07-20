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
