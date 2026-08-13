import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNaverOriginProductPayload, mapLiveNaverProductToImageSwapPayload } from '../src/naver-payload-builder.mjs';

function fakeDraft(overrides = {}) {
  return {
    optimizedTitle: '무타공 수납 정리함',
    sellerProductName: '무타공 수납 정리함',
    salePrice: 19800,
    ...overrides,
  };
}

test('buildNaverOriginProductPayload builds a SALE-status originProduct with the resolved category, name, and price', () => {
  const payload = buildNaverOriginProductPayload({
    draft: fakeDraft(),
    categoryId: '50000803',
    mainImageUrl: 'https://pub.example/main.jpg',
    detailImageUrls: ['https://pub.example/detail-1.jpg', 'https://pub.example/detail-2.jpg'],
  });

  assert.equal(payload.originProduct.statusType, 'SALE');
  assert.equal(payload.originProduct.leafCategoryId, '50000803');
  assert.equal(payload.originProduct.name, '무타공 수납 정리함');
  assert.equal(payload.originProduct.salePrice, 19800);
  assert.equal(payload.originProduct.images.representativeImage.url, 'https://pub.example/main.jpg');
  assert.equal(payload.originProduct.images.optionalImages.length, 2);
  assert.match(payload.originProduct.detailContent, /detail-1\.jpg/);
  assert.match(payload.originProduct.detailContent, /detail-2\.jpg/);
});

test('buildNaverOriginProductPayload caps optionalImages at 9 (representativeImage carries the 10th slot separately)', () => {
  const detailImageUrls = Array.from({ length: 12 }, (_, i) => `https://pub.example/detail-${i + 1}.jpg`);
  const payload = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: 'https://pub.example/main.jpg', detailImageUrls });
  assert.equal(payload.originProduct.images.optionalImages.length, 9);
  // detailContent still gets the full ordered set, not just the capped 9.
  assert.match(payload.originProduct.detailContent, /detail-12\.jpg/);
});

test('buildNaverOriginProductPayload falls back to null leafCategoryId when no category was resolved', () => {
  const payload = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: null, mainImageUrl: null, detailImageUrls: [] });
  assert.equal(payload.originProduct.leafCategoryId, null);
  assert.equal(payload.originProduct.images.representativeImage, null);
});

test('buildNaverOriginProductPayload fills manufacturer/origin from supplierNoticeFields when not explicitly overridden', () => {
  const payload = buildNaverOriginProductPayload({
    draft: fakeDraft(),
    categoryId: '1',
    mainImageUrl: 'https://pub.example/main.jpg',
    detailImageUrls: ['https://pub.example/detail-1.jpg'],
    supplierNoticeFields: { manufacturer: '공급처제조사', countryOfOrigin: '수입산 / 아시아 / 중국', modelName: 'MX-100' },
  });
  assert.equal(payload.originProduct.detailAttribute.manufacturerName, '공급처제조사');
  // content stays the human-readable string; originAreaCode is a separate,
  // explicitly-resolved param (see pickOriginAreaCode) since Naver only
  // accepts its own origin-area codes there, not free text.
  assert.equal(payload.originProduct.detailAttribute.originAreaInfo.content, '수입산 / 아시아 / 중국');
  assert.equal(payload.originProduct.detailAttribute.productInfoProvidedNotice.etc.manufacturer, '공급처제조사');
  assert.equal(payload.originProduct.detailAttribute.productInfoProvidedNotice.etc.modelName, 'MX-100');
});

// createOriginProduct rejects a free-text originAreaCode outright ("원산지
// 상세코드 항목이 유효하지 않습니다", confirmed live 2026-07-24) -- it must be
// passed in already resolved to one of Naver's own codes, or left null.
test('buildNaverOriginProductPayload passes originAreaCode through as-is and defaults to null when not resolved', () => {
  const resolved = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: null, detailImageUrls: [], originAreaCode: '0200037' });
  assert.equal(resolved.originProduct.detailAttribute.originAreaInfo.originAreaCode, '0200037');

  const unresolved = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: null, detailImageUrls: [] });
  assert.equal(unresolved.originProduct.detailAttribute.originAreaInfo.originAreaCode, null);
});

// GET /v1/products-for-provided-notice confirmed live (2026-07-24) that
// 'ETC' (not the Korean label) is the real enum value, and modelName is a
// NotNull field on that type -- a live create_origin_product call 400'd on
// exactly this before the fix (empty/missing modelName, wrong enum string).
test('buildNaverOriginProductPayload uses the ETC enum constant and defaults modelName so a missing supplier model never leaves it null', () => {
  const payload = buildNaverOriginProductPayload({
    draft: fakeDraft(),
    categoryId: '1',
    mainImageUrl: null,
    detailImageUrls: [],
    supplierNoticeFields: {},
  });
  assert.equal(payload.originProduct.detailAttribute.productInfoProvidedNotice.productInfoProvidedNoticeType, 'ETC');
  assert.equal(payload.originProduct.detailAttribute.productInfoProvidedNotice.etc.modelName, '해당없음');
});

// minorPurchasable and channelProductDisplayStatusType are both NotNull /
// required-enum fields the real API rejected when absent. SUSPENSION keeps
// a fresh registration hidden from sale until a human flips it to ON --
// the same 자동 판매 승인 금지 gate Coupang's requestApproval step enforces.
test('buildNaverOriginProductPayload defaults minorPurchasable to true and channelProductDisplayStatusType to SUSPENSION', () => {
  const payload = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: null, detailImageUrls: [] });
  assert.equal(payload.originProduct.detailAttribute.minorPurchasable, true);
  assert.equal(payload.smartstoreChannelProduct.channelProductDisplayStatusType, 'SUSPENSION');
});

// afterServiceTelephoneNumber, originAreaInfo.importer, and
// deliveryFee.deliveryFeePayType are all NotEmpty on the real API (confirmed
// live 2026-07-24). importer has no real business name on file, so per user
// instruction (2026-07-24) it defaults to pointing the buyer at the product
// detail page. afterServiceTelephoneNumber has its own regex validator
// ("숫자, -, +만 입력 가능") that rejects free text, so callers must pass a real
// phone number (read from NAVER_AS_PHONE_NUMBER in .env, never hardcoded here).
test('buildNaverOriginProductPayload defaults importer to "상세 페이지 참조" and deliveryFeePayType to PREPAID, passes through AS phone', () => {
  const payload = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: null, detailImageUrls: [], asPhoneNumber: '010-0000-0000' });
  assert.equal(payload.originProduct.detailAttribute.afterServiceInfo.afterServiceTelephoneNumber, '010-0000-0000');
  assert.equal(payload.originProduct.detailAttribute.originAreaInfo.importer, '상세 페이지 참조');
  assert.equal(payload.originProduct.deliveryInfo.deliveryFee.deliveryFeePayType, 'PREPAID');
});

test('buildNaverOriginProductPayload lets real AS phone / importer values override the defaults', () => {
  const payload = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: null, detailImageUrls: [], asPhoneNumber: '010-1234-5678', importer: '다솜상사' });
  assert.equal(payload.originProduct.detailAttribute.afterServiceInfo.afterServiceTelephoneNumber, '010-1234-5678');
  assert.equal(payload.originProduct.detailAttribute.originAreaInfo.importer, '다솜상사');
});

// ExclusiveNotNull on the real API (confirmed live 2026-07-24): the ETC
// notice block's afterServiceDirector and customerServicePhoneNumber may not
// both be set at once.
test('buildNaverOriginProductPayload only sets one of etc.afterServiceDirector/customerServicePhoneNumber, never both', () => {
  const payload = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: null, detailImageUrls: [], asPhoneNumber: '010-0000-0000' });
  const etc = payload.originProduct.detailAttribute.productInfoProvidedNotice.etc;
  assert.equal(etc.afterServiceDirector, '010-0000-0000');
  assert.equal(etc.customerServicePhoneNumber, null);
});

test('buildNaverOriginProductPayload includes smartstoreChannelProduct with the channel id when provided', () => {
  const payload = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: null, detailImageUrls: [], channelId: 'channel-99' });
  assert.equal(payload.smartstoreChannelProduct.channelId, 'channel-99');
  assert.equal(payload.smartstoreChannelProduct.naverShoppingRegistration, true);
  assert.equal(payload.smartstoreChannelProduct.channelProductName, '무타공 수납 정리함');
});

// Mirrors coupang-payload-builder.mjs's mapLiveProductToUpdatePayload tests --
// a live getProduct() response spread wholesale, only images/detailContent
// overridden.
function liveNaverProductFixture(overrides = {}) {
  return {
    originProduct: {
      statusType: 'SALE',
      name: '무타공 수납 정리함',
      salePrice: 19800,
      stockQuantity: 999,
      leafCategoryId: '50000803',
      images: { representativeImage: { url: 'https://pub.example/old-main.jpg' }, optionalImages: [{ url: 'https://pub.example/old-detail-1.jpg' }] },
      detailContent: '<img src="https://pub.example/old-detail-1.jpg" />',
      deliveryInfo: { deliveryType: 'DELIVERY' },
      detailAttribute: { manufacturerName: '와우픽' },
    },
    smartstoreChannelProduct: { channelProductDisplayStatusType: 'SUSPENSION', naverShoppingRegistration: true },
    ...overrides,
  };
}

test('mapLiveNaverProductToImageSwapPayload replaces only images/detailContent, carrying every other originProduct field through verbatim', () => {
  const live = liveNaverProductFixture();
  const payload = mapLiveNaverProductToImageSwapPayload(live, {
    mainImageUrl: 'https://pub.example/new-main.jpg',
    detailImageUrls: ['https://pub.example/new-detail-1.jpg', 'https://pub.example/new-detail-2.jpg'],
  });

  assert.equal(payload.originProduct.images.representativeImage.url, 'https://pub.example/new-main.jpg');
  assert.deepEqual(payload.originProduct.images.optionalImages, [{ url: 'https://pub.example/new-detail-1.jpg' }, { url: 'https://pub.example/new-detail-2.jpg' }]);
  assert.match(payload.originProduct.detailContent, /new-detail-1\.jpg/);
  assert.match(payload.originProduct.detailContent, /new-detail-2\.jpg/);

  // untouched fields carried through from the live GET response
  assert.equal(payload.originProduct.statusType, 'SALE');
  assert.equal(payload.originProduct.salePrice, 19800);
  assert.equal(payload.originProduct.stockQuantity, 999);
  assert.equal(payload.originProduct.leafCategoryId, '50000803');
  assert.deepEqual(payload.originProduct.deliveryInfo, { deliveryType: 'DELIVERY' });
  assert.equal(payload.originProduct.detailAttribute.manufacturerName, '와우픽');
  assert.deepEqual(payload.smartstoreChannelProduct, { channelProductDisplayStatusType: 'SUSPENSION', naverShoppingRegistration: true });
});

test('mapLiveNaverProductToImageSwapPayload caps optionalImages at 9, same limit as create', () => {
  const live = liveNaverProductFixture();
  const detailImageUrls = Array.from({ length: 10 }, (_, i) => `https://pub.example/detail-${i + 1}.jpg`);
  const payload = mapLiveNaverProductToImageSwapPayload(live, { mainImageUrl: 'https://pub.example/main.jpg', detailImageUrls });
  assert.equal(payload.originProduct.images.optionalImages.length, 9);
});
