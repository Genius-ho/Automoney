"""Sweep several intraday indicators (single and AND-paired) over the
3-minute KORU bars we can actually fetch, to see which one best marks a
temporary flash dip/spike worth a small buy/sell.

Reuses the data pipeline (fetch/resample/VWAP/RSI/StochRSI) from
backtest_vwap_rsi.py and adds a few more indicators, then runs every
combination through the same edge-triggered signal / forward-return
evaluation so the results are directly comparable.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime

import candle_logger
from backtest_vwap_rsi import (
    RESAMPLE_MINUTES,
    Bar,
    TossBroker,
    compute_rsi,
    compute_stoch_rsi,
    compute_vwap,
    fetch_minute_candles,
    resample,
)
from telegram_bot import TelegramNotifier

FORWARD_BARS = 10  # 10 * 3m = 30 minutes
# A single-horizon check undersells slow reversions: a manually-spotted BUY
# point on 2026-08-07 was underwater at 30-60min but +2.5% by 90min. Sweep
# several horizons per signal instead of judging on one fixed window.
HORIZON_MINUTES = (30, 60, 90, 120, 180)
MIN_SIGNAL_COUNT = 5


def compute_sma(closes: list[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(closes)
    for index in range(len(closes)):
        if index - period + 1 < 0:
            continue
        result[index] = sum(closes[index - period + 1: index + 1]) / period
    return result


def compute_sma_gap_pct(bars: list[Bar], period: int = 20) -> list[float | None]:
    """% deviation of close from a plain N-period SMA (VWAP's un-volume-weighted cousin)."""
    closes = [bar.close for bar in bars]
    sma = compute_sma(closes, period)
    return [None if value is None else (close - value) / value * 100 for close, value in zip(closes, sma)]


def compute_bollinger_percent_b(bars: list[Bar], period: int = 20, num_std: float = 2.0) -> list[float | None]:
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


def compute_volume_zscore(bars: list[Bar], period: int = 20) -> list[float | None]:
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


def compute_roc_pct(bars: list[Bar], period: int = 3) -> list[float | None]:
    """% change vs. the close `period` bars ago -- a raw momentum-burst measure."""
    closes = [bar.close for bar in bars]
    result: list[float | None] = [None] * len(closes)
    for index in range(len(closes)):
        if index - period < 0 or not closes[index - period]:
            continue
        result[index] = (closes[index] - closes[index - period]) / closes[index - period] * 100
    return result


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
    armed_buy = armed_sell = False
    for index, bar in enumerate(bars):
        if buy_mask[index] and not armed_buy:
            signals.append(SweepSignal(index, bar.timestamp, "BUY", bar.close))
        if sell_mask[index] and not armed_sell:
            signals.append(SweepSignal(index, bar.timestamp, "SELL", bar.close))
        armed_buy, armed_sell = buy_mask[index], sell_mask[index]
    return signals


def evaluate(bars: list[Bar], signals: list[SweepSignal], *, forward_bars: int = FORWARD_BARS) -> dict:
    by_side: dict[str, list[float]] = {"BUY": [], "SELL": []}
    hits: dict[str, int] = {"BUY": 0, "SELL": 0}
    for signal in signals:
        window = bars[signal.index + 1: signal.index + 1 + forward_bars]
        if not window:
            continue
        end_price = window[-1].close
        forward_return = (end_price - signal.price) / signal.price * 100
        by_side[signal.side].append(forward_return)
        favorable = forward_return > 0 if signal.side == "BUY" else forward_return < 0
        hits[signal.side] += 1 if favorable else 0
    result = {}
    for side in ("BUY", "SELL"):
        returns = by_side[side]
        result[side] = {
            "count": len(returns),
            "hit_rate_pct": round(hits[side] / len(returns) * 100, 1) if returns else None,
            "avg_return_pct": round(statistics.mean(returns), 3) if returns else None,
        }
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


def sweep_report(bars: list[Bar], symbol: str) -> dict:
    closes = [bar.close for bar in bars]
    days = len({bar.timestamp.date() for bar in bars})

    vwap = compute_vwap(bars)
    vwap_gap = [(bar.close - v) / v * 100 if v else None for bar, v in zip(bars, vwap)]
    rsi14 = compute_rsi(closes)
    stoch_k, _stoch_d = compute_stoch_rsi(closes)
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

    grid: list[tuple[str, int, dict, dict]] = []
    for name, buy_mask, sell_mask in experiments:
        signals = edge_trigger(bars, buy_mask, sell_mask)
        for minutes in HORIZON_MINUTES:
            stats = evaluate(bars, signals, forward_bars=minutes // RESAMPLE_MINUTES)
            grid.append((name, minutes, stats["BUY"], stats["SELL"]))

    def ranked(side_index: int, reverse: bool) -> list[tuple[str, int, dict]]:
        candidates = [
            (name, minutes, row[side_index])
            for name, minutes, *row in grid
            if row[side_index]["count"] >= MIN_SIGNAL_COUNT and row[side_index]["avg_return_pct"] is not None
        ]
        return sorted(candidates, key=lambda item: item[2]["avg_return_pct"], reverse=reverse)[:5]

    return {
        "symbol": symbol,
        "bar_count": len(bars),
        "days": days,
        "range": (bars[0].timestamp.isoformat(), bars[-1].timestamp.isoformat()) if bars else None,
        "grid": grid,
        "buy_top": ranked(0, reverse=True),
        "sell_top": ranked(1, reverse=False),
    }


def print_report(report: dict) -> None:
    def cell(stat: dict, key: str) -> str:
        return "-" if stat[key] is None else str(stat[key])

    print(f"{report['symbol']}: 3분봉 {report['bar_count']}개 (거래일 {report['days']}일치)")
    if report["range"]:
        print(f"기간: {report['range'][0]} ~ {report['range'][1]}")
    print()

    header = f"{'지표 조합':32} {'창(분)':>6} {'매수n':>5} {'매수적중%':>9} {'매수평균%':>9}   {'매도n':>5} {'매도적중%':>9} {'매도평균%':>9}"
    print(header)
    print("-" * len(header))
    for name, minutes, buy, sell in report["grid"]:
        print(
            f"{name:32} {minutes:>6} {buy['count']:>5} {cell(buy, 'hit_rate_pct'):>9} {cell(buy, 'avg_return_pct'):>9}   "
            f"{sell['count']:>5} {cell(sell, 'hit_rate_pct'):>9} {cell(sell, 'avg_return_pct'):>9}"
        )

    print()
    print(f"[매수 상위 5 — 평균수익% 높은 순, 표본 {MIN_SIGNAL_COUNT}건 이상]")
    for name, minutes, stats in report["buy_top"]:
        print(f"  {name} · {minutes}분창 · n={stats['count']} · 적중률 {stats['hit_rate_pct']}% · 평균 {stats['avg_return_pct']}%")

    print()
    print(f"[매도 상위 5 — 평균수익%(매도후 하락폭) 낮은 순, 표본 {MIN_SIGNAL_COUNT}건 이상]")
    for name, minutes, stats in report["sell_top"]:
        print(f"  {name} · {minutes}분창 · n={stats['count']} · 적중률 {stats['hit_rate_pct']}% · 평균 {stats['avg_return_pct']}%")


def telegram_summary(report: dict) -> str:
    """Condensed, BUY-first summary (매수만 잘하면 매도는 괜찮다는 우선순위에 맞춤)."""
    lines = [
        f"[지표 스윕 결과] {report['symbol']} · 3분봉 {report['bar_count']}개 · 거래일 {report['days']}일치",
    ]
    lines.append("")
    lines.append(f"매수 상위 (표본 {MIN_SIGNAL_COUNT}건+):")
    if report["buy_top"]:
        for name, minutes, stats in report["buy_top"]:
            lines.append(f"· {name} ({minutes}분) n={stats['count']} 적중{stats['hit_rate_pct']}% 평균{stats['avg_return_pct']}%")
    else:
        lines.append("· 조건을 만족하는 조합 없음")
    lines.append("")
    lines.append(f"매도 상위 (표본 {MIN_SIGNAL_COUNT}건+):")
    if report["sell_top"]:
        for name, minutes, stats in report["sell_top"]:
            lines.append(f"· {name} ({minutes}분) n={stats['count']} 적중{stats['hit_rate_pct']}% 평균{stats['avg_return_pct']}%")
    else:
        lines.append("· 조건을 만족하는 조합 없음")
    return "\n".join(lines)


def notify_telegram(report: dict) -> None:
    notifier = TelegramNotifier()
    if not notifier.enabled:
        print("Telegram 미설정 (MUMAE_TELEGRAM_BOT_TOKEN/CHAT_ID 없음) -- 전송 건너뜀")
        return
    notifier.send_message(telegram_summary(report))


def run_sweep(symbol: str = "KORU", *, max_pages: int = 30, source: str = "cache", notify: bool = False) -> None:
    bars = load_bars(symbol, source=source, max_pages=max_pages)
    report = sweep_report(bars, symbol)
    print_report(report)
    if notify:
        notify_telegram(report)


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="여러 지표 x 시간창 조합을 스윕해 매수/매도 신호 후보를 순위화")
    parser.add_argument("symbol", nargs="?", default="KORU")
    parser.add_argument("--pages", type=int, default=30, help="live 소스일 때만 의미 있음 (cache는 top-up용으로만 사용)")
    parser.add_argument("--source", choices=("cache", "live"), default="cache")
    parser.add_argument("--notify", action="store_true", help="결과 요약을 텔레그램으로 전송")
    args = parser.parse_args()
    run_sweep(args.symbol, max_pages=args.pages, source=args.source, notify=args.notify)


if __name__ == "__main__":
    main()
