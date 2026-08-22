#!/usr/bin/env node
import { loadDatabaseUrl, loadEnvConfig } from '../src/config.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { runCancellationExceptionSweep } from '../src/cancellation-handler.mjs';

// Phase 10 (section 15.1): read-only detection sweep -- flags a placed
// supplier order whose channel order has since been cancelled into the
// admin 예외 큐. Never cancels anything itself; that's an explicit admin
// action (POST /api/order-exceptions/:id/attempt-supplier-cancel).
const root = process.cwd();
await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const db = await createPgPool(databaseUrl);
await runSchema(db);

const results = await runCancellationExceptionSweep(db);
let flagged = 0;
for (const result of results) {
  if (result?.error) { console.log(`supplierOrderId=${result.supplierOrderId} error=${result.error}`); continue; }
  flagged += 1;
  console.log(`channelOrderId=${result.channelOrderId} exceptionType=${result.exceptionType}`);
}
console.log(`flagged=${flagged}`);

await db.end();
