#!/usr/bin/env node
import { loadDatabaseUrl, loadEnvConfig } from '../src/config.mjs';
import { DomemeClient } from '../src/domeme-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { runSupplierMonitorSweep } from '../src/supplier-monitor.mjs';

const root = process.cwd();
const config = await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const db = await createPgPool(databaseUrl);
await runSchema(db);

const client = new DomemeClient({ apiKey: config.domemeApiKey, endpoint: config.domemeEndpoint });

const results = await runSupplierMonitorSweep(db, client);

let alertCount = 0;
for (const result of results) {
  if (result.alerts.length === 0) continue;
  alertCount += result.alerts.length;
  console.log(`supplierProductNo=${result.supplierProductNo}`);
  for (const alert of result.alerts) console.log(`  [${alert.code}] ${alert.message}`);
}

console.log(`checked=${results.length} withAlerts=${results.filter((r) => r.alerts.length > 0).length} totalAlerts=${alertCount}`);

await db.end();
