import { readFile, writeFile } from 'node:fs/promises';

import { loadJobPathsConfig } from '../src/config.mjs';
import { getJobPaths } from '../src/product-job-folder.mjs';
import { mergeAnalysis } from '../src/analysis-merge.mjs';

const root = process.cwd();
const draftId = Number((process.argv.find((arg) => arg.startsWith('--draft=')) || '--draft=64').split('=')[1]);

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const jobPathsConfig = await loadJobPathsConfig(root);
  const paths = getJobPaths(jobPathsConfig.jobDir, draftId);

  console.log(`=== draft ${draftId} 결과 병합 ===`);
  const codexAnalysis = await readJsonIfExists(paths.codexAnalysisPath);
  const pythonAnalysis = await readJsonIfExists(paths.pythonAnalysisPath);
  console.log(`  codex-analysis.json: ${codexAnalysis ? '있음' : '없음 (npm run codex:analyze 먼저 실행)'}`);
  console.log(`  python-analysis.json: ${pythonAnalysis ? '있음' : '없음 (Codex 결과만으로 병합 진행)'}`);
  if (!codexAnalysis && !pythonAnalysis) {
    console.error('병합할 분석 결과가 하나도 없습니다.');
    process.exitCode = 1;
    return;
  }

  const merged = mergeAnalysis({ codexAnalysis, pythonAnalysis });
  await writeFile(paths.mergedAnalysisPath, JSON.stringify(merged, null, 2));
  console.log(`  결과 저장: ${paths.mergedAnalysisPath}`);

  console.log('\n=== 최종 병합 결과 ===');
  for (const key of ['material', 'dimensions', 'manufacturer', 'countryOfOrigin', 'handlingPrecautions']) {
    const field = merged[key];
    console.log(`  ${key}: ${JSON.stringify(field.value)} (confidence=${field.confidence}, sources=${JSON.stringify(field.sources)}, conflict=${Boolean(field.conflict)})`);
  }
  for (const key of ['colors', 'components']) {
    const field = merged[key];
    console.log(`  ${key}: ${JSON.stringify(field.values)} (confidence=${field.confidence}, sources=${JSON.stringify(field.sources)}, conflict=${Boolean(field.conflict)})`);
  }
  console.log(`  unresolvedFields: ${JSON.stringify(merged.unresolvedFields)}`);
  console.log(`  conflicts: ${JSON.stringify(merged.conflicts, null, 2)}`);
}

main().catch((error) => {
  console.error('analyze-merge-product failed:', error.message);
  process.exitCode = 1;
});
