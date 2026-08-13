// Throwaway one-off runner: dry-run preview only (never confirms), so
// readiness gaps can be inspected/iterated without any live API call.
import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl, loadCoupangConfig } from '../src/config.mjs';
import { buildRegistrationPreview } from '../src/coupang-registration-flow.mjs';

const rootDir = process.cwd();
const draftId = Number(process.argv[2]);
const overrides = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const databaseUrl = await loadDatabaseUrl(rootDir);
const db = await createPgPool(databaseUrl);
const coupangConfig = await loadCoupangConfig(rootDir);

const preview = await buildRegistrationPreview(db, rootDir, draftId, { mode: 'raw', overrides, coupangConfig });
console.log('readiness=' + JSON.stringify(preview.readiness, null, 2));
await db.end();
