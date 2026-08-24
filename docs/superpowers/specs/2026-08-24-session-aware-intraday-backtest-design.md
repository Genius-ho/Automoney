# Session-Aware Intraday Backtest Design

## Status

Approved direction: use exchange-session-aware analysis for the existing 1-minute candle research. The research remains isolated from live order submission.

## Goal

Make the 1-minute-to-3-minute intraday trigger research statistically and temporally correct enough to guide future investigation: use real US market sessions and phases, never let a forward window cross a phase/session/data gap, distinguish exploratory results from out-of-sample validation, and keep the recurring report running.

## Evidence and current failure modes

The local cache contains candles timestamped in Asia/Seoul time. A trading day is observed from approximately 09:00 KST to the following 09:00 KST, while the current VWAP resets at KST midnight. The current evaluator selects the next N bars rather than bars at a real elapsed-time target, so a 180-minute result can cross a phase boundary, weekend, or multi-hour data gap. The current ranking also accepts as few as five signals and the report timer is a one-shot calendar timer from 2026-08-21.

## Design decisions

### 1. Exchange-local session and phase identity

All timezone-aware candle timestamps are converted to `America/New_York` using `zoneinfo.ZoneInfo`. The session trade date is:

- `timestamp_et.date() + 1 day` when local time is at or after 20:00;
- otherwise `timestamp_et.date()`.

The standard extended-hours phases are:

- `DAY`: 20:00–04:00 ET, including the midnight crossing;
- `PREMARKET`: 04:00–09:30 ET;
- `REGULAR`: 09:30–16:00 ET;
- `AFTER`: 16:00–20:00 ET.

The phase and session date are derived from each candle, so daylight-saving changes do not require hard-coded Korean times. Missing candles remain missing; the analyzer does not invent bars or treat a calendar day as a complete session.

### 2. Safe 3-minute resampling

Resampling remains wall-clock aligned, but a 3-minute bar is emitted only when its bucket contains exactly three consecutive one-minute candles in the same session and phase. Partial buckets at phase boundaries, missing-minute buckets, and buckets that cross a phase boundary are discarded. Each resampled `Bar` carries its session date and phase metadata so later calculations cannot accidentally mix segments.

### 3. Indicator reset boundaries

VWAP, RSI, StochRSI, SMA, Bollinger, volume z-score, and ROC are calculated independently inside each `(session_date, phase)` segment. Warm-up values remain `None` until that segment has enough data. This prevents midnight, overnight, and phase transitions from contaminating the next segment.

### 4. Forward evaluation by real time

For each signal and horizon, the evaluator looks for a resampled bar at exactly `signal_timestamp + horizon`. The target must remain in the same session and phase, and every required 3-minute bar between signal and target must exist. If any condition fails, that outcome is excluded and counted in an explicit `incomplete_outcomes` metric rather than silently using a later bar.

### 5. Research and validation status

The analyzer reports all current data as `EXPLORATORY` until at least 30 distinct trading sessions are present. Once 30 sessions exist, it splits sessions chronologically into the first 70% for candidate discovery and the last 30% for validation. Ranking is performed on validation results, never on the combined data. Validation candidates require at least 10 validation signals; results with 10–29 are marked `LOW_SAMPLE`, and results with 30 or more are marked `SUPPORTED`. Exploratory rankings remain visible but are clearly labeled and never presented as validated.

### 6. Costs and execution realism

Every report includes gross return and a configurable round-trip cost in basis points. The default is 0 bps to avoid asserting an unverified broker fee; the CLI and scheduled job can pass an explicit assumption, and the report prints the assumption. Net return is gross return minus the configured cost. No result is connected to order submission.

### 7. Recurring report schedule

The candle logger remains a six-hour oneshot timer. The indicator sweep becomes a recurring weekly timer scheduled for Saturday 09:20 KST, after the Friday/US-session cache has had time to update. The service still runs one sweep per symbol and sends the existing compact Telegram summary. A missed run is handled by `Persistent=true`.

## Compatibility

- Existing JSONL candle files remain readable; session and phase metadata are derived from timestamps and do not need a data migration.
- Existing pure indicator functions keep their public signatures where practical. New metadata-aware helpers are added at the resampling and report boundaries.
- The live trading engine, `mumae.service`, order plans, and broker submission code are not modified.
- Existing CLI commands continue to work; new cost and report-status fields are additive.

## Testing requirements

Tests must cover:

1. DST-safe session date and phase classification around 20:00, midnight, 04:00, 09:30, 16:00, and 20:00 ET.
2. Dropping partial and non-consecutive 3-minute buckets and retaining complete buckets.
3. VWAP/indicator state reset at phase boundaries.
4. Excluding forward windows that cross a phase/session boundary or contain a data gap.
5. Chronological 70/30 session split, exploratory status below 30 sessions, and sample-status thresholds.
6. Gross versus net return with an explicit cost assumption.
7. Weekly timer template and service command remain relocatable and run all three symbols.
8. Existing candle logger, indicator, and backtest tests remain green.

## Non-goals

- Automatically changing Mumae buy/sell plans based on research output.
- Claiming a profitable strategy from the current 11–15 sessions.
- Reconstructing missing historical candles or exchange holidays from guesses.
- Adding broker order execution to the backtest.
