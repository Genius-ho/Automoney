import { readFile } from 'node:fs/promises';

import { loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

// Usage: node scripts/set-option-stock.mjs --file=config/coupang-stock/draft-64.json
//
// Config file shape:
// { "draftId": 64, "stockByOptionValue": { "베이지": 12, "그레이": 7 } }
//
// This never invents quantities -- it only applies numbers a human already
// wrote into the config file, one option value at a time, by exact match on
// product_options.value for that draft.

const root = process.cwd();
const filePath = (process.argv.find((arg) => arg.startsWith('--file=')) || '').split('=')[1];

async function main() {
  if (!filePath) throw new Error('Usage: node scripts/set-option-stock.mjs --file=<path to JSON config>');
  const config = JSON.parse(await readFile(filePath, 'utf8'));
  const { draftId, stockByOptionValue } = config;
  if (!Number.isInteger(draftId)) throw new Error('config.draftId must be an integer');
  if (!stockByOptionValue || typeof stockByOptionValue !== 'object') throw new Error('config.stockByOptionValue must be an object');

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    for (const [optionValue, quantity] of Object.entries(stockByOptionValue)) {
      if (!Number.isInteger(quantity) || quantity < 0) {
        throw new Error(`stock quantity for "${optionValue}" must be a non-negative integer, got: ${JSON.stringify(quantity)}`);
      }
      const result = await db.query(
        'update product_options set stock_quantity = $1 where product_draft_id = $2 and value = $3 returning id, name, value',
        [quantity, draftId, optionValue],
      );
      if (result.rows.length === 0) {
        console.log(`no match: draft ${draftId} has no option with value "${optionValue}"`);
      } else {
        console.log(`set stock_quantity=${quantity} for draft ${draftId} option "${result.rows[0].name}/${result.rows[0].value}"`);
      }
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('set-option-stock failed:', error.message);
  process.exitCode = 1;
});
