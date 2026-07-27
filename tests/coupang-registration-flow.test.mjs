import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTECTED_DRAFT_ID,
  SELLER_FIXED_CONFIG,
  buildRegistrationPreview,
  createDirectRegistration,
  requestCoupangSaleApproval,
  selectRegistrationTarget,
  validateSellerShippingSettings,
} from '../src/coupang-registration-flow.mjs';

function rawModePreviewDeps(overridesToDeps = {}) {
  return {
    mode: 'raw',
    coupangConfig: { vendorId: 'A00000000', vendorUserId: 'seller1' },
    clientImpl: fakeCoupangClient(),
    categoryAdapterImpl: fakeCategoryAdapter(),
    exportProductDraftImpl: async () => fakeDraft(),
    getSellerShippingSettingsImpl: async () => CONFIGURED_SHIPPING_SETTINGS,
    // A fresh draft has no applied analysis yet -- raw registration relies on
    // supplierNoticeFields (from raw_json) + SELLER_FIXED_CONFIG fallbacks.
    getAppliedAnalysisImpl: async () => null,
    getDraftRawImagesImpl: async () => ({
      mainImageLocalUrl: 'https://domeggook.example/product/main.jpg',
      detailImageLocalUrls: ['/generated-images/drafts/501/detail-1-slice-001.jpg', '/generated-images/drafts/501/detail-2-slice-001.jpg'],
    }),
    uploadImpl: async ({ detailImageLocalUrls }) => ({
      mainImageUrl: 'https://pub.example/drafts/501/coupang/main.jpg',
      detailImageUrls: detailImageLocalUrls.map((_, i) => `https://pub.example/drafts/501/coupang/detail-${i + 1}.jpg`),
    }),
    ...overridesToDeps,
  };
}

const CONFIGURED_SHIPPING_SETTINGS = { outboundShippingPlaceCode: '111', outboundShippingPlaceName: '행당 출고지', returnCenterCode: '222', returnCenterName: '반품지1' };

function makeDraftsDb(ids) {
  return {
    async query(sql, params = []) {
      if (sql.includes('from product_drafts where id <> $1 order by id')) {
        return { rows: ids.filter((id) => id !== params[0]).map((id) => ({ id })) };
      }
      if (sql.includes('select supplier_product_id from product_drafts')) return { rows: [{ supplier_product_id: 900 }] };
      if (sql.includes('select raw_json from supplier_products')) {
        return { rows: [{ raw_json: { domeggook: { detail: { manufacturer: '공급처제조사', country: '수입산_아시아_중국', model: null, size: null, weight: null } } } }] };
      }
      throw new Error(`unhandled query: ${sql}`);
    },
  };
}

function fakeDraft(overrides = {}) {
  return {
    id: 46,
    optimizedTitle: '무타공 수납 정리함 슬라이드 레일선반',
    sellerProductName: '무타공 수납 정리함 슬라이드 레일선반',
    displayProductName: '무타공 수납 정리함 슬라이드 레일선반',
    mainImages: ['/generated-ai-images/drafts/46/main.jpg'],
    salePrice: 33570,
    shippingFee: 0,
    registrationOptimization: { shippingPolicies: [{ returnShippingFee: 5000 }] },
    options: [
      { optionName: '색상', optionValue: '아이보리', additionalPrice: 0, stockQuantity: 10 },
    ],
    ...overrides,
  };
}

const CATEGORY_META = {
  displayCategoryCode: 71691,
  attributes: [{ attributeTypeName: '색상', required: 'MANDATORY' }],
  mandatoryOptionNames: ['색상'],
  noticeCategoryTemplates: [{ noticeCategoryName: '기타 재화', noticeCategoryDetailNames: [{ noticeCategoryDetailName: '종류' }] }],
  requiredDocumentNames: [],
  certifications: [],
  mandatoryCertificationNames: [],
  allowedOfferConditions: [],
};

function fakeCategoryAdapter({ prediction = { displayCategoryCode: 71691, categoryName: '기타 재화', predictionResultType: 'AUTO' }, categoryMeta = CATEGORY_META } = {}) {
  return {
    async predictCategory() { return prediction; },
    async getCategoryMeta() { return categoryMeta; },
  };
}

// Default searchBrandResult is an empty match list ("와우픽" isn't a
// registered Coupang brand) -- resolveBrandIdentifier treats that as
// BRAND_NOT_FOUND, which never blocks readiness, so every existing test that
// doesn't care about the brand/GTIN policy keeps its "clean, non-blocked"
// expectations without having to know about this feature.
function fakeCoupangClient({ createProductResult = { code: 'SUCCESS', data: '99999999999' }, outbound = [{ shippingPlaceName: '행당 출고지', outboundShippingPlaceCode: 111, placeAddresses: [{ companyContactNumber: '010-0000-0000' }] }], returnCenters = [{ shippingPlaceName: '행당 반품지', returnCenterCode: '222', placeAddresses: [{}] }], getProductResults = [], requestApprovalResult = { code: 'SUCCESS', data: null }, searchBrandResult = { data: [] } } = {}) {
  const calls = { createProduct: 0, requestApproval: 0, getProduct: 0, searchBrand: 0 };
  return {
    calls,
    async listOutboundShippingPlaces() { return { data: outbound }; },
    async listReturnShippingCenters() { return { data: returnCenters }; },
    async createProduct(payload) { calls.createProduct += 1; this.lastPayload = payload; return createProductResult; },
    async getProduct() { const result = getProductResults[Math.min(calls.getProduct, getProductResults.length - 1)]; calls.getProduct += 1; return result; },
    async requestApproval(sellerProductId) { calls.requestApproval += 1; this.lastApprovalSellerProductId = sellerProductId; return requestApprovalResult; },
    async searchBrand(brandName) { calls.searchBrand += 1; this.lastSearchBrandName = brandName; return searchBrandResult; },
  };
}

function commonPreviewDeps(overridesToDeps = {}) {
  return {
    coupangConfig: { vendorId: 'A00000000', vendorUserId: 'seller1' },
    clientImpl: fakeCoupangClient(),
    categoryAdapterImpl: fakeCategoryAdapter(),
    exportProductDraftImpl: async () => fakeDraft(),
    getSellerShippingSettingsImpl: async () => CONFIGURED_SHIPPING_SETTINGS,
    getAppliedAnalysisImpl: async () => ({
      material: '아크릴, 벨벳', dimensions: '23.5cm x 13.5cm x 10.5cm',
      manufacturer: '분석확정제조사', countryOfOrigin: '수입산_아시아_중국',
      handlingPrecautions: null, searchTags: ['태그1', '태그2'],
    }),
    getApprovedManualMainImageImpl: async () => ({ coupangStoredUrl: '/generated-ai-images/drafts/46/main/manual/main.jpg' }),
    getApprovedManualDetailSetImpl: async () => ({
      images: Array.from({ length: 10 }, (_, i) => ({ normalizedStoredUrl: `/generated-ai-images/drafts/46/detail/manual/r1-v1/detail-${i + 1}.jpg` })),
    }),
    uploadImpl: async ({ detailImageLocalUrls }) => ({
      mainImageUrl: 'https://pub.example/drafts/46/coupang/main.jpg',
      detailImageUrls: detailImageLocalUrls.map((_, i) => `https://pub.example/drafts/46/coupang/detail-${i + 1}.jpg`),
    }),
    ...overridesToDeps,
  };
}

test('validateSellerShippingSettings blocks when no code has ever been confirmed and saved', async () => {
  const result = await validateSellerShippingSettings({}, {
    clientImpl: fakeCoupangClient(),
    getSellerShippingSettingsImpl: async () => ({ outboundShippingPlaceCode: null, returnCenterCode: null }),
  });
  assert.equal(result.configured, false);
  assert.equal(result.blocked, true);
  assert.match(result.reasons[0], /먼저 확인하고 저장/);
});

test('validateSellerShippingSettings matches the stored code exactly, never by display name', async () => {
  const client = fakeCoupangClient({
    outbound: [
      { shippingPlaceName: '행당', outboundShippingPlaceCode: 25045458, usable: true, placeAddresses: [{ returnAddress: '서울특별시 성동구 행당로 79' }] },
      { shippingPlaceName: '행당', outboundShippingPlaceCode: 24466172, usable: true, placeAddresses: [{ returnAddress: '서울특별시 성동구 행당동 347' }] },
    ],
    returnCenters: [
      { shippingPlaceName: '-', returnCenterCode: '1002571652', usable: true, placeAddresses: [{}] },
      { shippingPlaceName: '반품지1 ', returnCenterCode: '1002401151', usable: true, placeAddresses: [{ returnAddress: '서울특별시 성동구 행당로 79' }] },
    ],
  });
  const result = await validateSellerShippingSettings({}, {
    clientImpl: client,
    getSellerShippingSettingsImpl: async () => ({ outboundShippingPlaceCode: '24466172', returnCenterCode: '1002401151' }),
  });
  assert.equal(result.blocked, false);
  assert.equal(result.outboundShippingPlace.outboundShippingPlaceCode, 24466172);
  assert.equal(result.returnShippingCenter.returnCenterCode, '1002401151');
});

test('validateSellerShippingSettings blocks when the saved code has disappeared from the live list', async () => {
  const result = await validateSellerShippingSettings({}, {
    clientImpl: fakeCoupangClient({ outbound: [], returnCenters: [{ returnCenterCode: '222', usable: true, placeAddresses: [{}] }] }),
    getSellerShippingSettingsImpl: async () => CONFIGURED_SHIPPING_SETTINGS,
  });
  assert.equal(result.blocked, true);
  assert.match(result.reasons.join(' '), /더 이상 API 목록에 없습니다/);
});

test('validateSellerShippingSettings blocks when the saved code is present but usable=false', async () => {
  const result = await validateSellerShippingSettings({}, {
    clientImpl: fakeCoupangClient({
      outbound: [{ outboundShippingPlaceCode: 111, usable: false, placeAddresses: [{}] }],
      returnCenters: [{ returnCenterCode: '222', usable: true, placeAddresses: [{}] }],
    }),
    getSellerShippingSettingsImpl: async () => CONFIGURED_SHIPPING_SETTINGS,
  });
  assert.equal(result.blocked, true);
  assert.match(result.reasons.join(' '), /usable=false/);
});

test('selectRegistrationTarget falls through to the next eligible draft when the preferred one already has a registration', async () => {
  const db = makeDraftsDb([46, 47, 50]);
  const registrations = { 46: { status: 'approval_requested', sellerProductId: '16301910938' } };
  const target = await selectRegistrationTarget(db, {
    preferredDraftId: 46,
    getCoupangRegistrationImpl: async (_db, id) => registrations[id] || null,
    getApprovedManualMainImageImpl: async () => ({ ok: true }),
    getApprovedManualDetailSetImpl: async () => ({ ok: true }),
  });
  assert.equal(target.preferredDraftId, 46);
  assert.match(target.preferredDisqualifiedReason, /이미 쿠팡 등록 이력이 있습니다/);
  assert.equal(target.selectedDraftId, 47);
  assert.equal(target.noEligibleCandidate, false);
});

test('selectRegistrationTarget reports no eligible candidate when nothing has approved images', async () => {
  const db = makeDraftsDb([46, 47]);
  const target = await selectRegistrationTarget(db, {
    preferredDraftId: 46,
    getCoupangRegistrationImpl: async () => null,
    getApprovedManualMainImageImpl: async () => null,
    getApprovedManualDetailSetImpl: async () => null,
  });
  assert.equal(target.selectedDraftId, null);
  assert.equal(target.noEligibleCandidate, true);
  assert.match(target.preferredDisqualifiedReason, /승인된 대표이미지/);
});

test('selectRegistrationTarget never selects the protected draft 64, even if explicitly requested as preferred', async () => {
  const db = makeDraftsDb([]);
  const target = await selectRegistrationTarget(db, {
    preferredDraftId: PROTECTED_DRAFT_ID,
    getCoupangRegistrationImpl: async () => null,
    getApprovedManualMainImageImpl: async () => null,
    getApprovedManualDetailSetImpl: async () => null,
  });
  assert.notEqual(target.selectedDraftId, PROTECTED_DRAFT_ID);
  assert.equal(target.selectedDraftId, null);
  assert.match(target.preferredDisqualifiedReason, /보호 대상/);
});

test('buildRegistrationPreview refuses draft 64 immediately, without touching any dependency', async () => {
  const db = makeDraftsDb([]);
  await assert.rejects(
    () => buildRegistrationPreview(db, '/repo', PROTECTED_DRAFT_ID, commonPreviewDeps()),
    (error) => error.code === 'DRAFT_PROTECTED',
  );
});

test('buildRegistrationPreview refuses a draft with no approved images', async () => {
  const db = makeDraftsDb([]);
  await assert.rejects(
    () => buildRegistrationPreview(db, '/repo', 46, commonPreviewDeps({ getApprovedManualMainImageImpl: async () => null })),
    (error) => error.code === 'IMAGES_NOT_APPROVED',
  );
});

test('buildRegistrationPreview in raw mode registers with the draft\'s own supplier images, never requiring approved manual images', async () => {
  const db = makeDraftsDb([]);
  let approvedImageCheckCalled = false;
  const preview = await buildRegistrationPreview(db, '/repo', 501, rawModePreviewDeps({
    getApprovedManualMainImageImpl: async () => { approvedImageCheckCalled = true; return null; },
    getApprovedManualDetailSetImpl: async () => { approvedImageCheckCalled = true; return null; },
  }));
  assert.equal(approvedImageCheckCalled, false);
  assert.equal(preview.mainImageUrl, 'https://pub.example/drafts/501/coupang/main.jpg');
  assert.equal(preview.detailImageUrls.length, 2);
});

test('buildRegistrationPreview in raw mode accepts fewer than 10 detail images (unlike improved mode)', async () => {
  const db = makeDraftsDb([]);
  const preview = await buildRegistrationPreview(db, '/repo', 501, rawModePreviewDeps());
  assert.ok(preview.readiness.ready.some((line) => line.includes('원본 상세이미지 2장')));
  assert.ok(!preview.readiness.missing.some((line) => line.includes('상세이미지')));
});

test('buildRegistrationPreview in raw mode still blocks when no raw images exist at all', async () => {
  const db = makeDraftsDb([]);
  await assert.rejects(
    () => buildRegistrationPreview(db, '/repo', 501, rawModePreviewDeps({
      getDraftRawImagesImpl: async () => ({ mainImageLocalUrl: null, detailImageLocalUrls: [] }),
    })),
    (error) => error.code === 'IMAGES_NOT_APPROVED',
  );
});

test('buildRegistrationPreview in improved mode (default) still requires exactly 10 detail images', async () => {
  const db = makeDraftsDb([]);
  const preview = await buildRegistrationPreview(db, '/repo', 46, commonPreviewDeps({
    getApprovedManualDetailSetImpl: async () => ({ images: Array.from({ length: 3 }, (_, i) => ({ normalizedStoredUrl: `/generated-ai-images/drafts/46/detail/manual/r1-v1/detail-${i + 1}.jpg` })) }),
  }));
  assert.ok(preview.readiness.missing.some((line) => line.includes('상세이미지 10장 필요')));
});

test('buildRegistrationPreview assembles a requested=false payload using applied-analysis values and seller-fixed config, with a clean (non-blocked) readiness report', async () => {
  const db = makeDraftsDb([]);
  const preview = await buildRegistrationPreview(db, '/repo', 46, commonPreviewDeps());

  assert.equal(preview.payload.requested, false);
  assert.equal(preview.payload.brand, SELLER_FIXED_CONFIG.brand);
  assert.equal(preview.payload.manufacture, SELLER_FIXED_CONFIG.manufacture);
  assert.equal(preview.payload.deliveryCompanyCode, SELLER_FIXED_CONFIG.deliveryCompanyCode);
  assert.equal(preview.payload.remoteAreaDeliverable, 'N');
  assert.equal(preview.payload.outboundShippingPlaceCode, 111);
  assert.equal(preview.payload.returnCenterCode, '222');
  assert.equal(preview.payload.items.length, 1);
  assert.equal(preview.payload.items[0].itemName, '아이보리');
  assert.equal(preview.payload.items[0].stockQuantity, 10);
  assert.equal(preview.mainImageUrl, 'https://pub.example/drafts/46/coupang/main.jpg');
  assert.equal(preview.detailImageUrls.length, 10);
  assert.deepEqual(preview.readiness.missing, []);
  assert.equal(preview.readiness.blocked, false);

  const noticeMaterial = preview.payload.items[0].notices.find((n) => n.noticeCategoryDetailName === '종류');
  assert.ok(noticeMaterial);
});

test('buildRegistrationPreview blocks when the seller brand requires a GTIN/MPN that was never supplied', async () => {
  const db = makeDraftsDb([]);
  const client = fakeCoupangClient({
    searchBrandResult: { data: [{ brandId: 'KR-999', brandName: SELLER_FIXED_CONFIG.brand, isUIDRequired: true, allowedUIDTypes: ['GTIN', 'MPN'] }] },
  });
  const preview = await buildRegistrationPreview(db, '/repo', 46, commonPreviewDeps({ clientImpl: client }));

  assert.equal(preview.identifierStatus.status, 'MISSING_GTIN_MPN');
  assert.equal(preview.readiness.blocked, true);
  assert.ok(preview.readiness.missing.some((line) => line.includes('GTIN 또는 MPN이 필요합니다')));
  assert.deepEqual(preview.payload.items[0].attributes.filter((a) => a.attributeTypeName.startsWith('Global') || a.attributeTypeName.startsWith('Manufacturer')), []);
});

test('buildRegistrationPreview unblocks and attaches a Global Trade Item Number attribute when overrides.gtin is supplied for a UID-required brand', async () => {
  const db = makeDraftsDb([]);
  const client = fakeCoupangClient({
    searchBrandResult: { data: [{ brandId: 'KR-999', brandName: SELLER_FIXED_CONFIG.brand, isUIDRequired: true, allowedUIDTypes: ['GTIN', 'MPN'] }] },
  });
  const preview = await buildRegistrationPreview(db, '/repo', 46, commonPreviewDeps({
    clientImpl: client,
    overrides: { gtin: '8801234567890' },
  }));

  assert.equal(preview.identifierStatus.status, 'PASS');
  assert.equal(preview.payload.brandId, 'KR-999');
  assert.deepEqual(
    preview.payload.items[0].attributes.filter((a) => a.attributeTypeName === 'Global Trade Item Number'),
    [{ attributeTypeName: 'Global Trade Item Number', attributeValueName: '8801234567890', exposed: 'NONE' }],
  );
  assert.equal(preview.readiness.blocked, false);
});

test('buildRegistrationPreview overrides win over applied-analysis autofill', async () => {
  const db = makeDraftsDb([]);
  const preview = await buildRegistrationPreview(db, '/repo', 46, {
    ...commonPreviewDeps(),
    overrides: { material: '사용자 지정 소재' },
  });
  // material only feeds the 소재 notice field when the category's chosen
  // template actually includes it; assert indirectly via readiness instead,
  // which always reports the resolved value regardless of template shape.
  assert.ok(preview.readiness.ready.some((line) => line.includes('사용자 지정 소재')));
});

test('buildRegistrationPreview reports readiness.blocked when the category has no mapped attributes/manufacturer', async () => {
  const db = makeDraftsDb([]);
  const preview = await buildRegistrationPreview(db, '/repo', 46, commonPreviewDeps({
    categoryAdapterImpl: fakeCategoryAdapter({ prediction: { displayCategoryCode: null, categoryName: null, predictionResultType: 'NONE' } }),
    getAppliedAnalysisImpl: async () => null,
  }));
  assert.equal(preview.readiness.blocked, true);
  assert.ok(preview.readiness.missing.length > 0);
});

test('buildRegistrationPreview blocks on an unresolved MANDATORY notice field even when material/size/manufacturer/country are all resolved', async () => {
  const db = makeDraftsDb([]);
  const furnitureCategoryMeta = {
    ...CATEGORY_META,
    noticeCategoryTemplates: [{
      noticeCategoryName: '가구',
      noticeCategoryDetailNames: [
        { noticeCategoryDetailName: '주요 소재', required: 'MANDATORY' },
        { noticeCategoryDetailName: '구성품', required: 'MANDATORY' },
      ],
    }],
  };
  const preview = await buildRegistrationPreview(db, '/repo', 46, commonPreviewDeps({
    categoryAdapterImpl: fakeCategoryAdapter({ categoryMeta: furnitureCategoryMeta }),
  }));

  assert.equal(preview.readiness.blocked, true);
  assert.ok(preview.readiness.missing.some((line) => line.includes('구성품')));
  // 주요 소재 resolves via the 소재 synonym even though the template names it differently.
  assert.ok(!preview.readiness.missing.some((line) => line.includes('주요 소재')));
});

test('buildRegistrationPreview forwards overrides.noticeContentOverrides into the payload notices and unblocks readiness', async () => {
  const db = makeDraftsDb([]);
  const furnitureCategoryMeta = {
    ...CATEGORY_META,
    noticeCategoryTemplates: [{
      noticeCategoryName: '가구',
      noticeCategoryDetailNames: [{ noticeCategoryDetailName: '구성품', required: 'MANDATORY' }],
    }],
  };
  const preview = await buildRegistrationPreview(db, '/repo', 46, commonPreviewDeps({
    categoryAdapterImpl: fakeCategoryAdapter({ categoryMeta: furnitureCategoryMeta }),
    overrides: { noticeContentOverrides: { 구성품: '선반 1개, 고정 브래킷 2개' } },
  }));

  const notice = preview.payload.items[0].notices.find((n) => n.noticeCategoryDetailName === '구성품');
  assert.equal(notice.content, '선반 1개, 고정 브래킷 2개');
  assert.equal(preview.readiness.blocked, false);
});

test('createDirectRegistration refuses draft 64 without calling the Coupang client at all', async () => {
  const db = makeDraftsDb([]);
  const client = fakeCoupangClient();
  await assert.rejects(
    () => createDirectRegistration(db, '/repo', PROTECTED_DRAFT_ID, { confirm: true, clientImpl: client, buildRegistrationPreviewImpl: async () => { throw new Error('should not be called'); } }),
    (error) => error.code === 'DRAFT_PROTECTED',
  );
  assert.equal(client.calls.createProduct, 0);
});

test('createDirectRegistration blocks on an existing registration (dedup) and never builds a payload or calls the API', async () => {
  const db = makeDraftsDb([]);
  const client = fakeCoupangClient();
  let previewCalled = false;
  await assert.rejects(
    () => createDirectRegistration(db, '/repo', 46, {
      confirm: true,
      clientImpl: client,
      getCoupangRegistrationImpl: async () => ({ status: 'created', sellerProductId: '123' }),
      buildRegistrationPreviewImpl: async () => { previewCalled = true; },
    }),
    (error) => error.code === 'ALREADY_REGISTERED',
  );
  assert.equal(previewCalled, false);
  assert.equal(client.calls.createProduct, 0);
});

test('createDirectRegistration with confirm=false (default) returns a dry-run payload and never calls createProduct', async () => {
  const db = makeDraftsDb([]);
  const client = fakeCoupangClient();
  const result = await createDirectRegistration(db, '/repo', 46, {
    confirm: false,
    coupangConfig: { vendorId: 'A00000000' },
    clientImpl: client,
    getCoupangRegistrationImpl: async () => null,
    buildRegistrationPreviewImpl: async () => ({ payload: { requested: false }, readiness: { blocked: false, ready: [], missing: [] }, requestHash: 'abc' }),
  });
  assert.equal(result.dryRun, true);
  assert.equal(client.calls.createProduct, 0);
});

test('createDirectRegistration refuses to call createProduct while readiness is blocked, even with confirm=true', async () => {
  const db = makeDraftsDb([]);
  const client = fakeCoupangClient();
  await assert.rejects(
    () => createDirectRegistration(db, '/repo', 46, {
      confirm: true,
      clientImpl: client,
      getCoupangRegistrationImpl: async () => null,
      buildRegistrationPreviewImpl: async () => ({ payload: { requested: false }, readiness: { blocked: true, ready: [], missing: ['제조자 미확정'] }, requestHash: 'abc' }),
    }),
    (error) => error.code === 'REGISTRATION_NOT_READY',
  );
  assert.equal(client.calls.createProduct, 0);
});

test('createDirectRegistration with confirm=true calls createProduct exactly once, records sellerProductId, requested=false, and never calls requestApproval', async () => {
  const db = makeDraftsDb([]);
  const client = fakeCoupangClient({ createProductResult: { code: 'SUCCESS', data: '16301999999' } });
  let recorded = null;
  const result = await createDirectRegistration(db, '/repo', 46, {
    confirm: true,
    clientImpl: client,
    getCoupangRegistrationImpl: async () => null,
    buildRegistrationPreviewImpl: async () => ({ payload: { requested: false, sellerProductName: 'test product' }, readiness: { blocked: false, ready: [], missing: [] }, requestHash: 'hash123' }),
    recordDirectRegistrationImpl: async (_db, draftId, args) => { recorded = { draftId, ...args }; return { productDraftId: draftId, sellerProductId: args.sellerProductId, status: 'created' }; },
  });
  assert.equal(client.calls.createProduct, 1);
  assert.equal(client.calls.requestApproval, 0);
  assert.equal(result.dryRun, false);
  assert.equal(result.sellerProductId, '16301999999');
  assert.equal(recorded.sellerProductId, '16301999999');
  assert.equal(recorded.requestHash, 'hash123');
  assert.equal(result.payload.requested, false);
});

test('createDirectRegistration surfaces RECORD_CONFLICT_AFTER_CREATE loudly instead of silently losing a just-created live listing', async () => {
  const db = makeDraftsDb([]);
  const client = fakeCoupangClient({ createProductResult: { code: 'SUCCESS', data: '16302000000' } });
  await assert.rejects(
    () => createDirectRegistration(db, '/repo', 46, {
      confirm: true,
      clientImpl: client,
      getCoupangRegistrationImpl: async () => null,
      buildRegistrationPreviewImpl: async () => ({ payload: { requested: false }, readiness: { blocked: false, ready: [], missing: [] }, requestHash: 'hash' }),
      recordDirectRegistrationImpl: async () => null,
    }),
    (error) => error.code === 'RECORD_CONFLICT_AFTER_CREATE' && error.sellerProductId === '16302000000',
  );
});

test('requestCoupangSaleApproval refuses draft 64 without calling the Coupang client at all', async () => {
  const client = fakeCoupangClient();
  await assert.rejects(
    () => requestCoupangSaleApproval({}, PROTECTED_DRAFT_ID, { clientImpl: client, getCoupangRegistrationImpl: async () => { throw new Error('should not be called'); } }),
    (error) => error.code === 'DRAFT_PROTECTED',
  );
  assert.equal(client.calls.getProduct, 0);
  assert.equal(client.calls.requestApproval, 0);
});

test('requestCoupangSaleApproval refuses a draft with no linked sellerProductId', async () => {
  const client = fakeCoupangClient();
  await assert.rejects(
    () => requestCoupangSaleApproval({}, 27, { clientImpl: client, getCoupangRegistrationImpl: async () => null }),
    (error) => error.code === 'NOT_LINKED',
  );
  assert.equal(client.calls.getProduct, 0);
  assert.equal(client.calls.requestApproval, 0);
});

test('requestCoupangSaleApproval refuses without calling the API when this app already recorded requested=true', async () => {
  const client = fakeCoupangClient();
  await assert.rejects(
    () => requestCoupangSaleApproval({}, 27, {
      clientImpl: client,
      getCoupangRegistrationImpl: async () => ({ sellerProductId: '16311872388', status: 'approval_requested', requested: true }),
    }),
    (error) => error.code === 'ALREADY_REQUESTED',
  );
  assert.equal(client.calls.getProduct, 0);
  assert.equal(client.calls.requestApproval, 0);
});

test('requestCoupangSaleApproval re-queries the live status and refuses to call requestApproval when it is not 임시저장', async () => {
  const client = fakeCoupangClient({ getProductResults: [{ data: { statusName: '승인완료' } }] });
  let recorded = false;
  await assert.rejects(
    () => requestCoupangSaleApproval({}, 27, {
      clientImpl: client,
      getCoupangRegistrationImpl: async () => ({ sellerProductId: '16311872388', status: 'created', requested: false }),
      recordApprovalRequestedImpl: async () => { recorded = true; },
    }),
    (error) => error.code === 'NOT_TEMPORARY_SAVED' && error.liveStatusName === '승인완료',
  );
  assert.equal(client.calls.getProduct, 1);
  assert.equal(client.calls.requestApproval, 0);
  assert.equal(recorded, false);
});

test('requestCoupangSaleApproval calls requestApproval exactly once when live status is 임시저장, then records the result', async () => {
  const client = fakeCoupangClient({
    getProductResults: [{ data: { statusName: '임시저장' } }, { data: { statusName: '승인요청중' } }],
    requestApprovalResult: { code: 'SUCCESS', data: null },
  });
  let recordedArgs = null;
  const result = await requestCoupangSaleApproval({}, 27, {
    clientImpl: client,
    getCoupangRegistrationImpl: async () => ({ sellerProductId: '16311872388', status: 'created', requested: false }),
    recordApprovalRequestedImpl: async (_db, draftId, args) => { recordedArgs = { draftId, ...args }; return { productDraftId: draftId, status: 'approval_requested', requested: true, liveStatusName: args.statusName }; },
  });

  assert.equal(client.calls.getProduct, 2);
  assert.equal(client.calls.requestApproval, 1);
  assert.equal(client.lastApprovalSellerProductId, '16311872388');
  assert.equal(recordedArgs.draftId, 27);
  assert.equal(recordedArgs.statusName, '승인요청중');
  assert.match(recordedArgs.responseMessage, /SUCCESS/);
  assert.equal(result.registration.status, 'approval_requested');
  assert.equal(result.liveStatusNameBefore, '임시저장');
  assert.equal(result.liveStatusNameAfter, '승인요청중');
});
