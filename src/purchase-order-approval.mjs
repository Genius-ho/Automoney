import { getSupplierOrder, getDraftOrderingContext, markSupplierOrdering, recordSupplierOrderSuccess, recordSupplierOrderFailure } from './purchase-order-store.mjs';
import { getChannelOrder } from './channel-orders-store.mjs';
import { buildSupplierOrderDraft } from './purchase-order-builder.mjs';
import { DomemePrivateApiError } from './domeme-private-client.mjs';
import { getValidDomemeSId } from './domeme-private-session.mjs';

const SHOP_NAME = 'automoney';

// channel_orders.address is one combined string (see order-collector.mjs's
// normalizeCoupangOrder: addr1+addr2 already joined) -- 도매매's deliinfo wants
// address1/address2 separately, and requires both. There's no reliable way
// to split a free-text combined address back into the two without risking
// getting it wrong, so this puts the whole thing in address1 and leaves
// address2 empty; if 도매매 rejects that as ORDER_CONSUMER_ERROR, it comes
// back as a clean, visible failure (recordSupplierOrderFailure) rather than
// a wrong delivery -- not silently guessed around.
function buildDeliInfoFromChannelOrder(channelOrder) {
  return {
    name: channelOrder.recipientName,
    zipcode: channelOrder.postalCode,
    address1: channelOrder.address,
    address2: '',
    mobile: channelOrder.phone,
    shopName: SHOP_NAME,
  };
}

// The only place in this app allowed to call domemeClient.createOrder() --
// real money leaves the moment this succeeds. Only ever invoked from an
// explicit admin action (never a sweep/schedule), and re-validates one more
// time immediately before ordering (13.2) rather than trusting whatever the
// last background sweep computed.
export async function approveSupplierOrder(db, domemeClient, supplierOrderId, {
  getSupplierOrderImpl = getSupplierOrder,
  getChannelOrderImpl = getChannelOrder,
  getDraftOrderingContextImpl = getDraftOrderingContext,
  buildSupplierOrderDraftImpl = buildSupplierOrderDraft,
  markSupplierOrderingImpl = markSupplierOrdering,
  recordSupplierOrderSuccessImpl = recordSupplierOrderSuccess,
  recordSupplierOrderFailureImpl = recordSupplierOrderFailure,
  getValidDomemeSIdImpl = getValidDomemeSId,
} = {}) {
  const existing = await getSupplierOrderImpl(db, supplierOrderId);
  if (!existing) throw Object.assign(new Error('Supplier order not found'), { code: 'NOT_FOUND' });
  if (existing.status !== 'awaiting_purchase_approval') {
    throw Object.assign(new Error(`Cannot approve a supplier order in status '${existing.status}'`), { code: 'NOT_APPROVABLE' });
  }

  const channelOrder = await getChannelOrderImpl(db, existing.channelOrderId);
  if (!channelOrder) throw Object.assign(new Error('Channel order not found'), { code: 'CHANNEL_ORDER_NOT_FOUND' });

  const refreshed = await buildSupplierOrderDraftImpl(db, domemeClient, channelOrder);
  if (refreshed.status !== 'awaiting_purchase_approval') {
    // No longer clean as of right now -- block_reasons already persisted by
    // the rebuild above. Do not proceed to a real order.
    return refreshed;
  }

  const locked = await markSupplierOrderingImpl(db, refreshed.id);
  if (!locked) {
    throw Object.assign(new Error('Supplier order is no longer awaiting approval (already being processed)'), { code: 'ALREADY_IN_PROGRESS' });
  }

  const context = await getDraftOrderingContextImpl(db, locked.productDraftId);

  try {
    const sId = await getValidDomemeSIdImpl(db, domemeClient);
    const result = await domemeClient.createOrder({
      sId,
      receipt: 0,
      items: [{
        itemNo: context.supplierProductNo,
        market: locked.supplierMarket,
        deliveryWho: 'P',
        options: [{ code: locked.supplierOptionCode, qty: locked.supplierOrderQty }],
        sellerMemo: `automoney ${channelOrder.channel} ${channelOrder.channelOrderId}`.slice(0, 256),
        deliveryRequest: (channelOrder.deliveryMemo || '').slice(0, 256),
      }],
      deliInfo: buildDeliInfoFromChannelOrder(channelOrder),
    });
    const order = result.orders[0];
    return recordSupplierOrderSuccessImpl(db, locked.id, { domemeOrderNo: order ? String(order.orderNo) : null });
  } catch (error) {
    const message = error instanceof DomemePrivateApiError
      ? `${error.dcode || 'ERROR'}: ${error.dmessage || error.message}`
      : error.message;
    return recordSupplierOrderFailureImpl(db, locked.id, { failureMessage: message });
  }
}
