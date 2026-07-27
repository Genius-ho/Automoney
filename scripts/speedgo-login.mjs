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

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: null,
});
const page = context.pages()[0] || (await context.newPage());
// Landing on the bare domain rather than guessing a login sub-path -- the
// exact login URL/flow hasn't been confirmed in this codebase yet.
// waitUntil:'load' hung past 30s on this site (likely a long-polling/ad
// resource that never fires the load event) -- 'domcontentloaded' is enough
// since the user drives everything from here by hand anyway. A failed
// navigation isn't fatal: the browser window is already open, so the user
// can just type the URL themselves.
try {
  await page.goto('https://domeggook.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
} catch (error) {
  console.log(`자동 이동 실패 (${error.message}) -- 브라우저 창에서 직접 domeggook.com으로 이동해주세요.`);
}

console.log('브라우저가 열렸습니다. 직접 로그인 페이지로 이동해서 도매매에 로그인한 뒤 이 창을 닫으세요.');
console.log(`세션은 ${profileDir} 에 저장되며, 다음부터는 로그인 없이 재사용됩니다.`);

await new Promise((resolve) => context.on('close', resolve));
