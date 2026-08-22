// Scrapes Coupang's *public* consumer site (coupang.com) -- not the Wing
// seller API, which has no product-search/ranking surface. Mirrors the
// manual workflow: land on a literally-random category, filter to >= 9,900
// won, read the "추천순" (recommended) ranking listing, and pull product
// *titles only* (never price or image) so a later step can extract keywords
// from them. One-shot launch per run (no persistent seller session needed,
// unlike speedgo-browser.mjs) -- same style as scripts/crawl-rendered-images.js.

const DEFAULT_PRICE_MIN = 9900;
const DEFAULT_MAX_TITLES = 30;
const DEFAULT_JITTER_MS = [500, 1500];

export function pickRandom(list, rngImpl = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const index = Math.floor(rngImpl() * list.length);
  return list[Math.min(index, list.length - 1)];
}

// Product titles read off a live listing page are noisy (whitespace runs,
// occasional empty nodes from lazy-loaded cards, duplicate cards from
// infinite-scroll re-render) -- clean and cap before handing them to the
// keyword extractor.
export function buildTitleList(rawTitles, { maxTitles = DEFAULT_MAX_TITLES } = {}) {
  const seen = new Set();
  const result = [];
  for (const raw of rawTitles || []) {
    const title = String(raw || '').replace(/\s+/g, ' ').trim();
    if (title.length < 2) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    result.push(title);
    if (result.length >= maxTitles) break;
  }
  return result;
}

async function readCategoryLinks(page) {
  return page.evaluate(() => {
    const negative = /(로그인|회원가입|고객센터|장바구니|주문배송|이벤트|쿠폰|알림|더보기|전체보기)/;
    const anchors = [...document.querySelectorAll('nav a[href], [class*="category"] a[href], [class*="Category"] a[href]')];
    const seen = new Set();
    const out = [];
    for (const anchor of anchors) {
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      const href = anchor.href;
      if (!text || !href || text.length > 20) continue;
      if (negative.test(text)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push({ text, href });
    }
    return out;
  });
}

async function applyPriceFilter(page, priceMin) {
  const filled = await page.evaluate((priceMin) => {
    const input = document.querySelector(
      'input[placeholder*="최소"], input[name*="minPrice"], input[id*="minPrice"], [class*="price"] input:first-of-type',
    );
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(priceMin));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const applyButton = [...document.querySelectorAll('button, a')].find((el) => /^적용$/.test((el.textContent || '').trim()));
    if (applyButton) applyButton.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }, priceMin);
  return { filled };
}

async function ensureRecommendedSort(page) {
  return page.evaluate(() => {
    const tabs = [...document.querySelectorAll('button, a')].filter((el) => /추천순/.test((el.textContent || '').trim()));
    const tab = tabs[0];
    if (!tab) return { found: false, clicked: false };
    const alreadyActive = /(active|selected|on)\b/i.test(tab.className || '');
    if (!alreadyActive) tab.click();
    return { found: true, clicked: !alreadyActive };
  });
}

async function slowScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = Math.max(500, Math.floor(window.innerHeight * 0.75));
      const timer = setInterval(() => {
        y += step;
        window.scrollTo(0, y);
        if (y >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 350);
    });
  });
}

async function readProductTitles(page) {
  return page.evaluate(() => {
    const nodes = document.querySelectorAll(
      '[class*="productName"], [class*="ProductName"], [data-testid*="product-name"], [class*="name"] a, li[class*="product"] a',
    );
    return [...nodes].map((node) => node.textContent || '');
  });
}

// One category dive: pick a random top-level category link, follow it, then
// (if the landing page itself exposes a further category nav) drill one
// level deeper -- matching the manual "패션 → 가방/잡화" two-hop pattern.
// Falls back to whatever level was reached if no deeper nav exists.
export async function scoutCategory({
  page,
  priceMin = DEFAULT_PRICE_MIN,
  maxTitles = DEFAULT_MAX_TITLES,
  rngImpl = Math.random,
} = {}) {
  await page.goto('https://www.coupang.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState?.('networkidle', { timeout: 10000 }).catch(() => {});

  const topLevelLinks = await readCategoryLinks(page);
  const topChoice = pickRandom(topLevelLinks, rngImpl);
  if (!topChoice) {
    const error = new Error('No category links found on the Coupang homepage');
    error.code = 'NO_CATEGORY_LINKS';
    throw error;
  }
  await page.goto(topChoice.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState?.('networkidle', { timeout: 10000 }).catch(() => {});

  const subLevelLinks = await readCategoryLinks(page);
  const subChoice = pickRandom(subLevelLinks, rngImpl);
  let categoryPath = [topChoice.text];
  if (subChoice) {
    await page.goto(subChoice.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState?.('networkidle', { timeout: 10000 }).catch(() => {});
    categoryPath = [topChoice.text, subChoice.text];
  }

  await applyPriceFilter(page, priceMin);
  await page.waitForTimeout(700);
  await ensureRecommendedSort(page);
  await page.waitForTimeout(700);
  await slowScroll(page);
  await page.waitForTimeout(1200);

  const rawTitles = await readProductTitles(page);
  const titles = buildTitleList(rawTitles, { maxTitles });

  return { categoryPath, url: page.url?.(), titles };
}

function jitterDelay([minMs, maxMs], rngImpl = Math.random) {
  const ms = minMs + rngImpl() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// Full run: launch a one-shot browser, dive into `count` random categories,
// return the raw title lists per category for the keyword extractor.
// `chromiumImpl` is injected (defaults to the real `playwright` module) so
// tests never need a real browser.
export async function scoutCoupangCategories({
  chromiumImpl,
  count = 2,
  priceMin = DEFAULT_PRICE_MIN,
  maxTitles = DEFAULT_MAX_TITLES,
  headful = false,
  jitterRangeMs = DEFAULT_JITTER_MS,
  rngImpl = Math.random,
} = {}) {
  const chromium = chromiumImpl || (await import('playwright')).chromium;
  const browser = await chromium.launch({ headless: !headful });
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    for (let i = 0; i < count; i += 1) {
      const result = await scoutCategory({ page, priceMin, maxTitles, rngImpl });
      results.push(result);
      if (i < count - 1) await jitterDelay(jitterRangeMs, rngImpl);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}
