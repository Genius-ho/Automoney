# Speedgo Naver Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register one Automoney product draft on Naver through the Domeme Speedgo Playwright UI, persist the resulting Naver identifiers, and automatically apply and verify the approved images and final price.

**Architecture:** Keep the real browser behind a small injected adapter so the state machine is testable without a live website. Reserve the draft in `naver_product_registrations` before the irreversible submit, capture the external identifiers from the submit response or success UI, then reuse the Naver Commerce client for post-registration verification and image/price updates. Persist a redacted run journal and screenshots for every stage.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, PostgreSQL via `pg`, Playwright 1.61, existing Naver Commerce API client, existing R2/image workflow.

## Global Constraints

- Reuse `.playwright-profile/`; do not store or type a new Domeme ID or password.
- A missing authenticated session must stop with `SPEEDGO_SESSION_EXPIRED`.
- Only `--confirm` may click the final external submit control; dry-run must have zero live registration side effects.
- CAPTCHA, secondary authentication, and human-verification screens must not be bypassed.
- Draft 64 remains protected and must never be submitted.
- Reserve before submit; a retry with an unresolved `submitting` row must recover and must not resubmit.
- Never persist guessed Naver identifiers.
- Artifacts must redact passwords, tokens, authorization headers, and cookie values.
- Preserve all unrelated untracked files and existing user changes.

---

## File Map

- Create `src/speedgo-artifacts.mjs`: redacted run journal and screenshot metadata.
- Create `src/speedgo-registration-input.mjs`: preflight checks, request hash, and UI form model.
- Create `src/speedgo-selectors.mjs`: semantic locator candidates and visible-locator resolution.
- Create `src/speedgo-browser.mjs`: Playwright profile/session, Speedgo UI operations, submit response capture, and identifier extraction.
- Create `src/naver-registration-post-process.mjs`: Naver API verification, image swap, price update, and final verification.
- Create `src/speedgo-registration.mjs`: idempotent end-to-end state machine.
- Create `scripts/speedgo-register.mjs`: CLI entry point.
- Modify `src/naver-registration-store.mjs`: reservation and completion operations.
- Modify `src/admin-server.mjs`: reuse the extracted Naver price-payload helper.
- Modify `package.json`: add `speedgo:register` and focused tests to the full suite.
- Create focused tests in `tests/` for every new module.

---

### Task 1: Idempotent Speedgo Registration Reservation

**Files:**
- Modify: `src/naver-registration-store.mjs`
- Modify: `tests/naver-registration-store.test.mjs`

**Interfaces:**
- Consumes: existing `naver_product_registrations` table and `toRegistrationRow()` mapping.
- Produces: `reserveNaverSpeedgoRegistration(db, productDraftId, { requestHash })` and `completeNaverSpeedgoRegistration(db, productDraftId, { requestHash, originProductNo, channelProductNo })`.

- [ ] **Step 1: Write failing reservation and completion tests**

Add imports and tests covering a new reservation, an existing linked row, recovery of a same-hash `submitting` row, a different-hash conflict, and completion restricted to the matching reservation.

```js
import {
  completeNaverSpeedgoRegistration,
  reserveNaverSpeedgoRegistration,
} from '../src/naver-registration-store.mjs';

test('reserveNaverSpeedgoRegistration inserts one submitting speedgo row', async () => {
  const db = { async query(sql, params) {
    assert.match(sql, /'submitting'/);
    assert.match(sql, /'speedgo_automation'/);
    assert.deepEqual(params, [501, 'hash-1']);
    return { rows: [{ product_draft_id: 501, request_hash: 'hash-1', status: 'submitting', linked_via: 'speedgo_automation' }] };
  } };
  const result = await reserveNaverSpeedgoRegistration(db, 501, { requestHash: 'hash-1' });
  assert.equal(result.action, 'reserved');
  assert.equal(result.registration.status, 'submitting');
});

test('completeNaverSpeedgoRegistration stores verified ids only on the matching reservation', async () => {
  const db = { async query(sql, params) {
    assert.match(sql, /status = 'created'/);
    assert.match(sql, /status = 'submitting'/);
    assert.deepEqual(params, [501, 'hash-1', '7777777777', '8888888888']);
    return { rows: [{ product_draft_id: 501, origin_product_no: '7777777777', channel_product_no: '8888888888', status: 'created', linked_via: 'speedgo_automation' }] };
  } };
  const result = await completeNaverSpeedgoRegistration(db, 501, {
    requestHash: 'hash-1', originProductNo: '7777777777', channelProductNo: '8888888888',
  });
  assert.equal(result.originProductNo, '7777777777');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/naver-registration-store.test.mjs`

Expected: FAIL because the two functions are not exported.

- [ ] **Step 3: Implement reservation and completion**

Use one insert and one conditional update. On insert conflict, read the existing row and return one of `already_linked`, `recover`, or `conflict` without modifying it.

```js
export async function reserveNaverSpeedgoRegistration(db, productDraftId, { requestHash }) {
  if (!requestHash) throw new Error('requestHash is required');
  const inserted = await db.query(
    `insert into naver_product_registrations
       (product_draft_id, request_hash, status, linked_via)
     values ($1, $2, 'submitting', 'speedgo_automation')
     on conflict (product_draft_id) do nothing returning *`,
    [productDraftId, requestHash],
  );
  if (inserted.rows[0]) return { action: 'reserved', registration: toRegistrationRow(inserted.rows[0]) };
  const existing = await getNaverRegistration(db, productDraftId);
  if (existing?.originProductNo) return { action: 'already_linked', registration: existing };
  if (existing?.status === 'submitting' && existing.requestHash === requestHash) return { action: 'recover', registration: existing };
  return { action: 'conflict', registration: existing };
}
```

Extend `toRegistrationRow()` to include `requestHash`, then implement completion with a `where product_draft_id = $1 and request_hash = $2 and status = 'submitting' and linked_via = 'speedgo_automation'` guard.

- [ ] **Step 4: Run the focused test and verify pass**

Run: `node --test tests/naver-registration-store.test.mjs`

Expected: all store tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/naver-registration-store.mjs tests/naver-registration-store.test.mjs
git commit -m "feat: reserve speedgo naver registrations"
```

---

### Task 2: Redacted Run Journal and Artifacts

**Files:**
- Create: `src/speedgo-artifacts.mjs`
- Create: `tests/speedgo-artifacts.test.mjs`

**Interfaces:**
- Consumes: `rootDir`, `draftId`, optional artifact directory, and an injectable clock.
- Produces: `redactSpeedgoValue(value)` and `createSpeedgoRunJournal({ rootDir, draftId, artifactDir, now })` with `recordStep()`, `recordFailure()`, `setScreenshot()`, and `finish()` methods.

- [ ] **Step 1: Write failing redaction and journal tests**

```js
test('redactSpeedgoValue removes nested credentials and bearer tokens', () => {
  const value = redactSpeedgoValue({
    password: 'secret', cookie: 'sid=abc', headers: { authorization: 'Bearer token-1' }, safe: 'ok',
  });
  assert.deepEqual(value, {
    password: '[REDACTED]', cookie: '[REDACTED]', headers: { authorization: '[REDACTED]' }, safe: 'ok',
  });
});

test('journal writes ordered stages and a terminal result JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'speedgo-journal-'));
  const journal = await createSpeedgoRunJournal({ artifactDir: dir, draftId: 501, now: () => new Date('2026-08-04T00:00:00Z') });
  await journal.recordStep('draft_loaded', { supplierProductNo: '49168396' });
  await journal.finish({ status: 'completed', originProductNo: '777' });
  const saved = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
  assert.deepEqual(saved.steps.map((step) => step.stage), ['draft_loaded']);
  assert.equal(saved.result.originProductNo, '777');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/speedgo-artifacts.test.mjs`

Expected: FAIL because `src/speedgo-artifacts.mjs` does not exist.

- [ ] **Step 3: Implement recursive redaction and atomic JSON writes**

Use `mkdir`, `writeFile`, and `rename`; write `result.json.tmp` first and rename it to `result.json`. Redact keys matching `/password|secret|token|authorization|cookie/i` and replace `Bearer <value>` in free-form strings.

```js
export function redactSpeedgoValue(value) {
  if (Array.isArray(value)) return value.map(redactSpeedgoValue);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key,
      /password|secret|token|authorization|cookie/i.test(key) ? '[REDACTED]' : redactSpeedgoValue(inner),
    ]),
  );
  return typeof value === 'string' ? value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]') : value;
}
```

- [ ] **Step 4: Run the focused test and verify pass**

Run: `node --test tests/speedgo-artifacts.test.mjs`

Expected: all artifact tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/speedgo-artifacts.mjs tests/speedgo-artifacts.test.mjs
git commit -m "feat: add redacted speedgo run artifacts"
```

---

### Task 3: Draft Preflight and Speedgo Form Model

**Files:**
- Create: `src/speedgo-registration-input.mjs`
- Create: `tests/speedgo-registration-input.test.mjs`

**Interfaces:**
- Consumes: output from `exportProductDraft(db, draftId, 'naver')`.
- Produces: `buildSpeedgoRegistrationInput(draft, { draftId })` returning `{ draftId, supplierProductNo, productName, salePrice, deliveryFee, detailContent, mainImageUrl, detailImageUrls, options, requestHash }`.

- [ ] **Step 1: Write failing mapping and readiness tests**

Cover a valid draft, protected draft 64, blocked draft, missing supplier number, missing title/price/image, and stable request hashes.

```js
test('buildSpeedgoRegistrationInput maps the reviewed Naver export', () => {
  const input = buildSpeedgoRegistrationInput({
    exportBlocked: false,
    supplierProductNo: '49168396',
    displayProductName: '무타공 정리 선반',
    salePrice: 19800,
    deliveryFee: 3000,
    detailContent: '<p>상세</p>',
    mainImages: ['/generated-ai-images/drafts/501/main/manual/v1.jpg'],
    approvedAiDetailImages: ['/generated-ai-images/drafts/501/detail/manual/r1-v1/01.jpg'],
    options: [{ groupName: '색상', optionName: '화이트', price: 0 }],
  }, { draftId: 501 });
  assert.equal(input.productName, '무타공 정리 선반');
  assert.equal(input.mainImageUrl, '/generated-ai-images/drafts/501/main/manual/v1.jpg');
  assert.equal(input.options[0].stockQuantity, 999);
  assert.match(input.requestHash, /^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/speedgo-registration-input.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement validation, normalization, and SHA-256 hashing**

Use error objects with the design codes `DRAFT_NOT_FOUND`, `DRAFT_BLOCKED`, and `DRAFT_NOT_READY`. Prefer approved detail images; fall back to `detailImages`, then `detailSliceImages`. Normalize option stock to `999` only when no stored stock exists.

```js
const snapshot = {
  draftId,
  supplierProductNo: String(draft.supplierProductNo),
  productName: String(draft.displayProductName || draft.name).trim(),
  salePrice: Number(draft.salePrice),
  deliveryFee: Number(draft.deliveryFee || 0),
  detailContent: String(draft.detailContent || ''),
  mainImageUrl: draft.mainImages?.[0] || null,
  detailImageUrls: [...(draft.approvedAiDetailImages?.length ? draft.approvedAiDetailImages : draft.detailImages || draft.detailSliceImages || [])],
  options: (draft.options || []).map((option) => ({
    groupName: option.groupName || '옵션', optionName: option.optionName, additionalPrice: Number(option.price || 0), stockQuantity: Number(option.stockQuantity ?? 999),
  })),
};
snapshot.requestHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
```

- [ ] **Step 4: Run the focused test and verify pass**

Run: `node --test tests/speedgo-registration-input.test.mjs`

Expected: all input tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/speedgo-registration-input.mjs tests/speedgo-registration-input.test.mjs
git commit -m "feat: build speedgo registration input"
```

---

### Task 4: Semantic Selectors and Playwright Browser Adapter

**Files:**
- Create: `src/speedgo-selectors.mjs`
- Create: `src/speedgo-browser.mjs`
- Create: `tests/speedgo-selectors.test.mjs`
- Create: `tests/speedgo-browser.test.mjs`

**Interfaces:**
- Consumes: Playwright-compatible `page` and the form model from Task 3.
- Produces: `findFirstVisible(page, name, candidates)`, `extractNaverRegistrationIds(value)`, and `createSpeedgoBrowser({ chromiumImpl, rootDir, headless, profileDir, sessionStatePath })`.
- Browser object methods: `open()`, `assertAuthenticated()`, `findSupplierProduct(input)`, `openSpeedgoTransfer()`, `selectNaverMarket()`, `fillNaverForm(input)`, `preview()`, `submitAndResolveIds()`, `recoverRegistration(input)`, `screenshot(path)`, and `close()`.

- [ ] **Step 1: Write failing selector resolution tests**

Use a fake page whose role/text/CSS locators report visibility in a controlled order. Assert that structural candidates win, invisible candidates are skipped, and the failure contains `selectorName` and `url`.

```js
test('findFirstVisible chooses the first visible semantic candidate', async () => {
  const page = fakePage({ visible: ['role:button:스피드고 전송'] });
  const locator = await findFirstVisible(page, 'speedgoTransfer', [
    { kind: 'css', value: '[data-action="speedgo-transfer"]' },
    { kind: 'role', role: 'button', name: /스피드고\s*전송/ },
  ]);
  assert.equal(locator.key, 'role:button:스피드고 전송');
});
```

- [ ] **Step 2: Write failing identifier extraction and side-effect-gate tests**

```js
test('extractNaverRegistrationIds finds ids in nested response JSON', () => {
  assert.deepEqual(extractNaverRegistrationIds({ data: { originProductNo: '777', channelProducts: [{ channelProductNo: '888' }] } }), {
    originProductNo: '777', channelProductNo: '888',
  });
});

test('browser preview never clicks the final submit candidate', async () => {
  const harness = fakeBrowserHarness();
  const browser = createSpeedgoBrowser({ chromiumImpl: harness.chromium, rootDir: 'C:/repo' });
  await browser.open();
  await browser.preview();
  assert.equal(harness.submitClicks, 0);
});
```

- [ ] **Step 3: Run focused tests and verify failure**

Run: `node --test tests/speedgo-selectors.test.mjs tests/speedgo-browser.test.mjs`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement semantic selector resolution**

Define candidate sets for the known Speedgo concepts. Use exact Korean labels plus structural fallbacks already observed in the exploration scripts.

```js
export const SPEEDGO_SELECTORS = {
  loginEvidence: [{ kind: 'text', value: /로그아웃/ }],
  searchInput: [
    { kind: 'css', value: 'input[name="ss"]' },
    { kind: 'role', role: 'searchbox', name: /상품|검색/ },
    { kind: 'css', value: 'input[type="search"]' },
  ],
  transferButton: [
    { kind: 'role', role: 'button', name: /스피드고\s*전송/ },
    { kind: 'text', value: /스피드고\s*전송/ },
    { kind: 'css', value: '[data-action*="speedgo" i], a[href*="speedgo" i]' },
  ],
  naverMarket: [
    { kind: 'role', role: 'checkbox', name: /네이버|스마트스토어/ },
    { kind: 'label', value: /네이버|스마트스토어/ },
  ],
  finalSubmit: [
    { kind: 'role', role: 'button', name: /전송|등록|상품등록/ },
    { kind: 'css', value: 'button[type="submit"], input[type="submit"]' },
  ],
};
```

- [ ] **Step 5: Implement the browser adapter and response capture**

Launch `chromium.launchPersistentContext(profileDir, { headless, viewport: headless ? { width: 1600, height: 1000 } : null })`, restore cookies from `.session-state.json`, and listen to `page.on('response')`. Parse only JSON responses whose URL or response body contains Speedgo/Naver registration identifiers. Do not log request headers or cookies.

`submitAndResolveIds()` must click exactly once, wait for either a captured identifier response or a success UI transition, then use `extractNaverRegistrationIds()` against response JSON, URL, visible success text, and result links in that order. Throw `UNRESOLVED_EXTERNAL_RESULT` if no verified `originProductNo` is found.

Map browser failures at the method boundary so callers never have to parse Playwright text:

- `assertAuthenticated()` -> `SPEEDGO_SESSION_EXPIRED`
- `findSupplierProduct()` with zero matches -> `SPEEDGO_SUPPLIER_PRODUCT_NOT_FOUND`
- `findSupplierProduct()` with multiple exact matches -> `SPEEDGO_AMBIGUOUS_PRODUCT`
- `openSpeedgoTransfer()` or `selectNaverMarket()` -> `SPEEDGO_TRANSFER_UI_NOT_FOUND`
- `fillNaverForm()` when a required value cannot be filled or read back -> `SPEEDGO_FORM_VALIDATION_FAILED`
- final click or success wait failure -> `SPEEDGO_SUBMIT_FAILED`
- successful-looking submission without an `originProductNo` -> `UNRESOLVED_EXTERNAL_RESULT`

- [ ] **Step 6: Run focused tests and verify pass**

Run: `node --test tests/speedgo-selectors.test.mjs tests/speedgo-browser.test.mjs`

Expected: all selector and browser tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/speedgo-selectors.mjs src/speedgo-browser.mjs tests/speedgo-selectors.test.mjs tests/speedgo-browser.test.mjs
git commit -m "feat: automate speedgo browser flow"
```

---

### Task 5: Naver Verification and Post-Processing Service

**Files:**
- Create: `src/naver-registration-post-process.mjs`
- Create: `tests/naver-registration-post-process.test.mjs`
- Modify: `src/admin-server.mjs`
- Modify: `tests/naver-registration-flow.test.mjs`

**Interfaces:**
- Consumes: verified `originProductNo`, draft ID, existing Naver client, approved manual image stores, R2 publisher, and Naver upload helper.
- Produces: `buildNaverPriceUpdatePayload(liveProduct, salePrice)` and `postProcessNaverRegistration(db, rootDir, draftId, { originProductNo, salePrice, clientImpl, ...deps })`.

- [ ] **Step 1: Write failing post-processing tests**

Test the exact order: get live product, upload approved images to R2, upload them to Naver, update origin product, update price using the live option structure, record image swap, get final product, and verify final price and image URL.

```js
test('postProcessNaverRegistration updates images and price then verifies the live product', async () => {
  const calls = [];
  const client = {
    async getProduct() { calls.push('get'); return calls.filter((x) => x === 'get').length === 1 ? liveBefore() : liveAfter(); },
    async updateOriginProduct(id, payload) { calls.push(['images', id, payload]); },
    async updateOptionStock(id, payload) { calls.push(['price', id, payload]); },
  };
  const result = await postProcessNaverRegistration({}, 'C:/repo', 501, {
    originProductNo: '777', salePrice: 19800, clientImpl: client,
    getApprovedMainImpl: async () => ({ coupangStoredUrl: '/main.jpg' }),
    getApprovedDetailImpl: async () => ({ images: [{ normalizedStoredUrl: '/detail-1.jpg' }] }),
    publishImpl: async () => ({ mainImageUrl: 'https://r2/main.jpg', detailImageUrls: ['https://r2/detail.jpg'] }),
    uploadToNaverImpl: async () => ({ mainImageUrl: 'https://naver/main.jpg', detailImageUrls: ['https://naver/detail.jpg'] }),
    recordImagesSwappedImpl: async () => ({ status: 'images_swapped' }),
  });
  assert.equal(result.verified, true);
  assert.deepEqual(calls.slice(0, 3).map((entry) => Array.isArray(entry) ? entry[0] : entry), ['get', 'images', 'price']);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/naver-registration-post-process.test.mjs`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Extract the price helper and implement post-processing**

Move the current private `buildNaverPriceUpdatePayload()` implementation from `src/admin-server.mjs` into the new service and import it back into the admin server. Use `uploadApprovedImagesToR2()`, `uploadImagesToNaver()`, `mapLiveNaverProductToImageSwapPayload()`, and `recordImagesSwapped()`.

```js
export function buildNaverPriceUpdatePayload(liveProduct, salePrice) {
  const optionInfo = liveProduct?.originProduct?.detailAttribute?.optionInfo || {};
  return {
    productSalePrice: { salePrice },
    optionInfo: {
      optionCombinations: optionInfo.optionCombinations || [],
      optionStandards: optionInfo.optionStandards || [],
      useStockManagement: optionInfo.useStockManagement ?? false,
    },
  };
}
```

After the final `getProduct()`, require `originProduct.salePrice === salePrice`, the representative image URL to match the Naver-uploaded URL, and at least the uploaded detail image count. Throw `NAVER_POST_PROCESS_FAILED` with a compact mismatch object otherwise.

- [ ] **Step 4: Run post-process and affected Naver tests**

Run: `node --test tests/naver-registration-post-process.test.mjs tests/naver-registration-flow.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Run admin server syntax verification**

Run: `node --check src/admin-server.mjs`

Expected: exit 0.

- [ ] **Step 6: Commit**

```powershell
git add src/naver-registration-post-process.mjs src/admin-server.mjs tests/naver-registration-post-process.test.mjs tests/naver-registration-flow.test.mjs
git commit -m "feat: post-process speedgo naver listings"
```

---

### Task 6: End-to-End Speedgo Registration State Machine

**Files:**
- Create: `src/speedgo-registration.mjs`
- Create: `tests/speedgo-registration.test.mjs`

**Interfaces:**
- Consumes: store operations from Task 1, journal from Task 2, form input from Task 3, browser adapter from Task 4, and post-processing service from Task 5.
- Produces: `runSpeedgoNaverRegistration(db, rootDir, draftId, { confirm, headless, artifactDir, browserImpl, naverConfig, clientImpl, ...deps })`.

- [ ] **Step 1: Write failing dry-run, success, dedup, and recovery tests**

Use injected fake dependencies. Assert exact stage order and call counts.

```js
test('dry-run fills and previews but never reserves or submits', async () => {
  const calls = [];
  const result = await runSpeedgoNaverRegistration({}, 'C:/repo', 501, fakeDeps({ confirm: false, calls }));
  assert.equal(result.dryRun, true);
  assert.equal(calls.includes('reserve'), false);
  assert.equal(calls.includes('submit'), false);
  assert.deepEqual(calls.slice(0, 6), ['open', 'auth', 'find', 'transfer', 'naver', 'fill']);
});

test('confirm reserves before one submit, completes ids, verifies, and post-processes', async () => {
  const calls = [];
  const result = await runSpeedgoNaverRegistration({}, 'C:/repo', 501, fakeDeps({ confirm: true, calls }));
  assert.equal(result.originProductNo, '777');
  assert.ok(calls.indexOf('reserve') < calls.indexOf('submit'));
  assert.equal(calls.filter((value) => value === 'submit').length, 1);
  assert.ok(calls.indexOf('complete') < calls.indexOf('postProcess'));
});

test('recover action never submits a second time', async () => {
  const calls = [];
  await runSpeedgoNaverRegistration({}, 'C:/repo', 501, fakeDeps({ confirm: true, reserveAction: 'recover', calls }));
  assert.equal(calls.includes('submit'), false);
  assert.equal(calls.includes('recover'), true);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/speedgo-registration.test.mjs`

Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement readiness, dry-run, confirm, dedup, and recovery branches**

Load the draft with `exportProductDraft(db, draftId, 'naver')`, build the form input, create a journal, and execute the browser methods in order. Reserve immediately before submit. Handle store actions as follows:

```js
switch (reservation.action) {
  case 'reserved':
    ids = await browser.submitAndResolveIds();
    break;
  case 'recover':
    ids = await browser.recoverRegistration(input);
    break;
  case 'already_linked':
    ids = {
      originProductNo: reservation.registration.originProductNo,
      channelProductNo: reservation.registration.channelProductNo,
    };
    break;
  default:
    throw speedgoError('NAVER_REGISTRATION_ALREADY_LINKED', 'draft has an incompatible registration reservation');
}
```

After every successful browser method, capture `<sequence>-<stage>.png` and call `journal.recordStep(stage, { url, screenshot })`. For `reserved` and `recover`, call completion only after `originProductNo` is present. Verify with `client.getProduct(originProductNo)` before post-processing. Always close the browser in `finally`; if a page exists, capture a terminal screenshot before close.

- [ ] **Step 4: Implement coded error wrapping and journal finalization**

Preserve known error codes. Wrap unclassified browser errors as `SPEEDGO_SUBMIT_FAILED`, Naver read failures as `NAVER_VERIFY_FAILED`, and persistence failures as `PERSISTENCE_FAILED`. Pass only redacted details to `recordFailure()`.

- [ ] **Step 5: Run the focused test and verify pass**

Run: `node --test tests/speedgo-registration.test.mjs`

Expected: all state-machine tests PASS.

- [ ] **Step 6: Run all new focused tests together**

Run: `node --test tests/speedgo-artifacts.test.mjs tests/speedgo-registration-input.test.mjs tests/speedgo-selectors.test.mjs tests/speedgo-browser.test.mjs tests/naver-registration-post-process.test.mjs tests/speedgo-registration.test.mjs tests/naver-registration-store.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/speedgo-registration.mjs tests/speedgo-registration.test.mjs
git commit -m "feat: orchestrate speedgo naver registration"
```

---

### Task 7: CLI and Package Integration

**Files:**
- Create: `scripts/speedgo-register.mjs`
- Create: `tests/speedgo-register-cli.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `runSpeedgoNaverRegistration()`, database/config loaders, CLI arguments.
- Produces: `npm run speedgo:register -- <draftId> [--confirm] [--headless] [--artifact-dir <path>]`.

- [ ] **Step 1: Write failing CLI parser tests**

Export `parseSpeedgoRegisterArgs(argv)` from the script while guarding the executable entry with an `isMain` check.

```js
test('parseSpeedgoRegisterArgs parses confirm, headless, and artifact directory', () => {
  assert.deepEqual(parseSpeedgoRegisterArgs(['501', '--confirm', '--headless', '--artifact-dir', 'C:/tmp/run']), {
    draftId: 501, confirm: true, headless: true, artifactDir: 'C:/tmp/run',
  });
});

test('parseSpeedgoRegisterArgs rejects missing or non-positive draft ids', () => {
  assert.throws(() => parseSpeedgoRegisterArgs(['0']), /positive integer/);
  assert.throws(() => parseSpeedgoRegisterArgs(['abc']), /positive integer/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/speedgo-register-cli.test.mjs`

Expected: FAIL because the CLI script does not exist.

- [ ] **Step 3: Implement the CLI and package script**

Load `DATABASE_URL` and Naver Commerce config, create the pool, invoke the orchestrator, print one redacted JSON result, and always call `db.end()` in `finally`. Exit 2 for argument/config errors and 1 for runtime failures.

Add to `package.json`:

```json
"speedgo:register": "node scripts/speedgo-register.mjs"
```

Append the new focused tests to the Naver/registration section of the full `test` script.

- [ ] **Step 4: Run CLI and syntax tests**

Run: `node --test tests/speedgo-register-cli.test.mjs`

Run: `node --check scripts/speedgo-register.mjs`

Run: `node --check src/speedgo-registration.mjs`

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```powershell
git add scripts/speedgo-register.mjs tests/speedgo-register-cli.test.mjs package.json
git commit -m "feat: add speedgo registration cli"
```

---

### Task 8: Live Dry-Run, Real Registration, and Final Verification

**Files:**
- Modify only if live evidence requires selector corrections: `src/speedgo-selectors.mjs`, `src/speedgo-browser.mjs`, and their focused tests.
- Generated and ignored: `artifacts/speedgo/119/<timestamp>/`

**Interfaces:**
- Consumes: automatic login profile, draft 119, valid DB and Naver Commerce configuration.
- Produces: one verified Naver registration for draft 119 and passing repository verification.

- [ ] **Step 1: Verify the profile and draft without a live submit**

Run: `npm.cmd run speedgo:register -- 119`

Expected: exit 0 with `dryRun: true`; artifact stages reach `fields_filled`; no `submitting` DB row is created and no final submit is clicked.

- [ ] **Step 2: Inspect the dry-run artifact**

Check `result.json` and the terminal screenshot. Confirm the exact draft title, price, Naver market selection, and no credential fields in the artifact. If a semantic selector fails, add a structural or exact-text candidate and a focused regression test before changing implementation.

- [ ] **Step 3: Re-run focused tests after any selector correction**

Run: `node --test tests/speedgo-selectors.test.mjs tests/speedgo-browser.test.mjs tests/speedgo-registration.test.mjs`

Expected: all tests PASS.

- [ ] **Step 4: Execute the authorized live registration**

Run: `npm.cmd run speedgo:register -- 119 --confirm`

Expected: one final submit click, `originProductNo` captured, DB row completed with `linked_via = 'speedgo_automation'`, Naver API verification succeeds, image/price post-processing succeeds, and the result artifact is `completed`.

- [ ] **Step 5: Prove retry idempotency**

Run: `npm.cmd run speedgo:register -- 119 --confirm`

Expected: no second submit; the existing linked registration is reused and verified.

- [ ] **Step 6: Run full verification**

Run: `npm.cmd test`

Run: `git diff --check`

Run: `git status --short`

Expected: all tests PASS, no whitespace errors, and only intentional task files plus the user's pre-existing untracked files appear.

- [ ] **Step 7: Commit live-evidence selector corrections if any**

```powershell
git add src/speedgo-selectors.mjs src/speedgo-browser.mjs tests/speedgo-selectors.test.mjs tests/speedgo-browser.test.mjs
git commit -m "fix: align speedgo selectors with live ui"
```

Skip this commit if the dry-run required no code change.
