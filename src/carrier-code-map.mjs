// automoney_complete_automation_implementation_plan.md section 14.3 (Phase
// 9): 택배사 코드 정규화. Confirmed live 2026-07-25: a real 도매매 order's
// delivery.company code for 롯데택배 was "HYUNDAI" -- identical to Coupang's
// own deliveryCompanyCode for the same carrier
// (developers.coupang.com/ko/api/logistics/courier-code). Both systems
// appear to draw from the same widely-used Korean courier-code registry, so
// this is a whitelist/passthrough rather than a translation table.
//
// IMPORTANT: only "HYUNDAI" is confirmed against a real order so far (the
// only shipped order this account has). The rest of this list is taken
// directly from Coupang's own published code table, not independently
// verified against a real 도매매 delivery.company value -- if a shipment
// ever comes back with a carrier not in this set (or, less likely, a known
// code that turns out to mean something different on 도매매's side), it
// blocks (14.3's "매핑 실패 시 자동 발송처리 금지") rather than guessing, and
// should be checked against the real order before adding/trusting it.
const KNOWN_COUPANG_CARRIER_CODES = new Map([
  ['HYUNDAI', '롯데택배'], // confirmed live 2026-07-25
  ['KGB', '로젠택배'],
  ['EPOST', '우체국택배'],
  ['HANJIN', '한진택배'],
  ['CJGLS', 'CJ대한통운'],
  ['KOREX', '대한통운(합병)'],
  ['KDEXP', '경동택배'],
  ['ILYANG', '일양택배'],
  ['CHUNIL', '천일특송'],
  ['AJOU', '아주택배'],
  ['CSLOGIS', 'SC로지스'],
  ['DIRECT', '업체직송'],
]);

export function mapCarrierCodeToCoupang(supplierCarrierCode) {
  const code = String(supplierCarrierCode || '').trim().toUpperCase();
  if (!code || !KNOWN_COUPANG_CARRIER_CODES.has(code)) return null;
  return code;
}

export function isKnownCarrierCode(supplierCarrierCode) {
  return mapCarrierCodeToCoupang(supplierCarrierCode) !== null;
}
