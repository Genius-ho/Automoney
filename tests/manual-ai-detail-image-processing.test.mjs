import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import {
  assertDetailSetAggregate,
  createDetailRegistrationJpeg,
  validateDetailSourceImage,
} from '../src/manual-ai/detail-image-processing.mjs';

const SOURCE_LIMIT = 10_000_000;
const NORMALIZED_TARGET = 800_000;
const NORMALIZED_LIMIT = 1_500_000;
const SET_LIMIT = 10_000_000;
const JPEG_QUALITIES = [92, 88, 84, 80];
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function image(width, height, format = 'png', options = {}) {
  return sharp({
    create: {
      width,
      height,
      channels: options.channels ?? 3,
      background: options.background ?? '#c8d0d8',
    },
  })[format]().toBuffer();
}

async function noisePng(width, height) {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x9e3779b9;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function binaryNoisePng(width, height) {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x9e3779b9;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const offset = pixel * 3;
    pixels[offset] = state & 1 ? 255 : 0;
    pixels[offset + 1] = state & 2 ? 255 : 0;
    pixels[offset + 2] = state & 4 ? 255 : 0;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function orientedQuadrantJpeg() {
  const width = 1100;
  const height = 860;
  const pixels = Buffer.allocUnsafe(width * height * 3);
  const colours = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const quadrant = (y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0);
      const offset = ((y * width) + x) * 3;
      pixels.set(colours[quadrant], offset);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

function pngWithExactSize(png, targetSize) {
  const iendSize = 12;
  const chunkOverhead = 12;
  const dataSize = targetSize - png.length - chunkOverhead;
  assert.ok(dataSize >= 0, 'target PNG size must leave room for an ancillary chunk');
  const type = Buffer.from('ruSt', 'ascii');
  const data = Buffer.alloc(dataSize);
  const chunk = Buffer.alloc(chunkOverhead + dataSize);
  chunk.writeUInt32BE(dataSize, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + dataSize);
  return Buffer.concat([png.subarray(0, -iendSize), chunk, png.subarray(-iendSize)]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pixelAt(data, info, x, y) {
  const offset = ((y * info.width) + x) * info.channels;
  return [...data.subarray(offset, offset + 3)];
}

function assertDominantColour(actual, expectedChannelA, expectedChannelB = null) {
  for (let channel = 0; channel < 3; channel += 1) {
    const shouldBeHigh = channel === expectedChannelA || channel === expectedChannelB;
    assert.ok(
      shouldBeHigh ? actual[channel] > 220 : actual[channel] < 35,
      `unexpected RGB sample ${JSON.stringify(actual)}`,
    );
  }
}

async function registrationCandidateSizes(buffer) {
  const metadata = await sharp(buffer).metadata();
  const resize = metadata.width > 1000
    ? { width: 1000, withoutEnlargement: true }
    : null;
  const results = [];
  for (const jpegQuality of JPEG_QUALITIES) {
    let pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: 25_000_000 })
      .flatten({ background: '#fff' });
    if (resize) pipeline = pipeline.resize(resize);
    const candidate = await pipeline
      .toColourspace('srgb')
      .jpeg({ quality: jpegQuality })
      .toBuffer();
    results.push({ jpegQuality, fileSize: candidate.length });
  }
  return results;
}

test('accepts PNG, JPEG, and WebP sources at the exact minimum dimensions', async () => {
  for (const [format, mimeType] of [
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ]) {
    const input = await image(860, 1100, format);
    const result = await validateDetailSourceImage(input, mimeType, 1);
    assert.deepEqual(result, {
      mimeType,
      width: 860,
      height: 1100,
      fileSize: input.length,
    });
  }
});

test('rejects a declared MIME mismatch and reports the ordered image index', async () => {
  const input = await image(860, 1100);
  await assert.rejects(
    () => validateDetailSourceImage(input, 'image/jpeg', 3),
    (error) => error.code === 'IMAGE_MIME_MISMATCH' && error.imageIndex === 3,
  );
});

test('rejects unsupported signatures and corrupt bytes with a supported signature', async () => {
  await assert.rejects(
    () => validateDetailSourceImage(Buffer.from('not an image'), 'image/png', 2),
    { code: 'UNSUPPORTED_IMAGE_FORMAT', imageIndex: 2 },
  );
  const corruptPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('corrupt'),
  ]);
  await assert.rejects(
    () => validateDetailSourceImage(corruptPng, 'image/png', 4),
    { code: 'CORRUPT_IMAGE', imageIndex: 4 },
  );
});

test('fully decodes a source instead of trusting header metadata', async () => {
  const complete = await noisePng(860, 1100);
  const truncated = complete.subarray(0, Math.floor(complete.length * 0.7));
  assert.deepEqual(
    [
      (await sharp(truncated, { failOn: 'none', limitInputPixels: false }).metadata()).width,
      (await sharp(truncated, { failOn: 'none', limitInputPixels: false }).metadata()).height,
    ],
    [860, 1100],
  );
  await assert.rejects(
    () => validateDetailSourceImage(truncated, 'image/png', 5),
    { code: 'CORRUPT_IMAGE', imageIndex: 5 },
  );
});

test('accepts exactly 10,000,000 source bytes and rejects one byte more before decode', async () => {
  const valid = await image(860, 1100);
  const exactLimit = pngWithExactSize(valid, SOURCE_LIMIT);
  assert.equal((await sharp(exactLimit).metadata()).format, 'png');
  const result = await validateDetailSourceImage(exactLimit, 'image/png', 1);
  assert.equal(result.fileSize, SOURCE_LIMIT);

  const overLimit = Buffer.alloc(SOURCE_LIMIT + 1);
  overLimit.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(
    () => validateDetailSourceImage(overLimit, 'image/png', 6),
    { code: 'IMAGE_TOO_LARGE', imageIndex: 6 },
  );
});

test('enforces minimum dimensions and the 5000-pixel maximum side', async () => {
  await assert.rejects(
    () => image(859, 1100).then((input) => validateDetailSourceImage(input, 'image/png', 1)),
    { code: 'IMAGE_DIMENSIONS_INVALID' },
  );
  await assert.rejects(
    () => image(860, 1099).then((input) => validateDetailSourceImage(input, 'image/png', 2)),
    { code: 'IMAGE_DIMENSIONS_INVALID' },
  );

  const maximumHeight = await validateDetailSourceImage(
    await image(4500, 5000),
    'image/png',
    3,
  );
  assert.deepEqual([maximumHeight.width, maximumHeight.height], [4500, 5000]);

  await assert.rejects(
    () => image(4500, 5001).then((input) => validateDetailSourceImage(input, 'image/png', 4)),
    { code: 'IMAGE_DIMENSIONS_INVALID' },
  );
});

test('enforces the 25-megapixel ceiling independently of side bounds', async () => {
  await assert.rejects(
    () => image(5000, 5001).then((input) => validateDetailSourceImage(input, 'image/png', 8)),
    { code: 'IMAGE_PIXELS_INVALID', imageIndex: 8 },
  );
});

test('rejects landscape images and portrait ratios outside 0.45 through 0.90', async () => {
  await assert.rejects(
    () => image(1200, 1100).then((input) => validateDetailSourceImage(input, 'image/png', 1)),
    { code: 'IMAGE_DIMENSIONS_INVALID' },
  );
  await assert.rejects(
    () => image(899, 2000).then((input) => validateDetailSourceImage(input, 'image/png', 2)),
    { code: 'IMAGE_DIMENSIONS_INVALID' },
  );
  await assert.rejects(
    () => image(991, 1100).then((input) => validateDetailSourceImage(input, 'image/png', 3)),
    { code: 'IMAGE_DIMENSIONS_INVALID' },
  );
});

test('accepts the inclusive 0.45 and 0.90 portrait ratio boundaries', async () => {
  const narrow = await validateDetailSourceImage(await image(900, 2000), 'image/png', 1);
  const wide = await validateDetailSourceImage(await image(990, 1100), 'image/png', 2);
  assert.deepEqual([narrow.width, narrow.height], [900, 2000]);
  assert.deepEqual([wide.width, wide.height], [990, 1100]);
});

test('alpha portrait is flattened white without crop or enlargement', async () => {
  const input = await image(860, 1100, 'png', {
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  const validated = await validateDetailSourceImage(input, 'image/png', 1);
  const output = await createDetailRegistrationJpeg(input, 1);
  const metadata = await sharp(output.buffer).metadata();
  const stats = await sharp(output.buffer).stats();
  assert.deepEqual([validated.width, validated.height], [860, 1100]);
  assert.deepEqual([metadata.width, metadata.height], [860, 1100]);
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.space, 'srgb');
  assert.ok(stats.channels.slice(0, 3).every((channel) => channel.mean > 250));
  assert.equal(output.mimeType, 'image/jpeg');
  assert.equal(output.width, 860);
  assert.equal(output.height, 1100);
  assert.equal(output.fileSize, output.buffer.length);
  assert.equal(output.jpegQuality, 92);
  assert.ok(output.fileSize <= NORMALIZED_LIMIT);
});

test('downscales only widths above 1000 and preserves aspect ratio without cropping', async () => {
  const atLimit = await createDetailRegistrationJpeg(await image(1000, 1500), 1);
  const downscaled = await createDetailRegistrationJpeg(await image(1200, 1800), 2);
  assert.deepEqual([atLimit.width, atLimit.height], [1000, 1500]);
  assert.deepEqual([downscaled.width, downscaled.height], [1000, 1500]);
  assert.equal(downscaled.width / downscaled.height, 1200 / 1800);
});

test('strips source EXIF and ICC metadata from the registration JPEG', async () => {
  const input = await sharp({
    create: { width: 860, height: 1100, channels: 3, background: '#867564' },
  })
    .jpeg()
    .withExif({ IFD0: { Artist: 'Automoney test fixture' } })
    .withIccProfile('srgb')
    .toBuffer();
  const sourceMetadata = await sharp(input).metadata();
  assert.ok(sourceMetadata.exif);
  assert.ok(sourceMetadata.icc);

  const output = await createDetailRegistrationJpeg(input, 4);
  const outputMetadata = await sharp(output.buffer).metadata();
  assert.equal(outputMetadata.exif, undefined);
  assert.equal(outputMetadata.icc, undefined);
});

test('bakes EXIF orientation into pixels before stripping metadata and resizing', async () => {
  const input = await orientedQuadrantJpeg();
  const sourceMetadata = await sharp(input).metadata();
  assert.deepEqual(
    [sourceMetadata.width, sourceMetadata.height, sourceMetadata.orientation],
    [1100, 860, 6],
  );

  const validated = await validateDetailSourceImage(input, 'image/jpeg', 4);
  const output = await createDetailRegistrationJpeg(input, 4);
  const outputMetadata = await sharp(output.buffer).metadata();
  const { data, info } = await sharp(output.buffer).raw().toBuffer({ resolveWithObject: true });

  assert.deepEqual([validated.width, validated.height], [860, 1100]);
  assert.deepEqual([output.width, output.height], [860, 1100]);
  assert.equal(outputMetadata.orientation, undefined);
  assert.equal(outputMetadata.exif, undefined);
  assertDominantColour(pixelAt(data, info, 20, 20), 2);
  assertDominantColour(pixelAt(data, info, info.width - 20, 20), 0);
  assertDominantColour(pixelAt(data, info, 20, info.height - 20), 0, 1);
  assertDominantColour(pixelAt(data, info, info.width - 20, info.height - 20), 1);
});

test('uses the first quality in 92, 88, 84, 80 that reaches the 800KB target', async () => {
  const input = await noisePng(1000, 1200);
  const candidates = await registrationCandidateSizes(input);
  const expected = candidates.find((candidate) => candidate.fileSize <= NORMALIZED_TARGET);
  assert.ok(expected, `expected a candidate at or below 800KB: ${JSON.stringify(candidates)}`);
  assert.notEqual(expected.jpegQuality, 92, `fixture must exercise the ladder: ${JSON.stringify(candidates)}`);

  const output = await createDetailRegistrationJpeg(input, 5);
  assert.equal(output.jpegQuality, expected.jpegQuality);
  assert.equal(output.fileSize, expected.fileSize);
  assert.ok(output.fileSize <= NORMALIZED_TARGET);
});

test('accepts quality 80 above 800KB when it remains within the strict 1.5MB limit', async () => {
  const input = await noisePng(1000, 1800);
  const candidates = await registrationCandidateSizes(input);
  const quality80 = candidates.at(-1);
  assert.ok(quality80.fileSize > NORMALIZED_TARGET, `fixture must exceed 800KB: ${JSON.stringify(candidates)}`);
  assert.ok(quality80.fileSize <= NORMALIZED_LIMIT, `fixture must remain within 1.5MB: ${JSON.stringify(candidates)}`);

  const output = await createDetailRegistrationJpeg(input, 6);
  assert.equal(output.jpegQuality, 80);
  assert.equal(output.fileSize, quality80.fileSize);
});

test('fails an indexed image when quality 80 still exceeds 1.5MB', async () => {
  const input = await binaryNoisePng(1000, 2222);
  const candidates = await registrationCandidateSizes(input);
  assert.ok(candidates.at(-1).fileSize > NORMALIZED_LIMIT, `fixture must exceed 1.5MB: ${JSON.stringify(candidates)}`);

  await assert.rejects(
    () => createDetailRegistrationJpeg(input, 7),
    (error) => error.code === 'DETAIL_IMAGE_OPTIMIZATION_FAILED'
      && error.imageIndex === 7
      && error.fileSize === candidates.at(-1).fileSize,
  );
});

test('enforces the normalized ten-image aggregate at exactly 10,000,000 bytes', () => {
  const exact = Array.from({ length: 10 }, () => ({ fileSize: SET_LIMIT / 10 }));
  assert.equal(assertDetailSetAggregate(exact), SET_LIMIT);

  const over = [...exact];
  over[9] = { fileSize: (SET_LIMIT / 10) + 1 };
  assert.throws(
    () => assertDetailSetAggregate(over),
    (error) => error.code === 'DETAIL_IMAGE_AGGREGATE_TOO_LARGE'
      && error.totalFileSize === SET_LIMIT + 1
      && error.maxFileSize === SET_LIMIT,
  );
});

test('rejects malformed aggregate sizes instead of failing open', () => {
  for (const fileSize of [undefined, Number.NaN, -1, 1.5]) {
    assert.throws(
      () => assertDetailSetAggregate([{ fileSize: 100 }, { fileSize }]),
      (error) => error.code === 'DETAIL_IMAGE_AGGREGATE_INVALID'
        && error.imageIndex === 2,
    );
  }
});
