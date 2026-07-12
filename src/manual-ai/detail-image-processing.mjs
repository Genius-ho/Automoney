import sharp from 'sharp';

import { detectImageType } from './image-processing.mjs';

const JPEG_QUALITIES = Object.freeze([92, 88, 84, 80]);

export const DETAIL_IMAGE_LIMITS = Object.freeze({
  maxSourceBytes: 10_000_000,
  minWidth: 860,
  minHeight: 1100,
  maxSide: 5000,
  maxPixels: 25_000_000,
  minRatio: 0.45,
  maxRatio: 0.90,
  targetRegistrationBytes: 800_000,
  maxRegistrationBytes: 1_500_000,
  maxAggregateBytes: 10_000_000,
  jpegQualities: JPEG_QUALITIES,
});

export async function validateDetailSourceImage(buffer, declaredMime, imageIndex) {
  if (!Buffer.isBuffer(buffer)) {
    throw detailImageError(
      'UNSUPPORTED_IMAGE_FORMAT',
      'Only PNG, JPEG, and WebP detail images are supported',
      imageIndex,
    );
  }
  if (buffer.length > DETAIL_IMAGE_LIMITS.maxSourceBytes) {
    throw detailImageError(
      'IMAGE_TOO_LARGE',
      'Each original detail image must be at most 10MB',
      imageIndex,
    );
  }

  const actualMime = detectImageType(buffer);
  if (!actualMime) {
    throw detailImageError(
      'UNSUPPORTED_IMAGE_FORMAT',
      'Only PNG, JPEG, and WebP detail images are supported',
      imageIndex,
    );
  }
  if (actualMime !== String(declaredMime || '').trim().toLowerCase()) {
    throw detailImageError(
      'IMAGE_MIME_MISMATCH',
      'Declared MIME type does not match detail image signature',
      imageIndex,
    );
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: false }).metadata();
  } catch (cause) {
    throw detailImageError('CORRUPT_IMAGE', 'Detail image could not be decoded', imageIndex, cause);
  }

  const storedWidth = Number(metadata.width);
  const storedHeight = Number(metadata.height);
  if (!Number.isInteger(storedWidth) || !Number.isInteger(storedHeight)) {
    throw detailImageError(
      'IMAGE_DIMENSIONS_INVALID',
      'Detail image dimensions could not be determined',
      imageIndex,
    );
  }
  if (storedWidth * storedHeight > DETAIL_IMAGE_LIMITS.maxPixels) {
    throw detailImageError(
      'IMAGE_PIXELS_INVALID',
      'Detail image exceeds 25 megapixels',
      imageIndex,
    );
  }
  if (storedWidth > DETAIL_IMAGE_LIMITS.maxSide || storedHeight > DETAIL_IMAGE_LIMITS.maxSide) {
    throw detailImageError(
      'IMAGE_DIMENSIONS_INVALID',
      'Neither detail image side may exceed 5000 pixels',
      imageIndex,
    );
  }

  const { width, height } = orientedDimensions(metadata);
  if (width < DETAIL_IMAGE_LIMITS.minWidth || height < DETAIL_IMAGE_LIMITS.minHeight) {
    throw detailImageError(
      'IMAGE_DIMENSIONS_INVALID',
      'Detail image must be at least 860 pixels wide and 1100 pixels high',
      imageIndex,
    );
  }

  const ratio = width / height;
  if (width > height
    || ratio < DETAIL_IMAGE_LIMITS.minRatio
    || ratio > DETAIL_IMAGE_LIMITS.maxRatio) {
    throw detailImageError(
      'IMAGE_DIMENSIONS_INVALID',
      'Detail image must be portrait with a width-to-height ratio from 0.45 through 0.90',
      imageIndex,
    );
  }

  try {
    await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: DETAIL_IMAGE_LIMITS.maxPixels,
    }).autoOrient().raw().toBuffer();
  } catch (cause) {
    throw detailImageError('CORRUPT_IMAGE', 'Detail image could not be decoded', imageIndex, cause);
  }

  return { mimeType: actualMime, width, height, fileSize: buffer.length };
}

export async function createDetailRegistrationJpeg(buffer, imageIndex) {
  let sourceMetadata;
  try {
    sourceMetadata = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: DETAIL_IMAGE_LIMITS.maxPixels,
    }).metadata();
  } catch (cause) {
    throw detailImageError(
      'DETAIL_IMAGE_OPTIMIZATION_FAILED',
      'Detail image could not be converted to a registration JPEG',
      imageIndex,
      cause,
    );
  }

  const { width: orientedWidth } = orientedDimensions(sourceMetadata);
  for (const jpegQuality of DETAIL_IMAGE_LIMITS.jpegQualities) {
    let outputBuffer;
    try {
      let pipeline = sharp(buffer, {
        failOn: 'error',
        limitInputPixels: DETAIL_IMAGE_LIMITS.maxPixels,
      }).autoOrient().flatten({ background: '#fff' });
      if (orientedWidth > 1000) {
        pipeline = pipeline.resize({ width: 1000, withoutEnlargement: true });
      }
      outputBuffer = await pipeline
        .toColourspace('srgb')
        .jpeg({ quality: jpegQuality })
        .toBuffer();
    } catch (cause) {
      throw detailImageError(
        'DETAIL_IMAGE_OPTIMIZATION_FAILED',
        'Detail image could not be converted to a registration JPEG',
        imageIndex,
        cause,
      );
    }

    const reachesTarget = outputBuffer.length <= DETAIL_IMAGE_LIMITS.targetRegistrationBytes;
    const isAllowedQuality80Fallback = jpegQuality === 80
      && outputBuffer.length <= DETAIL_IMAGE_LIMITS.maxRegistrationBytes;
    if (reachesTarget || isAllowedQuality80Fallback) {
      try {
        const outputMetadata = await sharp(outputBuffer).metadata();
        return {
          buffer: outputBuffer,
          mimeType: 'image/jpeg',
          width: Number(outputMetadata.width),
          height: Number(outputMetadata.height),
          fileSize: outputBuffer.length,
          jpegQuality,
        };
      } catch (cause) {
        throw detailImageError(
          'DETAIL_IMAGE_OPTIMIZATION_FAILED',
          'Detail registration JPEG metadata could not be read',
          imageIndex,
          cause,
        );
      }
    }

    if (jpegQuality === 80) {
      const error = detailImageError(
        'DETAIL_IMAGE_OPTIMIZATION_FAILED',
        'Detail registration JPEG remains larger than 1.5MB at quality 80',
        imageIndex,
      );
      error.fileSize = outputBuffer.length;
      error.maxFileSize = DETAIL_IMAGE_LIMITS.maxRegistrationBytes;
      throw error;
    }
  }

  throw detailImageError(
    'DETAIL_IMAGE_OPTIMIZATION_FAILED',
    'Detail image could not be converted to a registration JPEG',
    imageIndex,
  );
}

export function assertDetailSetAggregate(images) {
  if (!Array.isArray(images)) {
    throw detailImageError(
      'DETAIL_IMAGE_AGGREGATE_INVALID',
      'Normalized detail images must be provided as an array',
    );
  }

  let totalFileSize = 0;
  for (let index = 0; index < images.length; index += 1) {
    const fileSize = images[index]?.fileSize;
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      const error = detailImageError(
        'DETAIL_IMAGE_AGGREGATE_INVALID',
        'Every normalized detail image must have a non-negative integer file size',
        index + 1,
      );
      error.fileSize = fileSize;
      throw error;
    }
    totalFileSize += fileSize;
    if (!Number.isSafeInteger(totalFileSize)) {
      throw detailImageError(
        'DETAIL_IMAGE_AGGREGATE_INVALID',
        'Normalized detail image file sizes exceed the safe integer range',
        index + 1,
      );
    }
  }
  if (totalFileSize > DETAIL_IMAGE_LIMITS.maxAggregateBytes) {
    const error = detailImageError(
      'DETAIL_IMAGE_AGGREGATE_TOO_LARGE',
      'The normalized detail image set must be at most 10MB',
    );
    error.totalFileSize = totalFileSize;
    error.maxFileSize = DETAIL_IMAGE_LIMITS.maxAggregateBytes;
    throw error;
  }
  return totalFileSize;
}

function orientedDimensions(metadata) {
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  return [5, 6, 7, 8].includes(Number(metadata.orientation))
    ? { width: height, height: width }
    : { width, height };
}

function detailImageError(code, message, imageIndex, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  if (imageIndex !== undefined) error.imageIndex = imageIndex;
  return error;
}
