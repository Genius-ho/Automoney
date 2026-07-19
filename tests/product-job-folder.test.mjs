import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildAnalysisInputPackage, createProductJobFolder, getJobPaths } from '../src/product-job-folder.mjs';

test('getJobPaths isolates each draft under its own draft-{id} folder', () => {
  const paths = getJobPaths('/data/jobs', 64);
  assert.ok(paths.root.includes(join('data', 'jobs', 'draft-64')));
  assert.ok(paths.inputDir.startsWith(paths.root));
  assert.ok(paths.outputDir.startsWith(paths.root));
  assert.ok(paths.logsDir.startsWith(paths.root));
  assert.ok(paths.detailSlicesDir.startsWith(paths.inputDir));

  const otherDraft = getJobPaths('/data/jobs', 46);
  assert.notEqual(paths.root, otherDraft.root);
});

test('createProductJobFolder never creates or touches another draft\'s folder', async () => {
  const jobDir = await mkdtemp(join(tmpdir(), 'automoney-jobs-'));
  try {
    const pathsA = await createProductJobFolder({ jobDir, draftId: 64 });
    const pathsB = getJobPaths(jobDir, 46);
    await assert.rejects(() => access(pathsB.inputDir), 'draft 46\'s folder must not exist just because draft 64\'s was created');
    await access(pathsA.inputDir); // sanity: draft 64's own folder does exist
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test('createProductJobFolder and buildAnalysisInputPackage work when the job dir path contains spaces (Windows-realistic)', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'automoney root '));
  const jobDir = await mkdtemp(join(tmpdir(), 'automoney jobs '));
  try {
    const publicImagesDir = join(rootDir, 'public', 'generated-images', 'drafts', '999');
    await import('node:fs/promises').then((m) => m.mkdir(publicImagesDir, { recursive: true }));
    await writeFile(join(publicImagesDir, 'slice-001.jpg'), 'fake-image');

    const draftRow = {
      id: 999, supplierProductNo: 'sp-999', rawName: 'raw', cleanedName: 'clean', sellingTitle: 'title',
      optimizedCoupangTitle: null, options: [],
      images: [{ imageType: 'detail_slice', sliceIndex: 1, storedUrl: '/generated-images/drafts/999/slice-001.jpg' }],
    };
    const db = {
      async query(sql) {
        if (sql.includes('supplier_product_id from product_drafts')) return { rows: [{ supplier_product_id: 1 }] };
        if (sql.includes('raw_json from supplier_products')) return { rows: [{ raw_json: {} }] };
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const result = await buildAnalysisInputPackage({ db, rootDir, jobDir, draftId: 999, getProductDraftImpl: async () => draftRow });
    assert.equal(result.detailImagePaths.length, 1);
    await access(result.detailImagePaths[0]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(jobDir, { recursive: true, force: true });
  }
});

test('createProductJobFolder creates all subdirectories and is safe to call twice (re-run)', async () => {
  const jobDir = await mkdtemp(join(tmpdir(), 'automoney-jobs-'));
  try {
    const paths = await createProductJobFolder({ jobDir, draftId: 999 });
    await access(paths.inputDir);
    await access(paths.outputDir);
    await access(paths.logsDir);
    await access(paths.detailSlicesDir);
    await access(paths.originalImagesDir);
    // re-run must not throw
    await createProductJobFolder({ jobDir, draftId: 999 });
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test('buildAnalysisInputPackage writes product.json/raw.json and copies only locally-stored detail_slice images in sliceIndex order', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'automoney-root-'));
  const jobDir = await mkdtemp(join(tmpdir(), 'automoney-jobs-'));
  try {
    const publicImagesDir = join(rootDir, 'public', 'generated-images', 'drafts', '999');
    await import('node:fs/promises').then((m) => m.mkdir(publicImagesDir, { recursive: true }));
    await writeFile(join(publicImagesDir, 'slice-002.jpg'), 'fake-image-2');
    await writeFile(join(publicImagesDir, 'slice-001.jpg'), 'fake-image-1');

    const draftRow = {
      id: 999,
      supplierProductNo: 'sp-999',
      rawName: 'raw name',
      cleanedName: 'clean name',
      sellingTitle: 'selling title',
      optimizedCoupangTitle: null,
      options: [{ name: '색상', value: '그레이' }],
      images: [
        { imageType: 'detail_slice', sliceIndex: 2, storedUrl: '/generated-images/drafts/999/slice-002.jpg' },
        { imageType: 'detail_slice', sliceIndex: 1, storedUrl: '/generated-images/drafts/999/slice-001.jpg' },
        { imageType: 'detail', sliceIndex: null, storedUrl: 'https://remote.example.com/full.jpg' },
        { imageType: 'main', sliceIndex: null, storedUrl: null },
      ],
    };
    const db = {
      async query(sql, params) {
        if (sql.includes('supplier_product_id from product_drafts')) return { rows: [{ supplier_product_id: 1 }] };
        if (sql.includes('raw_json from supplier_products')) return { rows: [{ raw_json: { domeggook: { detail: { size: '0.1' } } } }] };
        throw new Error(`unexpected query in test: ${sql}`);
      },
    };

    const { readFile } = await import('node:fs/promises');
    const result = await buildAnalysisInputPackage({
      db, rootDir, jobDir, draftId: 999,
      getProductDraftImpl: async () => draftRow,
    });

    const product = JSON.parse(await readFile(result.paths.productJsonPath, 'utf8'));
    assert.equal(product.id, 999);
    assert.deepEqual(product.options, [{ name: '색상', value: '그레이' }]);

    const raw = JSON.parse(await readFile(result.paths.rawJsonPath, 'utf8'));
    assert.equal(raw.domeggook.detail.size, '0.1');

    assert.equal(result.detailImagePaths.length, 2);
    assert.ok(result.detailImagePaths[0].endsWith('slice-001.jpg'), 'sliceIndex 1 must come before sliceIndex 2');
    assert.ok(result.detailImagePaths[1].endsWith('slice-002.jpg'));
    assert.equal(result.mainImagePath, null, 'main image with no local storedUrl is skipped, not fabricated');

    await access(result.detailImagePaths[0]);
    await access(result.detailImagePaths[1]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(jobDir, { recursive: true, force: true });
  }
});
