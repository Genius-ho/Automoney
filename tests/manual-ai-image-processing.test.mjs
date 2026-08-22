import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import { createCoupangDerivative, detectImageType, validateManualMainImage } from '../src/manual-ai/image-processing.mjs';

const image = (width, height, format = 'png') => sharp({ create:{ width, height, channels:3, background:'#c8d0d8' } })[format]().toBuffer();

test('detects PNG, JPEG, and WebP from signatures', async () => {
  assert.equal(detectImageType(await image(1000,1000,'png')), 'image/png');
  assert.equal(detectImageType(await image(1000,1000,'jpeg')), 'image/jpeg');
  assert.equal(detectImageType(await image(1000,1000,'webp')), 'image/webp');
});

test('rejects declared MIME that disagrees with the signature', async () => {
  const input = await image(1000,1000,'png');
  await assert.rejects(() => validateManualMainImage(input, 'image/jpeg'), { code:'IMAGE_MIME_MISMATCH' });
});

test('rejects corrupt and unsupported image bytes', async () => {
  await assert.rejects(() => validateManualMainImage(Buffer.from('not an image'), 'image/png'), { code:'UNSUPPORTED_IMAGE_FORMAT' });
});

test('rejects original files larger than 10MB before decode', async () => {
  const bytes = Buffer.alloc(10_000_001); bytes.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  await assert.rejects(() => validateManualMainImage(bytes, 'image/png'), { code:'IMAGE_TOO_LARGE' });
});

test('rejects undersized, oversized, and non-square images', async () => {
  await assert.rejects(() => image(999,1000).then((input) => validateManualMainImage(input, 'image/png')), { code:'IMAGE_DIMENSIONS_INVALID' });
  await assert.rejects(() => image(5001,5000).then((input) => validateManualMainImage(input, 'image/png')), { code:'IMAGE_DIMENSIONS_INVALID' });
  await assert.rejects(() => image(1200,1100).then((input) => validateManualMainImage(input, 'image/png')), { code:'IMAGE_NOT_SQUARE' });
});

test('accepts square images within one percent tolerance', async () => {
  const result = await validateManualMainImage(await image(1200,1190), 'image/png');
  assert.deepEqual([result.width,result.height], [1200,1190]);
});

test('WebP upload produces a 1000-square JPEG below three megabytes', async () => {
  const input = await image(1200,1200,'webp');
  const output = await createCoupangDerivative(input);
  const metadata = await sharp(output.buffer).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.deepEqual([metadata.width,metadata.height], [1000,1000]);
  assert.equal(output.mimeType, 'image/jpeg');
  assert.ok(output.fileSize <= 2_500_000);
  assert.ok(output.fileSize < 3_000_000);
  assert.ok([90,85,80,75].includes(output.quality));
});
