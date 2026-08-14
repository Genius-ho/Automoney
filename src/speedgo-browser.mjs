import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { findFirstVisible, SPEEDGO_SELECTORS } from './speedgo-selectors.mjs';

const SPEEDGO_HOME_URL = 'https://domemedb.domeggook.com/index/';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// Widened from 15s/5s on 2026-08-14: this Linux box is slower than the
// original Windows machine these were tuned on, and speedgo-registration.mjs
// now falls back to recoverRegistration()'s list-page lookup on timeout
// anyway, so a wider margin here only trades a few extra seconds of waiting
// for a better chance submitAndResolveIds() succeeds outright.
const SUBMISSION_TIMEOUT_MS = 30_000;
const TRANSFER_UI_TIMEOUT_MS = 12_000;
const TRANSFER_FRAME_POLL_MS = 100;
const POPUP_PRODUCT_URL = /^https:\/\/speedgo\.domeggook\.com\/popup_market\/popup_setProduct\.php(?:\?|$)/i;
const SPEEDGO_SUCCESS_LIST_URL = 'https://speedgo.domeggook.com/send/send_list.php?status=SUCCESS&types=';
const IDENTIFIER_MARKER = /originProductNo|channelProductNo|원상품\s*번호|채널상품\s*번호/i;
const RELEVANT_RESPONSE_URL = /speedgo|naver|smartstore|register|registration|product/i;
const SUPPORTED_IMAGE_TYPES = new Map([
  ['image/jpeg', { mimeType: 'image/jpeg', extension: 'jpg' }],
  ['image/jpg', { mimeType: 'image/jpeg', extension: 'jpg' }],
  ['image/pjpeg', { mimeType: 'image/jpeg', extension: 'jpg' }],
  ['image/png', { mimeType: 'image/png', extension: 'png' }],
  ['image/x-png', { mimeType: 'image/png', extension: 'png' }],
  ['image/webp', { mimeType: 'image/webp', extension: 'webp' }],
  ['image/gif', { mimeType: 'image/gif', extension: 'gif' }],
  ['image/bmp', { mimeType: 'image/bmp', extension: 'bmp' }],
]);

function speedgoError(code, message, page, extra = {}) {
  let url = 'unknown';
  try {
    url = page?.url?.() || url;
  } catch {
    // A stable code is more useful than a second error from a closed page.
  }
  return Object.assign(new Error(message), { code, url, ...extra });
}

function keepCodeOrMap(error, code, message, page) {
  if (error?.code === code) return error;
  return speedgoError(code, message, page, error?.selectorName ? { selectorName: error.selectorName } : {});
}

function primitiveId(value) {
  if ((typeof value === 'string' || typeof value === 'number') && /^\d+$/.test(String(value).trim())) {
    return String(value).trim();
  }
  return undefined;
}

function hasVerifiedOriginProductNo(ids) {
  return Boolean(ids?.originProductNo);
}

function channelProductNoFromSpeedgoSuccessEntries(entries, input) {
  const supplierProductNo = String(input?.supplierProductNo || '').trim();
  const productName = String(input?.productName || '').trim();
  const matches = new Set();
  for (const entry of entries || []) {
    if (String(entry?.supplierProductNo || '').trim() !== supplierProductNo) continue;
    if (String(entry?.productName || '').trim() !== productName) continue;
    if (!/전송완료/.test(String(entry?.statusText || ''))) continue;
    const match = String(entry?.itemChangeOnclick || '').match(
      /itemChange\(\s*['"]ss['"]\s*,\s*['"](\d+)['"]\s*,\s*['"](\d+)['"]/,
    );
    if (!match || match[1] !== supplierProductNo) continue;
    matches.add(match[2]);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function idsFromString(value) {
  const text = String(value);
  const originPatterns = [
    /originProductNo(?:%22|["']|\s)*(?:%3A|[:=\/])(?:%22|["']|\s)*(\d+)/i,
    /원상품\s*번호\s*[:=#]?\s*(\d+)/,
    /sell\.smartstore\.naver\.com\/products\/(\d+)/i,
    /\/origin-products?\/(\d+)/i,
  ];
  const channelPatterns = [
    /channelProductNo(?:%22|["']|\s)*(?:%3A|[:=\/])(?:%22|["']|\s)*(\d+)/i,
    /채널상품\s*번호\s*[:=#]?\s*(\d+)/,
    /\/channel-products?\/(\d+)/i,
  ];
  const result = {};
  for (const pattern of originPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.originProductNo = match[1];
      break;
    }
  }
  for (const pattern of channelPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.channelProductNo = match[1];
      break;
    }
  }
  return result;
}

export function extractNaverRegistrationIds(value) {
  if (typeof value === 'string' || typeof value === 'number') return idsFromString(value);
  if (!value || typeof value !== 'object') return {};

  const result = {};
  const seen = new WeakSet();
  const queue = [{ value, depth: 0 }];
  let visited = 0;

  while (queue.length && visited < 10_000) {
    const current = queue.shift();
    const item = current.value;
    if (!item || typeof item !== 'object' || seen.has(item) || current.depth > 25) continue;
    seen.add(item);
    visited += 1;

    for (const [key, child] of Object.entries(item)) {
      const normalizedKey = key.replace(/[^a-z]/gi, '').toLowerCase();
      if (!result.originProductNo && ['originproductno', 'originproductnumber'].includes(normalizedKey)) {
        result.originProductNo = primitiveId(child);
      }
      if (!result.channelProductNo && ['channelproductno', 'channelproductnumber', 'smartstorechannelproductno'].includes(normalizedKey)) {
        result.channelProductNo = primitiveId(child);
      }
      if (typeof child === 'string') {
        const fromString = idsFromString(child);
        result.originProductNo ||= fromString.originProductNo;
        result.channelProductNo ||= fromString.channelProductNo;
      } else if (child && typeof child === 'object') {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }

    if (result.originProductNo && result.channelProductNo) break;
  }

  if (!result.originProductNo) delete result.originProductNo;
  if (!result.channelProductNo) delete result.channelProductNo;
  return result;
}

// Windows drive-letter paths (e.g. C:\foo or C:/foo) are absolute on any host OS.
// node:path's isAbsolute is platform-specific and only recognizes these on win32,
// so detect them explicitly rather than relying on the host OS's path module.
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;

function resolvedFilePath(rootDir, value) {
  const stringValue = String(value);
  if (stringValue.startsWith('file:')) return fileURLToPath(stringValue);
  if (WINDOWS_DRIVE_PATH.test(stringValue)) return stringValue;
  return join(rootDir, stringValue.replace(/^[/\\]+/, ''));
}

function remoteImageError(message) {
  return Object.assign(new Error(message), { code: 'SPEEDGO_FORM_VALIDATION_FAILED' });
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === 'function') return response.headers.get(name);
  const headers = response?.headers || {};
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null;
}

async function readBoundedImageBody(response) {
  if (typeof response?.body?.getReader !== 'function') {
    throw remoteImageError('Remote image response did not expose a readable body');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw remoteImageError('Remote image exceeded the maximum allowed size');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) throw remoteImageError('Remote image was empty');
  return Buffer.concat(chunks, byteLength);
}

async function materializeImageInput(rootDir, value, { fetchImpl, kind, index }) {
  const stringValue = String(value);
  if (!/^https?:\/\//i.test(stringValue)) return resolvedFilePath(rootDir, stringValue);
  if (typeof fetchImpl !== 'function') throw remoteImageError('Remote image fetching is unavailable');

  const response = await fetchImpl(stringValue);
  if (!response?.ok) throw remoteImageError('Remote image request was not successful');

  const contentType = String(responseHeader(response, 'content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const imageType = SUPPORTED_IMAGE_TYPES.get(contentType);
  if (!imageType) throw remoteImageError('Remote image content type is not supported');

  const declaredLength = Number(responseHeader(response, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw remoteImageError('Remote image exceeded the maximum allowed size');
  }

  return {
    name: `${kind}-image-${index + 1}.${imageType.extension}`,
    mimeType: imageType.mimeType,
    buffer: await readBoundedImageBody(response),
  };
}

async function readLocatorValue(locator) {
  if (typeof locator.inputValue === 'function') {
    try {
      return await locator.inputValue();
    } catch {
      // Contenteditable fields do not expose inputValue().
    }
  }
  if (typeof locator.textContent === 'function') return (await locator.textContent()) || '';
  return '';
}

function comparableValue(value) {
  return String(value).replace(/,/g, '').trim();
}

function comparablePriceValue(value) {
  return comparableValue(value).replace(/\s*원\s*$/, '').trim();
}

async function fillAndVerify(page, selectorName, expected, locatorOverride, { exact = false } = {}) {
  const locator = locatorOverride || await findFirstVisible(page, selectorName, SPEEDGO_SELECTORS[selectorName]);
  await locator.fill(String(expected));
  const actual = await readLocatorValue(locator);
  const matches = exact
    ? String(actual) === String(expected)
    : comparableValue(actual) === comparableValue(expected);
  if (!matches) {
    throw speedgoError('SPEEDGO_FORM_VALIDATION_FAILED', `Speedgo field ${selectorName} did not retain its value`, page, { selectorName });
  }
  return locator;
}

async function setFilesAndVerify(page, selectorName, paths) {
  const locator = await findFirstVisible(page, selectorName, SPEEDGO_SELECTORS[selectorName]);
  await locator.setInputFiles(paths);
  const actual = await readLocatorValue(locator);
  if (!actual) {
    throw speedgoError('SPEEDGO_FORM_VALIDATION_FAILED', `Speedgo field ${selectorName} did not retain selected files`, page, { selectorName });
  }
}

async function collectResultLinkIds(page) {
  const links = page.locator('a[href]');
  const count = typeof links.count === 'function' ? await links.count() : 0;
  for (let index = 0; index < count; index += 1) {
    const href = await links.nth(index).getAttribute('href').catch(() => null);
    const ids = extractNaverRegistrationIds(href);
    if (hasVerifiedOriginProductNo(ids)) return ids;
  }
  return {};
}

async function waitForSuccessEvidence(page, isCancelled) {
  const attempts = Math.ceil(SUBMISSION_TIMEOUT_MS / 100);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isCancelled()) throw new Error('Speedgo success wait was cancelled');
    try {
      return await findFirstVisible(page, 'successEvidence', SPEEDGO_SELECTORS.successEvidence);
    } catch (error) {
      if (error?.code !== 'SPEEDGO_SELECTOR_NOT_FOUND') throw error;
    }
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(100);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Speedgo success evidence did not become visible');
}

async function findFirstPresent(page, selectorName, candidates) {
  for (const candidate of candidates) {
    if (candidate.kind !== 'css') continue;
    try {
      const locator = page.locator(candidate.value);
      const count = typeof locator.count === 'function' ? await locator.count() : 1;
      if (count > 0) return typeof locator.first === 'function' ? locator.first() : locator;
    } catch {
      // Try the next compatible structural candidate.
    }
  }
  throw speedgoError('SPEEDGO_SELECTOR_NOT_FOUND', `No Speedgo locator found for ${selectorName}`, page, { selectorName });
}

async function setSearchMode(locator, value) {
  await locator.evaluate((element, nextValue) => {
    element.value = nextValue;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(value));
}

async function waitForSupplierSearchResults(page) {
  if (typeof page.waitForURL === 'function') {
    await page.waitForURL(/\/index\/item\/supplyList\.php(?:\?|$)/i, {
      waitUntil: 'domcontentloaded',
      timeout: SUBMISSION_TIMEOUT_MS,
    });
    return;
  }
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(100);
}

async function waitForExactTransferButton(page) {
  const exactCandidate = SPEEDGO_SELECTORS.transferButton[0];
  try {
    let transfer = page.locator(exactCandidate.value);
    if (typeof transfer.first === 'function') transfer = transfer.first();
    await transfer.waitFor({ state: 'visible', timeout: TRANSFER_UI_TIMEOUT_MS });
    return transfer;
  } catch (error) {
    throw speedgoError(
      'SPEEDGO_TRANSFER_UI_NOT_FOUND',
      'The exact Speedgo product transfer action is unavailable',
      page,
      { selectorName: 'transferButton' },
    );
  }
}

function remainingDeadlineMs(deadline, nowImpl) {
  return Math.max(0, deadline - nowImpl());
}

async function withinDeadline(deadline, nowImpl, operation) {
  const remaining = remainingDeadlineMs(deadline, nowImpl);
  if (remaining <= 0) throw new Error('Speedgo popup acquisition timed out');
  let timeoutHandle;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(remaining)),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Speedgo popup acquisition timed out')),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function parsedPopupItemNo(frameUrl) {
  if (!POPUP_PRODUCT_URL.test(frameUrl)) return null;
  try {
    return new URL(frameUrl).searchParams.get('itemNo');
  } catch {
    return null;
  }
}

function isExactPopupFormAction(action) {
  if (action === 'mkt_marketIng.php') return true;
  try {
    const url = new URL(action, 'https://speedgo.domeggook.com/popup_market/');
    return url.origin === 'https://speedgo.domeggook.com'
      && url.pathname === '/market/mkt_marketIng.php';
  } catch {
    return false;
  }
}

async function waitForPopupProductForm(page, supplierProductNo, nowImpl) {
  const expectedItemNo = String(supplierProductNo || '').trim();
  if (!expectedItemNo) {
    throw speedgoError(
      'SPEEDGO_TRANSFER_UI_NOT_FOUND',
      'The selected Speedgo supplier product number is unavailable',
      page,
      { selectorName: 'popupProductForm' },
    );
  }

  const deadline = nowImpl() + TRANSFER_UI_TIMEOUT_MS;
  while (remainingDeadlineMs(deadline, nowImpl) > 0) {
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    const exactFrames = [];
    for (const frame of frames) {
      let frameUrl = '';
      try {
        frameUrl = frame.url();
      } catch {
        continue;
      }
      if (parsedPopupItemNo(frameUrl) !== expectedItemNo) continue;

      try {
        const form = frame.locator(SPEEDGO_SELECTORS.popupProductForm[0].value);
        const count = typeof form.count === 'function'
          ? await withinDeadline(deadline, nowImpl, () => form.count())
          : 1;
        const visible = count > 0 && (typeof form.isVisible !== 'function'
          || await withinDeadline(
            deadline,
            nowImpl,
            (remaining) => form.isVisible({ timeout: remaining }),
          ));
        const action = visible && typeof form.getAttribute === 'function'
          ? await withinDeadline(
            deadline,
            nowImpl,
            (remaining) => form.getAttribute('action', { timeout: remaining }),
          )
          : null;
        if (!visible || !isExactPopupFormAction(action)) continue;

        const itemNo = frame.locator(SPEEDGO_SELECTORS.popupProductItemNo[0].value);
        const itemCount = typeof itemNo.count === 'function'
          ? await withinDeadline(deadline, nowImpl, () => itemNo.count())
          : 1;
        if (itemCount !== 1 || typeof itemNo.inputValue !== 'function') continue;
        const formItemNo = await withinDeadline(
          deadline,
          nowImpl,
          (remaining) => itemNo.inputValue({ timeout: remaining }),
        );
        if (String(formItemNo).trim() === expectedItemNo) exactFrames.push(frame);
      } catch {
        // Matching frames can detach or be replaced while loading; retry within the same deadline.
      }
    }

    if (exactFrames.length > 1) {
      throw speedgoError(
        'SPEEDGO_AMBIGUOUS_PRODUCT',
        'More than one exact Speedgo popup product form was found',
        page,
        { selectorName: 'popupProductForm' },
      );
    }
    if (exactFrames.length === 1) return exactFrames[0];

    const pollMs = Math.min(
      TRANSFER_FRAME_POLL_MS,
      remainingDeadlineMs(deadline, nowImpl),
    );
    if (pollMs <= 0) break;
    if (typeof page.waitForTimeout === 'function') {
      await withinDeadline(deadline, nowImpl, () => page.waitForTimeout(pollMs));
    } else {
      await withinDeadline(
        deadline,
        nowImpl,
        () => new Promise((resolve) => setTimeout(resolve, pollMs)),
      );
    }
  }

  throw speedgoError(
    'SPEEDGO_TRANSFER_UI_NOT_FOUND',
    'The exact Speedgo popup product form did not become available',
    page,
    { selectorName: 'popupProductForm' },
  );
}

async function fillWithChange(scope, selectorName, expected, options) {
  const locator = await fillAndVerify(scope, selectorName, expected, undefined, options);
  await locator.dispatchEvent('change');
}

async function fillLiveNaverForm(scope, page, input) {
  const basePrice = Number(await scope.evaluate(() => Number(globalThis.a)));
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    throw speedgoError(
      'SPEEDGO_FORM_VALIDATION_FAILED',
      'The Speedgo source base price is not finite and positive',
      page,
      { selectorName: 'sourceBasePrice' },
    );
  }

  const targetPrice = Number(input?.salePrice);
  if (!Number.isFinite(targetPrice) || targetPrice < basePrice) {
    throw speedgoError(
      'SPEEDGO_FORM_VALIDATION_FAILED',
      'The Naver target sale price is invalid for the Speedgo source price',
      page,
      { selectorName: 'salePriceInput' },
    );
  }

  for (const [selectorName, value, options] of [
    ['liveProductNameInput', input.productName, { exact: true }],
    ['liveRateInput', 1, undefined],
    ['liveFeeInput', 0, undefined],
    ['liveAddPriceInput', targetPrice - basePrice, undefined],
    ['liveDeliveryPriceInput', 0, undefined],
    ['liveSellerDiscountInput', 0, undefined],
  ]) {
    await fillWithChange(scope, selectorName, value, options);
  }

  for (const candidate of SPEEDGO_SELECTORS.livePriceOutputs) {
    const output = await findFirstPresent(scope, 'priceOutputs', [candidate]);
    if (comparablePriceValue(await readLocatorValue(output)) !== comparablePriceValue(targetPrice)) {
      throw speedgoError(
        'SPEEDGO_FORM_VALIDATION_FAILED',
        'The Speedgo hidden price outputs did not match the target price',
        page,
        { selectorName: 'priceOutputs' },
      );
    }
  }

  const form = await findFirstVisible(
    scope,
    'popupProductForm',
    SPEEDGO_SELECTORS.popupProductForm,
  );
  const visibleText = typeof form.innerText === 'function' ? await form.innerText() : '';
  const expectedVisiblePrice = `${targetPrice.toLocaleString('en-US')}원`;
  if (!visibleText.includes(expectedVisiblePrice)) {
    throw speedgoError(
      'SPEEDGO_FORM_VALIDATION_FAILED',
      'The visible Speedgo price did not match the target price',
      page,
      { selectorName: 'visiblePriceText' },
    );
  }
}

async function visibleLocators(locator) {
  const count = typeof locator.count === 'function' ? await locator.count() : 1;
  const visible = [];
  for (let index = 0; index < count; index += 1) {
    const instance = typeof locator.nth === 'function' ? locator.nth(index) : locator;
    if (await instance.isVisible()) visible.push(instance);
  }
  return visible;
}

export function createSpeedgoBrowser({
  chromiumImpl,
  rootDir,
  fetchImpl = globalThis.fetch,
  nowImpl = Date.now,
  headless = false,
  profileDir = join(rootDir, '.playwright-profile'),
  sessionStatePath = join(profileDir, '.session-state.json'),
} = {}) {
  if (!chromiumImpl?.launchPersistentContext) throw new TypeError('chromiumImpl.launchPersistentContext is required');
  if (!rootDir) throw new TypeError('rootDir is required');
  if (typeof nowImpl !== 'function') throw new TypeError('nowImpl must be a function');

  let context = null;
  let page = null;
  let activeFormScope = null;
  let responseListener = null;
  let responseCaptureTail = Promise.resolve();
  let selectedSupplierProductNo = null;
  const capturedResponses = [];
  const responseWaiters = new Set();

  const signalResponse = (entry) => {
    for (const resolve of responseWaiters) resolve(entry);
    responseWaiters.clear();
  };

  const captureResponse = async (response) => {
    const headers = typeof response.headers === 'function' ? await response.headers() : {};
    const contentType = String(headers?.['content-type'] || headers?.['Content-Type'] || '');
    if (!/(?:application|text)\/(?:[\w.+-]*\+)?json\b/i.test(contentType)) return;

    const contentLength = Number(headers?.['content-length'] || headers?.['Content-Length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) return;

    const url = typeof response.url === 'function' ? response.url() : '';
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) return;
    if (!RELEVANT_RESPONSE_URL.test(url) && !IDENTIFIER_MARKER.test(body)) return;
    if (!IDENTIFIER_MARKER.test(url) && !IDENTIFIER_MARKER.test(body) && !RELEVANT_RESPONSE_URL.test(url)) return;

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return;
    }

    const entry = {
      jsonIds: extractNaverRegistrationIds(json),
      urlIds: extractNaverRegistrationIds(url),
    };
    capturedResponses.push(entry);
    if (hasVerifiedOriginProductNo(entry.jsonIds) || hasVerifiedOriginProductNo(entry.urlIds)) {
      signalResponse(entry);
    }
  };

  const startResponseCapture = () => {
    responseListener = (response) => {
      responseCaptureTail = responseCaptureTail
        .then(() => captureResponse(response))
        .catch(() => {});
    };
    page.on('response', responseListener);
  };

  const browser = {
    get page() { return page; },
    get context() { return context; },

    async open() {
      if (page) return page;
      context = await chromiumImpl.launchPersistentContext(profileDir, {
        headless,
        viewport: headless ? { width: 1600, height: 1000 } : null,
      });

      if (existsSync(sessionStatePath)) {
        const state = JSON.parse(await readFile(sessionStatePath, 'utf8'));
        if (Array.isArray(state.cookies) && state.cookies.length) await context.addCookies(state.cookies);
      }

      page = context.pages()[0] || await context.newPage();
      startResponseCapture();
      if (typeof page.goto === 'function') {
        await page.goto(SPEEDGO_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      return page;
    },

    async assertAuthenticated() {
      try {
        await findFirstVisible(page, 'loginEvidence', SPEEDGO_SELECTORS.loginEvidence);
        return true;
      } catch (error) {
        throw keepCodeOrMap(error, 'SPEEDGO_SESSION_EXPIRED', 'The saved Speedgo session is not authenticated', page);
      }
    },

    async findSupplierProduct(input) {
      try {
        const supplierProductNo = String(input?.supplierProductNo || '').trim();
        selectedSupplierProductNo = null;
        activeFormScope = null;
        const search = await findFirstVisible(page, 'searchInput', SPEEDGO_SELECTORS.searchInput);
        const searchMode = await findFirstPresent(page, 'searchModeInput', SPEEDGO_SELECTORS.searchModeInput);
        const searchSubmit = await findFirstVisible(page, 'searchSubmit', SPEEDGO_SELECTORS.searchSubmit);
        await setSearchMode(searchMode, 'no');
        await search.fill(supplierProductNo);
        const resultWait = waitForSupplierSearchResults(page);
        await Promise.all([resultWait, searchSubmit.click()]);

        const matches = page.getByText(supplierProductNo, { exact: true });
        const count = typeof matches.count === 'function' ? await matches.count() : 0;
        const visibleMatches = [];
        for (let index = 0; index < count; index += 1) {
          const match = matches.nth(index);
          if (await match.isVisible()) visibleMatches.push(match);
        }
        if (visibleMatches.length === 0) {
          throw speedgoError('SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND', 'No exact Speedgo supplier product match was found', page);
        }
        if (visibleMatches.length > 1) {
          throw speedgoError('SPEEDGO_AMBIGUOUS_PRODUCT', 'More than one exact Speedgo supplier product match was found', page);
        }
        const cards = page.locator('.sub_cont_bane1').filter({ hasText: supplierProductNo });
        const visibleCards = await visibleLocators(cards);
        if (visibleCards.length === 0) {
          throw speedgoError('SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND', 'The matching Speedgo supplier product card was not visible', page);
        }
        if (visibleCards.length > 1) {
          throw speedgoError('SPEEDGO_AMBIGUOUS_PRODUCT', 'More than one matching Speedgo supplier product card was visible', page);
        }

        const cardTriggerCandidates = visibleCards[0].locator('.bane_brd1[onclick*="itemInfo("]');
        const cardTriggers = await visibleLocators(cardTriggerCandidates);
        if (cardTriggers.length === 0) {
          throw speedgoError('SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND', 'The matching Speedgo supplier product card trigger was not visible', page);
        }
        if (cardTriggers.length > 1) {
          throw speedgoError('SPEEDGO_AMBIGUOUS_PRODUCT', 'More than one matching Speedgo supplier product card trigger was visible', page);
        }
        await cardTriggers[0].evaluate((element) => element.click());
        await waitForExactTransferButton(page);
        selectedSupplierProductNo = supplierProductNo;
        return true;
      } catch (error) {
        if (error?.code === 'SPEEDGO_AMBIGUOUS_PRODUCT' || error?.code === 'SPEEDGO_TRANSFER_UI_NOT_FOUND') throw error;
        throw keepCodeOrMap(error, 'SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND', 'The Speedgo supplier product could not be selected', page);
      }
    },

    async openSpeedgoTransfer() {
      try {
        const transfer = await findFirstVisible(page, 'transferButton', SPEEDGO_SELECTORS.transferButton);
        activeFormScope = null;
        await transfer.click();
        activeFormScope = await waitForPopupProductForm(
          page,
          selectedSupplierProductNo,
          nowImpl,
        );
        return true;
      } catch (error) {
        if (error?.code === 'SPEEDGO_AMBIGUOUS_PRODUCT') throw error;
        throw keepCodeOrMap(error, 'SPEEDGO_TRANSFER_UI_NOT_FOUND', 'The Speedgo transfer action is unavailable', page);
      }
    },

    async selectNaverMarket() {
      try {
        if (activeFormScope) {
          const form = await findFirstPresent(
            activeFormScope,
            'popupProductForm',
            SPEEDGO_SELECTORS.popupProductForm,
          );
          const marketState = await form.evaluate((formElement, naverId) => {
            const controls = [...formElement.querySelectorAll('input[type="checkbox"][id^="we"]')];
            const naverControl = controls.find((control) => control.id === naverId);
            if (!naverControl) return { found: false, checkedIds: [] };
            for (const control of controls) {
              const shouldBeChecked = control.id === naverId;
              if (control.checked === shouldBeChecked) continue;
              control.checked = shouldBeChecked;
              control.dispatchEvent(new Event('input', { bubbles: true }));
              control.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return {
              found: true,
              checkedIds: controls.filter((control) => control.checked).map((control) => control.id),
            };
          }, 'we1');
          if (!marketState?.found) {
            throw speedgoError(
              'SPEEDGO_TRANSFER_UI_NOT_FOUND',
              'The exact Naver Smartstore market checkbox is unavailable',
              page,
              { selectorName: 'naverMarket' },
            );
          }
          if (marketState.checkedIds.length !== 1 || marketState.checkedIds[0] !== 'we1') {
            throw speedgoError(
              'SPEEDGO_TRANSFER_UI_NOT_FOUND',
              'The Speedgo market selection did not resolve to only Naver Smartstore',
              page,
              { selectorName: 'naverMarket' },
            );
          }
          return true;
        }

        const market = await findFirstVisible(page, 'naverMarket', SPEEDGO_SELECTORS.naverMarket);
        if (typeof market.check === 'function') {
          const checked = typeof market.isChecked === 'function' && await market.isChecked();
          if (!checked) await market.check();
        } else {
          await market.click();
        }
        return true;
      } catch (error) {
        throw keepCodeOrMap(error, 'SPEEDGO_TRANSFER_UI_NOT_FOUND', 'The Naver Smartstore transfer option is unavailable', page);
      }
    },

    async fillNaverForm(input) {
      try {
        if (activeFormScope) {
          await fillLiveNaverForm(activeFormScope, page, input);
          return true;
        }

        const mainImage = await materializeImageInput(rootDir, input.mainImageUrl, {
          fetchImpl,
          kind: 'main',
          index: 0,
        });
        const detailImages = [];
        for (let index = 0; index < input.detailImageUrls.length; index += 1) {
          detailImages.push(await materializeImageInput(rootDir, input.detailImageUrls[index], {
            fetchImpl,
            kind: 'detail',
            index,
          }));
        }

        await fillAndVerify(page, 'productNameInput', input.productName);
        await fillAndVerify(page, 'salePriceInput', input.salePrice);
        await fillAndVerify(page, 'deliveryFeeInput', input.deliveryFee);
        await fillAndVerify(page, 'detailContentInput', input.detailContent);
        await setFilesAndVerify(page, 'mainImageInput', mainImage);
        await setFilesAndVerify(page, 'detailImageInput', detailImages);

        const options = input.options || [];
        if (options.length > 1) {
          const addOption = await findFirstVisible(page, 'addOptionButton', SPEEDGO_SELECTORS.addOptionButton);
          for (let index = 1; index < options.length; index += 1) await addOption.click();
        }
        for (let index = 0; index < options.length; index += 1) {
          const option = options[index];
          for (const [selectorName, value] of [
            ['optionGroupInput', option.groupName],
            ['optionNameInput', option.optionName],
            ['optionPriceInput', option.additionalPrice],
            ['optionStockInput', option.stockQuantity],
          ]) {
            const locator = await findFirstVisible(
              page,
              selectorName,
              SPEEDGO_SELECTORS[selectorName],
              { instanceIndex: index },
            );
            await fillAndVerify(page, selectorName, value, locator);
          }
        }
        return true;
      } catch (error) {
        throw keepCodeOrMap(error, 'SPEEDGO_FORM_VALIDATION_FAILED', 'The Naver transfer form could not be filled and verified', page);
      }
    },

    async preview() {
      const scope = activeFormScope || page;
      const selectors = activeFormScope
        ? SPEEDGO_SELECTORS.liveFinalSubmit
        : SPEEDGO_SELECTORS.finalSubmit;
      await findFirstVisible(scope, 'finalSubmit', selectors);
      return { ready: true, url: scope.url() };
    },

    async submitAndResolveIds() {
      const scope = activeFormScope || page;
      let submit;
      try {
        submit = await findFirstVisible(
          scope,
          'finalSubmit',
          activeFormScope ? SPEEDGO_SELECTORS.liveFinalSubmit : SPEEDGO_SELECTORS.finalSubmit,
        );
      } catch (error) {
        throw keepCodeOrMap(error, 'SPEEDGO_SUBMIT_FAILED', 'The final Speedgo submit control is unavailable', page);
      }

      const captureStart = capturedResponses.length;
      let outcomeSettled = false;
      let resolveResponse;
      const responseOutcome = new Promise((resolve) => { resolveResponse = resolve; });
      responseWaiters.add(resolveResponse);
      let timeoutHandle;
      const timeoutOutcome = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Speedgo submission outcome timed out')), SUBMISSION_TIMEOUT_MS);
      });
      const urlOutcome = typeof scope.waitForURL === 'function'
        ? scope.waitForURL(/(?:speedgo|naver|smartstore).*(?:result|complete|success)|(?:result|complete|success).*(?:speedgo|naver|smartstore)/i, { timeout: SUBMISSION_TIMEOUT_MS })
          .catch(() => new Promise(() => {}))
        : new Promise(() => {});

      try {
        await submit.click();
      } catch (error) {
        clearTimeout(timeoutHandle);
        responseWaiters.delete(resolveResponse);
        throw speedgoError('SPEEDGO_SUBMIT_FAILED', 'The final Speedgo submit click failed', page);
      }

      try {
        const successOutcome = waitForSuccessEvidence(scope, () => outcomeSettled)
          .catch(() => new Promise(() => {}));
        await Promise.race([responseOutcome, urlOutcome, successOutcome, timeoutOutcome]);
      } catch (error) {
        throw speedgoError('SPEEDGO_SUBMIT_FAILED', 'Speedgo did not expose a submission result', page);
      } finally {
        outcomeSettled = true;
        clearTimeout(timeoutHandle);
        responseWaiters.delete(resolveResponse);
      }

      await responseCaptureTail;
      for (const captured of capturedResponses.slice(captureStart)) {
        if (hasVerifiedOriginProductNo(captured.jsonIds)) return captured.jsonIds;
      }
      for (const captured of capturedResponses.slice(captureStart)) {
        if (hasVerifiedOriginProductNo(captured.urlIds)) return captured.urlIds;
      }
      for (const captured of capturedResponses.slice(captureStart)) {
        const combinedIds = {
          originProductNo: captured.jsonIds.originProductNo || captured.urlIds.originProductNo,
          channelProductNo: captured.jsonIds.channelProductNo || captured.urlIds.channelProductNo,
        };
        if (hasVerifiedOriginProductNo(combinedIds)) return combinedIds;
      }

      const urlIds = extractNaverRegistrationIds(scope.url());
      if (hasVerifiedOriginProductNo(urlIds)) return urlIds;

      try {
        const success = await findFirstVisible(scope, 'successEvidence', SPEEDGO_SELECTORS.successEvidence);
        const successIds = extractNaverRegistrationIds(await success.textContent());
        if (hasVerifiedOriginProductNo(successIds)) return successIds;
      } catch {
        // A URL transition can be the success evidence even without a status node.
      }

      const linkIds = await collectResultLinkIds(scope);
      if (hasVerifiedOriginProductNo(linkIds)) return linkIds;
      throw speedgoError('UNRESOLVED_EXTERNAL_RESULT', 'Speedgo appeared to submit but no Naver origin product number was verified', page);
    },

    async recoverRegistration(input) {
      const scope = activeFormScope || page;
      const urlIds = extractNaverRegistrationIds(scope.url());
      if (hasVerifiedOriginProductNo(urlIds)) return urlIds;

      try {
        const success = await findFirstVisible(scope, 'successEvidence', SPEEDGO_SELECTORS.successEvidence);
        const successIds = extractNaverRegistrationIds(await success.textContent());
        if (hasVerifiedOriginProductNo(successIds)) return successIds;
      } catch {
        // Recovery also supports result pages that expose identifiers only in links.
      }

      const linkIds = await collectResultLinkIds(scope);
      if (hasVerifiedOriginProductNo(linkIds)) return linkIds;

      try {
        await page.goto(SPEEDGO_SUCCESS_LIST_URL, {
          waitUntil: 'domcontentloaded',
          timeout: SUBMISSION_TIMEOUT_MS,
        });
        if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(1_000);
        const entries = await page.locator('input[name="item[]"]').evaluateAll((inputs) => inputs.map((input) => {
          const row = input.closest('tr');
          const nameInput = row?.querySelector('input[name^="itemName["]');
          const itemChange = row?.querySelector('a[onclick*="itemChange("]');
          return {
            supplierProductNo: input.value,
            productName: nameInput?.value,
            statusText: row?.innerText,
            itemChangeOnclick: itemChange?.getAttribute('onclick'),
          };
        }));
        const channelProductNo = channelProductNoFromSpeedgoSuccessEntries(entries, input);
        if (channelProductNo) return { channelProductNo };
      } catch {
        // Leave the reservation unresolved when the success list cannot prove one exact match.
      }
      throw speedgoError('UNRESOLVED_EXTERNAL_RESULT', 'No verified Naver origin product number was found during recovery', page);
    },

    async screenshot(path) {
      await page.screenshot({ path, fullPage: false });
      return path;
    },

    async close() {
      const closingContext = context;
      const closingPage = page;
      context = null;
      page = null;
      activeFormScope = null;
      selectedSupplierProductNo = null;
      if (!closingContext) return;

      if (responseListener && typeof closingPage?.off === 'function') {
        closingPage.off('response', responseListener);
      }
      responseListener = null;
      responseWaiters.clear();

      try {
        if (typeof closingContext.storageState === 'function') {
          await closingContext.storageState({ path: sessionStatePath });
        }
      } catch {
        // Closing the browser still takes priority if the session snapshot fails.
      } finally {
        await closingContext.close();
      }
    },
  };

  return browser;
}
