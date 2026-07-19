import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadDatabaseUrl, loadJobPathsConfig, loadPythonConfig } from '../src/config.mjs';
import { checkPythonAvailability, runPythonAnalysis } from '../src/python-client.mjs';
import { buildAnalysisInputPackage } from '../src/product-job-folder.mjs';
import { validatePythonAnalysis } from '../src/python-analysis-schema.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

const root = process.cwd();
const draftId = Number((process.argv.find((arg) => arg.startsWith('--draft=')) || '--draft=64').split('=')[1]);
const workerDir = join(root, 'workers', 'python');

async function main() {
  const pythonConfig = await loadPythonConfig(root);
  const jobPathsConfig = await loadJobPathsConfig(root);

  console.log('=== 1. Python 실행 환경 확인 ===');
  const availability = await checkPythonAvailability({ config: pythonConfig });
  console.log(`  available=${availability.available} version=${availability.version || 'n/a'}`);
  console.log(`  message: ${availability.message}`);
  if (!availability.available) {
    console.error('Python 실행 파일을 찾을 수 없습니다. 설치 후 PYTHON_EXECUTABLE(.env)을 실제 경로로 설정하세요. 예) winget install --id Python.Python.3.12');
    console.error('OCR(Tesseract)이 필요하면: winget install --id UB-Mannheim.TesseractOCR, 한국어는 kor.traineddata를 TESSDATA_PREFIX_DIR에 배치.');
    process.exitCode = 1;
    return;
  }

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    console.log(`\n=== 2. draft ${draftId} 입력 패키지 준비 ===`);
    const pkg = await buildAnalysisInputPackage({ db, rootDir: root, jobDir: jobPathsConfig.jobDir, draftId });
    console.log(`  job folder: ${pkg.paths.root}`);

    console.log('\n=== 3. Python 분석 실행 ===');
    const result = await runPythonAnalysis({ config: pythonConfig, workerDir, jobDir: pkg.paths.root });
    await writeFile(pkg.paths.pythonLogPath, result.log || '');
    console.log(`  성공 여부: ${result.success} (exitCode=${result.exitCode}, timedOut=${result.timedOut}, truncated=${result.truncated})`);
    console.log(`  로그 저장: ${pkg.paths.pythonLogPath}`);
    if (!result.success) {
      console.error('Python 분석 실행 실패. 로그를 확인하세요. (Codex 단독 결과는 영향받지 않습니다)');
      process.exitCode = 1;
      return;
    }

    console.log('\n=== 4. 결과 검증 ===');
    const validation = validatePythonAnalysis(result.analysis);
    console.log(`  valid=${validation.valid}`);
    if (!validation.valid) {
      for (const error of validation.errors) console.log(`   - ${error}`);
      process.exitCode = 1;
      return;
    }
    await writeFile(pkg.paths.pythonAnalysisPath, JSON.stringify(result.analysis, null, 2));
    console.log(`  결과 저장: ${pkg.paths.pythonAnalysisPath}`);

    console.log('\n=== 5. 요약 ===');
    console.log(`  OCR available=${result.analysis.ocrMeta.available} (${result.analysis.ocrMeta.message})`);
    console.log(`  처리 이미지: ${result.analysis.ocrMeta.imagesProcessed}장 / OCR 성공: ${result.analysis.ocrMeta.imagesOcrOk}장`);
    for (const key of ['material', 'dimensions', 'manufacturer', 'countryOfOrigin', 'handlingPrecautions']) {
      const field = result.analysis[key];
      console.log(`  ${key}: ${JSON.stringify(field.value)} (source=${field.source}, confidence=${field.confidence})`);
    }
    for (const key of ['colors', 'components']) {
      const field = result.analysis[key];
      console.log(`  ${key}: ${JSON.stringify(field.values)} (source=${field.source}, confidence=${field.confidence})`);
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('analyze-python-product failed:', error.message);
  process.exitCode = 1;
});
