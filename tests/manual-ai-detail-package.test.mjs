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

function sliceAssets(count) {
  return Array.from({ length: count }, (_, offset) => ({
    url: `https://supplier.test/slice-${String(offset + 1).padStart(2, '0')}.png`,
  }));
}

function detailPackageContext({ sliceCount = 10, mainImage, rawMainImage } = {}) {
  const resolvedMainImage = mainImage !== undefined ? mainImage : {
    url: '/original-images/main.jpg',
    storedUrl: '/original-images/main.jpg',
    originalUrl: 'https://supplier.test/main.jpg',
  };
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
    mainImage: resolvedMainImage,
    rawMainImage: rawMainImage !== undefined ? rawMainImage : resolvedMainImage,
    detailImages: [],
    originalDetailFull: [{ url: 'https://supplier.test/detail-full.webp', storedUrl: '/original-images/detail-full.webp' }],
    sourceSlices: sliceAssets(sliceCount),
    extractedReferences: {
      heroCandidates: [{ url: 'https://supplier.test/hero-candidate.png' }],
      reviewStyleCandidates: [{ url: 'https://supplier.test/detail-full.webp', storedUrl: '/original-images/detail-full.webp' }],
      pointCandidates: [], comparisonCandidates: [], sizeOptionCandidates: [],
    },
    sectionReferenceHints: { hero: ['source-slices/source-slice-01'], review: ['source-slices/source-slice-02'] },
    referenceImages: [],
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

function trackedLoaders() {
  const localReads = [];
  const remoteFetches = [];
  const readLocalAsset = async (url) => {
    localReads.push(url);
    return url.endsWith('.webp') ? WEBP : PNG;
  };
  const fetchImpl = async (url) => {
    remoteFetches.push(url);
    if (url.endsWith('unavailable.jpg')) return response(Buffer.alloc(0), { ok: false, status: 404 });
    return response(url.endsWith('.png') ? PNG : JPEG);
  };
  return { localReads, remoteFetches, readLocalAsset, fetchImpl };
}

test('the download attaches only the prompt, one main image, and seven auto-selected references at the zip root', async () => {
  const context = detailPackageContext({ sliceCount: 10 });
  const { readLocalAsset, fetchImpl, remoteFetches } = trackedLoaders();
  const result = await buildDetailPagePackage(context, { readLocalAsset, fetchImpl });

  assert.equal(result.filename, 'draft-64-detail-page-r1.zip');
  assert.ok(result.buffer.subarray(0, 2).equals(Buffer.from('PK')));

  const rootEntries = result.entries.filter((entry) => !entry.name.startsWith('sources/'));
  assert.deepEqual(rootEntries.map((entry) => entry.name), [
    'prompt-rendered.txt',
    'main-image.png',
    'reference-01.png',
    'reference-02.png',
    'reference-03.png',
    'reference-04.png',
    'reference-05.png',
    'reference-06.png',
    'reference-07.png',
  ]);
  assert.equal(rootEntries.length, 9, 'only the files the user attaches live at the zip root');

  // Ten slices evenly sampled down to seven: indices 1,3,4,6,7,9,10 are picked first (root
  // references), the remaining 2,5,8 are only fetched afterward while dumping full provenance.
  assert.deepEqual(remoteFetches.slice(0, 10), [
    'https://supplier.test/slice-01.png',
    'https://supplier.test/slice-03.png',
    'https://supplier.test/slice-04.png',
    'https://supplier.test/slice-06.png',
    'https://supplier.test/slice-07.png',
    'https://supplier.test/slice-09.png',
    'https://supplier.test/slice-10.png',
    'https://supplier.test/slice-02.png',
    'https://supplier.test/slice-05.png',
    'https://supplier.test/slice-08.png',
  ]);
});

test('everything the user never needs to open is filed under sources/', async () => {
  const context = detailPackageContext({ sliceCount: 10 });
  const { readLocalAsset, fetchImpl } = trackedLoaders();
  const result = await buildDetailPagePackage(context, { readLocalAsset, fetchImpl });

  const sourceNames = result.entries.filter((entry) => entry.name.startsWith('sources/')).map((entry) => entry.name);
  assert.ok(sourceNames.includes('sources/prompt-original.txt'));
  assert.ok(sourceNames.includes('sources/product-info.json'));
  assert.ok(sourceNames.includes('sources/instructions.txt'));
  assert.ok(sourceNames.includes('sources/main-image/source-main-image.png'));
  assert.ok(sourceNames.includes('sources/original-detail-full/source-detail-full-01.webp'));
  assert.ok(sourceNames.includes('sources/extracted-references/hero-candidates/candidate-01.png'));

  const allTenSlices = Array.from({ length: 10 }, (_, i) => `sources/source-slices/source-slice-${String(i + 1).padStart(2, '0')}.png`);
  for (const name of allTenSlices) assert.ok(sourceNames.includes(name), `missing ${name}`);

  const info = JSON.parse(result.entries.find((entry) => entry.name === 'sources/product-info.json').data);
  assert.equal(info.draftId, 64);
  assert.equal(info.productName, 'Draft 64 product');
  assert.equal(info.requestId, 8);
  assert.equal(info.expectedImageCount, 10);
  assert.equal(info.referenceImageCount, 7);
  assert.equal(info.promptRevision, 1);
  assert.equal(info.templateVersion, 1);
  assert.equal(info.promptHash, '1234567890abcdef');
  assert.equal(info.workflowMode, 'manual_external_ai');
  assert.deepEqual(info.sections, SECTIONS);
  assert.deepEqual(info.sectionReferenceHints.hero, ['source-slices/source-slice-01']);
  assert.deepEqual(info.options, [{ index: 1, name: '색상', value: '파랑', additionalPrice: 500 }]);

  assert.equal(
    result.entries.find((entry) => entry.name === 'prompt-rendered.txt').data.toString(),
    'rendered detail page prompt',
  );
  assert.equal(
    result.entries.find((entry) => entry.name === 'sources/prompt-original.txt').data.toString(),
    'original detail page prompt',
  );
  const instructions = result.entries.find((entry) => entry.name === 'sources/instructions.txt').data.toString();
  assert.match(instructions, /review\/평점/);
  assert.match(instructions, /source material/);
});

test('fewer than seven candidate images are all attached without padding or failure', async () => {
  const context = detailPackageContext({ sliceCount: 3 });
  const { readLocalAsset, fetchImpl } = trackedLoaders();
  const result = await buildDetailPagePackage(context, { readLocalAsset, fetchImpl });

  const rootReferenceNames = result.entries
    .filter((entry) => !entry.name.startsWith('sources/') && entry.name.startsWith('reference-'))
    .map((entry) => entry.name);
  assert.deepEqual(rootReferenceNames, ['reference-01.png', 'reference-02.png', 'reference-03.png']);
});

test('slices cut from the same long source image are not treated as duplicates of each other', async () => {
  // Real sliced detail images all share one parentImageId and therefore one
  // originalUrl (the pre-slice long image), while storedUrl/url uniquely
  // identify each individual slice. Dedup must key off storedUrl/url, not
  // originalUrl, or every slice after the first looks like a repeat.
  const context = detailPackageContext({ sliceCount: 0 });
  context.sourceSlices = Array.from({ length: 10 }, (_, offset) => ({
    url: `/generated-images/drafts/46/detail-3190-slice-${String(offset + 1).padStart(3, '0')}.jpg`,
    storedUrl: `/generated-images/drafts/46/detail-3190-slice-${String(offset + 1).padStart(3, '0')}.jpg`,
    originalUrl: 'https://supplier.test/long-source-image.jpg',
  }));
  const { readLocalAsset, fetchImpl, localReads } = trackedLoaders();
  const result = await buildDetailPagePackage(context, { readLocalAsset, fetchImpl });

  const rootReferenceNames = result.entries
    .filter((entry) => !entry.name.startsWith('sources/') && entry.name.startsWith('reference-'))
    .map((entry) => entry.name);
  assert.equal(rootReferenceNames.length, 7, 'seven distinct slices should be sampled, not just the first one');
  assert.equal(new Set(localReads).size, localReads.length, 'each slice is read once, not skipped as a duplicate');
});

test('an approved representative image is used at the root while the raw original is kept under sources/', async () => {
  const approved = { url: '/generated-ai-images/drafts/64/main/manual/r1-v2/detail-r1-v2-01-registered.jpg', storedUrl: '/generated-ai-images/drafts/64/main/manual/r1-v2/detail-r1-v2-01-registered.jpg' };
  const raw = { url: '/original-images/main.jpg', storedUrl: '/original-images/main.jpg' };
  const context = detailPackageContext({ sliceCount: 1, mainImage: approved, rawMainImage: raw });
  context.originalDetailFull = [];
  context.extractedReferences = { heroCandidates: [], reviewStyleCandidates: [], pointCandidates: [], comparisonCandidates: [], sizeOptionCandidates: [] };
  const localReads = [];
  const readLocalAsset = async (url) => {
    localReads.push(url);
    return JPEG;
  };
  const fetchImpl = async (url) => response(url.endsWith('.png') ? PNG : JPEG);
  const result = await buildDetailPagePackage(context, { readLocalAsset, fetchImpl });

  assert.ok(result.entries.some((entry) => entry.name === 'main-image.jpg'));
  assert.ok(result.entries.some((entry) => entry.name === 'sources/main-image/source-main-image.jpg'));
  assert.deepEqual(localReads, [approved.storedUrl, raw.storedUrl]);
});

test('detail package requires a current rendered prompt and at least one usable image', async () => {
  const context = detailPackageContext({ sliceCount: 0 });
  context.originalDetailFull = [];
  context.extractedReferences = { heroCandidates: [], reviewStyleCandidates: [], pointCandidates: [], comparisonCandidates: [], sizeOptionCandidates: [] };
  context.mainImage = null;
  context.rawMainImage = null;
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
    ...detailPackageContext({ sliceCount: 0 }),
    mainImage: null,
    rawMainImage: null,
    sourceSlices: [],
    detailImages: [{ url: 'https://supplier.test/detail.png', imageType: 'detail' }],
    originalDetailFull: [],
    extractedReferences: { heroCandidates: [], reviewStyleCandidates: [], pointCandidates: [], comparisonCandidates: [], sizeOptionCandidates: [] },
    referenceImages: [],
  };

  const result = await buildDetailPagePackage(context, options);
  const serializedEntries = Buffer.concat(result.entries.map((entry) => entry.data)).toString('utf8');
  assert.doesNotMatch(serializedEntries, /do-not-serialize/);
  assert.doesNotMatch(serializedEntries, /apiKey|authorization|credential/i);
});
