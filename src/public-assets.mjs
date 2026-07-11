export function isAllowedPublicAssetPath(pathname) {
  return pathname.startsWith('/generated-images/') || pathname.startsWith('/original-images/');
}
