import { ZipArchive } from 'archiver';
import { PassThrough } from 'node:stream';

import { detectImageType } from './image-processing.mjs';
import { DETAIL_PAGE_EXPECTED_COUNT } from './detail-sections.mjs';

const INSTRUCTIONS = `상세페이지 이미지 작업 지침

- 모바일 화면에 맞는 세로형 이미지로 정확히 10장을 만듭니다.
- 03-product-info.json의 sections 순서대로 1번부터 10번까지 빠짐없이 구성합니다.
- 원본 제품의 형태, 색상, 구조를 임의로 변경하지 않습니다.
- 프롬프트를 따르되 사실과 다른 문구나 오해를 부르는 표현을 넣지 않습니다.
- 각 파일의 순서를 유지한 채 완성된 10장을 Automoney에 다시 업로드합니다.
`;

export async function buildDetailPagePackage(context, {
  fetchImpl = globalThis.fetch,
  readLocalAsset,
} = {}) {
  validateContext(context);

  const entries = buildMetadataEntries(context);
  const selectedAliases = new Set();
  const attemptedUrls = new Set();
  let usableImageCount = 0;

  usableImageCount += await appendAssetGroup(entries, [context.mainImage], {
    directory: 'main-image',
    basename: 'source-main-image',
    numbered: false,
    fetchImpl,
    readLocalAsset,
    selectedAliases,
    attemptedUrls,
  });
  usableImageCount += await appendAssetGroup(entries, context.detailImages, {
    directory: 'detail-images',
    basename: 'source-detail',
    numbered: true,
    fetchImpl,
    readLocalAsset,
    selectedAliases,
    attemptedUrls,
  });
  usableImageCount += await appendAssetGroup(entries, context.referenceImages, {
    directory: 'references',
    basename: 'optional-reference',
    numbered: true,
    fetchImpl,
    readLocalAsset,
    selectedAliases,
    attemptedUrls,
  });

  if (usableImageCount === 0) {
    throw packageError(
      'DETAIL_PACKAGE_IMAGES_MISSING',
      'At least one usable source or reference image is required',
    );
  }

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

function buildMetadataEntries(context) {
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
  const info = {
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
    sections,
  };

  return [
    { name: '01-prompt-rendered.txt', data: Buffer.from(request.promptRendered, 'utf8') },
    { name: '02-prompt-original.txt', data: Buffer.from(request.promptOriginal || '', 'utf8') },
    { name: '03-product-info.json', data: Buffer.from(JSON.stringify(info, null, 2), 'utf8') },
    { name: '04-instructions.txt', data: Buffer.from(INSTRUCTIONS, 'utf8') },
  ];
}

async function appendAssetGroup(entries, assets, options) {
  let accepted = 0;
  for (const asset of Array.isArray(assets) ? assets : []) {
    const descriptor = describeAsset(asset);
    if (!descriptor || descriptor.aliases.some((url) => options.selectedAliases.has(url))) continue;

    const loaded = await loadFirstUsableAsset(descriptor.urls, options);
    if (!loaded) continue;

    descriptor.aliases.forEach((url) => options.selectedAliases.add(url));
    options.selectedAliases.add(loaded.url);
    accepted += 1;
    const suffix = options.numbered ? `-${String(accepted).padStart(2, '0')}` : '';
    entries.push({
      name: `${options.directory}/${options.basename}${suffix}.${extension(loaded.mimeType)}`,
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
    if (options.attemptedUrls.has(url)) continue;
    options.attemptedUrls.add(url);
    const loaded = await loadAsset(url, options);
    if (loaded) return { ...loaded, url };
  }
  return null;
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
