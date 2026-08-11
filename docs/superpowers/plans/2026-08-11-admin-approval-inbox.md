# Admin Approval Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자가 `/admin` 첫 화면에서 승인 대기 항목만 확인하고 이미지 승인, 쿠팡 판매 승인, 공급처 발주 승인을 한 화면에서 처리하게 한다.

**Architecture:** 서버가 여러 테이블의 승인 대기 상태를 `approval inbox card` 모델로 결합해 반환한다. 이미지 대표·상세 승인은 하나의 트랜잭션으로 상태를 바꾼 후 기존 `handleApprovedImages` 후처리를 호출하고, 판매·발주 승인은 기존 API를 재사용한다. 관리자 단일 페이지에는 승인함 전용 렌더러를 추가하며 기존 상품 관리 화면은 유지한다.

**Tech Stack:** Node.js ESM, PostgreSQL, 내장 HTTP 서버, 바닐라 JavaScript 관리자 UI, `node:test`

## Global Constraints

- 관리자 진입 시 승인함을 기본 화면으로 표시한다.
- 승인함에는 이미지 승인, 쿠팡 판매 승인, 공급처 발주 승인, 처리 실패 항목만 표시한다.
- 이미지 승인은 대표 이미지와 최신 상세 이미지 10장을 한 번에 승인하며 부분 성공을 허용하지 않는다.
- 외부 쿠팡 등록, 판매 승인, 실제 발주는 기존 검증과 안전장치를 우회하지 않는다.
- 승인 성공 카드는 즉시 사라지고 조회 실패는 빈 목록이 아니라 오류로 표시한다.
- 기존 사용자 미추적 파일과 생성 이미지 파일은 수정하거나 커밋하지 않는다.

---

## File Structure

- Create: `src/approval-inbox-store.mjs` — 승인 대기 자료 조회와 카드 모델 변환
- Create: `src/approval-inbox-service.mjs` — 대표·상세 이미지의 원자적 일괄 승인, 안전한 실패 재대기, 후처리 호출
- Create: `tests/approval-inbox-store.test.mjs` — 카드 분류와 필드 매핑 테스트
- Create: `tests/approval-inbox-service.test.mjs` — 일괄 승인 트랜잭션과 후처리 테스트
- Create: `tests/approval-inbox-admin.test.mjs` — API 라우팅과 관리자 HTML 계약 테스트
- Modify: `src/admin-server.mjs` — 승인함 API, 기본 보기, 카드와 버튼 이벤트 연결

### Task 1: Approval Inbox Query Model

**Files:**
- Create: `src/approval-inbox-store.mjs`
- Create: `tests/approval-inbox-store.test.mjs`

**Interfaces:**
- Produces: `listApprovalInbox(db): Promise<{ counts, cards }>`
- `counts`: `{ image: number, sale: number, purchase: number, failed: number }`
- 각 card: `{ key, type, title, draftId, status, availableActions, pricing, mainImage, detailImages, error }`

- [ ] **Step 1: Write the failing mapping tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { listApprovalInbox } from '../src/approval-inbox-store.mjs';

test('listApprovalInbox returns image cards with one bulk action', async () => {
  const db = fakeDbForInbox({
    imageRows: [{ draft_id: 118, product_name: '시스맥스 뉴트로 소품박스 3단', queue_status: 'awaiting_image_approval', main_image_id: 21, main_image_url: '/main.jpg', detail_set_id: 31, detail_image_urls: ['/01.jpg'], coupang_sale_price: 29900, unit_cost_price: 12000, coupang_expected_profit: 5000 }],
  });
  const result = await listApprovalInbox(db);
  assert.equal(result.counts.image, 1);
  assert.deepEqual(result.cards[0].availableActions, ['approve_images']);
  assert.equal(result.cards[0].draftId, 118);
});

test('listApprovalInbox separates sale, purchase, and failed cards', async () => {
  const result = await listApprovalInbox(fakeDbForInbox({ saleRows: [{}], purchaseRows: [{}], failedRows: [{}] }));
  assert.deepEqual(result.counts, { image: 0, sale: 1, purchase: 1, failed: 1 });
  assert.deepEqual(result.cards.map((card) => card.type), ['sale', 'purchase', 'failed']);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/approval-inbox-store.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `approval-inbox-store.mjs`.

- [ ] **Step 3: Implement focused SQL queries and card mapping**

```js
export async function listApprovalInbox(db) {
  const [images, sales, purchases, failures] = await Promise.all([
    listImageApprovals(db), listSaleApprovals(db), listPurchaseApprovals(db), listFailures(db),
  ]);
  const cards = [
    ...images.map(toImageCard), ...sales.map(toSaleCard),
    ...purchases.map(toPurchaseCard), ...failures.map(toFailureCard),
  ];
  return {
    counts: { image: images.length, sale: sales.length, purchase: purchases.length, failed: failures.length },
    cards,
  };
}
```

Image SQL must select only queue rows in `awaiting_image_approval`, the latest `uploaded` main image, and the latest `uploaded` detail set with exactly 10 images. Sale SQL selects queue rows in `awaiting_sale_approval` joined to `coupang_product_registrations`. Purchase SQL selects `supplier_orders.status = 'awaiting_purchase_approval'`. Failure SQL selects `processing_queue.status = 'failed'` with non-null failure metadata. Sort cards by `updated_at` ascending so the oldest human wait appears first.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test tests/approval-inbox-store.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/approval-inbox-store.mjs tests/approval-inbox-store.test.mjs
git commit -m "feat: add approval inbox query model"
```

### Task 2: Atomic Bulk Image Approval

**Files:**
- Create: `src/approval-inbox-service.mjs`
- Create: `tests/approval-inbox-service.test.mjs`

**Interfaces:**
- Produces: `approveInboxImages(db, rootDir, draftId, deps?): Promise<{ mainImage, detailSet, autoRegistration }>`
- Produces: `retryFailedInboxItem(db, queueId): Promise<{ queueItem }>`
- Consumes: existing `handleApprovedImages(db, rootDir, draftId, options)` after the DB transaction commits

- [ ] **Step 1: Write failing transaction tests**

```js
test('approveInboxImages commits both uploaded image records before post-processing', async () => {
  const events = [];
  const db = transactionalDb(events, { main: { id: 21 }, detail: { id: 31, image_count: 10 } });
  const result = await approveInboxImages(db, '.', 118, {
    handleApprovedImagesImpl: async () => { events.push('post-process'); return { status: 'registered' }; },
    loadCoupangConfigImpl: async () => ({}),
    loadTelegramConfigImpl: async () => ({}),
    createCoupangClientImpl: () => ({}),
  });
  assert.deepEqual(events, ['begin', 'approve-main', 'approve-detail', 'commit', 'post-process']);
  assert.equal(result.autoRegistration.status, 'registered');
});

test('approveInboxImages rolls back without partial approval when detail set is missing', async () => {
  const events = [];
  await assert.rejects(() => approveInboxImages(transactionalDb(events, { main: { id: 21 }, detail: null }), '.', 118), { code: 'IMAGES_NOT_READY' });
  assert.deepEqual(events, ['begin', 'rollback']);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/approval-inbox-service.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement one transaction and existing post-processing reuse**

Within one checked-out DB client:

1. `BEGIN`.
2. Lock the queue row for `draft_id = $1`; require `awaiting_image_approval`.
3. Lock the newest main image with `status = 'uploaded'`.
4. Lock the newest detail set with `status = 'uploaded' AND image_count = 10`.
5. If either is missing, throw `IMAGES_NOT_READY` and `ROLLBACK`.
6. Supersede previous approved records, approve both selected records, then `COMMIT`.
7. Load Coupang and Telegram configuration and call `handleApprovedImages` once.

The catch block must roll back only when the transaction is still open and always release the checked-out client.

Implement `retryFailedInboxItem` with a guarded update from `failed` only. Map `draft_creation` to `queued`, analysis-related stages to `draft_created`, and image-related stages to `analysis_completed`. Registration or unknown external-side-effect stages return `RETRY_NOT_SAFE` without changing state so duplicate marketplace creation cannot occur.

- [ ] **Step 4: Run service tests and existing image approval tests**

Run: `node --test tests/approval-inbox-service.test.mjs tests/image-approval-registration.test.mjs tests/manual-ai-workflow-store.test.mjs tests/manual-ai-detail-store.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/approval-inbox-service.mjs tests/approval-inbox-service.test.mjs
git commit -m "feat: approve generated images from one inbox action"
```

### Task 3: Approval Inbox HTTP API

**Files:**
- Modify: `src/admin-server.mjs`
- Create: `tests/approval-inbox-admin.test.mjs`

**Interfaces:**
- Produces: `GET /api/approval-inbox`
- Produces: `POST /api/approval-inbox/drafts/:draftId/approve-images`
- Produces: `POST /api/approval-inbox/queue/:queueId/retry`
- Reuses: `POST /api/product-drafts/:draftId/coupang-registration/request-approval`
- Reuses: `POST /api/purchase-orders/:id/approve` with `{ "confirm": true }`

- [ ] **Step 1: Write failing route tests**

Add injectable helper functions or exported route helpers so tests can assert:

```js
test('approval inbox GET returns counts and cards', async () => {
  const payload = await getApprovalInboxResponse({}, { listApprovalInboxImpl: async () => ({ counts: { image: 1, sale: 0, purchase: 0, failed: 0 }, cards: [] }) });
  assert.equal(payload.counts.image, 1);
});

test('bulk image approval maps state errors to HTTP 409', async () => {
  const error = Object.assign(new Error('images missing'), { code: 'IMAGES_NOT_READY' });
  const response = await approveInboxImagesResponse({}, '.', 118, { approveInboxImagesImpl: async () => { throw error; } });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'IMAGES_NOT_READY');
});
```

- [ ] **Step 2: Run the route tests and verify RED**

Run: `node --test tests/approval-inbox-admin.test.mjs`

Expected: FAIL because the exported helpers and routes do not exist.

- [ ] **Step 3: Add imports, helpers, and routes**

Import `listApprovalInbox`, `approveInboxImages`, and `retryFailedInboxItem`. Return `500` for unexpected errors; return `409` for `QUEUE_NOT_APPROVABLE`, `IMAGES_NOT_READY`, and `RETRY_NOT_SAFE`; return JSON `{ error, code }`. Do not alter the existing sale and purchase approval implementations.

- [ ] **Step 4: Run route and regression tests**

Run: `node --test tests/approval-inbox-admin.test.mjs tests/manual-ai-admin-html.test.mjs tests/purchase-order-approval.test.mjs tests/coupang-telegram-approval.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add src/admin-server.mjs tests/approval-inbox-admin.test.mjs
git commit -m "feat: expose approval inbox endpoints"
```

### Task 4: Admin Approval Inbox UI

**Files:**
- Modify: `src/admin-server.mjs`
- Modify: `tests/approval-inbox-admin.test.mjs`

**Interfaces:**
- Consumes: `GET /api/approval-inbox`
- Calls: bulk image, existing Coupang sale approval, and existing purchase approval endpoints
- Calls: safe queue retry endpoint only when the card exposes `retry`
- Produces client functions: `loadApprovalInbox()`, `approvalInboxHtml(data)`, `bindApprovalInboxActions(container)`

- [ ] **Step 1: Write failing HTML contract tests**

```js
test('admin HTML opens approval inbox by default', () => {
  const html = getAdminHtmlForTest();
  assert.match(html, /data-view="approvalInbox"/);
  assert.match(html, /승인함/);
  assert.match(html, /전체 이미지 승인/);
  assert.match(html, /loadApprovalInbox\(\)/);
});
```

Also assert the four summary labels, card error region, and stable action attributes `data-approve-images-draft-id`, `data-request-sale-approval-draft-id`, `data-approve-purchase-order-id`, and `data-retry-queue-id`.

- [ ] **Step 2: Run the UI contract test and verify RED**

Run: `node --test tests/approval-inbox-admin.test.mjs`

Expected: FAIL because approval inbox markup is absent.

- [ ] **Step 3: Implement the default approval inbox view**

Add an `승인함` navigation button before existing views and mark it active on initial load. Render:

```html
<section class="approvalSummary">이미지 승인 <strong>1</strong>건 · 판매 승인 <strong>0</strong>건 · 발주 승인 <strong>0</strong>건 · 처리 실패 <strong>0</strong>건</section>
<article class="approvalCard" data-approval-key="image:118">
  <h2>시스맥스 뉴트로 소품박스 3단 <small>#118</small></h2>
  <div class="approvalImages">...</div>
  <button data-approve-images-draft-id="118">전체 이미지 승인</button>
  <div data-action-result></div>
</article>
```

Escape all server strings and URLs with existing `escapeHtml`/`attr`. While a button request is running, disable every action in that card. On success call `loadApprovalInbox()`; on failure re-enable actions and write the API error into the card's result element. Purchase approval must keep a native `confirm` immediately before the money-spending request.

- [ ] **Step 4: Run UI and existing admin tests**

Run: `node --test tests/approval-inbox-admin.test.mjs tests/manual-ai-admin-html.test.mjs tests/manual-ai-http.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add src/admin-server.mjs tests/approval-inbox-admin.test.mjs
git commit -m "feat: add one-click admin approval inbox"
```

### Task 5: Full Verification and Draft 118 Handoff

**Files:**
- Modify only if verification exposes a defect in the files listed above

- [ ] **Step 1: Run formatting and full automated verification**

Run:

```powershell
git diff --check
npm test
```

Expected: no whitespace errors; all tests PASS with zero failures.

- [ ] **Step 2: Restart the Windows server and verify the read-only inbox**

Restart using the existing `Automoney 시작.lnk`, open `http://localhost:3000/admin`, and verify without clicking approval:

- 승인함 is the default view.
- Summary shows one image approval.
- Draft 118 card is visible.
- One main image and ten detail images render.
- `전체 이미지 승인` is enabled.

- [ ] **Step 3: Ask for action-time confirmation before the external side effect**

The final click starts existing Coupang registration after image approval. Report the exact draft/product and ask the user to confirm clicking `전체 이미지 승인`. Do not click it during read-only verification.

- [ ] **Step 4: After confirmation, click once and verify state transitions**

Verify the card disappears, `processing_queue` advances from `awaiting_image_approval`, a Coupang registration row exists, and the Telegram sale approval notification result is recorded. Do not claim success from a toast alone.

- [ ] **Step 5: Commit any verification-only fix, then push**

If no fix was required, skip the extra commit. Push the branch only after all checks pass and preserve every unrelated untracked file.
