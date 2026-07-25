function toOrderException(row) {
  return {
    id: Number(row.id),
    channelOrderId: Number(row.channel_order_id),
    supplierOrderId: row.supplier_order_id == null ? null : Number(row.supplier_order_id),
    exceptionType: row.exception_type,
    status: row.status,
    detail: row.detail || {},
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// One open exception per channel order (the schema's partial unique index)
// -- a repeat detection of the same or a different condition on an
// already-open exception just refreshes it rather than creating a
// duplicate row. A resolved exception is left alone; if the same channel
// order needs flagging again later, that's a fresh row.
export async function createOrderException(db, { channelOrderId, supplierOrderId = null, exceptionType, detail = {} }) {
  const result = await db.query(
    `insert into order_exceptions (channel_order_id, supplier_order_id, exception_type, detail)
     values ($1, $2, $3, $4::jsonb)
     on conflict (channel_order_id) where status = 'open' do update set
       exception_type = excluded.exception_type,
       supplier_order_id = excluded.supplier_order_id,
       detail = excluded.detail,
       updated_at = now()
     returning *`,
    [channelOrderId, supplierOrderId, exceptionType, JSON.stringify(detail)],
  );
  return toOrderException(result.rows[0]);
}

export async function getOrderException(db, id) {
  const result = await db.query('select * from order_exceptions where id = $1', [id]);
  return result.rows[0] ? toOrderException(result.rows[0]) : null;
}

export async function resolveOrderException(db, id, { resolutionNote = null } = {}) {
  const result = await db.query(
    `update order_exceptions set status = 'resolved', resolution_note = $2, resolved_at = now(), updated_at = now()
     where id = $1 returning *`,
    [id, resolutionNote],
  );
  return result.rows[0] ? toOrderException(result.rows[0]) : null;
}

// 15.4-adjacent listing for the admin 예외 큐 screen -- joins in just enough
// channel-order/supplier-order context (채널, 수령인 등 -- masked by the
// caller with maskOrderForLog the same as the 주문/발주안 tabs) for a human
// to act on the exception without opening three other tabs.
export async function listOrderExceptionsForAdmin(db, { status = 'open', exceptionType } = {}) {
  const conditions = [];
  const params = [];
  if (status) { params.push(status); conditions.push(`oe.status = $${params.length}`); }
  if (exceptionType) { params.push(exceptionType); conditions.push(`oe.exception_type = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const result = await db.query(
    `select oe.*, co.channel, co.channel_order_id, co.option_info, co.recipient_name, co.address,
            co.postal_code, co.phone, co.order_status, so.domeme_order_no, so.tracking_number
     from order_exceptions oe
     join channel_orders co on co.id = oe.channel_order_id
     left join supplier_orders so on so.id = oe.supplier_order_id
     ${where}
     order by oe.created_at desc`,
    params,
  );
  return result.rows.map((row) => ({
    ...toOrderException(row),
    channel: row.channel,
    channelOrderId: row.channel_order_id,
    optionInfo: row.option_info,
    recipientName: row.recipient_name,
    address: row.address,
    postalCode: row.postal_code,
    phone: row.phone,
    orderStatus: row.order_status,
    domemeOrderNo: row.domeme_order_no,
    trackingNumber: row.tracking_number,
  }));
}
