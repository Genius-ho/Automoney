// Read-only "live watch" helper: opens the same persistent profile
// speedgo-login.mjs uses, but instead of waiting for the user to close the
// window, it screenshots on an interval to a fixed path so Claude can poll
// that single file and observe progress (login, navigating to an item,
// opening the speedgo 등록 UI) without ever taking control away from the
// user or needing them to close/reopen the browser between steps. Stops
// when a stop.flag file appears next to the screenshot, or after 15
// minutes, whichever first -- never left running unattended indefinitely.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const profileDir = join(rootDir, '.playwright-profile');
const sessionStatePath = join(profileDir, '.session-state.json');
const outDir = process.argv[2] || rootDir;
const screenshotPath = join(outDir, 'speedgo-live.png');
const stopFlagPath = join(outDir, 'speedgo-live.stop');
const urlLogPath = join(outDir, 'speedgo-live-url.txt');

const context = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: null });
// Chromium drops session-only cookies (domeggook's login cookie has no
// Expires) across separate launches of the same profile -- see
// speedgo-login.mjs. Re-inject the cookies it snapshotted before relying on
// the profile alone.
if (existsSync(sessionStatePath)) {
  const state = JSON.parse(await readFile(sessionStatePath, 'utf8'));
  await context.addCookies(state.cookies);
}
const page = context.pages()[0] || (await context.newPage());

try {
  await page.goto('https://domemedb.domeggook.com/index/', { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (error) {
  console.log(`자동 이동 실패 (${error.message})`);
}

console.log('watch 시작 -- 브라우저에서 계속 진행해주세요. 이 창은 자동으로 캡처됩니다.');

const { writeFile } = await import('node:fs/promises');
const start = Date.now();
const maxMs = 15 * 60 * 1000;
let closed = false;
context.on('close', () => { closed = true; });

while (!closed && Date.now() - start < maxMs) {
  if (existsSync(stopFlagPath)) break;
  try {
    await page.screenshot({ path: screenshotPath });
    await writeFile(urlLogPath, page.url(), 'utf8');
  } catch {
    // page may be mid-navigation -- just try again next tick
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.log('watch 종료');
if (!closed) await context.close();
