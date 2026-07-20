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

// Approved main/detail images are served locally by the admin server
// (relative /generated-ai-images/... paths), which Coupang's servers can't
// reach. Coupang's payload needs real public HTTPS URLs, so each image gets
// mirrored to R2 first -- same hash-keyed, dedup-on-reupload approach as
// scripts/coupang-upload-images.mjs, just driven from the DB-approved rows
// instead of a draft export. Shared by both the image-swap flow (already
// registered products) and the new direct-registration flow (brand-new
// products), so this lives in its own module instead of admin-server.mjs.
export async function uploadApprovedImagesToR2({ rootDir, draftId, mainImageLocalUrl, detailImageLocalUrls, loadR2ConfigImpl = loadR2Config, createClientImpl = (config) => new R2Client(config), readPublicAssetImpl = readPublicAsset }) {
  const r2Config = await loadR2ConfigImpl(rootDir);
  const client = createClientImpl(r2Config);
  const upload = async (localUrl) => {
    const buffer = await readPublicAssetImpl(rootDir, localUrl);
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const extension = localUrl.split('.').pop();
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
