import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { CoupangClient } from '../src/coupang-client.mjs';
import { createCoupangCategoryAdapter } from '../src/coupang-category-adapter.mjs';
import { buildCoupangProductPayload, extractSupplierNoticeFields, formatKstDateTime, mapOptionsToMandatoryAttributes } from '../src/coupang-payload-builder.mjs';
import { loadCoupangConfig, loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';
import { exportProductDraft } from '../src/admin-store.mjs';

const root = process.cwd();
const draftId = Number((process.argv.find((arg) => arg.startsWith('--draft=')) || '--draft=64').split('=')[1]);
const DISPLAY_CATEGORY_CODE = 71691;
const NOTICE_CATEGORY_TEMPLATE_NAME = '패션잡화(모자/벨트/액세서리 등)';
const CANDIDATE_OUTBOUND_SHIPPING_PLACE_CODE = 23777733;
const CANDIDATE_RETURN_CENTER_CODE = '1002401151';
const SALE_ENDED_AT = '2099-12-31T23:59:59';
const WARRANTY_STANDARD = '관련 법 및 소비자분쟁해결기준에 따름';
// Confirmed with the user directly -- not present anywhere in Domeme source data.
const DELIVERY_COMPANY_CODE = 'CJGLS';

// Read visually off public/generated-images/drafts/64/detail-3369-slice-009.jpg
// (a size diagram baked into the original detail-page image itself) and
// slice-001/005 ("투명한 아크릴 케이스" / "서랍 전체 벨벳원단으로 제작") --
// not present anywhere as extractable text in raw_json, so these are recorded
// as manually-verified constants for this one draft rather than a generic
// extraction the code can repeat for other products.
const VERIFIED_MATERIAL = '아크릴(케이스), 벨벳(서랍 내부)';
const VERIFIED_SIZE = '23.5 x 13.5 x 10.5cm (측정 위치에 따라 0.5~1cm 오차 가능, 원본 표기 기준)';
// Coupang caps the mandatory "주얼리 사이즈" purchase-option attribute value at
// 30 characters, so the caveat above only fits in the (unrestricted) 치수
// notice field -- this short form carries the same real measurement alone.
const SIZE_ATTRIBUTE_VALUE = '23.5 x 13.5 x 10.5cm';
// Paraphrased from the supplier's own delivery/exchange notice image
// (하단공지사항-001.jpg): "고객님의 부주의로 인한 부상 및 제품 파손 시 자사는
// 법적 책임이 없습니다", "사용감이 있는 제품의 경우 교환/반품/환불이 불가합니다".
const HANDLING_CAUTION = '사용자 부주의로 인한 파손·부상에 대해 판매자는 책임지지 않으며, 사용감이 있는 경우 교환·반품이 불가합니다. (원본 공급처 안내 기준)';

async function main() {
  const config = await loadCoupangConfig(root);
  const client = new CoupangClient(config);
  const categoryAdapter = createCoupangCategoryAdapter(client);

  console.log('=== 1. 출고지/반품지 후보를 실제 API로 재확인 ===');
  const outboundList = extractList(await client.listOutboundShippingPlaces());
  const outboundShippingPlace = outboundList.find((place) => Number(place.outboundShippingPlaceCode) === CANDIDATE_OUTBOUND_SHIPPING_PLACE_CODE) || null;
  if (!outboundShippingPlace) throw new Error(`outboundShippingPlaceCode ${CANDIDATE_OUTBOUND_SHIPPING_PLACE_CODE} not found in live list`);
  console.log(`  출고지: ${outboundShippingPlace.shippingPlaceName} / usable=${outboundShippingPlace.usable} / ${outboundShippingPlace.placeAddresses?.[0]?.returnAddress || '(주소 없음)'}`);

  const returnList = extractList(await client.listReturnShippingCenters());
  const returnShippingCenter = returnList.find((center) => String(center.returnCenterCode) === CANDIDATE_RETURN_CENTER_CODE) || null;
  if (!returnShippingCenter) throw new Error(`returnCenterCode ${CANDIDATE_RETURN_CENTER_CODE} not found in live list`);
  console.log(`  반품지: ${returnShippingCenter.shippingPlaceName} / usable=${returnShippingCenter.usable} / ${returnShippingCenter.placeAddresses?.[0]?.returnAddress || '(주소 없음)'}`);

  const asPhoneNumber = outboundShippingPlace.placeAddresses?.[0]?.companyContactNumber
    || returnShippingCenter.placeAddresses?.[0]?.companyContactNumber
    || null;
  console.log(`  A/S·소비자상담 전화번호(출고지/반품지 등록 연락처): ${asPhoneNumber ?? 'missing'}`);

  console.log(`\n=== 2. displayCategoryCode ${DISPLAY_CATEGORY_CODE} 메타정보 조회 ===`);
  const categoryMeta = await categoryAdapter.getCategoryMeta(DISPLAY_CATEGORY_CODE);
  const sizeAttribute = categoryMeta.attributes.find((attribute) => attribute.attributeTypeName !== '색상' && categoryMeta.mandatoryOptionNames.includes(attribute.attributeTypeName));
  console.log(`  필수 옵션: ${JSON.stringify(categoryMeta.mandatoryOptionNames)}`);
  console.log(`  주얼리 사이즈 속성 정의: inputType=${sizeAttribute?.inputType} / inputValues(allowed)=${JSON.stringify(sizeAttribute?.inputValues)} / usableUnits=${JSON.stringify(sizeAttribute?.usableUnits)}`);
  console.log(`  → inputType=INPUT(자유 입력), 허용값 목록 없음(자유 텍스트) → 원본에서 찾은 실측값을 그대로 사용, 없었다면 "상세페이지 참조"만 허용됐을 것`);
  console.log(`  선택한 고시정보 템플릿: ${NOTICE_CATEGORY_TEMPLATE_NAME}`);

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    console.log(`\n=== 3. draft ${draftId} 원본 데이터 + 상세이미지에서 고시정보 값 재조사 ===`);
    const draft = await exportProductDraft(db, draftId, 'coupang');
    if (!draft) throw new Error(`draft ${draftId} not found`);
    const draftRow = (await db.query('select supplier_product_id from product_drafts where id = $1', [draftId])).rows[0];
    const supplierProduct = (await db.query('select raw_json from supplier_products where id = $1', [draftRow.supplier_product_id])).rows[0];
    const supplierNoticeFields = extractSupplierNoticeFields(supplierProduct.raw_json);
    console.log(`  제조자: ${supplierNoticeFields.manufacturer ?? 'missing'}`);
    console.log(`  제조국: ${supplierNoticeFields.countryOfOrigin ?? 'missing'}`);
    console.log(`  모델명: ${supplierNoticeFields.modelName ?? 'missing'}`);
    console.log(`  소재: ${VERIFIED_MATERIAL} (원본 상세이미지 slice-001/005 텍스트에서 확인: "투명한 아크릴 케이스", "서랍 전체 벨벳원단")`);
    console.log(`  치수: ${VERIFIED_SIZE} (원본 상세이미지 slice-009의 실측 치수 다이어그램에서 확인)`);
    console.log(`  취급주의사항: 원본 공급처 안내(하단공지사항 이미지)에서 확인 → "${HANDLING_CAUTION}"`);
    console.log(`  품질보증기준(지정값): ${WARRANTY_STANDARD}`);
    console.log(`  A/S 책임자 전화번호(지정값, 출고지 API 응답): ${asPhoneNumber ?? 'missing'}`);
    if (supplierNoticeFields.supplierOwnContact) {
      console.log(`  참고: 원본 공급처 자체 연락처는 ${supplierNoticeFields.supplierOwnContact.companyName} ${supplierNoticeFields.supplierOwnContact.phone} — 우리 매장 연락처로 사용하지 않음`);
    }

    console.log('\n=== 4. 필수 구매옵션 매핑 (색상/주얼리 사이즈) ===');
    const stockByOptionValue = Object.fromEntries(
      (draft.options || [])
        .filter((option) => option.stockQuantity != null)
        .map((option) => [option.optionValue, option.stockQuantity]),
    );
    const optionMapping = mapOptionsToMandatoryAttributes({
      draftOptions: draft.options,
      mandatoryOptionNames: categoryMeta.mandatoryOptionNames,
      stockByOptionValue,
      sizeAttributeValue: SIZE_ATTRIBUTE_VALUE,
    });
    optionMapping.items.forEach((item) => console.log(`  옵션 [${item.optionValue}] stockQuantity=${item.stockQuantity ?? 'missing'}`));
    if (optionMapping.unresolvedMandatoryAttributes.length > 0) {
      console.log(`  미해결 필수옵션: ${JSON.stringify(optionMapping.unresolvedMandatoryAttributes)} (원본에서 확인 불가, 임의값 미입력)`);
    }
    if (optionMapping.missingStock.length > 0) {
      console.log(`  재고 미입력 옵션: ${JSON.stringify(optionMapping.missingStock)} — npm run coupang:set-stock -- --file=<config.json> 으로 입력 필요`);
    }

    let mainImageUrl = null;
    let approvedDetailImageUrls = draft.approvedAiDetailImages || [];
    try {
      const uploaded = JSON.parse(await readFile(`${root}/artifacts/coupang-uploaded-images-draft-${draftId}.json`, 'utf8'));
      if (uploaded.allOk) {
        const representation = uploaded.images.find((image) => image.role === 'REPRESENTATION');
        const details = uploaded.images.filter((image) => image.role === 'DETAIL').sort((a, b) => a.order - b.order);
        if (representation && details.length === 10) {
          mainImageUrl = representation.publicUrl;
          approvedDetailImageUrls = details.map((image) => image.publicUrl);
          console.log(`\n(R2 업로드 결과 발견: artifacts/coupang-uploaded-images-draft-${draftId}.json 의 공개 URL을 사용합니다)`);
        }
      }
    } catch {
      // No upload artifact yet -- fall back to local (non-public) paths.
    }

    console.log('\n=== 5. payload 조립 (requested=false, 상품 생성 API는 호출하지 않음) ===');
    const saleStartedAt = formatKstDateTime(new Date());
    const payload = buildCoupangProductPayload({
      draft,
      vendorId: config.vendorId,
      vendorUserId: config.vendorUserId,
      displayCategoryCode: DISPLAY_CATEGORY_CODE,
      categoryMeta,
      noticeCategoryTemplateName: NOTICE_CATEGORY_TEMPLATE_NAME,
      supplierNoticeFields,
      optionMapping,
      outboundShippingPlace,
      returnShippingCenter,
      mainImageUrl,
      approvedDetailImageUrls,
      material: VERIFIED_MATERIAL,
      verifiedSize: VERIFIED_SIZE,
      handlingCaution: HANDLING_CAUTION,
      warrantyStandard: WARRANTY_STANDARD,
      asPhoneNumber,
      saleStartedAt,
      saleEndedAt: SALE_ENDED_AT,
      deliveryCompanyCode: DELIVERY_COMPANY_CODE,
      deliveryCharge: draft.shippingFee || 0,
      returnCharge: draft.registrationOptimization?.shippingPolicies?.[0]?.returnShippingFee || 0,
      remoteAreaDeliverable: true,
      unionDeliverable: true,
      requested: false,
    });
    console.log(`  saleStartedAt(KST, 실행 시점): ${saleStartedAt}`);
    console.log(`  saleEndedAt: ${SALE_ENDED_AT}`);
    console.log(`  imagesPubliclyHosted: ${payload.imagesPubliclyHosted}`);
    console.log(`  deliveryCompanyCode: ${payload.deliveryCompanyCode} (사용자 확인값) / deliveryCharge=${payload.deliveryCharge} / returnCharge=${payload.returnCharge}`);
    console.log(`  items[].images: REPRESENTATION 1장만 (DETAIL 없음) -> ${payload.items[0].images[0].vendorPath}`);
    console.log(`  items[].contents[0].contentDetails: 승인 상세이미지 ${payload.items[0].contents[0].contentDetails.length}장, 순서 1~${payload.items[0].contents[0].contentDetails.length}`);

    const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await db.query(
      `insert into coupang_product_registrations (product_draft_id, seller_product_id, request_hash, status, requested)
       values ($1, null, $2, 'payload_prepared', false)
       on conflict (product_draft_id) do update set
         request_hash = excluded.request_hash,
         status = case when coupang_product_registrations.seller_product_id is null then 'payload_prepared' else coupang_product_registrations.status end,
         updated_at = now()
       returning id, status, requested, seller_product_id`,
      [draftId, requestHash],
    );
    console.log(`  request_hash=${requestHash.slice(0, 16)}... 저장됨 (coupang_product_registrations, seller_product_id는 아직 없음)`);

    await mkdir(`${root}/artifacts`, { recursive: true });
    const outputPath = `${root}/artifacts/coupang-product-payload-draft-${draftId}.json`;
    await writeFile(outputPath, JSON.stringify(payload, null, 2));
    console.log(`\n결과 저장: artifacts/coupang-product-payload-draft-${draftId}.json`);
    console.log('상품 생성 API는 호출하지 않았습니다.');
  } finally {
    await db.end();
  }
}

function extractList(raw) {
  const payload = raw?.data ?? raw;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.content)) return payload.content;
  return [];
}

main().catch((error) => {
  console.error('coupang:build-payload failed:', error.message);
  process.exitCode = 1;
});
