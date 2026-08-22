// Read-only exploration script (not part of the app) -- reuses the same
// .playwright-profile/ cookies speedgo-login.mjs's manual login saved, to
// look at the 도매매 스피드고 등록 UI structure (selectors) without ever
// touching login/credentials. Screenshots go to the scratchpad dir passed
// as argv[2]; safe to delete after selectors are captured.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const profileDir = join(rootDir, '.playwright-profile');
const sessionStatePath = join(profileDir, '.session-state.json');
const outDir = process.argv[2] || rootDir;

const context = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1600, height: 1000 } });
// Chromium drops session-only cookies (domeggook's login cookie has no
// Expires) across separate launches of the same profile -- see
// speedgo-login.mjs. Re-inject the cookies it snapshotted before relying on
// the profile alone.
if (existsSync(sessionStatePath)) {
  const state = JSON.parse(await readFile(sessionStatePath, 'utf8'));
  await context.addCookies(state.cookies);
}
const page = context.pages()[0] || (await context.newPage());

async function shot(name) {
  const path = join(outDir, `speedgo-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`screenshot: ${path}`);
}

await page.goto('https://domemedb.domeggook.com/index/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1500);
const loggedIn = await page.locator('text=로그아웃').count();
console.log(`loggedIn(로그아웃 link present)=${loggedIn > 0}`);
await shot('01-home');

await page.fill('input[name="ss"], input[type="search"], input[placeholder*="검색"]', '가방').catch(() => {});
await page.keyboard.press('Enter');
await page.waitForTimeout(2000);
await shot('02-search-results');
console.log('search url:', page.url());

// User says: clicking a listed item's representative image pops a menu with
// a 스피드고 전송 button. Find the first product thumbnail and click it.
const thumb = page.locator('img').filter({ hasNotText: '' }).nth(0);
const thumbCandidates = await page.locator('a img, li img, .item img, .prd img').all();
console.log('thumbnail candidates found:', thumbCandidates.length);
if (thumbCandidates.length > 0) {
  await thumbCandidates[0].click({ timeout: 5000 }).catch((e) => console.log('thumb click failed:', e.message));
  await page.waitForTimeout(1500);
  await shot('03-after-thumb-click');
  console.log('url after thumb click:', page.url());
}

await context.close();
