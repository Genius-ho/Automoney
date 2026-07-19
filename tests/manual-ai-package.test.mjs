import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMainImagePackage, buildPackageEntries } from '../src/manual-ai/package-builder.mjs';

const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
const context = {
  draft:{ id:64, sellingTitle:'Test product' },
  request:{ id:91, requestType:'main_image', revision:2, templateVersion:7, templateHash:'abcdef1234567890', promptRendered:'rendered prompt', promptOriginal:'original prompt', state:'current', status:'draft' },
  sourceMainImage:{ url:'https://source.test/main.png' },
  referenceImages:[{ url:'https://source.test/ref.jpg' }],
};
const fetchImpl = async (url) => ({ ok:true, headers:new Headers({ 'content-type':url.endsWith('.jpg')?'image/jpeg':'image/png' }), arrayBuffer:async()=>png });

test('package entries contain every required file and exact revision metadata', async () => {
  const entries = await buildPackageEntries(context,{fetchImpl});
  assert.deepEqual(entries.map((entry)=>entry.name), ['01-source-main-image.png','02-prompt-rendered.txt','03-prompt-original.txt','04-product-info.json','05-instructions.txt','references/optional-reference-01.png']);
  const info = JSON.parse(entries.find((entry)=>entry.name==='04-product-info.json').data.toString());
  assert.deepEqual(info,{draftId:64,productName:'Test product',requestId:91,promptRevision:2,templateVersion:7,promptHash:'abcdef1234567890',sourceImageUrl:'https://source.test/main.png',workflowMode:'manual_external_ai'});
  assert.equal(entries.find((entry)=>entry.name==='02-prompt-rendered.txt').data.toString(),'rendered prompt');
  assert.match(entries.find((entry)=>entry.name==='05-instructions.txt').data.toString(),/원본 제품의 형태, 색상, 구조를 변경하지 않는다/);
});

test('package is downloadable while prompt status is draft', async () => {
  const result = await buildMainImagePackage(context,{fetchImpl});
  assert.equal(result.filename,'draft-64-main-image-r2.zip');
  assert.ok(result.buffer.subarray(0,2).equals(Buffer.from('PK')));
});

test('package rejects missing current prompt, rendered text, or source image', async () => {
  await assert.rejects(()=>buildPackageEntries({...context,request:null},{fetchImpl}),{code:'MAIN_IMAGE_PROMPT_MISSING'});
  await assert.rejects(()=>buildPackageEntries({...context,request:{...context.request,state:'stale'}},{fetchImpl}),{code:'MAIN_IMAGE_PROMPT_STALE'});
  await assert.rejects(()=>buildPackageEntries({...context,request:{...context.request,promptRendered:''}},{fetchImpl}),{code:'MAIN_IMAGE_PROMPT_INVALID'});
  await assert.rejects(()=>buildPackageEntries({...context,sourceMainImage:null},{fetchImpl}),{code:'SOURCE_MAIN_IMAGE_MISSING'});
});

test('package rejects a missing draft and failed source download', async () => {
  await assert.rejects(()=>buildPackageEntries({...context,draft:null},{fetchImpl}),{code:'DRAFT_NOT_FOUND'});
  await assert.rejects(()=>buildPackageEntries(context,{fetchImpl:async()=>({ok:false,status:404})}),{code:'SOURCE_IMAGE_DOWNLOAD_FAILED'});
});
