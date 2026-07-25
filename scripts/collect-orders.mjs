#!/usr/bin/env node
import { loadDatabaseUrl, loadEnvConfig, loadCoupangConfig, loadNaverCommerceConfig } from '../src/config.mjs';
import { CoupangClient } from '../src/coupang-client.mjs';
import { NaverCommerceClient } from '../src/naver-commerce-client.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';
import { runCoupangOrderCollection, runNaverOrderCollection } from '../src/order-collector.mjs';

const root = process.cwd();
await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const db = await createPgPool(databaseUrl);
await runSchema(db);

const coupangConfig = await loadCoupangConfig(root);
const naverConfig = await loadNaverCommerceConfig(root);
const coupangClient = new CoupangClient(coupangConfig);
const naverClient = new NaverCommerceClient(naverConfig);

const coupangResult = await runCoupangOrderCollection(db, coupangClient);
console.log(`coupang: ${JSON.stringify(coupangResult)}`);

const naverResult = await runNaverOrderCollection(db, naverClient);
console.log(`naver: ${JSON.stringify(naverResult)}`);

await db.end();
