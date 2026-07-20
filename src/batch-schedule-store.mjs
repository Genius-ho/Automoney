function toBatchScheduleState(row) {
  return {
    intervalDays: row.interval_days,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    isRunning: row.is_running,
    minPassingScore: row.min_passing_score,
    updatedAt: row.updated_at,
  };
}

// Single-row settings (same pattern as coupang_seller_settings) holding the
// auto-discovery batch's schedule and running-lock state.
export async function getBatchScheduleState(db) {
  const result = await db.query('select * from batch_schedule_state where id = 1');
  return result.rows[0] ? toBatchScheduleState(result.rows[0]) : null;
}

export async function updateBatchScheduleState(db, { intervalDays, nextRunAt, minPassingScore } = {}) {
  const result = await db.query(
    `update batch_schedule_state set
       interval_days = coalesce($1, interval_days),
       next_run_at = coalesce($2, next_run_at),
       min_passing_score = coalesce($3, min_passing_score),
       updated_at = now()
     where id = 1
     returning *`,
    [intervalDays ?? null, nextRunAt ?? null, minPassingScore ?? null],
  );
  return toBatchScheduleState(result.rows[0]);
}

// Atomic compare-and-set: only succeeds (returns a row) when no batch is
// currently running. This is the single source of truth for "동시 실행 수 1"
// / "이전 배치가 실행 중이면 새 배치를 시작하지 않음" -- the WHERE clause
// makes the check-and-flip a single statement so two concurrent callers
// (the scheduler tick and a manual "지금 실행" click) can never both acquire
// the lock.
export async function tryAcquireBatchLock(db) {
  const result = await db.query(
    `update batch_schedule_state set is_running = true, updated_at = now()
     where id = 1 and is_running = false
     returning *`,
  );
  return result.rows[0] ? toBatchScheduleState(result.rows[0]) : null;
}

export async function releaseBatchLock(db, { lastRunAt, nextRunAt } = {}) {
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
