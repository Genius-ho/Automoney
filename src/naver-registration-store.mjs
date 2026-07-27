function toRegistrationRow(row) {
  return {
    productDraftId: Number(row.product_draft_id),
    originProductNo: row.origin_product_no,
    channelProductNo: row.channel_product_no,
    status: row.status,
    linkedVia: row.linked_via,
    imagesSwappedAt: row.images_swapped_at,
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
    `insert into naver_product_registrations (product_draft_id, origin_product_no, channel_product_no, request_hash, status, linked_via)
     values ($1, $2, $3, $4, 'created', 'direct_api')
     on conflict (product_draft_id) do nothing
     returning *`,
    [productDraftId, String(originProductNo), channelProductNo ? String(channelProductNo) : null, requestHash],
  );
  return result.rows[0] ? toRegistrationRow({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}

// Explicit, user-confirmed link between a locally-tracked draft and an
// originProductNo the user found on Naver's own seller center (i.e. a
// listing registered externally through 스피드등록, not through this app's
// own createOriginProduct() pipeline) -- never called automatically. There's
// no confirmed "search products by name" endpoint for Naver Commerce in this
// codebase (unlike Coupang's listSellerProducts), so unlike
// linkCoupangRegistration this takes the originProductNo directly rather
// than a search-result pick.
export async function linkNaverRegistration(db, productDraftId, { originProductNo }) {
  if (!originProductNo) throw new Error('originProductNo is required');
  const requestHash = `speedgo:${originProductNo}`;
  const result = await db.query(
    `insert into naver_product_registrations (product_draft_id, origin_product_no, request_hash, status, linked_via)
     values ($1, $2, $3, 'linked', 'speedgo_link')
     on conflict (product_draft_id) do update set
       origin_product_no = excluded.origin_product_no,
       linked_via = 'speedgo_link',
       status = 'linked',
       updated_at = now()
     returning *`,
    [productDraftId, String(originProductNo), requestHash],
  );
  return toRegistrationRow({ ...result.rows[0], product_draft_id: productDraftId });
}

// Mirrors coupang-registration-store.mjs's recordImagesSwapped.
export async function recordImagesSwapped(db, productDraftId) {
  const result = await db.query(
    `update naver_product_registrations set status = 'images_swapped', images_swapped_at = now(), updated_at = now()
     where product_draft_id = $1 returning *`,
    [productDraftId],
  );
  return result.rows[0] ? toRegistrationRow({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}
