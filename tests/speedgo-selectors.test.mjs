import assert from 'node:assert/strict';
import test from 'node:test';

import { findFirstVisible, SPEEDGO_SELECTORS } from '../src/speedgo-selectors.mjs';

function fakePage({ visible = [] } = {}) {
  const visibleKeys = new Set(visible);
  const makeLocator = (key) => ({
    key,
    count: async () => 1,
    first() { return this; },
    nth() { return this; },
    isVisible: async () => visibleKeys.has(key),
  });

  return {
    url: () => 'https://domemedb.domeggook.com/search?ss=49168396',
    locator: (value) => makeLocator(`css:${value}`),
    getByRole: (role, { name }) => makeLocator(`role:${role}:${name.source || name}`),
    getByText: (value) => makeLocator(`text:${value.source || value}`),
    getByLabel: (value) => makeLocator(`label:${value.source || value}`),
  };
}

test('findFirstVisible keeps structural candidate priority when several candidates are visible', async () => {
  const page = fakePage({
    visible: ['css:[data-action="speedgo-transfer"]', 'role:button:스피드고\\s*전송'],
  });

  const locator = await findFirstVisible(page, 'speedgoTransfer', [
    { kind: 'css', value: '[data-action="speedgo-transfer"]' },
    { kind: 'role', role: 'button', name: /스피드고\s*전송/ },
  ]);

  assert.equal(locator.key, 'css:[data-action="speedgo-transfer"]');
});

test('findFirstVisible skips invisible candidates', async () => {
  const page = fakePage({ visible: ['role:button:스피드고\\s*전송'] });

  const locator = await findFirstVisible(page, 'speedgoTransfer', [
    { kind: 'css', value: '[data-action="speedgo-transfer"]' },
    { kind: 'role', role: 'button', name: /스피드고\s*전송/ },
  ]);

  assert.equal(locator.key, 'role:button:스피드고\\s*전송');
});

test('findFirstVisible supports label candidates', async () => {
  const page = fakePage({ visible: ['label:네이버\\s*스마트스토어'] });

  const locator = await findFirstVisible(page, 'naverMarket', [
    { kind: 'label', value: /네이버\s*스마트스토어/ },
  ]);

  assert.equal(locator.key, 'label:네이버\\s*스마트스토어');
});

test('findFirstVisible reports selector name and current URL when nothing is visible', async () => {
  await assert.rejects(
    findFirstVisible(fakePage(), 'finalSubmit', [
      { kind: 'role', role: 'button', name: /^상품\s*등록$/ },
    ]),
    (error) => {
      assert.equal(error.code, 'SPEEDGO_SELECTOR_NOT_FOUND');
      assert.equal(error.selectorName, 'finalSubmit');
      assert.equal(error.url, 'https://domemedb.domeggook.com/search?ss=49168396');
      return true;
    },
  );
});

test('live supplier search selectors prioritize the structural form controls', () => {
  assert.deepEqual(SPEEDGO_SELECTORS.searchInput[0], {
    kind: 'css',
    value: 'input[name="sw"]',
  });
  assert.deepEqual(SPEEDGO_SELECTORS.searchSubmit[0], {
    kind: 'css',
    value: '#search_list button[type="submit"]',
  });
  assert.deepEqual(SPEEDGO_SELECTORS.searchModeInput[0], {
    kind: 'css',
    value: '#search_list input[name="sf"]',
  });
});
