// Throwaway exploration script (like speedgo-explore.mjs) -- reuses the
// saved session cookies to look for the 쿠팡 전송실패 사유 (Coupang transfer
// failure reason) after a live speedgo transfer partially failed. Safe to
// delete once the relevant selectors/flow are captured.
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
if (existsSync(sessionStatePath)) {
  const state = JSON.parse(await readFile(sessionStatePath, 'utf8'));
  await context.addCookies(state.cookies);
}
const page = context.pages()[0] || (await context.newPage());

async function shot(name) {
  const path = join(outDir, `speedgo-ff-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`screenshot: ${path}`);
}

await page.goto('https://domemedb.domeggook.com/index/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1000);

const navLink = page.locator('a', { hasText: '스피드고전송기' }).first();
const href = await navLink.getAttribute('href').catch(() => null);
console.log('스피드고전송기 nav href:', href);
await navLink.click({ timeout: 5000 }).catch((e) => console.log('nav click failed:', e.message));
await page.waitForTimeout(2000);
console.log('url after nav click:', page.url());
await shot('01-speedgo-menu');

const links = await page.locator('a').evaluateAll((as) =>
  as
    .filter((a) => a.offsetParent !== null && a.textContent.trim())
    .slice(0, 80)
    .map((a) => `${a.textContent.trim()} -> ${a.getAttribute('href')}`)
);
console.log('links on page:\n' + links.join('\n'));

await context.close();
