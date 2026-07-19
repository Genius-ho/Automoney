import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { getProductDraft } from './admin-store.mjs';

// All paths built with path.join/path.resolve only, per spec section 9 --
// no "\\"/"/" literal joining, so the same code works on Windows and Linux.
export function getJobPaths(jobDir, draftId) {
  const root = resolve(jobDir, `draft-${draftId}`);
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  const logsDir = join(root, 'logs');
  return {
    root,
    inputDir,
    outputDir,
    logsDir,
    originalImagesDir: join(inputDir, 'original-images'),
    detailSlicesDir: join(inputDir, 'detail-slices'),
    productJsonPath: join(inputDir, 'product.json'),
    rawJsonPath: join(inputDir, 'raw.json'),
    codexAnalysisPath: join(outputDir, 'codex-analysis.json'),
    codexLogPath: join(logsDir, 'codex.log'),
  };
}

// Each draft gets its own isolated folder tree; nothing here ever touches
// another draft's files (spec section 3: "다른 상품 파일 접근 금지").
export async function createProductJobFolder({ jobDir, draftId }) {
  const paths = getJobPaths(jobDir, draftId);
  await mkdir(paths.originalImagesDir, { recursive: true });
  await mkdir(paths.detailSlicesDir, { recursive: true });
  await mkdir(paths.outputDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  return paths;
}

// Gathers exactly what Codex is allowed to see for one draft: the
// structured product summary, the supplier's raw_json, and the *original*
// supplier detail-page images (not this app's own AI-generated marketing
// images, which don't carry the supplier's spec-panel text/graphics).
// Re-runnable: overwrites the same job folder each time (spec: "작업 재실행
// 가능").
export async function buildAnalysisInputPackage({ db, rootDir, jobDir, draftId, getProductDraftImpl = getProductDraft }) {
  const draft = await getProductDraftImpl(db, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);

  const draftRow = (await db.query('select supplier_product_id from product_drafts where id = $1', [draftId])).rows[0];
  const supplierProduct = (await db.query('select raw_json from supplier_products where id = $1', [draftRow.supplier_product_id])).rows[0];

  const paths = await createProductJobFolder({ jobDir, draftId });

  const productSummary = {
    id: draft.id,
    supplierProductNo: draft.supplierProductNo,
    rawName: draft.rawName,
    cleanedName: draft.cleanedName,
    sellingTitle: draft.sellingTitle,
    optimizedCoupangTitle: draft.optimizedCoupangTitle,
    options: (draft.options || []).map((option) => ({ name: option.name, value: option.value })),
  };
  await writeFile(paths.productJsonPath, JSON.stringify(productSummary, null, 2));
  await writeFile(paths.rawJsonPath, JSON.stringify(supplierProduct.raw_json, null, 2));

  const publicRoot = resolve(rootDir, 'public');
  const localImagePath = (storedUrl) => {
    if (!storedUrl || !storedUrl.startsWith('/')) return null; // remote-only URL, not yet mirrored locally -- out of scope for stage 1
    return resolve(join(publicRoot, storedUrl.replace(/^\/+/, '')));
  };

  const detailSliceImages = (draft.images || [])
    .filter((image) => image.imageType === 'detail_slice')
    .sort((a, b) => (a.sliceIndex ?? 0) - (b.sliceIndex ?? 0));

  const detailImagePaths = [];
  for (const image of detailSliceImages) {
    const source = localImagePath(image.storedUrl);
    if (!source) continue;
    const dest = join(paths.detailSlicesDir, basename(source));
    await copyFile(source, dest);
    detailImagePaths.push(dest);
  }

  const mainImage = (draft.images || []).find((image) => image.imageType === 'main');
  let mainImagePath = null;
  const mainSource = mainImage ? localImagePath(mainImage.storedUrl) : null;
  if (mainSource) {
    mainImagePath = join(paths.originalImagesDir, basename(mainSource));
    await copyFile(mainSource, mainImagePath);
  }

  return { paths, draft, productSummary, detailImagePaths, mainImagePath };
}
