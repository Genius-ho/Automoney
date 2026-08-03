import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSpeedgoRegistrationInput } from '../src/speedgo-registration-input.mjs';

const validDraft = {
  exportBlocked: false,
  supplierProductNo: '49168396',
  displayProductName: '무타공 정리 선반',
  salePrice: 19800,
  deliveryFee: 3000,
  detailContent: '<p>상세</p>',
  mainImages: ['/generated-ai-images/drafts/501/main/manual/v1.jpg'],
  approvedAiDetailImages: ['/generated-ai-images/drafts/501/detail/manual/r1-v1/01.jpg'],
  options: [{ groupName: '색상', optionName: '화이트', price: 0 }],
};

test('buildSpeedgoRegistrationInput maps the reviewed Naver export', () => {
  const input = buildSpeedgoRegistrationInput(validDraft, { draftId: 501 });

  assert.deepEqual(input, {
    draftId: 501,
    supplierProductNo: '49168396',
    productName: '무타공 정리 선반',
    salePrice: 19800,
    deliveryFee: 3000,
    detailContent: '<p>상세</p>',
    mainImageUrl: '/generated-ai-images/drafts/501/main/manual/v1.jpg',
    detailImageUrls: ['/generated-ai-images/drafts/501/detail/manual/r1-v1/01.jpg'],
    options: [{ groupName: '색상', optionName: '화이트', additionalPrice: 0, stockQuantity: 999 }],
    requestHash: input.requestHash,
  });
  assert.match(input.requestHash, /^[a-f0-9]{64}$/);
});

test('rejects protected draft 64 before building input', () => {
  assert.throws(() => buildSpeedgoRegistrationInput(validDraft, { draftId: 64 }), { code: 'DRAFT_NOT_READY' });
});

test('rejects a blocked draft with DRAFT_BLOCKED', () => {
  assert.throws(() => buildSpeedgoRegistrationInput({ ...validDraft, exportBlocked: true }, { draftId: 501 }), { code: 'DRAFT_BLOCKED' });
});

test('rejects missing supplier number with DRAFT_NOT_READY', () => {
  assert.throws(() => buildSpeedgoRegistrationInput({ ...validDraft, supplierProductNo: '' }, { draftId: 501 }), { code: 'DRAFT_NOT_READY' });
});

test('rejects a missing title, price, or main image with DRAFT_NOT_READY', () => {
  for (const draft of [
    { ...validDraft, displayProductName: '' },
    { ...validDraft, salePrice: null },
    { ...validDraft, mainImages: [] },
  ]) {
    assert.throws(() => buildSpeedgoRegistrationInput(draft, { draftId: 501 }), { code: 'DRAFT_NOT_READY' });
  }
});

test('rejects blank detail HTML and missing detail images with DRAFT_NOT_READY', () => {
  for (const draft of [
    { ...validDraft, detailContent: '' },
    { ...validDraft, detailContent: '   ' },
    { ...validDraft, approvedAiDetailImages: [], detailImages: [], detailSliceImages: [] },
  ]) {
    assert.throws(() => buildSpeedgoRegistrationInput(draft, { draftId: 501 }), { code: 'DRAFT_NOT_READY' });
  }
});

test('rejects invalid delivery fee, option price, and explicit stock quantity', () => {
  for (const draft of [
    { ...validDraft, deliveryFee: 'not-a-number' },
    { ...validDraft, deliveryFee: -1 },
    { ...validDraft, options: [{ ...validDraft.options[0], price: 'not-a-number' }] },
    { ...validDraft, options: [{ ...validDraft.options[0], price: -1 }] },
    { ...validDraft, options: [{ ...validDraft.options[0], stockQuantity: 'not-a-number' }] },
    { ...validDraft, options: [{ ...validDraft.options[0], stockQuantity: -1 }] },
  ]) {
    assert.throws(() => buildSpeedgoRegistrationInput(draft, { draftId: 501 }), { code: 'DRAFT_NOT_READY' });
  }
});

test('rejects explicit NaN delivery fee, option price, and stock quantity', () => {
  for (const draft of [
    { ...validDraft, deliveryFee: Number.NaN },
    { ...validDraft, options: [{ ...validDraft.options[0], price: Number.NaN }] },
    { ...validDraft, options: [{ ...validDraft.options[0], stockQuantity: Number.NaN }] },
  ]) {
    assert.throws(() => buildSpeedgoRegistrationInput(draft, { draftId: 501 }), { code: 'DRAFT_NOT_READY' });
  }
});

test('preserves explicit zero delivery fee, option price, and stock quantity', () => {
  const input = buildSpeedgoRegistrationInput({
    ...validDraft,
    deliveryFee: 0,
    options: [{ ...validDraft.options[0], price: 0, stockQuantity: 0 }],
  }, { draftId: 501 });

  assert.equal(input.deliveryFee, 0);
  assert.equal(input.options[0].additionalPrice, 0);
  assert.equal(input.options[0].stockQuantity, 0);
});

test('rejects a missing draft with DRAFT_NOT_FOUND', () => {
  assert.throws(() => buildSpeedgoRegistrationInput(null, { draftId: 501 }), { code: 'DRAFT_NOT_FOUND' });
});

test('prefers approved details and falls back to detail images then slices', () => {
  const approved = buildSpeedgoRegistrationInput(validDraft, { draftId: 501 });
  const details = buildSpeedgoRegistrationInput({ ...validDraft, approvedAiDetailImages: [], detailImages: ['/detail.jpg'], detailSliceImages: ['/slice.jpg'] }, { draftId: 501 });
  const slices = buildSpeedgoRegistrationInput({ ...validDraft, approvedAiDetailImages: [], detailImages: [], detailSliceImages: ['/slice.jpg'] }, { draftId: 501 });

  assert.deepEqual(approved.detailImageUrls, validDraft.approvedAiDetailImages);
  assert.deepEqual(details.detailImageUrls, ['/detail.jpg']);
  assert.deepEqual(slices.detailImageUrls, ['/slice.jpg']);
});

test('produces a stable hash for the same normalized request', () => {
  const first = buildSpeedgoRegistrationInput(validDraft, { draftId: 501 });
  const second = buildSpeedgoRegistrationInput({ ...validDraft, options: [{ ...validDraft.options[0], stockQuantity: undefined }] }, { draftId: 501 });

  assert.equal(first.requestHash, second.requestHash);
});

test('preserves stored option stock and normalizes numeric values', () => {
  const input = buildSpeedgoRegistrationInput({
    ...validDraft,
    salePrice: '19800',
    deliveryFee: undefined,
    options: [{ groupName: '', optionName: '화이트', price: '500', stockQuantity: '12' }],
  }, { draftId: 501 });

  assert.equal(input.salePrice, 19800);
  assert.equal(input.deliveryFee, 0);
  assert.deepEqual(input.options, [{ groupName: '옵션', optionName: '화이트', additionalPrice: 500, stockQuantity: 12 }]);
});
