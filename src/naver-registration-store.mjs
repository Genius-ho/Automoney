function toRegistrationRow(row) {
  return {
    productDraftId: Number(row.product_draft_id),
    originProductNo: row.origin_product_no,
    channelProductNo: row.channel_product_no,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getNaverRegistration(db, productDraftId) {
  const result = await db.query('select * from naver_product_registrations where product_draft_id = $1', [productDraftId]);
  return result.rows[0] ? toRegistrationRow({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}

// Deliberately `on conflict ... do nothing`, not `do update` -- mirrors
// coupang-registration-store.mjs's recordDirectRegistration: a row already
// existing for this draft means it was already registered by some path, and
// overwriting it would erase the dedup guard this table exists to provide.
// Returns null when nothing was inserted so the caller can tell "already
// registered" apart from "just registered".
export async function recordNaverDirectRegistration(db, productDraftId, { originProductNo, channelProductNo = null, requestHash }) {
  if (!originProductNo) throw new Error('originProductNo is required');
  if (!requestHash) throw new Error('requestHash is required');
  const result = await db.query(
    `insert into naver_product_registrations (product_draft_id, origin_product_no, channel_product_no, request_hash, status)
     values ($1, $2, $3, $4, 'created')
     on conflict (product_draft_id) do nothing
     returning *`,
    [productDraftId, String(originProductNo), channelProductNo ? String(channelProductNo) : null, requestHash],
  );
  return result.rows[0] ? toRegistrationRow({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}
