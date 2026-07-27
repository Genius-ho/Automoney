// One-time (or occasional, when the session expires) manual login step for
// Phase 4's Playwright 스피드등록 automation. Opens a persistent, non-headless
// browser profile at .playwright-profile/ and leaves it open so the user can
// log into 도매매 themselves -- automation scripts never see or type the
// password (see automoney_complete_automation_implementation_plan.md 9.3,
// "ID/비밀번호 코드 저장 금지"). Once logged in here, speedgo-register.mjs (not
// yet built) reuses this same profile's cookies without logging in again.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const profileDir = join(rootDir, '.playwright-profile');
const sessionStatePath = join(profileDir, '.session-state.json');

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: null,
});
// Chromium only preserves session-only cookies (no Expires/Max-Age -- which
// is how domeggook's login cookie is set) across restarts if the profile's
// "continue where you left off" setting is on, which a bare launchPersistentContext
// profile never has. Confirmed live 2026-07-27: logging in, closing the
// window, and reopening with the same profileDir still showed logged-out.
// Snapshotting cookies to disk ourselves and re-injecting them (see
// speedgo-explore.mjs/speedgo-watch.mjs) sidesteps that entirely instead of
// fighting Chromium's own session-restore prefs.
const saveState = () => context.storageState({ path: sessionStatePath }).catch(() => {});
const saveStateInterval = setInterval(saveState, 3000);
const page = context.pages()[0] || (await context.newPage());
// domeggook.com's bare domain lands on 도매꾹 (C2C) -- speedgo only works
// for 도매매 (B2B) products, a separate front end on its own subdomain
// (domemedb.domeggook.com) sharing the same www.domeggook.com login/account
// system (confirmed live 2026-07-27: 도매매's own "로그인" link goes to
// https://www.domeggook.com/ssl/member/mem_loginForm.php?back=<base64 of
// the domemedb return URL>). Landing on domemedb's own homepage and
// clicking its 로그인 link (rather than hardcoding the login form URL
// directly) keeps the back-redirect correct without duplicating that
// base64 encoding here.
// waitUntil:'load' hung past 30s on this site (likely a long-polling/ad
// resource that never fires the load event) -- 'domcontentloaded' is enough
// since the user drives everything from here by hand anyway. A failed
// navigation isn't fatal: the browser window is already open, so the user
// can just type the URL themselves.
try {
  await page.goto('https://domemedb.domeggook.com/index/', { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (error) {
  console.log(`자동 이동 실패 (${error.message}) -- 브라우저 창에서 직접 domemedb.domeggook.com으로 이동해주세요.`);
}

console.log('브라우저가 열렸습니다. 직접 로그인 페이지로 이동해서 도매매에 로그인한 뒤 이 창을 닫으세요.');
console.log(`세션은 ${profileDir} 에 저장되며, 다음부터는 로그인 없이 재사용됩니다.`);

await new Promise((resolve) => context.on('close', resolve));
clearInterval(saveStateInterval);
