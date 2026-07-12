import sharp from 'sharp';

export const MANUAL_IMAGE_LIMITS = Object.freeze({ maxBytes:10_000_000, minSide:1000, maxSide:5000, maxPixels:25_000_000, squareTolerance:0.01 });

export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0]===0xff && buffer[1]===0xd8 && buffer[2]===0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') return 'image/webp';
  return null;
}

export async function validateManualMainImage(buffer, declaredMime) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MANUAL_IMAGE_LIMITS.maxBytes) throw imageError('IMAGE_TOO_LARGE', 'Original image must be at most 10MB');
  const actualMime = detectImageType(buffer);
  if (!actualMime) throw imageError('UNSUPPORTED_IMAGE_FORMAT', 'Only PNG, JPEG, and WebP images are supported');
  if (actualMime !== String(declaredMime||'').toLowerCase()) throw imageError('IMAGE_MIME_MISMATCH', 'Declared MIME type does not match image signature');
  let metadata;
  try { metadata = await sharp(buffer, { failOn:'error', limitInputPixels:false }).metadata(); }
  catch (cause) { throw imageError('CORRUPT_IMAGE', 'Image could not be decoded', cause); }
  const width=Number(metadata.width), height=Number(metadata.height);
  if (!width || !height || width<1000 || height<1000 || width>5000 || height>5000) throw imageError('IMAGE_DIMENSIONS_INVALID', 'Image dimensions must be between 1000 and 5000 pixels');
  if (width*height>MANUAL_IMAGE_LIMITS.maxPixels) throw imageError('IMAGE_PIXELS_INVALID', 'Image exceeds 25 megapixels');
  if (Math.abs(width-height)/Math.max(width,height)>MANUAL_IMAGE_LIMITS.squareTolerance) throw imageError('IMAGE_NOT_SQUARE', 'Image must be square within one percent');
  try { await sharp(buffer, { failOn:'error', limitInputPixels:MANUAL_IMAGE_LIMITS.maxPixels }).rotate().raw().toBuffer(); }
  catch (cause) { throw imageError('CORRUPT_IMAGE', 'Image could not be decoded', cause); }
  return { mimeType:actualMime, width, height, fileSize:buffer.length };
}

export async function createCoupangDerivative(buffer) {
  for (const quality of [90,85,80,75]) {
    const output = await sharp(buffer, { failOn:'error', limitInputPixels:MANUAL_IMAGE_LIMITS.maxPixels })
      .rotate().resize(1000,1000,{fit:'fill',withoutEnlargement:true}).toColourspace('srgb').jpeg({quality,mozjpeg:true}).toBuffer();
    if (output.length<=2_500_000) return { buffer:output, mimeType:'image/jpeg', width:1000, height:1000, quality, fileSize:output.length };
  }
  throw imageError('DERIVATIVE_TOO_LARGE', 'Coupang JPEG remains larger than 2.5MB at quality 75');
}

function imageError(code,message,cause){const error=new Error(message,{cause});error.code=code;return error;}
