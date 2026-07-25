function toSupplierOrder(row) {
  return {
    id: Number(row.id),
    channelOrderId: Number(row.channel_order_id),
    productDraftId: Number(row.product_draft_id),
    supplierProductId: Number(row.supplier_product_id),
    status: row.status,
    blockReasons: row.block_reasons || [],
    supplierMarket: row.supplier_market,
    supplierOptionCode: row.supplier_option_code,
    supplierOrderQty: row.supplier_order_qty == null ? null : Number(row.supplier_order_qty),
    saleQty: row.sale_qty == null ? null : Number(row.sale_qty),
    salePrice: row.sale_price == null ? null : Number(row.sale_price),
    supplierUnitPrice: row.supplier_unit_price == null ? null : Number(row.supplier_unit_price),
    supplierShippingFee: row.supplier_shipping_fee == null ? null : Number(row.supplier_shipping_fee),
    estimatedProfit: row.estimated_profit == null ? null : Number(row.estimated_profit),
    supplierCheckedAt: row.supplier_checked_at,
    domemeOrderNo: row.domeme_order_no,
    domemeOrderUid: row.domeme_order_uid,
    approvedAt: row.approved_at,
    orderedAt: row.ordered_at,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Upsert -- 13.2 재검증 re-runs this on every sweep for anything not yet
// ordered, refreshing the computed numbers each time. The status guard in
// the CASE is defense-in-depth: the real "don't rebuild an in-flight/placed
// order" check lives in purchase-order-builder.mjs (13.3 "기존 supplier order
// 존재"), which skips calling this at all once a row is
// supplier_ordering/supplier_ordered -- this just makes sure a stray call
// can never regress one of those back to a validation status either.
export async function upsertSupplierOrderDraft(db, {
  channelOrderId, productDraftId, supplierProductId, status, blockReasons = [],
  supplierMarket = null, supplierOptionCode = null, supplierOrderQty = null, saleQty = null, salePrice = null,
  supplierUnitPrice = null, supplierShippingFee = null, estimatedProfit = null,
}) {
  const result = await db.query(
    `insert into supplier_orders (
       channel_order_id, product_draft_id, supplier_product_id, status, block_reasons,
       supplier_market, supplier_option_code, supplier_order_qty, sale_qty, sale_price,
       supplier_unit_price, supplier_shipping_fee, estimated_profit, supplier_checked_at
     ) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13, now())
     on conflict (channel_order_id) do update set
       status = case
         when supplier_orders.status in ('supplier_ordering', 'supplier_ordered') then supplier_orders.status
         else excluded.status
       end,
       block_reasons = excluded.block_reasons,
       supplier_market = excluded.supplier_market,
       supplier_option_code = excluded.supplier_option_code,
       supplier_order_qty = excluded.supplier_order_qty,
       sale_qty = excluded.sale_qty,
       sale_price = excluded.sale_price,
       supplier_unit_price = excluded.supplier_unit_price,
       supplier_shipping_fee = excluded.supplier_shipping_fee,
       estimated_profit = excluded.estimated_profit,
       supplier_checked_at = now(),
       updated_at = now()
     returning *`,
    [
      channelOrderId, productDraftId, supplierProductId, status, JSON.stringify(blockReasons),
      supplierMarket, supplierOptionCode, supplierOrderQty, saleQty, salePrice, supplierUnitPrice, supplierShippingFee, estimatedProfit,
    ],
  );
  return toSupplierOrder(result.rows[0]);
}

export async function listSupplierOrders(db, { status } = {}) {
  const conditions = [];
  const params = [];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const result = await db.query(`select * from supplier_orders ${where} order by created_at desc`, params);
  return result.rows.map(toSupplierOrder);
}

export async function getSupplierOrder(db, id) {
  const result = await db.query('select * from supplier_orders where id = $1', [id]);
  return result.rows[0] ? toSupplierOrder(result.rows[0]) : null;
}

export async function getSupplierOrderByChannelOrderId(db, channelOrderId) {
  const result = await db.query('select * from supplier_orders where channel_order_id = $1', [channelOrderId]);
  return result.rows[0] ? toSupplierOrder(result.rows[0]) : null;
}

// The one transition an admin's "발주 승인" click causes before the real
// domeme call goes out -- never set by the validation sweep.
export async function markSupplierOrdering(db, id) {
  const result = await db.query(
    `update supplier_orders set status = 'supplier_ordering', approved_at = now(), updated_at = now()
     where id = $1 and status = 'awaiting_purchase_approval' returning *`,
    [id],
  );
  return result.rows[0] ? toSupplierOrder(result.rows[0]) : null;
}

export async function recordSupplierOrderSuccess(db, id, { domemeOrderNo, domemeOrderUid = null }) {
  const result = await db.query(
    `update supplier_orders set
       status = 'supplier_ordered', domeme_order_no = $2, domeme_order_uid = $3,
       ordered_at = now(), failure_message = null, updated_at = now()
     where id = $1 returning *`,
    [id, domemeOrderNo ?? null, domemeOrderUid],
  );
  return result.rows[0] ? toSupplierOrder(result.rows[0]) : null;
}

// Falls back to 'validating_supplier' (not a terminal state) -- an order
// that failed at the real API call (e.g. TOO_LESS_EMONEY_ERROR, a price
// that moved between draft and approval) needs the next validation sweep to
// re-check it and update block_reasons, the same as any other blocked draft.
export async function recordSupplierOrderFailure(db, id, { failureMessage }) {
  const result = await db.query(
    `update supplier_orders set
       status = 'validating_supplier', failure_message = $2, updated_at = now()
     where id = $1 returning *`,
    [id, failureMessage],
  );
  return result.rows[0] ? toSupplierOrder(result.rows[0]) : null;
}

// 13.4 발주안 화면: one row combining the supplier_orders draft with the
// channel-side context (채널, 채널 주문번호, 고객 주문상품/옵션, 수령인) a human
// needs to actually decide whether to approve -- admin-server.mjs is
// responsible for masking recipient PII before this reaches the browser
// (same maskOrderForLog used by the 주문 tab).
export async function listSupplierOrdersForAdmin(db, { status } = {}) {
  const conditions = [];
  const params = [];
  if (status) { params.push(status); conditions.push(`so.status = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const result = await db.query(
    `select so.*, co.channel, co.channel_order_id, co.option_info, co.recipient_name, co.address,
            co.postal_code, co.phone, co.order_status, sp.supplier_product_no
     from supplier_orders so
     join channel_orders co on co.id = so.channel_order_id
     join supplier_products sp on sp.id = so.supplier_product_id
     ${where}
     order by so.created_at desc`,
    params,
  );
  return result.rows.map((row) => ({
    ...toSupplierOrder(row),
    channel: row.channel,
    channelOrderId: row.channel_order_id,
    optionInfo: row.option_info,
    recipientName: row.recipient_name,
    address: row.address,
    postalCode: row.postal_code,
    phone: row.phone,
    orderStatus: row.order_status,
    supplierProductNo: row.supplier_product_no,
  }));
}

// Everything purchase-order-builder.mjs needs about the mapped draft in one
// query: the multiplier (bundle_quantity, 12.4's "공급처 발주 multiplier"),
// the supplier product's own number (to re-fetch it live), and every stored
// option with its order-code (from the processing.mjs fix) to match against
// the channel order's free-text option description.
export async function getDraftOrderingContext(db, productDraftId) {
  const draftResult = await db.query(
    `select d.supplier_product_id, d.bundle_quantity, d.min_order_qty, d.unit_cost_price, d.sell_unit_type,
            sp.supplier_product_no, sp.source_market
     from product_drafts d
     join supplier_products sp on sp.id = d.supplier_product_id
     where d.id = $1`,
    [productDraftId],
  );
  const draft = draftResult.rows[0];
  if (!draft) return null;
  const optionsResult = await db.query(
    'select name, value, option_code, stock_quantity, additional_price from product_options where product_draft_id = $1 order by option_index',
    [productDraftId],
  );
  return {
    supplierProductId: Number(draft.supplier_product_id),
    supplierProductNo: draft.supplier_product_no,
    sourceMarket: draft.source_market,
    bundleQuantity: Number(draft.bundle_quantity) || 1,
    minOrderQty: draft.min_order_qty == null ? null : Number(draft.min_order_qty),
    unitCostPrice: draft.unit_cost_price == null ? null : Number(draft.unit_cost_price),
    sellUnitType: draft.sell_unit_type,
    options: optionsResult.rows.map((row) => ({
      name: row.name,
      value: row.value,
      optionCode: row.option_code,
      stockQuantity: row.stock_quantity == null ? null : Number(row.stock_quantity),
      additionalPrice: row.additional_price == null ? null : Number(row.additional_price),
    })),
  };
}
