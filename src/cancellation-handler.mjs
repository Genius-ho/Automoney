import { listSupplierOrders, recordSupplierOrderCancellation } from './purchase-order-store.mjs';
import { getChannelOrder } from './channel-orders-store.mjs';
import { isChannelOrderCancelled } from './channel-order-status.mjs';
import { createOrderException, getOrderException, resolveOrderException } from './order-exception-store.mjs';

// automoney_complete_automation_implementation_plan.md section 15.1 (Phase
// 10), the other two of the three 주문 취소 cases (the third -- "도매매 미발주"
// -- is handled directly inside purchase-order-builder.mjs's own
// short-circuit to status='cancelled', since that case never needs a
// separate sweep or exception row at all):
//
//   도매매 발주 완료, 미출고 → 공급처 취소 가능 여부 관리자 확인  (CANCEL_NOT_SHIPPED)
//   이미 출고 → 자동 처리 금지 → 관리자 예외 큐            (CANCEL_ALREADY_SHIPPED)
//
// "이미 출고" is read off supplier_orders.tracking_number -- shipment-collector.mjs
// only ever sets that once 도매매's own delivery.code appears, which is the
// same "발송됨" fact this needs.
export async function runCancellationExceptionSweep(db, {
  listSupplierOrdersImpl = listSupplierOrders,
  getChannelOrderImpl = getChannelOrder,
  createOrderExceptionImpl = createOrderException,
} = {}) {
  const ordered = await listSupplierOrdersImpl(db, { status: 'supplier_ordered' });
  const results = [];
  for (const supplierOrder of ordered) {
    try {
      const channelOrder = await getChannelOrderImpl(db, supplierOrder.channelOrderId);
      if (!channelOrder || !isChannelOrderCancelled(channelOrder)) continue;
      const exceptionType = supplierOrder.trackingNumber ? 'CANCEL_ALREADY_SHIPPED' : 'CANCEL_NOT_SHIPPED';
      results.push(await createOrderExceptionImpl(db, {
        channelOrderId: channelOrder.id,
        supplierOrderId: supplierOrder.id,
        exceptionType,
        detail: {
          domemeOrderNo: supplierOrder.domemeOrderNo,
          trackingNumber: supplierOrder.trackingNumber,
          channelOrderStatus: channelOrder.orderStatus,
        },
      }));
    } catch (error) {
      results.push({ supplierOrderId: supplierOrder.id, error: error.message });
    }
  }
  return results;
}

// The one admin action for a CANCEL_NOT_SHIPPED exception -- 15.1 explicitly
// requires a human to confirm this ("공급처 취소 가능 여부 관리자 확인"), never
// automatic. Calls the real domeme cancelOrder() (Phase 8's client);
// success resolves the exception, failure leaves it open with the domeme
// error attached so the admin can see why and retry or fall back to manual
// handling on 도매매's own site.
export async function attemptSupplierCancellation(db, domemeClient, exceptionId, { sId, memo = '채널 주문 취소로 인한 발주 취소 요청' }, {
  getOrderExceptionImpl = getOrderException,
  resolveOrderExceptionImpl = resolveOrderException,
  recordSupplierOrderCancellationImpl = recordSupplierOrderCancellation,
} = {}) {
  const exception = await getOrderExceptionImpl(db, exceptionId);
  if (!exception) throw Object.assign(new Error('Order exception not found'), { code: 'NOT_FOUND' });
  if (exception.status !== 'open') throw Object.assign(new Error(`Exception is already ${exception.status}`), { code: 'NOT_OPEN' });
  if (exception.exceptionType !== 'CANCEL_NOT_SHIPPED') {
    throw Object.assign(new Error(`Supplier cancellation only applies to CANCEL_NOT_SHIPPED, not ${exception.exceptionType}`), { code: 'WRONG_EXCEPTION_TYPE' });
  }

  const orderNo = exception.detail?.domemeOrderNo;
  if (!orderNo) throw Object.assign(new Error('No domeme order number on this exception'), { code: 'NO_ORDER_NUMBER' });

  const result = await domemeClient.cancelOrder({ sId, orderNo, memo });
  if (result.result === 'complete' || result.result === 'req' || result.result === 'true') {
    if (exception.supplierOrderId) {
      await recordSupplierOrderCancellationImpl(db, exception.supplierOrderId, { note: `채널 주문 취소로 공급처 발주 취소됨 (result=${result.result})` });
    }
    return resolveOrderExceptionImpl(db, exceptionId, { resolutionNote: `공급처 취소 요청 완료 (result=${result.result})` });
  }
  return { exception, domemeResult: result };
}
