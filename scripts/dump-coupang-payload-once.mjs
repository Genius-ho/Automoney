import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl, loadCoupangConfig } from '../src/config.mjs';
import { buildRegistrationPreview } from '../src/coupang-registration-flow.mjs';

const rootDir = process.cwd();
const draftId = Number(process.argv[2]);
const overrides = JSON.parse(process.argv[3]);

const databaseUrl = await loadDatabaseUrl(rootDir);
const db = await createPgPool(databaseUrl);
const coupangConfig = await loadCoupangConfig(rootDir);

const preview = await buildRegistrationPreview(db, rootDir, draftId, { mode: 'raw', overrides, coupangConfig });
console.log(JSON.stringify(preview.payload.items[0].attributes, null, 2));
await db.end();
