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
  cardTriggerPointerIntercepted = false,
  cardTransferDelayMs = 0,
  cardTriggerVisibility,
  cardTransferAvailable = true,
  semanticTransferAvailable = true,
  globalSpeedgoLink = true,
  globalDataActionControl = false,
  successUrlTransition,
  popupFrameAvailable = true,
  popupProductNo = '49168396',
  popupFormItemNo = popupProductNo,
  popupFrameUrlDelayTicks = 0,
  popupFormDelayTicks = 0,
  popupFormAction = 'mkt_marketIng.php',
  popupActionReadHang = false,
  popupBasePrice = 9500,
  popupPrecheckedMarkets = ['we1'],
  popupMarketsHidden = false,
  popupTitleReadback = null,
  popupHiddenPriceOverride = null,
  popupDecoratedPriceOutputs = false,
  popupVisiblePriceText = null,
  popupSuccessText = '',
  popupResultLinks = [],
  popupSuccessUrlTransition = false,
  popupSuccessDelayTicks = 1,
  popupRecoveryReady = false,
  popupExactSubmitAvailable = true,
  speedgoSuccessEntries = [],
} = {}) {
  const responseListeners = new Set();
  const values = new Map();
  const uploadedFiles = new Map();
  const calls = [];
  let submitClicks = 0;
  let cookiesAdded = null;
  let storageStatePath = null;
  let contextClosed = false;
  let cardActivated = false;
  let cardTransferReadyAt = 0;
  let searchSubmitted = false;
  let popupStarted = false;
  let popupTicks = 0;
  let popupSubmitted = false;
  let virtualNow = 0;
  const searchWaiters = [];
  const popupValues = new Map();
  const checkedMarkets = new Set(popupPrecheckedMarkets);
  const popupChangeEvents = [];
  const popupEvaluations = [];
  const popupEvaluationResults = [];
  const hasSuccessUrlTransition = successUrlTransition ?? Boolean(successText);
  const responsesAfterSubmit = submitResponses || (submitResponse
    ? [{ response: submitResponse, delayMs: 0 }]
    : []);

  const popupFormReady = () => popupStarted && popupTicks >= popupFormDelayTicks;
  const popupSuccessReady = () => popupRecoveryReady
    || (popupSubmitted && popupTicks >= popupSuccessDelayTicks);
  const popupFrameUrl = () => popupStarted && popupTicks >= popupFrameUrlDelayTicks
    ? `https://speedgo.domeggook.com/popup_market/popup_setProduct.php?itemNo=${popupProductNo}&mode=send`
    : `https://speedgo.domeggook.com/popup_market/popup_trans.php?itemNo=${popupProductNo}`;
  const updatePopupPrices = () => {
    const rate = Number(popupValues.get('ss_rate'));
    const fee = Number(popupValues.get('ss_fee'));
    const add = Number(popupValues.get('ss_addPrice'));
    const delivery = Number(popupValues.get('ss_delPrice'));
    const discount = Number(popupValues.get('ss_sellerDiscount'));
    if (![rate, fee, add, delivery, discount].every(Number.isFinite)) return;
    const computed = popupBasePrice * rate + fee + add + delivery - discount;
    for (const id of ['ss_storePrice', 'ss_disPrice', 'ss_realPrice', 'ss_discountPrice']) {
      popupValues.set(id, String(popupHiddenPriceOverride ?? computed));
    }
  };

  const classify = ({ css, role, name, text, label }) => {
    const semanticText = String(name?.source || name || text?.source || text || label?.source || label || '');
    if (css === 'input[name="sw"]') return 'search';
    if (css === '#search_list input[name="sf"]' || css === 'input[name="sf"]') return 'searchMode';
    if (css === '#search_list button[type="submit"]') return 'searchSubmit';
    if (css === '.bane_brd1[onclick*="itemInfo("]') return 'cardTrigger';
    if (css === '.main_cont_btn1[onclick*="speedGoSend("]') return 'cardTransfer';
    if (css === '#mkForm') return 'popupForm';
    if (css === '#mkForm input[name="itemNo"]') return 'popupItemNo';
    if (css === '#mkForm input[type="checkbox"][id^="we"]') return 'popupMarkets';
    if (css === '#ss_title') return 'ss_title';
    if (css === '#ss_rate') return 'ss_rate';
    if (css === '#ss_fee') return 'ss_fee';
    if (css === '#ss_addPrice') return 'ss_addPrice';
    if (css === '#ss_delPrice') return 'ss_delPrice';
    if (css === '#ss_sellerDiscount') return 'ss_sellerDiscount';
    if (css === '#ss_storePrice') return 'ss_storePrice';
    if (css === '#ss_disPrice') return 'ss_disPrice';
    if (css === '#ss_realPrice') return 'ss_realPrice';
    if (css === '#ss_discountPrice') return 'ss_discountPrice';
    if (css === '#sendBtn button.cont_btn1[onclick*="goProduct("]') return 'popupSubmit';
    if (css === 'input[name="item[]"]') return 'speedgoSuccessEntries';
    if (css === '[data-action="speedgo-transfer"], [data-action*="speedgo" i]') return 'globalDataAction';
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
    if (['searchMode', 'searchSubmit', 'cardTrigger'].includes(concept)) return true;
    if (concept === 'globalSpeedgo') return globalSpeedgoLink;
    if (concept === 'globalDataAction') return globalDataActionControl;
    if (concept === 'cardTransfer') return cardActivated && cardTransferAvailable && Date.now() >= cardTransferReadyAt;
    if (concept === 'login') return authenticated;
    if (concept === 'success') return Boolean(successText);
    if (concept === 'transfer') return semanticTransferAvailable;
    if (concept === 'popupForm') return popupFormReady();
    if (concept === 'popupMarkets') return popupFormReady() && !popupMarketsHidden;
    if (concept === 'popupItemNo' || concept.startsWith('ss_')) return popupFormReady();
    if (concept === 'popupSubmit') return popupFormReady() && popupExactSubmitAvailable;
    return ['search', 'naver', 'productName', 'salePrice', 'deliveryFee', 'detailContent', 'mainImage', 'detailImage', 'addOption', 'optionGroup', 'optionName', 'optionPrice', 'optionStock', 'submit', 'links'].includes(concept);
  };

  const makeLocator = (descriptor, item = null, fixedIndex = undefined, invalid = false, scope = 'page') => {
    const concept = classify(descriptor);
    const marketId = concept === 'popupMarkets'
      ? (item || ['we1', 'we2', 'we9', 'we10'][fixedIndex])
      : null;
    const valueKey = fixedIndex === undefined ? concept : `${concept}:${fixedIndex}`;
    const locator = {
      concept,
      first() { return makeLocator(descriptor, item, fixedIndex ?? 0, invalid, scope); },
      nth(index) {
        if (concept === 'links') {
          const links = scope === 'popup' ? popupResultLinks : resultLinks;
          return makeLocator(descriptor, links[index], index, false, scope);
        }
        if (concept === 'popupMarkets') {
          return makeLocator(descriptor, ['we1', 'we2', 'we9', 'we10'][index], index, false, scope);
        }
        if (fixedIndex !== undefined) return makeLocator(descriptor, item, fixedIndex, invalid || index !== 0, scope);
        return makeLocator(descriptor, item, index, false, scope);
      },
      count: async () => concept === 'links'
        ? (scope === 'popup' ? (popupSuccessReady() ? popupResultLinks.length : 0) : resultLinks.length)
        : concept === 'popupMarkets'
          ? 4
          : concept === 'popupForm'
            ? (popupFormReady() ? 1 : 0)
        : ['optionGroup', 'optionName', 'optionPrice', 'optionStock'].includes(concept)
          ? 2
          : 1,
      isVisible: async () => !invalid && (
        concept === 'success' && scope === 'popup'
          ? popupSuccessReady() && Boolean(popupSuccessText)
          : visible(concept)
      ),
      waitFor: async ({ timeout = 0 } = {}) => {
        const deadline = Date.now() + timeout;
        while (invalid || !visible(concept)) {
          if (timeout <= 0 || Date.now() >= deadline) throw new Error('not visible');
          await new Promise((resolve) => setTimeout(resolve, Math.min(5, deadline - Date.now())));
        }
        calls.push(`waitFor:${concept}`);
      },
      fill: async (value) => {
        if (invalid) throw new Error('locator resolved to no elements');
        if (concept === 'searchMode' && searchModeHidden) {
          calls.push(`fillAttempt:${concept}:${value}`);
          throw new Error('Element is not actionable because it is hidden');
        }
        calls.push(scope === 'popup' ? `fill:popup:${concept}:${value}` : `fill:${concept}:${value}`);
        if (scope === 'popup') popupValues.set(concept, String(value));
        else values.set(valueKey, String(value));
      },
      evaluate: async (_callback, value) => {
        calls.push(`evaluate:${concept}:${value}`);
        if (concept === 'popupForm' && scope === 'popup') {
          const elements = ['we1', 'we2', 'we9', 'we10'].map((id) => ({
            id,
            get checked() { return checkedMarkets.has(id); },
            set checked(next) {
              if (next) checkedMarkets.add(id);
              else checkedMarkets.delete(id);
            },
            dispatchEvent(event) {
              calls.push(`domEvent:${event.type}:popupMarket:${id}`);
              return true;
            },
          }));
          const form = {
            querySelectorAll: (selector) => selector === 'input[type="checkbox"][id^="we"]'
              ? elements
              : [],
          };
          return _callback(form, value);
        }
        if (concept === 'cardTrigger') {
          await _callback({ click: () => {
            cardActivated = true;
            cardTransferReadyAt = Date.now() + cardTransferDelayMs;
          } }, value);
        }
        values.set(valueKey, String(value));
        if (concept === 'searchMode') {
          calls.push(`event:input:${concept}`);
          calls.push(`event:change:${concept}`);
        }
      },
      evaluateAll: async () => concept === 'speedgoSuccessEntries' ? speedgoSuccessEntries : [],
      inputValue: async () => {
        if (formReadbackMismatch && concept === 'productName') return 'wrong value';
        if (concept === 'popupItemNo') return String(popupFormItemNo);
        if (concept === 'ss_title' && popupTitleReadback !== null) return popupTitleReadback;
        if (popupDecoratedPriceOutputs
          && ['ss_realPrice', 'ss_discountPrice'].includes(concept)) throw new Error('not an input');
        if (scope === 'popup') return popupValues.get(concept) || '';
        return values.get(valueKey) || '';
      },
      textContent: async () => {
        if (concept === 'success') return scope === 'popup'
          ? (popupSuccessReady() ? popupSuccessText : '')
          : successText;
        if (scope === 'popup' && popupDecoratedPriceOutputs
          && ['ss_realPrice', 'ss_discountPrice'].includes(concept)) {
          return `${Number(popupValues.get(concept)).toLocaleString('en-US')}원`;
        }
        return scope === 'popup' ? popupValues.get(concept) || '' : values.get(valueKey) || '';
      },
      innerText: async () => {
        if (concept !== 'popupForm') return '';
        if (popupVisiblePriceText !== null) return popupVisiblePriceText;
        const target = popupValues.get('ss_realPrice');
        return target ? `판매가 ${Number(target).toLocaleString('ko-KR')}원` : '';
      },
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
        calls.push(scope === 'popup' ? `click:popup:${concept}` : `click:${concept}`);
        if (concept === 'cardTrigger') {
          if (cardTriggerPointerIntercepted) throw new Error('pointer event intercepted by hover overlay');
          cardActivated = true;
          cardTransferReadyAt = Date.now() + cardTransferDelayMs;
        }
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
        if (concept === 'cardTransfer') popupStarted = true;
        if (concept === 'popupSubmit') {
          submitClicks += 1;
          popupSubmitted = true;
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
      check: async () => {
        if (concept === 'popupMarkets') {
          if (popupMarketsHidden) throw new Error('Element is not actionable because it is hidden');
          calls.push(`check:popupMarket:${marketId}`);
          checkedMarkets.add(marketId);
        } else {
          calls.push(`check:${concept}`);
        }
      },
      uncheck: async () => {
        if (concept === 'popupMarkets') {
          if (popupMarketsHidden) throw new Error('Element is not actionable because it is hidden');
          calls.push(`uncheck:popupMarket:${marketId}`);
          checkedMarkets.delete(marketId);
        } else {
          calls.push(`uncheck:${concept}`);
        }
      },
      isChecked: async () => concept === 'popupMarkets' ? checkedMarkets.has(marketId) : false,
      dispatchEvent: async (eventName) => {
        calls.push(`event:${eventName}:popup:${concept}`);
        popupChangeEvents.push(concept);
        if (eventName === 'change') updatePopupPrices();
      },
      press: async (key) => calls.push(`press:${concept}:${key}`),
      getAttribute: async (name) => {
        if (name === 'id' && concept === 'popupMarkets') return marketId;
        if (name === 'action' && concept === 'popupForm') {
          if (popupActionReadHang) return new Promise(() => {});
          return popupFormAction;
        }
        if (name === 'href') return item;
        return null;
      },
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
    locator: (css) => {
      if (css !== '.bane_brd1[onclick*="itemInfo("]') return makeLocator({ css });
      const visibility = cardTriggerVisibility || [true];
      const triggerLocator = {
        count: async () => visibility.length,
        nth: (index) => {
          const locator = makeLocator({ css }, null, index);
          locator.isVisible = async () => Boolean(visibility[index]);
          return locator;
        },
      };
      return triggerLocator;
    },
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
    waitForTimeout: async (timeout = 0) => {
      popupTicks += 1;
      virtualNow += timeout;
    },
    frames: () => popupFrameAvailable && popupStarted ? [popupFrame] : [],
    screenshot: async ({ path }) => calls.push(`screenshot:${path}`),
  };

  const popupFrame = {
    url: () => popupSuccessUrlTransition && popupSuccessReady()
      ? 'https://speedgo.domeggook.com/popup_market/success.php?originProductNo=777&channelProductNo=888'
      : popupFrameUrl(),
    locator: (css) => makeLocator({ css }, null, undefined, false, 'popup'),
    getByRole: (role, { name } = {}) => makeLocator({ role, name }, null, undefined, false, 'popup'),
    getByText: (text) => makeLocator({ text }, null, undefined, false, 'popup'),
    getByLabel: (label) => makeLocator({ label }, null, undefined, false, 'popup'),
    evaluate: async (callback) => {
      popupEvaluations.push(String(callback));
      popupEvaluationResults.push(popupBasePrice);
      return popupBasePrice;
    },
    waitForTimeout: async (timeout = 0) => {
      popupTicks += 1;
      virtualNow += timeout;
    },
    waitForURL: async (_pattern, { timeout = 0 } = {}) => {
      const start = virtualNow;
      while (!popupSuccessUrlTransition || !popupSuccessReady()) {
        if (virtualNow - start >= timeout) throw new Error('no popup success transition');
        popupTicks += 1;
        virtualNow += Math.min(100, timeout - (virtualNow - start));
        await Promise.resolve();
      }
    },
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
    popupValues,
    popupChangeEvents,
    popupEvaluations,
    popupEvaluationResults,
    popupFrame,
    now: () => virtualNow,
    get popupTicks() { return popupTicks; },
    get checkedMarkets() { return [...checkedMarkets].sort(); },
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

async function openLivePopup(browser) {
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });
  await browser.openSpeedgoTransfer();
}

function acquisitionFrame({
  urlItemNo,
  formItemNo = urlItemNo,
  formAction = 'mkt_marketIng.php',
} = {}) {
  const missing = {
    count: async () => 0,
    first() { return this; },
    isVisible: async () => false,
  };
  return {
    url: () => `https://speedgo.domeggook.com/popup_market/popup_setProduct.php?itemNo=${urlItemNo}`,
    locator: (css) => {
      if (css === '#mkForm') {
        return {
          count: async () => 1,
          isVisible: async () => true,
          getAttribute: async (name) => name === 'action' ? formAction : null,
        };
      }
      if (css === '#mkForm input[name="itemNo"]') {
        return {
          count: async () => 1,
          inputValue: async () => String(formItemNo),
        };
      }
      return missing;
    },
    getByRole: () => missing,
    getByText: () => missing,
    getByLabel: () => missing,
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
  assert.ok(harness.calls.indexOf('evaluate:cardTrigger:undefined') > searchSubmitIndex);
  assert.equal(harness.calls.includes('click:cardTrigger'), false);
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

test('findSupplierProduct activates the exact card through DOM click when pointer events are intercepted', async () => {
  const harness = fakeBrowserHarness({
    exactProductMatches: 1,
    cardTriggerPointerIntercepted: true,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();

  await browser.findSupplierProduct({ supplierProductNo: '49168396' });

  assert.ok(harness.calls.includes('evaluate:cardTrigger:undefined'));
  assert.equal(harness.calls.includes('click:cardTrigger'), false);
  assert.ok(harness.calls.includes('waitFor:cardTransfer'));
  await browser.close();
});

test('findSupplierProduct waits for the exact transfer control after delayed menu rendering', async () => {
  const harness = fakeBrowserHarness({
    exactProductMatches: 1,
    cardTransferDelayMs: 50,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();

  await browser.findSupplierProduct({ supplierProductNo: '49168396' });

  assert.ok(harness.calls.includes('evaluate:cardTrigger:undefined'));
  assert.ok(harness.calls.includes('waitFor:cardTransfer'));
  assert.equal(harness.calls.includes('click:cardTransfer'), false);
  assert.equal(harness.calls.includes('click:globalSpeedgo'), false);
  await browser.close();
});

test('findSupplierProduct rejects zero or multiple visible exact card triggers', async () => {
  for (const [cardTriggerVisibility, code] of [
    [[false], 'SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND'],
    [[true, true], 'SPEEDGO_AMBIGUOUS_PRODUCT'],
  ]) {
    const harness = fakeBrowserHarness({ cardTriggerVisibility });
    const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
    await browser.open();

    await assert.rejects(
      browser.findSupplierProduct({ supplierProductNo: '49168396' }),
      { code },
    );
    assert.equal(harness.calls.includes('evaluate:cardTrigger:undefined'), false);
    await browser.close();
  }
});

test('findSupplierProduct does not use the global Speedgo link when the exact transfer control is absent', async () => {
  const harness = fakeBrowserHarness({
    cardTransferAvailable: false,
    semanticTransferAvailable: false,
    globalSpeedgoLink: true,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();

  await assert.rejects(
    browser.findSupplierProduct({ supplierProductNo: '49168396' }),
    { code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND' },
  );
  assert.equal(harness.calls.includes('click:globalSpeedgo'), false);
  await browser.close();
});

test('openSpeedgoTransfer does not use the global Speedgo link when the exact transfer control is absent', async () => {
  const harness = fakeBrowserHarness({
    cardTransferAvailable: false,
    semanticTransferAvailable: false,
    globalSpeedgoLink: true,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();

  await assert.rejects(browser.openSpeedgoTransfer(), { code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND' });
  assert.equal(harness.calls.includes('click:globalSpeedgo'), false);
  await browser.close();
});

test('findSupplierProduct does not use a broad data-action control when the exact transfer control is absent', async () => {
  const harness = fakeBrowserHarness({
    cardTransferAvailable: false,
    semanticTransferAvailable: false,
    globalSpeedgoLink: false,
    globalDataActionControl: true,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();

  await assert.rejects(
    browser.findSupplierProduct({ supplierProductNo: '49168396' }),
    { code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND' },
  );
  assert.equal(harness.calls.includes('click:globalDataAction'), false);
  await browser.close();
});

test('openSpeedgoTransfer does not use a broad data-action control when the exact transfer control is absent', async () => {
  const harness = fakeBrowserHarness({
    cardTransferAvailable: false,
    semanticTransferAvailable: false,
    globalSpeedgoLink: false,
    globalDataActionControl: true,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();

  await assert.rejects(browser.openSpeedgoTransfer(), { code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND' });
  assert.equal(harness.calls.includes('click:globalDataAction'), false);
  await browser.close();
});

test('openSpeedgoTransfer waits for the delayed exact popup frame and form readiness', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    popupFrameUrlDelayTicks: 2,
    popupFormDelayTicks: 4,
    popupPrecheckedMarkets: [],
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());

  await openLivePopup(browser);
  await browser.selectNaverMarket();

  assert.equal(harness.calls.filter((call) => call === 'click:cardTransfer').length, 1);
  assert.equal(harness.calls.filter((call) => call === 'check:popupMarket:we1').length, 0);
  assert.deepEqual(harness.checkedMarkets, ['we1']);
});

test('openSpeedgoTransfer ignores a lingering other-product frame and binds the selected item in URL and form', async (t) => {
  const harness = fakeBrowserHarness({ popupProductNo: '49168396', popupFormItemNo: '49168396' });
  const browser = createSpeedgoBrowser({
    chromiumImpl: harness.chromium,
    rootDir: 'C:/repo',
    nowImpl: harness.now,
  });
  t.after(() => browser.close());
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });
  const staleFrame = acquisitionFrame({ urlItemNo: '53209521', formItemNo: '53209521' });
  browser.page.frames = () => [staleFrame, harness.popupFrame];

  await browser.openSpeedgoTransfer();
  const preview = await browser.preview();

  assert.match(preview.url, /itemNo=49168396/);
  assert.equal(harness.submitClicks, 0);
});

test('openSpeedgoTransfer accepts the exact live absolute Speedgo form action', async (t) => {
  const harness = fakeBrowserHarness({
    popupFormAction: 'https://speedgo.domeggook.com/market/mkt_marketIng.php',
  });
  const browser = createSpeedgoBrowser({
    chromiumImpl: harness.chromium,
    rootDir: 'C:/repo',
    nowImpl: harness.now,
  });
  t.after(() => browser.close());
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });

  await browser.openSpeedgoTransfer();

  assert.match((await browser.preview()).url, /itemNo=49168396/);
  assert.equal(harness.submitClicks, 0);
});

test('openSpeedgoTransfer rejects URL and form itemNo disagreement for the selected product', async (t) => {
  const harness = fakeBrowserHarness({ popupProductNo: '49168396', popupFormItemNo: '53209521' });
  const browser = createSpeedgoBrowser({
    chromiumImpl: harness.chromium,
    rootDir: 'C:/repo',
    nowImpl: harness.now,
  });
  t.after(() => browser.close());
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });

  await assert.rejects(browser.openSpeedgoTransfer(), {
    code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND',
    selectorName: 'popupProductForm',
  });
  assert.equal(harness.submitClicks, 0);
});

test('openSpeedgoTransfer rejects multiple exact popup candidates as ambiguous', async (t) => {
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });
  const duplicate = { ...harness.popupFrame };
  browser.page.frames = () => [harness.popupFrame, duplicate];

  await assert.rejects(browser.openSpeedgoTransfer(), {
    code: 'SPEEDGO_AMBIGUOUS_PRODUCT',
  });
  assert.equal(harness.submitClicks, 0);
});

test('openSpeedgoTransfer retries a detached exact frame and binds its exact replacement', async (t) => {
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });
  const detached = acquisitionFrame({ urlItemNo: '49168396' });
  const detachedLocator = detached.locator;
  detached.locator = (css) => {
    const locator = detachedLocator(css);
    if (css === '#mkForm') {
      locator.getAttribute = async () => { throw new Error('frame detached'); };
    }
    return locator;
  };
  let scans = 0;
  browser.page.frames = () => (++scans === 1 ? [detached] : [harness.popupFrame]);

  await browser.openSpeedgoTransfer();

  assert.match((await browser.preview()).url, /itemNo=49168396/);
  assert.ok(scans >= 2);
  assert.equal(harness.submitClicks, 0);
});

test('openSpeedgoTransfer fails safely when the exact popup form never becomes ready', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    popupFrameAvailable: false,
  });
  const browser = createSpeedgoBrowser({
    chromiumImpl: harness.chromium,
    rootDir: 'C:/repo',
    nowImpl: harness.now,
  });
  t.after(() => browser.close());
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });

  await assert.rejects(browser.openSpeedgoTransfer(), (error) => {
    assert.equal(error.code, 'SPEEDGO_TRANSFER_UI_NOT_FOUND');
    assert.equal(error.selectorName, 'popupProductForm');
    assert.match(error.url, /\/index\/item\/supplyList\.php/);
    return true;
  });

  assert.equal(harness.calls.filter((call) => call === 'click:cardTransfer').length, 1);
  assert.equal(harness.submitClicks, 0);
  assert.equal(harness.popupTicks, 120);
});

test('openSpeedgoTransfer rejects a popup frame whose form action is not mkt_marketIng.php', async (t) => {
  const harness = fakeBrowserHarness({ popupFormAction: 'unexpected.php' });
  const browser = createSpeedgoBrowser({
    chromiumImpl: harness.chromium,
    rootDir: 'C:/repo',
    nowImpl: harness.now,
  });
  t.after(() => browser.close());
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });

  await assert.rejects(browser.openSpeedgoTransfer(), {
    code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND',
    selectorName: 'popupProductForm',
  });
  assert.equal(harness.calls.filter((call) => call === 'click:cardTransfer').length, 1);
  assert.equal(harness.submitClicks, 0);
});

test('openSpeedgoTransfer bounds a hanging form action read by the one twelve-second deadline', async (t) => {
  const harness = fakeBrowserHarness({ popupActionReadHang: true });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await browser.open();
  await browser.findSupplierProduct({ supplierProductNo: '49168396' });
  const startedAt = Date.now();

  await assert.rejects(
    Promise.race([
      browser.openSpeedgoTransfer(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('adapter exceeded bounded deadline')), 12_750)),
    ]),
    { code: 'SPEEDGO_TRANSFER_UI_NOT_FOUND', selectorName: 'popupProductForm' },
  );

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 10_800 && elapsedMs < 12_750, `elapsed ${elapsedMs}ms`);
  assert.equal(harness.submitClicks, 0);
});

test('selectNaverMarket handles hidden markets through exact-form DOM state and events', async (t) => {
  const harness = fakeBrowserHarness({
    popupPrecheckedMarkets: ['we2', 'we9', 'we10'],
    popupMarketsHidden: true,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  await browser.selectNaverMarket();

  assert.deepEqual(harness.checkedMarkets, ['we1']);
  assert.equal(harness.calls.some((call) => /^(?:uncheck|check):popupMarket:/.test(String(call))), false);
  assert.deepEqual(
    harness.calls.filter((call) => String(call).startsWith('domEvent:')),
    [
      'domEvent:input:popupMarket:we1',
      'domEvent:change:popupMarket:we1',
      'domEvent:input:popupMarket:we2',
      'domEvent:change:popupMarket:we2',
      'domEvent:input:popupMarket:we9',
      'domEvent:change:popupMarket:we9',
      'domEvent:input:popupMarket:we10',
      'domEvent:change:popupMarket:we10',
    ],
  );
  assert.equal(harness.submitClicks, 0);
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
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: '/repo' });
  t.after(() => browser.close());
  await browser.open();

  await browser.fillNaverForm({
    productName: 'test product',
    salePrice: 19800,
    deliveryFee: 3000,
    detailContent: '<p>detail</p>',
    mainImageUrl: 'C:/assets/main.jpg',
    detailImageUrls: ['/generated/detail.jpg', 'file:///repo/assets/detail.jpg'],
    options: [],
  });

  assert.deepEqual(harness.uploadedFiles.get('mainImage'), ['C:/assets/main.jpg']);
  assert.deepEqual(harness.uploadedFiles.get('detailImage'), [
    '/repo/generated/detail.jpg',
    '/repo/assets/detail.jpg',
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

test('fillNaverForm uses literal base 9500 and target 39900 in the exact live popup controls', async (t) => {
  let imageFetches = 0;
  const harness = fakeBrowserHarness({
    popupBasePrice: 9500,
    popupVisiblePriceText: '판매가 39,900원',
  });
  const browser = createSpeedgoBrowser({
    chromiumImpl: harness.chromium,
    rootDir: 'C:/repo',
    fetchImpl: async () => {
      imageFetches += 1;
      throw new Error('live popup path must not fetch images');
    },
  });
  t.after(() => browser.close());
  await openLivePopup(browser);

  await browser.fillNaverForm({
    productName: '드래프트 119 상품',
    salePrice: 39900,
    mainImageUrl: 'https://images.test/main.jpg',
    detailImageUrls: ['https://images.test/detail.jpg'],
    detailContent: '',
    options: [{ groupName: '색상', optionName: '검정', additionalPrice: 0, stockQuantity: 10 }],
  });

  assert.equal(imageFetches, 0);
  assert.deepEqual(harness.popupEvaluationResults, [9500]);
  assert.match(harness.popupEvaluations[0], /globalThis\.a/);
  assert.equal(harness.uploadedFiles.size, 0);
  assert.equal(harness.calls.some((call) => String(call).startsWith('files:')), false);
  assert.equal(harness.calls.some((call) => /^fill:(?:detailContent|option)/.test(String(call))), false);
  assert.equal(harness.calls.includes('click:addOption'), false);
  assert.deepEqual(
    Object.fromEntries([
      'ss_title',
      'ss_rate',
      'ss_fee',
      'ss_addPrice',
      'ss_delPrice',
      'ss_sellerDiscount',
      'ss_storePrice',
      'ss_disPrice',
      'ss_realPrice',
      'ss_discountPrice',
    ].map((key) => [key, harness.popupValues.get(key)])),
    {
      ss_title: '드래프트 119 상품',
      ss_rate: '1',
      ss_fee: '0',
      ss_addPrice: '30400',
      ss_delPrice: '0',
      ss_sellerDiscount: '0',
      ss_storePrice: '39900',
      ss_disPrice: '39900',
      ss_realPrice: '39900',
      ss_discountPrice: '39900',
    },
  );
  assert.deepEqual(harness.popupChangeEvents, [
    'ss_title',
    'ss_rate',
    'ss_fee',
    'ss_addPrice',
    'ss_delPrice',
    'ss_sellerDiscount',
  ]);
  assert.deepEqual(
    harness.calls.filter((call) => String(call).startsWith('fill:popup:ss_')),
    [
      'fill:popup:ss_title:드래프트 119 상품',
      'fill:popup:ss_rate:1',
      'fill:popup:ss_fee:0',
      'fill:popup:ss_addPrice:30400',
      'fill:popup:ss_delPrice:0',
      'fill:popup:ss_sellerDiscount:0',
    ],
  );
});

test('fillNaverForm rejects popup title punctuation loss with exact string readback', async (t) => {
  const harness = fakeBrowserHarness({
    popupTitleReadback: 'AB',
    popupVisiblePriceText: '판매가 39,900원',
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  await assert.rejects(
    browser.fillNaverForm({ productName: 'A,B', salePrice: 39900 }),
    {
      code: 'SPEEDGO_FORM_VALIDATION_FAILED',
      selectorName: 'liveProductNameInput',
    },
  );
  assert.equal(harness.submitClicks, 0);
});

test('fillNaverForm accepts live div price outputs formatted with a comma and won suffix', async (t) => {
  const harness = fakeBrowserHarness({ popupDecoratedPriceOutputs: true });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  await browser.fillNaverForm({
    productName: '드래프트 119 상품',
    salePrice: 39900,
  });

  assert.equal(harness.submitClicks, 0);
});

test('fillNaverForm rejects invalid live base and target prices without guessing or clamping', async (t) => {
  for (const [name, popupBasePrice, salePrice, selectorName] of [
    ['non-finite base', Number.NaN, 39900, 'sourceBasePrice'],
    ['zero base', 0, 39900, 'sourceBasePrice'],
    ['negative base', -1, 39900, 'sourceBasePrice'],
    ['non-finite target', 9500, Number.POSITIVE_INFINITY, 'salePriceInput'],
    ['target below base', 9500, 9499, 'salePriceInput'],
  ]) {
    await t.test(name, async () => {
      const harness = fakeBrowserHarness({ popupBasePrice });
      const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
      await openLivePopup(browser);

      await assert.rejects(
        browser.fillNaverForm({ productName: '드래프트 119 상품', salePrice }),
        { code: 'SPEEDGO_FORM_VALIDATION_FAILED', selectorName },
      );

      assert.equal(harness.calls.some((call) => String(call).startsWith('fill:popup:ss_')), false);
      assert.equal(harness.submitClicks, 0);
      await browser.close();
    });
  }
});

test('fillNaverForm rejects hidden or visible popup price mismatches', async (t) => {
  for (const [name, options, selectorName] of [
    ['hidden outputs', { popupHiddenPriceOverride: 39899 }, 'priceOutputs'],
    ['visible price text', { popupVisiblePriceText: '판매가 39,899원' }, 'visiblePriceText'],
    ['visible price missing comma', { popupVisiblePriceText: '판매가 39900원' }, 'visiblePriceText'],
    ['visible price missing won suffix', { popupVisiblePriceText: '판매가 39,900' }, 'visiblePriceText'],
  ]) {
    await t.test(name, async () => {
      const harness = fakeBrowserHarness(options);
      const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
      await openLivePopup(browser);

      await assert.rejects(
        browser.fillNaverForm({ productName: '드래프트 119 상품', salePrice: 39900 }),
        { code: 'SPEEDGO_FORM_VALIDATION_FAILED', selectorName },
      );

      assert.equal(harness.submitClicks, 0);
      await browser.close();
    });
  }
});

test('live popup preview finds only the exact final control and performs zero clicks', async (t) => {
  const harness = fakeBrowserHarness({ globalDataActionControl: true });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  const preview = await browser.preview();

  assert.equal(preview.ready, true);
  assert.match(preview.url, /popup_setProduct\.php/);
  assert.equal(harness.submitClicks, 0);
  assert.equal(harness.calls.some((call) => String(call).startsWith('click:popup:popupSubmit')), false);
  assert.equal(harness.calls.includes('click:globalDataAction'), false);
});

test('live popup preview rejects broad final controls when the exact control is absent', async (t) => {
  const harness = fakeBrowserHarness({ popupExactSubmitAvailable: false });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  await assert.rejects(browser.preview(), {
    code: 'SPEEDGO_SELECTOR_NOT_FOUND',
    selectorName: 'finalSubmit',
  });

  assert.equal(harness.submitClicks, 0);
  assert.equal(harness.calls.some((call) => String(call).startsWith('click:popup:')), false);
});

test('live popup submit clicks the exact final control once and keeps top-page response capture', async (t) => {
  const response = jsonResponse({ data: { originProductNo: 777, channelProducts: [{ channelProductNo: 888 }] } });
  const harness = fakeBrowserHarness({
    successText: '',
    submitResponse: response,
    globalDataActionControl: true,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  const result = await browser.submitAndResolveIds();

  assert.deepEqual(result, { originProductNo: '777', channelProductNo: '888' });
  assert.equal(harness.submitClicks, 1);
  assert.equal(harness.calls.filter((call) => call === 'click:popup:popupSubmit').length, 1);
  assert.equal(harness.calls.includes('click:globalDataAction'), false);
  assert.equal(response.textReads, 1);
});

test('live popup success URL appears only after one exact submit and resolves identifiers', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    successUrlTransition: false,
    popupSuccessUrlTransition: true,
    popupSuccessDelayTicks: 3,
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  assert.match(harness.popupFrame.url(), /popup_setProduct\.php/);
  assert.doesNotMatch(harness.popupFrame.url(), /originProductNo/);

  assert.deepEqual(await browser.submitAndResolveIds(), {
    originProductNo: '777',
    channelProductNo: '888',
  });
  assert.equal(harness.submitClicks, 1);
  assert.equal(harness.calls.filter((call) => call === 'click:popup:popupSubmit').length, 1);
  assert.match(harness.popupFrame.url(), /success\.php/);
});

test('live popup submit rejects broad final controls when the exact control is absent', async (t) => {
  const harness = fakeBrowserHarness({ popupExactSubmitAvailable: false });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  await assert.rejects(browser.submitAndResolveIds(), {
    code: 'SPEEDGO_SUBMIT_FAILED',
    selectorName: 'finalSubmit',
  });

  assert.equal(harness.submitClicks, 0);
  assert.equal(harness.calls.some((call) => String(call).startsWith('click:popup:')), false);
});

test('live popup success and recovery inspect the active frame while screenshots stay on the top page', async (t) => {
  const successHarness = fakeBrowserHarness({
    successText: '',
    successUrlTransition: false,
    popupSuccessText: '상품 등록 완료 원상품번호: 777 / 채널상품번호: 888',
  });
  const successBrowser = createSpeedgoBrowser({ chromiumImpl: successHarness.chromium, rootDir: 'C:/repo' });
  await openLivePopup(successBrowser);

  assert.deepEqual(await successBrowser.submitAndResolveIds(), {
    originProductNo: '777',
    channelProductNo: '888',
  });
  await successBrowser.screenshot('C:/artifacts/live-popup.png');
  assert.ok(successHarness.calls.includes('screenshot:C:/artifacts/live-popup.png'));
  await successBrowser.close();

  const recoveryHarness = fakeBrowserHarness({
    successText: '',
    popupResultLinks: ['https://sell.smartstore.naver.com/products/777?channelProductNo=888'],
    popupRecoveryReady: true,
  });
  const recoveryBrowser = createSpeedgoBrowser({ chromiumImpl: recoveryHarness.chromium, rootDir: 'C:/repo' });
  t.after(() => recoveryBrowser.close());
  await openLivePopup(recoveryBrowser);

  assert.deepEqual(await recoveryBrowser.recoverRegistration({}), {
    originProductNo: '777',
    channelProductNo: '888',
  });
  assert.equal(recoveryHarness.submitClicks, 0);
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

test('recoverRegistration reads one exact completed Speedgo row without resubmitting', async (t) => {
  const harness = fakeBrowserHarness({
    successText: '',
    popupSuccessText: '',
    speedgoSuccessEntries: [{
      supplierProductNo: '49168396',
      productName: '드래프트 119 상품',
      statusText: '전송완료 2026-08-10 23:15:31',
      itemChangeOnclick: "itemChange('ss','49168396','13716234819');",
    }],
  });
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  t.after(() => browser.close());
  await openLivePopup(browser);

  const ids = await browser.recoverRegistration({
    supplierProductNo: '49168396',
    productName: '드래프트 119 상품',
  });

  assert.deepEqual(ids, { channelProductNo: '13716234819' });
  assert.equal(harness.submitClicks, 0);
  assert.equal(
    harness.calls.includes('goto:https://speedgo.domeggook.com/send/send_list.php?status=SUCCESS&types='),
    true,
  );
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
