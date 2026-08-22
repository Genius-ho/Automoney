import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sliceLongDetailImagesForDraft } from '../src/image-slicer.mjs';

function fakeSharp({ width, height }) {
  return () => ({
    async metadata() { return { width, height }; },
    extract() { return this; },
    jpeg() { return this; },
    async toFile() {},
  });
}

// sliceLongDetailImagesForDraft loads sharp once per draft and calls
// sharp(buffer) at least once per image (twice for the direct-copy path:
// once for metadata, once to re-encode) -- so a test simulating several
// differently-sized images must key metadata off which image's buffer is
// being read, not off a global call counter. fakeFetchByUrl tags each
// buffer's first byte with an index; fakeSharpByTag reads that byte back.
function fakeFetchByUrl(sizeByUrl) {
  const urls = Object.keys(sizeByUrl);
  return async (url) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async arrayBuffer() { return new Uint8Array([urls.indexOf(url)]).buffer; },
  });
}
function fakeSharpByTag(sizeByUrl) {
  const sizes = Object.values(sizeByUrl);
  return () => (buffer) => {
    const { width, height } = sizes[new Uint8Array(buffer)[0]];
    return {
      async metadata() { return { width, height }; },
      extract() { return this; },
      jpeg() { return this; },
      async toFile() {},
    };
  };
}

function fakeFetch(ok = true) {
  return async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Server Error',
    async arrayBuffer() { return new ArrayBuffer(8); },
  });
}

function fakeDb(rows) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('from product_images') && sql.includes('image_type in (')) return { rows };
      if (sql.includes('next_index')) return { rows: [{ next_index: 5 }] };
      return { rows: [] };
    },
  };
}

test('sliceLongDetailImagesForDraft copies a normal-sized detail image through as its own single detail_slice (several-separate-photos format)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  const db = fakeDb([{ id: 1, product_draft_id: 27, supplier_product_no: '1', image_index: 0, url: 'https://example.test/a.jpg', original_url: null, stored_url: null, image_type: 'detail' }]);

  const result = await sliceLongDetailImagesForDraft(db, 27, {
    rootDir: root,
    fetchImpl: fakeFetch(),
    loadSharpImpl: async () => fakeSharp({ width: 800, height: 1200 }),
  });

  assert.equal(result.checked, 1);
  assert.equal(result.longImages, 0);
  assert.equal(result.generatedSlices, 0);
  assert.equal(result.directSlices, 1);
  assert.equal(result.failed, 0);
  assert.ok(!db.queries.some((q) => q.sql.includes("image_type = 'detail_full'")));
  const insert = db.queries.find((q) => q.sql.includes('insert into product_images'));
  assert.ok(insert.params.includes('/generated-images/drafts/27/detail-1-slice-001.jpg'));
  assert.ok(insert.sql.includes("'direct_copy'"));
});

test('sliceLongDetailImagesForDraft marks a long image detail_full and inserts detail_slice rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  const db = fakeDb([{ id: 1, product_draft_id: 27, supplier_product_no: '1', image_index: 0, url: 'https://example.test/a.jpg', original_url: 'https://example.test/a-original.jpg', stored_url: null, image_type: 'detail' }]);

  const result = await sliceLongDetailImagesForDraft(db, 27, {
    rootDir: root,
    fetchImpl: fakeFetch(),
    loadSharpImpl: async () => fakeSharp({ width: 800, height: 5000 }),
  });

  assert.equal(result.longImages, 1);
  assert.ok(result.generatedSlices >= 3); // 5000px at 1600px slices with 50px overlap
  const inserts = db.queries.filter((q) => q.sql.includes("insert into product_images"));
  assert.equal(inserts.length, result.generatedSlices);
  assert.ok(inserts[0].params.includes('/generated-images/drafts/27/detail-1-slice-001.jpg'));
  assert.ok(db.queries.some((q) => q.sql.includes("image_type = 'detail_full'")));
});

test('sliceLongDetailImagesForDraft handles a mix of several normal photos and one long scrolling image in the same draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  const db = fakeDb([
    { id: 1, product_draft_id: 27, supplier_product_no: '1', image_index: 0, url: 'https://example.test/a.jpg', original_url: null, stored_url: null, image_type: 'detail' },
    { id: 2, product_draft_id: 27, supplier_product_no: '1', image_index: 1, url: 'https://example.test/b.jpg', original_url: null, stored_url: null, image_type: 'detail' },
    { id: 3, product_draft_id: 27, supplier_product_no: '1', image_index: 2, url: 'https://example.test/c.jpg', original_url: null, stored_url: null, image_type: 'detail' },
  ]);
  const sizeByUrl = {
    'https://example.test/a.jpg': { width: 800, height: 1200 },
    'https://example.test/b.jpg': { width: 800, height: 1300 },
    'https://example.test/c.jpg': { width: 800, height: 5000 },
  };
  const result = await sliceLongDetailImagesForDraft(db, 27, {
    rootDir: root,
    fetchImpl: fakeFetchByUrl(sizeByUrl),
    loadSharpImpl: fakeSharpByTag(sizeByUrl),
  });

  assert.equal(result.checked, 3);
  assert.equal(result.directSlices, 2);
  assert.equal(result.longImages, 1);
  assert.ok(result.generatedSlices >= 3);
});

test('sliceLongDetailImagesForDraft records a failure and continues instead of throwing when a download fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automoney-'));
  const db = fakeDb([
    { id: 1, product_draft_id: 27, supplier_product_no: '1', image_index: 0, url: 'https://example.test/a.jpg', original_url: null, stored_url: null, image_type: 'detail' },
    { id: 2, product_draft_id: 27, supplier_product_no: '1', image_index: 1, url: 'https://example.test/b.jpg', original_url: null, stored_url: null, image_type: 'detail' },
  ]);

  const result = await sliceLongDetailImagesForDraft(db, 27, {
    rootDir: root,
    fetchImpl: fakeFetch(false),
    loadSharpImpl: async () => fakeSharp({ width: 800, height: 1200 }),
  });

  assert.equal(result.checked, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.failures.length, 2);
});
