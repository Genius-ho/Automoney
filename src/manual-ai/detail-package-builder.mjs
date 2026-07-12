import { ZipArchive } from 'archiver';
import { PassThrough } from 'node:stream';

import { detectImageType } from './image-processing.mjs';
import { DETAIL_PAGE_EXPECTED_COUNT } from './detail-sections.mjs';

const REFERENCE_IMAGE_COUNT = 7;

const DETAIL_INSTRUCTIONS = `상세페이지 이미지 작업 지침
- prompt-rendered.txt의 원래 10장 구성과 순서를 그대로 유지합니다.
- source material에서 필요한 제품 단독컷, 사용 장면, 구조·재질·사이즈·옵션 정보를 골라 재구성합니다.
- 제품의 형태, 색상, 구조, 재질, 실제 옵션과 구성품을 변경하거나 임의로 추가하지 않습니다.
- review/평점 섹션은 사실 단정형 수치·과장 광고보다 리뷰 연출용 시각 요소와 만족 포인트형 구성을 우선합니다.
- 정보가 부족한 섹션은 source material 안에서 가장 유사한 정보를 조합하며, 사실처럼 새로운 사양을 만들지 않습니다.
- sources 폴더는 참고용 원본 자료입니다. 원본 상세페이지의 문구나 디자인을 복제하지 마세요.
- 1번부터 10번까지 순서대로 생성한 결과 10장을 Automoney에 다시 업로드합니다.
`;

export async function buildDetailPagePackage(context, {
  fetchImpl = globalThis.fetch,
  readLocalAsset,
} = {}) {
  validateContext(context);

  const attemptedUrls = new Set();
  const loadedByAlias = new Map();
  const loaderOptions = { fetchImpl, readLocalAsset, attemptedUrls, loadedByAlias };

  const rootEntries = [
    { name: 'prompt-rendered.txt', data: Buffer.from(context.request.promptRendered, 'utf8') },
  ];
  const usedAliases = new Set();
  let usableImageCount = 0;

  usableImageCount += await appendAssetGroup(rootEntries, [context.mainImage], {
    directory: null,
    basename: 'main-image',
    numbered: false,
    selectedAliases: usedAliases,
    ...loaderOptions,
  });

  const referencePool = buildReferencePool(context, usedAliases);
  usableImageCount += await appendAssetGroup(rootEntries, referencePool, {
    directory: null,
    basename: 'reference',
    numbered: true,
    maxCount: REFERENCE_IMAGE_COUNT,
    selectedAliases: usedAliases,
    ...loaderOptions,
  });

  if (usableImageCount === 0) {
    throw packageError(
      'DETAIL_PACKAGE_IMAGES_MISSING',
      'At least one usable source or reference image is required',
    );
  }

  const sourceEntries = await buildSourceEntries(context, loaderOptions);
  const entries = [...rootEntries, ...sourceEntries];

  const buffer = await createArchive(entries);
  return {
    filename: `draft-${context.draft.id}-detail-page-r${context.request.revision || 1}.zip`,
    buffer,
    entries,
  };
}

function validateContext(context) {
  if (!context?.draft) throw packageError('DRAFT_NOT_FOUND', 'Product draft not found');
  if (!context.request) {
    throw packageError('DETAIL_PAGE_PROMPT_MISSING', 'Detail-page prompt does not exist');
  }
  if (context.request.state !== 'current') {
    throw packageError('DETAIL_PAGE_PROMPT_STALE', 'Detail-page prompt is not current');
  }
  if (!String(context.request.promptRendered || '').trim()) {
    throw packageError('DETAIL_PAGE_PROMPT_INVALID', 'Rendered detail-page prompt is required');
  }
}

function buildReferencePool(context, usedAliases) {
  const slices = Array.isArray(context.sourceSlices) ? context.sourceSlices : [];
  const regularDetail = (Array.isArray(context.detailImages) ? context.detailImages : [])
    .filter((image) => image?.imageType === 'detail');
  const pool = slices.length > 0 ? slices : regularDetail;
  const deduped = dedupeByAlias(pool, usedAliases);
  return sampleEvenly(deduped, REFERENCE_IMAGE_COUNT);
}

function dedupeByAlias(assets, seed = new Set()) {
  const seen = new Set(seed);
  const result = [];
  for (const asset of assets) {
    const descriptor = describeAsset(asset);
    if (!descriptor || descriptor.aliases.some((url) => seen.has(url))) continue;
    descriptor.aliases.forEach((url) => seen.add(url));
    result.push(asset);
  }
  return result;
}

function sampleEvenly(items, count) {
  if (items.length <= count) return items.slice();
  const used = new Set();
  const indices = [];
  for (let i = 0; i < count; i += 1) {
    let index = Math.round((i * (items.length - 1)) / (count - 1));
    while (used.has(index) && index < items.length - 1) index += 1;
    used.add(index);
    indices.push(index);
  }
  return indices.sort((a, b) => a - b).map((index) => items[index]);
}

async function buildSourceEntries(context, loaderOptions) {
  const entries = [
    { name: 'sources/prompt-original.txt', data: Buffer.from(context.request.promptOriginal || '', 'utf8') },
    { name: 'sources/product-info.json', data: Buffer.from(JSON.stringify(buildProductInfo(context), null, 2), 'utf8') },
    { name: 'sources/instructions.txt', data: Buffer.from(DETAIL_INSTRUCTIONS, 'utf8') },
  ];

  const provenanceAliases = new Set();
  await appendAssetGroup(entries, [context.rawMainImage || context.mainImage], {
    directory: 'sources/main-image',
    basename: 'source-main-image',
    numbered: false,
    selectedAliases: provenanceAliases,
    ...loaderOptions,
  });
  await appendAssetGroup(entries, context.originalDetailFull || [], {
    directory: 'sources/original-detail-full',
    basename: 'source-detail-full',
    numbered: true,
    selectedAliases: provenanceAliases,
    ...loaderOptions,
  });
  await appendAssetGroup(entries, context.sourceSlices || [], {
    directory: 'sources/source-slices',
    basename: 'source-slice',
    numbered: true,
    selectedAliases: provenanceAliases,
    allowAliasedAssets: true,
    ...loaderOptions,
  });
  for (const [directory, assets] of Object.entries(referenceGroups(context))) {
    await appendAssetGroup(entries, assets, {
      directory: `sources/extracted-references/${directory}`,
      basename: 'candidate',
      numbered: true,
      selectedAliases: new Set(),
      ...loaderOptions,
    });
  }

  return entries;
}

function buildProductInfo(context) {
  const { draft, request } = context;
  const sections = (Array.isArray(context.sections) ? context.sections : []).map((section) => ({
    index: Number(section.index),
    key: String(section.key || ''),
    label: String(section.label || ''),
  }));
  const options = (Array.isArray(draft.options) ? draft.options : []).map((option) => ({
    index: option.index == null ? null : Number(option.index),
    name: String(option.name || ''),
    value: String(option.value || ''),
    additionalPrice: option.additionalPrice == null ? null : Number(option.additionalPrice),
  }));
  const productName = draft.sellingTitle || draft.rawName || '';
  return {
    draftId: Number(draft.id),
    productName,
    product: {
      supplierProductNo: draft.supplierProductNo ?? null,
      supplierMarket: draft.supplierMarket ?? null,
      rawName: draft.rawName || '',
      sellingTitle: productName,
      cost: draft.cost ?? null,
      shippingFee: draft.shippingFee ?? null,
      minOrderQty: draft.minOrderQty ?? null,
      orderUnit: draft.orderUnit ?? null,
    },
    options,
    requestId: Number(request.id),
    promptRevision: Number(request.revision || 1),
    templateVersion: request.templateVersion ?? null,
    promptHash: request.templateHash || '',
    workflowMode: 'manual_external_ai',
    expectedImageCount: DETAIL_PAGE_EXPECTED_COUNT,
    referenceImageCount: REFERENCE_IMAGE_COUNT,
    sections,
    sectionReferenceHints: context.sectionReferenceHints || {},
  };
}

async function appendAssetGroup(entries, assets, options) {
  let accepted = 0;
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (options.maxCount && accepted >= options.maxCount) break;
    const descriptor = describeAsset(asset);
    if (!descriptor || (!options.allowAliasedAssets && descriptor.aliases.some((url) => options.selectedAliases.has(url)))) continue;

    const loaded = await loadFirstUsableAsset(descriptor.urls, options);
    if (!loaded) continue;

    descriptor.aliases.forEach((url) => options.selectedAliases.add(url));
    options.selectedAliases.add(loaded.url);
    descriptor.aliases.forEach((url) => options.loadedByAlias?.set(url, loaded));
    options.loadedByAlias?.set(loaded.url, loaded);
    accepted += 1;
    const suffix = options.numbered ? `-${String(accepted).padStart(2, '0')}` : '';
    const prefix = options.directory ? `${options.directory}/` : '';
    entries.push({
      name: `${prefix}${options.basename}${suffix}.${extension(loaded.mimeType)}`,
      data: loaded.buffer,
    });
  }
  return accepted;
}

function describeAsset(asset) {
  if (!asset) return null;
  const value = typeof asset === 'string' ? { url: asset } : asset;
  const aliases = uniqueStrings([value.storedUrl, value.url, value.originalUrl]);
  if (aliases.length === 0) return null;
  return {
    aliases,
    urls: [...aliases.filter(isLocalUrl), ...aliases.filter((url) => !isLocalUrl(url))],
  };
}

async function loadFirstUsableAsset(urls, options) {
  for (const url of urls) {
    const cached = options.loadedByAlias?.get(url);
    if (cached) return { ...cached, url };
    if (options.attemptedUrls.has(url)) continue;
    options.attemptedUrls.add(url);
    const loaded = await loadAsset(url, options);
    if (loaded) return { ...loaded, url };
  }
  return null;
}

function referenceGroups(context) {
  const references = context.extractedReferences || {};
  return {
    'hero-candidates': references.heroCandidates || [],
    'review-style-candidates': references.reviewStyleCandidates || [],
    'point-candidates': references.pointCandidates || [],
    'comparison-candidates': references.comparisonCandidates || [],
    'size-option-candidates': references.sizeOptionCandidates || [],
  };
}

async function loadAsset(url, { fetchImpl, readLocalAsset }) {
  try {
    let buffer;
    if (isLocalUrl(url) && typeof readLocalAsset === 'function') {
      buffer = toBuffer(await readLocalAsset(url));
    } else {
      if (typeof fetchImpl !== 'function') return null;
      const response = await fetchImpl(url);
      if (!response?.ok || typeof response.arrayBuffer !== 'function') return null;
      buffer = Buffer.from(await response.arrayBuffer());
    }
    const mimeType = detectImageType(buffer);
    return mimeType ? { buffer, mimeType } : null;
  } catch {
    return null;
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Buffer.isBuffer(value?.buffer)) return value.buffer;
  if (Buffer.isBuffer(value?.data)) return value.data;
  throw new TypeError('Local asset reader must return image bytes');
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function isLocalUrl(url) {
  return url.startsWith('/') && !url.startsWith('//');
}

function extension(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

async function createArchive(entries) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    output.on('data', (chunk) => chunks.push(chunk));
    output.on('end', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });

  archive.pipe(output);
  for (const entry of entries) archive.append(entry.data, { name: entry.name });
  await archive.finalize();
  await completed;
  return Buffer.concat(chunks);
}

function packageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
