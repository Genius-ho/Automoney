export function isAllowedPublicAssetPath(pathname) {
  if (pathname.includes('..') || pathname.includes('\\')) return false;
  return pathname.startsWith('/generated-images/') || pathname.startsWith('/original-images/') || /^\/generated-ai-images\/drafts\/\d+\/main\/manual\/[a-z0-9._-]+$/i.test(pathname);
}
