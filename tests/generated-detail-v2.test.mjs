import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGeneratedDetailHtmlV2 } from '../src/admin-store.mjs';

test('v2 generated detail HTML uses archived source images only in the reference section', () => {
  const html = buildGeneratedDetailHtmlV2(
    {
      sellingTitle: '[GS마켓] 수납함 특가',
      originalProductName: '[GS마켓] 수납함 특가',
      cost: 5000,
      shippingFee: 3000,
      minOrderQty: 1,
      images: [
        { imageType: 'main', storedUrl: '/original-images/drafts/64/main.jpg', originalUrl: 'https://supplier.test/main.jpg' },
        {
          imageType: 'detail_source_full',
          sourceSection: 'detail',
          storedUrl: '/original-images/drafts/64/detail-source-full-4972.jpg',
          originalUrl: 'https://supplier.test/detail.jpg',
        },
      ],
      options: [],
    },
    { includeOriginalDetailImages: true },
  );

  assert.ok(html.includes('/original-images/drafts/64/detail-source-full-4972.jpg'));
  assert.equal(html.includes('https://supplier.test/detail.jpg'), false);
  assert.ok(html.indexOf('<section class="am-section am-reference">') > html.indexOf('<section class="am-section am-benefits">'));
  assert.ok(html.indexOf('<section class="am-section am-reference">') < html.indexOf('<section class="am-section am-options">'));
  assert.equal(html.includes('[GS마켓]'), false);
  assert.equal(html.includes('특가'), false);
});

test('v2 generated detail HTML can omit archived source images by explicit choice', () => {
  const html = buildGeneratedDetailHtmlV2(
    {
      sellingTitle: '수납함',
      images: [
        {
          imageType: 'detail_source_full',
          sourceSection: 'detail',
          storedUrl: '/original-images/drafts/64/detail-source-full-4972.jpg',
        },
      ],
      options: [],
    },
    { includeOriginalDetailImages: false },
  );

  assert.equal(html.includes('/original-images/drafts/64/detail-source-full-4972.jpg'), false);
});
