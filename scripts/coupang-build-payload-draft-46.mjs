import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { CoupangClient } from '../src/coupang-client.mjs';
import { createCoupangCategoryAdapter } from '../src/coupang-category-adapter.mjs';
import { buildCoupangProductPayload, extractSupplierNoticeFields, formatKstDateTime, mapOptionsToMandatoryAttributes } from '../src/coupang-payload-builder.mjs';
import { loadCoupangConfig, loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';
import { exportProductDraft } from '../src/admin-store.mjs';

const root = process.cwd();
const draftId = 46;
// Independently re-predicted for this draft via the category-prediction API
// (not copied from draft 64, which used a different category: 71691).
const DISPLAY_CATEGORY_CODE = 80704;
// Matches this product's own domeggook.detail.infoDuty.type verbatim, which
// is a genuine field this specific supplier record carries (draft 64's
// infoDuty.type was '패션잡화(모자/벨트/액세서리 등)' -- a different value).
const NOTICE_CATEGORY_TEMPLATE_NAME = '기타 재화';
// Same WowPick account infrastructure draft 64 ended up using, but
// independently re-verified here via a live API address match rather than
// assumed: outboundShippingPlaceCode 24466172's own address (zip 04713,
// 010-8795-2571, 119동 906호) is identical to returnCenterCode 1002401151's
// address in every field except JIBUN vs road-name text formatting.
const CANDIDATE_OUTBOUND_SHIPPING_PLACE_CODE = 24466172;
const CANDIDATE_RETURN_CENTER_CODE = '1002401151';
const SALE_ENDED_AT = '2099-12-31T23:59:59';
const WARRANTY_STANDARD = '관련 법 및 소비자분쟁해결기준에 따름';
const DELIVERY_COMPANY_CODE = 'CJGLS';

// Read directly off the (already user-approved) generated detail-page image
// #9 ("구매 전 꼭 확인하세요" spec panel), which states 색상/옵션: 아이보리 /
// 단일 옵션 and 사이즈: 약 200 x 430 x 60 mm for the single physical unit.
// This product ships in a mandatory minimum order of 2 (see draft.bundleQuantity),
// so the "수량" mandatory attribute is filled with that real count.
const COLOR_ATTRIBUTE_VALUE = '아이보리';
const SIZE_ATTRIBUTE_VALUE = '200 x 430 x 60mm';
const QUANTITY_ATTRIBUTE_VALUE = '2';
// Price/cost were recalculated for the real 2-unit minimum order (see the
// processing.mjs bundling fix), so the listing name must say so explicitly
// or buyers will not understand why they're paying for two units.
const NAME_SUFFIX = ' 2개 세트';
const ITEM_NAME = `${COLOR_ATTRIBUTE_VALUE} 2개세트`;
const SEARCH_TAGS = ['레일선반', '슬라이드선반', '주방정리', '수납정리함', '무타공선반', '틈새수납장', '다용도선반', '주방수납', '2개세트', '아이보리'];
// Set once the initial createProduct call returned a sellerProductId, so
// re-running this script now produces a *modify* payload (PUT) instead of a
// fresh create payload.
const EXISTING_SELLER_PRODUCT_ID = 16301910938;
const EXISTING_SELLER_PRODUCT_ITEM_IDS = [38202857893];
// Domeme's own infoDuty marks every notice field "상세정보 별도표기" (provided
// separately) rather than blank, but the underlying detail.* fields this
// supplier record actually carries do have real values.
const HANDLING_CAUTION = null; // not present anywhere in source data or generated images; left unfilled rather than invented.

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

  const outboundAddr = outboundShippingPlace.placeAddresses?.[0] || {};
  const returnAddr = returnShippingCenter.placeAddresses?.[0] || {};
  const addressMatches = outboundAddr.returnZipCode === returnAddr.returnZipCode
    && outboundAddr.companyContactNumber === returnAddr.companyContactNumber
    && outboundAddr.returnAddressDetail === returnAddr.returnAddressDetail;
  console.log(`  출고지/반품지 동일 주소 확인: ${addressMatches ? 'OK' : 'MISMATCH -- 재검토 필요'}`);
  if (!addressMatches) throw new Error('outbound/return address mismatch -- refusing to proceed on an unverified pairing');

  const asPhoneNumber = outboundAddr.companyContactNumber || returnAddr.companyContactNumber || null;
  console.log(`  A/S·소비자상담 전화번호(출고지/반품지 등록 연락처): ${asPhoneNumber ?? 'missing'}`);

  console.log(`\n=== 2. displayCategoryCode ${DISPLAY_CATEGORY_CODE} 메타정보 조회 ===`);
  const categoryMeta = await categoryAdapter.getCategoryMeta(DISPLAY_CATEGORY_CODE);
  console.log(`  필수 옵션: ${JSON.stringify(categoryMeta.mandatoryOptionNames)}`);
  console.log(`  선택한 고시정보 템플릿: ${NOTICE_CATEGORY_TEMPLATE_NAME} (원본 domeggook.detail.infoDuty.type과 동일)`);

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    console.log(`\n=== 3. draft ${draftId} 원본 데이터에서 고시정보 값 재조사 ===`);
    const draft = await exportProductDraft(db, draftId, 'coupang');
    if (!draft) throw new Error(`draft ${draftId} not found`);
    const draftRow = (await db.query('select supplier_product_id from product_drafts where id = $1', [draftId])).rows[0];
    const supplierProduct = (await db.query('select raw_json from supplier_products where id = $1', [draftRow.supplier_product_id])).rows[0];
    const supplierNoticeFields = extractSupplierNoticeFields(supplierProduct.raw_json);
    console.log(`  제조자(원본): ${supplierNoticeFields.manufacturer ?? 'missing'} -> 표기값: 와우픽 (draft 64와 동일 정책: 판매자가 자사 브랜드로 표기)`);
    console.log(`  제조국: ${supplierNoticeFields.countryOfOrigin ?? 'missing'}`);
    console.log(`  모델명: ${supplierNoticeFields.modelName ?? 'missing'}`);
    console.log(`  사이즈(단일 유닛, 생성 상세이미지 9번 실측 패널): ${SIZE_ATTRIBUTE_VALUE}`);
    console.log(`  색상(생성 상세이미지 9번 실측 패널): ${COLOR_ATTRIBUTE_VALUE}`);
    console.log(`  수량(필수구매옵션, 최소구매수량=2 반영): ${QUANTITY_ATTRIBUTE_VALUE}개`);
    console.log('  인증/허가 사항: 해당없음 (카테고리 메타상 필수 인증 없음, preflight 확인됨)');
    console.log(`  취급주의사항: 원본/생성이미지 어디에도 없어 값 없음으로 둠 (임의 작성하지 않음)`);
    console.log(`  품질보증기준(지정값): ${WARRANTY_STANDARD}`);
    console.log(`  A/S 책임자 전화번호(지정값, 출고지 API 응답): ${asPhoneNumber ?? 'missing'}`);

    console.log('\n=== 4. 필수 구매옵션 매핑 (색상/사이즈/수량) ===');
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
      additionalAttributeValues: { 수량: QUANTITY_ATTRIBUTE_VALUE },
      exposed: 'NONE',
    });
    optionMapping.items.forEach((item) => console.log(`  옵션 [${item.optionValue}] stockQuantity=${item.stockQuantity ?? 'missing'}`));
    if (optionMapping.unresolvedMandatoryAttributes.length > 0) {
      console.log(`  미해결 필수옵션: ${JSON.stringify(optionMapping.unresolvedMandatoryAttributes)} (원본에서 확인 불가, 임의값 미입력)`);
    }
    if (optionMapping.missingStock.length > 0) {
      console.log(`  재고 미입력 옵션: ${JSON.stringify(optionMapping.missingStock)}`);
    }

    let mainImageUrl = null;
    let approvedDetailImageUrls = draft.approvedAiDetailImages || [];
    let detailImageUrlsForImages = [];
    try {
      const uploaded = JSON.parse(await readFile(`${root}/artifacts/coupang-uploaded-images-draft-${draftId}.json`, 'utf8'));
      if (uploaded.allOk) {
        const representation = uploaded.images.find((image) => image.role === 'REPRESENTATION');
        const details = uploaded.images.filter((image) => image.role === 'DETAIL').sort((a, b) => a.order - b.order);
        if (representation && details.length === 10) {
          mainImageUrl = representation.publicUrl;
          approvedDetailImageUrls = details.map((image) => image.publicUrl);
          // Coupang caps items[].images at 1 REPRESENTATION + 9 DETAIL, so only
          // the first 9 go here -- the full ordered 10 still goes into contents
          // below. Draft 64 does the same split; this draft's payload had
          // omitted it, which is why Wing's product-lookup image gallery (which
          // reads items[].images, not contents) showed only 1 image.
          detailImageUrlsForImages = details.slice(0, 9).map((image) => image.publicUrl);
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
      supplierNoticeFields: { ...supplierNoticeFields, manufacturer: '와우픽' },
      noticeContentOverrides: { '인증/허가 사항': '해당없음' },
      optionMapping,
      outboundShippingPlace,
      returnShippingCenter,
      mainImageUrl,
      approvedDetailImageUrls,
      detailImageUrlsForImages,
      material: null,
      verifiedSize: null,
      handlingCaution: HANDLING_CAUTION,
      warrantyStandard: WARRANTY_STANDARD,
      asPhoneNumber,
      brand: '와우픽',
      manufacture: '와우픽',
      sellerProductNameOverride: `${draft.optimizedTitle}${NAME_SUFFIX}`,
      displayProductNameOverride: `${draft.displayProductName}${NAME_SUFFIX}`,
      itemNameOverride: ITEM_NAME,
      searchTags: SEARCH_TAGS,
      saleStartedAt,
      saleEndedAt: SALE_ENDED_AT,
      deliveryCompanyCode: DELIVERY_COMPANY_CODE,
      deliveryCharge: draft.shippingFee || 0,
      returnCharge: draft.registrationOptimization?.shippingPolicies?.[0]?.returnShippingFee || 0,
      // Coupang rejected the first submission (remoteAreaDeliverable: true)
      // with: "도서산간배송 출고지에 등록된 택배사만 선택할 수 있습니다" -- CJGLS is
      // not registered as a remote-area courier at the 행당 outbound place, so
      // remote-area delivery must be turned off here, same as draft 64 ended
      // up doing.
      remoteAreaDeliverable: false,
      unionDeliverable: true,
      sellerProductId: EXISTING_SELLER_PRODUCT_ID,
      sellerProductItemIds: EXISTING_SELLER_PRODUCT_ITEM_IDS,
      requested: false,
    });
    console.log(`  saleStartedAt(KST, 실행 시점): ${saleStartedAt}`);
    console.log(`  saleEndedAt: ${SALE_ENDED_AT}`);
    console.log(`  imagesPubliclyHosted: ${payload.imagesPubliclyHosted}`);
    console.log(`  deliveryCompanyCode: ${payload.deliveryCompanyCode} / deliveryCharge=${payload.deliveryCharge} / returnCharge=${payload.returnCharge}`);
    console.log(`  items[].images: REPRESENTATION 1 + DETAIL ${payload.items[0]?.images?.filter((i) => i.imageType === 'DETAIL').length ?? 0}장`);
    console.log(`  items[].contents[0].contentDetails: 승인 상세이미지 ${payload.items[0]?.contents?.[0]?.contentDetails?.length}장`);
    console.log(`  items.length: ${payload.items.length}`);

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
  console.error('coupang-build-payload-draft-46 failed:', error.message);
  process.exitCode = 1;
});
