// automoney_complete_automation_implementation_plan.md section 14.3 (Phase
// 9): 택배사 코드 정규화. Confirmed live 2026-07-25 that a real 도매매 order's
// delivery.company code for 롯데택배 was "HYUNDAI" -- identical to Coupang's
// own deliveryCompanyCode for the same carrier
// (developers.coupang.com/ko/api/logistics/courier-code). Confirmed again
// 2026-07-26 against Naver Commerce API's own published deliveryCompanyCode
// table (apicenter.commerce.naver.com, pasted directly by the user): the
// exact same code set (CJGLS/HYUNDAI/HANJIN/KGB/EPOST/KDEXP/ILYANG/CHUNIL/...)
// is used there too. All three systems draw from the same widely-used
// Korean courier-code registry -- this map is a shared whitelist/passthrough
// for both channels, not two separate translation tables.
//
// IMPORTANT: only "HYUNDAI" is confirmed against a real 도매매 shipment so far
// (the only shipped order this account has). The rest of this list is taken
// from Coupang's and Naver's own published code tables (which agree with
// each other), not independently verified against a real 도매매 delivery.
// company value -- if a shipment ever comes back with a carrier not in this
// set, it blocks (14.3's "매핑 실패 시 자동 발송처리 금지") rather than guessing.
const KNOWN_CARRIER_CODES = new Map([
  ['HYUNDAI', '롯데택배'], // confirmed live 2026-07-25 (도매매 order) and 2026-07-26 (Naver's own table)
  ['KGB', '로젠택배'],
  ['EPOST', '우체국택배'],
  ['HANJIN', '한진택배'],
  ['CJGLS', 'CJ대한통운'],
  ['KOREX', '대한통운(합병)'],
  ['KDEXP', '경동택배'],
  ['ILYANG', '일양택배'],
  ['CHUNIL', '천일택배'],
  ['AJOU', '아주택배'],
  ['CSLOGIS', 'SC로지스'],
  ['DIRECT', '업체직송'],
]);

export function mapCarrierCode(supplierCarrierCode) {
  const code = String(supplierCarrierCode || '').trim().toUpperCase();
  if (!code || !KNOWN_CARRIER_CODES.has(code)) return null;
  return code;
}

export function isKnownCarrierCode(supplierCarrierCode) {
  return mapCarrierCode(supplierCarrierCode) !== null;
}
