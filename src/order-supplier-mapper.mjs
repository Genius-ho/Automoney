import { recordLiveSnapshot } from './coupang-registration-store.mjs';
import { updateChannelOrderMapping } from './channel-orders-store.mjs';

// automoney_complete_automation_implementation_plan.md section 12.4 (Phase 7):
// 쿠팡 vendorItemId 또는 네이버 channelProductNo → channel_product → draft →
// supplier_product_id. There's no `channel_product` table (order-collector.mjs's
// Explore pass found none) -- Naver's link is exact and free, since
// naver_product_registrations already stores channel_product_no/origin_product_no
// at registration time. Coupang has no persisted vendorItemId anywhere, and
// WING's seller API has no reverse vendorItemId -> sellerProductId lookup
// endpoint (confirmed against Coupang's own docs, 2026-07-25) -- so it's
// resolved by scanning each linked product's item list instead: cached
// live_item_snapshot_json first (free), falling back to a live getProduct()
// call -- cached as it goes via recordLiveSnapshot -- only for products with
// no cached snapshot yet.

export async function resolveNaverProductDraft(db, channelProductId) {
  if (!channelProductId) return null;
  const result = await db.query(
    `select r.product_draft_id, d.supplier_product_id
     from naver_product_registrations r
     join product_drafts d on d.id = r.product_draft_id
     where r.channel_product_no = $1 or r.origin_product_no = $1
     limit 1`,
    [String(channelProductId)],
  );
  const row = result.rows[0];
  return row ? toMatch(row) : null;
}

export async function resolveCoupangProductDraft(db, client, vendorItemId, {
  recordLiveSnapshotImpl = recordLiveSnapshot,
} = {}) {
  if (!vendorItemId || !client) return null;
  const vendorItemIdStr = String(vendorItemId);
  const linked = await db.query(
    `select r.product_draft_id, r.seller_product_id, r.live_item_snapshot_json, d.supplier_product_id
     from coupang_product_registrations r
     join product_drafts d on d.id = r.product_draft_id
     where r.seller_product_id is not null`,
  );

  for (const row of linked.rows) {
    if (itemsContainVendorItem(row.live_item_snapshot_json, vendorItemIdStr)) return toMatch(row);
  }

  // Cache miss against every already-snapshotted product -- refresh only the
  // ones with no snapshot at all yet (vendorItemId is immutable per Coupang's
  // docs, so a snapshot that was already checked above and didn't match is
  // trusted rather than re-fetched on every unmapped order).
  for (const row of linked.rows) {
    if (row.live_item_snapshot_json) continue;
    const live = await client.getProduct(row.seller_product_id);
    const items = live?.data?.items || [];
    await recordLiveSnapshotImpl(db, Number(row.product_draft_id), {
      statusName: live?.data?.statusName ?? null,
      totalStockQuantity: items.reduce((sum, item) => sum + (Number(item.maximumBuyCount) || 0), 0),
      salePrice: items[0]?.salePrice ?? null,
      itemSnapshotJson: items,
    });
    if (itemsContainVendorItem(items, vendorItemIdStr)) return toMatch(row);
  }
  return null;
}

function itemsContainVendorItem(items, vendorItemIdStr) {
  return Array.isArray(items) && items.some((item) => String(item.vendorItemId) === vendorItemIdStr);
}

function toMatch(row) {
  return {
    productDraftId: Number(row.product_draft_id),
    supplierProductId: row.supplier_product_id == null ? null : Number(row.supplier_product_id),
  };
}

// Called once per collected order line (order-collector.mjs), right after
// it's upserted -- a no-op for anything not still sitting at
// 'mapping_required' (already mapped, or missing a channel_product_id to
// even attempt with). coupangClientImpl is only needed for channel='coupang'
// -- omit it for the Naver collection path.
export async function mapChannelOrder(db, order, {
  coupangClientImpl = null,
  resolveNaverProductDraftImpl = resolveNaverProductDraft,
  resolveCoupangProductDraftImpl = resolveCoupangProductDraft,
  updateChannelOrderMappingImpl = updateChannelOrderMapping,
} = {}) {
  if (order.supplierMappingStatus !== 'mapping_required' || !order.channelProductId) return order;

  let match = null;
  if (order.channel === 'naver') {
    match = await resolveNaverProductDraftImpl(db, order.channelProductId);
  } else if (order.channel === 'coupang') {
    match = await resolveCoupangProductDraftImpl(db, coupangClientImpl, order.channelProductId);
  }
  if (!match) return order;

  return updateChannelOrderMappingImpl(db, order.id, {
    supplierMappingStatus: 'mapped',
    productDraftId: match.productDraftId,
    supplierProductId: match.supplierProductId,
  });
}
