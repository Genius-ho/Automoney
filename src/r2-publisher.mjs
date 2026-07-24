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

// Raw supplier image URLs (e.g. Domeggook's `.../img_760?hash=...`) often
// carry a query string and no real file extension, so naively taking
// whatever follows the URL's last "." (which may be inside the query string,
// or inside the hostname when the path has no dot at all) produces garbage
// like "com/upload/item/...?hash=..." and an invalid R2 key. Only trust an
// extension found in the path portion (before any "?"), and fall back to jpg
// -- objects are always stored as image/jpeg regardless, see putObject below.
function extensionFor(localUrl) {
  const path = /^https?:\/\//i.test(localUrl) ? localUrl.split('?')[0] : localUrl;
  const match = path.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match ? match[1].toLowerCase() : 'jpg';
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
    const extension = extensionFor(localUrl);
    const key = `drafts/${draftId}/coupang/${hash}.${extension}`;
    const existing = await client.headObject(key);
    if (existing) return existing.publicUrl;
    const { publicUrl } = await client.putObject(key, buffer, 'image/jpeg');
    return publicUrl;
  };
  const mainImageUrl = await upload(mainImageLocalUrl);
  const detailImageUrls = [];
  for (const localUrl of detailImageLocalUrls) detailImageUrls.push(await upload(localUrl));
  return { mainImageUrl, detailImageUrls };
}
