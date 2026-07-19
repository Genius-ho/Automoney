import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { CoupangClient, CoupangApiError } from '../src/coupang-client.mjs';
import { createCoupangCategoryAdapter } from '../src/coupang-category-adapter.mjs';
import { buildCoupangProductPayload, extractSupplierNoticeFields, mapOptionsToMandatoryAttributes } from '../src/coupang-payload-builder.mjs';
import { loadCoupangConfig, loadDatabaseUrl } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';
import { exportProductDraft } from '../src/admin-store.mjs';

const root = process.cwd();
const draftId = 64;
const SELLER_PRODUCT_ID = 16301574570;
const DISPLAY_CATEGORY_CODE = 71691;
const NOTICE_CATEGORY_TEMPLATE_NAME = '패션잡화(모자/벨트/액세서리 등)';
const OUTBOUND_SHIPPING_PLACE_CODE = 24466172; // 행당
const RETURN_CENTER_CODE = '1002401151'; // 반품지1 -- confirmed address-matched to 행당 by the user
const WARRANTY_STANDARD = '관련 법 및 소비자분쟁해결기준에 따름';
const DELIVERY_COMPANY_CODE = 'CJGLS';
const BRAND = '와우픽';
const DISPLAY_PRODUCT_NAME = '와우픽 3단 주얼리함 보석함 액세서리 수납함';
// Visually confirmed: the approved representation photo shows only the grey
// velvet-tray variant, not both colors side by side, so the single surviving
// item keeps the "그레이" identity (existing sellerProductItemId 38201516160)
// per the user's own rule ("두 색상이 모두 있으면 베이지/그레이", otherwise the
// one actually shown).
const SURVIVING_ITEM_ID = 38201516160;
const SURVIVING_COLOR = '그레이';
const STOCK_QUANTITY = 10;
const SIZE_ATTRIBUTE_VALUE = '23.5 x 13.5 x 10.5cm';
const VERIFIED_MATERIAL = '아크릴(케이스), 벨벳(서랍 내부)';
const VERIFIED_SIZE_NOTICE = '23.5 x 13.5 x 10.5cm (측정 위치에 따라 0.5~1cm 오차 가능, 원본 표기 기준)';
const HANDLING_CAUTION = '사용자 부주의로 인한 파손·부상에 대해 판매자는 책임지지 않으며, 사용감이 있는 경우 교환·반품이 불가합니다. (원본 공급처 안내 기준)';
const SEARCH_TAGS = [...new Set([
  '주얼리함', '보석함', '주얼리보관함', '액세서리보관함', '3단보석함', '서랍형보석함',
  '귀걸이보관함', '반지보관함', '목걸이보관함', '화장대수납함', '아크릴보석함', '벨벳보석함',
])];

async function main() {
  const config = await loadCoupangConfig(root);
  const client = new CoupangClient(config);
  const categoryAdapter = createCoupangCategoryAdapter(client);

  console.log('=== 1. 수정 전 현재 상품 조회 ===');
  const before = await client.getProduct(SELLER_PRODUCT_ID);
  console.log(`  statusName=${before.data.statusName} / requested=${before.data.requested} / items=${before.data.items.map((i) => `${i.itemName}(${i.sellerProductItemId})`).join(', ')}`);

  console.log('\n=== 2. 출고지(행당)/반품지(반품지1) 실제 API 재확인 ===');
  const outboundList = extractList(await client.listOutboundShippingPlaces());
  const outboundShippingPlace = outboundList.find((place) => Number(place.outboundShippingPlaceCode) === OUTBOUND_SHIPPING_PLACE_CODE);
  if (!outboundShippingPlace) throw new Error(`outboundShippingPlaceCode ${OUTBOUND_SHIPPING_PLACE_CODE} not found`);
  console.log(`  출고지: ${outboundShippingPlace.shippingPlaceName} / usable=${outboundShippingPlace.usable}`);

  const returnList = extractList(await client.listReturnShippingCenters());
  const returnShippingCenter = returnList.find((center) => String(center.returnCenterCode) === RETURN_CENTER_CODE);
  if (!returnShippingCenter) throw new Error(`returnCenterCode ${RETURN_CENTER_CODE} not found`);
  console.log(`  반품지: ${returnShippingCenter.shippingPlaceName} / usable=${returnShippingCenter.usable}`);
  const outboundAddr = outboundShippingPlace.placeAddresses?.[0] || {};
  const returnAddr = returnShippingCenter.placeAddresses?.[0] || {};
  const addressMatches = outboundAddr.returnZipCode === returnAddr.returnZipCode && outboundAddr.companyContactNumber === returnAddr.companyContactNumber;
  console.log(`  주소 일치(zip+연락처 기준): ${addressMatches}`);
  const asPhoneNumber = outboundAddr.companyContactNumber || returnAddr.companyContactNumber || null;

  const categoryMeta = await categoryAdapter.getCategoryMeta(DISPLAY_CATEGORY_CODE);

  const dbUrl = await loadDatabaseUrl(root);
  const db = await createPgPool(dbUrl);
  try {
    const draft = await exportProductDraft(db, draftId, 'coupang');
    const draftRow = (await db.query('select supplier_product_id from product_drafts where id = $1', [draftId])).rows[0];
    const supplierProduct = (await db.query('select raw_json from supplier_products where id = $1', [draftRow.supplier_product_id])).rows[0];
    const rawSupplierNoticeFields = extractSupplierNoticeFields(supplierProduct.raw_json);
    const supplierNoticeFields = { ...rawSupplierNoticeFields, manufacturer: BRAND };

    console.log('\n=== 3. 단일상품 옵션/속성 구성 (exposed:NONE) ===');
    const optionMapping = mapOptionsToMandatoryAttributes({
      draftOptions: [{ optionValue: SURVIVING_COLOR, additionalPrice: 0 }],
      mandatoryOptionNames: categoryMeta.mandatoryOptionNames,
      stockByOptionValue: { [SURVIVING_COLOR]: STOCK_QUANTITY },
      sizeAttributeValue: SIZE_ATTRIBUTE_VALUE,
      exposed: 'NONE',
    });
    console.log(`  item=${SURVIVING_COLOR}(${SURVIVING_ITEM_ID}) stock=${STOCK_QUANTITY} attributes=${JSON.stringify(optionMapping.items[0].attributes)}`);

    const uploaded = JSON.parse(await readFile(`${root}/artifacts/coupang-uploaded-images-draft-${draftId}.json`, 'utf8'));
    const representation = uploaded.images.find((image) => image.role === 'REPRESENTATION');
    const details = uploaded.images.filter((image) => image.role === 'DETAIL').sort((a, b) => a.order - b.order);
    if (!representation || details.length !== 10) throw new Error('expected 1 representation + 10 detail images from the upload artifact');
    const detailUrlsForImages = details.slice(0, 9).map((image) => image.publicUrl);
    const allDetailUrlsForContents = details.map((image) => image.publicUrl);

    console.log('\n=== 4. 이미지 URL 확인 (대표1 + 기타9 + contents10) ===');
    const allUrls = [representation.publicUrl, ...allDetailUrlsForContents];
    for (const url of allUrls) {
      const response = await fetch(url);
      console.log(`  ${url} -> HTTP ${response.status}`);
      if (response.status !== 200) throw new Error(`image not reachable: ${url}`);
    }

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
      mainImageUrl: representation.publicUrl,
      approvedDetailImageUrls: allDetailUrlsForContents,
      detailImageUrlsForImages: detailUrlsForImages,
      material: VERIFIED_MATERIAL,
      verifiedSize: VERIFIED_SIZE_NOTICE,
      handlingCaution: HANDLING_CAUTION,
      warrantyStandard: WARRANTY_STANDARD,
      asPhoneNumber,
      saleStartedAt: before.data.saleStartedAt,
      saleEndedAt: before.data.saleEndedAt,
      deliveryCompanyCode: DELIVERY_COMPANY_CODE,
      deliveryCharge: draft.shippingFee || 0,
      returnCharge: draft.registrationOptimization?.shippingPolicies?.[0]?.returnShippingFee || 0,
      remoteAreaDeliverable: false,
      unionDeliverable: true,
      sellerProductId: SELLER_PRODUCT_ID,
      sellerProductItemIds: [SURVIVING_ITEM_ID],
      brand: BRAND,
      manufacture: BRAND,
      displayProductNameOverride: DISPLAY_PRODUCT_NAME,
      searchTags: SEARCH_TAGS,
      requested: false,
    });

    await mkdir(`${root}/artifacts`, { recursive: true });
    await writeFile(`${root}/artifacts/coupang-modify-payload-draft-${draftId}.json`, JSON.stringify(payload, null, 2));

    console.log('\n=== 5. 상품 수정 API 호출 (PUT, requested=false) ===');
    let result;
    try {
      result = await client.updateProduct(payload);
    } catch (error) {
      if (error instanceof CoupangApiError) {
        console.log(`실패: HTTP ${error.status} (${error.operation})`);
        console.log(`쿠팡 오류 메시지: ${error.bodyPreview}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.log(`  결과: ${JSON.stringify(result)}`);

    await db.query(
      `update coupang_product_registrations set status = 'modified', updated_at = now() where product_draft_id = $1`,
      [draftId],
    );

    console.log('\n=== 6. 수정 후 재조회 ===');
    const after = await client.getProduct(SELLER_PRODUCT_ID);
    await writeFile(`${root}/artifacts/coupang-product-after-modify-draft-${draftId}.json`, JSON.stringify(after, null, 2));
    console.log(JSON.stringify({
      sellerProductId: after.data.sellerProductId,
      statusName: after.data.statusName,
      requested: after.data.requested,
      displayProductName: after.data.displayProductName,
      brand: after.data.brand,
      manufacture: after.data.manufacture,
      remoteAreaDeliverable: after.data.remoteAreaDeliverable,
      outboundShippingPlaceCode: after.data.outboundShippingPlaceCode,
      returnCenterCode: after.data.returnCenterCode,
      itemCount: after.data.items?.length,
      items: after.data.items?.map((i) => ({ sellerProductItemId: i.sellerProductItemId, itemName: i.itemName, stockQuantity: i.stockQuantity, searchTags: i.searchTags })),
    }, null, 2));
    console.log(`\n결과 저장: artifacts/coupang-modify-payload-draft-${draftId}.json, artifacts/coupang-product-after-modify-draft-${draftId}.json`);
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
  console.error('coupang:modify-product failed:', error.message);
  process.exitCode = 1;
});
