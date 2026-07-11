import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveFileName,
  shouldArchiveOriginalImage,
} from '../src/original-image-archive.mjs';

test('archives an external long source image that has no local stored URL', () => {
  assert.equal(
    shouldArchiveOriginalImage({
      imageType: 'detail_source_full',
      sourceSection: 'detail',
      originalUrl: 'https://supplier.example/detail.jpg',
      storedUrl: 'https://supplier.example/detail.jpg',
    }),
    true,
  );
});

test('skips a long source image already stored locally', () => {
  assert.equal(
    shouldArchiveOriginalImage({
      imageType: 'detail_full',
      sourceSection: 'detail',
      originalUrl: 'https://supplier.example/detail.jpg',
      storedUrl: '/original-images/drafts/64/detail-full-123.jpg',
    }),
    false,
  );
});

test('uses stable archive filenames by image type and id', () => {
  assert.equal(archiveFileName({ imageType: 'detail_source_full', id: 123 }, 'image/jpeg'), 'detail-source-full-123.jpg');
  assert.equal(archiveFileName({ imageType: 'detail_full', id: 456 }, 'image/webp'), 'detail-full-456.webp');
});
