# Live Order Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair every live-order safety issue found in the 2026-08-04 audit and restart the service only after verification.

**Architecture:** Keep the existing single-process engine and broker adapter. Add explicit session-date propagation and conservative order-state transitions at the broker boundary, then harden the HTTP and Telegram command boundaries.

**Tech Stack:** Python standard library, `unittest`, systemd, Toss OpenAPI, Telegram Bot API.

## Global Constraints

- Never submit, cancel, or modify a real broker order during tests or repair.
- Preserve all existing user changes in the dirty worktree.
- Do not restart the service before the full verification gate passes.

---

### Task 1: Trading-session identity

**Files:** `web_gui/web_service.py`, `web_gui/trading_service.py`, `mumae_core.py`, `tests/test_web_trading.py`

- [ ] Add a failing cross-midnight test proving one US session keeps one order date.
- [ ] Pass the calendar session date explicitly to plan generation.
- [ ] Run the focused test and confirm it passes.

### Task 2: Broker reconciliation and retry safety

**Files:** `web_gui/trading_service.py`, `toss_api.py`, `tests/test_web_trading.py`

- [ ] Add failing tests for delayed broker visibility and historical false matches.
- [ ] Keep returned broker IDs quarantined as unconfirmed and disallow fresh-ID retry.
- [ ] Restrict fallback matching to the active trading date and add order-detail rejection context.
- [ ] Run focused tests and confirm they pass.

### Task 3: Command and scheduler guards

**Files:** `web_gui/dashboard/server.py`, `web_gui/trading_service.py`, `tests/test_web_dashboard.py`, `tests/test_web_trading.py`

- [ ] Add failing tests for retry-command live gates and transient scheduler failure.
- [ ] Apply the live gate to both retry commands.
- [ ] Make phase-attempt state retry-safe without allowing rapid duplicate submissions.
- [ ] Run focused tests and confirm they pass.

### Task 4: Telegram safety and resilience

**Files:** `telegram_bot.py`, `tests/test_telegram.py`

- [ ] Add failing tests for unrelated/stale price messages and unexpected update errors.
- [ ] Bind price input to a prompt reply with an expiry.
- [ ] Isolate update failures so polling continues and offsets remain safe.
- [ ] Run focused tests and confirm they pass.

### Task 5: Runtime hygiene and final verification

**Files:** `runtime_store.py`, `tests/test_runtime_store.py`

- [ ] Add a failing test for bounded historical tracking state.
- [ ] Prune only old resolved records and preserve unresolved/custom records.
- [ ] Run all 242+ tests in forced DRY_RUN, compile checks, and diff checks.
- [ ] Restart the service with systemd and confirm process, threads, HTTP, and logs.
- [ ] Create a local commit; do not push to GitHub.

