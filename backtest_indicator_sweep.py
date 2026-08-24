"""Sweep several intraday indicators (single and AND-paired) over the
3-minute KORU bars we can actually fetch, to see which one best marks a
temporary flash dip/spike worth a small buy/sell.

Reuses the data pipeline (fetch/resample/VWAP/RSI/StochRSI) from
backtest_vwap_rsi.py and adds a few more indicators, then runs every
combination through the same edge-triggered signal / forward-return
evaluation so the results are directly comparable.
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
    grid = _build_grid(bars, round_trip_cost_bps=round_trip_cost_bps)
    discovery_grid = (
        _build_grid(discovery_bars, round_trip_cost_bps=round_trip_cost_bps)
        if discovery_bars else grid
    )
    validation_grid = _build_grid(validation_bars, round_trip_cost_bps=round_trip_cost_bps) if validation_bars else []
    discovery_buy_top = _ranked(discovery_grid, 0, True, minimum_count=MIN_SIGNAL_COUNT)
    discovery_sell_top = _ranked(discovery_grid, 1, False, minimum_count=MIN_SIGNAL_COUNT)
    validation_buy_top = _validation_ranked(
        discovery_grid, validation_grid, 0, True,
        minimum_validation_signals=minimum_validation_signals,
    ) if validation_grid else []
    validation_sell_top = _validation_ranked(
        discovery_grid, validation_grid, 1, False,
        minimum_validation_signals=minimum_validation_signals,
    ) if validation_grid else []
    buy_top = validation_buy_top if research_status == "VALIDATED" else discovery_buy_top
    sell_top = validation_sell_top if research_status == "VALIDATED" else discovery_sell_top
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
            buy.get("incomplete_outcomes", 0)
            for _name, _minutes, buy, _sell in grid
        ),
        "range": (bars[0].timestamp.isoformat(), bars[-1].timestamp.isoformat()) if bars else None,
        "grid": grid,
        "discovery_grid": discovery_grid,
        "validation_grid": validation_grid,
        "discovery_buy_top": discovery_buy_top,
        "discovery_sell_top": discovery_sell_top,
        "validation_buy_top": validation_buy_top,
        "validation_sell_top": validation_sell_top,
        "buy_top": buy_top,
        "sell_top": sell_top,
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
    if report["range"]:
        print(f"기간: {report['range'][0]} ~ {report['range'][1]}")
    print()
    if report.get("research_status") == "VALIDATED":
        print("[전체 기간 그리드 — 탐색 참고용, 검증 아님]")
    else:
        print("[전체 기간 그리드 — 탐색 결과]")

    header = f"{'지표 조합':32} {'창(분)':>6} {'매수n':>5} {'매수적중%':>9} {'매수평균%':>9} {'매수순수익%':>11}   {'매도n':>5} {'매도적중%':>9} {'매도평균%':>9} {'매도순수익%':>11}"
    print(header)
    print("-" * len(header))
    for name, minutes, buy, sell in report["grid"]:
        print(
            f"{name:32} {minutes:>6} {buy['count']:>5} {cell(buy, 'hit_rate_pct'):>9} {cell(buy, 'avg_return_pct'):>9} {cell(buy, 'avg_net_return_pct'):>11}   "
            f"{sell['count']:>5} {cell(sell, 'hit_rate_pct'):>9} {cell(sell, 'avg_return_pct'):>9} {cell(sell, 'avg_net_return_pct'):>11}"
        )

    print()
    print(f"[매수 상위 5 — 평균수익% 높은 순, 표본 {MIN_SIGNAL_COUNT}건 이상]")
    for name, minutes, stats in report["buy_top"]:
        print(
            f"  {name} · {minutes}분창 · n={stats['count']} "
            f"· 표본 {stats.get('sample_status', sample_status(stats['count']))} "
            f"· 적중률 {stats['hit_rate_pct']}% · 총수익 {stats['avg_return_pct']}% "
            f"· 순수익 {stats.get('avg_net_return_pct', stats['avg_return_pct'])}%"
        )

    print()
    print(f"[매도 상위 5 — 평균수익%(매도후 하락폭) 낮은 순, 표본 {MIN_SIGNAL_COUNT}건 이상]")
    for name, minutes, stats in report["sell_top"]:
        print(
            f"  {name} · {minutes}분창 · n={stats['count']} "
            f"· 표본 {stats.get('sample_status', sample_status(stats['count']))} "
            f"· 적중률 {stats['hit_rate_pct']}% · 총수익 {stats['avg_return_pct']}% "
            f"· 순수익 {stats.get('avg_net_return_pct', stats['avg_return_pct'])}%"
        )


def telegram_summary(report: dict) -> str:
    """Condensed, BUY-first summary (매수만 잘하면 매도는 괜찮다는 우선순위에 맞춤)."""
    lines = [
        f"[지표 스윕 결과] {report['symbol']} · 3분봉 {report['bar_count']}개 · "
        f"거래세션 {report.get('session_count', report['days'])}개 · "
        f"상태 {report.get('research_status', 'EXPLORATORY')}",
        f"비용 왕복 {report.get('round_trip_cost_bps', 0.0)}bps · 불완전 제외 {report.get('incomplete_outcomes', 0)}건",
    ]
    if report.get("research_status") == "VALIDATED":
        lines.append("검증 상위 후보는 후반 세션 기준이며, 전체 기간 그리드는 탐색 참고용입니다.")
    lines.append("")
    lines.append(f"매수 상위 (표본 {MIN_SIGNAL_COUNT}건+):")
    if report["buy_top"]:
        for name, minutes, stats in report["buy_top"]:
            lines.append(
                f"· {name} ({minutes}분) n={stats['count']} "
                f"표본{stats.get('sample_status', sample_status(stats['count']))} "
                f"적중{stats['hit_rate_pct']}% 총{stats['avg_return_pct']}% 순{stats.get('avg_net_return_pct', stats['avg_return_pct'])}%"
            )
    else:
        lines.append("· 조건을 만족하는 조합 없음")
    lines.append("")
    lines.append(f"매도 상위 (표본 {MIN_SIGNAL_COUNT}건+):")
    if report["sell_top"]:
        for name, minutes, stats in report["sell_top"]:
            lines.append(
                f"· {name} ({minutes}분) n={stats['count']} "
                f"표본{stats.get('sample_status', sample_status(stats['count']))} "
                f"적중{stats['hit_rate_pct']}% 총{stats['avg_return_pct']}% 순{stats.get('avg_net_return_pct', stats['avg_return_pct'])}%"
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
    parser = argparse.ArgumentParser(description="여러 지표 x 시간창 조합을 스윕해 매수/매도 신호 후보를 순위화")
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
