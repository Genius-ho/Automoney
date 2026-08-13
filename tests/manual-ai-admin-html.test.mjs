import assert from 'node:assert/strict';
import test from 'node:test';
import { getQueueStatusLabel, renderManualMainImageWorkflowSection } from '../src/admin-server.mjs';

test('queue lifecycle labels cover image and sale approval waits',()=>{
  assert.equal(getQueueStatusLabel('draft_created'),'드래프트 생성 완료');
  assert.equal(getQueueStatusLabel('awaiting_image_approval'),'이미지 승인 대기');
  assert.equal(getQueueStatusLabel('awaiting_sale_approval'),'판매승인 대기');
  assert.equal(getQueueStatusLabel('completed'),'완료');
});

test('manual main image UI includes package, copy, upload, provider, comparison, and decisions',()=>{
  const html=renderManualMainImageWorkflowSection({request:{id:91,revision:2,templateHash:'abcdef1234567890',promptOriginal:'original',promptRendered:'rendered'},results:[]});
  for(const selector of ['data-manual-package','data-copy-rendered','data-copy-original','data-manual-upload','name="image"','name="providerCode"','data-manual-comparison','data-manual-approve','data-manual-reject'])assert.ok(html.includes(selector),selector);
  assert.match(html,/ChatGPT/);assert.match(html,/Google Gemini/);assert.match(html,/Anthropic Claude/);assert.match(html,/Custom \/ 기타/);assert.match(html,/아직 업로드된 외부 AI 생성 이미지가 없습니다/);
});

test('manual main image UI shows latest result and retained version history',()=>{
  const html=renderManualMainImageWorkflowSection({request:{id:91,revision:2,templateHash:'abcdef1234567890'},sourceMainImage:{url:'/source.jpg'},results:[{id:1,version:1,status:'superseded',providerDisplayName:'ChatGPT',coupangStoredUrl:'/v1.jpg'},{id:2,version:2,status:'uploaded',providerDisplayName:'Google Gemini',coupangStoredUrl:'/v2.jpg'}]});
  assert.match(html,/version 2/);assert.match(html,/superseded/);assert.match(html,/data-manual-version="1"/);assert.match(html,/data-manual-version="2"/);
});
