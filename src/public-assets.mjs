export function isAllowedPublicAssetPath(pathname) {
  if (pathname.includes('..') || pathname.includes('\\')) return false;
  return pathname.startsWith('/generated-images/')
    || pathname.startsWith('/original-images/')
    || /^\/generated-ai-images\/drafts\/\d+\/main\/manual\/[a-z0-9._-]+$/i.test(pathname)
    || /^\/generated-ai-images\/drafts\/\d+\/detail\/manual\/r\d+-v\d+\/[a-z0-9._-]+$/i.test(pathname);
}
