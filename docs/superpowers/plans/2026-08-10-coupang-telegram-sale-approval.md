# Coupang Telegram Sale Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the configured Telegram chat about Coupang temporary-save listings and let a human request sale approval exactly once or defer safely.

**Architecture:** Extend the Coupang registration store with notification metadata, add a focused sale-approval Telegram handler, and replace competing Telegram pollers with one shared update router. The existing `requestCoupangSaleApproval` function remains the only external approval mutation gate.

**Tech Stack:** Node.js ESM, PostgreSQL, Telegram Bot HTTP API, Coupang Seller API, `node:test`.

## Global Constraints

- Never request Coupang approval while sending a notification.
- Approval callbacks must re-read database and live Coupang state through `requestCoupangSaleApproval`.
- Repeated callbacks must never cause a second approval API call.
- Telegram-controlled and product-controlled text must be HTML escaped.
- Purchase-order Telegram callbacks must continue to work through the same shared `getUpdates` offset.
- Draft 119 may receive a live notification after automated verification, but the agent must not press its approval button.

---

### Task 1: Persist Coupang Telegram notification state

**Files:**
- Create: `migrations/2026-08-10-coupang-telegram-approval.sql`
- Modify: `schema.sql`
- Modify: `src/coupang-registration-store.mjs`
- Test: `tests/coupang-registration-store.test.mjs`

**Interfaces:**
- Produces: `listCoupangRegistrationsAwaitingTelegramNotification(db)` returning pending registration summaries.
- Produces: `markCoupangRegistrationTelegramNotified(db, draftId, messageId)` returning the updated registration.
- Extends registration mapping with `telegramNotifiedAt` and `telegramMessageId`.

- [ ] **Step 1: Write failing store tests**

```js
test('listCoupangRegistrationsAwaitingTelegramNotification selects only created unrequested unnotified linked rows', async () => {
  const rows = await listCoupangRegistrationsAwaitingTelegramNotification(fakeDb);
  assert.equal(rows[0].productDraftId, 119);
  assert.match(captured.sql, /requested = false/);
  assert.match(captured.sql, /telegram_notified_at is null/);
});

test('markCoupangRegistrationTelegramNotified stores timestamp and message id', async () => {
  const row = await markCoupangRegistrationTelegramNotified(fakeDb, 119, 987);
  assert.equal(row.telegramMessageId, 987);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test tests/coupang-registration-store.test.mjs`

Expected: FAIL because both exports are missing.

- [ ] **Step 3: Add schema and store implementation**

```sql
alter table coupang_product_registrations
  add column if not exists telegram_notified_at timestamptz;
alter table coupang_product_registrations
  add column if not exists telegram_message_id bigint;
```

Use a pending query constrained by `seller_product_id is not null`, `requested = false`, `status = 'created'`, and `telegram_notified_at is null`. Join `product_drafts` and `product_options`; aggregate option value and `stock_quantity` for message display. Mark delivery only after Telegram returns a message ID.

- [ ] **Step 4: Run store tests and verify GREEN**

Run: `node --test tests/coupang-registration-store.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- schema.sql migrations/2026-08-10-coupang-telegram-approval.sql src/coupang-registration-store.mjs tests/coupang-registration-store.test.mjs
git commit -m "feat: track coupang telegram approval notices"
```

### Task 2: Build the Coupang Telegram approval handler

**Files:**
- Create: `src/coupang-telegram-approval.mjs`
- Create: `tests/coupang-telegram-approval.test.mjs`

**Interfaces:**
- Consumes: Task 1 store functions and `requestCoupangSaleApproval(db, draftId, deps)`.
- Produces: `notifyPendingCoupangSaleApprovals(db, telegramConfig, deps)`.
- Produces: `handleCoupangApprovalCallback(db, telegramConfig, query, deps)` returning `{ handled, action, draftId }`.

- [ ] **Step 1: Write failing notification tests**

```js
test('notification sends escaped listing summary and persists Telegram message id', async () => {
  const result = await notifyPendingCoupangSaleApprovals(db, config, deps);
  assert.equal(result.notified, 1);
  assert.equal(sent.options.replyMarkup.inline_keyboard[0][0].callback_data, 'approve_cp:119');
  assert.deepEqual(marked, { draftId: 119, messageId: 987 });
});

test('unconfigured Telegram is a no-op', async () => {
  assert.deepEqual(await notifyPendingCoupangSaleApprovals(db, null, deps), { notified: 0 });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test tests/coupang-telegram-approval.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement formatting and delivery**

Build Korean message copy using normal UTF-8 source literals, escape every interpolated value with `escapeHtml`, and construct callbacks `approve_cp:<draftId>` and `defer_cp:<draftId>`. Persist notification metadata only after `sendTelegramMessage` succeeds and returns `result.message_id`.

- [ ] **Step 4: Add failing callback tests**

```js
test('approve callback delegates once to the guarded Coupang approval flow', async () => {
  const result = await handleCoupangApprovalCallback(db, config, approveQuery, deps);
  assert.equal(result.handled, true);
  assert.equal(calls.requestApproval, 1);
});

test('defer callback performs no Coupang mutation', async () => {
  await handleCoupangApprovalCallback(db, config, deferQuery, deps);
  assert.equal(calls.requestApproval, 0);
});
```

Also cover an already-requested error, stale/non-temporary live state, failed callback answer, failed edit with fallback send, malformed IDs, and unrelated callback prefixes.

- [ ] **Step 5: Implement callback handling**

Parse only `approve_cp` and `defer_cp`. For approval, call `requestCoupangSaleApproval`; convert known refusal errors to visible status text without retry. Independently attempt `answerCallbackQuery`, then `editTelegramMessageText`, then fallback `sendTelegramMessage` exactly as the purchase-order bot does.

- [ ] **Step 6: Run handler tests and verify GREEN**

Run: `node --test tests/coupang-telegram-approval.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- src/coupang-telegram-approval.mjs tests/coupang-telegram-approval.test.mjs
git commit -m "feat: add coupang telegram approval handler"
```

### Task 3: Route all Telegram callbacks through one offset

**Files:**
- Create: `src/telegram-callback-router.mjs`
- Create: `tests/telegram-callback-router.test.mjs`
- Modify: `src/telegram-approval-bot.mjs`
- Modify: `tests/telegram-approval-bot.test.mjs`

**Interfaces:**
- Produces: `handlePurchaseOrderApprovalCallback(db, domemeClient, telegramConfig, query, deps)` extracted from the existing bot.
- Produces: `createTelegramCallbackRouter()` with `pollOnce(db, deps, telegramConfig, impls)`.
- Consumes: `handleCoupangApprovalCallback` from Task 2.

- [ ] **Step 1: Extract the purchase-order single-query handler under existing tests**

Move action parsing and dispatch from the loop into `handlePurchaseOrderApprovalCallback`. Keep all current result-notification behavior unchanged.

- [ ] **Step 2: Run purchase-order bot tests**

Run: `node --test tests/telegram-approval-bot.test.mjs`

Expected: PASS with no behavioral changes.

- [ ] **Step 3: Write failing router tests**

```js
test('one shared offset routes purchase-order and Coupang callbacks exactly once', async () => {
  const router = createTelegramCallbackRouter();
  const first = await router.pollOnce(db, deps, config, impls);
  const second = await router.pollOnce(db, deps, config, impls);
  assert.deepEqual(first, { processed: 2 });
  assert.deepEqual(second, { processed: 0 });
  assert.deepEqual(seenOffsets, [undefined, 23]);
});
```

- [ ] **Step 4: Implement the shared router**

Own one closure-scoped offset. Fetch updates once, advance past every `update_id`, then offer each callback query to the purchase-order handler and Coupang handler. Count an update only when a handler returns `handled: true`.

- [ ] **Step 5: Run router and bot tests**

Run: `node --test tests/telegram-callback-router.test.mjs tests/telegram-approval-bot.test.mjs tests/coupang-telegram-approval.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- src/telegram-callback-router.mjs src/telegram-approval-bot.mjs tests/telegram-callback-router.test.mjs tests/telegram-approval-bot.test.mjs
git commit -m "refactor: share telegram callback routing"
```

### Task 4: Schedule notifications and verify live delivery

**Files:**
- Modify: `src/scheduler.mjs`
- Modify: `tests/scheduler.test.mjs`

**Interfaces:**
- Consumes: `notifyPendingCoupangSaleApprovals` and `createTelegramCallbackRouter`.
- Produces: scheduler jobs `coupangSaleApprovalTelegramNotify` and the existing single `telegramApprovalPoll` backed by the shared router.

- [ ] **Step 1: Write failing scheduler tests**

Assert the new notification job uses `ORDER_TICK_INTERVAL_MS`, only one Telegram poll job exists, and its poller receives both Coupang and Domeme dependencies.

- [ ] **Step 2: Run scheduler tests and verify RED**

Run: `node --test tests/scheduler.test.mjs`

Expected: FAIL because the notification job and shared router are absent.

- [ ] **Step 3: Wire scheduler dependencies**

Schedule `notifyPendingCoupangSaleApprovals(db, telegramConfig)` and replace the old purchase-order-only poller with `createTelegramCallbackRouter().pollOnce(...)`. Preserve all existing interval labels except for the new notification label.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/coupang-registration-store.test.mjs tests/coupang-telegram-approval.test.mjs tests/telegram-callback-router.test.mjs tests/telegram-approval-bot.test.mjs tests/scheduler.test.mjs`

Run: `npm.cmd test`

Expected: all tests pass with exit code 0.

- [ ] **Step 5: Apply the migration and send draft 119 notification**

Apply `migrations/2026-08-10-coupang-telegram-approval.sql` using the configured PostgreSQL connection. Invoke `notifyPendingCoupangSaleApprovals` once, then query draft 119 and verify both `telegram_notified_at` and `telegram_message_id` are non-null. Confirm live Coupang status remains temporary-save and `requested` remains false.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- src/scheduler.mjs tests/scheduler.test.mjs
git commit -m "feat: schedule coupang telegram approvals"
```

- [ ] **Step 7: Final verification**

Run: `git diff --check`

Run: `git status --short`

Verify the only expected untracked path is the preserved runtime image directory `public/generated-ai-images/drafts/119/`. Record the Telegram message ID, seller product ID `16341358344`, and the passing test counts in the handoff.
