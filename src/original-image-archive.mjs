const ARCHIVABLE_IMAGE_TYPES = new Set(['detail_source_full', 'detail_full']);

export function shouldArchiveOriginalImage(image = {}) {
  if (!ARCHIVABLE_IMAGE_TYPES.has(image.imageType)) return false;
  if (image.sourceSection !== 'detail') return false;
  if (!isHttpUrl(image.originalUrl)) return false;
  return !image.storedUrl || isHttpUrl(image.storedUrl);
}

export function archiveFileName(image, contentType = '') {
  const prefix = image.imageType === 'detail_source_full' ? 'detail-source-full' : 'detail-full';
  return `${prefix}-${image.id}.${extensionForContentType(contentType)}`;
}

export function extensionForContentType(contentType = '') {
  const normalized = String(contentType).split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/avif') return 'avif';
  return 'jpg';
}

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}
