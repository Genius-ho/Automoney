// Throwaway one-off runner: runs the Codex+Python product-analysis pass for
// a single draft, then applies every non-blocked field (legal fields
// manufacturer/countryOfOrigin only apply if they have real evidence --
// see product-analysis-orchestrator.mjs's LEGAL_FIELDS gate, never forced
// here).
import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl, loadCodexConfig, loadPythonConfig, loadJobPathsConfig } from '../src/config.mjs';
import { runProductAnalysis, applyProductAnalysis, buildApplyPreview, getAnalysisRun } from '../src/product-analysis-orchestrator.mjs';

const rootDir = process.cwd();
const draftId = Number(process.argv[2]);

const databaseUrl = await loadDatabaseUrl(rootDir);
const db = await createPgPool(databaseUrl);
const [codexConfig, pythonConfig, jobPathsConfig] = await Promise.all([
  loadCodexConfig(rootDir), loadPythonConfig(rootDir), loadJobPathsConfig(rootDir),
]);

console.log('running analysis...');
const run = await runProductAnalysis({ db, rootDir, draftId, codexConfig, pythonConfig, jobPathsConfig });
console.log('run status:', run.status, 'python:', run.pythonStatus, run.pythonErrorCode, 'codex:', run.codexStatus, run.codexErrorCode);

if (run.status === 'success') {
  const preview = buildApplyPreview(run, { options: [] });
  console.log('apply preview:', JSON.stringify(preview, null, 2));

  const fields = { material: true, dimensions: true, manufacturer: true, countryOfOrigin: true, handlingPrecautions: true, searchTags: true, colors: true };
  const applied = await applyProductAnalysis(db, draftId, { runId: run.id, fields });
  console.log('applied:', JSON.stringify(applied, null, 2));
} else {
  console.log('full run:', JSON.stringify(run, null, 2));
}

await db.end();
