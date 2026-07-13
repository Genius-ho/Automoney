import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCoupangProductPayload,
  extractSupplierNoticeFields,
  formatKstDateTime,
  mapOptionsToMandatoryAttributes,
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
  assert.equal(payload.items[0].contents[0].contentDetails[0].content, TEN_APPROVED_DETAIL_IMAGES[0]);
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
  assert.equal(hosted.items[0].contents[0].contentDetails[0].content, r2Urls[0]);
});
