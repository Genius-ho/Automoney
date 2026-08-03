import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSpeedgoBrowser,
  extractNaverRegistrationIds,
} from '../src/speedgo-browser.mjs';

function fakeBrowserHarness({
  authenticated = true,
  exactProductMatches = 1,
  formReadbackMismatch = false,
  submitError = null,
  submitResponse = null,
  submitResponses = null,
  successText = '상품 등록 완료',
  resultLinks = [],
  exactProductVisibility,
  searchModeHidden = false,
  successUrlTransition,
} = {}) {
  const responseListeners = new Set();
  const values = new Map();
  const uploadedFiles = new Map();
  const calls = [];
  let submitClicks = 0;
  let cookiesAdded = null;
  let storageStatePath = null;
  let contextClosed = false;
  let searchSubmitted = false;
  const searchWaiters = [];
  const hasSuccessUrlTransition = successUrlTransition ?? Boolean(successText);
  const responsesAfterSubmit = submitResponses || (submitResponse
    ? [{ response: submitResponse, delayMs: 0 }]
    : []);

  const classify = ({ css, role, name, text, label }) => {
    const semanticText = String(name?.source || name || text?.source || text || label?.source || label || '');
    if (css === 'input[name="sw"]') return 'search';
    if (css === '#search_list input[name="sf"]' || css === 'input[name="sf"]') return 'searchMode';
    if (css === '#search_list button[type="submit"]') return 'searchSubmit';
    if (css === '.bane_brd1[onclick*="itemInfo("]') return 'cardTrigger';
    if (css === '.main_cont_btn1[onclick*="speedGoSend("]') return 'cardTransfer';
    if (css === 'a[href*="speedgo" i]') return 'globalSpeedgo';
    if (css === 'input[name="ss"]' || semanticText.includes('검색')) return 'search';
    if (semanticText.includes('로그아웃')) return 'login';
    if (semanticText.includes('스피드고') && semanticText.includes('전송')) return 'transfer';
    if (semanticText.includes('네이버') && semanticText.includes('스마트스토어')) return 'naver';
    if (semanticText.includes('상품명') || css?.includes('productName')) return 'productName';
    if (semanticText.includes('판매가') || css?.includes('salePrice')) return 'salePrice';
    if (semanticText.includes('배송비') || css?.includes('deliveryFee')) return 'deliveryFee';
    if (semanticText.includes('상세') || css?.includes('detailContent')) return 'detailContent';
    if (css?.includes('main') && css?.includes('file')) return 'mainImage';
    if (css?.includes('detail') && css?.includes('file')) return 'detailImage';
    if (semanticText.includes('옵션') && semanticText.includes('추가')) return 'addOption';
    if (css?.includes('optionGroup') || semanticText.includes('그룹') || semanticText.includes('분류')) return 'optionGroup';
    if (css?.includes('optionName') || semanticText.includes('옵션명') || semanticText.includes('옵션\\s*값')) return 'optionName';
    if (css?.includes('additionalPrice') || css?.includes('optionPrice') || semanticText.includes('금액') || semanticText.includes('가격')) return 'optionPrice';
    if (css?.includes('stockQuantity') || css?.includes('optionStock') || semanticText.includes('재고')) return 'optionStock';
    if ((semanticText.includes('등록') || semanticText.includes('전송'))
      && (semanticText.includes('완료') || semanticText.includes('성공'))) return 'success';
    if ((role === 'button' && semanticText.includes('등록')) || css?.includes('type="submit"')) return 'submit';
    if (css === 'a[href]') return 'links';
    return css || `${role}:${semanticText}`;
  };

  const visible = (concept) => {
    if (['searchMode', 'searchSubmit', 'cardTrigger', 'cardTransfer', 'globalSpeedgo'].includes(concept)) return true;
    if (concept === 'login') return authenticated;
    if (concept === 'success') return Boolean(successText);
    return ['search', 'transfer', 'naver', 'productName', 'salePrice', 'deliveryFee', 'detailContent', 'mainImage', 'detailImage', 'addOption', 'optionGroup', 'optionName', 'optionPrice', 'optionStock', 'submit', 'links'].includes(concept);
  };

  const makeLocator = (descriptor, item = null, fixedIndex = undefined, invalid = false) => {
    const concept = classify(descriptor);
    const valueKey = fixedIndex === undefined ? concept : `${concept}:${fixedIndex}`;
    const locator = {
      concept,
      first() { return makeLocator(descriptor, item, fixedIndex ?? 0, invalid); },
      nth(index) {
        if (concept === 'links') return makeLocator(descriptor, resultLinks[index]);
        if (fixedIndex !== undefined) return makeLocator(descriptor, item, fixedIndex, invalid || index !== 0);
        return makeLocator(descriptor, item, index);
      },
      count: async () => concept === 'links'
        ? resultLinks.length
        : ['optionGroup', 'optionName', 'optionPrice', 'optionStock'].includes(concept)
          ? 2
          : 1,
      isVisible: async () => !invalid && visible(concept),
      waitFor: async () => {
        if (invalid || !visible(concept)) throw new Error('not visible');
        calls.push(`waitFor:${concept}`);
      },
      fill: async (value) => {
        if (invalid) throw new Error('locator resolved to no elements');
        if (concept === 'searchMode' && searchModeHidden) {
          calls.push(`fillAttempt:${concept}:${value}`);
          throw new Error('Element is not actionable because it is hidden');
        }
        calls.push(`fill:${concept}:${value}`);
        values.set(valueKey, String(value));
      },
      evaluate: async (_callback, value) => {
        calls.push(`evaluate:${concept}:${value}`);
        values.set(valueKey, String(value));
        calls.push(`event:input:${concept}`);
        calls.push(`event:change:${concept}`);
      },
      inputValue: async () => {
        if (formReadbackMismatch && concept === 'productName') return 'wrong value';
        return values.get(valueKey) || '';
      },
      textContent: async () => concept === 'success' ? successText : values.get(valueKey) || '',
      setInputFiles: async (paths) => {
        const files = Array.isArray(paths) ? paths : [paths];
        uploadedFiles.set(concept, files);
        const displayFiles = files.map((file) => typeof file === 'string' ? file : file.name);
        calls.push(`files:${concept}:${displayFiles.join(',')}`);
        const firstName = typeof files[0] === 'string'
          ? files[0].split(/[\\/]/).at(-1)
          : files[0]?.name;
        values.set(valueKey, firstName ? `C:\\fakepath\\${firstName}` : '');
      },
      click: async () => {
        calls.push(`click:${concept}`);
        if (concept === 'searchSubmit') {
          searchSubmitted = true;
          while (searchWaiters.length) searchWaiters.shift()();
        }
        if (concept === 'submit') {
          submitClicks += 1;
          if (submitError) throw submitError;
          for (const { response, delayMs = 0 } of responsesAfterSubmit) {
            const emit = () => {
              for (const listener of responseListeners) listener(response);
            };
            if (delayMs > 0) setTimeout(emit, delayMs);
            else emit();
          }
        }
      },
      check: async () => calls.push(`check:${concept}`),
      isChecked: async () => false,
      press: async (key) => calls.push(`press:${concept}:${key}`),
      getAttribute: async (name) => name === 'href' ? item : null,
    };
    return locator;
  };

  const exactProductLocator = {
    count: async () => exactProductMatches,
    nth: (index) => ({
      isVisible: async () => exactProductVisibility?.[index] ?? true,
      click: async () => calls.push('click:product'),
    }),
  };

  const cardLocator = {
    count: async () => exactProductVisibility
      ? exactProductVisibility.filter(Boolean).length
      : exactProductMatches,
    nth: () => cardLocator,
    isVisible: async () => true,
    filter: () => cardLocator,
    locator: (css) => makeLocator({ css }),
  };

  const page = {
    goto: async (url) => calls.push(`goto:${url}`),
    url: () => hasSuccessUrlTransition
      ? 'https://domemedb.domeggook.com/speedgo/result'
      : searchSubmitted
        ? 'https://domemedb.domeggook.com/index/item/supplyList.php?sf=no&sw=49168396'
        : 'https://domemedb.domeggook.com/index/',
    locator: (css) => css === '.sub_cont_bane1' ? cardLocator : makeLocator({ css }),
    getByRole: (role, { name } = {}) => makeLocator({ role, name }),
    getByText: (text, options = {}) => {
      if (options.exact && /^\d+$/.test(String(text))) return exactProductLocator;
      return makeLocator({ text });
    },
    getByLabel: (label) => makeLocator({ label }),
    on: (event, listener) => {
      if (event === 'response') responseListeners.add(listener);
    },
    off: (event, listener) => {
      if (event === 'response') responseListeners.delete(listener);
    },
    waitForURL: async (pattern) => {
      calls.push(`waitForURL:${pattern}`);
      if (pattern?.toString().includes('supplyList') && !searchSubmitted) {
        await new Promise((resolve) => searchWaiters.push(resolve));
        return;
      }
      if (!hasSuccessUrlTransition) throw new Error('no success transition');
    },
    waitForTimeout: async () => {},
    screenshot: async ({ path }) => calls.push(`screenshot:${path}`),
  };

  const context = {
    pages: () => [page],
    newPage: async () => page,
    addCookies: async (cookies) => { cookiesAdded = cookies; },
    storageState: async ({ path }) => {
      storageStatePath = path;
      await writeFile(path, JSON.stringify({ cookies: [{ name: 'sid', value: 'saved' }] }));
    },
    close: async () => { contextClosed = true; },
  };

  const chromium = {
    launchPersistentContext: async (profileDir, options) => {
      calls.push({ profileDir, options });
      return context;
    },
  };

  return {
    chromium,
    calls,
    uploadedFiles,
    get submitClicks() { return submitClicks; },
    get cookiesAdded() { return cookiesAdded; },
    get storageStatePath() { return storageStatePath; },
    get contextClosed() { return contextClosed; },
  };
}

function imageResponse(content, {
  status = 200,
  contentType = 'image/jpeg',
  contentLength,
} = {}) {
  const buffer = Buffer.from(content);
  const headers = new Map([['content-type', contentType]]);
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) || null },
    body: new ReadableStream({
      start(controller) {
        if (buffer.length) controller.enqueue(buffer);
        controller.close();
      },
    }),
  };
}

function jsonResponse(value, { url = 'https://domemedb.domeggook.com/api/speedgo/naver/register' } = {}) {
  let textReads = 0;
  return {
    url: () => url,
    headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
    text: async () => {
      textReads += 1;
      return JSON.stringify(value);
    },
    get textReads() { return textReads; },
  };
}

test('extractNaverRegistrationIds finds ids in nested response JSON', () => {
  assert.deepEqual(
    extractNaverRegistrationIds({
      data: {
        originProductNo: '777',
        channelProducts: [{ channelProductNo: '888' }],
      },
    }),
    { originProductNo: '777', channelProductNo: '888' },
  );
});

test('extractNaverRegistrationIds recognizes URL and visible Korean result text without guessing unrelated numbers', () => {
  assert.deepEqual(
    extractNaverRegistrationIds('https://sell.smartstore.naver.com/products/777?channelProductNo=888'),
    { originProductNo: '777', channelProductNo: '888' },
  );
  assert.deepEqual(
    extractNaverRegistrationIds('원상품번호: 777 / 채널상품번호: 888'),
    { originProductNo: '777', channelProductNo: '888' },
  );
  assert.deepEqual(extractNaverRegistrationIds('주문 1234 처리 완료'), {});
});

test('open launches the persistent profile with the required viewport and restores session cookies', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'speedgo-browser-'));
  const profileDir = join(rootDir, '.playwright-profile');
  const sessionStatePath = join(profileDir, '.session-state.json');
  await mkdir(profileDir, { recursive: true });
  await writeFile(sessionStatePath, JSON.stringify({ cookies: [{ name: 'sid', value: 'session-only', domain: '.domeggook.com', path: '/' }] }));
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({
    chromiumImpl: harness.chromium,
    rootDir,
    headless: true,
    profileDir,
    sessionStatePath,
  });
  t.after(() => browser.close());

  await browser.open();

  assert.deepEqual(harness.calls[0], {
    profileDir,
    options: { headless: true, viewport: { width: 1600, height: 1000 } },
  });
  assert.deepEqual(harness.cookiesAdded, [{ name: 'sid', value: 'session-only', domain: '.domeggook.com', path: '/' }]);
});

test('assertAuthenticated maps missing login evidence to SPEEDGO_SESSION_EXPIRED', async (t) => {
  const harness = fakeBrowserHarness({ authenticated: false });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  await assert.rejects(browser.assertAuthenticated(), { code: 'SPEEDGO_SESSION_EXPIRED' });
});

test('findSupplierProduct maps zero and multiple exact matches at its boundary', async () => {
  for (const [exactProductMatches, code] of [
    [0, 'SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND'],
    [2, 'SPEEDGO_AMBIGUOUS_PRODUCT'],
  ]) {
    const harness = fakeBrowserHarness({ exactProductMatches });
    const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
    await browser.open();
    await assert.rejects(browser.findSupplierProduct({ supplierProductNo: '49168396' }), { code });
    await browser.close();
  }
});

test('findSupplierProduct follows the live product-number form and matching card flow', async () => {
  const harness = fakeBrowserHarness({
    exactProductMatches: 2,
    exactProductVisibility: [false, true],
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();

  await browser.findSupplierProduct({ supplierProductNo: '49168396' });

  const searchSubmitIndex = harness.calls.indexOf('click:searchSubmit');
  assert.equal(harness.calls.filter((call) => call === 'click:searchSubmit').length, 1);
  assert.ok(harness.calls.includes('fill:search:49168396'));
  assert.ok(harness.calls.includes('evaluate:searchMode:no'));
  assert.ok(harness.calls.includes('event:input:searchMode'));
  assert.ok(harness.calls.includes('event:change:searchMode'));
  assert.ok(harness.calls.some((call) => String(call).startsWith('waitForURL:') && String(call).includes('supplyList')));
  assert.ok(harness.calls.indexOf('click:cardTrigger') > searchSubmitIndex);
  assert.ok(harness.calls.includes('waitFor:cardTransfer'));
  assert.equal(harness.calls.includes('click:product'), false);

  await browser.openSpeedgoTransfer();
  assert.equal(harness.calls.includes('click:cardTransfer'), true);
  assert.equal(harness.calls.includes('click:globalSpeedgo'), false);
  await browser.close();
});

test('findSupplierProduct sets the hidden search mode through DOM semantics', async () => {
  const harness = fakeBrowserHarness({
    exactProductMatches: 1,
    searchModeHidden: true,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();

  await browser.findSupplierProduct({ supplierProductNo: '49168396' });

  assert.ok(harness.calls.includes('evaluate:searchMode:no'));
  assert.ok(harness.calls.includes('event:input:searchMode'));
  assert.ok(harness.calls.includes('event:change:searchMode'));
  assert.equal(harness.calls.some((call) => String(call).startsWith('fillAttempt:searchMode:')), false);
  assert.equal(harness.calls.includes('click:searchMode'), false);
  assert.equal(harness.calls.filter((call) => call === 'click:searchSubmit').length, 1);
  await browser.close();
});

test('transfer and market methods expose stable SPEEDGO_TRANSFER_UI_NOT_FOUND errors', async () => {
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();
  const originalGetByRole = browser.page.getByRole;
  browser.page.getByRole = () => ({ count: async () => 0, isVisible: async () => false, first() { return this; } });
  browser.page.getByText = browser.page.getByRole;
  browser.page.getByLabel = browser.page.getByRole;
  browser.page.locator = browser.page.getByRole;

  await assert.rejects(browser.openSpeedgoTransfer(), { code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND' });
  await assert.rejects(browser.selectNaverMarket(), { code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND' });
  browser.page.getByRole = originalGetByRole;
  await browser.close();
});

test('fillNaverForm fills and verifies required values and maps readback failures', async () => {
  const input = {
    productName: '테스트 상품',
    salePrice: 19800,
    deliveryFee: 3000,
    detailContent: '<p>상세</p>',
    mainImageUrl: '/generated/main.jpg',
    detailImageUrls: ['/generated/detail-1.jpg', '/generated/detail-2.jpg'],
    options: [],
  };
  const okHarness = fakeBrowserHarness();
  const okBrowser = createSpeedgoBrowser({ chromiumImpl: okHarness.chromium, rootDir: 'C:/repo' });
  await okBrowser.open();
  await okBrowser.fillNaverForm(input);
  assert.ok(okHarness.calls.includes('fill:productName:테스트 상품'));
  assert.ok(okHarness.calls.some((call) => typeof call === 'string' && call.startsWith('files:detailImage:')));
  await okBrowser.close();

  const badHarness = fakeBrowserHarness({ formReadbackMismatch: true });
  const badBrowser = createSpeedgoBrowser({ chromiumImpl: badHarness.chromium, rootDir: 'C:/repo' });
  await badBrowser.open();
  await assert.rejects(badBrowser.fillNaverForm(input), { code: 'SPEEDGO_FORM_VALIDATION_FAILED' });
  await badBrowser.close();
});

test('fillNaverForm materializes remote images as ordered safe Playwright file payloads', async (t) => {
  const remoteImages = new Map([
    ['https://images.test/main-source?token=main-secret', imageResponse('main-bytes', { contentType: 'image/jpeg' })],
    ['http://images.test/detail-one.png?token=detail-secret', imageResponse('detail-one', { contentType: 'image/png' })],
    ['https://images.test/detail-two.webp', imageResponse('detail-two', { contentType: 'image/webp' })],
  ]);
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({
    chromiumImpl: harness.chromium,
    rootDir: 'C:/repo',
    fetchImpl: async (url) => remoteImages.get(url),
  });
  t.after(() => browser.close());
  await browser.open();

  await browser.fillNaverForm({
    productName: 'test product',
    salePrice: 19800,
    deliveryFee: 3000,
    detailContent: '<p>detail</p>',
    mainImageUrl: 'https://images.test/main-source?token=main-secret',
    detailImageUrls: [
      'http://images.test/detail-one.png?token=detail-secret',
      'https://images.test/detail-two.webp',
    ],
    options: [],
  });

  assert.deepEqual(harness.uploadedFiles.get('mainImage'), [{
    name: 'main-image-1.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('main-bytes'),
  }]);
  assert.deepEqual(harness.uploadedFiles.get('detailImage'), [
    { name: 'detail-image-1.png', mimeType: 'image/png', buffer: Buffer.from('detail-one') },
    { name: 'detail-image-2.webp', mimeType: 'image/webp', buffer: Buffer.from('detail-two') },
  ]);
  assert.equal(
    [...harness.uploadedFiles.values()].flat().some((file) => typeof file === 'string' && /https?:/i.test(file)),
    false,
  );
});

test('fillNaverForm preserves absolute, root-relative, and file URL image paths', async (t) => {
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  await browser.fillNaverForm({
    productName: 'test product',
    salePrice: 19800,
    deliveryFee: 3000,
    detailContent: '<p>detail</p>',
    mainImageUrl: 'C:/assets/main.jpg',
    detailImageUrls: ['/generated/detail.jpg', 'file:///C:/assets/detail.jpg'],
    options: [],
  });

  assert.deepEqual(harness.uploadedFiles.get('mainImage'), ['C:/assets/main.jpg']);
  assert.deepEqual(harness.uploadedFiles.get('detailImage'), [
    'C:\\repo\\generated\\detail.jpg',
    'C:\\assets\\detail.jpg',
  ]);
});

test('fillNaverForm safely rejects invalid or oversized remote images before submit', async (t) => {
  const secretUrl = 'https://user:password@images.test/private.jpg?token=query-secret';
  const cases = [
    ['unsuccessful response', imageResponse('secret-response-body', { status: 403 })],
    ['non-image content type', imageResponse('secret-response-body', { contentType: 'text/plain' })],
    ['empty body', imageResponse('', { contentType: 'image/jpeg' })],
    ['declared oversized body', imageResponse('not-read', { contentLength: 25 * 1024 * 1024 + 1 })],
    ['streamed oversized body', imageResponse(Buffer.alloc(25 * 1024 * 1024 + 1), { contentType: 'image/png' })],
  ];

  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const harness = fakeBrowserHarness();
      const browser = createSpeedgoBrowser({
        chromiumImpl: harness.chromium,
        rootDir: 'C:/repo',
        fetchImpl: async () => response,
      });
      t.after(() => browser.close());
      await browser.open();

      let serializedError = '';
      await assert.rejects(browser.fillNaverForm({
        productName: 'test product',
        salePrice: 19800,
        deliveryFee: 3000,
        detailContent: '<p>detail</p>',
        mainImageUrl: secretUrl,
        detailImageUrls: ['/generated/detail.jpg'],
        options: [],
      }), (error) => {
        serializedError = JSON.stringify({ message: error.message, ...error });
        return error.code === 'SPEEDGO_FORM_VALIDATION_FAILED';
      });

      assert.doesNotMatch(serializedError, /password|query-secret|secret-response-body|not-read/);
      assert.equal(harness.submitClicks, 0);
      assert.equal(harness.uploadedFiles.has('mainImage'), false);
    });
  }
});

test('fillNaverForm addresses every option row from the unscoped locator collection', async (t) => {
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  await browser.fillNaverForm({
    productName: '테스트 상품',
    salePrice: 19800,
    deliveryFee: 3000,
    detailContent: '<p>상세</p>',
    mainImageUrl: '/generated/main.jpg',
    detailImageUrls: ['/generated/detail.jpg'],
    options: [
      { groupName: '색상', optionName: '검정', additionalPrice: 0, stockQuantity: 10 },
      { groupName: '색상', optionName: '흰색', additionalPrice: 500, stockQuantity: 20 },
    ],
  });

  assert.ok(harness.calls.includes('fill:optionName:검정'));
  assert.ok(harness.calls.includes('fill:optionName:흰색'));
});

test('browser preview never clicks the final submit candidate', async (t) => {
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  await browser.preview();

  assert.equal(harness.submitClicks, 0);
});

test('submitAndResolveIds captures nested JSON ids and clicks the final candidate exactly once', async (t) => {
  const response = jsonResponse({ data: { originProductNo: 777, channelProducts: [{ channelProductNo: 888 }] } });
  const harness = fakeBrowserHarness({ submitResponse: response });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  const result = await browser.submitAndResolveIds();

  assert.deepEqual(result, { originProductNo: '777', channelProductNo: '888' });
  assert.equal(harness.submitClicks, 1);
  assert.equal(response.textReads, 1);
});

test('submitAndResolveIds accepts a captured identifier response without a success URL transition', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    submitResponse: jsonResponse({ data: { originProductNo: '777', channelProductNo: '888' } }),
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  assert.deepEqual(await browser.submitAndResolveIds(), { originProductNo: '777', channelProductNo: '888' });
  assert.equal(harness.submitClicks, 1);
});

test('submitAndResolveIds ignores an earlier relevant response without ids', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    successUrlTransition: false,
    submitResponses: [
      { response: jsonResponse({ accepted: true }), delayMs: 0 },
      {
        response: jsonResponse({ data: { originProductNo: '777', channelProductNo: '888' } }),
        delayMs: 10,
      },
    ],
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  assert.deepEqual(await browser.submitAndResolveIds(), {
    originProductNo: '777',
    channelProductNo: '888',
  });
  assert.equal(harness.submitClicks, 1);
});

test('submitAndResolveIds accepts an origin-only response before a later complete response', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    successUrlTransition: false,
    submitResponses: [
      { response: jsonResponse({ data: { originProductNo: '777' } }), delayMs: 0 },
      {
        response: jsonResponse({ data: { originProductNo: '777', channelProductNo: '888' } }),
        delayMs: 10,
      },
    ],
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  assert.deepEqual(await browser.submitAndResolveIds(), { originProductNo: '777' });
  assert.equal(harness.submitClicks, 1);
});

test('submitAndResolveIds accepts a visible success transition on the same URL', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '상품 등록 완료 원상품번호: 777 / 채널상품번호: 888',
    successUrlTransition: false,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  assert.deepEqual(await browser.submitAndResolveIds(), { originProductNo: '777', channelProductNo: '888' });
  assert.equal(harness.submitClicks, 1);
});

test('submitAndResolveIds maps one failed click to SPEEDGO_SUBMIT_FAILED without retrying', async (t) => {
  const harness = fakeBrowserHarness({ submitError: new Error('detached') });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  await assert.rejects(browser.submitAndResolveIds(), { code: 'SPEEDGO_SUBMIT_FAILED' });
  assert.equal(harness.submitClicks, 1);
});

test('successful-looking submission without originProductNo is unresolved, not retried', async (t) => {
  const harness = fakeBrowserHarness({ submitResponse: jsonResponse({ data: { accepted: true } }) });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  await assert.rejects(browser.submitAndResolveIds(), { code: 'UNRESOLVED_EXTERNAL_RESULT' });
  assert.equal(harness.submitClicks, 1);
});

test('response capture ignores non-JSON response bodies', async (t) => {
  let textReads = 0;
  const response = {
    url: () => 'https://domemedb.domeggook.com/assets/speedgo-logo.png',
    headers: () => ({ 'content-type': 'image/png' }),
    text: async () => { textReads += 1; return 'originProductNo=999'; },
  };
  const harness = fakeBrowserHarness({ submitResponse: response });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  await assert.rejects(browser.submitAndResolveIds(), { code: 'UNRESOLVED_EXTERNAL_RESULT' });
  assert.equal(textReads, 0);
});

test('recoverRegistration resolves result links without clicking final submit', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    resultLinks: ['https://sell.smartstore.naver.com/products/777?channelProductNo=888'],
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  const result = await browser.recoverRegistration({ supplierProductNo: '49168396', productName: '테스트 상품' });

  assert.deepEqual(result, { originProductNo: '777', channelProductNo: '888' });
  assert.equal(harness.submitClicks, 0);
});

test('recoverRegistration accepts an origin-only result link', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    resultLinks: ['https://sell.smartstore.naver.com/products/777'],
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();

  assert.deepEqual(await browser.recoverRegistration({}), { originProductNo: '777' });
  assert.equal(harness.submitClicks, 0);
});

test('close persists session state, detaches response capture, and closes context', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'speedgo-close-'));
  const profileDir = join(rootDir, '.playwright-profile');
  const sessionStatePath = join(profileDir, '.session-state.json');
  await mkdir(profileDir, { recursive: true });
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir, profileDir, sessionStatePath });
  await browser.open();

  await browser.close();

  assert.equal(harness.storageStatePath, sessionStatePath);
  assert.equal(harness.contextClosed, true);
  assert.deepEqual(JSON.parse(await readFile(sessionStatePath, 'utf8')), { cookies: [{ name: 'sid', value: 'saved' }] });
});
