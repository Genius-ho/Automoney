import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedPublicAssetPath } from '../src/public-assets.mjs';

test('allows generated and archived original image paths', () => {
  assert.equal(isAllowedPublicAssetPath('/generated-images/drafts/64/rendered/full-page.jpg'), true);
  assert.equal(isAllowedPublicAssetPath('/original-images/drafts/64/detail-source-full-4972.jpg'), true);
});

test('does not expose unrelated public paths through the image endpoint', () => {
  assert.equal(isAllowedPublicAssetPath('/admin'), false);
  assert.equal(isAllowedPublicAssetPath('/other/file.jpg'), false);
});
