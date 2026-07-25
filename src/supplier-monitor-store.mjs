function toSnapshot(row) {
  return {
    id: Number(row.id),
    supplierProductId: Number(row.supplier_product_id),
    supplierProductNo: row.supplier_product_no,
    unitCostPrice: row.unit_cost_price == null ? null : Number(row.unit_cost_price),
    shippingFee: row.shipping_fee == null ? null : Number(row.shipping_fee),
    minOrderQty: row.min_order_qty == null ? null : Number(row.min_order_qty),
    isSoldOut: row.is_sold_out,
    priceParseStatus: row.price_parse_status,
    checkedAt: row.checked_at,
  };
}

export async function getLatestSupplierSnapshot(db, supplierProductId) {
  const result = await db.query(
    'select * from supplier_snapshots where supplier_product_id = $1 order by checked_at desc limit 1',
    [supplierProductId],
  );
  return result.rows[0] ? toSnapshot(result.rows[0]) : null;
}

export async function recordSupplierSnapshot(db, supplierProductId, supplierProductNo, {
  unitCostPrice, shippingFee, minOrderQty, isSoldOut, priceParseStatus,
}) {
  const result = await db.query(
    `insert into supplier_snapshots
       (supplier_product_id, supplier_product_no, unit_cost_price, shipping_fee, min_order_qty, is_sold_out, price_parse_status)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [supplierProductId, String(supplierProductNo), unitCostPrice ?? null, shippingFee ?? null, minOrderQty ?? null, Boolean(isSoldOut), priceParseStatus ?? null],
  );
  return toSnapshot(result.rows[0]);
}

// One row per row in supplier_products -- every registered/drafted supplier
// product the monitor needs to sweep through on each run.
export async function listMonitorableSupplierProducts(db) {
  const result = await db.query(
    `select sp.id as supplier_product_id, sp.supplier_product_no, sp.source_market
     from supplier_products sp
     order by sp.id`,
  );
  return result.rows.map((row) => ({
    supplierProductId: Number(row.supplier_product_id),
    supplierProductNo: row.supplier_product_no,
    sourceMarket: row.source_market,
  }));
}
