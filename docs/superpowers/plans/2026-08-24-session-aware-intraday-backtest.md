# Session-Aware Intraday Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Correct the 1-minute-to-3-minute trigger research for US exchange sessions, real elapsed-time outcomes, out-of-sample status, execution costs, and recurring weekly reporting without changing live order execution.

**Architecture:** Add a small session-classification module that converts aware candle timestamps to America/New_York and assigns a trade date and phase. Make resampling emit only complete, contiguous 3-minute bars carrying that metadata. Keep the existing indicator functions reusable, but make the sweep pipeline calculate every indicator and signal independently per session/phase, evaluate exact elapsed-time targets, and expose exploratory/validation results additively.

**Tech Stack:** Python 3.13, datetime/zoneinfo, unittest, existing JSONL candle cache, systemd timer templates, Telegram notifier.

**Spec:** docs/superpowers/specs/2026-08-24-session-aware-intraday-backtest-design.md

## Global Constraints

- Use America/New_York exchange-local time; do not hard-code Korean session times.
- Use only complete consecutive 1-minute groups for 3-minute bars.
- Never evaluate a forward outcome across a session, phase, or missing-data gap.
- Keep mumae.service, live order plans, and broker submission code unchanged.
- Keep existing CLI commands compatible; new report fields and cost options are additive.
- Do not claim validation before 30 distinct sessions; below that threshold report EXPLORATORY.

---

### Task 1: Add exchange-session classification

**Files:**
- Create: intraday_sessions.py
- Create: tests/test_intraday_sessions.py

**Interfaces:**
- Produce CandleContext with session_date, phase, and a stable segment key.
- Produce classify_timestamp(timestamp: datetime) -> CandleContext.
- Produce session_phase_key(timestamp: datetime) -> tuple[date, str].

- [ ] Step 1: Write failing boundary tests.

Use aware timestamps in America/New_York and assert that 20:00 rolls the session date forward and is DAY; 04:00 is PREMARKET; 09:30 is REGULAR; 16:00 is AFTER; 20:00 is DAY; 23:59 and 00:01 share the same session date and DAY phase; and a November DST timestamp is classified without a Korean-time assumption.

- [ ] Step 2: Run the focused tests and verify the expected failure.

    .venv/bin/python -m unittest tests.test_intraday_sessions

Expected: import or attribute failures because the classifier does not yet exist.

- [ ] Step 3: Implement the minimal classifier.

Use zoneinfo.ZoneInfo("America/New_York"), convert timestamps with astimezone, classify half-open intervals [start, end), and assign the next local date to timestamps at or after 20:00 ET. Reject naive timestamps with ValueError so the pipeline cannot silently apply a wrong timezone.

- [ ] Step 4: Run the focused tests and verify they pass.

    .venv/bin/python -m unittest tests.test_intraday_sessions

Expected: all classifier tests pass, including the DST boundary case.

- [ ] Step 5: Commit.

    git add intraday_sessions.py tests/test_intraday_sessions.py
    git commit -m "feat: classify intraday candles by US session"

### Task 2: Make resampling and indicators session/phase safe

**Files:**
- Modify: backtest_vwap_rsi.py
- Modify: backtest_indicator_sweep.py
- Modify: candle_logger.py
- Modify: tests/test_backtest_vwap_rsi.py
- Modify: tests/test_backtest_indicator_sweep.py
- Create: tests/test_session_aware_resampling.py

**Interfaces:**
- Bar gains optional session_date and phase metadata with defaults so existing fixtures remain constructible.
- resample(bars, minutes=3) returns only complete, contiguous buckets and annotates each result.
- Existing public indicator functions remain callable; the sweep pipeline gets segment-aware wrappers that reset state at (session_date, phase) boundaries.

- [ ] Step 1: Write failing resampling and reset tests.

Cover a complete 09:30, 09:31, 09:32 bucket, a missing-minute bucket, a phase-boundary bucket, and a partial bucket. Assert only the complete bucket remains and metadata is present. Add a VWAP test where the second phase begins at a different price and must start its cumulative VWAP at that price. Add an RSI/rolling-indicator test proving the second segment has its own warm-up values.

- [ ] Step 2: Run the focused tests and verify failure.

    .venv/bin/python -m unittest tests.test_session_aware_resampling

Expected: current resampling retains partial or missing buckets and current calculations do not expose the required segment boundaries.

- [ ] Step 3: Implement metadata-aware bars and complete-bucket resampling.

Derive CandleContext for each raw candle, floor timestamps to the 3-minute wall-clock bucket, group by bucket timestamp plus session date plus phase, and emit a bucket only if its timestamps equal the three expected consecutive minutes. Preserve JSONL compatibility by continuing to load and save the original OHLCV fields; derive metadata after loading.

- [ ] Step 4: Implement segment-local indicator calculation.

Add an internal helper that iterates contiguous (session_date, phase) ranges and applies the existing RSI, StochRSI, SMA, Bollinger, volume z-score, and ROC functions to each range. Make compute_vwap reset on the same segment key. Keep the helper deterministic and return lists aligned one-to-one with the input bars.

- [ ] Step 5: Run focused and existing indicator tests.

    .venv/bin/python -m unittest tests.test_session_aware_resampling tests.test_backtest_vwap_rsi tests.test_backtest_indicator_sweep

Expected: all new boundary tests and existing pure-function tests pass.

- [ ] Step 6: Commit.

    git add backtest_vwap_rsi.py backtest_indicator_sweep.py candle_logger.py tests/test_backtest_vwap_rsi.py tests/test_backtest_indicator_sweep.py tests/test_session_aware_resampling.py
    git commit -m "fix: keep intraday indicators inside market phases"

### Task 3: Evaluate exact elapsed-time outcomes and research status

**Files:**
- Modify: backtest_vwap_rsi.py
- Modify: backtest_indicator_sweep.py
- Modify: tests/test_backtest_vwap_rsi.py
- Modify: tests/test_backtest_indicator_sweep.py
- Create: tests/test_intraday_evaluation.py

**Interfaces:**
- evaluate_signals and evaluate accept real horizon minutes and return incomplete_outcomes alongside side statistics.
- sweep_report accepts round_trip_cost_bps=0.0, minimum_sessions=30, and minimum_validation_signals=10 as additive keyword arguments.
- The report includes research_status, session_count, discovery rankings, validation rankings, and sample-status labels without removing existing grid, buy_top, or sell_top fields.

- [ ] Step 1: Write failing outcome and split tests.

Add tests proving a signal at 15:00 with a 180-minute horizon is excluded when the phase ends at 16:00, a signal with a missing intermediate 3-minute bar is excluded, and a signal at 15:00 is not evaluated against a bar after the next phase. Add tests for EXPLORATORY below 30 sessions, chronological 70/30 session splitting at 30 sessions, LOW_SAMPLE for 10–29 validation signals, and SUPPORTED at 30 or more.

- [ ] Step 2: Run the focused tests and verify failure.

    .venv/bin/python -m unittest tests.test_intraday_evaluation

Expected: current evaluation incorrectly returns outcomes from the next N list entries and the report has no research or sample status.

- [ ] Step 3: Implement exact target lookup and gap checks.

Index bars by (session_date, phase, timestamp). For each horizon, require the exact target timestamp and every expected 3-minute timestamp between signal and target. Return an explicit incomplete count; never substitute the last available bar.

- [ ] Step 4: Implement gross/net returns and chronological research status.

Compute signed gross directional return using the current convention. For BUY, net return is gross minus cost_pct. For SELL, net return is gross plus cost_pct because SELL gross values are represented as favorable downward price movement with a negative sign. Use train sessions for candidate discovery and evaluate those candidates on later validation sessions. Keep exploratory full-history rankings clearly labeled until 30 sessions exist.

- [ ] Step 5: Update report rendering and Telegram summary.

Print research status, session count, cost assumption, incomplete outcome count, and validation/sample labels. Keep the existing Korean summary readable and do not send any order command from the report path.

- [ ] Step 6: Run focused analytical tests.

    .venv/bin/python -m unittest tests.test_intraday_evaluation tests.test_backtest_vwap_rsi tests.test_backtest_indicator_sweep tests.test_candle_logger

Expected: all analytical tests pass and legacy CLI/report fields remain available.

- [ ] Step 7: Commit.

    git add backtest_vwap_rsi.py backtest_indicator_sweep.py tests/test_backtest_vwap_rsi.py tests/test_backtest_indicator_sweep.py tests/test_candle_logger.py tests/test_intraday_evaluation.py
    git commit -m "feat: validate intraday trigger outcomes by session"

### Task 4: Make CLI costs and the scheduled report recurring

**Files:**
- Modify: backtest_indicator_sweep.py
- Modify: deploy/mumae-backtest-notify.timer
- Modify: deploy/systemd/mumae-backtest-notify.service.in
- Modify: tests/test_systemd_installer.py
- Modify: tests/test_backtest_indicator_sweep.py

**Interfaces:**
- CLI adds --round-trip-cost-bps FLOAT and passes it to run_sweep.
- The timer runs every Saturday at 09:20 KST using OnCalendar=Sat *-*-* 09:20:00 with Persistent=true.
- The service template continues to run KORU, SOXL, and TQQQ with the relocatable project-root token.

- [ ] Step 1: Write failing CLI and timer tests.

Assert the parser accepts the cost option and the rendered report includes the cost assumption. Assert the timer template contains the weekly calendar expression and the service template retains all three symbols and the project-root placeholder.

- [ ] Step 2: Run focused tests and verify failure.

    .venv/bin/python -m unittest tests.test_backtest_indicator_sweep tests.test_systemd_installer

Expected: parser/report and timer assertions fail against the current one-shot timer and missing cost argument.

- [ ] Step 3: Implement CLI and timer changes.

Pass the parsed cost through run_sweep, update the service description to state weekly execution, and replace the fixed-date timer with the recurring Saturday expression. Do not alter the candle logger timer.

- [ ] Step 4: Run focused tests and installer rendering tests.

    .venv/bin/python -m unittest tests.test_backtest_indicator_sweep tests.test_systemd_installer

Expected: all pass with no path hard-coding introduced.

- [ ] Step 5: Commit.

    git add backtest_indicator_sweep.py deploy/mumae-backtest-notify.timer deploy/systemd/mumae-backtest-notify.service.in tests/test_backtest_indicator_sweep.py tests/test_systemd_installer.py
    git commit -m "fix: schedule weekly intraday research reports"

### Task 5: Full verification and safe deployment

**Files:**
- Verify: all changed files and generated systemd templates
- Test: tests/ full suite

- [ ] Step 1: Run formatting and diff checks.

    git diff --check
    git status --short

Expected: no whitespace errors and only the session-aware research files, tests, spec, and plan are changed.

- [ ] Step 2: Run the full test suite with local sockets allowed.

    env -u MUMAE_MODE -u MUMAE_WEB_LIVE_ACTIONS .venv/bin/python -m unittest discover -s tests -p 'test_*.py'

Expected: all tests pass; skipped tests are reported explicitly.

- [ ] Step 3: Run the cache-only report without Telegram notification.

    env -u MUMAE_MODE -u MUMAE_WEB_LIVE_ACTIONS .venv/bin/python backtest_indicator_sweep.py TQQQ --source cache --round-trip-cost-bps 10

Expected: report shows session/phase-aware status and no broker order submission or Telegram send.

- [ ] Step 4: Render and inspect systemd units.

Use the existing installer test/render path to confirm the timer and service point at the current project root and retain ReadWritePaths for the cache. Do not restart mumae.service because the live trading engine is outside this change.

- [ ] Step 5: Request independent code review.

Review the complete diff for session-boundary leakage, partial-bar inclusion, outcome look-ahead, validation ranking leakage, and accidental live-order coupling. Fix Critical or Important issues before completion.

- [ ] Step 6: Report the result.

Include final test count, current cache session counts, exploratory or validation status, changed commits, and the fact that live order execution was not modified.

