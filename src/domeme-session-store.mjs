function toSession(row) {
  if (!row?.s_id) return null;
  return {
    sId: row.s_id,
    cId: row.c_id,
    grade: row.grade,
    sIdRenewDate: row.s_id_renew_date == null ? null : Number(row.s_id_renew_date),
    loggedInAt: row.logged_in_at,
    updatedAt: row.updated_at,
  };
}

export async function getDomemeSession(db) {
  const result = await db.query('select * from domeme_session_state where id = 1');
  return toSession(result.rows[0]);
}

export async function saveDomemeSession(db, { sId, cId, grade, sIdRenewDate }) {
  if (!sId) throw new Error('sId is required');
  const result = await db.query(
    `insert into domeme_session_state (id, s_id, c_id, grade, s_id_renew_date, logged_in_at, updated_at)
     values (1, $1, $2, $3, $4, now(), now())
     on conflict (id) do update set
       s_id = excluded.s_id,
       c_id = excluded.c_id,
       grade = excluded.grade,
       s_id_renew_date = excluded.s_id_renew_date,
       logged_in_at = now(),
       updated_at = now()
     returning *`,
    [sId, cId ?? null, grade ?? null, sIdRenewDate ?? null],
  );
  return toSession(result.rows[0]);
}

// Only updates the renewal timestamp (from setLoginChk) without touching
// logged_in_at -- a distinct write path from saveDomemeSession's full
// login-replace, so "when did we last actually log in" survives a renewal.
export async function touchDomemeSessionRenewal(db, sIdRenewDate) {
  const result = await db.query(
    `update domeme_session_state set s_id_renew_date = $1, updated_at = now()
     where id = 1 returning *`,
    [sIdRenewDate ?? null],
  );
  return toSession(result.rows[0]);
}

export async function clearDomemeSession(db) {
  await db.query(
    `update domeme_session_state set s_id = null, c_id = null, grade = null, s_id_renew_date = null, updated_at = now()
     where id = 1`,
  );
}
