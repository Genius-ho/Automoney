import { normalizeProduct } from './processing.mjs';
import { listChannelOrders } from './channel-orders-store.mjs';
import {
  getSupplierOrderByChannelOrderId,
  getDraftOrderingContext,
  upsertSupplierOrderDraft,
} from './purchase-order-store.mjs';

// automoney_complete_automation_implementation_plan.md section 13.2/13.3/13.4
// (Phase 8): builds (or refreshes) a 발주안 for one already-mapped
// channel_orders row. Never places an order itself -- only ever writes
// 'validating_supplier' (blocked, block_reasons populated) or
// 'awaiting_purchase_approval' (clean, sitting for a human in the 13.4
// screen). The actual domeme setOrder call only happens in
// approveSupplierOrder, and only from an explicit admin action.

// channel_orders.option_info is free text (Coupang's vendorItemName, or
// Naver's best-guess productOption/productName -- see order-collector.mjs's
// normalizeNaverOrder) -- there is no exact option-id stored anywhere on
// the channel side (Phase 7's Explore pass confirmed this; see
// order-supplier-mapper.mjs's header comment). A single-option product has
// no ambiguity ("00" is the only code). A multi-option product is matched
// by checking which stored option's value/name appears inside the free
// text -- if that's not exactly one option, the draft is blocked
// (OPTION_MISMATCH) rather than guessing.
export function matchSupplierOption(options, optionInfoText) {
  if (!Array.isArray(options) || options.length === 0) {
    return { optionCode: '00', stockQuantity: null, additionalPrice: 0 };
  }
  const text = String(optionInfoText || '').trim();
  if (!text) return null;
  const matches = options.filter((option) => option.value && text.includes(option.value));
  return matches.length === 1 ? matches[0] : null;
}

const CANCELLED_PATTERN = /CANCEL|취소/i;

function isCancelled(channelOrder) {
  return Boolean(channelOrder.cancelledAt) || CANCELLED_PATTERN.test(channelOrder.orderStatus || '');
}

function hasCompleteAddress(channelOrder) {
  return Boolean(channelOrder.recipientName && channelOrder.address && channelOrder.postalCode && channelOrder.phone);
}

export async function buildSupplierOrderDraft(db, domemeClient, channelOrder, {
  getSupplierOrderByChannelOrderIdImpl = getSupplierOrderByChannelOrderId,
  getDraftOrderingContextImpl = getDraftOrderingContext,
  upsertSupplierOrderDraftImpl = upsertSupplierOrderDraft,
  fetchProductDetailImpl,
  normalizeProductImpl = normalizeProduct,
  matchSupplierOptionImpl = matchSupplierOption,
} = {}) {
  if (!channelOrder.productDraftId || !channelOrder.supplierProductId) {
    throw new Error('buildSupplierOrderDraft requires an already-mapped channel order (productDraftId/supplierProductId)');
  }

  // 13.3 "기존 supplier order 존재" -- never rebuild past the point of no
  // return. An in-flight or placed order is left completely untouched by
  // every later validation sweep.
  const existing = await getSupplierOrderByChannelOrderIdImpl(db, channelOrder.id);
  if (existing && (existing.status === 'supplier_ordering' || existing.status === 'supplier_ordered')) {
    return existing;
  }

  const blockReasons = [];
  if (isCancelled(channelOrder)) blockReasons.push('ORDER_CANCELLED');
  if (!hasCompleteAddress(channelOrder)) blockReasons.push('ADDRESS_INCOMPLETE');

  const context = await getDraftOrderingContextImpl(db, channelOrder.productDraftId);
  if (!context) {
    blockReasons.push('DRAFT_NOT_FOUND');
    return upsertSupplierOrderDraftImpl(db, {
      channelOrderId: channelOrder.id,
      productDraftId: channelOrder.productDraftId,
      supplierProductId: channelOrder.supplierProductId,
      status: 'validating_supplier',
      blockReasons,
    });
  }

  const match = matchSupplierOptionImpl(context.options, channelOrder.optionInfo);
  if (!match) blockReasons.push('OPTION_MISMATCH');

  // 13.2 발주 직전 재검증: refetch the supplier product live (public API,
  // no login needed) rather than trusting whatever was last scraped --
  // reuses the exact same fetch+normalize path as Phase 6's supplier
  // monitor, so a soldout/price/MOQ change is read the same way in both
  // places.
  let live = null;
  let liveRaw = null;
  try {
    const fetchDetail = fetchProductDetailImpl || ((productNo) => domemeClient.fetchProductDetail(productNo));
    liveRaw = await fetchDetail(context.supplierProductNo);
    live = normalizeProductImpl(context.supplierProductNo, liveRaw, {});
  } catch {
    blockReasons.push('SUPPLIER_FETCH_FAILED');
  }

  // Which of the two dome-domain markets (도매꾹 "dome" vs 도매매 "supply") to
  // order through -- every collected product is listed on both (confirmed
  // live, 2026-07-25: raw_json.domeggook.channel.{dome,supply} are both
  // true on every sampled row), so this can't be inferred from
  // product_drafts.sourceMarket or a static per-product fact. It has to
  // match whichever price tier this specific draft was actually priced and
  // margin-checked against -- and product_drafts.raw_price_field_name isn't
  // trustworthy for that either (confirmed stale for some already-collected
  // drafts, priced under an older candidate-priority order than
  // processing.mjs's current one). live.rawPriceFieldName (from the fresh
  // re-fetch+normalize just above) is the one value guaranteed to reflect
  // what this exact run actually used.
  let supplierMarket = null;
  if (live) {
    if (live.isSoldOut) blockReasons.push('SUPPLIER_SOLD_OUT');
    const saleStatus = liveRaw?.domeggook?.basis?.status ?? liveRaw?.basis?.status;
    if (saleStatus && saleStatus !== '판매중') blockReasons.push('SUPPLIER_SALE_STOPPED');
    if (match && context.options.length > 0) {
      const liveOption = (live.options || []).find((option) => option.optionCode === match.optionCode);
      if (!liveOption) blockReasons.push('OPTION_MISMATCH');
      else if (liveOption.stockQuantity != null && liveOption.stockQuantity <= 0) blockReasons.push('SUPPLIER_SOLD_OUT');
    }
    if (Number.isFinite(live.minOrderQty) && Number.isFinite(context.minOrderQty) && live.minOrderQty !== context.minOrderQty) {
      blockReasons.push('MOQ_CHANGED');
    }
    supplierMarket = live.rawPriceFieldName === 'price.dome' ? 'dome' : live.rawPriceFieldName === 'price.supply' ? 'supply' : null;
    if (!supplierMarket) blockReasons.push('MARKET_UNRESOLVED');
  }

  // 12.4 MOQ 예시: 판매채널 주문수량 × 공급처 발주 multiplier(bundle_quantity) =
  // 최종 발주수량.
  const saleQty = Number.isFinite(channelOrder.quantity) ? channelOrder.quantity : 1;
  const supplierOrderQty = saleQty * context.bundleQuantity;
  const salePrice = Number.isFinite(channelOrder.salePrice) ? channelOrder.salePrice : null;
  const priceOk = live && (live.priceParseStatus === 'ok' || live.priceParseStatus === 'tiered_price');
  const supplierUnitPrice = priceOk ? live.unitCostPrice : context.unitCostPrice;
  const supplierShippingFee = live && live.shippingParseStatus === 'ok' ? live.shippingFee : null;

  // Advisory only -- salePrice is the channel's reported line total, this
  // is not a final settlement figure (fees/rocket-growth adjustments etc.
  // aren't modeled here). The 13.4 screen shows it next to every other raw
  // number precisely so a human can sanity-check it before approving.
  let estimatedProfit = null;
  if (Number.isFinite(salePrice) && Number.isFinite(supplierUnitPrice)) {
    estimatedProfit = salePrice - supplierUnitPrice * supplierOrderQty - (supplierShippingFee || 0);
    if (estimatedProfit <= 0) blockReasons.push('LOSS_AT_CURRENT_PRICE');
  }

  const status = blockReasons.length > 0 ? 'validating_supplier' : 'awaiting_purchase_approval';

  return upsertSupplierOrderDraftImpl(db, {
    channelOrderId: channelOrder.id,
    productDraftId: channelOrder.productDraftId,
    supplierProductId: channelOrder.supplierProductId,
    status,
    blockReasons,
    supplierMarket,
    supplierOptionCode: match?.optionCode ?? null,
    supplierOrderQty,
    saleQty,
    salePrice,
    supplierUnitPrice,
    supplierShippingFee,
    estimatedProfit,
  });
}

// Sweeps every mapped-but-not-yet-ordered channel order, continuing past a
// single build failure the same way runSupplierMonitorSweep does -- one bad
// live fetch shouldn't stop the rest of the queue from refreshing.
export async function runSupplierOrderValidationSweep(db, domemeClient, {
  listChannelOrdersImpl = listChannelOrders,
  buildSupplierOrderDraftImpl = buildSupplierOrderDraft,
} = {}) {
  const mapped = await listChannelOrdersImpl(db, { supplierMappingStatus: 'mapped' });
  const results = [];
  for (const channelOrder of mapped) {
    try {
      results.push(await buildSupplierOrderDraftImpl(db, domemeClient, channelOrder));
    } catch (error) {
      results.push({ channelOrderId: channelOrder.id, error: error.message });
    }
  }
  return results;
}
