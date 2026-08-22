import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedPublicAssetPath } from '../src/public-assets.mjs';

test('allows generated and archived original image paths', () => {
  assert.equal(isAllowedPublicAssetPath('/generated-images/drafts/64/rendered/full-page.jpg'), true);
  assert.equal(isAllowedPublicAssetPath('/original-images/drafts/64/detail-source-full-4972.jpg'), true);
});

test('allows manual main-image and manual detail-set generated assets', () => {
  assert.equal(isAllowedPublicAssetPath('/generated-ai-images/drafts/64/main/manual/manual-r2-v1-coupang-1000x1000.jpg'), true);
  assert.equal(isAllowedPublicAssetPath('/generated-ai-images/drafts/64/detail/manual/r1-v1/detail-r1-v1-01-registered.jpg'), true);
  assert.equal(isAllowedPublicAssetPath('/generated-ai-images/drafts/64/detail/manual/r1-v1/detail-r1-v1-10-original.png'), true);
});

test('rejects manual detail-set paths that skip the revision-version directory or traverse elsewhere', () => {
  assert.equal(isAllowedPublicAssetPath('/generated-ai-images/drafts/64/detail/manual/detail-r1-v1-01-registered.jpg'), false);
  assert.equal(isAllowedPublicAssetPath('/generated-ai-images/drafts/64/detail/manual/r1-v1/../../../etc/passwd'), false);
  assert.equal(isAllowedPublicAssetPath('/generated-ai-images/drafts/64/other-task/manual/r1-v1/file.jpg'), false);
});

test('does not expose unrelated public paths through the image endpoint', () => {
  assert.equal(isAllowedPublicAssetPath('/admin'), false);
  assert.equal(isAllowedPublicAssetPath('/other/file.jpg'), false);
});
