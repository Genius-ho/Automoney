import { runSupplierMonitorSweep } from './supplier-monitor.mjs';
import { getCoupangRegistration } from './coupang-registration-store.mjs';

// automoney_complete_automation_implementation_plan.md section 15.2 (Phase
// 10), first case: "주문 전 품절 → 발주 차단 → 채널 판매중지 → 관리자 알림". 발주 차단
// is already handled separately (purchase-order-builder.mjs's own live
// SUPPLIER_SOLD_OUT re-check on every draft build) -- this only adds the
// 채널 판매중지 side effect on top of Phase 6's existing sold-out detection.
// The second 15.2 case ("주문 후 공급처 품절 → 고객 취소/대체 처리 관리자 확인") needs no
// separate code: 13.2's revalidation sweep already re-blocks
// SUPPLIER_SOLD_OUT on the draft, visible in the 발주안 screen, which is
// where a human makes that call.

// vendorItemId isn't persisted anywhere in this app (Phase 7's mapping
// research confirmed no reverse lookup or stored per-option channel id
// exists) -- suspension has to enumerate the product's current live items
// first, same as order-supplier-mapper.mjs's live-scan fallback does.
export async function suspendCoupangListing(db, coupangClient, productDraftId, {
  getCoupangRegistrationImpl = getCoupangRegistration,
} = {}) {
  const registration = await getCoupangRegistrationImpl(db, productDraftId);
  if (!registration?.sellerProductId) return { suspended: false, reason: 'NOT_LINKED', items: [] };

  const live = await coupangClient.getProduct(registration.sellerProductId);
  const items = (live?.data?.items || []).filter((item) => item.vendorItemId);
  const results = [];
  for (const item of items) {
    try {
      await coupangClient.suspendSale(item.vendorItemId);
      results.push({ vendorItemId: item.vendorItemId, ok: true });
    } catch (error) {
      results.push({ vendorItemId: item.vendorItemId, ok: false, error: error.message });
    }
  }
  return { suspended: results.some((r) => r.ok), items: results };
}

async function findLinkedCoupangProductDraftIds(db, supplierProductId) {
  const result = await db.query(
    `select d.id from product_drafts d
     join coupang_product_registrations r on r.product_draft_id = d.id
     where d.supplier_product_id = $1 and r.seller_product_id is not null`,
    [supplierProductId],
  );
  return result.rows.map((row) => Number(row.id));
}

// Wraps runSupplierMonitorSweep -- same continue-past-failure shape as
// every other sweep in this codebase, plus a coupangSuspensions field
// appended onto any result that fired a SUPPLIER_OUT_OF_STOCK alert AND has
// a linked live Coupang listing.
export async function runSupplierMonitorAndSuspendSweep(db, domemeClient, coupangClient, {
  runSupplierMonitorSweepImpl = runSupplierMonitorSweep,
  findLinkedCoupangProductDraftIdsImpl = findLinkedCoupangProductDraftIds,
  suspendCoupangListingImpl = suspendCoupangListing,
} = {}) {
  const results = await runSupplierMonitorSweepImpl(db, domemeClient);
  for (const result of results) {
    const outOfStock = (result.alerts || []).some((alert) => alert.code === 'SUPPLIER_OUT_OF_STOCK');
    if (!outOfStock || !result.supplierProductId) continue;
    const draftIds = await findLinkedCoupangProductDraftIdsImpl(db, result.supplierProductId);
    result.coupangSuspensions = [];
    for (const draftId of draftIds) {
      try {
        const suspension = await suspendCoupangListingImpl(db, coupangClient, draftId);
        result.coupangSuspensions.push({ productDraftId: draftId, ...suspension });
      } catch (error) {
        result.coupangSuspensions.push({ productDraftId: draftId, suspended: false, error: error.message });
      }
    }
  }
  return results;
}
