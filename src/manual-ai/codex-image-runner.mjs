import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, resolve } from 'node:path';

import { checkCodexAvailability, checkCodexImageGenerationAvailable, runCodexImagePrompt } from '../codex-client.mjs';
import { createImagePromptRequest, getManualDetailWorkflowContext, getManualMainImageWorkflowContext } from '../admin-store.mjs';
import { buildPackageEntries } from './package-builder.mjs';
import { buildDetailPagePackage } from './detail-package-builder.mjs';
import { detectImageType, createCoupangDerivative, validateManualMainImage } from './image-processing.mjs';
import { persistManualMainImageFiles } from './multipart.mjs';
import { getNextManualMainImageVersion, insertManualMainImage } from './workflow-store.mjs';
import { assertDetailSetAggregate, createDetailRegistrationJpeg, validateDetailSourceImage } from './detail-image-processing.mjs';
import { insertDetailSet, reserveDetailSetVersion } from './detail-workflow-store.mjs';
import { finalizeDetailSetDirectory, removeDetailSetDirectory } from './detail-multipart.mjs';
import { getDetailPageSections } from './detail-sections.mjs';
import { getImageGenerationJobPaths } from '../product-job-folder.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const DETAIL_EXPECTED_COUNT = 10;
const DEFAULT_MAIN_TIMEOUT_MS = 600_000;
// Per-SECTION timeout, not a total -- a real 10-in-one-session run was tried
// first and reliably failed (Windows sandbox errors reading an attached
// image plus malformed image-tool calls after the model had been carrying a
// very long multi-image conversation, confirmed via a real Codex CLI run
// that produced 0 files after 20 minutes). One short single-image session
// per section mirrors the pattern that verified successfully for the main
// image, and a failure in one section no longer costs the other nine.
const DEFAULT_DETAIL_SECTION_TIMEOUT_MS = 240_000;

function runnerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

// Mirrors admin-server's/r2-publisher's own workflow-asset path guard
// (public/ only, no traversal) -- a small private copy rather than an import
// from admin-server.mjs, which is the HTTP entrypoint and must not be
// depended on by library modules.
function readPublicAsset(rootDir, value) {
  const publicRoot = resolve(rootDir, 'public');
  const filePath = resolve(join(publicRoot, String(value).replace(/^\/+/, '')));
  if (!filePath.startsWith(publicRoot)) throw runnerError('DETAIL_PACKAGE_IMAGES_MISSING', 'Forbidden workflow asset');
  return readFile(filePath);
}

// Checks Codex/image-generation availability the same distinguishable way
// the analysis pipeline does (never/not-installed vs not-logged-in vs the
// image_generation feature itself being unavailable), so callers can surface
// the exact right message instead of a generic failure.
async function checkAvailability({ codexConfig, checkCodexAvailabilityImpl = checkCodexAvailability, checkCodexImageGenerationAvailableImpl = checkCodexImageGenerationAvailable }) {
  const codex = await checkCodexAvailabilityImpl({ config: codexConfig });
  if (!codex.available) throw runnerError('CODEX_NOT_AVAILABLE', codex.message);
  if (!codex.loggedIn) throw runnerError('CODEX_LOGIN_REQUIRED', codex.message);
  const imageGeneration = await checkCodexImageGenerationAvailableImpl({ config: codexConfig });
  if (!imageGeneration.available) throw runnerError('IMAGE_GENERATION_UNAVAILABLE', imageGeneration.message);
}

// Flattens the package builder's zip-entry paths (e.g. "sources/main-image/
// source-main-image.jpg") into plain filenames on disk -- Codex doesn't need
// the original directory structure, just real files it can read/attach, and
// flattening avoids ever creating a path outside inputDir from entry names.
async function writeEntriesToDisk(entries, inputDir) {
  await mkdir(inputDir, { recursive: true });
  const written = [];
  for (const entry of entries) {
    const flatName = entry.name.replace(/\//g, '__');
    const path = join(inputDir, flatName);
    await writeFile(path, entry.data);
    written.push({ name: entry.name, flatName, path });
  }
  return written;
}

async function listGeneratedImages(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function buildMainImagePrompt(request) {
  return [
    request.promptRendered,
    '',
    '=== Codex 자동 생성 실행 지침 (자동화 전용, 반드시 지킬 것) ===',
    '- 이 작업 디렉터리 안에서 내장 이미지 생성 도구를 사용해 대표이미지를 만드세요. 외부 API를 호출하지 마세요.',
    '- 정사각형(가로:세로 1:1) 이미지로 생성하세요.',
    '- 이미지 안에 문구, 로고, 워터마크를 넣지 마세요.',
    '- 첨부된 원본 대표이미지를 참고해 원본 제품의 형태와 구조를 왜곡하지 마세요.',
    '- 생성 결과를 정확히 1장만 만들어 이 경로에 저장하세요: generated-main/main.png (다른 경로에 생성했다면 이 경로로 복사하세요)',
  ].join('\n');
}

// One call generates exactly one section's image -- the full 10-section
// prompt-rendered.txt is still reused as shared context every time (so each
// section is generated with the same product understanding a human pasting
// the whole thing into ChatGPT would have), but each turn is scoped to a
// single deliverable so Codex never has to juggle 10 image-tool calls in one
// long session.
function buildDetailSectionPrompt(request, section) {
  return [
    request.promptRendered,
    '',
    '=== Codex 자동 생성 실행 지침 (자동화 전용, 반드시 지킬 것) ===',
    '- 위 상세페이지 프롬프트는 전체 10개 섹션 구성에 대한 설명입니다. 지금 이 실행에서는 아래 한 섹션의 이미지 1장만 생성하세요. 다른 섹션 이미지는 만들지 마세요.',
    `- 대상 섹션: ${section.index}번 "${section.label}" (섹션 키: ${section.key})`,
    '- 이 작업 디렉터리 안에서 내장 이미지 생성 도구를 사용하세요. 외부 API를 호출하지 마세요.',
    '- 세로형(가로:세로 비율 약 0.5~0.85, 예: 1000x1400)으로 생성하세요. 정사각형이나 가로형으로 만들지 마세요.',
    '- 원본 제품의 형태, 색상, 구조, 실제 옵션 구성을 임의로 바꾸거나 없는 사양을 만들어내지 마세요.',
    '- 첨부된 참고 이미지가 있다면 원본 제품 참고 자료입니다.',
    `- 생성 결과를 정확히 1장만 만들어 이 경로에 저장하세요: generated-detail/${String(section.index).padStart(2, '0')}-${section.key}.png (다른 경로에 생성했다면 이 경로로 복사하세요)`,
  ].join('\n');
}

// Step 1-2 (대표이미지): ensures a current main_image prompt exists (same
// createImagePromptRequest call the package-download route already makes),
// runs Codex's own image-generation tool against it, then feeds the
// resulting file through the exact same validate -> derive -> persist ->
// insert pipeline the human "업로드" endpoint uses -- so the result lands as
// an ordinary status='uploaded' row, waiting for the same approve/reject
// buttons, never auto-approved.
export async function generateMainImage(db, rootDir, jobDir, draftId, {
  codexConfig,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_MAIN_TIMEOUT_MS,
  checkCodexAvailabilityImpl,
  checkCodexImageGenerationAvailableImpl,
  runCodexImagePromptImpl = runCodexImagePrompt,
  createImagePromptRequestImpl = createImagePromptRequest,
  getManualMainImageWorkflowContextImpl = getManualMainImageWorkflowContext,
  buildPackageEntriesImpl = buildPackageEntries,
  getNextManualMainImageVersionImpl = getNextManualMainImageVersion,
  insertManualMainImageImpl = insertManualMainImage,
} = {}) {
  await checkAvailability({ codexConfig, checkCodexAvailabilityImpl, checkCodexImageGenerationAvailableImpl });

  await createImagePromptRequestImpl(db, draftId, 'main_image');
  const context = await getManualMainImageWorkflowContextImpl(db, draftId);
  if (!context.request || context.request.state !== 'current') throw runnerError('MAIN_IMAGE_PROMPT_MISSING', 'Main-image prompt is missing or not current');

  const entries = await buildPackageEntriesImpl(context, { fetchImpl });

  const paths = getImageGenerationJobPaths(jobDir, draftId);
  await rm(paths.generatedMainDir, { recursive: true, force: true });
  await mkdir(paths.generatedMainDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  const written = await writeEntriesToDisk(entries, paths.inputDir);
  const sourceImage = written.find((item) => item.name.startsWith('01-source-main-image'));

  const prompt = buildMainImagePrompt(context.request);
  const result = await runCodexImagePromptImpl({
    // loadCodexConfig defaults to sandbox:'read-only' for the (never-writes)
    // analysis pipeline; image generation always needs to save its output
    // into this draft's own job folder, so that default is overridden here
    // regardless of what the caller's codexConfig says -- still confined to
    // `cwd` (this job folder only), never the repo or DB.
    config: { ...codexConfig, sandbox: 'workspace-write' },
    cwd: paths.root,
    images: sourceImage ? [sourceImage.path] : [],
    prompt,
    timeoutMs,
  });
  await writeFile(paths.mainCodexLogPath, result.log || '');

  if (!result.success) {
    if (result.timedOut) throw runnerError('CODEX_TIMEOUT', 'Codex image generation timed out', { log: result.log });
    throw runnerError('CODEX_FAILED', 'Codex image generation failed', { log: result.log });
  }

  const generatedFiles = await listGeneratedImages(paths.generatedMainDir);
  if (generatedFiles.length === 0) throw runnerError('NO_GENERATED_FILES', 'Codex reported success but no image was found in generated-main/', { log: result.log });

  const buffer = await readFile(generatedFiles[generatedFiles.length - 1]);
  const declaredMime = detectImageType(buffer);
  let validated;
  try {
    validated = await validateManualMainImage(buffer, declaredMime);
  } catch (error) {
    throw runnerError('MAIN_IMAGE_VALIDATION_FAILED', `Generated main image failed validation: ${error.message}`, { cause: error.code, log: result.log });
  }
  const derivative = await createCoupangDerivative(buffer);

  const revision = context.request.revision;
  const version = await getNextManualMainImageVersionImpl(db, draftId);
  const stored = await persistManualMainImageFiles({ rootDir, draftId, revision, version, original: { buffer, mimeType: validated.mimeType }, derivative });
  const inserted = await insertManualMainImageImpl(db, {
    productDraftId: draftId,
    promptRequestId: context.request.id,
    promptRevision: revision,
    providerCode: 'custom',
    providerDisplayName: 'Codex CLI (자동 생성)',
    version,
    ...stored,
    originalFileSize: validated.fileSize,
    coupangFileSize: derivative.fileSize,
    originalMimeType: validated.mimeType,
    originalWidth: validated.width,
    originalHeight: validated.height,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    notes: 'Codex CLI 자동 생성 (승인 대기)',
  });

  return { result: inserted, generatedFileCount: generatedFiles.length, log: result.log };
}

// Step 1-3 (상세이미지): same idea for the 10-image detail set. Builds the
// staging directory by hand (imageIndex/path descriptors identical in shape
// to what receiveDetailMultipart produces from an HTTP upload) so the rest
// -- reserveDetailSetVersion / finalizeDetailSetDirectory / insertDetailSet,
// the same functions the manual upload route calls -- runs completely
// unchanged.
export async function generateDetailImageSet(db, rootDir, jobDir, draftId, {
  codexConfig,
  fetchImpl = globalThis.fetch,
  sectionTimeoutMs = DEFAULT_DETAIL_SECTION_TIMEOUT_MS,
  checkCodexAvailabilityImpl,
  checkCodexImageGenerationAvailableImpl,
  runCodexImagePromptImpl = runCodexImagePrompt,
  createImagePromptRequestImpl = createImagePromptRequest,
  getManualDetailWorkflowContextImpl = getManualDetailWorkflowContext,
  buildDetailPagePackageImpl = buildDetailPagePackage,
  reserveDetailSetVersionImpl = reserveDetailSetVersion,
  finalizeDetailSetDirectoryImpl = finalizeDetailSetDirectory,
  removeDetailSetDirectoryImpl = removeDetailSetDirectory,
  insertDetailSetImpl = insertDetailSet,
} = {}) {
  await checkAvailability({ codexConfig, checkCodexAvailabilityImpl, checkCodexImageGenerationAvailableImpl });

  await createImagePromptRequestImpl(db, draftId, 'detail_page');
  const context = await getManualDetailWorkflowContextImpl(db, draftId);
  if (!context.request || context.request.state !== 'current') throw runnerError('DETAIL_PAGE_PROMPT_MISSING', 'Detail-page prompt is missing or not current');

  const packageResult = await buildDetailPagePackageImpl(context, { fetchImpl, readLocalAsset: (value) => readPublicAsset(rootDir, value) });
  const entries = packageResult.entries;

  const paths = getImageGenerationJobPaths(jobDir, draftId);
  // Deliberately NOT wiped before a run (unlike generateMainImage's single
  // file) -- 10 sequential Codex calls is long enough that a real run can be
  // interrupted partway (confirmed live: a background shell timeout killed
  // one mid-run after 5/10 sections). Leaving prior output in place lets the
  // per-section "already exists" check below resume instead of re-spending
  // several more minutes regenerating sections that already succeeded.
  await mkdir(paths.generatedDetailDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  const written = await writeEntriesToDisk(entries, paths.inputDir);
  const mainReference = written.find((item) => item.name === 'main-image' || item.name.startsWith('main-image.'));

  const sections = getDetailPageSections();
  let combinedLog = '';
  for (const section of sections) {
    const alreadyExists = (await listGeneratedImages(paths.generatedDetailDir))
      .some((path) => path.includes(`${String(section.index).padStart(2, '0')}-${section.key}`));
    if (alreadyExists) continue; // a retry of a partially-completed run should not regenerate sections that already succeeded
    const prompt = buildDetailSectionPrompt(context.request, section);
    const sectionResult = await runCodexImagePromptImpl({
      // Same override as generateMainImage -- must write into this job folder.
      config: { ...codexConfig, sandbox: 'workspace-write' },
      cwd: paths.root,
      images: mainReference ? [mainReference.path] : [],
      prompt,
      timeoutMs: sectionTimeoutMs,
    });
    combinedLog += `\n\n=== section ${section.index} (${section.label}) success=${sectionResult.success} timedOut=${Boolean(sectionResult.timedOut)} ===\n${sectionResult.log || ''}`;
  }
  await writeFile(paths.detailCodexLogPath, combinedLog);

  const generatedFiles = await listGeneratedImages(paths.generatedDetailDir);
  if (generatedFiles.length < DETAIL_EXPECTED_COUNT) {
    throw runnerError('DETAIL_IMAGE_COUNT_INSUFFICIENT', `Expected ${DETAIL_EXPECTED_COUNT} generated detail images, found ${generatedFiles.length}`, {
      expectedCount: DETAIL_EXPECTED_COUNT, actualCount: generatedFiles.length, log: combinedLog,
    });
  }

  const chosenFiles = generatedFiles.slice(0, DETAIL_EXPECTED_COUNT);
  const processed = [];
  for (let index = 0; index < chosenFiles.length; index += 1) {
    const imageIndex = index + 1;
    const buffer = await readFile(chosenFiles[index]);
    const declaredMime = detectImageType(buffer);
    let validated;
    try {
      validated = await validateDetailSourceImage(buffer, declaredMime, imageIndex);
    } catch (error) {
      throw runnerError('DETAIL_IMAGE_VALIDATION_FAILED', `Generated detail image ${imageIndex} failed validation: ${error.message}`, { imageIndex, cause: error.code, log: combinedLog });
    }
    const normalized = await createDetailRegistrationJpeg(buffer, imageIndex);
    processed.push({ imageIndex, buffer, validated, normalized });
  }
  assertDetailSetAggregate(processed.map((item) => item.normalized));

  const client = db.connect ? await db.connect() : db;
  let setVersion = null;
  let finalized = false;
  let stagingDir = null;
  try {
    await client.query('BEGIN');
    setVersion = await reserveDetailSetVersionImpl(client, draftId);
    const revision = context.request.revision;

    const detailManualDir = join(resolve(rootDir), 'public', 'generated-ai-images', 'drafts', String(draftId), 'detail', 'manual');
    await mkdir(detailManualDir, { recursive: true });
    stagingDir = await mkdtemp(join(detailManualDir, '.upload-'));

    const rows = [];
    for (const item of processed) {
      const originalExt = item.validated.mimeType === 'image/png' ? 'png' : item.validated.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const stem = `detail-r${revision}-v${setVersion}-${String(item.imageIndex).padStart(2, '0')}`;
      const originalName = `${stem}-original.${originalExt}`;
      const normalizedName = `${stem}-registered.jpg`;
      await writeFile(join(stagingDir, originalName), item.buffer, { flag: 'wx' });
      await writeFile(join(stagingDir, normalizedName), item.normalized.buffer, { flag: 'wx' });
      const relative = `/generated-ai-images/drafts/${draftId}/detail/manual/r${revision}-v${setVersion}`;
      rows.push({
        imageIndex: item.imageIndex,
        originalStoredUrl: `${relative}/${originalName}`,
        normalizedStoredUrl: `${relative}/${normalizedName}`,
        originalWidth: item.validated.width,
        originalHeight: item.validated.height,
        normalizedWidth: item.normalized.width,
        normalizedHeight: item.normalized.height,
        originalFileSize: item.validated.fileSize,
        normalizedFileSize: item.normalized.fileSize,
        originalMimeType: item.validated.mimeType,
        normalizedMimeType: 'image/jpeg',
        jpegQuality: item.normalized.jpegQuality,
        sha256: createHash('sha256').update(item.buffer).digest('hex'),
      });
    }

    await finalizeDetailSetDirectoryImpl({ stagingDir, rootDir, draftId, revision, setVersion });
    finalized = true;

    const inserted = await insertDetailSetImpl(client, {
      productDraftId: draftId,
      promptRequestId: context.request.id,
      promptRevision: revision,
      providerCode: 'custom',
      providerDisplayName: 'Codex CLI (자동 생성)',
      setVersion,
      sections: context.sections,
      images: rows,
      notes: 'Codex CLI 자동 생성 (승인 대기)',
    });
    await client.query('COMMIT');
    return { result: inserted, generatedFileCount: generatedFiles.length, log: combinedLog };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (finalized && setVersion) await removeDetailSetDirectoryImpl({ rootDir, draftId, revision: context.request.revision, setVersion }).catch(() => {});
    else if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}

export const IMAGE_GENERATION_LIMITS = Object.freeze({ detailExpectedCount: DETAIL_EXPECTED_COUNT });
