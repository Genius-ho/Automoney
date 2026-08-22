import { mkdir, writeFile } from 'node:fs/promises';

import { CoupangClient, maskAccessKey } from '../src/coupang-client.mjs';
import { createCoupangCategoryAdapter } from '../src/coupang-category-adapter.mjs';
import { loadCoupangConfig, loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';
import { exportProductDraft } from '../src/admin-store.mjs';

const root = process.cwd();
const draftId = Number((process.argv.find((arg) => arg.startsWith('--draft=')) || '--draft=64').split('=')[1]);

const report = {
  draftId,
  authenticationSucceeded: false,
  vendorId: null,
  outboundShippingPlaces: [],
  returnShippingCenters: [],
  categoryPrediction: null,
  categoryMeta: null,
  currentlyReadyFields: [],
  actuallyMissingFields: [],
  errors: [],
};

function logStep(label) {
  console.log(`\n=== ${label} ===`);
}

function recordError(step, error) {
  const safeMessage = error?.name === 'CoupangApiError'
    ? `HTTP ${error.status} (${error.operation}): ${error.bodyPreview}`
    : error.message;
  report.errors.push({ step, message: safeMessage });
  console.log(`  실패: ${safeMessage}`);
}

async function main() {
  const config = await loadCoupangConfig(root);
  report.vendorId = config.vendorId;
  console.log(`vendorId=${config.vendorId} accessKey=${maskAccessKey(config.accessKey)} (secretKey/signature는 출력하지 않음)`);

  const client = new CoupangClient(config);
  const categoryAdapter = createCoupangCategoryAdapter(client);

  logStep('1. 출고지 목록 조회');
  try {
    const raw = await client.listOutboundShippingPlaces();
    report.authenticationSucceeded = true;
    const places = extractList(raw);
    report.outboundShippingPlaces = places.map(normalizeShippingPlace);
    report.outboundShippingPlacesRaw = raw;
    report.outboundShippingPlaces.forEach((place) => console.log(`  - ${place.shippingPlaceName ?? '(이름 없음)'} / outboundShippingPlaceCode=${place.outboundShippingPlaceCode ?? '(코드 없음)'}`));
    if (places.length === 0) console.log('  등록된 출고지가 없습니다.');
  } catch (error) {
    recordError('list_outbound_shipping_places', error);
  }

  logStep('2. 반품지 목록 조회');
  try {
    const raw = await client.listReturnShippingCenters();
    report.authenticationSucceeded = true;
    const centers = extractList(raw);
    report.returnShippingCenters = centers.map(normalizeReturnCenter);
    report.returnShippingCentersRaw = raw;
    report.returnShippingCenters.forEach((center) => console.log(`  - ${center.shippingPlaceName ?? '(이름 없음)'} / returnCenterCode=${center.returnCenterCode ?? '(코드 없음)'}`));
    if (centers.length === 0) console.log('  등록된 반품지가 없습니다.');
  } catch (error) {
    recordError('list_return_shipping_centers', error);
  }

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  let draft;
  try {
    draft = await exportProductDraft(db, draftId, 'coupang');
    if (!draft) throw new Error(`draft ${draftId} not found`);

    logStep('3. draft 최적화 상품명으로 카테고리 추천');
    const productName = draft.optimizedTitle || draft.sellerProductName;
    console.log(`  검색 상품명: ${productName}`);
    try {
      const prediction = await categoryAdapter.predictCategory(productName);
      report.categoryPrediction = prediction;
      console.log(`  추천 결과: displayCategoryCode=${prediction.displayCategoryCode} / categoryName=${prediction.categoryName} / resultType=${prediction.predictionResultType}`);

      if (prediction.displayCategoryCode) {
        logStep('4. 선택된 displayCategoryCode 메타정보 조회');
        try {
          const meta = await categoryAdapter.getCategoryMeta(prediction.displayCategoryCode);
          report.categoryMeta = meta;
          console.log(`  카테고리 경로: ${meta.categoryPath.join(' > ') || '(경로 정보 없음)'}`);
          console.log(`  전체 구매옵션 ${meta.attributes.length}개 중 필수(MANDATORY): ${JSON.stringify(meta.mandatoryOptionNames)}`);
          console.log(`  고시정보 템플릿 후보 (${meta.noticeCategoryTemplates.length}개, 판매자가 실제 상품에 맞는 템플릿 1개를 선택해야 함):`);
          meta.noticeCategoryTemplates.forEach((template) => {
            const names = template.noticeCategoryDetailNames.map((detail) => detail.noticeCategoryDetailName);
            console.log(`    - ${template.noticeCategoryName}: ${JSON.stringify(names)}`);
          });
          console.log(`  필수(MANDATORY) 인증정보: ${JSON.stringify(meta.mandatoryCertificationNames)} (전체 ${meta.certifications.length}개 중)`);
          console.log(`  조건부 필수서류(구비서류): ${JSON.stringify(meta.requiredDocumentNames.filter((doc) => doc.required !== 'OPTIONAL'))}`);
        } catch (error) {
          recordError('get_category_meta', error);
        }
      } else {
        console.log('  추천된 카테고리 코드가 없어 메타정보 조회를 생략합니다.');
      }
    } catch (error) {
      recordError('predict_category', error);
    }

    logStep('5. draft 64 현재 데이터 대비 실제 누락 필드 계산');
    const ready = [];
    const missing = [];

    if (draft.optimizedTitle) ready.push(`상품명: ${draft.optimizedTitle}`); else missing.push('최적화 상품명');
    if (draft.salePrice) ready.push(`판매가: ${draft.salePrice}`); else missing.push('판매가');
    missing.push('재고 수량 (product_drafts 스키마에 필드 없음)');
    if (draft.approvedAiDetailImageCount === 10) ready.push('승인 상세이미지 10장'); else missing.push('승인 상세이미지 10장');
    if (Array.isArray(draft.mainImages) && draft.mainImages.length > 0) ready.push('승인 대표이미지 1장'); else missing.push('승인 대표이미지 1장');
    missing.push('이미지 공개 호스팅 (로컬 경로만 존재, 외부 접근 불가)');

    if (report.categoryPrediction?.displayCategoryCode) ready.push(`추천 카테고리: ${report.categoryPrediction.displayCategoryCode} (${report.categoryPrediction.categoryName}) — 사람 확인/확정 필요`);
    else missing.push('쿠팡 확정 카테고리');

    const meta = report.categoryMeta;
    if (meta) {
      const draftOptionNames = new Set((draft.options || []).map((option) => option.optionName));
      for (const name of meta.mandatoryOptionNames) {
        if (draftOptionNames.has(name)) ready.push(`필수 구매옵션 [${name}] 존재`);
        else missing.push(`필수 구매옵션 [${name}] (쿠팡 카테고리 요구, draft 옵션과 매칭 안 됨: ${JSON.stringify([...draftOptionNames])})`);
      }

      const noticeItems = draft.registrationOptimization?.notice?.[0]?.noticeItems || {};
      missing.push(`고시정보 템플릿 미확정 (후보 ${meta.noticeCategoryTemplates.length}개 중 실제 상품에 맞는 1개를 사람이 선택해야 함: ${JSON.stringify(meta.noticeCategoryTemplates.map((t) => t.noticeCategoryName))})`);
      for (const [key, value] of Object.entries(noticeItems)) {
        if (value) ready.push(`고시정보 [${key}]: ${value}`); else missing.push(`고시정보 [${key}] (draft에 값 없음)`);
      }

      if (meta.mandatoryCertificationNames.length > 0) missing.push(`필수 인증정보: ${JSON.stringify(meta.mandatoryCertificationNames)}`);
      else ready.push('이 카테고리는 필수(MANDATORY) 인증정보 없음');

      const mandatoryDocs = meta.requiredDocumentNames.filter((doc) => doc.required !== 'OPTIONAL');
      if (mandatoryDocs.length > 0) missing.push(`조건부 필수서류: ${JSON.stringify(mandatoryDocs)}`);
      else ready.push('무조건 필수인 구비서류 없음 (조건부 서류만 존재)');
    } else {
      missing.push('카테고리 메타정보 조회 실패로 필수 옵션/고시정보/인증 요구사항을 확인하지 못함');
    }

    missing.push('sellerProductId 저장 컬럼 (product_drafts 스키마에 없음, 재실행 시 중복 방지 불가)');

    report.currentlyReadyFields = ready;
    report.actuallyMissingFields = missing;
    ready.forEach((line) => console.log(`  준비됨: ${line}`));
    missing.forEach((line) => console.log(`  누락: ${line}`));
  } finally {
    await db.end();
  }

  await mkdir(`${root}/artifacts`, { recursive: true });
  await writeFile(`${root}/artifacts/coupang-preflight-draft-${draftId}-result.json`, JSON.stringify(report, null, 2));
  console.log(`\n결과 저장: artifacts/coupang-preflight-draft-${draftId}-result.json`);
  console.log('\n상품 생성 API는 호출하지 않았습니다 (read-only preflight).');
}

function extractList(raw) {
  const payload = raw?.data ?? raw;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.elements)) return payload.elements;
  return [];
}

function normalizeShippingPlace(place) {
  return {
    shippingPlaceName: place?.shippingPlaceName ?? place?.name ?? null,
    outboundShippingPlaceCode: place?.outboundShippingPlaceCode ?? place?.shippingPlaceCode ?? place?.code ?? null,
    raw: place,
  };
}

function normalizeReturnCenter(center) {
  return {
    shippingPlaceName: center?.shippingPlaceName ?? center?.returnCenterName ?? center?.name ?? null,
    returnCenterCode: center?.returnCenterCode ?? center?.code ?? null,
    raw: center,
  };
}

main().catch((error) => {
  console.error('coupang:preflight failed:', error.message);
  process.exitCode = 1;
});
