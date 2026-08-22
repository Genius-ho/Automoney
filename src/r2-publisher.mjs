import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { loadR2Config } from './config.mjs';
import { R2Client } from './r2-client.mjs';

// Mirrors admin-server's own workflow-asset path guard (public/ only, no
// traversal) -- kept as a tiny private copy here rather than importing from
// admin-server.mjs, since that module is the HTTP entrypoint and importing
// from it would create a cycle with any admin-server code that needs this.
function readPublicAsset(rootDir, value) {
  const publicRoot = resolve(rootDir, 'public');
  const filePath = resolve(join(publicRoot, String(value).replace(/^\/+/, '')));
  if (!filePath.startsWith(publicRoot)) throw Object.assign(new Error('Forbidden workflow asset'), { code: 'DETAIL_PACKAGE_IMAGES_MISSING' });
  return readFile(filePath);
}

// The URL/filename a raw supplier image arrives under is not trustworthy --
// Domeggook URLs often carry a query string and no real extension at all
// (e.g. `.../img_760?hash=...`), and separately, the file behind a `.jpg`
// name is sometimes actually a PNG (confirmed live 2026-07-24: Naver's
// createOriginProduct rejected a registration with "올바른 이미지 파일이 아닙니다"
// because the object had been stored as Content-Type: image/jpeg while its
// bytes were a PNG). Sniff the real format from the file's own
// magic bytes instead of trusting the URL or hardcoding image/jpeg, and use
// that for both the R2 key's extension and the object's Content-Type so the
// two always agree. Defaults to jpg/image/jpeg for anything unrecognized.
function detectImageFormat(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { extension: 'png', contentType: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', contentType: 'image/jpeg' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { extension: 'webp', contentType: 'image/webp' };
  }
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
    return { extension: 'gif', contentType: 'image/gif' };
  }
  return { extension: 'jpg', contentType: 'image/jpeg' };
}

// Approved main/detail images are served locally by the admin server
// (relative /generated-ai-images/... paths), which Coupang's servers can't
// reach. Coupang's payload needs real public HTTPS URLs, so each image gets
// mirrored to R2 first -- same hash-keyed, dedup-on-reupload approach as
// scripts/coupang-upload-images.mjs, just driven from the DB-approved rows
// instead of a draft export. Shared by both the image-swap flow (already
// registered products) and the new direct-registration flow (brand-new
// products), so this lives in its own module instead of admin-server.mjs.
export async function uploadApprovedImagesToR2({ rootDir, draftId, mainImageLocalUrl, detailImageLocalUrls, loadR2ConfigImpl = loadR2Config, createClientImpl = (config) => new R2Client(config), readPublicAssetImpl = readPublicAsset, fetchImpl = globalThis.fetch }) {
  const r2Config = await loadR2ConfigImpl(rootDir);
  const client = createClientImpl(r2Config);
  const upload = async (localUrl) => {
    // Raw-mode registration (coupang-registration-flow.mjs) sources images
    // straight from a draft's own supplier-original URL (product_images.
    // main_image_type='main', never mirrored to a local public/ file the
    // way an approved/generated image is) -- fetch it directly instead of
    // treating it as a local path in that case.
    const buffer = /^https?:\/\//i.test(localUrl)
      ? Buffer.from(await (await fetchImpl(localUrl)).arrayBuffer())
      : await readPublicAssetImpl(rootDir, localUrl);
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const { extension, contentType } = detectImageFormat(buffer);
    const key = `drafts/${draftId}/coupang/${hash}.${extension}`;
    const existing = await client.headObject(key);
    if (existing) return existing.publicUrl;
    const { publicUrl } = await client.putObject(key, buffer, contentType);
    return publicUrl;
  };
  const mainImageUrl = await upload(mainImageLocalUrl);
  const detailImageUrls = [];
  for (const localUrl of detailImageLocalUrls) detailImageUrls.push(await upload(localUrl));
  return { mainImageUrl, detailImageUrls };
}
