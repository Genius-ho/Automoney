function toQueueItem(row) {
  return {
    id: Number(row.id),
    batchRunCandidateId: Number(row.batch_run_candidate_id),
    categoryPolicyId: Number(row.category_policy_id),
    supplierProductNo: row.supplier_product_no,
    name: row.name,
    score: row.score == null ? null : Number(row.score),
    status: row.status,
    draftId: row.draft_id == null ? null : Number(row.draft_id),
    failureStage: row.failure_stage,
    failureMessage: row.failure_message,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

// "동일 상품 중복 적재 금지" -- true if this supplier_product_no is either
// already sitting in the queue in a non-terminal state, or already has a
// draft (created by this or any earlier run/manual import). A queue row only
// ever reaches 'failed' after already clearing the scoring/eligibility
// filter (enqueueCandidate is called for winners only -- see
// runCandidateDiscoveryBatch), so every 'failed' row here is a downstream
// technical failure (draft creation, analysis, image generation) on an
// already-vetted good candidate, not a business-rule rejection. Permanently
// excluding those would contradict the plan's own resumability principle
// ("실패 처리하지 않음... 재개 가능한 대기 상태로 관리") by blacklisting a
// perfectly good product forever over one bad network blip -- so 'failed'
// stays excludable from "active", letting a future discovery cycle retry it.
export async function isCandidateActiveOrQueued(db, supplierProductNo) {
  const queued = await db.query(
    `select 1 from processing_queue where supplier_product_no = $1 and status <> 'failed' limit 1`,
    [String(supplierProductNo)],
  );
  if (queued.rows.length > 0) return true;
  const drafted = await db.query('select 1 from product_drafts where supplier_product_no = $1 limit 1', [String(supplierProductNo)]);
  return drafted.rows.length > 0;
}

export async function enqueueCandidate(db, { batchRunCandidateId, categoryPolicyId, supplierProductNo, name, score }) {
  const result = await db.query(
    `insert into processing_queue (batch_run_candidate_id, category_policy_id, supplier_product_no, name, score)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [batchRunCandidateId, categoryPolicyId, String(supplierProductNo), name || null, score ?? null],
  );
  return toQueueItem(result.rows[0]);
}

export async function countActiveQueueItems(db) {
  const result = await db.query(`select count(*)::int as count from processing_queue where status <> 'failed'`);
  return result.rows[0].count;
}

export async function listQueue(db, { status } = {}) {
  const result = status
    ? await db.query('select * from processing_queue where status = $1 order by queued_at', [status])
    : await db.query('select * from processing_queue order by queued_at');
  return result.rows.map(toQueueItem);
}

// Priority: resume anything already mid-flight (analyzing/generating_images
// -- interrupted by a rate limit or a process restart) before ever starting
// a fresh item, then the highest-scoring still-queued item. This is what
// makes "완료되지 않은 상품이 있으면 다음 상품으로 넘어가지 않음" true across
// day boundaries, not just within one run.
export async function getNextQueueItem(db) {
  const inProgress = await db.query(
    `select * from processing_queue where status in ('analyzing', 'analysis_completed', 'generating_images') order by started_at asc nulls last limit 1`,
  );
  if (inProgress.rows.length > 0) return toQueueItem(inProgress.rows[0]);
  const queued = await db.query(
    `select * from processing_queue where status = 'queued' order by score desc nulls last, queued_at asc limit 1`,
  );
  return queued.rows[0] ? toQueueItem(queued.rows[0]) : null;
}

async function getFirstByStatus(db, status, orderBy) {
  const result = await db.query(`select * from processing_queue where status = '${status}' order by ${orderBy} limit 1`);
  return result.rows[0] ? toQueueItem(result.rows[0]) : null;
}

export function getNextQueuedItem(db) {
  return getFirstByStatus(db, 'queued', 'score desc nulls last, queued_at asc');
}

export function getNextAnalysisItem(db) {
  return getFirstByStatus(db, 'analyzing', 'started_at asc nulls last, queued_at asc');
}

export function getNextImageItem(db) {
  return getFirstByStatus(db, 'analysis_completed', 'started_at asc nulls last, queued_at asc');
}

export async function updateQueueItemStatus(db, id, { status, draftId, failureStage, failureMessage, startedAt } = {}) {
  const result = await db.query(
    `update processing_queue set
       status = coalesce($2, status),
       draft_id = coalesce($3, draft_id),
       failure_stage = coalesce($4, failure_stage),
       failure_message = coalesce($5, failure_message),
       started_at = coalesce($6, started_at),
       updated_at = now()
     where id = $1
     returning *`,
    [id, status ?? null, draftId ?? null, failureStage ?? null, failureMessage ?? null, startedAt ?? null],
  );
  return result.rows[0] ? toQueueItem(result.rows[0]) : null;
}

// Only the failure metadata changes -- used on a quota-limited stop, where
// the status must stay at whatever in-progress stage was last reached (so
// getNextQueueItem resumes it tomorrow) rather than being force-marked
// 'failed' the way a genuine terminal failure is.
export async function recordQueueItemPause(db, id, { failureStage, failureMessage }) {
  const result = await db.query(
    `update processing_queue set failure_stage = $2, failure_message = $3, updated_at = now() where id = $1 returning *`,
    [id, failureStage ?? null, failureMessage ?? null],
  );
  return result.rows[0] ? toQueueItem(result.rows[0]) : null;
}
