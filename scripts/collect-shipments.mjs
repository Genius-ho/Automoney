#!/usr/bin/env node
import { loadDatabaseUrl, loadDomemePrivateConfig, loadEnvConfig } from '../src/config.mjs';
import { DomemePrivateClient } from '../src/domeme-private-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { runShipmentCollectionSweep } from '../src/shipment-collector.mjs';

// Phase 9 (section 14.2): read-only against 도매매's own order detail --
// finds the tracking number for every placed order that doesn't have one
// yet. Never touches a channel.
const root = process.cwd();
await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const db = await createPgPool(databaseUrl);
await runSchema(db);

const domemeConfig = await loadDomemePrivateConfig(root);
const domemeClient = new DomemePrivateClient(domemeConfig);

const results = await runShipmentCollectionSweep(db, domemeClient);
const found = results.filter((r) => r?.trackingNumber).length;
const errors = results.filter((r) => r?.error);
for (const error of errors) console.log(`supplierOrderId=${error.supplierOrderId} error=${error.error}`);
console.log(`checked=${results.length} shipmentsFound=${found} errors=${errors.length}`);

await db.end();
