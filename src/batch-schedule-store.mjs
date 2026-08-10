function toBatchScheduleState(row) {
  return {
    intervalDays: row.interval_days,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    isRunning: row.is_running,
    minPassingScore: row.min_passing_score,
    processingIntervalDays: row.processing_interval_days,
    processingNextRunAt: row.processing_next_run_at,
    processingLastRunAt: row.processing_last_run_at,
    draftNextRunAt: row.draft_next_run_at,
    draftLastRunAt: row.draft_last_run_at,
    draftLastServiceDate: row.draft_last_service_date,
    draftLastOutcome: row.draft_last_outcome,
    analysisNextRunAt: row.analysis_next_run_at,
    analysisLastRunAt: row.analysis_last_run_at,
    analysisLastServiceDate: row.analysis_last_service_date,
    analysisLastOutcome: row.analysis_last_outcome,
    imagesNextRunAt: row.images_next_run_at,
    imagesLastRunAt: row.images_last_run_at,
    imagesLastServiceDate: row.images_last_service_date,
    imagesLastOutcome: row.images_last_outcome,
    discoveryNextRunAt: row.next_run_at,
    discoveryLastRunAt: row.last_run_at,
    discoveryLastServiceDate: row.discovery_last_service_date,
    discoveryLastOutcome: row.discovery_last_outcome,
    updatedAt: row.updated_at,
  };
}

// Single-row settings (same pattern as coupang_seller_settings) holding both
// schedules -- discovery (interval_days/next_run_at/last_run_at, default
// every 3 days: pick categories, score candidates, enqueue winners) and
// daily processing (processing_*, default every 1 day: pop one queue item
// and run it through analysis+images) -- plus the single is_running lock
// shared by both, since "전체 동시 실행 수 1" covers the whole auto-batch
// system, not just one cycle.
export async function getBatchScheduleState(db) {
  const result = await db.query('select * from batch_schedule_state where id = 1');
  return result.rows[0] ? toBatchScheduleState(result.rows[0]) : null;
}

export async function updateBatchScheduleState(db, { intervalDays, nextRunAt, minPassingScore, processingIntervalDays, processingNextRunAt } = {}) {
  const result = await db.query(
    `update batch_schedule_state set
       interval_days = coalesce($1, interval_days),
       next_run_at = coalesce($2, next_run_at),
       min_passing_score = coalesce($3, min_passing_score),
       processing_interval_days = coalesce($4, processing_interval_days),
       processing_next_run_at = coalesce($5, processing_next_run_at),
       updated_at = now()
     where id = 1
     returning *`,
    [intervalDays ?? null, nextRunAt ?? null, minPassingScore ?? null, processingIntervalDays ?? null, processingNextRunAt ?? null],
  );
  return toBatchScheduleState(result.rows[0]);
}

// Atomic compare-and-set: only succeeds (returns a row) when no batch is
// currently running. This is the single source of truth for "동시 실행 수 1"
// / "이전 배치가 실행 중이면 새 배치를 시작하지 않음" -- the WHERE clause
// makes the check-and-flip a single statement so two concurrent callers
// (the scheduler tick and a manual "지금 실행" click) can never both acquire
// the lock. Shared by both the discovery and the daily-processing cycle.
export async function tryAcquireBatchLock(db) {
  const result = await db.query(
    `update batch_schedule_state set is_running = true, updated_at = now()
     where id = 1 and is_running = false
     returning *`,
  );
  return result.rows[0] ? toBatchScheduleState(result.rows[0]) : null;
}

export async function releaseDiscoveryLock(db, { lastRunAt, nextRunAt } = {}) {
  const result = await db.query(
    `update batch_schedule_state set
       is_running = false,
       last_run_at = coalesce($1, now()),
       next_run_at = coalesce($2, next_run_at),
       updated_at = now()
     where id = 1
     returning *`,
    [lastRunAt ?? null, nextRunAt ?? null],
  );
  return toBatchScheduleState(result.rows[0]);
}

export async function releaseProcessingLock(db, { lastRunAt, nextRunAt } = {}) {
  const result = await db.query(
    `update batch_schedule_state set
       is_running = false,
       processing_last_run_at = coalesce($1, now()),
       processing_next_run_at = coalesce($2, processing_next_run_at),
       updated_at = now()
     where id = 1
     returning *`,
    [lastRunAt ?? null, nextRunAt ?? null],
  );
  return toBatchScheduleState(result.rows[0]);
}

// Released without ever having done any work (e.g. discovery skipped this
// tick because a backlog still exists) -- just drops the lock, touches
// nothing else.
export async function releaseLockOnly(db) {
  const result = await db.query(
    `update batch_schedule_state set is_running = false, updated_at = now() where id = 1 returning *`,
  );
  return toBatchScheduleState(result.rows[0]);
}

const PRODUCT_STAGE_COLUMNS = Object.freeze({
  draft: 'draft',
  analysis: 'analysis',
  images: 'images',
  discovery: 'discovery',
});

export async function completeProductStage(db, stage, { serviceDate, nextRunAt, outcome } = {}) {
  const prefix = PRODUCT_STAGE_COLUMNS[stage];
  if (!prefix) throw new TypeError(`unknown product stage: ${stage}`);
  const nextColumn = stage === 'discovery' ? 'next_run_at' : `${prefix}_next_run_at`;
  const lastRunColumn = stage === 'discovery' ? 'last_run_at' : `${prefix}_last_run_at`;
  const result = await db.query(
    `update batch_schedule_state set
       is_running = false,
       ${lastRunColumn} = now(),
       ${prefix}_last_service_date = $1,
       ${nextColumn} = $2,
       ${prefix}_last_outcome = $3,
       updated_at = now()
     where id = 1
     returning *`,
    [serviceDate, nextRunAt, outcome],
  );
  return toBatchScheduleState(result.rows[0]);
}

export const releaseProductStageLock = releaseLockOnly;
