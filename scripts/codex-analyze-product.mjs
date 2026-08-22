import { readFile, writeFile } from 'node:fs/promises';

import { loadCodexConfig, loadDatabaseUrl, loadJobPathsConfig } from '../src/config.mjs';
import { checkCodexAvailability, runCodexAnalysis } from '../src/codex-client.mjs';
import { buildAnalysisInputPackage } from '../src/product-job-folder.mjs';
import { buildAnalysisPrompt, classifyConfidence, validateProductAnalysis } from '../src/product-analysis-schema.mjs';
import { createPgPool } from '../src/postgres-store.mjs';

const root = process.cwd();
const draftId = Number((process.argv.find((arg) => arg.startsWith('--draft=')) || '--draft=64').split('=')[1]);
const RAW_JSON_EXCERPT_LIMIT = 4000;

async function main() {
  const codexConfig = await loadCodexConfig(root);
  const jobPathsConfig = await loadJobPathsConfig(root);

  console.log('=== 1. Codex 연결 상태 확인 ===');
  const availability = await checkCodexAvailability({ config: codexConfig });
  console.log(`  available=${availability.available} loggedIn=${availability.loggedIn} version=${availability.version || 'n/a'}`);
  console.log(`  message: ${availability.message}`);
  if (!availability.available || !availability.loggedIn) {
    console.error('Codex CLI를 사용할 수 없습니다 (설치 또는 로그인 확인 필요). 중단합니다.');
    process.exitCode = 1;
    return;
  }

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    console.log(`\n=== 2. draft ${draftId} 작업 폴더 및 입력 패키지 생성 ===`);
    const pkg = await buildAnalysisInputPackage({ db, rootDir: root, jobDir: jobPathsConfig.jobDir, draftId });
    console.log(`  job folder: ${pkg.paths.root}`);
    console.log(`  상세 슬라이스 이미지: ${pkg.detailImagePaths.length}장`);
    console.log(`  대표 이미지: ${pkg.mainImagePath ? 'OK' : '없음(로컬 미보관)'}`);
    if (pkg.detailImagePaths.length === 0) {
      console.error('로컬에 보관된 상세페이지 원본 이미지가 없어 분석을 진행할 수 없습니다.');
      process.exitCode = 1;
      return;
    }

    console.log('\n=== 3. Codex 분석 실행 (read-only, job 폴더로 범위 제한) ===');
    const rawJsonExcerpt = (await readFile(pkg.paths.rawJsonPath, 'utf8')).slice(0, RAW_JSON_EXCERPT_LIMIT);
    const prompt = buildAnalysisPrompt({
      productSummary: JSON.stringify(pkg.productSummary),
      rawJsonExcerpt,
      imageCount: pkg.detailImagePaths.length,
    });

    const result = await runCodexAnalysis({
      config: codexConfig,
      cwd: pkg.paths.root,
      images: pkg.detailImagePaths,
      schemaPath: `${root}/schemas/product-analysis.schema.json`,
      outputPath: pkg.paths.codexAnalysisPath,
      prompt,
    });
    await writeFile(pkg.paths.codexLogPath, result.log || '');
    console.log(`  성공 여부: ${result.success} (exitCode=${result.exitCode}, timedOut=${result.timedOut})`);
    console.log(`  로그 저장: ${pkg.paths.codexLogPath}`);

    if (!result.success) {
      console.error('Codex 분석 실행 실패. 로그를 확인하세요.');
      process.exitCode = 1;
      return;
    }

    console.log('\n=== 4. 결과 JSON 검증 ===');
    const validation = validateProductAnalysis(result.analysis);
    console.log(`  valid=${validation.valid}`);
    if (!validation.valid) {
      for (const error of validation.errors) console.log(`   - ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  결과 저장: ${pkg.paths.codexAnalysisPath}`);

    console.log('\n=== 5. 분석 결과 요약 ===');
    for (const key of ['material', 'dimensions', 'manufacturer', 'countryOfOrigin', 'handlingPrecautions']) {
      const field = result.analysis[key];
      console.log(`  ${key}: ${JSON.stringify(field.value)} (confidence=${field.confidence}, ${classifyConfidence(field.confidence)}, evidence=${field.evidence.length}건)`);
    }
    for (const key of ['colors', 'components']) {
      const field = result.analysis[key];
      console.log(`  ${key}: ${JSON.stringify(field.values)} (confidence=${field.confidence}, ${classifyConfidence(field.confidence)}, evidence=${field.evidence.length}건)`);
    }
    console.log(`  searchTags: ${JSON.stringify(result.analysis.searchTags)}`);
    console.log(`  coupangTitleCandidate: ${JSON.stringify(result.analysis.coupangTitleCandidate)}`);
    console.log(`  unresolvedFields: ${JSON.stringify(result.analysis.unresolvedFields)}`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error('codex-analyze-product failed:', error.message);
  process.exitCode = 1;
});
