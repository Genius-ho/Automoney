# Manual Main Image Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a credential-free, provider-agnostic manual external-AI workflow for one draft main image, including ZIP handoff, validated upload, approval history, and approved-image export selection.

**Architecture:** Keep binary processing and workflow persistence outside the existing admin server. A package builder, multipart parser, image validator/derivative generator, and workflow store expose small interfaces consumed by HTTP routes and the admin UI. PostgreSQL guarantees one approved main image, while export code only selects a validated approved JPEG derivative.

**Tech Stack:** Node.js 24 ESM, PostgreSQL 18, `sharp`, built-in `node:test`, Playwright; add `archiver` for streaming ZIP creation.

## Global Constraints

- Never require or read `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, or `AUTOMONEY_CREDENTIAL_MASTER_KEY` for this workflow.
- Never call an AI provider connection test or paid AI API.
- Implement only `task_type=main_image`; do not implement the ten-image detail workflow.
- Original uploads are immutable and limited to 10MB; accepted formats are signature-verified PNG, JPEG, and WebP.
- Accepted input is at least 1000x1000, at most 5000x5000, at most 25MP, and square within 1 percent.
- Coupang derivatives are 1000x1000 sRGB JPEG, metadata-free, targeted at 2.5MB and always below 3MB.
- Preserve draft 64 `generated_detail_html`: length 3896 and SHA-256 `67ee716e9d48a39ae8a744e3451c3d7bd198399227aaf4b87997be54b86c5758`.
- Preserve original representative images and all historical manual AI image versions.

## File Map

- Create `src/manual-ai/image-processing.mjs`: signature/decode/dimension validation and JPEG derivative generation.
- Create `src/manual-ai/multipart.mjs`: bounded multipart parsing for one image and known text fields.
- Create `src/manual-ai/package-builder.mjs`: deterministic work-package manifest and ZIP stream generation.
- Create `src/manual-ai/workflow-store.mjs`: version persistence, listing, approval/rejection, export selection.
- Create `migrations/2026-07-12-manual-main-image-workflow.sql`: production migration matching `schema.sql`.
- Modify `schema.sql`: `generated_ai_images` table, constraints, foreign key, and partial unique index.
- Modify `src/admin-store.mjs`: expose package context and merge approved main image into exports/debug output.
- Modify `src/admin-server.mjs`: workflow routes, safe download/upload responses, UI, optional-provider notice, disabled connection tests.
- Modify `src/public-assets.mjs`: allow only the generated manual image URL prefix.
- Create `tests/manual-ai-image-processing.test.mjs`, `tests/manual-ai-package.test.mjs`, `tests/manual-ai-workflow-store.test.mjs`, and `tests/manual-ai-http.test.mjs`.
- Create `scripts/verify-manual-main-image.mjs`: draft 64 Playwright verification.
- Modify `package.json`: dependency and test/verification scripts.

---

### Task 1: Database Model and Approval State Machine

**Files:**
- Modify: `schema.sql`
- Create: `migrations/2026-07-12-manual-main-image-workflow.sql`
- Create: `src/manual-ai/workflow-store.mjs`
- Create: `tests/manual-ai-workflow-store.test.mjs`

**Interfaces:**
- Produces: `listManualMainImages(db, draftId)`, `insertManualMainImage(db, input)`, `approveManualMainImage(db, draftId, imageId, approvalNote)`, `rejectManualMainImage(db, draftId, imageId, note)`, and `getApprovedManualMainImage(db, draftId)`.
- Approval returns `{ approved, superseded }` and runs through `db.connect()` when available.

- [ ] **Step 1: Write failing store tests**

Test SQL-visible behavior with a recording transaction client: first approval updates one row to approved; second approval locks current rows, marks the first `superseded` with the new ID, then approves the second; rejection never promotes old versions; list output preserves all timestamps.

```js
test('second approval supersedes the first and preserves history', async () => {
  const db = approvalDb({ currentApprovedId: 10, targetId: 11 });
  const result = await approveManualMainImage(db, 64, 11, 'selected');
  assert.equal(result.approved.id, 11);
  assert.equal(result.superseded.id, 10);
  assert.match(db.sql.join('\n'), /status='superseded'/);
  assert.match(db.sql.join('\n'), /superseded_by_image_id=\$2/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/manual-ai-workflow-store.test.mjs`
Expected: FAIL because `src/manual-ai/workflow-store.mjs` does not exist.

- [ ] **Step 3: Add the schema and store implementation**

Define `generated_ai_images` with the design fields, checks for task/workflow/status/MIME, the version uniqueness constraint, self-reference for `superseded_by_image_id`, and:

```sql
create unique index if not exists uq_generated_ai_images_one_approved_main
on generated_ai_images(product_draft_id, task_type)
where status = 'approved';
```

Implement approval with `BEGIN`, `SELECT ... FOR UPDATE`, supersede update, target approval update, `COMMIT`, and `ROLLBACK` on error.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/manual-ai-workflow-store.test.mjs`
Expected: all store tests pass.

- [ ] **Step 5: Commit the task**

```powershell
git add schema.sql migrations/2026-07-12-manual-main-image-workflow.sql src/manual-ai/workflow-store.mjs tests/manual-ai-workflow-store.test.mjs
git commit -m "feat: add manual AI image approval history"
```

### Task 2: Upload Validation and Coupang Derivative

**Files:**
- Create: `src/manual-ai/image-processing.mjs`
- Create: `tests/manual-ai-image-processing.test.mjs`

**Interfaces:**
- Produces: `detectImageType(buffer)`, `validateManualMainImage(buffer, declaredMime)`, and `createCoupangDerivative(buffer)`.
- `createCoupangDerivative` returns `{ buffer, mimeType:'image/jpeg', width:1000, height:1000, quality, fileSize }`.

- [ ] **Step 1: Write failing validation tests**

Generate small fixtures with Sharp at test runtime. Cover PNG/JPEG/WebP success; MIME/signature mismatch; corrupt bytes; over 10MB; below 1000px; above 5000px; above 25MP; and aspect error above 1 percent.

```js
test('WebP upload produces a registration-safe JPEG', async () => {
  const input = await sharp({ create:{ width:1200, height:1200, channels:3, background:'#ddd' } }).webp().toBuffer();
  await validateManualMainImage(input, 'image/webp');
  const output = await createCoupangDerivative(input);
  const metadata = await sharp(output.buffer).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.deepEqual([metadata.width, metadata.height], [1000, 1000]);
  assert.ok(output.fileSize < 3_000_000);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/manual-ai-image-processing.test.mjs`
Expected: FAIL because the image-processing module is missing.

- [ ] **Step 3: Implement validation and derivative retries**

Use magic bytes plus Sharp metadata/decode. Reject before persistence. Resize with `fit:'fill'` only after the 1-percent square check; accepted input is never enlarged. Convert through `toColourspace('srgb')`, omit `withMetadata`, and try JPEG qualities `[90,85,80,75]`, accepting the first output at or below 2,500,000 bytes. Throw `DERIVATIVE_TOO_LARGE` otherwise.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/manual-ai-image-processing.test.mjs`
Expected: all format, dimension, and derivative tests pass.

- [ ] **Step 5: Commit the task**

```powershell
git add src/manual-ai/image-processing.mjs tests/manual-ai-image-processing.test.mjs
git commit -m "feat: validate manual AI image uploads"
```

### Task 3: Work Package ZIP

**Files:**
- Create: `src/manual-ai/package-builder.mjs`
- Create: `tests/manual-ai-package.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: package context `{ draft, request, sourceMainImage, referenceImages }` supplied by the store layer.
- Produces: `buildMainImagePackage(context, { fetchImpl })` returning `{ filename, buffer }`.

- [ ] **Step 1: Install ZIP dependency and write failing tests**

Run: `npm.cmd install archiver`

Test required entry names, product JSON values, instructions, optional reference numbering, draft prompt permissibility, and errors for missing draft/current prompt/rendered prompt/source main image. Inject `fetchImpl` so tests never use the network.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/manual-ai-package.test.mjs`
Expected: FAIL because `buildMainImagePackage` is missing.

- [ ] **Step 3: Implement package construction**

Build the exact five required entries and `references/` entries. Sanitize extensions from decoded MIME, not URLs. Set filename to `draft-{id}-main-image-r{revision}.zip`; JSON includes the exact approved design keys and `workflowMode:'manual_external_ai'`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/manual-ai-package.test.mjs`
Expected: all ZIP and prerequisite tests pass.

- [ ] **Step 5: Commit the task**

```powershell
git add package.json package-lock.json src/manual-ai/package-builder.mjs tests/manual-ai-package.test.mjs
git commit -m "feat: build manual AI work packages"
```

### Task 4: Multipart Upload and Immutable File Persistence

**Files:**
- Create: `src/manual-ai/multipart.mjs`
- Create: `tests/manual-ai-http.test.mjs`
- Modify: `src/manual-ai/workflow-store.mjs`
- Modify: `src/public-assets.mjs`

**Interfaces:**
- Produces: `readManualImageMultipart(request, { maxBytes:10_000_000 })` returning `{ image:{ buffer, filename, mimeType }, fields }`.
- Produces: `persistManualMainImageFiles({ rootDir, draftId, revision, version, original, derivative })` returning public URLs; it writes temporary files and atomically renames them.

- [ ] **Step 1: Write failing multipart and persistence tests**

Cover known fields, unknown/multiple image rejection, 10MB enforcement while streaming, immutable versioned names, cleanup after derivative or database failure, and public-path allowlisting.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/manual-ai-http.test.mjs`
Expected: FAIL because multipart parsing and persistence do not exist.

- [ ] **Step 3: Implement bounded parsing and atomic writes**

Parse only `multipart/form-data` with one image part and six known text fields. Stop reading once the request limit is exceeded. Persist under `public/generated-ai-images/drafts/{draftId}/main/manual/`, using `manual-r{revision}-v{version}-original.{ext}` and `manual-r{revision}-v{version}-coupang-1000x1000.jpg`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/manual-ai-http.test.mjs`
Expected: multipart, cleanup, immutability, and asset-path tests pass.

- [ ] **Step 5: Commit the task**

```powershell
git add src/manual-ai/multipart.mjs src/manual-ai/workflow-store.mjs src/public-assets.mjs tests/manual-ai-http.test.mjs
git commit -m "feat: persist manual AI uploads safely"
```

### Task 5: HTTP Workflow API

**Files:**
- Modify: `src/admin-store.mjs`
- Modify: `src/admin-server.mjs`
- Extend: `tests/manual-ai-http.test.mjs`

**Interfaces:**
- Adds `GET .../package`, `GET .../results`, `POST .../upload`, `POST .../results/:imageId/approve`, and `POST .../results/:imageId/reject`.
- Produces stable JSON errors with codes and 4xx statuses; package endpoint returns ZIP headers.

- [ ] **Step 1: Write failing route-level tests**

Exercise API-key-free package download and upload; provider validation; custom display name; matching draft/request/current revision; stale prompt; every image validation failure; multiple versions; approval/rejection; and no invocation of provider settings or provider methods.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/manual-ai-http.test.mjs`
Expected: 404/405 responses because workflow routes are absent.

- [ ] **Step 3: Implement routes and context queries**

Fetch the current main-image prompt and source representative image, call the focused services, and map error codes to 400/404/409/413/415/422. Do not pass `aiSecrets` into manual workflow functions. Disable the existing provider connection-test endpoint with `409 { code:'MANUAL_WORKFLOW_ACTIVE' }` for this phase.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/manual-ai-http.test.mjs`
Expected: all package, upload, metadata, approval, and no-credential tests pass.

- [ ] **Step 5: Commit the task**

```powershell
git add src/admin-store.mjs src/admin-server.mjs tests/manual-ai-http.test.mjs
git commit -m "feat: expose manual main image workflow API"
```

### Task 6: Export and Debug History

**Files:**
- Modify: `src/admin-store.mjs`
- Extend: `tests/admin-store.test.mjs`
- Extend: `tests/manual-ai-workflow-store.test.mjs`

**Interfaces:**
- `exportProductDraft` queries `getApprovedManualMainImage` and passes it into both export formatters.
- `buildDebugExport` adds metadata-only `manualAiMainImages` history.

- [ ] **Step 1: Write failing export tests**

Cover fallback before approval, approved `coupang_stored_url` first after approval, original URL never selected, rejected/superseded/oversized/non-JPEG rows ignored, latest current approval used, history retained, and unchanged existing Coupang/Naver fields.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/admin-store.test.mjs tests/manual-ai-workflow-store.test.mjs`
Expected: export still uses only original main images and debug export lacks history.

- [ ] **Step 3: Implement safe export selection**

Validate the selected row again at export boundary: approved, JPEG, 1000x1000, `coupang_file_size < 3_000_000`, and non-empty derivative URL. Prepend the derivative to the existing representative image list and de-duplicate. Add metadata-only history to debug export.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/admin-store.test.mjs tests/manual-ai-workflow-store.test.mjs`
Expected: all export selection and history tests pass.

- [ ] **Step 5: Commit the task**

```powershell
git add src/admin-store.mjs tests/admin-store.test.mjs tests/manual-ai-workflow-store.test.mjs
git commit -m "feat: export approved manual AI main images"
```

### Task 7: Admin Comparison UI

**Files:**
- Modify: `src/admin-server.mjs`
- Create: `tests/manual-ai-admin-html.test.mjs`

**Interfaces:**
- The existing `renderAiPromptSectionsV1` loads workflow results and renders controls with stable `data-*` selectors.
- Clipboard helper returns the method used and updates revision/hash feedback.

- [ ] **Step 1: Write failing HTML behavior tests**

Assert package/copy/upload/approve/reject controls, provider options, conditional custom-name input, comparison columns, empty-state text, history selector, and the optional-provider notice. Assert provider connection-test controls are disabled.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/manual-ai-admin-html.test.mjs`
Expected: required selectors and notice are missing.

- [ ] **Step 3: Implement the UI**

Use `FormData` for upload, refresh results after transitions, default to the newest version, keep old versions selectable, and implement `navigator.clipboard.writeText` with temporary-textarea fallback. Display revision and 12-character hash after copy. Never inspect API provider configuration to enable manual controls.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/manual-ai-admin-html.test.mjs`
Expected: all UI structure and behavior assertions pass.

- [ ] **Step 5: Commit the task**

```powershell
git add src/admin-server.mjs tests/manual-ai-admin-html.test.mjs
git commit -m "feat: add manual AI comparison UI"
```

### Task 8: Draft 64 Playwright and Full Verification

**Files:**
- Create: `scripts/verify-manual-main-image.mjs`
- Modify: `package.json`

**Interfaces:**
- Adds `npm.cmd run verify:manual-main-image`.
- Produces `artifacts/manual-main-image-draft-64-result.json` and screenshot without uploading or approving paid/generated content.

- [ ] **Step 1: Write the verification script**

Start the local admin server, visit `/admin?draftId=64`, open the relevant panel, and assert all requested controls, provider selector, API-key-independent enablement, comparison area, empty state when applicable, and approval/rejection buttons. Collect console errors, page errors, and failed requests. Query draft 64 HTML and verify exact length/hash.

- [ ] **Step 2: Run focused verification**

Run: `npm.cmd run verify:manual-main-image`
Expected: exit 0 with empty browser error arrays and correct HTML invariants.

- [ ] **Step 3: Run the complete automated suite**

Run: `npm.cmd test`
Expected: exit 0 with every existing and new test passing.

- [ ] **Step 4: Verify database and schema invariants**

Run: `node scripts/db-check.js`
Expected: `postgresConnection=true` and `postgresStatus=enabled`.

Run a read-only SQL check through the project DB connection confirming zero or one approved main image per draft and that draft 64 HTML still matches the exact SHA-256.

- [ ] **Step 5: Review the final diff against prohibited changes**

Run: `git diff --check` and `git status --short`.
Confirm no paid provider call, connection test, detail-image workflow, original-image overwrite, or HTML mutation was introduced.

- [ ] **Step 6: Commit verification assets and scripts**

```powershell
git add package.json scripts/verify-manual-main-image.mjs
git commit -m "test: verify manual main image workflow"
```

## Final Report Contract

Report exact fresh evidence for:

```text
manualWorkflowImplemented
paidApiCalls
apiKeyRequiredForManualWorkflow
packageDownloadAvailable
promptCopyAvailable
manualUploadAvailable
supportedUploadFormats
providerMetadataSupported
approvalWorkflowImplemented
approvedImageUsedInExport
originalMainImageUnchanged
generatedDetailHtmlUnchanged
browserConsoleErrors
browserPageErrors
failedRequests
testsPassed
```

`paidApiCalls` must be `0`.
