import { normalizeProduct } from './processing.mjs';
import {
  getLatestSupplierSnapshot,
  recordSupplierSnapshot,
  listMonitorableSupplierProducts,
} from './supplier-monitor-store.mjs';

// automoney_complete_automation_implementation_plan.md section 11 (Phase 6):
// 공급처 가격·재고·판매상태 감시. Read-only against Domeme/Domeggook only --
// never touches Coupang/Naver. Compares the freshly-fetched state against
// the most recent prior supplier_snapshots row (null on the very first-ever
// check for a product, in which case there's nothing to diff against yet).
export function diffSnapshots(previous, current) {
  const alerts = [];
  if (!previous) return alerts;

  if (!previous.isSoldOut && current.isSoldOut) {
    alerts.push({ code: 'SUPPLIER_OUT_OF_STOCK', message: '공급처 품절 감지 -- 판매중지 후보' });
  } else if (previous.isSoldOut && !current.isSoldOut) {
    alerts.push({ code: 'SUPPLIER_BACK_IN_STOCK', message: '공급처 재입고 감지' });
  }

  if (Number.isFinite(previous.unitCostPrice) && Number.isFinite(current.unitCostPrice) && previous.unitCostPrice !== current.unitCostPrice) {
    if (current.unitCostPrice > previous.unitCostPrice) {
      alerts.push({
        code: 'SUPPLIER_PRICE_INCREASED',
        message: `공급가 상승: ${previous.unitCostPrice} -> ${current.unitCostPrice} (예상이익 재계산 필요)`,
        previousValue: previous.unitCostPrice,
        currentValue: current.unitCostPrice,
      });
    } else {
      alerts.push({
        code: 'SUPPLIER_PRICE_DECREASED',
        message: `공급가 하락: ${previous.unitCostPrice} -> ${current.unitCostPrice} (가격 인하 후보)`,
        previousValue: previous.unitCostPrice,
        currentValue: current.unitCostPrice,
      });
    }
  }

  if (Number.isFinite(previous.minOrderQty) && Number.isFinite(current.minOrderQty) && previous.minOrderQty !== current.minOrderQty) {
    alerts.push({
      code: 'SUPPLIER_MOQ_CHANGED',
      message: `최소주문수량 변경: ${previous.minOrderQty} -> ${current.minOrderQty} (관리자 확인 필요)`,
      previousValue: previous.minOrderQty,
      currentValue: current.minOrderQty,
    });
  }

  const wasHealthy = previous.priceParseStatus !== 'parsing_error' && previous.priceParseStatus !== 'invalid_range';
  const nowBroken = current.priceParseStatus === 'parsing_error' || current.priceParseStatus === 'invalid_range';
  if (wasHealthy && nowBroken) {
    alerts.push({ code: 'SUPPLIER_DATA_ERROR', message: '공급처 가격 데이터 파싱 오류 -- 수동 확인 필요' });
  }

  return alerts;
}

// price/shippingFee come back as 0 (not null) from normalizeProduct on a
// parse failure -- comparing "0" as if it were a real price would produce
// bogus SUPPLIER_PRICE_DECREASED alerts, so only trust the value when its
// own parse status says it's actually usable.
function extractCurrentState(normalized) {
  const priceOk = normalized.priceParseStatus === 'ok' || normalized.priceParseStatus === 'tiered_price';
  const shippingOk = normalized.shippingParseStatus === 'ok';
  return {
    unitCostPrice: priceOk ? normalized.unitCostPrice : null,
    shippingFee: shippingOk ? normalized.shippingFee : null,
    minOrderQty: normalized.minOrderQty,
    isSoldOut: normalized.isSoldOut,
    priceParseStatus: normalized.priceParseStatus,
  };
}

export async function checkSupplierProduct(db, client, { supplierProductId, supplierProductNo, sourceMarket }, {
  getLatestSupplierSnapshotImpl = getLatestSupplierSnapshot,
  recordSupplierSnapshotImpl = recordSupplierSnapshot,
  normalizeProductImpl = normalizeProduct,
  fetchProductDetailImpl,
} = {}) {
  const previous = await getLatestSupplierSnapshotImpl(db, supplierProductId);
  const fetchDetail = fetchProductDetailImpl || ((productNo) => client.fetchProductDetail(productNo));
  const raw = await fetchDetail(supplierProductNo);
  const normalized = normalizeProductImpl(supplierProductNo, raw, { requestedMarket: sourceMarket === 'domeme' ? 'dome' : null });
  const current = extractCurrentState(normalized);
  const saved = await recordSupplierSnapshotImpl(db, supplierProductId, supplierProductNo, current);
  const alerts = diffSnapshots(previous, current);
  return { supplierProductId, supplierProductNo, previous, current: saved, alerts };
}

// Sweeps every row in supplier_products -- one Domeme/Domeggook fetch each,
// continuing past individual failures (a single bad fetch shouldn't abort
// the whole sweep) rather than throwing.
export async function runSupplierMonitorSweep(db, client, {
  listMonitorableSupplierProductsImpl = listMonitorableSupplierProducts,
  checkSupplierProductImpl = checkSupplierProduct,
} = {}) {
  const products = await listMonitorableSupplierProductsImpl(db);
  const results = [];
  for (const product of products) {
    try {
      const result = await checkSupplierProductImpl(db, client, product);
      results.push(result);
    } catch (error) {
      results.push({
        supplierProductId: product.supplierProductId,
        supplierProductNo: product.supplierProductNo,
        error: error.message,
        alerts: [{ code: 'SUPPLIER_FETCH_ERROR', message: error.message }],
      });
    }
  }
  return results;
}
