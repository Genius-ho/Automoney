import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { isAllowedPublicAssetPath } from '../src/public-assets.mjs';
import { persistManualMainImageFiles, readManualImageMultipart } from '../src/manual-ai/multipart.mjs';
import { approveImageAndMaybeRegister } from '../src/admin-server.mjs';

function request(parts,boundary='manual-boundary'){
  const chunks=[];
  for(const part of parts){chunks.push(Buffer.from(`--${boundary}\r\n${part.headers}\r\n\r\n`));chunks.push(Buffer.isBuffer(part.body)?part.body:Buffer.from(part.body));chunks.push(Buffer.from('\r\n'));}
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const stream=Readable.from(chunks);stream.headers={'content-type':`multipart/form-data; boundary=${boundary}`};return stream;
}
const field=(name,value)=>({headers:`Content-Disposition: form-data; name="${name}"`,body:value});
const file=(body=Buffer.from('png'))=>({headers:'Content-Disposition: form-data; name="image"; filename="result.png"\r\nContent-Type: image/png',body});

test('multipart parser returns one image and known metadata fields', async()=>{
  const parsed=await readManualImageMultipart(request([file(),field('providerCode','chatgpt'),field('promptRequestId','91'),field('promptRevision','2'),field('notes','clean')]));
  assert.equal(parsed.image.filename,'result.png');assert.equal(parsed.image.mimeType,'image/png');assert.equal(parsed.fields.providerCode,'chatgpt');assert.equal(parsed.fields.promptRevision,'2');
});

test('multipart parser rejects unknown fields, duplicate images, and oversized bodies',async()=>{
  await assert.rejects(()=>readManualImageMultipart(request([file(),field('unknown','x')])),{code:'UNKNOWN_MULTIPART_FIELD'});
  await assert.rejects(()=>readManualImageMultipart(request([file(),file()])),{code:'MULTIPLE_IMAGE_FILES'});
  await assert.rejects(()=>readManualImageMultipart(request([file(Buffer.alloc(101))]),{maxBytes:100}),{code:'UPLOAD_TOO_LARGE'});
});

test('file persistence uses immutable revision/version names and public URLs',async()=>{
  const rootDir=await mkdtemp(join(tmpdir(),'automoney-manual-'));
  const result=await persistManualMainImageFiles({rootDir,draftId:64,revision:2,version:1,original:{buffer:Buffer.from('original'),mimeType:'image/webp'},derivative:{buffer:Buffer.from('jpeg')}});
  assert.equal(result.originalStoredUrl,'/generated-ai-images/drafts/64/main/manual/manual-r2-v1-original.webp');
  assert.equal(result.coupangStoredUrl,'/generated-ai-images/drafts/64/main/manual/manual-r2-v1-coupang-1000x1000.jpg');
  assert.equal((await readFile(join(rootDir,'public',result.originalStoredUrl))).toString(),'original');
  await assert.rejects(()=>persistManualMainImageFiles({rootDir,draftId:64,revision:2,version:1,original:{buffer:Buffer.from('again'),mimeType:'image/webp'},derivative:{buffer:Buffer.from('jpeg')}}),{code:'MANUAL_IMAGE_VERSION_EXISTS'});
});

test('manual generated image paths are public but traversal is not',()=>{
  assert.equal(isAllowedPublicAssetPath('/generated-ai-images/drafts/64/main/manual/a.jpg'),true);
  assert.equal(isAllowedPublicAssetPath('/generated-ai-images/../schema.sql'),false);
});

test('image approval commits before automatic registration coordination', async () => {
  const calls = [];
  const value = await approveImageAndMaybeRegister({}, 'C:/repo', 119, 7, null, {
    approveImpl: async () => { calls.push('approved'); return { approved: { id: 7 } }; },
    handleApprovedImagesImpl: async (_db, _root, draftId) => { calls.push(`registered:${draftId}`); return { outcome: 'not_ready' }; },
    loadCoupangConfigImpl: async () => ({ accessKey: 'test' }),
    loadTelegramConfigImpl: async () => ({ botToken: 'test' }),
    createCoupangClientImpl: () => ({}),
  });
  assert.deepEqual(calls, ['approved', 'registered:119']);
  assert.equal(value.result.approved.id, 7);
  assert.equal(value.autoRegistration.outcome, 'not_ready');
});

test('detail approval can trigger automatic registration after both image gates are ready', async () => {
  const value = await approveImageAndMaybeRegister({}, 'C:/repo', 119, 8, 'ok', {
    approveImpl: async () => ({ approved: { id: 8 } }),
    handleApprovedImagesImpl: async () => ({ outcome: 'awaiting_sale_approval' }),
    loadCoupangConfigImpl: async () => ({}),
    loadTelegramConfigImpl: async () => ({}),
    createCoupangClientImpl: () => ({}),
  });
  assert.equal(value.autoRegistration.outcome, 'awaiting_sale_approval');
});

test('registration failure does not roll back the committed image approval', async () => {
  let approved = false;
  await assert.rejects(() => approveImageAndMaybeRegister({}, 'C:/repo', 119, 9, null, {
    approveImpl: async () => { approved = true; return { approved: { id: 9 } }; },
    handleApprovedImagesImpl: async () => { throw Object.assign(new Error('safe failure'), { code: 'COUPANG_REGISTRATION_FAILED' }); },
    loadCoupangConfigImpl: async () => ({}),
    loadTelegramConfigImpl: async () => ({}),
    createCoupangClientImpl: () => ({}),
  }), /safe failure/);
  assert.equal(approved, true);
});
