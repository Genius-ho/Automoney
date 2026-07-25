#!/usr/bin/env node
import { loadDatabaseUrl, loadEnvConfig } from '../src/config.mjs';
import { DomemeClient } from '../src/domeme-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { runSupplierOrderValidationSweep } from '../src/purchase-order-builder.mjs';

// Phase 8 (section 13.2/13.3): read-only revalidation sweep -- builds or
// refreshes a 발주안 for every mapped channel order. Never places a real
// order; that only ever happens from an explicit admin approval action.
const root = process.cwd();
const config = await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const db = await createPgPool(databaseUrl);
await runSchema(db);

const client = new DomemeClient({ apiKey: config.domemeApiKey, endpoint: config.domemeEndpoint });

const results = await runSupplierOrderValidationSweep(db, client);

let ready = 0;
let blocked = 0;
for (const result of results) {
  if (result.error) {
    console.log(`channelOrderId=${result.channelOrderId} error=${result.error}`);
    continue;
  }
  if (result.status === 'awaiting_purchase_approval') {
    ready += 1;
  } else {
    blocked += 1;
    console.log(`channelOrderId=${result.channelOrderId} status=${result.status} blockReasons=${JSON.stringify(result.blockReasons)}`);
  }
}

console.log(`checked=${results.length} readyForApproval=${ready} blocked=${blocked}`);

await db.end();
