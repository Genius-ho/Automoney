function toChannelOrder(row) {
  return {
    id: Number(row.id),
    channel: row.channel,
    channelOrderId: row.channel_order_id,
    channelOrderItemId: row.channel_order_item_id,
    channelProductId: row.channel_product_id,
    optionInfo: row.option_info,
    quantity: row.quantity == null ? null : Number(row.quantity),
    salePrice: row.sale_price == null ? null : Number(row.sale_price),
    orderStatus: row.order_status,
    recipientName: row.recipient_name,
    address: row.address,
    postalCode: row.postal_code,
    phone: row.phone,
    deliveryMemo: row.delivery_memo,
    orderedAt: row.ordered_at,
    cancelledAt: row.cancelled_at,
    supplierMappingStatus: row.supplier_mapping_status,
    supplierProductId: row.supplier_product_id == null ? null : Number(row.supplier_product_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Upsert, not insert -- the same order line gets re-fetched on every 30-min
// poll for as long as it keeps changing status (결제완료 -> 상품준비중 -> 배송중
// -> 배송완료), so a plain insert-or-skip would freeze the row at whatever
// status it first arrived in. `isNew` tells the caller (the collection
// sweep) whether this line has never been seen before, for a "N new orders
// found" summary -- xmax = 0 is the standard Postgres trick for that on an
// upsert (only 0 on a fresh insert, never on a row an ON CONFLICT touched).
export async function recordChannelOrder(db, order) {
  const result = await db.query(
    `insert into channel_orders
       (channel, channel_order_id, channel_order_item_id, channel_product_id, option_info,
        quantity, sale_price, order_status, recipient_name, address, postal_code, phone,
        delivery_memo, ordered_at, cancelled_at, raw_json)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict (channel, channel_order_item_id) do update set
       order_status = excluded.order_status,
       cancelled_at = excluded.cancelled_at,
       quantity = excluded.quantity,
       sale_price = excluded.sale_price,
       raw_json = excluded.raw_json,
       updated_at = now()
     returning *, (xmax = 0) as is_new`,
    [
      order.channel, order.channelOrderId, order.channelOrderItemId, order.channelProductId ?? null,
      order.optionInfo ?? null, order.quantity ?? null, order.salePrice ?? null, order.orderStatus ?? null,
      order.recipientName ?? null, order.address ?? null, order.postalCode ?? null, order.phone ?? null,
      order.deliveryMemo ?? null, order.orderedAt ?? null, order.cancelledAt ?? null, order.rawJson ?? null,
    ],
  );
  const row = result.rows[0];
  return { ...toChannelOrder(row), isNew: row.is_new };
}

export async function listChannelOrders(db, { channel, supplierMappingStatus } = {}) {
  const conditions = [];
  const params = [];
  if (channel) { params.push(channel); conditions.push(`channel = $${params.length}`); }
  if (supplierMappingStatus) { params.push(supplierMappingStatus); conditions.push(`supplier_mapping_status = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const result = await db.query(`select * from channel_orders ${where} order by ordered_at desc nulls last`, params);
  return result.rows.map(toChannelOrder);
}

export async function getOrderCollectionState(db, channel) {
  const result = await db.query('select * from order_collection_state where channel = $1', [channel]);
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return { channel: row.channel, lastSuccessAt: row.last_success_at, isRunning: row.is_running, updatedAt: row.updated_at };
}

// Same atomic compare-and-set pattern as batch-schedule-store's
// tryAcquireBatchLock -- "동시 실행 금지" (12.1): the WHERE clause makes the
// check-and-flip one statement so a scheduler tick and a manual re-run can
// never both acquire the lock for the same channel.
export async function tryAcquireOrderCollectionLock(db, channel) {
  const result = await db.query(
    `update order_collection_state set is_running = true, updated_at = now()
     where channel = $1 and is_running = false
     returning *`,
    [channel],
  );
  return result.rows[0] ? { channel: result.rows[0].channel, lastSuccessAt: result.rows[0].last_success_at } : null;
}

export async function releaseOrderCollectionLock(db, channel, { successAt } = {}) {
  const result = await db.query(
    `update order_collection_state set
       is_running = false,
       last_success_at = coalesce($2, last_success_at),
       updated_at = now()
     where channel = $1
     returning *`,
    [channel, successAt ?? null],
  );
  return result.rows[0] ? { channel: result.rows[0].channel, lastSuccessAt: result.rows[0].last_success_at } : null;
}
