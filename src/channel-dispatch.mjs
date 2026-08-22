import { getChannelOrder } from './channel-orders-store.mjs';
import { getSupplierOrder, listShippedNotDispatched, recordChannelShipmentResult } from './purchase-order-store.mjs';
import { mapCarrierCode } from './carrier-code-map.mjs';
import { isChannelOrderCancelled } from './channel-order-status.mjs';

// automoney_complete_automation_implementation_plan.md section 14.4 (Phase
// 9): 채널 발송 처리. 송장 확인(already collected -- see shipment-collector.mjs)
// → 주문 취소 여부 재확인 → 택배사 코드 변환 → 쿠팡/네이버 발송 처리 → 성공 여부 저장.
// Naver requires an explicit 발주확인 (confirmProductOrders) call before
// dispatchProductOrders will move a product order's placeOrderStatus --
// confirmed via the same source as the dispatch spec itself
// (apicenter.commerce.naver.com, pasted directly by the user since the docs
// site is blocked for WebFetch/browser navigation in this environment).

// Coupang's own per-line unique key, `${shipmentBoxId}:${vendorItemId}`
// (order-collector.mjs's normalizeCoupangOrder) -- the invoice-upload API
// needs both ids as separate fields, so this undoes that join rather than
// re-deriving them from a fresh API call.
function parseCoupangShipmentKey(channelOrderItemId) {
  const [shipmentBoxId, vendorItemId] = String(channelOrderItemId || '').split(':');
  return shipmentBoxId && vendorItemId ? { shipmentBoxId, vendorItemId } : null;
}

// Naver's own per-line order unit already IS the dedup key
// (order-collector.mjs's normalizeNaverOrder / Phase 7), so
// channel_order_item_id is the productOrderId directly -- no parsing needed.
async function dispatchCoupang(db, supplierOrder, channelOrder, coupangClient, recordChannelShipmentResultImpl, channelCarrierCode) {
  const shipmentKey = parseCoupangShipmentKey(channelOrder.channelOrderItemId);
  if (!shipmentKey) {
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'mapping_failed', channelShipError: 'channel_order_item_id에서 shipmentBoxId/vendorItemId 파싱 실패' });
  }
  try {
    await coupangClient.uploadInvoice({
      shipmentBoxId: Number(shipmentKey.shipmentBoxId),
      orderId: Number(channelOrder.channelOrderId),
      vendorItemId: Number(shipmentKey.vendorItemId),
      deliveryCompanyCode: channelCarrierCode,
      invoiceNumber: supplierOrder.trackingNumber,
    });
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'sent' });
  } catch (error) {
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'failed', channelShipError: error.message });
  }
}

function findFailure(result, productOrderId) {
  return (result?.data?.failProductOrderInfos || []).find((f) => f.productOrderId === productOrderId);
}

async function dispatchNaver(db, supplierOrder, channelOrder, naverClient, recordChannelShipmentResultImpl, channelCarrierCode) {
  const productOrderId = channelOrder.channelOrderItemId;
  try {
    const confirmResult = await naverClient.confirmProductOrders([productOrderId]);
    const confirmFailure = findFailure(confirmResult, productOrderId);
    if (confirmFailure) {
      return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'failed', channelShipError: `발주확인 실패: ${confirmFailure.code} ${confirmFailure.message}` });
    }

    const dispatchResult = await naverClient.dispatchProductOrders([{
      productOrderId,
      deliveryMethod: 'DELIVERY',
      deliveryCompanyCode: channelCarrierCode,
      trackingNumber: supplierOrder.trackingNumber,
      dispatchDate: supplierOrder.shippedAt || new Date().toISOString(),
    }]);
    const dispatchFailure = findFailure(dispatchResult, productOrderId);
    if (dispatchFailure) {
      return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'failed', channelShipError: `발송처리 실패: ${dispatchFailure.code} ${dispatchFailure.message}` });
    }
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'sent' });
  } catch (error) {
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'failed', channelShipError: error.message });
  }
}

export async function dispatchSupplierOrderToChannel(db, supplierOrderId, { coupangClient, naverClient } = {}, {
  getSupplierOrderImpl = getSupplierOrder,
  getChannelOrderImpl = getChannelOrder,
  recordChannelShipmentResultImpl = recordChannelShipmentResult,
} = {}) {
  const supplierOrder = await getSupplierOrderImpl(db, supplierOrderId);
  if (!supplierOrder) throw Object.assign(new Error('Supplier order not found'), { code: 'NOT_FOUND' });
  if (!supplierOrder.trackingNumber) throw Object.assign(new Error('No tracking number collected yet'), { code: 'NO_TRACKING' });
  if (supplierOrder.channelShipStatus === 'sent') return supplierOrder;

  const channelOrder = await getChannelOrderImpl(db, supplierOrder.channelOrderId);
  if (!channelOrder) throw Object.assign(new Error('Channel order not found'), { code: 'CHANNEL_ORDER_NOT_FOUND' });

  // 14.4 "주문 취소 여부 재확인" -- a cancellation that landed after the order
  // was already placed with the supplier still must not be shipped onward.
  if (isChannelOrderCancelled(channelOrder)) {
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelShipStatus: 'cancelled_skip', channelShipError: '채널 주문이 취소되어 발송 처리를 건너뜀' });
  }

  // 14.3 택배사 코드 정규화 -- "매핑 실패 시 자동 발송처리 금지".
  const channelCarrierCode = mapCarrierCode(supplierOrder.carrierCode);
  if (!channelCarrierCode) {
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelShipStatus: 'mapping_failed', channelShipError: `매핑되지 않은 택배사 코드: ${supplierOrder.carrierCode}` });
  }

  if (channelOrder.channel === 'coupang') {
    if (!coupangClient) return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'unsupported_channel', channelShipError: 'coupangClient가 제공되지 않음' });
    return dispatchCoupang(db, supplierOrder, channelOrder, coupangClient, recordChannelShipmentResultImpl, channelCarrierCode);
  }
  if (channelOrder.channel === 'naver') {
    if (!naverClient) return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'unsupported_channel', channelShipError: 'naverClient가 제공되지 않음' });
    return dispatchNaver(db, supplierOrder, channelOrder, naverClient, recordChannelShipmentResultImpl, channelCarrierCode);
  }
  return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelCarrierCode, channelShipStatus: 'unsupported_channel', channelShipError: `${channelOrder.channel} 발송 API 미구현` });
}

// Continues past a single dispatch failure, same shape as every other sweep
// (order-collector, supplier-monitor, purchase-order-builder, shipment-collector).
export async function runChannelDispatchSweep(db, { coupangClient, naverClient } = {}, {
  listShippedNotDispatchedImpl = listShippedNotDispatched,
  dispatchSupplierOrderToChannelImpl = dispatchSupplierOrderToChannel,
} = {}) {
  const pending = await listShippedNotDispatchedImpl(db);
  const results = [];
  for (const order of pending) {
    try {
      results.push(await dispatchSupplierOrderToChannelImpl(db, order.id, { coupangClient, naverClient }));
    } catch (error) {
      results.push({ supplierOrderId: order.id, error: error.message });
    }
  }
  return results;
}
