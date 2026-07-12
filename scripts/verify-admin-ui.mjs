import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { chromium } from 'playwright';
import { createPgPool } from '../src/postgres-store.mjs';
import { loadDatabaseUrl } from '../src/config.mjs';

const port = 3000;
const base = `http://127.0.0.1:${port}`;
let server;
let browser;

const portOpen = () => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

async function waitForPort(open, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await portOpen() === open) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(open ? 'server_not_ready' : 'port_not_closed');
}

async function stopServer() {
  if (!server?.pid) return;
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', resolve);
    killer.on('exit', resolve);
  });
  await waitForPort(false, 10000);
}

if (await portOpen()) throw new Error('server_already_running');
const db = await createPgPool(await loadDatabaseUrl());

try {
  server = spawn(process.execPath, ['scripts/admin-server.js'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForPort(true);
  const draftApi = await fetch(`${base}/api/product-drafts/64`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [], browserPageErrors = [], failedRequests = [], browserDraftApiRequests = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => browserPageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(request.url()));
  page.on('response', (response) => { if (response.url().endsWith('/api/product-drafts/64')) browserDraftApiRequests.push({ url: response.url(), status: response.status() }); });
  await page.goto(`${base}/admin?draftId=64&verifyTs=${Date.now()}`);
  const section = page.locator('[data-html-detail-helper="true"]');
  await section.waitFor({ state: 'attached', timeout: 15000 });
  const sectionText = await section.textContent();
  const textareaLength = await page.locator('#generatedDetailHtml').inputValue().then((value) => value.length);
  await page.locator('[data-tab="detail"]').click();
  const visible = await section.isVisible();
  const controls = { preview: await page.locator('#preview').count() > 0, save: await page.locator('#saveButton').count() > 0, regenerate: await page.locator('#regenerateDetailButton').count() > 0 };
  const diagnostics = await page.evaluate(() => window.__adminUiDiagnostics || {});
  const htmlDetailSectionRendered = Boolean(sectionText?.includes('HTML 상세페이지 v2') && textareaLength === 3896 && visible);
  const result = { rawShellStatus: (await fetch(`${base}/admin?draftId=64`)).status, draftApiStatus: draftApi.status, browserApiRequestStatus: browserDraftApiRequests.at(-1)?.status || null, browserDraftApiRequests, diagnostics, clientRenderFunctionCalled: Boolean(diagnostics.actualLoadDetailEntered), detailContainerFound: await page.locator('#detail [data-panel="detail"]').count() > 0, helperOutputInserted: Boolean(diagnostics.helperOutputInserted), browserConsoleErrors: consoleErrors, browserPageErrors, failedRequests, htmlDetailSectionRendered, textareaValueLength: textareaLength, sectionVisibleAfterTabClick: visible, controls };
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/admin-ui-draft-64.png', fullPage: true });
  await writeFile('artifacts/admin-ui-draft-64.html', await page.content());
  await writeFile('artifacts/admin-ui-draft-64-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  const html = (await db.query('select generated_detail_html from product_drafts where id=64')).rows[0].generated_detail_html;
  if (html.length !== 3896 || createHash('sha256').update(html).digest('hex') !== '67ee716e9d48a39ae8a744e3451c3d7bd198399227aaf4b87997be54b86c5758') throw new Error('generated_detail_html_changed');
  if (!htmlDetailSectionRendered || consoleErrors.length || browserPageErrors.length || failedRequests.length) process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await db.end();
  await stopServer();
}
