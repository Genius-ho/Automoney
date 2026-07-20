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
