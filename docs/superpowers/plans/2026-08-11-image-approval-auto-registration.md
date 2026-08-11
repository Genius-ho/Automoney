# Image Approval Auto-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move queued products through analysis and image generation before registration, automatically create or reuse a Coupang temporary listing once both image sets are approved, notify Telegram for the final human sale-approval decision, and reconcile the queue to the live Coupang state.

**Architecture:** `processing_queue` becomes the source of truth for the corrected lifecycle, with atomic compare-and-set transitions guarding external side effects. A focused `image-approval-registration` service coordinates approved-image readiness, existing-registration reuse, Coupang registration, Telegram notification, and queue reconciliation; HTTP approval routes and the scheduler call this service through dependency-injected seams. Existing registration and Telegram modules remain responsible for their external APIs.

**Tech Stack:** Node.js 24 ESM, PostgreSQL, native `node:test`, existing Coupang client/registration flow, existing Telegram notifier and callback router.

## Global Constraints

- Preserve the fixed schedule: draft 07:00 KST, analysis 08:00 KST, images 09:00 KST, discovery every three days at 10:00 KST.
- Require both an approved main image and an approved detail-image set before registration.
- Never call Coupang create-product when `coupang_product_registrations` already links the draft.
- Atomically claim `awaiting_image_approval -> registering` before any external registration call.
- Keep final Coupang sale approval as a Telegram human action; never press it automatically.
- Preserve protected-draft and registration-readiness guards.
- Human-wait and terminal queue rows must not block discovery; supplier-product and draft deduplication remains active.
- Migrate rows in place without deleting queue, draft, image, or registration data.
- Do not change order, shipment, return, supplier-monitor, dispatch, Telegram polling, or other operational intervals.
- Do not expose `.env`, credentials, customer data, or raw external error bodies.

---

## File Structure

- `migrations/2026-08-11-image-approval-auto-registration.sql`: expands the queue status constraint and performs data-driven lifecycle normalization.
- `schema.sql`: declares the corrected queue status vocabulary for clean installations.
- `src/processing-queue-store.mjs`: owns queue lookups, backlog semantics, atomic claims, completion, failure, and reconciliation candidates.
- `src/auto-discovery-batch.mjs`: advances only the draft, analysis, and image stages at their scheduled boundaries.
- `src/image-approval-registration.mjs`: coordinates image readiness, registration reuse/create, Telegram notification, and live-state reconciliation.
- `src/admin-server.mjs`: invokes the coordinator after either image approval and exposes corrected labels/actions.
- `src/coupang-telegram-approval.mjs`: applies refreshed live Coupang approval state to the queue.
- `src/scheduler.mjs`: runs lightweight registration reconciliation on the existing operational heartbeat without changing its interval.
- `tests/processing-queue-store.test.mjs`: verifies SQL predicates and atomic transition behavior.
- `tests/auto-discovery-batch.test.mjs`: verifies corrected stage order and discovery backlog behavior.
- `tests/image-approval-registration.test.mjs`: verifies orchestration, idempotency, failure recovery, and reconciliation.
- `tests/manual-ai-http.test.mjs`: verifies both approval routes trigger coordination after committing approval.
- `tests/coupang-telegram-approval.test.mjs`: verifies Telegram callback queue completion/failure behavior.
- `tests/scheduler.test.mjs`: verifies reconciliation is wired into the existing heartbeat.

### Task 1: Persist the Corrected Queue Lifecycle

**Files:**
- Create: `migrations/2026-08-11-image-approval-auto-registration.sql`
- Modify: `schema.sql:690`
- Modify: `src/processing-queue-store.mjs`
- Test: `tests/processing-queue-store.test.mjs`

**Interfaces:**
- Produces: `getQueueItemByDraftId(db, draftId) -> QueueItem|null`.
- Produces: `claimQueueItemStatus(db, draftId, fromStatus, toStatus) -> QueueItem|null`, implemented as one conditional `UPDATE ... WHERE draft_id = $1 AND status = $2 RETURNING *`.
- Produces: `listQueueItemsForRegistrationReconciliation(db) -> QueueItem[]` for non-terminal rows with a linked registration.
- Produces: `updateQueueItemStatus(db, id, patch) -> QueueItem|null`, extended so supplied `null` clears stale failure fields rather than being swallowed by SQL `coalesce`.
- Produces: `countActiveQueueItems(db) -> number`, counting only `queued`, `draft_created`, `analyzing`, `analysis_completed`, `generating_images`, and `registering`.

- [ ] **Step 1: Write failing store tests for the lifecycle SQL**

Add tests which capture SQL/params and assert:

```js
assert.match(countSql, /status in \('queued', 'draft_created', 'analyzing', 'analysis_completed', 'generating_images', 'registering'\)/);
assert.deepEqual(claimParams, [119, 'awaiting_image_approval', 'registering']);
assert.match(claimSql, /where draft_id = \$1 and status = \$2/);
assert.match(reconcileSql, /join coupang_product_registrations/);
```

Also return zero rows from the claim query and assert `claimQueueItemStatus(...) === null`; this is the duplicate/concurrent-approval contract.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/processing-queue-store.test.mjs`

Expected: FAIL because the new exports and corrected backlog predicate do not exist.

- [ ] **Step 3: Implement the store API and clean-install schema**

Use the exact allowed statuses:

```sql
('queued','draft_created','analyzing','analysis_completed','generating_images',
 'awaiting_image_approval','registering','awaiting_sale_approval','completed','failed')
```

Keep `isCandidateActiveOrQueued` deduplication independent from the backlog count: any queue row except `failed` remains a duplicate, and `product_drafts.supplier_product_no` remains the second guard.

- [ ] **Step 4: Add the in-place migration**

The migration must:

1. Drop only the existing `processing_queue_status_check` constraint and add the corrected one.
2. Set rows with no registration and legacy `ready_for_registration` to `draft_created` while clearing stale failure metadata.
3. Map every legacy `awaiting_approval` row to `awaiting_image_approval`; the coordinator derives readiness from the actual main/detail approval records rather than from the legacy label.
4. Map any non-terminal row with a registration to `awaiting_sale_approval`; do not hard-code queue IDs or draft IDs.
5. Leave final live completion to reconciliation because the migration must not call Coupang.

Use `DO $$ ... $$` guards so rerunning the migration is safe.

- [ ] **Step 5: Run focused tests and inspect migration safety**

Run: `node --test tests/processing-queue-store.test.mjs`

Expected: PASS. Then run `rg -n "delete from|truncate|drop table|117|118|119" migrations/2026-08-11-image-approval-auto-registration.sql` and expect no destructive statement and no hard-coded representative IDs.

- [ ] **Step 6: Commit the lifecycle store**

```powershell
git add schema.sql migrations/2026-08-11-image-approval-auto-registration.sql src/processing-queue-store.mjs tests/processing-queue-store.test.mjs
git commit -m "feat: add corrected product queue lifecycle"
```

### Task 2: Correct the Scheduled Draft, Analysis, and Image Boundaries

**Files:**
- Modify: `src/auto-discovery-batch.mjs`
- Test: `tests/auto-discovery-batch.test.mjs`

**Interfaces:**
- Consumes: `getNextQueuedItem`, `getNextAnalysisItem`, `getNextImageItem`, `updateQueueItemStatus`, and machine-actionable `countActiveQueueItems` from Task 1.
- Produces: draft success `draft_created`, analysis claim/success `analyzing -> analysis_completed`, and image claim/success `generating_images -> awaiting_image_approval`.

- [ ] **Step 1: Replace legacy expectations with failing lifecycle tests**

Assert the focused runners emit this exact sequence:

```js
assert.ok(updates.some((u) => u.id === 1 && u.status === 'draft_created'));
assert.ok(updates.some((u) => u.id === 2 && u.status === 'analysis_completed'));
assert.ok(updates.some((u) => u.id === 3 && u.status === 'awaiting_image_approval'));
```

Add a discovery test where the store reports zero actionable backlog despite human-wait rows, and assert discovery enqueues eligible, non-duplicate winners.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/auto-discovery-batch.test.mjs`

Expected: FAIL on legacy `ready_for_registration` / `awaiting_approval` transitions.

- [ ] **Step 3: Implement minimal stage transition changes**

Change `runDraftPreparationStage` and the compatibility `runDailyProcessingBatch` draft branch to land at `draft_created`. Make `getNextAnalysisItem` select `draft_created` and resumable `analyzing`; claim a fresh row as `analyzing` before work. Make image selection accept `analysis_completed` and resumable `generating_images`; claim before work and finish at `awaiting_image_approval`. Update comments and `mapCandidateStatusToQueueStatus` to the exact new names.

- [ ] **Step 4: Run stage and schedule regression tests**

Run: `node --test tests/auto-discovery-batch.test.mjs tests/product-automation-schedule.test.mjs tests/batch-schedule-store.test.mjs`

Expected: PASS with schedule timestamps unchanged.

- [ ] **Step 5: Commit corrected scheduling flow**

```powershell
git add src/auto-discovery-batch.mjs tests/auto-discovery-batch.test.mjs
git commit -m "feat: process drafts and images before registration"
```

### Task 3: Coordinate Approval-Triggered Coupang Registration

**Files:**
- Create: `src/image-approval-registration.mjs`
- Create: `tests/image-approval-registration.test.mjs`

**Interfaces:**
- Consumes: `claimQueueItemStatus`, `getQueueItemByDraftId`, `updateQueueItemStatus` from Task 1.
- Consumes: `createDirectRegistration(db, rootDir, draftId, { mode: 'raw', confirm: true, coupangConfig, clientImpl })`.
- Consumes: existing approved-image reads and `getRegistrationByDraftId(db, draftId)`.
- Consumes: `notifyPendingCoupangSaleApprovals(db, telegramConfig, deps)`.
- Produces: `handleApprovedImages(db, rootDir, draftId, options) -> { outcome: 'not_ready'|'not_queued'|'already_claimed'|'awaiting_sale_approval', registration? }`.
- Produces: `reconcileCoupangQueue(db, options) -> { checked, completed, awaiting, failed }`.

- [ ] **Step 1: Write failing readiness and idempotency tests**

Use injected fakes to verify:

```js
assert.equal((await handleApprovedImages(db, root, 118, depsWithoutDetail)).outcome, 'not_ready');
assert.equal(createCalls, 0);
assert.equal((await handleApprovedImages(db, root, 119, depsWithLostClaim)).outcome, 'already_claimed');
assert.equal(createCalls, 0);
```

Add a `Promise.all` double-call test whose claim fake succeeds once; assert `createDirectRegistrationImpl` runs exactly once.

Add named representative fixtures without putting their IDs in production logic: draft 117 derives its action from image/registration records, draft 118 with no registration returns to the pre-registration pipeline, and draft 119 with a linked approved seller product reconciles to `completed`. Assert the same decisions when fixture IDs are changed, proving the behavior is data-driven.

- [ ] **Step 2: Write failing create/reuse/notification tests**

Cover three cases:

1. Both approvals + successful claim + no registration: call `createDirectRegistrationImpl` once with raw/confirmed options, then notification once, then set `awaiting_sale_approval` and clear failures.
2. Existing registration: skip create, notify, then set `awaiting_sale_approval`.
3. Create succeeds but notification throws: set `failed` with `failureStage: 'telegram_sale_approval_notification'`; on retry, reuse the linked registration and never create twice.

Assert stored failure messages are sanitized stable codes/messages, not raw HTTP response bodies.

- [ ] **Step 3: Run the new test and verify RED**

Run: `node --test tests/image-approval-registration.test.mjs`

Expected: FAIL because the coordinator module does not exist.

- [ ] **Step 4: Implement the coordinator minimally**

Order operations exactly:

```text
read both approved image records
-> return not_ready if either is absent
-> atomic claim awaiting_image_approval to registering
-> return already_claimed when no row was claimed
-> read existing registration
-> create only if absent
-> notify pending sale approval
-> update queue to awaiting_sale_approval
```

If the queue is already `registering` or `failed` and a linked registration exists, the reconciliation/retry path may resume notification, but must never call create again.

- [ ] **Step 5: Implement reconciliation tests and code**

For each row returned by `listQueueItemsForRegistrationReconciliation`:

- refresh via the existing Coupang `getProduct` path;
- map normalized live `승인완료` to `completed`;
- map `승인대기중` to `awaiting_sale_approval`;
- map explicit rejection/terminal error to `failed` with `failureStage: 'coupang_sale_approval'`;
- keep transient API/network failures non-terminal and report them in the summary;
- make repeated runs idempotent.

Tests must use Korean status literals and assert no create-product dependency is called during reconciliation.

- [ ] **Step 6: Run coordinator tests**

Run: `node --test tests/image-approval-registration.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the coordinator**

```powershell
git add src/image-approval-registration.mjs tests/image-approval-registration.test.mjs
git commit -m "feat: register Coupang products after image approval"
```

### Task 4: Trigger Registration from Both Image Approval Routes

**Files:**
- Modify: `src/admin-server.mjs:197`
- Modify: `src/admin-server.mjs:215`
- Modify: `src/admin-server.mjs:1266`
- Test: `tests/manual-ai-http.test.mjs`
- Test: `tests/manual-ai-admin-html.test.mjs`

**Interfaces:**
- Consumes: `handleApprovedImages(db, rootDir, draftId, { coupangConfig, telegramConfig, clientImpl })` from Task 3.
- Produces: approval responses with the original `result` plus `autoRegistration`, without changing upload/reject contracts.

- [ ] **Step 1: Add failing HTTP tests for main and detail approvals**

For each existing POST approval route, inject a coordinator spy and assert the store approval happens first and then:

```js
assert.deepEqual(autoRegistrationCall, { draftId: 119 });
assert.equal(response.statusCode, 200);
assert.equal(body.autoRegistration.outcome, 'not_ready'); // first approval is valid but incomplete
```

Add a case where the second approval returns `awaiting_sale_approval`. Add a coordinator failure case asserting an actionable safe 502/500 response while the already-committed image remains approved for reconciliation.

- [ ] **Step 2: Run HTTP tests and verify RED**

Run: `node --test tests/manual-ai-http.test.mjs tests/manual-ai-admin-html.test.mjs`

Expected: FAIL because approval routes do not invoke the coordinator and labels still use legacy states.

- [ ] **Step 3: Wire both routes after approval commit**

Only invoke the coordinator for `approve`, never `reject`. Pass the existing server-owned configuration/client dependencies. Return `autoRegistration` so the UI can show whether it is waiting for the other image, registering, or waiting for Telegram sale approval.

- [ ] **Step 4: Update queue labels and remove the obsolete manual gate**

Add Korean labels for all corrected statuses and remove the Coupang “register now” button as the normal action for lifecycle rows. Keep diagnostic/direct registration endpoints available for operators; do not make them the queue workflow.

- [ ] **Step 5: Run HTTP/UI tests**

Run: `node --test tests/manual-ai-http.test.mjs tests/manual-ai-admin-html.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit route integration**

```powershell
git add src/admin-server.mjs tests/manual-ai-http.test.mjs tests/manual-ai-admin-html.test.mjs
git commit -m "feat: trigger registration from image approvals"
```

### Task 5: Complete Queue State from Telegram Sale Approval

**Files:**
- Modify: `src/coupang-telegram-approval.mjs`
- Modify: `tests/coupang-telegram-approval.test.mjs`

**Interfaces:**
- Consumes: refreshed product returned by the existing approval callback.
- Consumes: `getQueueItemByDraftId` and `updateQueueItemStatus` from Task 1.
- Produces: callback result containing the normalized live status and resulting queue status.

- [ ] **Step 1: Add failing callback lifecycle tests**

Extend injected dependencies with `updateQueueItemStatusImpl` and assert:

```js
assert.equal(completedPatch.status, 'completed');       // live 승인완료
assert.equal(waitingPatch.status, 'awaiting_sale_approval'); // live 승인대기중
assert.equal(rejectedPatch.status, 'failed');           // explicit rejection
```

Repeat the approved callback and assert it remains idempotent and never invokes registration creation.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --test tests/coupang-telegram-approval.test.mjs tests/telegram-callback-router.test.mjs`

Expected: FAIL because callback handling does not synchronize the processing queue.

- [ ] **Step 3: Apply normalized live status after refresh**

Reuse one status-classification helper exported by `image-approval-registration.mjs` so callback and reconciliation cannot disagree. Transient refresh errors leave the queue at `awaiting_sale_approval`; explicit terminal responses store only a safe status/error summary.

- [ ] **Step 4: Run Telegram regression tests**

Run: `node --test tests/coupang-telegram-approval.test.mjs tests/telegram-callback-router.test.mjs tests/telegram-notifier.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Telegram completion tracking**

```powershell
git add src/coupang-telegram-approval.mjs tests/coupang-telegram-approval.test.mjs
git commit -m "feat: complete product queue after Coupang approval"
```

### Task 6: Run Restart Reconciliation on the Existing Heartbeat

**Files:**
- Modify: `src/scheduler.mjs`
- Modify: `tests/scheduler.test.mjs`

**Interfaces:**
- Consumes: `reconcileCoupangQueue(db, options)` from Task 3.
- Produces: at most one non-overlapping reconciliation invocation per existing scheduler heartbeat; no new timer or interval.

- [ ] **Step 1: Add a failing scheduler wiring test**

Inject `reconcileCoupangQueueImpl`, execute one heartbeat, and assert it runs once after normal polling setup. Execute overlapping ticks with a pending promise and assert the second invocation is skipped rather than concurrent.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --test tests/scheduler.test.mjs`

Expected: FAIL because reconciliation is not wired.

- [ ] **Step 3: Add guarded reconciliation to the existing heartbeat**

Use the scheduler’s current lock/error-isolation pattern. Log only summary counts and safe error codes. Do not change `setInterval` durations or Telegram polling configuration.

- [ ] **Step 4: Run scheduler and coordinator tests**

Run: `node --test tests/scheduler.test.mjs tests/image-approval-registration.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit restart recovery**

```powershell
git add src/scheduler.mjs tests/scheduler.test.mjs
git commit -m "feat: reconcile Coupang queue on scheduler heartbeat"
```

### Task 7: Migrate, Verify Representative Data, and Validate End to End

**Files:**
- Modify only if verification exposes a defect: files owned by Tasks 1–6.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: verified Windows runtime state ready for the later Debian 13 transfer.

- [ ] **Step 1: Run all focused tests together**

Run:

```powershell
node --test tests/processing-queue-store.test.mjs tests/auto-discovery-batch.test.mjs tests/image-approval-registration.test.mjs tests/manual-ai-http.test.mjs tests/manual-ai-admin-html.test.mjs tests/coupang-telegram-approval.test.mjs tests/telegram-callback-router.test.mjs tests/scheduler.test.mjs
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the complete regression suite**

Run: `npm test`

Expected: exit code 0. If an unrelated pre-existing failure appears, capture exact output and prove it also occurs on the task base commit before classifying it as unrelated.

- [ ] **Step 3: Back up and apply schema/migration through the project’s existing DB bootstrap path**

Before applying, query and record counts for `product_drafts`, `processing_queue`, `generated_ai_images`, manual detail sets/images, and `coupang_product_registrations`. Apply `schema.sql` plus the new migration using the same startup/bootstrap mechanism already used by the Windows launcher. Re-query counts and require no row loss.

- [ ] **Step 4: Verify data-driven migration expectations**

Read-only queries must establish:

- draft 119 retains seller product `16341358344`; after a live refresh/reconciliation its queue row is `completed` when Coupang reports `승인완료`;
- draft 118 has no registration and is `draft_created`, then can advance only via analysis and image schedule stages;
- draft 117 is derived from its actual image/registration records, with no ID-specific migration branch;
- seller product `16341358344` appears only once and no new seller product was created by migration/reconciliation.

- [ ] **Step 5: Restart the Windows launcher and perform runtime smoke checks**

Start through the existing `Automoney 시작` shortcut, confirm `http://localhost:3000` responds, and inspect the queue UI labels. Approve only a controlled test draft’s missing image gate if one is available; verify first approval reports `not_ready`, second approval reaches `awaiting_sale_approval`, and exactly one Telegram sale-approval message exists. Do not automatically click final sale approval.

- [ ] **Step 6: Verify draft 118 does not register prematurely**

Run the corrected analysis and image stages through their existing manual/admin trigger or wait for their due slots. Confirm there is still no Coupang registration before both image approvals. This is a read-only safety assertion against Coupang product records.

- [ ] **Step 7: Review the final diff and repository hygiene**

Run:

```powershell
git status --short
git diff --check
git log --oneline --decorate -8
```

Expected: only intentional tracked changes/commits; preserve all pre-existing untracked handoff, logo, generated draft image, and one-off diagnostic script files.

- [ ] **Step 8: Commit any verification-only fixes, then rerun affected tests and `npm test`**

```powershell
git add <only-the-intentional-files-fixed>
git commit -m "fix: harden image approval registration recovery"
```

Skip this commit when no fix was needed. Never commit runtime data, `.env`, generated images, or the pre-existing untracked files.
