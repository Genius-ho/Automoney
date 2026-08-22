import { listOrderedWithoutTracking, recordSupplierShipment } from './purchase-order-store.mjs';
import { getValidDomemeSId } from './domeme-private-session.mjs';

// automoney_complete_automation_implementation_plan.md section 14.2 (Phase 9):
// 송장 수집. Confirmed live 2026-07-25 against a real order's getOrderView
// response: delivery.company (carrier code, e.g. "HYUNDAI"), delivery.
// companyName (Korean display name, e.g. "롯데택배"), delivery.code (tracking
// number), delivery.dateStart (ship date, unix seconds as a string).
// delivery.code is absent/empty until the supplier has actually shipped --
// extractShipmentInfo returns null in that case so the sweep just leaves
// the order for the next run instead of writing a false shipment.
export function extractShipmentInfo(orderDetail) {
  const delivery = orderDetail?.delivery;
  if (!delivery?.code) return null;
  const dateStart = Number(delivery.dateStart);
  return {
    carrierCode: delivery.company || null,
    carrierName: delivery.companyName || null,
    trackingNumber: String(delivery.code),
    shippedAt: Number.isFinite(dateStart) && dateStart > 0 ? new Date(dateStart * 1000).toISOString() : null,
  };
}

export async function collectSupplierShipment(db, domemeClient, supplierOrder, {
  getValidDomemeSIdImpl = getValidDomemeSId,
  recordSupplierShipmentImpl = recordSupplierShipment,
} = {}) {
  if (!supplierOrder.domemeOrderNo) return null;
  const sId = await getValidDomemeSIdImpl(db, domemeClient);
  const orderDetail = await domemeClient.getOrder({ sId, orderNo: supplierOrder.domemeOrderNo });
  const shipment = extractShipmentInfo(orderDetail);
  if (!shipment) return null;
  return recordSupplierShipmentImpl(db, supplierOrder.id, shipment);
}

// Continues past a single lookup failure the same way every other sweep in
// this codebase does (order-collector, supplier-monitor, purchase-order-
// builder) -- one bad getOrder() call shouldn't block the rest of the queue.
export async function runShipmentCollectionSweep(db, domemeClient, {
  listOrderedWithoutTrackingImpl = listOrderedWithoutTracking,
  collectSupplierShipmentImpl = collectSupplierShipment,
} = {}) {
  const pending = await listOrderedWithoutTrackingImpl(db);
  const results = [];
  for (const order of pending) {
    try {
      results.push(await collectSupplierShipmentImpl(db, domemeClient, order));
    } catch (error) {
      results.push({ supplierOrderId: order.id, error: error.message });
    }
  }
  return results;
}
