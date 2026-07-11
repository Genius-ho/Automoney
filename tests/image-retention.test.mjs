import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRetainOriginalDetailImage } from '../src/image-retention.mjs';

test('retains long original detail images during rendered recrawls', () => {
  assert.equal(
    shouldRetainOriginalDetailImage({ imageType: 'detail_source_full', isLongImage: true }),
    true,
  );
  assert.equal(
    shouldRetainOriginalDetailImage({ imageType: 'detail_full', isLongImage: true }),
    true,
  );
});

test('does not retain ordinary rendered detail images as source originals', () => {
  assert.equal(shouldRetainOriginalDetailImage({ imageType: 'detail', isLongImage: false }), false);
});
