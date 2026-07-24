import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNaverOriginProductPayload } from '../src/naver-payload-builder.mjs';

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

test('buildNaverOriginProductPayload fills manufacturer/origin/size from supplierNoticeFields when not explicitly overridden', () => {
  const payload = buildNaverOriginProductPayload({
    draft: fakeDraft(),
    categoryId: '1',
    mainImageUrl: 'https://pub.example/main.jpg',
    detailImageUrls: ['https://pub.example/detail-1.jpg'],
    supplierNoticeFields: { manufacturer: '공급처제조사', countryOfOrigin: '수입산 / 아시아 / 중국', size: '23.5cm x 13.5cm' },
  });
  assert.equal(payload.originProduct.detailAttribute.manufacturerName, '공급처제조사');
  assert.equal(payload.originProduct.detailAttribute.originAreaInfo.originAreaCode, '수입산 / 아시아 / 중국');
  assert.equal(payload.originProduct.detailAttribute.productInfoProvidedNotice.etc.size, '23.5cm x 13.5cm');
});

test('buildNaverOriginProductPayload includes smartstoreChannelProduct with the channel id when provided', () => {
  const payload = buildNaverOriginProductPayload({ draft: fakeDraft(), categoryId: '1', mainImageUrl: null, detailImageUrls: [], channelId: 'channel-99' });
  assert.equal(payload.smartstoreChannelProduct.channelId, 'channel-99');
  assert.equal(payload.smartstoreChannelProduct.naverShoppingRegistration, true);
  assert.equal(payload.smartstoreChannelProduct.channelProductName, '무타공 수납 정리함');
});
