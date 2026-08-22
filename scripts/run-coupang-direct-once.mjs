// Throwaway one-off runner: drives createDirectRegistration for a single
// draft end-to-end from the command line (mode:'raw', so it uses the
// draft's own supplier images -- no AI-improved image approval needed
// first). Safe to call with confirm:true directly: createDirectRegistration
// itself checks readiness before ever calling the real Coupang API, so a
// blocked draft throws REGISTRATION_NOT_READY without any live side effect.
import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl, loadCoupangConfig } from '../src/config.mjs';
import { createDirectRegistration } from '../src/coupang-registration-flow.mjs';

const rootDir = process.cwd();
const draftId = Number(process.argv[2]);
const confirm = process.argv[3] === 'confirm';

const databaseUrl = await loadDatabaseUrl(rootDir);
const db = await createPgPool(databaseUrl);
const coupangConfig = await loadCoupangConfig(rootDir);

try {
  const result = await createDirectRegistration(db, rootDir, draftId, { mode: 'raw', confirm, coupangConfig });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log('ERROR code=' + error.code);
  console.log(error.message);
  if (error.readiness) console.log('readiness=' + JSON.stringify(error.readiness, null, 2));
  if (error.details) console.log('details=' + JSON.stringify(error.details, null, 2));
}
await db.end();
