import assert from 'node:assert/strict';
import test from 'node:test';

import { createNaverDirectRegistration, buildNaverRegistrationPreview, pickBestNaverCategory, pickOriginAreaCode, uploadImagesToNaver } from '../src/naver-registration-flow.mjs';
import { PROTECTED_DRAFT_ID } from '../src/coupang-registration-flow.mjs';

function makeDb() {
  return {
    async query(sql) {
      if (sql.includes('select supplier_product_id from product_drafts')) return { rows: [{ supplier_product_id: 900 }] };
      if (sql.includes('select raw_json from supplier_products')) {
        return { rows: [{ raw_json: { domeggook: { detail: { manufacturer: '공급처제조사', country: '수입산_아시아_중국', model: null, size: null, weight: null } } } }] };
      }
      throw new Error(`unhandled query: ${sql}`);
    },
  };
}

// searchCategories' real shape (confirmed live 2026-07-24): a flat array of
// every category in the tree, not `{ data: [...] }` with a `categoryId`
// field -- see pickBestNaverCategory's comment in naver-registration-flow.mjs.
// getOriginAreas' real shape (confirmed live 2026-07-24): { originAreaCodeNames:
// [{ code, name }] }, name using "수입산:아시아>중국"-style separators -- see
// pickOriginAreaCode's comment in naver-registration-flow.mjs.
function fakeNaverClient({
  searchResult = [{ id: '50000803', name: '정리함', last: true, wholeCategoryName: '생활/건강>수납/정리>정리함' }],
  originAreasResult = { originAreaCodeNames: [{ code: '0200037', name: '수입산:아시아>중국' }] },
  createResult = { data: { originProductNo: '7777777777', channelProducts: [{ channelProductNo: '8888888888' }] } },
} = {}) {
  const calls = { searchCategories: 0, createOriginProduct: 0 };
  return {
    calls,
    async searchCategories() { calls.searchCategories += 1; return searchResult; },
    async getOriginAreas() { return originAreasResult; },
    async createOriginProduct(payload) { calls.createOriginProduct += 1; this.lastPayload = payload; return createResult; },
  };
}

function commonPreviewDeps(overrides = {}) {
  return {
    naverConfig: { clientId: 'client-1', clientSecret: 'secret' },
    clientImpl: fakeNaverClient(),
    exportProductDraftImpl: async () => ({ optimizedTitle: '무타공 수납 정리함', name: '무타공 수납 정리함', salePrice: 19800, deliveryFee: 0 }),
    getDraftRawImagesImpl: async () => ({
      mainImageLocalUrl: 'https://domeggook.example/product/main.jpg',
      detailImageLocalUrls: ['/generated-images/drafts/501/detail-1-slice-001.jpg'],
    }),
    uploadImpl: async ({ detailImageLocalUrls }) => ({
      mainImageUrl: 'https://pub.example/drafts/501/naver/main.jpg',
      detailImageUrls: detailImageLocalUrls.map((_, i) => `https://pub.example/drafts/501/naver/detail-${i + 1}.jpg`),
    }),
    // createOriginProduct only accepts image URLs Naver's own upload API
    // returned (see uploadImagesToNaver's comment), so the R2 URLs above
    // always make one more hop through this before reaching the payload.
    uploadImagesToNaverImpl: async (_client, { mainImageUrl, detailImageUrls }) => ({
      mainImageUrl: mainImageUrl.replace('pub.example', 'naver-cdn.example'),
      detailImageUrls: detailImageUrls.map((url) => url.replace('pub.example', 'naver-cdn.example')),
    }),
    ...overrides,
  };
}

test('pickBestNaverCategory picks the longest (most specific) leaf category name found in the product title', () => {
  const categories = [
    { id: '1', name: '무', last: true },
    { id: '2', name: '선반', last: true },
    { id: '3', name: '레일선반', last: true },
    { id: '4', name: '가구', last: false }, // not a leaf -- must be ignored even though it matches
  ];
  assert.equal(pickBestNaverCategory(categories, '무타공 레일선반 정리함'), '3');
});

test('pickBestNaverCategory ignores single-character matches and returns null when nothing else fits', () => {
  const categories = [{ id: '1', name: '무', last: true }];
  assert.equal(pickBestNaverCategory(categories, '무타공 정리함'), null);
});

test('pickBestNaverCategory returns null for an empty or non-array category list', () => {
  assert.equal(pickBestNaverCategory([], '정리함'), null);
  assert.equal(pickBestNaverCategory(null, '정리함'), null);
});

// createOriginProduct rejects a free-text origin string outright ("원산지
// 상세코드 항목이 유효하지 않습니다", confirmed live 2026-07-24); this app's own
// normalized country string uses "/"-joined segments while Naver's own list
// uses ":"/">" -- pickOriginAreaCode has to bridge the two separator styles.
test('pickOriginAreaCode matches this app\'s "/"-joined country string against Naver\'s ":"/">"-joined name', () => {
  const originAreaCodeNames = [
    { code: '00', name: '국산' },
    { code: '0200037', name: '수입산:아시아>중국' },
    { code: '0200038', name: '수입산:아시아>일본' },
  ];
  assert.equal(pickOriginAreaCode(originAreaCodeNames, '수입산 / 아시아 / 중국'), '0200037');
});

test('pickOriginAreaCode matches a domestic-only string to the general 국산 entry, not an unrelated sub-region', () => {
  const originAreaCodeNames = [
    { code: '00', name: '국산' },
    { code: '0001', name: '국산:강원도' },
  ];
  assert.equal(pickOriginAreaCode(originAreaCodeNames, '국산'), '00');
});

test('pickOriginAreaCode returns null when nothing matches or input is missing', () => {
  assert.equal(pickOriginAreaCode([{ code: '00', name: '국산' }], '수입산 / 유럽 / 프랑스'), null);
  assert.equal(pickOriginAreaCode([], '국산'), null);
  assert.equal(pickOriginAreaCode(null, '국산'), null);
  assert.equal(pickOriginAreaCode([{ code: '00', name: '국산' }], null), null);
});

// createOriginProduct rejected R2-hosted URLs outright with "올바른 이미지
// 파일이 아닙니다" (confirmed live 2026-07-24) -- only URLs Naver's own
// POST /v1/product-images/upload returns are accepted, so every R2 URL has
// to be re-fetched and re-uploaded through that endpoint first.
test('uploadImagesToNaver fetches each R2 URL, uploads all of them through client.uploadImages in one call, and maps main/detail URLs back in order', async () => {
  const calls = [];
  const client = {
    async uploadImages(files) {
      calls.push(files);
      return { images: files.map((_, i) => ({ url: `https://shop-phinf.pstatic.net/img-${i}.png` })) };
    },
  };
  const fetchImpl = async (url) => ({
    arrayBuffer: async () => Buffer.from(`bytes-for-${url}`),
    headers: { get: () => 'image/png' },
  });
  const result = await uploadImagesToNaver(client, {
    mainImageUrl: 'https://pub.example/main.png',
    detailImageUrls: ['https://pub.example/detail-1.png', 'https://pub.example/detail-2.png'],
    fetchImpl,
  });
  assert.equal(calls[0].length, 3, 'main image + 2 detail images uploaded in a single call');
  assert.equal(calls[0][0].contentType, 'image/png');
  assert.equal(result.mainImageUrl, 'https://shop-phinf.pstatic.net/img-0.png');
  assert.deepEqual(result.detailImageUrls, ['https://shop-phinf.pstatic.net/img-1.png', 'https://shop-phinf.pstatic.net/img-2.png']);
});

// The real upload endpoint 400s past 10 files in one call ("업로드대상 이미지
// 파일은 최대 10개 까지만 등록할 수 있습니다", confirmed live 2026-07-24) -- a raw
// registration's main + 13 detail-slice images (14 total) hit exactly this.
test('uploadImagesToNaver batches more than 10 images into sequential uploadImages calls and reassembles the URLs in order', async () => {
  const calls = [];
  const client = {
    async uploadImages(files) {
      calls.push(files.length);
      return { images: files.map((f) => ({ url: `https://shop-phinf.pstatic.net/${f.filename}.png` })) };
    },
  };
  const fetchImpl = async (url) => ({ arrayBuffer: async () => Buffer.from(url), headers: { get: () => 'image/jpeg' } });
  const detailImageUrls = Array.from({ length: 13 }, (_, i) => `https://pub.example/detail-${i + 1}.jpg`);
  const result = await uploadImagesToNaver(client, { mainImageUrl: 'https://pub.example/main.jpg', detailImageUrls, fetchImpl });

  assert.deepEqual(calls, [10, 4], 'main + 13 details = 14 files, batched as 10 then 4');
  assert.equal(result.mainImageUrl, 'https://shop-phinf.pstatic.net/image-0.jpg.png');
  assert.equal(result.detailImageUrls.length, 13);
  assert.equal(result.detailImageUrls[12], 'https://shop-phinf.pstatic.net/image-13.jpg.png');
});

test('buildNaverRegistrationPreview refuses draft 64 immediately', async () => {
  await assert.rejects(
    () => buildNaverRegistrationPreview(makeDb(), '/repo', PROTECTED_DRAFT_ID, commonPreviewDeps()),
    (error) => error.code === 'DRAFT_PROTECTED',
  );
});

test('buildNaverRegistrationPreview blocks when no raw images exist', async () => {
  await assert.rejects(
    () => buildNaverRegistrationPreview(makeDb(), '/repo', 501, commonPreviewDeps({
      getDraftRawImagesImpl: async () => ({ mainImageLocalUrl: null, detailImageLocalUrls: [] }),
    })),
    (error) => error.code === 'IMAGES_NOT_APPROVED',
  );
});

test('buildNaverRegistrationPreview assembles a clean (non-blocked) readiness report and payload when everything resolves', async () => {
  const preview = await buildNaverRegistrationPreview(makeDb(), '/repo', 501, commonPreviewDeps());
  assert.equal(preview.readiness.blocked, false);
  assert.equal(preview.payload.originProduct.leafCategoryId, '50000803');
  assert.equal(preview.payload.originProduct.salePrice, 19800);
  assert.equal(preview.payload.originProduct.detailAttribute.originAreaInfo.originAreaCode, '0200037');
  assert.equal(preview.mainImageUrl, 'https://naver-cdn.example/drafts/501/naver/main.jpg');
});

test('buildNaverRegistrationPreview reports readiness.blocked when the origin-area code cannot be matched', async () => {
  const preview = await buildNaverRegistrationPreview(makeDb(), '/repo', 501, commonPreviewDeps({
    clientImpl: fakeNaverClient({ originAreasResult: { originAreaCodeNames: [{ code: '00', name: '국산' }] } }),
  }));
  assert.equal(preview.readiness.blocked, true);
  assert.ok(preview.readiness.missing.some((line) => line.includes('원산지')));
});

test('buildNaverRegistrationPreview reports readiness.blocked when category search returns nothing', async () => {
  const preview = await buildNaverRegistrationPreview(makeDb(), '/repo', 501, commonPreviewDeps({
    clientImpl: fakeNaverClient({ searchResult: [] }),
  }));
  assert.equal(preview.readiness.blocked, true);
  assert.ok(preview.readiness.missing.some((line) => line.includes('카테고리')));
});

test('createNaverDirectRegistration refuses draft 64 without calling the Naver client at all', async () => {
  const client = fakeNaverClient();
  await assert.rejects(
    () => createNaverDirectRegistration(makeDb(), '/repo', PROTECTED_DRAFT_ID, { confirm: true, clientImpl: client }),
    (error) => error.code === 'DRAFT_PROTECTED',
  );
  assert.equal(client.calls.createOriginProduct, 0);
});

test('createNaverDirectRegistration blocks on an existing registration (dedup) and never calls the API', async () => {
  const client = fakeNaverClient();
  let previewCalled = false;
  await assert.rejects(
    () => createNaverDirectRegistration(makeDb(), '/repo', 501, {
      confirm: true,
      clientImpl: client,
      getNaverRegistrationImpl: async () => ({ status: 'created', originProductNo: '123' }),
      buildNaverRegistrationPreviewImpl: async () => { previewCalled = true; },
    }),
    (error) => error.code === 'ALREADY_REGISTERED',
  );
  assert.equal(previewCalled, false);
  assert.equal(client.calls.createOriginProduct, 0);
});

test('createNaverDirectRegistration with confirm=false (default) returns a dry-run payload and never calls createOriginProduct', async () => {
  const client = fakeNaverClient();
  const result = await createNaverDirectRegistration(makeDb(), '/repo', 501, {
    confirm: false,
    clientImpl: client,
    getNaverRegistrationImpl: async () => null,
    buildNaverRegistrationPreviewImpl: async () => ({ payload: { originProduct: {} }, readiness: { blocked: false, ready: [], missing: [] }, requestHash: 'abc' }),
  });
  assert.equal(result.dryRun, true);
  assert.equal(client.calls.createOriginProduct, 0);
});

test('createNaverDirectRegistration refuses to call createOriginProduct while readiness is blocked, even with confirm=true', async () => {
  const client = fakeNaverClient();
  await assert.rejects(
    () => createNaverDirectRegistration(makeDb(), '/repo', 501, {
      confirm: true,
      clientImpl: client,
      getNaverRegistrationImpl: async () => null,
      buildNaverRegistrationPreviewImpl: async () => ({ payload: {}, readiness: { blocked: true, ready: [], missing: ['카테고리 미확정'] }, requestHash: 'abc' }),
    }),
    (error) => error.code === 'REGISTRATION_NOT_READY',
  );
  assert.equal(client.calls.createOriginProduct, 0);
});

test('createNaverDirectRegistration with confirm=true calls createOriginProduct exactly once and records origin/channel product numbers', async () => {
  const client = fakeNaverClient({ createResult: { data: { originProductNo: '9999999999', channelProducts: [{ channelProductNo: '1111111111' }] } } });
  let recorded = null;
  const result = await createNaverDirectRegistration(makeDb(), '/repo', 501, {
    confirm: true,
    clientImpl: client,
    getNaverRegistrationImpl: async () => null,
    buildNaverRegistrationPreviewImpl: async () => ({ payload: { originProduct: { name: 'x' } }, readiness: { blocked: false, ready: [], missing: [] }, requestHash: 'hash123' }),
    recordNaverDirectRegistrationImpl: async (_db, draftId, args) => { recorded = { draftId, ...args }; return { productDraftId: draftId, originProductNo: args.originProductNo, status: 'created' }; },
  });
  assert.equal(client.calls.createOriginProduct, 1);
  assert.equal(result.dryRun, false);
  assert.equal(result.originProductNo, '9999999999');
  assert.equal(recorded.originProductNo, '9999999999');
  assert.equal(recorded.channelProductNo, '1111111111');
  assert.equal(recorded.requestHash, 'hash123');
});

test('createNaverDirectRegistration surfaces RECORD_CONFLICT_AFTER_CREATE loudly instead of silently losing a just-created live listing', async () => {
  const client = fakeNaverClient({ createResult: { data: { originProductNo: '5555555555' } } });
  await assert.rejects(
    () => createNaverDirectRegistration(makeDb(), '/repo', 501, {
      confirm: true,
      clientImpl: client,
      getNaverRegistrationImpl: async () => null,
      buildNaverRegistrationPreviewImpl: async () => ({ payload: {}, readiness: { blocked: false, ready: [], missing: [] }, requestHash: 'hash' }),
      recordNaverDirectRegistrationImpl: async () => null,
    }),
    (error) => error.code === 'RECORD_CONFLICT_AFTER_CREATE' && error.originProductNo === '5555555555',
  );
});
