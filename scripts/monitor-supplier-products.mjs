#!/usr/bin/env node
import { loadCoupangConfig, loadDatabaseUrl, loadEnvConfig, loadNaverCommerceConfig } from '../src/config.mjs';
import { DomemeClient } from '../src/domeme-client.mjs';
import { CoupangClient } from '../src/coupang-client.mjs';
import { NaverCommerceClient } from '../src/naver-commerce-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { runSupplierMonitorAndSuspendSweep } from '../src/channel-suspension.mjs';

// Phase 6 (section 11) supplier price/stock/sale-status monitoring, extended
// with Phase 10's 15.2 "주문 전 품절 → 채널 판매중지": a SUPPLIER_OUT_OF_STOCK
// alert on a product with a live Coupang or Naver listing now also suspends
// that listing automatically (runSupplierMonitorAndSuspendSweep).
const root = process.cwd();
const config = await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const db = await createPgPool(databaseUrl);
await runSchema(db);

const domemeClient = new DomemeClient({ apiKey: config.domemeApiKey, endpoint: config.domemeEndpoint });
const coupangConfig = await loadCoupangConfig(root);
const coupangClient = new CoupangClient(coupangConfig);
const naverConfig = await loadNaverCommerceConfig(root);
const naverClient = new NaverCommerceClient(naverConfig);

const results = await runSupplierMonitorAndSuspendSweep(db, domemeClient, { coupangClient, naverClient });

let alertCount = 0;
for (const result of results) {
  if (result.alerts.length === 0) continue;
  alertCount += result.alerts.length;
  console.log(`supplierProductNo=${result.supplierProductNo}`);
  for (const alert of result.alerts) console.log(`  [${alert.code}] ${alert.message}`);
  for (const suspension of result.coupangSuspensions || []) {
    console.log(`  coupang suspend draft=${suspension.productDraftId} suspended=${suspension.suspended} ${suspension.error ? `error=${suspension.error}` : ''}`);
  }
  for (const suspension of result.naverSuspensions || []) {
    console.log(`  naver suspend draft=${suspension.productDraftId} suspended=${suspension.suspended} ${suspension.error ? `error=${suspension.error}` : ''}`);
  }
}

console.log(`checked=${results.length} withAlerts=${results.filter((r) => r.alerts.length > 0).length} totalAlerts=${alertCount}`);

await db.end();
