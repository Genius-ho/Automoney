#!/usr/bin/env node
import { join } from 'node:path';

import { loadDatabaseUrl, loadEnvConfig, loadPricingRules, loadProductNumbers } from '../src/config.mjs';
import { DomemeClient } from '../src/domeme-client.mjs';
import { processProduct } from '../src/pipeline.mjs';
import { createPgPool, runSchema } from '../src/postgres-store.mjs';

const root = process.cwd();
const csvPath = process.argv[2] || join(root, 'test-products.csv');
const pricingPath = process.argv[3] || join(root, 'pricing-rules.json');

const config = await loadEnvConfig(root);
const databaseUrl = await loadDatabaseUrl(root);
const productNumbers = await loadProductNumbers(csvPath);
const pricingRules = await loadPricingRules(pricingPath);
const db = await createPgPool(databaseUrl);
await runSchema(db);
const client = new DomemeClient({
  apiKey: config.domemeApiKey,
  endpoint: config.domemeEndpoint,
});

console.log(`Processing ${productNumbers.length} Domeme products`);

for (const productNo of productNumbers) {
  const result = await withTransaction(db, (tx) => processProduct({ productNo, client, db: tx, pricingRules }));
  if (result.status === 'SUCCESS') {
    console.log(
      [
        productNo,
        'SUCCESS',
        result.cleanedName,
        `coupang=${result.coupangPrice}`,
        `smartstore=${result.smartstorePrice}`,
      ].join(' | '),
    );
  } else {
    console.log([productNo, result.status, result.reason].join(' | '));
  }
}

await db.end();

async function withTransaction(pool, fn) {
  const tx = await pool.connect();
  try {
    await tx.query('begin');
    const result = await fn(tx);
    await tx.query('commit');
    return result;
  } catch (error) {
    await tx.query('rollback');
    throw error;
  } finally {
    tx.release();
  }
}
