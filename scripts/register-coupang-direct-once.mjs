// Throwaway one-off runner: real createDirectRegistration call (mode:'raw')
// with explicit overrides, confirm:true. Safe even if something regressed
// since the last preview -- createDirectRegistration re-checks readiness
// itself before ever calling the real Coupang API.
import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl, loadCoupangConfig } from '../src/config.mjs';
import { createDirectRegistration } from '../src/coupang-registration-flow.mjs';

const rootDir = process.cwd();
const draftId = Number(process.argv[2]);
const overrides = JSON.parse(process.argv[3]);

const databaseUrl = await loadDatabaseUrl(rootDir);
const db = await createPgPool(databaseUrl);
const coupangConfig = await loadCoupangConfig(rootDir);

try {
  const result = await createDirectRegistration(db, rootDir, draftId, { mode: 'raw', confirm: true, overrides, coupangConfig });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log('ERROR code=' + error.code);
  console.log(error.message);
  if (error.readiness) console.log('readiness=' + JSON.stringify(error.readiness, null, 2));
}
await db.end();
