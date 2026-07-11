export function shouldRetainOriginalDetailImage(image = {}) {
  return Boolean(
    image.isLongImage && ['detail_source_full', 'detail_full'].includes(image.imageType),
  );
}
