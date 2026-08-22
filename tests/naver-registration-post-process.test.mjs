import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNaverPriceUpdatePayload,
  postProcessNaverRegistration,
} from '../src/naver-registration-post-process.mjs';

const NAVER_MAIN_URL = 'https://shop-phinf.pstatic.net/main.jpg';
const NAVER_DETAIL_URLS = [
  'https://shop-phinf.pstatic.net/detail-1.jpg',
  'https://shop-phinf.pstatic.net/detail-2.jpg',
];

function liveProduct({
  salePrice = 19800,
  mainImageUrl = NAVER_MAIN_URL,
  detailImageUrls = NAVER_DETAIL_URLS,
} = {}) {
  return {
    originProduct: {
      name: '무타공 정리 선반',
      salePrice,
      images: {
        representativeImage: { url: mainImageUrl },
        optionalImages: detailImageUrls.slice(0, 9).map((url) => ({ url })),
      },
      detailContent: detailImageUrls.map((url) => `<img src="${url}" />`).join(''),
      detailAttribute: {
        optionInfo: {
          optionCombinations: [{ id: 11, optionName1: '화이트', stockQuantity: 7 }],
          optionStandards: [{ id: 21, optionGroupName: '색상' }],
          useStockManagement: true,
        },
      },
    },
    smartstoreChannelProduct: { channelProductNo: '888' },
  };
}

function postProcessHarness({ finalProduct = liveProduct(), overrides = {} } = {}) {
  const calls = [];
  const state = {};
  let getCount = 0;
  const client = {
    async getProduct(originProductNo) {
      calls.push(`get:${originProductNo}`);
      getCount += 1;
      return getCount === 1
        ? liveProduct({ salePrice: 14900, mainImageUrl: 'https://shop-phinf.pstatic.net/old-main.jpg', detailImageUrls: ['https://shop-phinf.pstatic.net/old-detail.jpg'] })
        : finalProduct;
    },
    async updateOriginProduct(originProductNo, payload) {
      calls.push(`images:${originProductNo}`);
      state.imagePayload = payload;
    },
    async updateOptionStock(originProductNo, payload) {
      calls.push(`price:${originProductNo}`);
      state.pricePayload = payload;
    },
  };
  const deps = {
    originProductNo: '777',
    salePrice: 19800,
    clientImpl: client,
    async getApprovedMainImpl(db, draftId) {
      calls.push('approved-main');
      assert.equal(db.kind, 'db');
      assert.equal(draftId, 501);
      return { coupangStoredUrl: '/generated-ai-images/drafts/501/main/manual/v1.jpg' };
    },
    async getApprovedDetailImpl(db, draftId) {
      calls.push('approved-detail');
      assert.equal(db.kind, 'db');
      assert.equal(draftId, 501);
      return {
        images: [
          { normalizedStoredUrl: '/generated-ai-images/drafts/501/detail/manual/01.jpg' },
          { normalizedStoredUrl: '/generated-ai-images/drafts/501/detail/manual/02.jpg' },
        ],
      };
    },
    async publishImpl(args) {
      calls.push('r2');
      state.publishArgs = args;
      return {
        mainImageUrl: 'https://r2.example/main.jpg',
        detailImageUrls: ['https://r2.example/detail-1.jpg', 'https://r2.example/detail-2.jpg'],
      };
    },
    async uploadToNaverImpl(receivedClient, args) {
      calls.push('naver-upload');
      state.naverUploadClient = receivedClient;
      state.naverUploadArgs = args;
      return { mainImageUrl: NAVER_MAIN_URL, detailImageUrls: NAVER_DETAIL_URLS };
    },
    async recordImagesSwappedImpl(db, draftId) {
      calls.push('record');
      assert.equal(db.kind, 'db');
      assert.equal(draftId, 501);
      return { productDraftId: 501, originProductNo: '777', status: 'images_swapped' };
    },
    ...overrides,
  };
  return { calls, client, deps, state };
}

test('buildNaverPriceUpdatePayload preserves the live option structure while changing sale price', () => {
  const payload = buildNaverPriceUpdatePayload(liveProduct(), 23900);

  assert.deepEqual(payload, {
    productSalePrice: { salePrice: 23900 },
    optionInfo: {
      optionCombinations: [{ id: 11, optionName1: '화이트', stockQuantity: 7 }],
      optionStandards: [{ id: 21, optionGroupName: '색상' }],
      useStockManagement: true,
    },
  });
});

test('postProcessNaverRegistration uses approved paths, Naver-hosted URLs, exact operation order, and verifies the final product', async () => {
  const { calls, deps, state } = postProcessHarness();

  const result = await postProcessNaverRegistration({ kind: 'db' }, 'C:/repo', 501, deps);

  assert.deepEqual(calls, [
    'approved-main',
    'approved-detail',
    'get:777',
    'r2',
    'naver-upload',
    'images:777',
    'price:777',
    'record',
    'get:777',
  ]);
  assert.deepEqual(state.publishArgs, {
    rootDir: 'C:/repo',
    draftId: 501,
    mainImageLocalUrl: '/generated-ai-images/drafts/501/main/manual/v1.jpg',
    detailImageLocalUrls: [
      '/generated-ai-images/drafts/501/detail/manual/01.jpg',
      '/generated-ai-images/drafts/501/detail/manual/02.jpg',
    ],
  });
  assert.deepEqual(state.naverUploadArgs, {
    mainImageUrl: 'https://r2.example/main.jpg',
    detailImageUrls: ['https://r2.example/detail-1.jpg', 'https://r2.example/detail-2.jpg'],
  });
  assert.equal(state.naverUploadClient, deps.clientImpl);
  assert.equal(state.imagePayload.originProduct.images.representativeImage.url, NAVER_MAIN_URL);
  assert.deepEqual(state.imagePayload.originProduct.images.optionalImages, NAVER_DETAIL_URLS.map((url) => ({ url })));
  assert.doesNotMatch(state.imagePayload.originProduct.detailContent, /r2\.example/);
  assert.deepEqual(state.pricePayload, {
    productSalePrice: { salePrice: 19800 },
    optionInfo: {
      optionCombinations: [{ id: 11, optionName1: '화이트', stockQuantity: 7 }],
      optionStandards: [{ id: 21, optionGroupName: '색상' }],
      useStockManagement: true,
    },
  });
  assert.deepEqual(result, {
    verified: true,
    draftId: 501,
    originProductNo: '777',
    salePrice: 19800,
    representativeImageUrl: NAVER_MAIN_URL,
    detailImageCount: 2,
    registration: { productDraftId: 501, originProductNo: '777', status: 'images_swapped' },
  });
});

test('postProcessNaverRegistration rejects missing approved images before any Naver call or remote mutation', async (t) => {
  for (const scenario of [
    { name: 'main image missing', overrides: { getApprovedMainImpl: async () => null } },
    { name: 'main image path missing', overrides: { getApprovedMainImpl: async () => ({ coupangStoredUrl: '' }) } },
    { name: 'detail set missing', overrides: { getApprovedDetailImpl: async () => null } },
    { name: 'usable detail paths missing', overrides: { getApprovedDetailImpl: async () => ({ images: [{ normalizedStoredUrl: '' }] }) } },
  ]) {
    await t.test(scenario.name, async () => {
      const { calls, deps } = postProcessHarness({ overrides: scenario.overrides });

      await assert.rejects(
        () => postProcessNaverRegistration({ kind: 'db' }, 'C:/repo', 501, deps),
        (error) => error.code === 'IMAGES_NOT_APPROVED',
      );
      assert.equal(calls.some((call) => call.startsWith('get:')), false);
      assert.equal(calls.includes('r2'), false);
      assert.equal(calls.includes('record'), false);
    });
  }
});

test('postProcessNaverRegistration validates identifiers and finite price before loading images', async (t) => {
  for (const options of [
    { originProductNo: '', salePrice: 19800 },
    { originProductNo: '777', salePrice: Number.NaN },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const calls = [];
      await assert.rejects(
        () => postProcessNaverRegistration({}, 'C:/repo', 501, {
          ...options,
          getApprovedMainImpl: async () => { calls.push('approved-main'); },
          getApprovedDetailImpl: async () => { calls.push('approved-detail'); },
        }),
        (error) => error.code === 'NAVER_POST_PROCESS_INVALID_INPUT',
      );
      assert.deepEqual(calls, []);
    });
  }
});

test('postProcessNaverRegistration never records completion when either remote update fails', async (t) => {
  await t.test('image update failure', async () => {
    const failure = Object.assign(new Error('image update failed'), { code: 'NAVER_API_ERROR' });
    const { calls, deps } = postProcessHarness({
      overrides: {
        clientImpl: {
          async getProduct() { calls.push('get'); return liveProduct(); },
          async updateOriginProduct() { calls.push('images'); throw failure; },
          async updateOptionStock() { calls.push('price'); },
        },
      },
    });

    await assert.rejects(
      () => postProcessNaverRegistration({ kind: 'db' }, 'C:/repo', 501, deps),
      (error) => error === failure,
    );
    assert.equal(calls.includes('price'), false);
    assert.equal(calls.includes('record'), false);
  });

  await t.test('price update failure', async () => {
    const failure = Object.assign(new Error('price update failed'), { code: 'NAVER_API_ERROR' });
    const { calls, deps } = postProcessHarness({
      overrides: {
        clientImpl: {
          async getProduct() { calls.push('get'); return liveProduct(); },
          async updateOriginProduct() { calls.push('images'); },
          async updateOptionStock() { calls.push('price'); throw failure; },
        },
      },
    });

    await assert.rejects(
      () => postProcessNaverRegistration({ kind: 'db' }, 'C:/repo', 501, deps),
      (error) => error === failure,
    );
    assert.deepEqual(calls.filter((call) => ['get', 'images', 'price'].includes(call)), ['get', 'images', 'price']);
    assert.equal(calls.includes('record'), false);
  });
});

test('postProcessNaverRegistration reports compact safe final verification mismatches', async (t) => {
  const scenarios = [
    {
      name: 'sale price',
      finalProduct: liveProduct({ salePrice: 19700 }),
      expectedDetails: { salePrice: { expected: 19800, actual: 19700 } },
    },
    {
      name: 'representative image',
      finalProduct: liveProduct({ mainImageUrl: 'https://shop-phinf.pstatic.net/wrong-main.jpg' }),
      expectedDetails: {
        representativeImageUrl: {
          expected: NAVER_MAIN_URL,
          actual: 'https://shop-phinf.pstatic.net/wrong-main.jpg',
        },
      },
    },
    {
      name: 'detail image evidence',
      finalProduct: liveProduct({ detailImageUrls: [NAVER_DETAIL_URLS[0]] }),
      expectedDetails: { detailImageCount: { expectedMinimum: 2, actual: 1 } },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { deps } = postProcessHarness({ finalProduct: scenario.finalProduct });

      await assert.rejects(
        () => postProcessNaverRegistration({ kind: 'db' }, 'C:/repo', 501, deps),
        (error) => {
          assert.equal(error.code, 'NAVER_POST_PROCESS_FAILED');
          assert.deepEqual(error.details, scenario.expectedDetails);
          assert.equal('raw' in error, false);
          assert.equal('body' in error, false);
          return true;
        },
      );
    });
  }
});
