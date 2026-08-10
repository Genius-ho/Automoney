function toRegistrationListItem(row) {
  return {
    productDraftId: Number(row.product_draft_id),
    sellingTitle: row.selling_title,
    optimizedCoupangTitle: row.optimized_coupang_title,
    sellerProductId: row.seller_product_id,
    sellerProductName: row.seller_product_name,
    linkedVia: row.linked_via,
    status: row.status,
    requested: row.requested,
    imagesSwappedAt: row.images_swapped_at,
    lastSyncedAt: row.last_synced_at,
    liveStatusName: row.live_status_name,
    liveTotalStockQuantity: row.live_total_stock_quantity,
    liveSalePrice: row.live_sale_price,
    approvalRequestedAt: row.approval_requested_at,
    approvalResponseMessage: row.approval_response_message,
    telegramNotifiedAt: row.telegram_notified_at ?? null,
    telegramMessageId: row.telegram_message_id == null ? null : Number(row.telegram_message_id),
  };
}

export async function listCoupangRegistrationsAwaitingTelegramNotification(db) {
  const result = await db.query(
    `select
       r.product_draft_id,
       r.seller_product_id,
       r.seller_product_name,
       r.status,
       r.requested,
       d.coupang_sale_price as sale_price,
       coalesce(
         jsonb_agg(
           jsonb_build_object('name', o.value, 'stockQuantity', o.stock_quantity)
           order by o.option_index
         ) filter (where o.id is not null),
         '[]'::jsonb
       ) as options
     from coupang_product_registrations r
     join product_drafts d on d.id = r.product_draft_id
     left join product_options o on o.product_draft_id = d.id
     where r.seller_product_id is not null
       and r.status = 'created'
       and r.requested = false
       and r.telegram_notified_at is null
     group by r.product_draft_id, r.seller_product_id, r.seller_product_name, r.status, r.requested, d.coupang_sale_price
     order by r.created_at`,
    [],
  );
  return result.rows.map((row) => ({
    ...toRegistrationListItem(row),
    salePrice: row.sale_price == null ? null : Number(row.sale_price),
    options: row.options || [],
  }));
}

export async function markCoupangRegistrationTelegramNotified(db, productDraftId, messageId) {
  const result = await db.query(
    `update coupang_product_registrations
        set telegram_notified_at = now(), telegram_message_id = $2, updated_at = now()
      where product_draft_id = $1
      returning *`,
    [productDraftId, messageId],
  );
  return result.rows[0] ? toRegistrationListItem({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}

// Left-joins every draft against coupang_product_registrations so both
// unlinked 등록후보 drafts (stage 2 candidates to link) and already-linked
// drafts (stage 3 tracking) come from one query. `onlyLinked` narrows to the
// stage-3 view.
export async function listCoupangRegistrations(db, { onlyLinked = false } = {}) {
  const where = onlyLinked
    ? 'where r.seller_product_id is not null'
    : `where r.seller_product_id is not null or (
        d.status <> 'blocked'
        and jsonb_array_length(coalesce(d.block_reasons, '[]'::jsonb)) = 0
        and coalesce(d.min_order_qty, 1) < 5
        and nmr.winner_status = 'candidate'
        and coalesce(d.naver_expected_profit, 0) >= 3000
      )`;
  const result = await db.query(
    `
      select
        d.id as product_draft_id,
        d.selling_title,
        d.optimized_coupang_title,
        r.seller_product_id,
        r.seller_product_name,
        r.linked_via,
        r.status,
        r.images_swapped_at,
        r.last_synced_at,
        r.live_status_name,
        r.live_total_stock_quantity,
        r.live_sale_price
      from product_drafts d
      left join coupang_product_registrations r on r.product_draft_id = d.id
      left join market_research_results nmr on nmr.product_draft_id = d.id and nmr.marketplace = 'naver'
      ${where}
      order by (r.seller_product_id is null) desc, d.updated_at desc, d.id desc
    `,
  );
  return result.rows.map(toRegistrationListItem);
}

export async function getCoupangRegistration(db, productDraftId) {
  const result = await db.query('select * from coupang_product_registrations where product_draft_id = $1', [productDraftId]);
  return result.rows[0] ? toRegistrationListItem({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}

// Explicit, user-confirmed link between a locally-tracked draft and a
// sellerProductId found via Coupang's own seller-products lookup (i.e. a
// listing registered externally through 스피드고전송기, not through this
// app's own create-product pipeline) -- never called automatically.
export async function linkCoupangRegistration(db, productDraftId, { sellerProductId, sellerProductName }) {
  if (!sellerProductId) throw new Error('sellerProductId is required');
  const requestHash = `speedgo:${sellerProductId}`;
  const result = await db.query(
    `insert into coupang_product_registrations (product_draft_id, seller_product_id, seller_product_name, request_hash, status, linked_via, requested)
     values ($1, $2, $3, $4, 'linked', 'speedgo_lookup', false)
     on conflict (product_draft_id) do update set
       seller_product_id = excluded.seller_product_id,
       seller_product_name = excluded.seller_product_name,
       linked_via = 'speedgo_lookup',
       status = 'linked',
       updated_at = now()
     returning *`,
    [productDraftId, String(sellerProductId), sellerProductName || null, requestHash],
  );
  return toRegistrationListItem({ ...result.rows[0], product_draft_id: productDraftId });
}

// Persists the sellerProductId returned by this app's OWN createProduct()
// call (the new direct-registration flow), as opposed to linkCoupangRegistration
// (a listing found after being registered externally via 스피드고전송기).
// Deliberately `on conflict ... do nothing`, not `do update` -- a row already
// existing for this draft means it was already registered by *some* path
// (this flow, a prior direct-API run, or a speedgo link), and silently
// overwriting it would erase the dedup guard this table exists to provide.
// Returns null (not the existing row) when nothing was inserted, so the
// caller can tell "already registered" apart from "just registered".
export async function recordDirectRegistration(db, productDraftId, { sellerProductId, sellerProductName = null, requestHash }) {
  if (!sellerProductId) throw new Error('sellerProductId is required');
  if (!requestHash) throw new Error('requestHash is required');
  const result = await db.query(
    `insert into coupang_product_registrations (product_draft_id, seller_product_id, seller_product_name, request_hash, status, linked_via, requested)
     values ($1, $2, $3, $4, 'created', 'direct_api', false)
     on conflict (product_draft_id) do nothing
     returning *`,
    [productDraftId, String(sellerProductId), sellerProductName, requestHash],
  );
  return result.rows[0] ? toRegistrationListItem({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}

export async function recordImagesSwapped(db, productDraftId) {
  const result = await db.query(
    `update coupang_product_registrations set status = 'images_swapped', images_swapped_at = now(), updated_at = now()
     where product_draft_id = $1 returning *`,
    [productDraftId],
  );
  return result.rows[0] ? toRegistrationListItem({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}

// Marks a draft's registration as sale-approval-requested (WING's
// requestApproval endpoint was called exactly once for it) and stores
// Coupang's own response message for the audit trail. Never flips `requested`
// back to false -- this is a one-way transition mirroring the real,
// irreversible WING action.
export async function recordApprovalRequested(db, productDraftId, { statusName = null, responseMessage = null } = {}) {
  const result = await db.query(
    `update coupang_product_registrations set
       status = 'approval_requested',
       requested = true,
       approval_requested_at = now(),
       approval_response_message = $2,
       live_status_name = coalesce($3, live_status_name),
       updated_at = now()
     where product_draft_id = $1 returning *`,
    [productDraftId, responseMessage, statusName],
  );
  return result.rows[0] ? toRegistrationListItem({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}

export async function recordLiveSnapshot(db, productDraftId, { statusName, totalStockQuantity, salePrice, itemSnapshotJson }) {
  const result = await db.query(
    `update coupang_product_registrations set
       live_status_name = $2,
       live_total_stock_quantity = $3,
       live_sale_price = $4,
       live_item_snapshot_json = $5::jsonb,
       last_synced_at = now(),
       updated_at = now()
     where product_draft_id = $1 returning *`,
    [productDraftId, statusName || null, totalStockQuantity ?? null, salePrice ?? null, JSON.stringify(itemSnapshotJson || [])],
  );
  return result.rows[0] ? toRegistrationListItem({ ...result.rows[0], product_draft_id: productDraftId }) : null;
}
