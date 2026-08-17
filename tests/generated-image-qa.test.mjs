import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewGeneratedImages } from '../src/generated-image-qa.mjs';

function fakeDraft(overrides = {}) {
  return { id: 8, sellingTitle: '폴딩 차량뒷좌석 멀티트레이', coupangSalePrice: 13070, options: [{ name: '색상', value: '멀티트레이(블랙)' }], ...overrides };
}

function fakeMainImage(overrides = {}) {
  return { id: 10, status: 'uploaded', coupangStoredUrl: '/generated-ai-images/drafts/8/main/manual/manual-r1-v1-coupang-1000x1000.jpg', ...overrides };
}

function fakeDetailSet(overrides = {}) {
  return {
    id: 7, status: 'uploaded',
    images: [{ imageIndex: 1, normalizedStoredUrl: '/generated-ai-images/drafts/8/detail/manual/r1-v1/detail-r1-v1-01-registered.jpg' }],
    ...overrides,
  };
}

function enabledRoute(overrides = {}) {
  return { taskType: 'generated_image_review', providerCode: 'anthropic', model: null, enabled: true, ...overrides };
}

function passResult() {
  return { model: 'sonnet', rawText: '{"pass": true, "issues": []}' };
}

function failResult(description = 'issue found') {
  return { model: 'sonnet', rawText: `{"pass": false, "issues": [{"severity":"high","description":"${description}"}]}` };
}

function commonDeps(overrides = {}) {
  return {
    getProductDraftImpl: async () => fakeDraft(),
    getMarketResearchImpl: async () => null,
    listManualMainImagesImpl: async () => [fakeMainImage()],
    listManualDetailSetsImpl: async () => [fakeDetailSet()],
    listTaskRoutingImpl: async () => ({ routes: [enabledRoute()] }),
    loadClaudeCliConfigImpl: async () => ({ executable: 'claude', model: 'sonnet' }),
    checkClaudeCliAvailabilityImpl: async () => ({ available: true, loggedIn: true, message: 'Logged in (pro)' }),
    loadCodexConfigImpl: async () => ({}),
    loadJobPathsConfigImpl: async () => ({ jobDir: '/tmp/jobs' }),
    loadImageForVisionImpl: async (rootDir, url) => ({ filePath: `/repo/public${url}`, cleanup: null }),
    loadRemoteImageForVisionImpl: async () => ({ filePath: '/tmp/automoney-qa-competitor-fake.jpg', cleanup: async () => {} }),
    insertImageQaReviewImpl: async () => {},
    approveInboxImagesImpl: async () => {},
    generateMainImageImpl: async () => {},
    generateDetailImageSetImpl: async () => {},
    ...overrides,
  };
}

test('reviewGeneratedImages skips when the generated_image_review task route is missing or disabled', async () => {
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({ listTaskRoutingImpl: async () => ({ routes: [] }) }));
  assert.deepEqual(result, { skipped: true, reason: 'TASK_DISABLED' });

  const result2 = await reviewGeneratedImages({}, '/repo', 8, commonDeps({ listTaskRoutingImpl: async () => ({ routes: [enabledRoute({ enabled: false })] }) }));
  assert.deepEqual(result2, { skipped: true, reason: 'TASK_DISABLED' });
});

test('reviewGeneratedImages skips when the draft does not exist', async () => {
  const result = await reviewGeneratedImages({}, '/repo', 999, commonDeps({ getProductDraftImpl: async () => null }));
  assert.deepEqual(result, { skipped: true, reason: 'DRAFT_NOT_FOUND' });
});

test('reviewGeneratedImages skips when the Claude CLI is not available or not logged in', async () => {
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    checkClaudeCliAvailabilityImpl: async () => ({ available: false, loggedIn: false, message: 'claude --version exited with code 127' }),
  }));
  assert.deepEqual(result, { skipped: true, reason: 'CLAUDE_CLI_UNAVAILABLE', message: 'claude --version exited with code 127' });

  const result2 = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    checkClaudeCliAvailabilityImpl: async () => ({ available: true, loggedIn: false, message: 'Not logged in' }),
  }));
  assert.deepEqual(result2, { skipped: true, reason: 'CLAUDE_CLI_UNAVAILABLE', message: 'Not logged in' });
});

test('reviewGeneratedImages skips when no uploaded/approved main image or detail set exists yet', async () => {
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({ listManualMainImagesImpl: async () => [] }));
  assert.deepEqual(result, { skipped: true, reason: 'IMAGES_NOT_READY' });
});

test('reviewGeneratedImages calls approveInboxImages and records a pass review on the first attempt, without ever regenerating', async () => {
  let approveCalled;
  let regenerateCalled = false;
  const recordedReviews = [];
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({ analyzeImages: async () => passResult() }),
    approveInboxImagesImpl: async (db, rootDir, draftId) => { approveCalled = { rootDir, draftId }; },
    insertImageQaReviewImpl: async (db, input) => recordedReviews.push(input),
    generateMainImageImpl: async () => { regenerateCalled = true; },
  }));
  assert.deepEqual(result, { verdict: 'pass', approved: true, attempt: 1 });
  assert.deepEqual(approveCalled, { rootDir: '/repo', draftId: 8 });
  assert.equal(recordedReviews.length, 1);
  assert.equal(recordedReviews[0].verdict, 'pass');
  assert.equal(regenerateCalled, false);
});

test('reviewGeneratedImages reports (rather than throws) when the pass-triggered auto-registration itself fails, e.g. REGISTRATION_NOT_READY', async () => {
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({ analyzeImages: async () => passResult() }),
    approveInboxImagesImpl: async () => { throw Object.assign(new Error('Coupang registration failed: REGISTRATION_NOT_READY'), { code: 'REGISTRATION_NOT_READY' }); },
  }));
  assert.deepEqual(result, { verdict: 'pass', approved: false, registrationError: 'Coupang registration failed: REGISTRATION_NOT_READY', attempt: 1 });
});

test('reviewGeneratedImages regenerates and re-reviews after a first-attempt fail, then approves on a second-attempt pass', async () => {
  let analyzeCallCount = 0;
  let regenerateArgs = [];
  let approveCalled = false;
  const recordedReviews = [];
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({
      analyzeImages: async () => { analyzeCallCount += 1; return analyzeCallCount === 1 ? failResult('color mismatch') : passResult(); },
    }),
    insertImageQaReviewImpl: async (db, input) => recordedReviews.push(input),
    generateMainImageImpl: async (db, rootDir, jobDir, draftId, opts) => { regenerateArgs.push({ fn: 'main', opts }); },
    generateDetailImageSetImpl: async (db, rootDir, jobDir, draftId, opts) => { regenerateArgs.push({ fn: 'detail', opts }); },
    approveInboxImagesImpl: async () => { approveCalled = true; },
  }));
  assert.deepEqual(result, { verdict: 'pass', approved: true, attempt: 2 });
  assert.equal(analyzeCallCount, 2);
  assert.equal(approveCalled, true);
  assert.equal(regenerateArgs.length, 2);
  assert.equal(regenerateArgs[0].fn, 'main');
  assert.match(regenerateArgs[0].opts.extraInstructions, /color mismatch/);
  assert.match(regenerateArgs[1].opts.extraInstructions, /color mismatch/);
  assert.equal(recordedReviews.length, 2);
  assert.equal(recordedReviews[0].verdict, 'fail');
  assert.equal(recordedReviews[1].verdict, 'pass');
});

test('reviewGeneratedImages stops after maxAttempts fails without regenerating again, and never approves', async () => {
  let analyzeCallCount = 0;
  let regenerateCallCount = 0;
  let approveCalled = false;
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({ analyzeImages: async () => { analyzeCallCount += 1; return failResult(`issue ${analyzeCallCount}`); } }),
    generateMainImageImpl: async () => { regenerateCallCount += 1; },
    approveInboxImagesImpl: async () => { approveCalled = true; },
  }));
  assert.equal(result.verdict, 'fail');
  assert.equal(result.attempt, 2);
  assert.equal(analyzeCallCount, 2);
  assert.equal(regenerateCallCount, 1); // only regenerated once, between attempt 1 and 2 -- never a 3rd time
  assert.equal(approveCalled, false);
});

test('reviewGeneratedImages respects a custom maxAttempts', async () => {
  let analyzeCallCount = 0;
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    maxAttempts: 1,
    getProviderImpl: () => ({ analyzeImages: async () => { analyzeCallCount += 1; return failResult(); } }),
  }));
  assert.equal(analyzeCallCount, 1);
  assert.equal(result.attempt, 1);
});

test('reviewGeneratedImages records an error and stops the loop (no more attempts) when regeneration itself throws', async () => {
  let recordedReview;
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({ analyzeImages: async () => failResult() }),
    generateMainImageImpl: async () => { throw new Error('CODEX_TIMEOUT'); },
    insertImageQaReviewImpl: async (db, input) => { recordedReview = input; },
  }));
  assert.equal(result.verdict, 'error');
  assert.match(result.error, /CODEX_TIMEOUT/);
  assert.equal(recordedReview.verdict, 'error');
});

test('reviewGeneratedImages records an error review (and never approves) when the provider call itself throws', async () => {
  let approveCalled = false;
  let recordedReview;
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({ analyzeImages: async () => { throw Object.assign(new Error('rate limited'), { code: 'ANTHROPIC_API_ERROR' }); } }),
    approveInboxImagesImpl: async () => { approveCalled = true; },
    insertImageQaReviewImpl: async (db, input) => { recordedReview = input; },
  }));
  assert.equal(result.verdict, 'error');
  assert.match(result.error, /rate limited/);
  assert.equal(approveCalled, false);
  assert.equal(recordedReview.verdict, 'error');
});

test('reviewGeneratedImages records an error review when the model response is not parseable JSON', async () => {
  let recordedReview;
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({ analyzeImages: async () => ({ model: 'sonnet', rawText: 'sorry, I cannot help with that' }) }),
    insertImageQaReviewImpl: async (db, input) => { recordedReview = input; },
  }));
  assert.equal(result.verdict, 'error');
  assert.equal(recordedReview.verdict, 'error');
});

test('reviewGeneratedImages instructs the reviewer not to flag decorative rating/review graphics, but still requires cross-image option/color consistency', async () => {
  let capturedCall;
  await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({ analyzeImages: async (config, args) => { capturedCall = args; return passResult(); } }),
  }));
  assert.match(capturedCall.prompt, /별점\/후기 스타일의 연출용 그래픽은 일반적인 마케팅 관행이므로 문제로 지적하지 말 것/);
  assert.match(capturedCall.prompt, /이미지끼리 서로 다른 옵션\/색상을 표기하고 있지 않은가/);
});

test('reviewGeneratedImages sends the main image plus every detail image (as local file paths) to the provider, and includes options/price in the prompt', async () => {
  let capturedCall;
  await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getProviderImpl: () => ({
      analyzeImages: async (config, args) => { capturedCall = args; return passResult(); },
    }),
  }));
  assert.equal(capturedCall.images.length, 2);
  assert.equal(capturedCall.images[0].filePath, '/repo/public/generated-ai-images/drafts/8/main/manual/manual-r1-v1-coupang-1000x1000.jpg');
  assert.match(capturedCall.prompt, /폴딩 차량뒷좌석 멀티트레이/);
  assert.match(capturedCall.prompt, /색상: 멀티트레이\(블랙\)/);
  assert.match(capturedCall.prompt, /13070/);
});

test('reviewGeneratedImages omits the benchmark section and image when no naver research exists yet for the draft', async () => {
  let capturedCall;
  await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getMarketResearchImpl: async () => null,
    getProviderImpl: () => ({ analyzeImages: async (config, args) => { capturedCall = args; return passResult(); } }),
  }));
  assert.equal(capturedCall.images.length, 2); // main + 1 detail, no competitor thumbnail appended
  assert.doesNotMatch(capturedCall.prompt, /네이버 쇼핑 상위 판매자/);
});

test('reviewGeneratedImages includes the competitor title/price/thumbnail in the prompt and image list when naver research exists', async () => {
  let capturedCall;
  await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getMarketResearchImpl: async () => ({
      raw: { searchRaw: { items: [{ title: '<b>경쟁상품</b> 멀티트레이', mallName: '경쟁몰', lprice: '9900', image: 'https://example.com/competitor.jpg' }] } },
    }),
    getProviderImpl: () => ({ analyzeImages: async (config, args) => { capturedCall = args; return passResult(); } }),
  }));
  assert.equal(capturedCall.images.length, 3); // main + 1 detail + competitor thumbnail
  assert.equal(capturedCall.images[2].filePath, '/tmp/automoney-qa-competitor-fake.jpg');
  assert.match(capturedCall.prompt, /경쟁상품 멀티트레이/); // HTML-stripped
  assert.match(capturedCall.prompt, /경쟁몰/);
  assert.match(capturedCall.prompt, /9900원/);
  assert.match(capturedCall.prompt, /네이버 쇼핑 상위 판매자/);
});

test('reviewGeneratedImages still reviews using text-only benchmark info when the competitor thumbnail fails to download', async () => {
  let capturedCall;
  const result = await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getMarketResearchImpl: async () => ({
      raw: { searchRaw: { items: [{ title: '경쟁상품', mallName: '경쟁몰', lprice: '9900', image: 'https://example.com/dead.jpg' }] } },
    }),
    loadRemoteImageForVisionImpl: async () => { throw new Error('404'); },
    getProviderImpl: () => ({ analyzeImages: async (config, args) => { capturedCall = args; return passResult(); } }),
  }));
  assert.equal(capturedCall.images.length, 2); // competitor thumbnail dropped, main+detail still sent
  assert.equal(result.verdict, 'pass');
});

test('reviewGeneratedImages cleans up the downloaded competitor thumbnail after a successful review', async () => {
  let cleanupCalled = false;
  await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getMarketResearchImpl: async () => ({
      raw: { searchRaw: { items: [{ title: '경쟁상품', mallName: '경쟁몰', lprice: '9900', image: 'https://example.com/competitor.jpg' }] } },
    }),
    loadRemoteImageForVisionImpl: async () => ({ filePath: '/tmp/automoney-qa-competitor-fake.jpg', cleanup: async () => { cleanupCalled = true; } }),
    getProviderImpl: () => ({ analyzeImages: async () => passResult() }),
  }));
  assert.equal(cleanupCalled, true);
});

test('reviewGeneratedImages cleans up the downloaded competitor thumbnail even when the provider call throws', async () => {
  let cleanupCalled = false;
  await reviewGeneratedImages({}, '/repo', 8, commonDeps({
    getMarketResearchImpl: async () => ({
      raw: { searchRaw: { items: [{ title: '경쟁상품', mallName: '경쟁몰', lprice: '9900', image: 'https://example.com/competitor.jpg' }] } },
    }),
    loadRemoteImageForVisionImpl: async () => ({ filePath: '/tmp/automoney-qa-competitor-fake.jpg', cleanup: async () => { cleanupCalled = true; } }),
    getProviderImpl: () => ({ analyzeImages: async () => { throw new Error('rate limited'); } }),
  }));
  assert.equal(cleanupCalled, true);
});
