function toSellerShippingSettings(row) {
  return {
    outboundShippingPlaceCode: row.outbound_shipping_place_code,
    outboundShippingPlaceName: row.outbound_shipping_place_name,
    returnCenterCode: row.return_center_code,
    returnCenterName: row.return_center_name,
    confirmedAt: row.confirmed_at,
    updatedAt: row.updated_at,
  };
}

// Single-row settings (same pattern as ai_cost_safety_settings) holding the
// admin-confirmed outbound/return shipping codes. These are never derived by
// matching a display name at registration time (Coupang's own "행당" naming
// is ambiguous -- two outbound places and one oddly-named return center all
// answer to it) -- a human picks the exact code once here, and every draft
// after that just reuses it.
export async function getSellerShippingSettings(db) {
  const result = await db.query('select * from coupang_seller_settings where id = 1');
  return result.rows[0] ? toSellerShippingSettings(result.rows[0]) : toSellerShippingSettings({});
}

export async function saveSellerShippingSettings(db, { outboundShippingPlaceCode, outboundShippingPlaceName = null, returnCenterCode, returnCenterName = null }) {
  if (!outboundShippingPlaceCode) throw new Error('outboundShippingPlaceCode is required');
  if (!returnCenterCode) throw new Error('returnCenterCode is required');
  const result = await db.query(
    `insert into coupang_seller_settings (id, outbound_shipping_place_code, outbound_shipping_place_name, return_center_code, return_center_name, confirmed_at, updated_at)
     values (1, $1, $2, $3, $4, now(), now())
     on conflict (id) do update set
       outbound_shipping_place_code = excluded.outbound_shipping_place_code,
       outbound_shipping_place_name = excluded.outbound_shipping_place_name,
       return_center_code = excluded.return_center_code,
       return_center_name = excluded.return_center_name,
       confirmed_at = now(),
       updated_at = now()
     returning *`,
    [String(outboundShippingPlaceCode), outboundShippingPlaceName, String(returnCenterCode), returnCenterName],
  );
  return toSellerShippingSettings(result.rows[0]);
}
