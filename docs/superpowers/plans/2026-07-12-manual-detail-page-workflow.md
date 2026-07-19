# Manual Detail Page Image Set Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an API-key-free manual external-AI workflow that packages draft 64 detail-page inputs, atomically accepts an ordered ten-image set, approves one set at a time, and exposes approved registration JPEGs alongside unchanged HTML exports.

**Architecture:** Keep the completed main-image workflow untouched. Add detail-specific section, package, streaming multipart, image-processing, persistence, and service modules under `src/manual-ai/`; store parent set state separately from ten ordered image rows; append approved-set metadata to exports without changing `generated_detail_html`.

**Tech Stack:** Node.js 24 ESM, PostgreSQL 18, `busboy`, `archiver`, `sharp`, built-in `node:test`, Playwright.

## Global Constraints

- Never require or read `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, or `AUTOMONEY_CREDENTIAL_MASTER_KEY` for this workflow.
- Never call a provider connection test or paid AI API; `paidApiCalls` must remain 0.
- Implement only draft 64 `task_type=detail_page` behavior first; do not alter the working `main_image` workflow or its approved row/files.
- Accept exactly ten ordered images; every other count returns HTTP 422 `DETAIL_IMAGE_COUNT_INVALID` and leaves no DB row or final file.
- Preserve `generated_detail_html` length 3896 and SHA-256 `67ee716e9d48a39ae8a744e3451c3d7bd198399227aaf4b87997be54b86c5758`.
- Preserve HTML detail page v2 and existing Coupang/Naver `detailHtml`/`detailContent` fields.
- Original image maximum is 10,000,000 bytes each; dimensions are 860x1100 minimum, 5000 maximum per side, 25MP maximum, portrait ratio `width/height` 0.45 through 0.90.
- Registration images are non-enlarged, non-cropped, aspect-preserving sRGB JPEGs without source metadata; per-image maximum is 1.5MB and ten-image aggregate maximum is 10MB.
- JPEG qualities are tried in order `92, 88, 84, 80`, targeting at most 800KB and never going below 80.
- Keep untracked `artifacts/` and `public/generated-ai-images/` user data out of implementation commits.

## File Map

- Create `src/manual-ai/detail-sections.mjs`: the revision-associated ten-section snapshot.
- Create `src/manual-ai/detail-image-processing.mjs`: detail validation and registration JPEG optimization.
- Create `src/manual-ai/detail-multipart.mjs`: bounded streaming multipart intake and staging cleanup.
- Create `src/manual-ai/detail-package-builder.mjs`: detail ZIP metadata and source/reference assembly.
- Create `src/manual-ai/detail-workflow-service.mjs`: prompt/provider/count validation and upload orchestration.
- Create `src/manual-ai/detail-workflow-store.mjs`: set versions, persistence, listing, approval/rejection, approved lookup.
- Modify `schema.sql`; create `migrations/2026-07-12-manual-detail-page-workflow.sql`.
- Modify `src/admin-store.mjs`: detail workflow context, export fields, debug history.
- Modify `src/admin-server.mjs`: routes, error mapping, detail set UI and drag ordering.
- Modify `src/public-assets.mjs`: detail manual asset allowlist.
- Modify `package.json` and `package-lock.json`: add `busboy`, focused tests, and Playwright verifier.
- Create focused tests and `scripts/verify-manual-detail-page.mjs`.

---

### Task 1: Canonical Detail Section Snapshot and Prompt Context

**Files:**
- Create: `src/manual-ai/detail-sections.mjs`
- Modify: `src/admin-store.mjs`
- Create: `tests/manual-ai-detail-context.test.mjs`

**Interfaces:**
- Produces `DETAIL_PAGE_EXPECTED_COUNT = 10` and `getDetailPageSections()` returning fresh `{index,key,label}` objects.
- Produces `getManualDetailWorkflowContext(db, draftId)` returning `{draft,request,sections,mainImage,detailImages,referenceImages}` with computed prompt state.

- [ ] **Step 1: Write failing section/context tests**

```js
test('draft 64 detail context uses the current revision-one ten-section snapshot', async () => {
  const context = await getManualDetailWorkflowContext(detailContextDb(), 64);
  assert.equal(context.request.id, 8);
  assert.equal(context.request.revision, 1);
  assert.equal(context.request.state, 'current');
  assert.deepEqual(context.sections.map(x => x.key), [
    'hero','review','core_values','point_01','point_02',
    'point_03','comparison','detail','color_size','product_info',
  ]);
  assert.equal(context.sections.length, 10);
});
```

Also assert local `detail_source_full` preference, URL de-duplication, and at least one detail/reference asset.

- [ ] **Step 2: Run RED**

Run: `node tests/manual-ai-detail-context.test.mjs`
Expected: fail because `detail-sections.mjs` and `getManualDetailWorkflowContext` do not exist.

- [ ] **Step 3: Implement the minimal snapshot and context query**

Export an immutable canonical array but return cloned items to callers. Reuse `computeImagePromptState`; map existing `getProductDraft` images and request JSON URLs without mutating main-image context code.

- [ ] **Step 4: Run GREEN**

Run: `node tests/manual-ai-detail-context.test.mjs`
Expected: all context tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/manual-ai/detail-sections.mjs src/admin-store.mjs tests/manual-ai-detail-context.test.mjs
git commit -m "feat: add manual detail workflow context"
```

### Task 2: Detail Set Schema and Approval State Machine

**Files:**
- Modify: `schema.sql`
- Create: `migrations/2026-07-12-manual-detail-page-workflow.sql`
- Create: `src/manual-ai/detail-workflow-store.mjs`
- Create: `tests/manual-ai-detail-store.test.mjs`

**Interfaces:**
- Produces `reserveDetailSetVersion(client,draftId)`, `insertDetailSet(client,input)`, `listManualDetailSets(db,draftId)`, `approveManualDetailSet(db,draftId,setId,note)`, `rejectManualDetailSet(db,draftId,setId,note)`, and `getApprovedManualDetailSet(db,draftId)`.
- Public sets contain an ordered `images` array with camelCase metadata.

- [ ] **Step 1: Write failing store tests**

```js
test('second complete set approval supersedes the previous set and all children', async () => {
  const db = detailApprovalDb({ currentId: 20, targetId: 21, targetCount: 10 });
  const result = await approveManualDetailSet(db, 64, 21, 'approved');
  assert.equal(result.superseded.status, 'superseded');
  assert.equal(result.superseded.supersededBySetId, 21);
  assert.equal(result.approved.status, 'approved');
  assert.equal(result.approved.images.length, 10);
  assert.ok(db.sql.some(sql => /generated_ai_detail_images[\s\S]*superseded/.test(sql)));
});
```

Cover first approval, target ownership, exactly-ten approval guard, rejection, history ordering, and safe approved lookup.

- [ ] **Step 2: Run RED**

Run: `node tests/manual-ai-detail-store.test.mjs`
Expected: fail because the detail store is missing.

- [ ] **Step 3: Add schema and transactional store**

Create `generated_ai_detail_sets` and `generated_ai_detail_images` exactly as specified. Add:

```sql
create unique index if not exists uq_generated_ai_detail_sets_one_approved
on generated_ai_detail_sets(product_draft_id, task_type)
where status='approved';
```

Use `SELECT ... FOR UPDATE`, update parent and children together, and rollback on any failure.

- [ ] **Step 4: Run GREEN and apply schema**

Run: `node tests/manual-ai-detail-store.test.mjs`
Expected: all store tests pass.

Run a one-off project DB connection through `runSchema(db)`.
Expected: schema applies and both detail tables/index exist.

- [ ] **Step 5: Commit**

```powershell
git add schema.sql migrations/2026-07-12-manual-detail-page-workflow.sql src/manual-ai/detail-workflow-store.mjs tests/manual-ai-detail-store.test.mjs
git commit -m "feat: persist manual detail image sets"
```

### Task 3: Detail Image Validation and Optimization

**Files:**
- Create: `src/manual-ai/detail-image-processing.mjs`
- Create: `tests/manual-ai-detail-image-processing.test.mjs`

**Interfaces:**
- Produces `validateDetailSourceImage(buffer,declaredMime,imageIndex)`.
- Produces `createDetailRegistrationJpeg(buffer,imageIndex)` returning `{buffer,mimeType:'image/jpeg',width,height,fileSize,jpegQuality}`.
- Produces `assertDetailSetAggregate(images)` enforcing normalized total at most 10,000,000 bytes.

- [ ] **Step 1: Write failing processor tests**

```js
test('alpha portrait is flattened white without crop or enlargement', async () => {
  const input = await sharp({create:{width:860,height:1100,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
  const validated = await validateDetailSourceImage(input,'image/png',1);
  const output = await createDetailRegistrationJpeg(input,1);
  const metadata = await sharp(output.buffer).metadata();
  assert.deepEqual([validated.width,validated.height],[860,1100]);
  assert.deepEqual([metadata.width,metadata.height],[860,1100]);
  assert.equal(metadata.format,'jpeg');
  assert.equal(metadata.space,'srgb');
  assert.ok(output.fileSize <= 1_500_000);
});
```

Add fixtures for PNG/JPEG/WebP, MIME mismatch, corrupt bytes, 10MB, minimums, 5000 side, 25MP, landscape, ratios below 0.45/above 0.90, 1000-width downscale, no upscale, aspect preservation, stripped metadata, quality ladder, indexed optimization error, and aggregate >10MB.

- [ ] **Step 2: Run RED**

Run: `node tests/manual-ai-detail-image-processing.test.mjs`
Expected: missing module failure.

- [ ] **Step 3: Implement processor**

Reuse signature detection from `image-processing.mjs`. Decode fully with Sharp, flatten `{background:'#fff'}`, resize only when `width>1000` with `withoutEnlargement:true`, call `toColourspace('srgb')`, omit `withMetadata`, and try `[92,88,84,80]`. Accept the first result `<=800_000`; at 80 accept only `<=1_500_000`, otherwise throw `DETAIL_IMAGE_OPTIMIZATION_FAILED` with `imageIndex`.

- [ ] **Step 4: Run GREEN**

Run: `node tests/manual-ai-detail-image-processing.test.mjs`
Expected: every validation and conversion test passes.

- [ ] **Step 5: Commit**

```powershell
git add src/manual-ai/detail-image-processing.mjs tests/manual-ai-detail-image-processing.test.mjs
git commit -m "feat: optimize manual detail images"
```

### Task 4: Streaming Ten-File Multipart and Atomic Staging

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/manual-ai/detail-multipart.mjs`
- Create: `tests/manual-ai-detail-multipart.test.mjs`

**Interfaces:**
- Produces `receiveDetailMultipart(request,{rootDir,draftId})` returning `{stagingDir,images,fields,cleanup}`; each image is an ordered staged file descriptor.
- Produces `finalizeDetailSetDirectory({stagingDir,rootDir,draftId,revision,setVersion})` and `removeDetailSetDirectory(...)`.

- [ ] **Step 1: Install and record `busboy`**

Run: `npm.cmd install busboy`
Expected: dependency and lockfile update, zero audit vulnerabilities.

- [ ] **Step 2: Write failing streaming tests**

```js
test('eight files fail with the exact 422 payload contract and no residue', async () => {
  const request = multipartRequest(detailFiles(8));
  await assert.rejects(
    () => receiveDetailMultipart(request,{rootDir,draftId:64}),
    error => error.code==='DETAIL_IMAGE_COUNT_INVALID' &&
      error.expectedCount===10 && error.receivedCount===8,
  );
  assert.deepEqual(await stagedEntries(rootDir),[]);
});
```

Cover 9/11 files, unknown fields, wrong field name, per-file 10MB, bounded aggregate input, exact order, duplicate filenames, cleanup, immutable final version paths, and no partial final directory.

- [ ] **Step 3: Run RED**

Run: `node tests/manual-ai-detail-multipart.test.mjs`
Expected: missing module failure.

- [ ] **Step 4: Implement Busboy receiver and directory operations**

Accept only `images[]` plus five known text fields. Stream each file with an independent 10,000,000-byte counter, abort and clean up on limit/error, and return files in multipart arrival order. Rename the entire staging directory to `public/generated-ai-images/drafts/{draftId}/detail/manual/r{revision}-v{setVersion}` only after orchestration succeeds.

- [ ] **Step 5: Run GREEN**

Run: `node tests/manual-ai-detail-multipart.test.mjs`
Expected: all streaming, count, order, and cleanup tests pass.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json src/manual-ai/detail-multipart.mjs tests/manual-ai-detail-multipart.test.mjs
git commit -m "feat: receive ordered detail image sets"
```

### Task 5: Detail Work Package

**Files:**
- Create: `src/manual-ai/detail-package-builder.mjs`
- Create: `tests/manual-ai-detail-package.test.mjs`

**Interfaces:**
- Consumes `getManualDetailWorkflowContext` output.
- Produces `buildDetailPagePackage(context,{fetchImpl,readLocalAsset})` returning `{filename,buffer,entries}`.

- [ ] **Step 1: Write failing ZIP tests**

```js
test('detail package snapshots revision one and ten expected sections', async () => {
  const result = await buildDetailPagePackage(detailPackageContext(),{fetchImpl});
  assert.equal(result.filename,'draft-64-detail-page-r1.zip');
  const info = JSON.parse(result.entries.find(x=>x.name==='03-product-info.json').data);
  assert.equal(info.expectedImageCount,10);
  assert.equal(info.promptRevision,1);
  assert.deepEqual(info.sections.map(x=>x.index),[1,2,3,4,5,6,7,8,9,10]);
});
```

Assert exact prompt/instruction filenames, main/detail/reference folders, local-first behavior, URL de-duplication, optional remote skip, current prompt requirement, and failure with zero usable images. Assert no credential options exist.

- [ ] **Step 2: Run RED**

Run: `node tests/manual-ai-detail-package.test.mjs`
Expected: missing builder failure.

- [ ] **Step 3: Implement ZIP builder**

Use `ZipArchive`; derive file extensions from signatures; serialize product/options/section metadata without secrets; add Korean instructions requiring an ordered ten-image portrait set.

- [ ] **Step 4: Run GREEN**

Run: `node tests/manual-ai-detail-package.test.mjs`
Expected: all package tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/manual-ai/detail-package-builder.mjs tests/manual-ai-detail-package.test.mjs
git commit -m "feat: build manual detail work packages"
```

### Task 6: Atomic Upload Service and HTTP API

**Files:**
- Create: `src/manual-ai/detail-workflow-service.mjs`
- Modify: `src/admin-server.mjs`
- Create: `tests/manual-ai-detail-service.test.mjs`
- Create: `tests/manual-ai-detail-http.test.mjs`

**Interfaces:**
- Produces `validateManualDetailMetadata(context,fields)`.
- Produces `uploadManualDetailSet({db,rootDir,draftId,request})` coordinating staging, validation, conversion, DB transaction, directory rename, commit, and cleanup.
- Adds package/results/upload and set approve/reject endpoints under `/ai-workflows/detail-page/`.

- [ ] **Step 1: Write failing service/API tests**

```js
test('one invalid image rolls back rows and removes all staged/final files', async () => {
  const harness = detailUploadHarness({ invalidIndex:4 });
  await assert.rejects(() => uploadManualDetailSet(harness.input), {imageIndex:4});
  assert.equal(harness.db.commits,0);
  assert.equal(harness.db.rollbacks,1);
  assert.deepEqual(await harness.finalFiles(),[]);
});
```

Cover exact 422 body, prompt request/revision/current checks, provider metadata, correct ordering, ten successful inserts, normalized aggregate, transaction failure after rename cleanup, DB failure before rename cleanup, no API secret reads, listing, approve, and reject route status mapping.

- [ ] **Step 2: Run RED**

Run: `node tests/manual-ai-detail-service.test.mjs && node tests/manual-ai-detail-http.test.mjs`
Expected: missing service/routes failure.

- [ ] **Step 3: Implement orchestration and routes**

The service must own the transaction boundary and call store methods with the same client. Map count errors to the exact requested HTTP 422 object; map format to 415, bytes to 413, and validation/prompt/optimization errors to 409/422. Do not pass `aiSecrets` to any detail function.

- [ ] **Step 4: Run GREEN**

Run: `node tests/manual-ai-detail-service.test.mjs && node tests/manual-ai-detail-http.test.mjs`
Expected: all atomicity and route tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/manual-ai/detail-workflow-service.mjs src/admin-server.mjs tests/manual-ai-detail-service.test.mjs tests/manual-ai-detail-http.test.mjs
git commit -m "feat: expose manual detail image workflow"
```

### Task 7: Approved Detail Set Export and Debug History

**Files:**
- Modify: `src/admin-store.mjs`
- Modify: `tests/admin-store.test.mjs`
- Create: `tests/manual-ai-detail-export.test.mjs`

**Interfaces:**
- Both export formatters receive `approvedDetailSet` and emit the five approved-AI-detail fields.
- `buildDebugExport` emits metadata-only `manualAiDetailSets` history.

- [ ] **Step 1: Write failing export tests**

```js
test('approved registration JPEGs are exported in index order beside unchanged HTML', async () => {
  const result = await exportProductDraft(detailExportDb({status:'approved'}),64,'coupang');
  assert.equal(result.detailHtml,ORIGINAL_HTML);
  assert.equal(result.approvedAiDetailImages.length,10);
  assert.match(result.approvedAiDetailImages[0],/-01-registered\.jpg$/);
  assert.equal(result.approvedAiDetailSetVersion,1);
  assert.equal(result.approvedAiDetailPromptRevision,1);
});
```

Cover no approval, uploaded/rejected/superseded exclusions, originals never exported, non-JPEG/over-1.5MB/incomplete/aggregate-over-10MB rejection, Naver parity, main-image URL regression, and debug bytes exclusion.

- [ ] **Step 2: Run RED**

Run: `node tests/manual-ai-detail-export.test.mjs tests/admin-store.test.mjs`
Expected: approved detail fields are absent.

- [ ] **Step 3: Implement export boundary checks**

Emit ordered normalized URLs only when one approved set has exactly ten safe children. Return empty/default fields otherwise. Preserve `detailHtml`, `detailContent`, main image selection, and all existing fields byte-for-byte at the formatter boundary.

- [ ] **Step 4: Run GREEN**

Run: `node tests/manual-ai-detail-export.test.mjs tests/admin-store.test.mjs`
Expected: detail export and existing admin-store tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/admin-store.mjs tests/admin-store.test.mjs tests/manual-ai-detail-export.test.mjs
git commit -m "feat: export approved manual detail sets"
```

### Task 8: Detail Set Admin UI and Drag Reordering

**Files:**
- Modify: `src/admin-server.mjs`
- Create: `tests/manual-ai-detail-admin-html.test.mjs`

**Interfaces:**
- Produces `renderManualDetailWorkflowSection({request,sections,sets})` for unit-verifiable markup.
- Browser code keeps an ordered `File[]`, redraws ten preview slots, and appends files to multipart in displayed order.

- [ ] **Step 1: Write failing UI tests**

```js
test('detail workflow renders ten ordered slots and parallel HTML guidance', () => {
  const html = renderManualDetailWorkflowSection({request,sections,sets:[]});
  assert.match(html,/상세페이지 작업 패키지 다운로드/);
  assert.match(html,/multiple/);
  assert.equal((html.match(/data-detail-slot=/g)||[]).length,10);
  assert.match(html,/HTML 상세페이지 v2/);
  assert.match(html,/생성된 상세페이지 이미지 세트 없음/);
});
```

Assert copy controls, feedback metadata, provider/custom input, notes, drag attributes, count guard, thumbnails, labels, dimensions/status, set history, approval/rejection, and unchanged main workflow selectors.

- [ ] **Step 2: Run RED**

Run: `node tests/manual-ai-detail-admin-html.test.mjs`
Expected: detail set UI is absent.

- [ ] **Step 3: Implement UI**

Append the detail workflow immediately after the existing detail prompt card. Use file input `multiple`, dragstart/dragover/drop reordering, object-URL cleanup, displayed count, and client-side exact-ten guard while retaining server enforcement. Build `FormData` in current slot order. Refresh sets after upload/approve/reject.

- [ ] **Step 4: Run GREEN**

Run: `node tests/manual-ai-detail-admin-html.test.mjs tests/manual-ai-admin-html.test.mjs`
Expected: detail and main UI tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/admin-server.mjs tests/manual-ai-detail-admin-html.test.mjs
git commit -m "feat: add manual detail set review UI"
```

### Task 9: Public Asset Access and Draft 64 Playwright

**Files:**
- Modify: `src/public-assets.mjs`
- Modify: `tests/public-assets.test.mjs`
- Create: `scripts/verify-manual-detail-page.mjs`
- Modify: `package.json`

**Interfaces:**
- Adds `npm.cmd run verify:manual-detail-page`.
- Produces `artifacts/manual-detail-page-draft-64-result.json` and screenshot; these remain untracked.

- [ ] **Step 1: Write failing asset and Playwright verifier assertions**

Allow only `/generated-ai-images/drafts/{id}/detail/manual/r{revision}-v{version}/safe-file` and reject traversal/other task paths. In the verifier assert package/copy controls, multiple file input, provider, empty state, ten slots, set approval, revision 1 metadata, and all browser error arrays.

- [ ] **Step 2: Run asset RED**

Run: `node tests/public-assets.test.mjs`
Expected: detail manual path is rejected before allowlist implementation.

- [ ] **Step 3: Implement allowlist and verifier script**

Use the existing server lifecycle pattern. Do not create, upload, or approve synthetic images. Fetch the real detail package and assert HTTP 200 plus ZIP signature. Query HTML read-only and verify exact length/hash.

- [ ] **Step 4: Run focused browser verification**

Run: `npm.cmd run verify:manual-detail-page`
Expected: package status 200, ten slots, enabled credential-free controls, revision 1, empty browser error arrays, exact HTML invariants.

- [ ] **Step 5: Commit**

```powershell
git add src/public-assets.mjs tests/public-assets.test.mjs scripts/verify-manual-detail-page.mjs package.json
git commit -m "test: verify manual detail page workflow"
```

### Task 10: Full Regression and Completion Evidence

**Files:**
- Modify: `scripts/check-manual-main-image-invariants.mjs` only if a read-only detail invariant query can be added without changing main checks.

**Interfaces:**
- Final report supplies every requested key from fresh evidence.

- [ ] **Step 1: Run every focused detail test**

Run all `tests/manual-ai-detail-*.test.mjs` sequentially with `node`.
Expected: zero failures.

- [ ] **Step 2: Run the complete project suite**

Run: `npm.cmd test`
Expected: all existing main workflow, export, HTML, and new detail tests pass.

- [ ] **Step 3: Run browser regressions**

Run: `npm.cmd run verify:admin-ui`

Run: `npm.cmd run verify:manual-main-image`

Run: `npm.cmd run verify:manual-detail-page`

Expected: all exit 0 with empty console/page/request error arrays.

- [ ] **Step 4: Verify DB and immutable data**

Run read-only queries confirming at most one approved main image, at most one approved detail set, draft 64 detail request remains revision 1 unless the user explicitly regenerated it, and exact HTML length/hash. Confirm the existing approved main result remains `approved` and its two files still exist.

- [ ] **Step 5: Audit prohibited behavior and workspace scope**

Run: `git diff --check`, `git status --short`, and focused secret/paid-call searches.
Confirm no API keys, paid calls, generated detail HTML mutation, representative workflow mutation, user images, or artifacts are staged.

- [ ] **Step 6: Commit any final test-script-only adjustment**

```powershell
git add scripts/check-manual-main-image-invariants.mjs
git commit -m "chore: verify manual detail image workflow"
```

Skip this commit when Step 4 required no tracked-file change.

## Final Report Contract

```text
manualDetailWorkflowImplemented
paidApiCalls
apiKeyRequiredForManualWorkflow
detailPackageDownloadAvailable
detailPromptCopyAvailable
detailManualUploadAvailable
expectedImageCount
multiUploadSupported
detailApprovalWorkflowImplemented
approvedDetailSetUsedInExport
generatedDetailHtmlUnchanged
browserConsoleErrors
browserPageErrors
failedRequests
testsPassed
```

`paidApiCalls` must be `0`.
