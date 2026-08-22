# Staggered Product Automation Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run draft preparation at 07:00, analysis at 08:00, image generation at 09:00 daily, and candidate discovery at 10:00 every three days in `Asia/Seoul`, while leaving operational polling schedules unchanged.

**Architecture:** A pure schedule module calculates Korea-time service dates and next slots without host-timezone dependence. Database schedule state tracks each stage independently; focused stage runners process at most one queue item, and the existing five-minute admin heartbeat dispatches only the oldest due stage under the shared lock.

**Tech Stack:** Node.js 24+, PostgreSQL, ES modules, Node test runner, existing admin HTTP/UI.

## Global Constraints

- Fixed timezone: `Asia/Seoul`.
- Daily slots: draft `07:00`, analysis `08:00`, images `09:00`; discovery every three days at `10:00`.
- Process at most one item per stage and at most one product stage per heartbeat.
- Preserve the shared `batch_schedule_state.is_running` lock.
- Preserve existing human registration and image/sale approval gates.
- Do not alter order, shipment, return, supplier-monitor, dispatch, Telegram, notification, or daily-summary intervals.
- Do not reset existing drafts or queue rows, expose secrets, or modify user-owned untracked files.

---

### Task 1: Korea-Time Slot Calculation and Independent Schedule State

**Files:**
- Create: `src/product-automation-schedule.mjs`
- Create: `tests/product-automation-schedule.test.mjs`
- Create: `migrations/2026-08-11-staggered-product-automation-schedule.sql`
- Modify: `schema.sql`
- Modify: `src/batch-schedule-store.mjs`
- Modify: `tests/batch-schedule-store.test.mjs`

**Interfaces:**
- Produces: `PRODUCT_STAGE_SLOTS`, `koreaServiceDate(now)`, `slotForServiceDate(serviceDate, hour)`, `nextDailySlot(now, hour)`, `selectOldestDueStage(state, now)`, and store methods `completeProductStage(db, stage, { serviceDate, nextRunAt, outcome })` and `releaseProductStageLock(db)`.
- Stage identifiers are exactly `draft`, `analysis`, `images`, and `discovery`.

- [ ] **Step 1: Write failing pure schedule tests**

Test UTC/Korea date boundaries, exact 07/08/09/10 slots, once-per-service-date exclusion, and ordered late-start recovery. Use fixed ISO instants, including `2026-08-10T22:30:00.000Z` (07:30 KST) and `2026-08-11T01:30:00.000Z` (10:30 KST).

```js
assert.equal(koreaServiceDate(new Date('2026-08-10T15:30:00Z')), '2026-08-11');
assert.equal(nextDailySlot(new Date('2026-08-10T21:00:00Z'), 7).toISOString(), '2026-08-10T22:00:00.000Z');
assert.equal(selectOldestDueStage(state, new Date('2026-08-11T01:30:00Z')).stage, 'draft');
```

- [ ] **Step 2: Run schedule tests and verify RED**

Run: `node --test tests/product-automation-schedule.test.mjs`

Expected: FAIL because `src/product-automation-schedule.mjs` is absent.

- [ ] **Step 3: Implement deterministic KST calculations**

Implement calculations with explicit UTC arithmetic for Korea's fixed `+09:00` offset. `selectOldestDueStage` returns one `{ stage, serviceDate, dueAt }` or `null`, sorts overdue stages by `dueAt`, rejects a stage already completed for the same Korea service date, and applies the discovery three-day interval.

- [ ] **Step 4: Verify pure schedule GREEN**

Run: `node --test tests/product-automation-schedule.test.mjs`

Expected: all timezone and due-order tests PASS.

- [ ] **Step 5: Write failing store and schema tests**

Require independent columns for `draft`, `analysis`, and `images`: `*_next_run_at`, `*_last_run_at`, `*_last_service_date`, and `*_last_outcome`. Retain discovery's `next_run_at`, `last_run_at`, and three-day `interval_days`, and add discovery service-date/outcome fields. Assert `completeProductStage` updates only the named stage and clears `is_running` atomically.

- [ ] **Step 6: Run store tests and verify RED**

Run: `node --test tests/batch-schedule-store.test.mjs`

Expected: FAIL because independent stage mapping and columns do not exist.

- [ ] **Step 7: Add the idempotent migration and store mapping**

Add nullable legacy-compatible columns with `alter table ... add column if not exists`; initialize next slots with `07:00`, `08:00`, `09:00`, and `10:00` Korea-time expressions based on the next applicable date. Preserve queue and draft tables. Map all fields in `getBatchScheduleState`, whitelist the four stage identifiers before choosing SQL, and update one stage plus `is_running=false` in one query.

- [ ] **Step 8: Verify schedule/store tests and commit**

Run: `node --test tests/product-automation-schedule.test.mjs tests/batch-schedule-store.test.mjs`

Expected: PASS.

```powershell
git add -- src/product-automation-schedule.mjs tests/product-automation-schedule.test.mjs migrations/2026-08-11-staggered-product-automation-schedule.sql schema.sql src/batch-schedule-store.mjs tests/batch-schedule-store.test.mjs
git commit -m "feat: track fixed product automation slots"
```

### Task 2: Split Draft, Analysis, and Image Processing

**Files:**
- Modify: `src/batch-winner-processor.mjs`
- Modify: `tests/batch-winner-processor.test.mjs`
- Modify: `src/processing-queue-store.mjs`
- Modify: `tests/processing-queue-store.test.mjs`
- Modify: `src/auto-discovery-batch.mjs`
- Modify: `tests/auto-discovery-batch.test.mjs`
- Modify: `schema.sql`
- Modify: `migrations/2026-08-11-staggered-product-automation-schedule.sql`

**Interfaces:**
- Produces: `analyzeWinnerCandidate(db, candidateRow, deps)`, `generateWinnerCandidateImages(db, candidateRow, deps)`, `runDraftPreparationStage(db, deps)`, `runAnalysisStage(db, deps)`, and `runImageGenerationStage(db, deps)`.
- Queue status adds exact value `analysis_completed`; candidate processing statuses remain `analysis_running`, `analysis_completed`, `image_generation_running`, and `awaiting_image_approval`.

- [ ] **Step 1: Write failing processor-stage tests**

Assert analysis calls Python/Codex and safe-field apply but never image functions. Assert image generation requires `candidateRow.draftId`, reuses prior successful analysis, runs main then detail generation, and reaches `awaiting_image_approval`. Assert quota-limited results remain resumable at the current stage.

```js
assert.deepEqual(statuses, ['analysis_running', 'analysis_completed']);
assert.equal(calls.generateMainImage, 0);
assert.deepEqual(imageStatuses, ['image_generation_running', 'awaiting_image_approval']);
```

- [ ] **Step 2: Run processor tests and verify RED**

Run: `node --test tests/batch-winner-processor.test.mjs`

Expected: FAIL because the two focused functions are not exported.

- [ ] **Step 3: Extract focused processor functions**

Move existing analysis logic into `analyzeWinnerCandidate` and image logic into `generateWinnerCandidateImages`. Keep `processWinnerCandidate` as a compatibility wrapper that calls both in order for explicit/manual callers. Preserve existing error codes, safe fields, artifact behavior, and quota detection.

- [ ] **Step 4: Verify processor GREEN**

Run: `node --test tests/batch-winner-processor.test.mjs`

Expected: PASS with separate stage call assertions.

- [ ] **Step 5: Write failing queue selection and stage-runner tests**

Add selectors `getNextQueuedItem`, `getNextAnalysisItem`, and `getNextImageItem`. Analysis selects the oldest eligible registered item in `analyzing`; images select `analysis_completed`; neither selects `ready_for_registration`. Test that each runner locks, processes exactly one item, maps statuses, records no-work completion, and releases the lock on success or failure.

- [ ] **Step 6: Run queue and batch tests and verify RED**

Run: `node --test tests/processing-queue-store.test.mjs tests/auto-discovery-batch.test.mjs`

Expected: FAIL on missing selectors and stage runners.

- [ ] **Step 7: Implement queue state and three stage runners**

Extend the database status check constraint idempotently to include `analysis_completed`. Replace the combined daily runner's scheduled use with three functions while retaining its export only for compatibility. Draft preparation moves one `queued` item to `ready_for_registration`; the existing registration endpoint continues to move a registered item to `analyzing`; analysis moves it to `analysis_completed`; images move it to `awaiting_approval`.

- [ ] **Step 8: Verify focused tests and commit**

Run: `node --test tests/batch-winner-processor.test.mjs tests/processing-queue-store.test.mjs tests/auto-discovery-batch.test.mjs`

Expected: PASS.

```powershell
git add -- src/batch-winner-processor.mjs tests/batch-winner-processor.test.mjs src/processing-queue-store.mjs tests/processing-queue-store.test.mjs src/auto-discovery-batch.mjs tests/auto-discovery-batch.test.mjs schema.sql migrations/2026-08-11-staggered-product-automation-schedule.sql
git commit -m "feat: split product automation processing stages"
```

### Task 3: Dispatch One Due Product Stage per Heartbeat

**Files:**
- Modify: `src/admin-server.mjs`
- Modify: `tests/auto-discovery-batch.test.mjs`
- Modify: `tests/manual-ai-http.test.mjs`
- Modify: `tests/scheduler.test.mjs`

**Interfaces:**
- Produces: `runDueProductAutomationStage(db, deps, { now })`, returning `{ skipped, stage, outcome }` and dispatching no more than one stage.
- Consumes: Task 1 `selectOldestDueStage` and Task 2 stage runners.

- [ ] **Step 1: Write failing heartbeat dispatch tests**

Assert 07:00 dispatches draft, 08:00 analysis, 09:00 images, and due 10:00 discovery; when several are overdue only the oldest runs. Assert no due stage returns `NOT_DUE`, and an empty stage is recorded once rather than retried on the next heartbeat.

- [ ] **Step 2: Run batch/HTTP tests and verify RED**

Run: `node --test tests/auto-discovery-batch.test.mjs tests/manual-ai-http.test.mjs`

Expected: FAIL because due-stage dispatch is missing.

- [ ] **Step 3: Implement single-stage dispatch**

Load schedule state, call `selectOldestDueStage`, invoke exactly one matching runner, and persist that stage's service date, next run, and normalized outcome. Keep the five-minute heartbeat. Give daily processing priority over discovery only through oldest `dueAt` ordering, not hard-coded branching.

Keep `POST /api/auto-batch/processing/run-now` backward compatible by making it run exactly one oldest eligible non-discovery stage regardless of wall-clock due time. It still uses the shared lock and never chains analysis or images after draft preparation.

- [ ] **Step 4: Prove operational polling construction is unchanged**

Extend `tests/scheduler.test.mjs` to retain exact assertions for order, shipment, dispatch, return, supplier-monitor, Telegram notification/polling, and daily-summary interval labels and values. Product schedule dispatch remains in `admin-server.mjs` and is not added to `scheduler.mjs`.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/auto-discovery-batch.test.mjs tests/manual-ai-http.test.mjs tests/scheduler.test.mjs`

Expected: PASS.

```powershell
git add -- src/admin-server.mjs tests/auto-discovery-batch.test.mjs tests/manual-ai-http.test.mjs tests/scheduler.test.mjs
git commit -m "feat: dispatch staggered product automation stages"
```

### Task 4: Admin Visibility, Migration, and Runtime Verification

**Files:**
- Modify: `src/admin-server.mjs`
- Modify: `tests/manual-ai-admin-html.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Produces: `/api/auto-batch/schedule` fields `draftNextRunAt`, `analysisNextRunAt`, `imagesNextRunAt`, `discoveryNextRunAt`, plus each stage's last service date and outcome.

- [ ] **Step 1: Write failing API and admin-rendering tests**

Assert the schedule response exposes all four next-run values and stage outcomes. Assert the admin page labels the fixed Korea schedule as `07:00 드래프트`, `08:00 분석`, `09:00 이미지`, and `3일마다 10:00 후보 발굴`, and no longer presents relative daily-processing interval editing.

- [ ] **Step 2: Run admin tests and verify RED**

Run: `node tests/manual-ai-admin-html.test.mjs && node --test tests/manual-ai-http.test.mjs`

Expected: FAIL because the fixed schedule fields and labels are absent.

- [ ] **Step 3: Implement schedule visibility and documentation**

Return mapped stage state from the schedule endpoint and render next-run times in Korea locale. Remove only obsolete relative product-processing controls. Keep the existing discovery and processing `지금 실행` buttons; processing invokes the backward-compatible one-stage endpoint from Task 3. Document the fixed schedule, late-start one-at-a-time recovery, manual approval boundaries, and unchanged Telegram/order polling.

- [ ] **Step 4: Run focused and full automated verification**

Run: `node --test tests/product-automation-schedule.test.mjs tests/batch-schedule-store.test.mjs tests/batch-winner-processor.test.mjs tests/processing-queue-store.test.mjs tests/auto-discovery-batch.test.mjs tests/scheduler.test.mjs tests/manual-ai-http.test.mjs`

Expected: PASS.

Run: `npm.cmd test`

Expected: complete suite exits 0.

- [ ] **Step 5: Apply schema and verify the current database non-destructively**

Restart the Automoney server so `runSchema` applies the idempotent migration. Query only `batch_schedule_state` counts/timestamps and `processing_queue` status counts. Confirm existing draft and queue row counts are unchanged, each next-run time resolves to its fixed Korea slot, `is_running=false`, and no multiple overdue stages ran during migration.

- [ ] **Step 6: Verify runtime and unchanged polling**

Call `/api/auto-batch/schedule`, confirm the four next-run fields, HTTP 200, one admin server process, scheduler configuration present, and Telegram configuration present without printing secrets. Leave the server running from the desktop launcher.

- [ ] **Step 7: Commit visibility and documentation**

```powershell
git add -- src/admin-server.mjs tests/manual-ai-admin-html.test.mjs README.md
git commit -m "docs: show fixed product automation schedule"
```

- [ ] **Step 8: Preserve unrelated workspace files**

Run: `git status --short`

Expected: only the pre-existing user-owned untracked files remain; none are staged or modified.
