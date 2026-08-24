"""Backtest 3-minute drop-entry and recovery-target behavior over the
intraday bars we can actually fetch.

The data pipeline remains compatible with the previous indicator research,
but the primary report now asks the strategy question directly: after a
three-percent drawdown from a prior rolling high, how often does an entry
reach +2%, +3%, or +4% before the configured timeout?
"""
from __future__ import annotations

import os
import statistics
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from math import ceil

import candle_logger
from backtest_vwap_rsi import (
    RESAMPLE_MINUTES,
    Bar,
    TossBroker,
    apply_segmented,
    compute_segmented_rsi,
    compute_segmented_stoch_rsi,
    compute_rsi,
    compute_stoch_rsi,
    compute_vwap,
    fetch_minute_candles,
    resample,
    segment_ranges,
)
from telegram_bot import TelegramNotifier

FORWARD_BARS = 5  # 5 * 3m = 15 minutes
# A single-horizon check undersells slow reversions: a manually-spotted BUY
# point on 2026-08-07 was underwater at 30-60min but +2.5% by 90min. Sweep
# several horizons per signal instead of judging on one fixed window.
HORIZON_MINUTES = (15, 30, 60, 90, 120, 180)
MIN_SIGNAL_COUNT = 5
DROP_THRESHOLD_PCT = 3.0
RECOVERY_LOOKBACK_MINUTES = (15, 30, 60)
RECOVERY_TARGET_PCTS = (2.0, 3.0, 4.0)
RECOVERY_HORIZON_MINUTES = (60, 180, 360)


def compute_sma(closes: list[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(closes)
    for index in range(len(closes)):
        if index - period + 1 < 0:
            continue
        result[index] = sum(closes[index - period + 1: index + 1]) / period
    return result


def _compute_sma_gap_pct_single(bars: list[Bar], period: int) -> list[float | None]:
    """% deviation of close from a plain N-period SMA (VWAP's un-volume-weighted cousin)."""
    closes = [bar.close for bar in bars]
    sma = compute_sma(closes, period)
    return [None if value is None else (close - value) / value * 100 for close, value in zip(closes, sma)]


def compute_sma_gap_pct(bars: list[Bar], period: int = 20) -> list[float | None]:
    return apply_segmented(bars, lambda segment: _compute_sma_gap_pct_single(segment, period))


def _compute_bollinger_percent_b_single(
    bars: list[Bar], period: int, num_std: float
) -> list[float | None]:
    """%B on a 0-100 scale: <0 is below the lower band, >100 is above the upper band."""
    closes = [bar.close for bar in bars]
    result: list[float | None] = [None] * len(closes)
    for index in range(len(closes)):
        if index - period + 1 < 0:
            continue
        window = closes[index - period + 1: index + 1]
        mean = sum(window) / period
        std = statistics.pstdev(window)
        if std == 0:
            result[index] = 50.0
            continue
        upper, lower = mean + num_std * std, mean - num_std * std
        result[index] = (closes[index] - lower) / (upper - lower) * 100.0
    return result


def compute_bollinger_percent_b(
    bars: list[Bar], period: int = 20, num_std: float = 2.0
) -> list[float | None]:
    return apply_segmented(
        bars,
        lambda segment: _compute_bollinger_percent_b_single(segment, period, num_std),
    )


def _compute_volume_zscore_single(bars: list[Bar], period: int) -> list[float | None]:
    volumes = [bar.volume for bar in bars]
    result: list[float | None] = [None] * len(volumes)
    for index in range(len(volumes)):
        if index - period + 1 < 0:
            continue
        window = volumes[index - period + 1: index + 1]
        mean = sum(window) / period
        std = statistics.pstdev(window)
        result[index] = 0.0 if std == 0 else (volumes[index] - mean) / std
    return result


def compute_volume_zscore(bars: list[Bar], period: int = 20) -> list[float | None]:
    return apply_segmented(bars, lambda segment: _compute_volume_zscore_single(segment, period))


def _compute_roc_pct_single(bars: list[Bar], period: int) -> list[float | None]:
    """% change vs. the close `period` bars ago -- a raw momentum-burst measure."""
    closes = [bar.close for bar in bars]
    result: list[float | None] = [None] * len(closes)
    for index in range(len(closes)):
        if index - period < 0 or not closes[index - period]:
            continue
        result[index] = (closes[index] - closes[index - period]) / closes[index - period] * 100
    return result


def compute_roc_pct(bars: list[Bar], period: int = 3) -> list[float | None]:
    return apply_segmented(bars, lambda segment: _compute_roc_pct_single(segment, period))


def below(series: list[float | None], threshold: float) -> list[bool]:
    return [value is not None and value <= threshold for value in series]


def above(series: list[float | None], threshold: float) -> list[bool]:
    return [value is not None and value >= threshold for value in series]


def both(mask_a: list[bool], mask_b: list[bool]) -> list[bool]:
    return [a and b for a, b in zip(mask_a, mask_b)]


@dataclass
class SweepSignal:
    index: int
    timestamp: datetime
    side: str
    price: float


@dataclass
class DropSignal:
    index: int
    timestamp: datetime
    side: str
    price: float
    drop_pct: float
    reference_price: float


def detect_drop_entries(
    bars: list[Bar],
    *,
    lookback_minutes: int = 15,
    drop_threshold_pct: float = DROP_THRESHOLD_PCT,
) -> list[DropSignal]:
    """Find -3% drawdowns from a prior rolling high and enter next bar."""
    if lookback_minutes <= 0 or lookback_minutes % RESAMPLE_MINUTES:
        raise ValueError("lookback minutes must be a positive multiple of the resample interval")
    if drop_threshold_pct <= 0:
        raise ValueError("drop threshold must be positive")
    lookback_bars = lookback_minutes // RESAMPLE_MINUTES
    signals: list[DropSignal] = []
    for start, end in segment_ranges(bars):
        armed = False
        for index in range(start + lookback_bars, end):
            reference_price = max(bar.close for bar in bars[index - lookback_bars:index])
            drop_pct = (bars[index].close - reference_price) / reference_price * 100
            condition = drop_pct <= -drop_threshold_pct
            if condition and not armed and index + 1 < end:
                entry = bars[index + 1]
                signals.append(
                    DropSignal(
                        index=index + 1,
                        timestamp=entry.timestamp,
                        side="BUY",
                        price=entry.open,
                        drop_pct=drop_pct,
                        reference_price=reference_price,
                    )
                )
            armed = condition
    return signals


def evaluate_recovery_target(
    bars: list[Bar],
    signals: list[DropSignal],
    *,
    target_pct: float,
    horizon_minutes: int,
    round_trip_cost_bps: float = 0.0,
) -> dict:
    """Measure whether a drop entry reaches a recovery target before timeout."""
    if target_pct <= 0:
        raise ValueError("recovery target must be positive")
    if horizon_minutes <= 0 or horizon_minutes % RESAMPLE_MINUTES:
        raise ValueError("horizon minutes must be a positive multiple of the resample interval")
    if round_trip_cost_bps < 0:
        raise ValueError("round-trip cost cannot be negative")
    cost_pct = round_trip_cost_bps / 100.0
    ranges = segment_ranges(bars)
    outcomes: list[dict] = []
    incomplete_outcomes = 0
    for signal in signals:
        if not 0 <= signal.index < len(bars):
            incomplete_outcomes += 1
            continue
        segment_end = next(
            (end for start, end in ranges if start <= signal.index < end),
            signal.index + 1,
        )
        deadline = signal.timestamp + timedelta(minutes=horizon_minutes)
        target_price = signal.price * (1 + target_pct / 100)
        maximum_adverse_pct = 0.0
        hit_minutes: int | None = None
        deadline_bar: Bar | None = None
        for index in range(signal.index, segment_end):
            bar = bars[index]
            if bar.timestamp > deadline:
                break
            maximum_adverse_pct = min(
                maximum_adverse_pct,
                (bar.low - signal.price) / signal.price * 100,
            )
            if bar.high >= target_price:
                hit_minutes = int((bar.timestamp - signal.timestamp).total_seconds() // 60)
                break
            if bar.timestamp == deadline:
                deadline_bar = bar
                break
        if hit_minutes is not None:
            gross_return_pct = target_pct
            outcomes.append({
                "target_hit": True,
                "hit_minutes": hit_minutes,
                "gross_return_pct": gross_return_pct,
                "net_return_pct": gross_return_pct - cost_pct,
                "max_adverse_pct": maximum_adverse_pct,
            })
            continue
        if deadline_bar is None:
            incomplete_outcomes += 1
            continue
        gross_return_pct = (deadline_bar.close - signal.price) / signal.price * 100
        outcomes.append({
            "target_hit": False,
            "hit_minutes": None,
            "gross_return_pct": gross_return_pct,
            "net_return_pct": gross_return_pct - cost_pct,
            "max_adverse_pct": maximum_adverse_pct,
        })
    hits = [item for item in outcomes if item["target_hit"]]
    return {
        "signal_count": len(signals),
        "complete_count": len(outcomes),
        "target_hit_count": len(hits),
        "target_hit_rate_pct": round(len(hits) / len(outcomes) * 100, 1) if outcomes else None,
        "median_hit_minutes": round(statistics.median(item["hit_minutes"] for item in hits), 1) if hits else None,
        "avg_gross_return_pct": round(statistics.mean(item["gross_return_pct"] for item in outcomes), 3) if outcomes else None,
        "avg_net_return_pct": round(statistics.mean(item["net_return_pct"] for item in outcomes), 3) if outcomes else None,
        "avg_max_adverse_pct": round(statistics.mean(item["max_adverse_pct"] for item in outcomes), 3) if outcomes else None,
        "incomplete_outcomes": incomplete_outcomes,
        "outcomes": outcomes,
    }


def edge_trigger(bars: list[Bar], buy_mask: list[bool], sell_mask: list[bool]) -> list[SweepSignal]:
    """Fires once per excursion (rising edge), matching detect_signals() in
    backtest_vwap_rsi.py, so one dip/spike isn't counted on every bar it holds."""
    signals: list[SweepSignal] = []
    for start, end in segment_ranges(bars):
        armed_buy = armed_sell = False
        for index in range(start, end):
            bar = bars[index]
            if buy_mask[index] and not armed_buy:
                signals.append(SweepSignal(index, bar.timestamp, "BUY", bar.close))
            if sell_mask[index] and not armed_sell:
                signals.append(SweepSignal(index, bar.timestamp, "SELL", bar.close))
            armed_buy, armed_sell = buy_mask[index], sell_mask[index]
    return signals


def sample_status(signal_count: int) -> str:
    if signal_count < 10:
        return "INSUFFICIENT"
    if signal_count < 30:
        return "LOW_SAMPLE"
    return "SUPPORTED"


def evaluate(
    bars: list[Bar],
    signals: list[SweepSignal],
    *,
    forward_bars: int | None = FORWARD_BARS,
    horizon_minutes: int | None = None,
    round_trip_cost_bps: float = 0.0,
) -> dict:
    """Evaluate only complete, same-phase windows at a real time horizon."""
    if round_trip_cost_bps < 0:
        raise ValueError("round-trip cost cannot be negative")
    if horizon_minutes is None:
        horizon_minutes = (forward_bars or FORWARD_BARS) * RESAMPLE_MINUTES
    if horizon_minutes <= 0 or horizon_minutes % RESAMPLE_MINUTES:
        raise ValueError("horizon minutes must be a positive multiple of the resample interval")
    cost_pct = round_trip_cost_bps / 100.0
    by_side: dict[str, list[float]] = {"BUY": [], "SELL": []}
    net_by_side: dict[str, list[float]] = {"BUY": [], "SELL": []}
    hits: dict[str, int] = {"BUY": 0, "SELL": 0}
    incomplete_outcomes = 0
    by_key = {(bar.segment_key, bar.timestamp): bar for bar in bars}
    steps = horizon_minutes // RESAMPLE_MINUTES
    for signal in signals:
        if not 0 <= signal.index < len(bars):
            incomplete_outcomes += 1
            continue
        segment = bars[signal.index].segment_key
        timestamps = [
            signal.timestamp + timedelta(minutes=RESAMPLE_MINUTES * offset)
            for offset in range(1, steps + 1)
        ]
        window = [by_key.get((segment, timestamp)) for timestamp in timestamps]
        if any(item is None for item in window):
            incomplete_outcomes += 1
            continue
        window = [item for item in window if item is not None]
        end_price = window[-1].close
        forward_return = (end_price - signal.price) / signal.price * 100
        by_side[signal.side].append(forward_return)
        net_return = forward_return - cost_pct if signal.side == "BUY" else forward_return + cost_pct
        net_by_side[signal.side].append(net_return)
        favorable = forward_return > 0 if signal.side == "BUY" else forward_return < 0
        hits[signal.side] += 1 if favorable else 0
    result = {}
    for side in ("BUY", "SELL"):
        returns = by_side[side]
        net_returns = net_by_side[side]
        result[side] = {
            "count": len(returns),
            "hit_rate_pct": round(hits[side] / len(returns) * 100, 1) if returns else None,
            "avg_return_pct": round(statistics.mean(returns), 3) if returns else None,
            "avg_net_return_pct": round(statistics.mean(net_returns), 3) if net_returns else None,
        }
    result["incomplete_outcomes"] = incomplete_outcomes
    return result


def load_bars(symbol: str, *, source: str = "cache", max_pages: int = 30) -> list[Bar]:
    """"cache" tops up data/candles_1m/<symbol>.jsonl with whatever the live
    API currently has, then resamples the *full accumulated* history --
    this is the whole point of candle_logger.py's periodic timer, since a
    single live fetch only ever sees Toss's ~1-day retention window.
    "live" skips the cache entirely and only uses the current API window."""
    broker = TossBroker()
    if source == "live":
        return resample(fetch_minute_candles(broker, symbol, max_pages=max_pages))
    candle_logger.update_symbol(broker, symbol, max_pages=max_pages)
    minute_bars = sorted(candle_logger.load_existing(symbol).values(), key=lambda bar: bar.timestamp)
    return resample(minute_bars)


def _indicator_experiments(bars: list[Bar]) -> list[tuple[str, list[bool], list[bool]]]:
    vwap = compute_vwap(bars)
    vwap_gap = [(bar.close - v) / v * 100 if v else None for bar, v in zip(bars, vwap)]
    rsi14 = compute_segmented_rsi(bars)
    stoch_k, _stoch_d = compute_segmented_stoch_rsi(bars)
    sma20_gap = compute_sma_gap_pct(bars)
    boll_pct_b = compute_bollinger_percent_b(bars)
    vol_z = compute_volume_zscore(bars)
    roc3 = compute_roc_pct(bars, period=3)

    experiments: list[tuple[str, list[bool], list[bool]]] = [
        ("VWAP괴리 단독 (1.5%)", below(vwap_gap, -1.5), above(vwap_gap, 1.5)),
        ("SMA20괴리 단독 (1.5%)", below(sma20_gap, -1.5), above(sma20_gap, 1.5)),
        ("볼린저 %B 단독 (밴드 이탈)", below(boll_pct_b, 0.0), above(boll_pct_b, 100.0)),
        ("RSI(14) 단독 (30/70)", below(rsi14, 30.0), above(rsi14, 70.0)),
        ("RSI(14) 단독 (20/80)", below(rsi14, 20.0), above(rsi14, 80.0)),
        ("StochRSI 단독 (20/80)", below(stoch_k, 20.0), above(stoch_k, 80.0)),
        ("StochRSI 단독 (5/95)", below(stoch_k, 5.0), above(stoch_k, 95.0)),
        ("ROC(3봉) 단독 (1.0%)", below(roc3, -1.0), above(roc3, 1.0)),
        (
            "거래량급증(z>=2) AND ROC방향(0.5%)",
            both(above(vol_z, 2.0), below(roc3, -0.5)),
            both(above(vol_z, 2.0), above(roc3, 0.5)),
        ),
        (
            "VWAP괴리 AND StochRSI(20/80)",
            both(below(vwap_gap, -1.5), below(stoch_k, 20.0)),
            both(above(vwap_gap, 1.5), above(stoch_k, 80.0)),
        ),
        (
            "VWAP괴리 AND StochRSI(5/95)",
            both(below(vwap_gap, -1.5), below(stoch_k, 5.0)),
            both(above(vwap_gap, 1.5), above(stoch_k, 95.0)),
        ),
        (
            "VWAP괴리 AND RSI(30/70)",
            both(below(vwap_gap, -1.5), below(rsi14, 30.0)),
            both(above(vwap_gap, 1.5), above(rsi14, 70.0)),
        ),
        (
            "볼린저%B AND 거래량급증",
            both(below(boll_pct_b, 0.0), above(vol_z, 2.0)),
            both(above(boll_pct_b, 100.0), above(vol_z, 2.0)),
        ),
        (
            "SMA20괴리 AND StochRSI(20/80)",
            both(below(sma20_gap, -1.5), below(stoch_k, 20.0)),
            both(above(sma20_gap, 1.5), above(stoch_k, 80.0)),
        ),
    ]
    return experiments


def _build_grid(
    bars: list[Bar],
    *,
    round_trip_cost_bps: float,
) -> list[tuple[str, int, dict, dict]]:
    grid: list[tuple[str, int, dict, dict]] = []
    for name, buy_mask, sell_mask in _indicator_experiments(bars):
        signals = edge_trigger(bars, buy_mask, sell_mask)
        for minutes in HORIZON_MINUTES:
            stats = evaluate(
                bars,
                signals,
                horizon_minutes=minutes,
                round_trip_cost_bps=round_trip_cost_bps,
            )
            grid.append((
                name,
                minutes,
                dict(stats["BUY"], incomplete_outcomes=stats["incomplete_outcomes"]),
                dict(stats["SELL"], incomplete_outcomes=stats["incomplete_outcomes"]),
            ))
    return grid


def _build_recovery_grid(
    bars: list[Bar],
    *,
    round_trip_cost_bps: float,
) -> list[dict]:
    grid: list[dict] = []
    for lookback_minutes in RECOVERY_LOOKBACK_MINUTES:
        signals = detect_drop_entries(
            bars,
            lookback_minutes=lookback_minutes,
            drop_threshold_pct=DROP_THRESHOLD_PCT,
        )
        for target_pct in RECOVERY_TARGET_PCTS:
            for horizon_minutes in RECOVERY_HORIZON_MINUTES:
                stats = evaluate_recovery_target(
                    bars,
                    signals,
                    target_pct=target_pct,
                    horizon_minutes=horizon_minutes,
                    round_trip_cost_bps=round_trip_cost_bps,
                )
                grid.append({
                    "lookback_minutes": lookback_minutes,
                    "drop_threshold_pct": DROP_THRESHOLD_PCT,
                    "target_pct": target_pct,
                    "horizon_minutes": horizon_minutes,
                    **stats,
                })
    return grid


def _ranked_recovery(
    grid: list[dict],
    *,
    minimum_count: int,
) -> list[dict]:
    candidates = [
        dict(row, sample_status=sample_status(row["complete_count"]))
        for row in grid
        if row["complete_count"] >= minimum_count
        and row["target_hit_rate_pct"] is not None
    ]
    return sorted(
        candidates,
        key=lambda row: (
            row["target_hit_rate_pct"],
            row["complete_count"],
            row["avg_net_return_pct"] if row["avg_net_return_pct"] is not None else float("-inf"),
        ),
        reverse=True,
    )[:5]


def _validation_ranked_recovery(
    discovery_grid: list[dict],
    validation_grid: list[dict],
    *,
    minimum_validation_signals: int,
) -> list[dict]:
    validation_by_key = {
        (
            row["lookback_minutes"],
            row["target_pct"],
            row["horizon_minutes"],
        ): row
        for row in validation_grid
    }
    results: list[dict] = []
    for discovery in _ranked_recovery(discovery_grid, minimum_count=MIN_SIGNAL_COUNT):
        key = (
            discovery["lookback_minutes"],
            discovery["target_pct"],
            discovery["horizon_minutes"],
        )
        validation = validation_by_key[key]
        if (
            validation["complete_count"] >= minimum_validation_signals
            and validation["target_hit_rate_pct"] is not None
        ):
            results.append(dict(validation, sample_status=sample_status(validation["complete_count"])))
    return sorted(
        results,
        key=lambda row: (
            row["target_hit_rate_pct"],
            row["complete_count"],
            row["avg_net_return_pct"] if row["avg_net_return_pct"] is not None else float("-inf"),
        ),
        reverse=True,
    )[:5]


def _ranked(
    grid: list[tuple[str, int, dict, dict]],
    side_index: int,
    reverse: bool,
    *,
    minimum_count: int,
) -> list[tuple[str, int, dict]]:
    candidates = [
        (name, minutes, dict(row[side_index], sample_status=sample_status(row[side_index]["count"])))
        for name, minutes, *row in grid
        if row[side_index]["count"] >= minimum_count
        and row[side_index]["avg_return_pct"] is not None
    ]
    return sorted(candidates, key=lambda item: item[2]["avg_net_return_pct" if "avg_net_return_pct" in item[2] else "avg_return_pct"], reverse=reverse)[:5]


def split_session_bars(
    bars: list[Bar], *, minimum_sessions: int = 30
) -> tuple[list[Bar], list[Bar], int, int]:
    sessions = sorted({bar.segment_key[0] for bar in bars})
    if len(sessions) < minimum_sessions:
        return [], [], len(sessions), 0
    discovery_count = ceil(len(sessions) * 0.7)
    discovery_dates = set(sessions[:discovery_count])
    validation_dates = set(sessions[discovery_count:])
    discovery = [bar for bar in bars if bar.segment_key[0] in discovery_dates]
    validation = [bar for bar in bars if bar.segment_key[0] in validation_dates]
    return discovery, validation, len(discovery_dates), len(validation_dates)


def _validation_ranked(
    discovery_grid: list[tuple[str, int, dict, dict]],
    validation_grid: list[tuple[str, int, dict, dict]],
    side_index: int,
    reverse: bool,
    *,
    minimum_validation_signals: int,
) -> list[tuple[str, int, dict]]:
    validation_by_key = {
        (name, minutes): row[side_index]
        for name, minutes, *row in validation_grid
    }
    results = []
    for name, minutes, _discovery_stats in _ranked(
        discovery_grid, side_index, reverse, minimum_count=MIN_SIGNAL_COUNT
    ):
        stats = validation_by_key[(name, minutes)]
        if stats["count"] >= minimum_validation_signals and stats["avg_return_pct"] is not None:
            results.append((name, minutes, dict(stats, sample_status=sample_status(stats["count"]))))
    return sorted(
        results,
        key=lambda item: item[2]["avg_net_return_pct" if "avg_net_return_pct" in item[2] else "avg_return_pct"],
        reverse=reverse,
    )[:5]


def sweep_report(
    bars: list[Bar],
    symbol: str,
    *,
    round_trip_cost_bps: float = 0.0,
    minimum_sessions: int = 30,
    minimum_validation_signals: int = 10,
) -> dict:
    session_count = len({bar.segment_key[0] for bar in bars})
    discovery_bars, validation_bars, discovery_count, validation_count = split_session_bars(
        bars, minimum_sessions=minimum_sessions
    )
    research_status = "VALIDATED" if validation_count else "EXPLORATORY"
    # Keep the previous indicator-grid fields for programmatic callers. The
    # user-facing report below is driven by the new recovery target grid.
    legacy_grid = _build_grid(bars, round_trip_cost_bps=round_trip_cost_bps)
    legacy_discovery_grid = (
        _build_grid(discovery_bars, round_trip_cost_bps=round_trip_cost_bps)
        if discovery_bars else legacy_grid
    )
    legacy_validation_grid = (
        _build_grid(validation_bars, round_trip_cost_bps=round_trip_cost_bps)
        if validation_bars else []
    )
    legacy_discovery_buy_top = _ranked(legacy_discovery_grid, 0, True, minimum_count=MIN_SIGNAL_COUNT)
    legacy_discovery_sell_top = _ranked(legacy_discovery_grid, 1, False, minimum_count=MIN_SIGNAL_COUNT)
    legacy_validation_buy_top = (
        _validation_ranked(
            legacy_discovery_grid,
            legacy_validation_grid,
            0,
            True,
            minimum_validation_signals=minimum_validation_signals,
        )
        if legacy_validation_grid else []
    )
    legacy_validation_sell_top = (
        _validation_ranked(
            legacy_discovery_grid,
            legacy_validation_grid,
            1,
            False,
            minimum_validation_signals=minimum_validation_signals,
        )
        if legacy_validation_grid else []
    )
    legacy_buy_top = legacy_validation_buy_top if research_status == "VALIDATED" else legacy_discovery_buy_top
    legacy_sell_top = legacy_validation_sell_top if research_status == "VALIDATED" else legacy_discovery_sell_top

    target_grid = _build_recovery_grid(bars, round_trip_cost_bps=round_trip_cost_bps)
    target_discovery_grid = (
        _build_recovery_grid(discovery_bars, round_trip_cost_bps=round_trip_cost_bps)
        if discovery_bars else target_grid
    )
    target_validation_grid = (
        _build_recovery_grid(validation_bars, round_trip_cost_bps=round_trip_cost_bps)
        if validation_bars else []
    )
    discovery_top = _ranked_recovery(target_discovery_grid, minimum_count=MIN_SIGNAL_COUNT)
    validation_top = (
        _validation_ranked_recovery(
            target_discovery_grid,
            target_validation_grid,
            minimum_validation_signals=minimum_validation_signals,
        )
        if target_validation_grid else []
    )
    target_top = validation_top if research_status == "VALIDATED" else discovery_top
    return {
        "symbol": symbol,
        "bar_count": len(bars),
        "days": session_count,
        "session_count": session_count,
        "research_status": research_status,
        "discovery_session_count": discovery_count,
        "validation_session_count": validation_count,
        "round_trip_cost_bps": round_trip_cost_bps,
        "grid_scope": "FULL_HISTORY_EXPLORATORY",
        "incomplete_outcomes": sum(
            row.get("incomplete_outcomes", 0)
            for row in target_grid
        ),
        "range": (bars[0].timestamp.isoformat(), bars[-1].timestamp.isoformat()) if bars else None,
        "grid": legacy_grid,
        "discovery_grid": legacy_discovery_grid,
        "validation_grid": legacy_validation_grid,
        "legacy_grid": legacy_grid,
        "legacy_discovery_grid": legacy_discovery_grid,
        "legacy_validation_grid": legacy_validation_grid,
        "target_grid": target_grid,
        "discovery_target_grid": target_discovery_grid,
        "validation_target_grid": target_validation_grid,
        "drop_threshold_pct": DROP_THRESHOLD_PCT,
        "recovery_lookback_minutes": RECOVERY_LOOKBACK_MINUTES,
        "recovery_target_pcts": RECOVERY_TARGET_PCTS,
        "recovery_horizon_minutes": RECOVERY_HORIZON_MINUTES,
        "discovery_target_top": discovery_top,
        "validation_target_top": validation_top,
        "target_top": target_top,
        # Preserve the old tuple-shaped fields for programmatic callers. New
        # consumers should use target_top and the target_* grid fields.
        "discovery_buy_top": legacy_discovery_buy_top,
        "discovery_sell_top": legacy_discovery_sell_top,
        "validation_buy_top": legacy_validation_buy_top,
        "validation_sell_top": legacy_validation_sell_top,
        "buy_top": legacy_buy_top,
        "sell_top": legacy_sell_top,
    }


def print_report(report: dict) -> None:
    def cell(stat: dict, key: str) -> str:
        return "-" if stat[key] is None else str(stat[key])

    print(
        f"{report['symbol']}: 3분봉 {report['bar_count']}개 "
        f"(거래세션 {report.get('session_count', report['days'])}개) "
        f"· 연구상태 {report.get('research_status', 'EXPLORATORY')}"
    )
    print(
        f"비용 가정: 왕복 {report.get('round_trip_cost_bps', 0.0)}bps "
        f"· 불완전 결과 제외 {report.get('incomplete_outcomes', 0)}건"
    )
    print(
        f"전략: 최근 고점 대비 -{report.get('drop_threshold_pct', DROP_THRESHOLD_PCT)}% 급락 매수 "
        f"→ 목표 {', '.join(f'+{target:g}%' for target in report.get('recovery_target_pcts', RECOVERY_TARGET_PCTS))} 회복"
    )
    if report["range"]:
        print(f"기간: {report['range'][0]} ~ {report['range'][1]}")
    print()
    if report.get("research_status") == "VALIDATED":
        print("[전체 기간 그리드 — 탐색 참고용, 검증 아님]")
    else:
        print("[전체 기간 그리드 — 탐색 결과]")

    header = f"{'고점관찰':>8} {'목표':>6} {'제한(분)':>8} {'신호':>6} {'완료':>6} {'목표도달':>9} {'중앙도달(분)':>13} {'총수익%':>9} {'순수익%':>9} {'평균최대하락%':>14}"
    print(header)
    print("-" * len(header))
    for row in report["target_grid"]:
        print(
            f"{row['lookback_minutes']:>8} {row['target_pct']:>5.1f}% {row['horizon_minutes']:>8} "
            f"{row['signal_count']:>6} {row['complete_count']:>6} "
            f"{cell(row, 'target_hit_rate_pct'):>8}% {cell(row, 'median_hit_minutes'):>13} "
            f"{cell(row, 'avg_gross_return_pct'):>9} {cell(row, 'avg_net_return_pct'):>9} "
            f"{cell(row, 'avg_max_adverse_pct'):>14}"
        )

    print()
    print(f"[목표 도달률 상위 5 — 완료 표본 {MIN_SIGNAL_COUNT}건 이상]")
    for row in report.get("target_top", report.get("buy_top", [])):
        print(
            f"  고점관찰 {row['lookback_minutes']}분 · 목표 +{row['target_pct']:g}% · "
            f"제한 {row['horizon_minutes']}분 · 완료 n={row['complete_count']} "
            f"· 표본 {row.get('sample_status', sample_status(row['complete_count']))} "
            f"· 도달률 {row['target_hit_rate_pct']}% · 중앙 도달 {row['median_hit_minutes']}분 "
            f"· 총수익 {row['avg_gross_return_pct']}% · 순수익 {row['avg_net_return_pct']}% "
            f"· 최대하락 {row['avg_max_adverse_pct']}%"
        )


def telegram_summary(report: dict) -> str:
    """Condensed drop-entry/recovery-target summary."""
    lines = [
        f"[급락 회복 스윕 결과] {report['symbol']} · 3분봉 {report['bar_count']}개 · "
        f"거래세션 {report.get('session_count', report['days'])}개 · "
        f"상태 {report.get('research_status', 'EXPLORATORY')}",
        f"비용 왕복 {report.get('round_trip_cost_bps', 0.0)}bps · 불완전 제외 {report.get('incomplete_outcomes', 0)}건",
        f"전략 -{report.get('drop_threshold_pct', DROP_THRESHOLD_PCT):g}% 급락 매수 → "
        f"+{', +'.join(f'{target:g}%' for target in report.get('recovery_target_pcts', RECOVERY_TARGET_PCTS))} 목표",
    ]
    if report.get("research_status") == "VALIDATED":
        lines.append("검증 상위 후보는 후반 세션 기준이며, 전체 기간 그리드는 탐색 참고용입니다.")
    lines.append("")
    lines.append(f"목표 도달률 상위 (완료 표본 {MIN_SIGNAL_COUNT}건+):")
    target_top = report.get("target_top", report.get("buy_top", []))
    if target_top:
        for row in target_top:
            lines.append(
                f"· 관찰{row['lookback_minutes']}분 목표+{row['target_pct']:g}% 제한{row['horizon_minutes']}분 "
                f"완료n={row['complete_count']} "
                f"표본{row.get('sample_status', sample_status(row['complete_count']))} "
                f"도달{row['target_hit_rate_pct']}% 중앙{row['median_hit_minutes']}분 "
                f"총{row['avg_gross_return_pct']}% 순{row['avg_net_return_pct']}% "
                f"최대하락{row['avg_max_adverse_pct']}%"
            )
    else:
        lines.append("· 조건을 만족하는 조합 없음")
    return "\n".join(lines)


def notify_telegram(report: dict) -> None:
    notifier = TelegramNotifier()
    if not notifier.enabled:
        print("Telegram 미설정 (MUMAE_TELEGRAM_BOT_TOKEN/CHAT_ID 없음) -- 전송 건너뜀")
        return
    notifier.send_message(telegram_summary(report))


def run_sweep(
    symbol: str = "KORU",
    *,
    max_pages: int = 30,
    source: str = "cache",
    notify: bool = False,
    round_trip_cost_bps: float = 0.0,
) -> None:
    bars = load_bars(symbol, source=source, max_pages=max_pages)
    report = sweep_report(bars, symbol, round_trip_cost_bps=round_trip_cost_bps)
    print_report(report)
    if notify:
        notify_telegram(report)


def main() -> None:
    import argparse
    parser = build_parser()
    args = parser.parse_args()
    run_sweep(
        args.symbol,
        max_pages=args.pages,
        source=args.source,
        notify=args.notify,
        round_trip_cost_bps=args.round_trip_cost_bps,
    )


def build_parser():
    import argparse
    parser = argparse.ArgumentParser(description="-3% 급락 진입 후 +2/+3/+4% 회복 목표 도달률을 스윕")
    parser.add_argument("symbol", nargs="?", default="KORU")
    parser.add_argument("--pages", type=int, default=30, help="live 소스일 때만 의미 있음 (cache는 top-up용으로만 사용)")
    parser.add_argument("--source", choices=("cache", "live"), default="cache")
    parser.add_argument("--notify", action="store_true", help="결과 요약을 텔레그램으로 전송")
    parser.add_argument(
        "--round-trip-cost-bps",
        type=float,
        default=float(os.getenv("MUMAE_BACKTEST_ROUND_TRIP_COST_BPS", "0") or 0),
        help="왕복 거래비용 가정 (basis points; MUMAE_BACKTEST_ROUND_TRIP_COST_BPS로 기본값 설정)",
    )
    return parser


if __name__ == "__main__":
    main()
