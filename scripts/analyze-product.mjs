import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadCodexConfig, loadDatabaseUrl, loadJobPathsConfig, loadPythonConfig } from '../src/config.mjs';
import { checkCodexAvailability, runCodexAnalysis } from '../src/codex-client.mjs';
import { checkPythonAvailability, runPythonAnalysis } from '../src/python-client.mjs';
import { buildAnalysisInputPackage } from '../src/product-job-folder.mjs';
import { buildAnalysisPrompt, validateProductAnalysis } from '../src/product-analysis-schema.mjs';
import { validatePythonAnalysis } from '../src/python-analysis-schema.mjs';
import { mergeAnalysis } from '../src/analysis-merge.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

const root = process.cwd();
const draftId = Number((process.argv.find((arg) => arg.startsWith('--draft=')) || '--draft=64').split('=')[1]);
const workerDir = join(root, 'workers', 'python');
const RAW_JSON_EXCERPT_LIMIT = 4000;

async function main() {
  const codexConfig = await loadCodexConfig(root);
  const pythonConfig = await loadPythonConfig(root);
  const jobPathsConfig = await loadJobPathsConfig(root);

  console.log('=== 1. Codex / Python 사용 가능 여부 확인 ===');
  const codexAvailability = await checkCodexAvailability({ config: codexConfig });
  console.log(`  Codex: available=${codexAvailability.available} loggedIn=${codexAvailability.loggedIn}`);
  const pythonAvailability = await checkPythonAvailability({ config: pythonConfig });
  console.log(`  Python: available=${pythonAvailability.available} version=${pythonAvailability.version || 'n/a'}`);
  if (!codexAvailability.available || !codexAvailability.loggedIn) {
    console.error('Codex를 사용할 수 없어 중단합니다 (Codex는 이 파이프라인의 필수 구성요소입니다).');
    process.exitCode = 1;
    return;
  }
  if (!pythonAvailability.available) {
    console.log('  Python을 사용할 수 없습니다 -- Codex 단독 결과로 계속 진행합니다 (fallback).');
  }

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    console.log(`\n=== 2. draft ${draftId} 입력 패키지 준비 ===`);
    const pkg = await buildAnalysisInputPackage({ db, rootDir: root, jobDir: jobPathsConfig.jobDir, draftId });
    console.log(`  job folder: ${pkg.paths.root} / 상세 이미지 ${pkg.detailImagePaths.length}장`);
    if (pkg.detailImagePaths.length === 0) {
      console.error('로컬에 보관된 상세페이지 원본 이미지가 없어 분석을 진행할 수 없습니다.');
      process.exitCode = 1;
      return;
    }

    let pythonAnalysis = null;
    if (pythonAvailability.available) {
      console.log('\n=== 3. Python 분석 실행 ===');
      const pythonResult = await runPythonAnalysis({ config: pythonConfig, workerDir, jobDir: pkg.paths.root });
      await writeFile(pkg.paths.pythonLogPath, pythonResult.log || '');
      console.log(`  성공 여부: ${pythonResult.success} (exitCode=${pythonResult.exitCode})`);
      if (pythonResult.success) {
        const validation = validatePythonAnalysis(pythonResult.analysis);
        if (validation.valid) {
          pythonAnalysis = pythonResult.analysis;
          await writeFile(pkg.paths.pythonAnalysisPath, JSON.stringify(pythonAnalysis, null, 2));
          console.log(`  OCR available=${pythonAnalysis.ocrMeta.available}, 결과 저장: ${pkg.paths.pythonAnalysisPath}`);
        } else {
          console.log(`  결과 검증 실패, Python 결과 없이 계속 진행: ${validation.errors.join('; ')}`);
        }
      } else {
        console.log('  Python 분석 실패, Codex 단독 결과로 계속 진행합니다.');
      }
    } else {
      console.log('\n=== 3. Python 분석 건너뜀 (미사용 가능) ===');
    }

    console.log('\n=== 4. Codex 분석 실행 ===');
    const rawJsonExcerpt = (await readFile(pkg.paths.rawJsonPath, 'utf8')).slice(0, RAW_JSON_EXCERPT_LIMIT);
    const prompt = buildAnalysisPrompt({
      productSummary: JSON.stringify(pkg.productSummary),
      rawJsonExcerpt,
      imageCount: pkg.detailImagePaths.length,
    });
    const codexResult = await runCodexAnalysis({
      config: codexConfig,
      cwd: pkg.paths.root,
      images: pkg.detailImagePaths,
      schemaPath: `${root}/schemas/product-analysis.schema.json`,
      outputPath: pkg.paths.codexAnalysisPath,
      prompt,
    });
    await writeFile(pkg.paths.codexLogPath, codexResult.log || '');
    console.log(`  성공 여부: ${codexResult.success} (exitCode=${codexResult.exitCode})`);
    if (!codexResult.success) {
      console.error('Codex 분석 실패. 중단합니다.');
      process.exitCode = 1;
      return;
    }
    const codexValidation = validateProductAnalysis(codexResult.analysis);
    if (!codexValidation.valid) {
      console.error('Codex 결과 검증 실패:', codexValidation.errors.join('; '));
      process.exitCode = 1;
      return;
    }
    console.log(`  결과 저장: ${pkg.paths.codexAnalysisPath}`);

    console.log('\n=== 5. 결과 병합 ===');
    const merged = mergeAnalysis({ codexAnalysis: codexResult.analysis, pythonAnalysis });
    await writeFile(pkg.paths.mergedAnalysisPath, JSON.stringify(merged, null, 2));
    console.log(`  결과 저장: ${pkg.paths.mergedAnalysisPath}`);

    console.log('\n=== 6. 최종 요약 ===');
    for (const key of ['material', 'dimensions', 'manufacturer', 'countryOfOrigin', 'handlingPrecautions']) {
      const field = merged[key];
      console.log(`  ${key}: ${JSON.stringify(field.value)} (confidence=${field.confidence}, sources=${JSON.stringify(field.sources)})`);
    }
    for (const key of ['colors', 'components']) {
      const field = merged[key];
      console.log(`  ${key}: ${JSON.stringify(field.values)} (confidence=${field.confidence}, sources=${JSON.stringify(field.sources)})`);
    }
    console.log(`  unresolvedFields: ${JSON.stringify(merged.unresolvedFields)}`);
    console.log(`  conflicts: ${merged.conflicts.length}건`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('analyze-product failed:', error.message);
  process.exitCode = 1;
});
