import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCoupangProductPayload,
  buildImageOnlyFragments,
  extractSupplierNoticeFields,
  formatKstDateTime,
  mapLiveProductToUpdatePayload,
  mapOptionsToMandatoryAttributes,
  resolveBrandIdentifier,
} from '../src/coupang-payload-builder.mjs';

test('formatKstDateTime renders a UTC instant as Coupang\'s local-time format in Asia/Seoul', () => {
  // 2026-07-13T05:30:00Z is 14:30:00 in KST (UTC+9).
  const result = formatKstDateTime(new Date('2026-07-13T05:30:00.000Z'));
  assert.equal(result, '2026-07-13T14:30:00');
});

// Mirrors the real supplier_products.raw_json shape observed for draft 64.
function draft64RawJson({ size = '0.1', weight = '0.1' } = {}) {
  return {
    domeggook: {
      detail: {
        size,
        model: '주얼리보관함',
        weight,
        country: '수입산_아시아_중국',
        manufacturer: '쓰러담아 협력사',
        infoDuty: {
          type: '패션잡화(모자/벨트/액세서리 등)',
          item: [
            { desc: '상세정보 별도표기', name: '종류', type: 'item' },
            { desc: '상세정보 별도표기', name: '소재', type: 'item' },
            { desc: '상세정보 별도표기', name: '치수', type: 'item' },
            { desc: '상세정보 별도표기', name: '제조자', type: 'item' },
            { desc: '상세정보 별도표기', name: '제조국', type: 'item' },
            { desc: '상세정보 별도표기', name: '취급시 주의사항', type: 'item' },
            { desc: '상세정보 별도표기', name: '품질보증기준', type: 'item' },
            { desc: '상세정보 별도표기', name: 'A/S 책임자와 전화번호', type: 'item' },
          ],
        },
      },
      return: { addr: { mobile: '010-3138-8333' } },
      seller: { company: { name: '와이제이컴퍼니', phone: '010-3138-8333' } },
    },
  };
}

test('extractSupplierNoticeFields reads manufacturer/country/model directly from Domeme detail', () => {
  const result = extractSupplierNoticeFields(draft64RawJson());
  assert.equal(result.manufacturer, '쓰러담아 협력사');
  assert.equal(result.countryOfOrigin, '수입산 / 아시아 / 중국');
  assert.equal(result.modelName, '주얼리보관함');
});

test('extractSupplierNoticeFields rejects size when it exactly matches weight (Domeme unfilled placeholder pattern)', () => {
  const result = extractSupplierNoticeFields(draft64RawJson({ size: '0.1', weight: '0.1' }));
  assert.equal(result.size, null);
});

test('extractSupplierNoticeFields accepts size when it differs from weight', () => {
  const result = extractSupplierNoticeFields(draft64RawJson({ size: '15cm x 10cm x 8cm', weight: '0.4' }));
  assert.equal(result.size, '15cm x 10cm x 8cm');
});

test('extractSupplierNoticeFields flags handling caution, warranty, and AS phone as unavailable from the raw JSON when Domeme marks them "상세정보 별도표기"', () => {
  const result = extractSupplierNoticeFields(draft64RawJson());
  assert.deepEqual(result.unavailableFromSource, {
    handlingCaution: true,
    warrantyStandard: true,
    asPhoneNumber: true,
  });
});

test('extractSupplierNoticeFields surfaces the supplier\'s own contact but labels it as not ours', () => {
  const result = extractSupplierNoticeFields(draft64RawJson());
  assert.equal(result.supplierOwnContact.phone, '010-3138-8333');
  assert.equal(result.supplierOwnContact.companyName, '와이제이컴퍼니');
  assert.match(result.supplierOwnContact.note, /not Automoney/);
});

test('mapOptionsToMandatoryAttributes maps existing color values but leaves an unmatched mandatory attribute unresolved', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [
      { optionValue: '베이지', additionalPrice: 0 },
      { optionValue: '그레이', additionalPrice: 0 },
    ],
    mandatoryOptionNames: ['색상', '주얼리 사이즈'],
    stockByOptionValue: {},
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0].attributes, [
    { attributeTypeName: '색상', attributeValueName: '베이지' },
    { attributeTypeName: '주얼리 사이즈', attributeValueName: null },
  ]);
  assert.deepEqual(result.unresolvedMandatoryAttributes, ['주얼리 사이즈']);
  assert.deepEqual(result.missingStock, ['베이지', '그레이']);
});

test('mapOptionsToMandatoryAttributes applies a supplied size value to every item instead of leaving it unresolved', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [
      { optionValue: '베이지', additionalPrice: 0 },
      { optionValue: '그레이', additionalPrice: 0 },
    ],
    mandatoryOptionNames: ['색상', '주얼리 사이즈'],
    stockByOptionValue: {},
    sizeAttributeValue: '23.5 x 13.5 x 10.5cm',
  });

  assert.deepEqual(result.items[0].attributes, [
    { attributeTypeName: '색상', attributeValueName: '베이지' },
    { attributeTypeName: '주얼리 사이즈', attributeValueName: '23.5 x 13.5 x 10.5cm' },
  ]);
  assert.deepEqual(result.unresolvedMandatoryAttributes, []);
});

test('mapOptionsToMandatoryAttributes fills stock quantities when provided and reports none missing', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [
      { optionValue: '베이지', additionalPrice: 0 },
      { optionValue: '그레이', additionalPrice: 0 },
    ],
    mandatoryOptionNames: ['색상', '주얼리 사이즈'],
    stockByOptionValue: { 베이지: 12, 그레이: 7 },
  });

  assert.equal(result.items[0].stockQuantity, 12);
  assert.equal(result.items[1].stockQuantity, 7);
  assert.deepEqual(result.missingStock, []);
});

test('mapOptionsToMandatoryAttributes fills a third mandatory attribute (beyond 색상/size) from additionalAttributeValues', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [{ optionValue: '아이보리', additionalPrice: 0 }],
    mandatoryOptionNames: ['색상', '사이즈', '수량'],
    stockByOptionValue: { 아이보리: 10 },
    sizeAttributeValue: '200 x 430 x 60mm',
    additionalAttributeValues: { 수량: '2' },
    exposed: 'NONE',
  });

  assert.deepEqual(result.items[0].attributes, [
    { attributeTypeName: '색상', attributeValueName: '아이보리', exposed: 'NONE' },
    { attributeTypeName: '사이즈', attributeValueName: '200 x 430 x 60mm', exposed: 'NONE' },
    { attributeTypeName: '수량', attributeValueName: '2', exposed: 'NONE' },
  ]);
  assert.deepEqual(result.unresolvedMandatoryAttributes, []);
});

test('mapOptionsToMandatoryAttributes reports a third mandatory attribute unresolved when no override is supplied', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [{ optionValue: '아이보리', additionalPrice: 0 }],
    mandatoryOptionNames: ['색상', '사이즈', '수량'],
    stockByOptionValue: { 아이보리: 10 },
    sizeAttributeValue: '200 x 430 x 60mm',
  });

  assert.deepEqual(result.unresolvedMandatoryAttributes, ['수량']);
});

test('mapOptionsToMandatoryAttributes synthesizes exactly one item for a genuine no-option (single-SKU) draft', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [],
    mandatoryOptionNames: ['색상', '사이즈', '단 수'],
    sizeAttributeValue: '47 x 16 x 15.5cm',
    additionalAttributeValues: { 색상: '투명', '단 수': '1' },
    singleItemStockQuantity: 200,
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].optionValue, null);
  assert.equal(result.items[0].stockQuantity, 200);
  assert.deepEqual(result.items[0].attributes, [
    { attributeTypeName: '색상', attributeValueName: '투명' },
    { attributeTypeName: '사이즈', attributeValueName: '47 x 16 x 15.5cm' },
    { attributeTypeName: '단 수', attributeValueName: '1' },
  ]);
  assert.deepEqual(result.unresolvedMandatoryAttributes, []);
  assert.deepEqual(result.missingStock, []);
});

test('mapOptionsToMandatoryAttributes reports unresolved 색상 and missing stock for a no-option draft with no overrides supplied', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [],
    mandatoryOptionNames: ['색상', '사이즈', '단 수'],
  });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.unresolvedMandatoryAttributes, ['색상', '사이즈', '단 수']);
  assert.deepEqual(result.missingStock, ['(단일상품)']);
});

test('mapOptionsToMandatoryAttributes appends the usable unit to a NUMBER attribute value', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [],
    mandatoryOptionNames: ['색상', '사이즈', '단 수'],
    sizeAttributeValue: '47 x 16 x 15.5cm',
    additionalAttributeValues: { 색상: '투명', '단 수': '1' },
    singleItemStockQuantity: 10,
    attributeMeta: [
      { attributeTypeName: '색상', dataType: 'STRING', basicUnit: '없음', usableUnits: [] },
      { attributeTypeName: '사이즈', dataType: 'STRING', basicUnit: '없음', usableUnits: [] },
      { attributeTypeName: '단 수', dataType: 'NUMBER', basicUnit: '개', usableUnits: ['단'] },
    ],
  });

  assert.deepEqual(result.items[0].attributes, [
    { attributeTypeName: '색상', attributeValueName: '투명' },
    { attributeTypeName: '사이즈', attributeValueName: '47 x 16 x 15.5cm' },
    { attributeTypeName: '단 수', attributeValueName: '1단' },
  ]);
});

function categoryMetaFixture() {
  return {
    displayCategoryCode: 71691,
    noticeCategoryTemplates: [
      {
        noticeCategoryName: '패션잡화(모자/벨트/액세서리 등)',
        noticeCategoryDetailNames: [
          { noticeCategoryDetailName: '종류', required: 'MANDATORY' },
          { noticeCategoryDetailName: '소재', required: 'MANDATORY' },
          { noticeCategoryDetailName: '치수', required: 'MANDATORY' },
          { noticeCategoryDetailName: '제조자(수입자)', required: 'MANDATORY' },
          { noticeCategoryDetailName: '제조국', required: 'MANDATORY' },
          { noticeCategoryDetailName: '취급시 주의사항', required: 'MANDATORY' },
          { noticeCategoryDetailName: '품질보증기준', required: 'MANDATORY' },
          { noticeCategoryDetailName: 'A/S 책임자와 전화번호', required: 'MANDATORY' },
        ],
      },
    ],
  };
}

function draft64Fixture() {
  return {
    optimizedTitle: '악세사리 주얼리함 보석함 수납함 주얼리 3단',
    displayProductName: '악세사리 주얼리함 보석함 수납함 주얼리 3단',
    salePrice: 20930,
    mainImages: ['/generated-ai-images/drafts/64/main/manual/manual-r2-v1-coupang-1000x1000.jpg'],
  };
}

const TEN_APPROVED_DETAIL_IMAGES = Array.from(
  { length: 10 },
  (_, i) => `/generated-ai-images/drafts/64/detail/manual/r1-v1/detail-r1-v1-${String(i + 1).padStart(2, '0')}-registered.jpg`,
);

test('buildCoupangProductPayload keeps items[].images to just the representation photo and moves the ten approved detail images into contents', () => {
  const draft = draft64Fixture();
  const supplierNoticeFields = extractSupplierNoticeFields(draft64RawJson());
  const optionMapping = mapOptionsToMandatoryAttributes({
    draftOptions: [{ optionValue: '베이지', additionalPrice: 0 }, { optionValue: '그레이', additionalPrice: 0 }],
    mandatoryOptionNames: ['색상', '주얼리 사이즈'],
    stockByOptionValue: { 베이지: 10, 그레이: 10 },
    sizeAttributeValue: '23.5 x 13.5 x 10.5cm',
  });

  const payload = buildCoupangProductPayload({
    draft,
    vendorId: 'A01550261',
    vendorUserId: 'wowpick1',
    displayCategoryCode: 71691,
    categoryMeta: categoryMetaFixture(),
    noticeCategoryTemplateName: '패션잡화(모자/벨트/액세서리 등)',
    supplierNoticeFields,
    optionMapping,
    outboundShippingPlace: { outboundShippingPlaceCode: 23777733, shippingPlaceName: '출고지1' },
    returnShippingCenter: {
      returnCenterCode: '1002401151',
      shippingPlaceName: '반품지1',
      placeAddresses: [{ returnZipCode: '07526', returnAddress: '서울특별시 강서구 양천로 489', returnAddressDetail: '102동 102호' }],
    },
    approvedDetailImageUrls: TEN_APPROVED_DETAIL_IMAGES,
    material: '아크릴, 벨벳',
    verifiedSize: '23.5 x 13.5 x 10.5cm',
    handlingCaution: '사용자 부주의로 인한 파손/부상은 판매자 책임이 아님',
    warrantyStandard: '관련 법 및 소비자분쟁해결기준에 따름',
    asPhoneNumber: '010-9092-8623',
    saleStartedAt: '2026-07-13T10:00:00',
    saleEndedAt: '2099-12-31T23:59:59',
    deliveryCompanyCode: 'CJGLS',
    deliveryCharge: 3000,
    returnCharge: 6000,
  });

  assert.equal(payload.requested, false);
  assert.equal(payload.saleStartedAt, '2026-07-13T10:00:00');
  assert.equal(payload.saleEndedAt, '2099-12-31T23:59:59');
  assert.equal(payload.imagesPubliclyHosted, false);
  assert.equal(payload.vendorUserId, 'wowpick1');
  assert.equal(payload.deliveryMethod, 'SEQUENCIAL');
  assert.equal(payload.deliveryCompanyCode, 'CJGLS');
  assert.equal(payload.deliveryChargeType, 'NOT_FREE');
  assert.equal(payload.deliveryCharge, 3000);
  assert.equal(payload.returnCharge, 6000);
  assert.equal(payload.returnZipCode, '07526');
  assert.equal(payload.returnAddress, '서울특별시 강서구 양천로 489');

  assert.equal(payload.items[0].images.length, 1);
  assert.equal(payload.items[0].images[0].imageType, 'REPRESENTATION');
  assert.equal(payload.items[0].images[0].vendorPath, draft.mainImages[0]);
  assert.equal(payload.items[0].images.filter((image) => image.imageType === 'DETAIL').length, 0);

  assert.equal(payload.items[0].taxType, 'TAX');
  assert.equal(payload.items[0].parallelImported, 'NOT_PARALLEL_IMPORTED');
  assert.equal(payload.items[0].overseasPurchased, 'NOT_OVERSEAS_PURCHASED');
  assert.equal(payload.items[0].adultOnly, 'EVERYONE');
  assert.equal(payload.items[0].outboundShippingTimeDay, 1);
  assert.equal(payload.items[0].unitCount, 1);
  assert.equal(payload.items[0].maximumBuyCount, 10);
  assert.equal(payload.items[0].maximumBuyForPerson, 0);
  assert.equal(payload.items[0].maximumBuyForPersonPeriod, 1);

  assert.ok(Array.isArray(payload.items[0].contents));
  assert.equal(payload.items[0].contents.length, 1);
  assert.equal(payload.items[0].contents[0].contentDetails.length, 10);
  assert.deepEqual(payload.items[0].contents[0].contentDetails.map((detail) => detail.order), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(payload.items[0].contents[0].contentDetails[0].content, `<img src="${TEN_APPROVED_DETAIL_IMAGES[0]}" />`);
  assert.deepEqual(payload.items[1].contents, payload.items[0].contents);

  const notices = payload.items[0].notices;
  const materialNotice = notices.find((notice) => notice.noticeCategoryDetailName === '소재');
  assert.equal(materialNotice.content, '아크릴, 벨벳');
  const sizeNotice = notices.find((notice) => notice.noticeCategoryDetailName === '치수');
  assert.equal(sizeNotice.content, '23.5 x 13.5 x 10.5cm');
  const warrantyNotice = notices.find((notice) => notice.noticeCategoryDetailName === '품질보증기준');
  assert.equal(warrantyNotice.content, '관련 법 및 소비자분쟁해결기준에 따름');
  const asPhoneNotice = notices.find((notice) => notice.noticeCategoryDetailName === 'A/S 책임자와 전화번호');
  assert.equal(asPhoneNotice.content, '010-9092-8623');
});

test('mapOptionsToMandatoryAttributes tags every attribute exposed:NONE when asked to demote them to search filters', () => {
  const result = mapOptionsToMandatoryAttributes({
    draftOptions: [{ optionValue: '베이지/그레이', additionalPrice: 0 }],
    mandatoryOptionNames: ['색상', '주얼리 사이즈'],
    stockByOptionValue: { '베이지/그레이': 10 },
    sizeAttributeValue: '23.5 x 13.5 x 10.5cm',
    exposed: 'NONE',
  });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].attributes, [
    { attributeTypeName: '색상', attributeValueName: '베이지/그레이', exposed: 'NONE' },
    { attributeTypeName: '주얼리 사이즈', attributeValueName: '23.5 x 13.5 x 10.5cm', exposed: 'NONE' },
  ]);
});

test('buildCoupangProductPayload builds a single-item modify request with sellerProductId, DETAIL images, searchTags, and brand fields', () => {
  const draft = draft64Fixture();
  const supplierNoticeFields = { ...extractSupplierNoticeFields(draft64RawJson()), manufacturer: '와우픽' };
  const optionMapping = mapOptionsToMandatoryAttributes({
    draftOptions: [{ optionValue: '베이지/그레이', additionalPrice: 0 }],
    mandatoryOptionNames: ['색상', '주얼리 사이즈'],
    stockByOptionValue: { '베이지/그레이': 10 },
    sizeAttributeValue: '23.5 x 13.5 x 10.5cm',
    exposed: 'NONE',
  });
  const nineDetailUrls = TEN_APPROVED_DETAIL_IMAGES.slice(0, 9);
  const searchTags = ['주얼리함', '보석함', '주얼리함'];

  const payload = buildCoupangProductPayload({
    draft,
    vendorId: 'A01550261',
    vendorUserId: 'wowpick1',
    displayCategoryCode: 71691,
    categoryMeta: categoryMetaFixture(),
    noticeCategoryTemplateName: '패션잡화(모자/벨트/액세서리 등)',
    supplierNoticeFields,
    optionMapping,
    outboundShippingPlace: { outboundShippingPlaceCode: 24466172, shippingPlaceName: '행당' },
    returnShippingCenter: { returnCenterCode: '1002401151', shippingPlaceName: '반품지1', placeAddresses: [{}] },
    mainImageUrl: 'https://pub-example.r2.dev/drafts/64/coupang/main.jpg',
    approvedDetailImageUrls: TEN_APPROVED_DETAIL_IMAGES.map((_, i) => `https://pub-example.r2.dev/drafts/64/coupang/detail-${i}.jpg`),
    detailImageUrlsForImages: nineDetailUrls.map((_, i) => `https://pub-example.r2.dev/drafts/64/coupang/detail-${i}.jpg`),
    sellerProductId: 16301574570,
    sellerProductItemIds: [38201516159],
    brand: '와우픽',
    manufacture: '와우픽',
    displayProductNameOverride: '와우픽 3단 주얼리함 보석함 액세서리 수납함',
    searchTags,
    remoteAreaDeliverable: false,
    deliveryCompanyCode: 'CJGLS',
    requested: false,
  });

  assert.equal(payload.sellerProductId, 16301574570);
  assert.equal(payload.brand, '와우픽');
  assert.equal(payload.manufacture, '와우픽');
  assert.equal(payload.displayProductName, '와우픽 3단 주얼리함 보석함 액세서리 수납함');
  assert.equal(payload.remoteAreaDeliverable, 'N');
  assert.equal(payload.items.length, 1);

  const item = payload.items[0];
  assert.equal(item.sellerProductItemId, 38201516159);
  assert.equal(item.stockQuantity, 10);
  assert.deepEqual(item.searchTags, searchTags);
  assert.deepEqual(item.attributes.map((a) => a.exposed), ['NONE', 'NONE']);

  assert.equal(item.images.length, 10);
  assert.equal(item.images[0].imageType, 'REPRESENTATION');
  assert.equal(item.images.filter((image) => image.imageType === 'DETAIL').length, 9);
  assert.deepEqual(item.images.filter((image) => image.imageType === 'DETAIL').map((image) => image.imageOrder), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  assert.equal(item.contents[0].contentDetails.length, 10);

  const manufacturerNotice = item.notices.find((notice) => notice.noticeCategoryDetailName === '제조자(수입자)');
  assert.equal(manufacturerNotice.content, '와우픽');
});

test('buildCoupangProductPayload adds brandId to the envelope and appends identifierAttributes to every item, on top of the mandatory ones', () => {
  const draft = draft64Fixture();
  const optionMapping = mapOptionsToMandatoryAttributes({
    draftOptions: [{ optionValue: '베이지/그레이', additionalPrice: 0 }],
    mandatoryOptionNames: ['색상'],
    stockByOptionValue: { '베이지/그레이': 10 },
  });

  const payload = buildCoupangProductPayload({
    draft,
    vendorId: 'A01550261',
    displayCategoryCode: 71691,
    categoryMeta: categoryMetaFixture(),
    noticeCategoryTemplateName: '패션잡화(모자/벨트/액세서리 등)',
    supplierNoticeFields: extractSupplierNoticeFields(draft64RawJson()),
    optionMapping,
    outboundShippingPlace: { outboundShippingPlaceCode: 24466172, shippingPlaceName: '행당' },
    returnShippingCenter: { returnCenterCode: '1002401151', shippingPlaceName: '반품지1', placeAddresses: [{}] },
    mainImageUrl: 'https://pub-example.r2.dev/drafts/64/coupang/main.jpg',
    approvedDetailImageUrls: TEN_APPROVED_DETAIL_IMAGES.map((_, i) => `https://pub-example.r2.dev/drafts/64/coupang/detail-${i}.jpg`),
    brand: '산리오',
    brandId: 'KR-999',
    identifierAttributes: [{ attributeTypeName: 'Global Trade Item Number', attributeValueName: '8801234567890', exposed: 'NONE' }],
  });

  assert.equal(payload.brandId, 'KR-999');
  assert.deepEqual(payload.items[0].attributes, [
    { attributeTypeName: '색상', attributeValueName: '베이지/그레이' },
    { attributeTypeName: 'Global Trade Item Number', attributeValueName: '8801234567890', exposed: 'NONE' },
  ]);
});

test('buildCoupangProductPayload omits brandId entirely when none is supplied (no registered brand match)', () => {
  const draft = draft64Fixture();
  const optionMapping = { items: [{ optionValue: null, additionalPrice: 0, stockQuantity: 5, attributes: [] }], unresolvedMandatoryAttributes: [], missingStock: [] };

  const payload = buildCoupangProductPayload({
    draft,
    vendorId: 'A01550261',
    categoryMeta: {},
    supplierNoticeFields: extractSupplierNoticeFields(draft64RawJson()),
    optionMapping,
    mainImageUrl: 'https://pub-example.r2.dev/main.jpg',
    approvedDetailImageUrls: [],
    brand: '와우픽',
  });

  assert.equal('brandId' in payload, false);
  assert.deepEqual(payload.items[0].attributes, []);
});

test('resolveBrandIdentifier returns BRAND_NOT_FOUND when the brand has no Coupang brand-master entry', () => {
  const result = resolveBrandIdentifier({ brandSearchResult: { data: [] }, brandName: '와우픽' });
  assert.equal(result.status, 'BRAND_NOT_FOUND');
  assert.equal(result.brandId, null);
  assert.deepEqual(result.identifierAttributes, []);
});

test('resolveBrandIdentifier returns NO_UID_REQUIRED when the matched brand does not require GTIN/MPN', () => {
  const result = resolveBrandIdentifier({
    brandSearchResult: { data: [{ brandId: 'KR-5', brandName: '와우픽', isUIDRequired: false, allowedUIDTypes: [] }] },
    brandName: '와우픽',
  });
  assert.equal(result.status, 'NO_UID_REQUIRED');
  assert.equal(result.brandId, 'KR-5');
  assert.deepEqual(result.identifierAttributes, []);
});

test('resolveBrandIdentifier returns MISSING_GTIN_MPN when required but neither value was supplied -- never fabricates one', () => {
  const result = resolveBrandIdentifier({
    brandSearchResult: { data: [{ brandId: 'KR-999', brandName: '산리오', isUIDRequired: true, allowedUIDTypes: ['GTIN', 'MPN'] }] },
    brandName: '산리오',
  });
  assert.equal(result.status, 'MISSING_GTIN_MPN');
  assert.equal(result.brandId, 'KR-999');
  assert.deepEqual(result.identifierAttributes, []);
});

test('resolveBrandIdentifier returns PASS with a Global Trade Item Number attribute when GTIN is supplied and allowed', () => {
  const result = resolveBrandIdentifier({
    brandSearchResult: { data: [{ brandId: 'KR-999', brandName: '산리오', isUIDRequired: true, allowedUIDTypes: ['GTIN', 'MPN'] }] },
    brandName: '산리오',
    gtin: '8801234567890',
  });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.identifierAttributes, [
    { attributeTypeName: 'Global Trade Item Number', attributeValueName: '8801234567890', exposed: 'NONE' },
  ]);
});

test('resolveBrandIdentifier prefers GTIN over MPN when both are supplied and both are allowed', () => {
  const result = resolveBrandIdentifier({
    brandSearchResult: { data: [{ brandId: 'KR-999', brandName: '산리오', isUIDRequired: true, allowedUIDTypes: ['GTIN', 'MPN'] }] },
    brandName: '산리오',
    gtin: '8801234567890',
    mpn: 'MT0Q3FE/A',
  });
  assert.equal(result.identifierAttributes[0].attributeTypeName, 'Global Trade Item Number');
});

test('resolveBrandIdentifier falls back to MPN when the brand only allows MPN, not GTIN', () => {
  const result = resolveBrandIdentifier({
    brandSearchResult: { data: [{ brandId: 'KR-999', brandName: '산리오', isUIDRequired: true, allowedUIDTypes: ['MPN'] }] },
    brandName: '산리오',
    gtin: '8801234567890',
    mpn: 'MT0Q3FE/A',
  });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.identifierAttributes, [
    { attributeTypeName: 'Manufacturer Part Number', attributeValueName: 'MT0Q3FE/A', exposed: 'NONE' },
  ]);
});

test('buildCoupangProductPayload fills notice fields a different template names (e.g. "기타 재화") via noticeContentOverrides', () => {
  const draft = draft64Fixture();
  const otherGoodsTemplate = {
    displayCategoryCode: 80704,
    noticeCategoryTemplates: [{
      noticeCategoryName: '기타 재화',
      noticeCategoryDetailNames: [
        { noticeCategoryDetailName: '품명 및 모델명', required: 'MANDATORY' },
        { noticeCategoryDetailName: '인증/허가 사항', required: 'MANDATORY' },
        { noticeCategoryDetailName: '제조국(원산지)', required: 'MANDATORY' },
        { noticeCategoryDetailName: '제조자(수입자)', required: 'MANDATORY' },
        { noticeCategoryDetailName: '소비자상담 관련 전화번호', required: 'MANDATORY' },
      ],
    }],
  };
  const optionMapping = mapOptionsToMandatoryAttributes({
    draftOptions: [{ optionValue: '아이보리', additionalPrice: 0 }],
    mandatoryOptionNames: ['색상', '사이즈', '수량'],
    stockByOptionValue: { 아이보리: 10 },
    sizeAttributeValue: '200 x 430 x 60mm',
    additionalAttributeValues: { 수량: '2' },
    exposed: 'NONE',
  });

  const payload = buildCoupangProductPayload({
    draft,
    vendorId: 'A01550261',
    displayCategoryCode: 80704,
    categoryMeta: otherGoodsTemplate,
    noticeCategoryTemplateName: '기타 재화',
    supplierNoticeFields: { modelName: '레일선반', countryOfOrigin: '수입산 / 아시아 / 중국', manufacturer: '와우픽' },
    noticeContentOverrides: { '인증/허가 사항': '해당없음' },
    asPhoneNumber: '010-9092-8623',
    optionMapping,
    outboundShippingPlace: {},
    returnShippingCenter: {},
    approvedDetailImageUrls: TEN_APPROVED_DETAIL_IMAGES,
    deliveryCompanyCode: 'CJGLS',
  });

  const notices = payload.items[0].notices;
  assert.equal(notices.find((n) => n.noticeCategoryDetailName === '품명 및 모델명').content, '레일선반');
  assert.equal(notices.find((n) => n.noticeCategoryDetailName === '인증/허가 사항').content, '해당없음');
  assert.equal(notices.find((n) => n.noticeCategoryDetailName === '제조국(원산지)').content, '수입산 / 아시아 / 중국');
  assert.equal(notices.find((n) => n.noticeCategoryDetailName === '제조자(수입자)').content, '와우픽');
  assert.equal(notices.find((n) => n.noticeCategoryDetailName === '소비자상담 관련 전화번호').content, '010-9092-8623');
});

test('buildCoupangProductPayload marks imagesPubliclyHosted true only once every image is a real https URL', () => {
  const draft = draft64Fixture();
  const optionMapping = mapOptionsToMandatoryAttributes({
    draftOptions: [{ optionValue: '베이지', additionalPrice: 0 }],
    mandatoryOptionNames: ['색상', '주얼리 사이즈'],
    stockByOptionValue: { 베이지: 10 },
    sizeAttributeValue: '23.5cm',
  });
  const base = {
    draft, vendorId: 'A01550261', displayCategoryCode: 71691, categoryMeta: categoryMetaFixture(),
    noticeCategoryTemplateName: '패션잡화(모자/벨트/액세서리 등)',
    supplierNoticeFields: extractSupplierNoticeFields(draft64RawJson()), optionMapping,
    outboundShippingPlace: {}, returnShippingCenter: {},
  };

  const stillLocal = buildCoupangProductPayload({ ...base, approvedDetailImageUrls: TEN_APPROVED_DETAIL_IMAGES });
  assert.equal(stillLocal.imagesPubliclyHosted, false);
  assert.equal(stillLocal.items[0].images[0].vendorPath, draft.mainImages[0]);

  const r2Urls = TEN_APPROVED_DETAIL_IMAGES.map((_, i) => `https://pub-example.r2.dev/drafts/64/coupang/detail-${i}.jpg`);
  const hosted = buildCoupangProductPayload({
    ...base,
    mainImageUrl: 'https://pub-example.r2.dev/drafts/64/coupang/main.jpg',
    approvedDetailImageUrls: r2Urls,
  });
  assert.equal(hosted.imagesPubliclyHosted, true);
  assert.equal(hosted.items[0].images[0].vendorPath, 'https://pub-example.r2.dev/drafts/64/coupang/main.jpg');
  assert.equal(hosted.items[0].contents[0].contentDetails[0].content, `<img src="${r2Urls[0]}" />`);
});

test('buildImageOnlyFragments builds a REPRESENTATION+DETAIL images array and a TEXT/img contents array from plain URLs', () => {
  const mainImageUrl = 'https://pub-example.r2.dev/drafts/46/coupang/main.jpg';
  const detailImageUrls = Array.from({ length: 10 }, (_, i) => `https://pub-example.r2.dev/drafts/46/coupang/detail-${i}.jpg`);
  const { images, contents } = buildImageOnlyFragments({
    mainImageUrl,
    detailImageUrls,
    detailImageUrlsForImages: detailImageUrls.slice(0, 9),
  });

  assert.equal(images.length, 10);
  assert.deepEqual(images[0], { imageOrder: 1, imageType: 'REPRESENTATION', vendorPath: mainImageUrl });
  assert.equal(images.filter((image) => image.imageType === 'DETAIL').length, 9);
  assert.deepEqual(images[1], { imageOrder: 1, imageType: 'DETAIL', vendorPath: detailImageUrls[0] });

  assert.equal(contents.length, 1);
  assert.equal(contents[0].contentsType, 'TEXT');
  assert.equal(contents[0].contentDetails.length, 10);
  assert.deepEqual(contents[0].contentDetails[0], { content: `<img src="${detailImageUrls[0]}" />`, detailType: 'TEXT', order: 1 });
});

test('buildImageOnlyFragments omits DETAIL images entirely when detailImageUrlsForImages is not passed (no silent auto-fill)', () => {
  const { images } = buildImageOnlyFragments({
    mainImageUrl: 'https://pub-example.r2.dev/main.jpg',
    detailImageUrls: ['https://pub-example.r2.dev/d1.jpg', 'https://pub-example.r2.dev/d2.jpg'],
  });
  assert.equal(images.length, 1);
  assert.equal(images[0].imageType, 'REPRESENTATION');
});

// Fixture mirrors a real getProduct() response, trimmed to the fields
// mapLiveProductToUpdatePayload reads -- shape confirmed live against
// sellerProductId 16301574570 and 16301910938 on 2026-07-14.
function liveGetProductFixture(overrides = {}) {
  return {
    sellerProductId: 16301574570,
    displayCategoryCode: 71691,
    sellerProductName: '악세사리 주얼리함 보석함 수납함 주얼리 3단',
    vendorId: 'A01550261',
    vendorUserId: 'wowpick1',
    saleStartedAt: '2026-07-13T10:25:00',
    saleEndedAt: '2099-12-31T09:00:00',
    displayProductName: '와우픽 3단 주얼리함 보석함 액세서리 수납함',
    brand: '와우픽',
    manufacture: '와우픽',
    deliveryMethod: 'SEQUENCIAL',
    deliveryCompanyCode: 'CJGLS',
    deliveryChargeType: 'NOT_FREE',
    deliveryCharge: 3000,
    freeShipOverAmount: 0,
    // Confirmed live: this always comes back 0 regardless of the real
    // return-shipping charge -- returnCharge below is the reliable field.
    deliveryChargeOnReturn: 0,
    remoteAreaDeliverable: 'N',
    unionDeliveryType: 'UNION_DELIVERY',
    outboundShippingPlaceCode: 24466172,
    returnCenterCode: '1002401151',
    returnChargeName: '반품지1',
    returnCharge: 6000,
    companyContactNumber: '010-8795-2571',
    returnZipCode: '04713',
    returnAddress: '서울특별시 성동구 행당로 79',
    returnAddressDetail: '119동 906호',
    requested: false,
    statusName: '승인완료',
    productId: 9647805877,
    trackingId: 'sample-tracking-id',
    items: [
      {
        sellerProductItemId: 38201516160,
        vendorItemId: 95768275023,
        itemId: 28833869954,
        itemName: '그레이',
        originalPrice: 20930,
        salePrice: 20930,
        // No stockQuantity field on GET -- only maximumBuyCount.
        maximumBuyCount: 10,
        maximumBuyForPerson: 0,
        maximumBuyForPersonPeriod: 1,
        outboundShippingTimeDay: 1,
        unitCount: 1,
        taxType: 'TAX',
        parallelImported: 'NOT_PARALLEL_IMPORTED',
        overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
        adultOnly: 'EVERYONE',
        attributes: [
          { attributeTypeName: '제조년도', attributeValueName: '', exposed: 'NONE', editable: true },
          { attributeTypeName: '색상', attributeValueName: '그레이', exposed: 'NONE', editable: true },
          { attributeTypeName: '주얼리 사이즈', attributeValueName: '23.5 x 13.5 x 10.5cm', exposed: 'NONE', editable: true },
        ],
        notices: [{ noticeCategoryName: '패션잡화(모자/벨트/액세서리 등)', noticeCategoryDetailName: '종류', content: '악세사리 주얼리함 보석함 수납함 주얼리 3단' }],
        searchTags: ['주얼리함', '보석함'],
        images: [{ imageOrder: 1, imageType: 'REPRESENTATION', cdnPath: 'vendor_inventory/old.jpg', vendorPath: 'old.jpg' }],
        contents: [{ contentsType: 'TEXT', contentDetails: [{ content: '<img src="old" />', detailType: 'TEXT', order: 1 }] }],
      },
    ],
    ...overrides,
  };
}

test('mapLiveProductToUpdatePayload derives deliveryChargeOnReturn from returnCharge, not the live field of the same name', () => {
  const live = liveGetProductFixture();
  const mapped = mapLiveProductToUpdatePayload(live, { images: [], contents: [] });
  assert.equal(mapped.deliveryChargeOnReturn, 6000);
});

test('mapLiveProductToUpdatePayload translates maximumBuyCount into stockQuantity', () => {
  const live = liveGetProductFixture();
  const mapped = mapLiveProductToUpdatePayload(live, { images: [], contents: [] });
  assert.equal(mapped.items[0].stockQuantity, 10);
  assert.equal(mapped.items[0].maximumBuyCount, 10);
});

test('mapLiveProductToUpdatePayload drops blank attribute values and strips the editable flag', () => {
  const live = liveGetProductFixture();
  const mapped = mapLiveProductToUpdatePayload(live, { images: [], contents: [] });
  assert.deepEqual(mapped.items[0].attributes, [
    { attributeTypeName: '색상', attributeValueName: '그레이', exposed: 'NONE' },
    { attributeTypeName: '주얼리 사이즈', attributeValueName: '23.5 x 13.5 x 10.5cm', exposed: 'NONE' },
  ]);
});

test('mapLiveProductToUpdatePayload always submits requested=false regardless of the live value', () => {
  const live = liveGetProductFixture({ requested: true });
  const mapped = mapLiveProductToUpdatePayload(live, { images: [], contents: [] });
  assert.equal(mapped.requested, false);
});

test('mapLiveProductToUpdatePayload replaces items[].images/contents with the caller-supplied fragments, dropping the live ones', () => {
  const live = liveGetProductFixture();
  const newImages = [{ imageOrder: 1, imageType: 'REPRESENTATION', vendorPath: 'https://pub-example.r2.dev/new.jpg' }];
  const newContents = [{ contentsType: 'TEXT', contentDetails: [{ content: '<img src="new" />', detailType: 'TEXT', order: 1 }] }];
  const mapped = mapLiveProductToUpdatePayload(live, { images: newImages, contents: newContents });
  assert.deepEqual(mapped.items[0].images, newImages);
  assert.deepEqual(mapped.items[0].contents, newContents);
});

test('mapLiveProductToUpdatePayload drops response-only fields not part of the update payload schema', () => {
  const live = liveGetProductFixture();
  const mapped = mapLiveProductToUpdatePayload(live, { images: [], contents: [] });
  assert.equal('trackingId' in mapped, false);
  assert.equal('productId' in mapped, false);
  assert.equal('statusName' in mapped, false);
  assert.equal('vendorItemId' in mapped.items[0], false);
  assert.equal('itemId' in mapped.items[0], false);
});
