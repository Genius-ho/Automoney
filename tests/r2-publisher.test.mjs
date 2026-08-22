import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadApprovedImagesToR2 } from '../src/r2-publisher.mjs';

const BUFFERS = {
  '/generated-ai-images/drafts/1/main.jpg': Buffer.from('main-bytes'),
  '/generated-ai-images/drafts/1/detail-1.jpg': Buffer.from('detail-1-bytes'),
  '/generated-ai-images/drafts/1/detail-2.jpg': Buffer.from('detail-2-bytes'),
};

function fakeDeps({ headResult = null, calls = { head: [], put: [] } } = {}) {
  return {
    calls,
    loadR2ConfigImpl: async () => ({ accountId: 'x', accessKeyId: 'x', secretAccessKey: 'x', bucket: 'x', publicBaseUrl: 'https://pub.example' }),
    createClientImpl: () => ({
      async headObject(key) {
        calls.head.push(key);
        return typeof headResult === 'function' ? headResult(key) : headResult;
      },
      async putObject(key, buffer, contentType) {
        calls.put.push({ key, contentType, size: buffer.length });
        return { key, publicUrl: `https://pub.example/${key}` };
      },
    }),
    readPublicAssetImpl: async (rootDir, localUrl) => BUFFERS[localUrl],
  };
}

test('uploadApprovedImagesToR2 uploads main + each detail image and returns their public URLs', async () => {
  const deps = fakeDeps();
  const result = await uploadApprovedImagesToR2({
    rootDir: '/repo',
    draftId: 1,
    mainImageLocalUrl: '/generated-ai-images/drafts/1/main.jpg',
    detailImageLocalUrls: ['/generated-ai-images/drafts/1/detail-1.jpg', '/generated-ai-images/drafts/1/detail-2.jpg'],
    ...deps,
  });
  assert.ok(result.mainImageUrl.startsWith('https://pub.example/drafts/1/coupang/'));
  assert.equal(result.detailImageUrls.length, 2);
  assert.equal(deps.calls.put.length, 3);
  assert.equal(deps.calls.put[0].contentType, 'image/jpeg');
});

test('uploadApprovedImagesToR2 skips putObject entirely when headObject already finds the content-hash key (dedup)', async () => {
  const deps = fakeDeps({ headResult: (key) => ({ key, publicUrl: `https://pub.example/${key}` }) });
  const result = await uploadApprovedImagesToR2({
    rootDir: '/repo',
    draftId: 1,
    mainImageLocalUrl: '/generated-ai-images/drafts/1/main.jpg',
    detailImageLocalUrls: ['/generated-ai-images/drafts/1/detail-1.jpg'],
    ...deps,
  });
  assert.equal(deps.calls.head.length, 2);
  assert.equal(deps.calls.put.length, 0, 'already-uploaded content must not be re-uploaded');
  assert.ok(result.mainImageUrl.startsWith('https://pub.example/'));
});

test('uploadApprovedImagesToR2 keys objects under drafts/{draftId}/coupang/ so different drafts never collide', async () => {
  const deps = fakeDeps();
  await uploadApprovedImagesToR2({
    rootDir: '/repo',
    draftId: 46,
    mainImageLocalUrl: '/generated-ai-images/drafts/1/main.jpg',
    detailImageLocalUrls: [],
    ...deps,
  });
  assert.ok(deps.calls.put[0].key.startsWith('drafts/46/coupang/'));
});

test('uploadApprovedImagesToR2 keys a raw supplier URL with a query string and no real extension under a content-sniffed .jpg', async () => {
  // Whatever the URL looks like must never leak into the key -- only the
  // actual bytes decide the extension. This URL shape (Domeggook's
  // `...img_760?hash=...`) is exactly what previously produced an invalid,
  // slash-containing R2 key.
  const deps = fakeDeps();
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  deps.fetchImpl = async () => ({ arrayBuffer: async () => jpegBytes });
  const rawSupplierUrl = 'https://img.domeggook.com/upload/item/2026/06/19/1781825629EB1168742EAA76D939F9BF/1781825629EB1168742EAA76D939F9BF_img_760?hash=a803c03e63702a4736e211efbbb740a8';
  const result = await uploadApprovedImagesToR2({
    rootDir: '/repo',
    draftId: 46,
    mainImageLocalUrl: rawSupplierUrl,
    detailImageLocalUrls: [],
    ...deps,
  });
  assert.match(deps.calls.put[0].key, /^drafts\/46\/coupang\/[0-9a-f]{16}\.jpg$/);
  assert.equal(deps.calls.put[0].contentType, 'image/jpeg');
  assert.ok(result.mainImageUrl.startsWith('https://pub.example/drafts/46/coupang/'));
});

// Naver's createOriginProduct rejected a live registration with "올바른
// 이미지 파일이 아닙니다" because a file had been stored as
// Content-Type: image/jpeg while its actual bytes were a PNG (the old
// hardcoded-image/jpeg behavior). Extension and Content-Type must always
// match the real file, regardless of what the source URL's name implies.
test('uploadApprovedImagesToR2 sniffs a PNG by its magic bytes and stores it with a matching extension and Content-Type, even under a .jpg-looking URL', async () => {
  const deps = fakeDeps();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  deps.fetchImpl = async () => ({ arrayBuffer: async () => pngBytes });
  const result = await uploadApprovedImagesToR2({
    rootDir: '/repo',
    draftId: 46,
    mainImageLocalUrl: 'https://img.domeggook.com/upload/item/main.jpg?hash=abc',
    detailImageLocalUrls: [],
    ...deps,
  });
  assert.match(deps.calls.put[0].key, /\.png$/);
  assert.equal(deps.calls.put[0].contentType, 'image/png');
  assert.ok(result.mainImageUrl);
});
