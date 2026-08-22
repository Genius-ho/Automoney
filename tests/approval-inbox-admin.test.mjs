import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adminHtml,
  approveInboxImagesResponse,
  dismissApprovalInboxResponse,
  getApprovalInboxResponse,
  retryApprovalInboxResponse,
} from '../src/admin-server.mjs';

test('getApprovalInboxResponse returns the server-composed counts and cards', async () => {
  const expected = {
    counts: { image: 1, sale: 0, purchase: 0, failed: 0 },
    cards: [{ key: 'image:118' }],
  };

  const response = await getApprovalInboxResponse({}, {
    listApprovalInboxImpl: async () => expected,
  });

  assert.deepEqual(response, { status: 200, body: expected });
});

test('approveInboxImagesResponse maps a stale approval card to HTTP 409', async () => {
  const error = Object.assign(new Error('images missing'), { code: 'IMAGES_NOT_READY' });

  const response = await approveInboxImagesResponse({}, '.', 118, {
    approveInboxImagesImpl: async () => { throw error; },
  });

  assert.deepEqual(response, { status: 409, body: { error: 'images missing', code: 'IMAGES_NOT_READY' } });
});

test('approveInboxImagesResponse preserves a successful post-processing result', async () => {
  const result = { autoRegistration: { outcome: 'awaiting_sale_approval' } };

  const response = await approveInboxImagesResponse({}, '.', 118, {
    approveInboxImagesImpl: async () => result,
  });

  assert.deepEqual(response, { status: 200, body: result });
});

test('retryApprovalInboxResponse rejects unsafe external retries with HTTP 409', async () => {
  const error = Object.assign(new Error('external reconciliation required'), { code: 'RETRY_NOT_SAFE' });

  const response = await retryApprovalInboxResponse({}, 9, {
    retryFailedInboxItemImpl: async () => { throw error; },
  });

  assert.deepEqual(response, { status: 409, body: { error: 'external reconciliation required', code: 'RETRY_NOT_SAFE' } });
});

test('dismissApprovalInboxResponse rejects a queue item that is not failed with HTTP 409', async () => {
  const error = Object.assign(new Error('Failed queue item not found'), { code: 'QUEUE_NOT_APPROVABLE' });

  const response = await dismissApprovalInboxResponse({}, 9, {
    dismissFailedInboxItemImpl: async () => { throw error; },
  });

  assert.deepEqual(response, { status: 409, body: { error: 'Failed queue item not found', code: 'QUEUE_NOT_APPROVABLE' } });
});

test('dismissApprovalInboxResponse returns the dismissed queue item on success', async () => {
  const result = { queueItem: { id: 3, status: 'completed' } };

  const response = await dismissApprovalInboxResponse({}, 3, {
    dismissFailedInboxItemImpl: async () => result,
  });

  assert.deepEqual(response, { status: 200, body: result });
});

test('admin HTML defaults to the 링크 입력 tab, with the approval inbox present but hidden (2026-08-22 simplification)', () => {
  const html = adminHtml();

  assert.match(html, /id="viewLinkInputButton" class="primary"/);
  assert.match(html, /let currentView='linkInput'/);
  assert.match(html, /id="viewApprovalInboxButton" type="button" hidden/);
  // Underlying approval-inbox functionality is dormant, not deleted -- still
  // reachable by removing `hidden` from its nav button.
  assert.match(html, /이미지 승인/);
  assert.match(html, /판매 승인/);
  assert.match(html, /발주 승인/);
  assert.match(html, /처리 실패/);
  assert.match(html, /data-approve-images-draft-id/);
  assert.match(html, /전체 이미지 승인/);
  assert.match(html, /data-request-sale-approval-draft-id/);
  assert.match(html, /data-approve-purchase-order-id/);
  assert.match(html, /data-retry-queue-id/);
  assert.match(html, /data-dismiss-queue-id/);
});

test('admin HTML includes the three active tabs (링크 입력/점수/이미지 개선) wired to their view loaders and APIs', () => {
  const html = adminHtml();

  assert.match(html, /id="viewLinkInputButton" class="primary"[^>]*>링크 입력</);
  assert.match(html, /id="viewScoreButton"[^>]*>점수</);
  assert.match(html, /id="viewImageImprovementButton"[^>]*>이미지 개선</);
  assert.match(html, /view==='linkInput'\)loadLinkInputView\(\)/);
  assert.match(html, /view==='score'\)loadScoreView\(\)/);
  assert.match(html, /view==='imageImprovement'\)loadImageImprovementView\(\)/);
  assert.match(html, /function loadLinkInputView\(\)/);
  assert.match(html, /function loadScoreView\(\)/);
  assert.match(html, /function loadImageImprovementView\(\)/);
  assert.match(html, /api\('\/api\/product-drafts\/analyze-links',\{method:'POST',body:JSON\.stringify\(\{text:value\}\)\}\)/);
  assert.match(html, /api\('\/api\/product-drafts\?status=awaiting_image_approval&pageSize=50'\)/);
});

test('admin HTML puts a per-row 등록 button on the 점수 table that imports that product via import-by-url', () => {
  const html = adminHtml();

  assert.match(html, /<th>등록<\/th>/);
  assert.match(html, /data-score-import-product-no="'\+attr\(r\.productNo\)\+'"/);
  assert.match(html, /data-score-import-result="'\+attr\(r\.productNo\)\+'"/);
  assert.match(html, /querySelectorAll\('\[data-score-import-product-no\]'\)\.forEach\(button=>button\.onclick=async\(\)=>\{/);
  assert.match(html, /api\('\/api\/product-drafts\/import-by-url',\{method:'POST',body:JSON\.stringify\(\{url:productNo\}\)\}\)/);
  assert.match(html, /등록됨, 이미지 생성 중\.\.\./);
});

test('admin HTML includes a 사용자 키워드 tab wired to the keyword-queue API', () => {
  const html = adminHtml();

  assert.match(html, /id="viewKeywordSourcingButton"[^>]*>사용자 키워드</);
  assert.match(html, /keywordSourcing:document\.getElementById\('viewKeywordSourcingButton'\)/);
  assert.match(html, /view==='keywordSourcing'\)loadKeywordSourcingView\(\)/);
  assert.match(html, /async function loadKeywordSourcingView\(\)/);
  assert.match(html, /api\('\/api\/auto-batch\/keyword-queue'\)/);
  assert.match(html, /function keywordSourcingListHtml\(queue\)/);
});

test('admin HTML includes a URL 등록 tab wired to the import-by-url API', () => {
  const html = adminHtml();

  assert.match(html, /id="viewUrlImportButton"[^>]*>URL 등록</);
  assert.match(html, /urlImport:document\.getElementById\('viewUrlImportButton'\)/);
  assert.match(html, /view==='urlImport'\)loadUrlImportView\(\)/);
  assert.match(html, /function loadUrlImportView\(\)/);
  assert.match(html, /api\('\/api\/product-drafts\/import-by-url',\{method:'POST',body:JSON\.stringify\(\{url:value\}\)\}\)/);
  assert.match(html, /loadApprovalInbox\(\)/);
  assert.match(html, /AI 이미지 검수/);
});

test('admin HTML renders a permanent 키워드 검색 bar (ahead of the viewNav tab content, above the toolbar) that opens a Domeggook search results tab for the typed keyword', () => {
  const html = adminHtml();

  assert.match(html, /function domeggookSearchUrl\(keyword\)\{/);
  assert.match(html, /'https:\/\/domemedb\.domeggook\.com\/index\/item\/supplyList\.php\?sf=subject&enc=utf8&fromOversea=0&mode=search&sw='\+encodeURIComponent\(keyword\)\+'&image_file='/);
  // Must be static markup (present in every view, including a draftId deep
  // link's detailOnly view) rather than something a per-view loader like
  // loadLinkInputView() injects/removes -- otherwise it would disappear
  // exactly like the table did before the detailOnly fix.
  assert.match(html, /<div class="keywordSearchBar">\s*<input id="keywordSearchInput"/);
  const keywordBarIndex = html.indexOf('class="keywordSearchBar"');
  const toolbarIndex = html.indexOf('class="toolbar" hidden');
  assert.ok(keywordBarIndex > 0 && toolbarIndex > 0 && keywordBarIndex < toolbarIndex);
  // Its own CSS class, not .toolbar -- switchView() hides/shows *the first*
  // .toolbar-classed element by document.querySelector('.toolbar'), so this
  // bar sharing that class would make switchView toggle the wrong element.
  assert.doesNotMatch(html, /<div class="toolbar"[^>]*>\s*<input id="keywordSearchInput"/);
  assert.match(html, /keywordSearchButton\.onclick=\(\)=>\{/);
  assert.match(html, /window\.open\(domeggookSearchUrl\(keyword\),'_blank'\)/);
  assert.match(html, /keywordSearchInput\.addEventListener\('keydown'/);
  // Wired once at page load, not inside loadLinkInputView (which no longer
  // mentions it at all).
  const loadLinkInputViewBody = html.slice(html.indexOf('function loadLinkInputView()'), html.indexOf('function loadLinkInputView()') + 400);
  assert.ok(!loadLinkInputViewBody.includes('keywordSearchButton'));
});

test('admin HTML opens a draftId deep link (e.g. a Telegram notification) directly into the detail panel, not the hidden full-list table', () => {
  const html = adminHtml();

  // Regression: a draftId link used to call switchView('all'), which forced
  // the hidden "전체" list/table view (with its "DB ID" column) to render
  // alongside the detail panel -- confusing since that tab is no longer in
  // the nav. It must go to the dedicated 'detailOnly' branch instead, which
  // shows only the detail panel.
  assert.match(html, /if\(initialId\)switchView\('detailOnly'\)/);
  assert.match(html, /document\.getElementById\('specialView'\)\.hidden=view==='all'\|\|view==='detailOnly'/);
  assert.match(html, /detail\.hidden=!\(view==='all'\|\|view==='detailOnly'\)/);
  // The table/toolbar/pagination stay tied to 'all' only -- a deep link must
  // not unhide them.
  assert.match(html, /closest\('\.tableWrap'\)\.hidden=view!=='all'/);
  // singleView's 1fr grid row stretches to fill the page regardless of
  // content (confirmed live in a headless browser), which would squeeze the
  // detail panel into a sliver below the fold if reused for detailOnly --
  // it needs its own grid-template-rows so the thin nav bar sizes to content
  // and the detail panel gets the rest.
  assert.match(html, /main\.detailOnly\{grid-template-rows:auto 1fr\}/);
  assert.match(html, /classList\.toggle\('detailOnly',view==='detailOnly'\)/);
});

test('admin HTML forces .toolbar (and #paginationToolbar, which shares that class) to actually collapse when hidden', () => {
  const html = adminHtml();

  // Regression: .toolbar{display:flex} otherwise wins over the browser's
  // default [hidden]{display:none} UA rule by cascade order/specificity, so
  // every non-'all' view (링크 입력/점수/이미지 개선/etc.) kept rendering the
  // status-filter dropdown and pagination bar even though .hidden was set
  // true in JS -- confirmed live in a headless browser (computed
  // display:flex despite the hidden attribute) before this rule was added.
  assert.match(html, /\.toolbar\[hidden\]\{display:none\}/);
});
