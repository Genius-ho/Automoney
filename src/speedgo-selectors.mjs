function selectorError(selectorName, url) {
  return Object.assign(
    new Error(`No visible Speedgo locator found for ${selectorName} at ${url}`),
    {
      code: 'SPEEDGO_SELECTOR_NOT_FOUND',
      selectorName,
      url,
    },
  );
}

function locatorForCandidate(page, candidate) {
  switch (candidate.kind) {
    case 'css':
      return page.locator(candidate.value);
    case 'role':
      return page.getByRole(candidate.role, {
        name: candidate.name,
        ...(candidate.exact === undefined ? {} : { exact: candidate.exact }),
      });
    case 'text':
      return page.getByText(candidate.value, {
        ...(candidate.exact === undefined ? {} : { exact: candidate.exact }),
      });
    case 'label':
      return page.getByLabel(candidate.value, {
        ...(candidate.exact === undefined ? {} : { exact: candidate.exact }),
      });
    case 'placeholder':
      return page.getByPlaceholder(candidate.value, {
        ...(candidate.exact === undefined ? {} : { exact: candidate.exact }),
      });
    case 'testId':
      return page.getByTestId(candidate.value);
    default:
      throw new TypeError(`Unsupported Speedgo selector candidate kind: ${candidate.kind}`);
  }
}

async function visibleInstance(locator, instanceIndex) {
  const count = typeof locator.count === 'function' ? await locator.count() : 1;
  if (instanceIndex !== undefined) {
    if (instanceIndex >= count) return null;
    const instance = typeof locator.nth === 'function' ? locator.nth(instanceIndex) : locator;
    return await instance.isVisible() ? instance : null;
  }
  for (let index = 0; index < count; index += 1) {
    const instance = count === 1 && typeof locator.first === 'function'
      ? locator.first()
      : typeof locator.nth === 'function'
        ? locator.nth(index)
        : locator;
    if (await instance.isVisible()) return instance;
  }
  return null;
}

export async function findFirstVisible(page, selectorName, candidates, { instanceIndex } = {}) {
  for (const candidate of candidates) {
    try {
      const instance = await visibleInstance(locatorForCandidate(page, candidate), instanceIndex);
      if (instance) return instance;
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith('Unsupported Speedgo selector')) throw error;
    }
  }

  let url = 'unknown';
  try {
    url = page?.url?.() || url;
  } catch {
    // Keep selector failures diagnostic even if the page closed mid-check.
  }
  throw selectorError(selectorName, url);
}

export const SPEEDGO_SELECTORS = Object.freeze({
  loginEvidence: [
    { kind: 'text', value: /^로그아웃$/ },
    { kind: 'role', role: 'link', name: /^로그아웃$/ },
  ],
  searchInput: [
    { kind: 'css', value: 'input[name="sw"]' },
    { kind: 'css', value: 'input[name="ss"]' },
    { kind: 'role', role: 'searchbox', name: /상품|검색/ },
    { kind: 'css', value: 'input[type="search"]' },
  ],
  searchModeInput: [
    { kind: 'css', value: '#search_list input[name="sf"]' },
    { kind: 'css', value: 'input[name="sf"]' },
  ],
  searchSubmit: [
    { kind: 'css', value: '#search_list button[type="submit"]' },
    { kind: 'css', value: '#search_list input[type="submit"]' },
    { kind: 'css', value: 'button[type="submit"], input[type="submit"]' },
  ],
  transferButton: [
    { kind: 'css', value: '.main_cont_btn1[onclick*="speedGoSend("]' },
  ],
  popupProductForm: [
    { kind: 'css', value: '#mkForm' },
  ],
  liveMarketCheckboxes: [
    { kind: 'css', value: '#mkForm input[type="checkbox"][id^="we"]' },
  ],
  liveProductNameInput: [
    { kind: 'css', value: '#ss_title' },
  ],
  liveRateInput: [
    { kind: 'css', value: '#ss_rate' },
  ],
  liveFeeInput: [
    { kind: 'css', value: '#ss_fee' },
  ],
  liveAddPriceInput: [
    { kind: 'css', value: '#ss_addPrice' },
  ],
  liveDeliveryPriceInput: [
    { kind: 'css', value: '#ss_delPrice' },
  ],
  liveSellerDiscountInput: [
    { kind: 'css', value: '#ss_sellerDiscount' },
  ],
  livePriceOutputs: [
    { kind: 'css', value: '#ss_storePrice' },
    { kind: 'css', value: '#ss_disPrice' },
    { kind: 'css', value: '#ss_realPrice' },
    { kind: 'css', value: '#ss_discountPrice' },
  ],
  liveFinalSubmit: [
    { kind: 'css', value: '#sendBtn button.cont_btn1[onclick*="goProduct("]' },
  ],
  naverMarket: [
    { kind: 'css', value: 'input[name*="naver" i], input[value*="naver" i]' },
    { kind: 'role', role: 'checkbox', name: /^네이버\s*스마트스토어$/ },
    { kind: 'label', value: /^네이버\s*스마트스토어$/ },
  ],
  productNameInput: [
    { kind: 'css', value: 'input[name*="productName" i]' },
    { kind: 'role', role: 'textbox', name: /상품명/ },
    { kind: 'label', value: /상품명/ },
  ],
  salePriceInput: [
    { kind: 'css', value: 'input[name*="salePrice" i], input[name*="sellPrice" i]' },
    { kind: 'role', role: 'textbox', name: /판매가|판매 가격/ },
    { kind: 'label', value: /판매가|판매 가격/ },
  ],
  deliveryFeeInput: [
    { kind: 'css', value: 'input[name*="deliveryFee" i], input[name*="shippingFee" i]' },
    { kind: 'role', role: 'textbox', name: /배송비/ },
    { kind: 'label', value: /배송비/ },
  ],
  detailContentInput: [
    { kind: 'css', value: 'textarea[name*="detailContent" i], textarea[name*="description" i]' },
    { kind: 'role', role: 'textbox', name: /상세(?:설명|내용)/ },
    { kind: 'css', value: '[contenteditable="true"][data-field*="detail" i]' },
  ],
  mainImageInput: [
    { kind: 'css', value: 'input[type="file"][name*="main" i]' },
    { kind: 'css', value: 'input[type="file"][data-image-type="main"]' },
  ],
  detailImageInput: [
    { kind: 'css', value: 'input[type="file"][name*="detail" i]' },
    { kind: 'css', value: 'input[type="file"][data-image-type="detail"]' },
  ],
  addOptionButton: [
    { kind: 'css', value: '[data-action="add-option"]' },
    { kind: 'role', role: 'button', name: /^옵션\s*추가$/ },
  ],
  optionGroupInput: [
    { kind: 'css', value: 'input[name*="optionGroup" i]' },
    { kind: 'role', role: 'textbox', name: /옵션\s*(?:그룹|분류)/ },
  ],
  optionNameInput: [
    { kind: 'css', value: 'input[name*="optionName" i]' },
    { kind: 'role', role: 'textbox', name: /옵션명|옵션\s*값/ },
  ],
  optionPriceInput: [
    { kind: 'css', value: 'input[name*="additionalPrice" i], input[name*="optionPrice" i]' },
    { kind: 'role', role: 'textbox', name: /추가\s*금액|옵션\s*가격/ },
  ],
  optionStockInput: [
    { kind: 'css', value: 'input[name*="stockQuantity" i], input[name*="optionStock" i]' },
    { kind: 'role', role: 'textbox', name: /재고/ },
  ],
  finalSubmit: [
    { kind: 'css', value: '[data-action="naver-register"], [data-action="speedgo-submit"]' },
    { kind: 'role', role: 'button', name: /^(?:상품\s*)?(?:전송|등록)(?:하기)?$/ },
    { kind: 'css', value: 'button[type="submit"], input[type="submit"]' },
  ],
  successEvidence: [
    { kind: 'text', value: /(?:상품\s*)?(?:등록|전송).*(?:완료|성공)/ },
    { kind: 'role', role: 'status', name: /(?:등록|전송).*(?:완료|성공)/ },
    { kind: 'css', value: '[data-origin-product-no], [data-channel-product-no]' },
  ],
});
