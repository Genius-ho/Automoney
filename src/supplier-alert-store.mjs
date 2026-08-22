function toSupplierAlert(row) {
  return {
    id: Number(row.id),
    supplierProductId: Number(row.supplier_product_id),
    code: row.code,
    message: row.message,
    status: row.status,
    detail: row.detail || {},
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

export async function createSupplierAlert(db, { supplierProductId, code, message, detail = {} }) {
  const result = await db.query(
    `insert into supplier_alerts (supplier_product_id, code, message, detail)
     values ($1, $2, $3, $4::jsonb)
     returning *`,
    [supplierProductId, code, message, JSON.stringify(detail)],
  );
  return toSupplierAlert(result.rows[0]);
}

export async function listSupplierAlerts(db, { status = 'open' } = {}) {
  const conditions = [];
  const params = [];
  if (status) { params.push(status); conditions.push(`sa.status = $${params.length}`); }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const result = await db.query(
    `select sa.*, sp.supplier_product_no
     from supplier_alerts sa
     join supplier_products sp on sp.id = sa.supplier_product_id
     ${where}
     order by sa.created_at desc`,
    params,
  );
  return result.rows.map((row) => ({ ...toSupplierAlert(row), supplierProductNo: row.supplier_product_no }));
}

export async function acknowledgeSupplierAlert(db, id) {
  const result = await db.query(
    `update supplier_alerts set status = 'acknowledged', acknowledged_at = now() where id = $1 returning *`,
    [id],
  );
  return result.rows[0] ? toSupplierAlert(result.rows[0]) : null;
}

export async function countOpenSupplierAlerts(db) {
  const result = await db.query(`select count(*) from supplier_alerts where status = 'open'`);
  return Number(result.rows[0].count);
}
