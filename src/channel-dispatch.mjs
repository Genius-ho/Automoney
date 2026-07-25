import { getChannelOrder } from './channel-orders-store.mjs';
import { getSupplierOrder, listShippedNotDispatched, recordChannelShipmentResult } from './purchase-order-store.mjs';
import { mapCarrierCodeToCoupang } from './carrier-code-map.mjs';

// automoney_complete_automation_implementation_plan.md section 14.4 (Phase
// 9): 채널 발송 처리. 송장 확인(already collected -- see shipment-collector.mjs)
// → 주문 취소 여부 재확인 → 택배사 코드 변환 → 쿠팡 발송 처리 → 성공 여부 저장.
// Naver's own dispatch API isn't wired up yet -- apicenter.commerce.naver.com
// is blocked for both WebFetch and browser navigation in this environment,
// so its request/response shape couldn't be verified live the way every
// other endpoint in this app has been. A Naver channel order is recorded as
// 'unsupported_channel' (visible in the admin screen) rather than guessed at.

const CANCELLED_PATTERN = /CANCEL|취소/i;

function isCancelled(channelOrder) {
  return Boolean(channelOrder.cancelledAt) || CANCELLED_PATTERN.test(channelOrder.orderStatus || '');
}

// Coupang's own per-line unique key, `${shipmentBoxId}:${vendorItemId}`
// (order-collector.mjs's normalizeCoupangOrder) -- the invoice-upload API
// needs both ids as separate fields, so this undoes that join rather than
// re-deriving them from a fresh API call.
function parseCoupangShipmentKey(channelOrderItemId) {
  const [shipmentBoxId, vendorItemId] = String(channelOrderItemId || '').split(':');
  return shipmentBoxId && vendorItemId ? { shipmentBoxId, vendorItemId } : null;
}

export async function dispatchSupplierOrderToChannel(db, supplierOrderId, { coupangClient } = {}, {
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
  if (isCancelled(channelOrder)) {
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelShipStatus: 'cancelled_skip', channelShipError: '채널 주문이 취소되어 발송 처리를 건너뜀' });
  }

  if (channelOrder.channel !== 'coupang') {
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelShipStatus: 'unsupported_channel', channelShipError: `${channelOrder.channel} 발송 API 미구현` });
  }

  // 14.3 택배사 코드 정규화 -- "매핑 실패 시 자동 발송처리 금지".
  const channelCarrierCode = mapCarrierCodeToCoupang(supplierOrder.carrierCode);
  if (!channelCarrierCode) {
    return recordChannelShipmentResultImpl(db, supplierOrder.id, { channelShipStatus: 'mapping_failed', channelShipError: `매핑되지 않은 택배사 코드: ${supplierOrder.carrierCode}` });
  }

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

// Continues past a single dispatch failure, same shape as every other sweep
// (order-collector, supplier-monitor, purchase-order-builder, shipment-collector).
export async function runChannelDispatchSweep(db, { coupangClient } = {}, {
  listShippedNotDispatchedImpl = listShippedNotDispatched,
  dispatchSupplierOrderToChannelImpl = dispatchSupplierOrderToChannel,
} = {}) {
  const pending = await listShippedNotDispatchedImpl(db);
  const results = [];
  for (const order of pending) {
    try {
      results.push(await dispatchSupplierOrderToChannelImpl(db, order.id, { coupangClient }));
    } catch (error) {
      results.push({ supplierOrderId: order.id, error: error.message });
    }
  }
  return results;
}
