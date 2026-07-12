import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDetailPagePackage } from '../src/manual-ai/detail-package-builder.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 1, 2, 3,
]);

const SECTIONS = [
  { index: 1, key: 'hero', label: 'Hero' },
  { index: 2, key: 'review', label: '리뷰/평점' },
  { index: 3, key: 'core_values', label: '3가지 핵심가치' },
  { index: 4, key: 'point_01', label: 'Point 01' },
  { index: 5, key: 'point_02', label: 'Point 02' },
  { index: 6, key: 'point_03', label: 'Point 03' },
  { index: 7, key: 'comparison', label: 'Comparison' },
  { index: 8, key: 'detail', label: 'Detail' },
  { index: 9, key: 'color_size', label: 'Color & Size' },
  { index: 10, key: 'product_info', label: 'Product Info' },
];

function detailPackageContext() {
  return {
    draft: {
      id: 64,
      supplierProductNo: 'DRAFT-64',
      supplierMarket: 'domeme',
      rawName: 'Supplier product',
      sellingTitle: 'Draft 64 product',
      cost: 12_000,
      shippingFee: 3_000,
      minOrderQty: 1,
      orderUnit: 1,
      options: [{
        index: 1,
        name: '색상',
        value: '파랑',
        additionalPrice: 500,
        raw: { credential: 'do-not-serialize-option-secret' },
      }],
      aiSecrets: { apiKey: 'do-not-serialize-draft-secret' },
    },
    request: {
      id: 8,
      requestType: 'detail_page',
      revision: 1,
      templateVersion: 1,
      templateHash: '1234567890abcdef',
      promptRendered: 'rendered detail page prompt',
      promptOriginal: 'original detail page prompt',
      state: 'current',
      authorization: 'do-not-serialize-request-secret',
    },
    sections: SECTIONS.map((section) => ({ ...section })),
    mainImage: {
      url: '/original-images/main.jpg',
      storedUrl: '/original-images/main.jpg',
      originalUrl: 'https://supplier.test/main.jpg',
    },
    detailImages: [
      {
        url: 'https://supplier.test/detail-full.webp',
        storedUrl: '/original-images/detail-full.webp',
        originalUrl: 'https://supplier.test/detail-full.webp',
      },
      { url: 'https://supplier.test/detail-full.webp' },
      { url: 'https://supplier.test/detail.png' },
      { url: 'https://supplier.test/detail.png' },
    ],
    originalDetailFull: [{ url: 'https://supplier.test/detail-full.webp', storedUrl: '/original-images/detail-full.webp' }],
    sourceSlices: [
      { url: 'https://supplier.test/detail.png' },
      { url: 'https://supplier.test/detail-full.webp', storedUrl: '/original-images/detail-full.webp' },
    ],
    extractedReferences: {
      heroCandidates: [{ url: 'https://supplier.test/detail.png' }],
      reviewStyleCandidates: [{ url: 'https://supplier.test/detail-full.webp', storedUrl: '/original-images/detail-full.webp' }],
      pointCandidates: [], comparisonCandidates: [], sizeOptionCandidates: [],
    },
    sectionReferenceHints: { hero: ['source-slices/source-slice-01'], review: ['source-slices/source-slice-02'] },
    referenceImages: [
      { url: 'https://supplier.test/detail.png' },
      { url: 'https://reference.test/unavailable.jpg' },
      { url: 'https://reference.test/competitor.jpg' },
    ],
  };
}

function response(buffer, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async arrayBuffer() {
      return buffer;
    },
  };
}

test('detail package snapshots revision one and ten expected sections', async () => {
  const context = detailPackageContext();
  const result = await buildDetailPagePackage(context, {
    readLocalAsset: async (url) => url.endsWith('.webp') ? PNG : JPEG,
    fetchImpl: async (url) => {
      if (url.endsWith('unavailable.jpg')) return response(Buffer.alloc(0), { ok: false, status: 404 });
      return response(url.endsWith('.png') ? PNG : JPEG);
    },
  });

  assert.equal(result.filename, 'draft-64-detail-page-r1.zip');
  assert.ok(result.buffer.subarray(0, 2).equals(Buffer.from('PK')));
  assert.deepEqual(result.entries.slice(0, 4).map((entry) => entry.name), [
    '01-prompt-rendered.txt',
    '02-prompt-original.txt',
    '03-product-info.json',
    '04-instructions.txt',
  ]);
  assert.ok(result.entries.some((entry) => entry.name === 'original-detail-full/source-detail-full-01.png'));
  assert.ok(result.entries.some((entry) => entry.name === 'source-slices/source-slice-01.png'));
  assert.ok(result.entries.some((entry) => entry.name === 'extracted-references/hero-candidates/candidate-01.png'));

  const info = JSON.parse(result.entries.find((entry) => entry.name === '03-product-info.json').data);
  assert.equal(info.draftId, 64);
  assert.equal(info.productName, 'Draft 64 product');
  assert.equal(info.requestId, 8);
  assert.equal(info.expectedImageCount, 10);
  assert.equal(info.promptRevision, 1);
  assert.equal(info.templateVersion, 1);
  assert.equal(info.promptHash, '1234567890abcdef');
  assert.equal(info.workflowMode, 'manual_external_ai');
  assert.deepEqual(info.sections, SECTIONS);
  assert.deepEqual(info.sectionReferenceHints.hero, ['source-slices/source-slice-01']);
  assert.deepEqual(info.sections.map((section) => section.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(info.options, [{
    index: 1,
    name: '색상',
    value: '파랑',
    additionalPrice: 500,
  }]);

  assert.equal(
    result.entries.find((entry) => entry.name === '01-prompt-rendered.txt').data.toString(),
    'rendered detail page prompt',
  );
  assert.equal(
    result.entries.find((entry) => entry.name === '02-prompt-original.txt').data.toString(),
    'original detail page prompt',
  );
  const instructions = result.entries.find((entry) => entry.name === '04-instructions.txt').data.toString();
  assert.match(instructions, /원래 10장 구성/);
  assert.match(instructions, /review\/평점/);
  assert.match(instructions, /source material/);
});

test('detail package prefers local assets, de-duplicates aliases, and skips unavailable optional remotes', async () => {
  const localReads = [];
  const remoteFetches = [];
  const result = await buildDetailPagePackage(detailPackageContext(), {
    readLocalAsset: async (url) => {
      localReads.push(url);
      return url.endsWith('.webp') ? WEBP : JPEG;
    },
    fetchImpl: async (url) => {
      remoteFetches.push(url);
      if (url.endsWith('unavailable.jpg')) return response(Buffer.alloc(0), { ok: false, status: 503 });
      return response(url.endsWith('.png') ? PNG : JPEG);
    },
  });

  assert.deepEqual(localReads, [
    '/original-images/main.jpg',
    '/original-images/detail-full.webp',
  ]);
  assert.deepEqual(remoteFetches, ['https://supplier.test/detail.png']);
  assert.deepEqual(result.entries.slice(4).map((entry) => entry.name), [
    'main-image/source-main-image.jpg',
    'original-detail-full/source-detail-full-01.webp',
    'source-slices/source-slice-01.png',
    'source-slices/source-slice-02.webp',
    'extracted-references/hero-candidates/candidate-01.png',
    'extracted-references/review-style-candidates/candidate-01.webp',
  ]);
});

test('detail package requires a current rendered prompt and at least one usable image', async () => {
  const context = detailPackageContext();
  const options = {
    readLocalAsset: async () => {
      throw new Error('missing local file');
    },
    fetchImpl: async () => response(Buffer.alloc(0), { ok: false, status: 404 }),
  };

  await assert.rejects(
    () => buildDetailPagePackage({ ...context, request: null }, options),
    { code: 'DETAIL_PAGE_PROMPT_MISSING' },
  );
  await assert.rejects(
    () => buildDetailPagePackage({ ...context, request: { ...context.request, state: 'stale_template_version' } }, options),
    { code: 'DETAIL_PAGE_PROMPT_STALE' },
  );
  await assert.rejects(
    () => buildDetailPagePackage({ ...context, request: { ...context.request, promptRendered: '' } }, options),
    { code: 'DETAIL_PAGE_PROMPT_INVALID' },
  );
  await assert.rejects(
    () => buildDetailPagePackage(context, options),
    { code: 'DETAIL_PACKAGE_IMAGES_MISSING' },
  );
});

test('detail package has no credential dependency and excludes secret-bearing context fields', async () => {
  const forbiddenOption = () => {
    throw new Error('credential option must not be read');
  };
  const options = {
    fetchImpl: async () => response(PNG),
    get aiSecrets() { return forbiddenOption(); },
    get credentials() { return forbiddenOption(); },
    get apiKey() { return forbiddenOption(); },
  };
  const context = {
    ...detailPackageContext(),
    mainImage: null,
    detailImages: [{ url: 'https://supplier.test/detail.png' }],
    referenceImages: [],
  };

  const result = await buildDetailPagePackage(context, options);
  const serializedEntries = Buffer.concat(result.entries.map((entry) => entry.data)).toString('utf8');
  assert.doesNotMatch(serializedEntries, /do-not-serialize/);
  assert.doesNotMatch(serializedEntries, /apiKey|authorization|credential/i);
});
