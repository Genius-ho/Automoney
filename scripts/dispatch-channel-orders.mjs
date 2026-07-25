#!/usr/bin/env node
import { loadCoupangConfig, loadEnvConfig, loadDatabaseUrl, loadNaverCommerceConfig } from '../src/config.mjs';
import { CoupangClient } from '../src/coupang-client.mjs';
import { NaverCommerceClient } from '../src/naver-commerce-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { runChannelDispatchSweep } from '../src/channel-dispatch.mjs';

// Phase 9 (section 14.4): 채널 발송 처리 -- the one script in this pipeline
// that writes to Coupang (invoice upload) and Naver (발주확인 + 발송처리), so
// every shipment it touches has already passed 14.3's carrier-code mapping
// and a fresh cancellation re-check inside dispatchSupplierOrderToChannel.
const root = process.cwd();
await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const db = await createPgPool(databaseUrl);
await runSchema(db);

const coupangConfig = await loadCoupangConfig(root);
const coupangClient = new CoupangClient(coupangConfig);
const naverConfig = await loadNaverCommerceConfig(root);
const naverClient = new NaverCommerceClient(naverConfig);

const results = await runChannelDispatchSweep(db, { coupangClient, naverClient });
let sent = 0;
for (const result of results) {
  if (result?.error) { console.log(`supplierOrderId=${result.supplierOrderId} error=${result.error}`); continue; }
  if (result.channelShipStatus === 'sent') { sent += 1; continue; }
  console.log(`supplierOrderId=${result.id} channelShipStatus=${result.channelShipStatus} error=${result.channelShipError || '-'}`);
}
console.log(`checked=${results.length} sent=${sent}`);

await db.end();
