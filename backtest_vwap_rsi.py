"""Backtest: does a sharp VWAP-deviation or an RSI extreme on 3-minute bars
mark a temporary intraday dip/spike worth a small buy/sell?

Pulls whatever 1-minute candle history the Toss API actually returns (no
assumed retention window -- see get_minute_candles_raw), resamples to
3-minute bars, computes VWAP and RSI, and reports how price behaved after
each signal.
"""
from __future__ import annotations

import argparse
import statistics
import time
from dataclasses import dataclass
from datetime import datetime

from toss_api import TossBroker

RESAMPLE_MINUTES = 3
RSI_PERIOD = 14


@dataclass
class Bar:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


def fetch_minute_candles(broker: TossBroker, symbol: str, max_pages: int = 30, page_size: int = 200) -> list[Bar]:
    """Page backward through 1-minute candles as far as the API returns data.

    Stops as soon as the API reports no further history (nextBefore is
    falsy) or a page comes back empty; Toss does not document a retention
    window for intraday candles, so this never assumes one.
    """
    bars: list[Bar] = []
    before: str | None = None
    for page in range(max_pages):
        payload = broker.get_minute_candles_raw(symbol, page_size, before=before)
        candles = payload.get("result", {}).get("candles", [])
        if not candles:
            break
        for candle in candles:
            bars.append(Bar(
                timestamp=datetime.fromisoformat(candle["timestamp"]),
                open=float(candle["openPrice"]),
                high=float(candle["highPrice"]),
                low=float(candle["lowPrice"]),
                close=float(candle["closePrice"]),
                volume=float(candle["volume"]),
            ))
        before = payload.get("result", {}).get("nextBefore")
        if not before:
            break
        if page < max_pages - 1:
            time.sleep(0.25)  # Stay under the MARKET_DATA_CHART group's 5 TPS limit.
    bars.sort(key=lambda bar: bar.timestamp)
    return bars


def resample(bars: list[Bar], minutes: int = RESAMPLE_MINUTES) -> list[Bar]:
    """Group consecutive 1-minute bars into wall-clock-aligned N-minute bars."""
    buckets: dict[datetime, list[Bar]] = {}
    for bar in bars:
        floor_minute = bar.timestamp.minute - bar.timestamp.minute % minutes
        key = bar.timestamp.replace(minute=floor_minute, second=0, microsecond=0)
        buckets.setdefault(key, []).append(bar)
    result = []
    for key in sorted(buckets):
        group = buckets[key]
        result.append(Bar(
            timestamp=key,
            open=group[0].open,
            high=max(item.high for item in group),
            low=min(item.low for item in group),
            close=group[-1].close,
            volume=sum(item.volume for item in group),
        ))
    return result


def compute_vwap(bars: list[Bar]) -> list[float]:
    """Intraday VWAP, resetting the cumulative sums at each new calendar date."""
    vwap: list[float] = []
    cum_pv = cum_vol = 0.0
    current_date = None
    for bar in bars:
        bar_date = bar.timestamp.date()
        if bar_date != current_date:
            current_date = bar_date
            cum_pv = cum_vol = 0.0
        typical_price = (bar.high + bar.low + bar.close) / 3
        cum_pv += typical_price * bar.volume
        cum_vol += bar.volume
        vwap.append(cum_pv / cum_vol if cum_vol else bar.close)
    return vwap


def compute_rsi(closes: list[float], period: int = RSI_PERIOD) -> list[float | None]:
    """Wilder-smoothed RSI. The first `period` entries are None (not enough history)."""
    rsi: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return rsi
    gains = losses = 0.0
    for index in range(1, period + 1):
        change = closes[index] - closes[index - 1]
        gains += max(change, 0.0)
        losses += max(-change, 0.0)
    avg_gain = gains / period
    avg_loss = losses / period
    rsi[period] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1 + avg_gain / avg_loss)
    for index in range(period + 1, len(closes)):
        change = closes[index] - closes[index - 1]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        rsi[index] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1 + avg_gain / avg_loss)
    return rsi


def compute_stoch_rsi(
    closes: list[float],
    *,
    rsi_period: int = 14,
    stoch_period: int = 14,
    smooth_k: int = 3,
    smooth_d: int = 3,
) -> tuple[list[float | None], list[float | None]]:
    """Standard (14,14,3,3) Stochastic RSI: %K and %D on a 0-100 scale.

    Plain RSI rarely touches the extremes (see compute_rsi); Stochastic RSI
    re-normalizes RSI against its own recent range, so it regularly swings
    to 0/100 -- thresholds like 2/98 are only meaningful against this, not
    against plain RSI.
    """
    rsi = compute_rsi(closes, period=rsi_period)
    raw_stoch: list[float | None] = [None] * len(closes)
    for index in range(len(closes)):
        window = rsi[max(0, index - stoch_period + 1): index + 1]
        if len(window) < stoch_period or any(value is None for value in window):
            continue
        low, high = min(window), max(window)
        # RSI has been flat across the whole window (e.g. pegged at 0 or 100
        # during a sustained one-directional move) -- there's no range to
        # normalize against, so fall back to the RSI level itself rather
        # than forcing an arbitrary extreme.
        raw_stoch[index] = rsi[index] if high == low else (rsi[index] - low) / (high - low) * 100.0

    def _sma(values: list[float | None], period: int) -> list[float | None]:
        result: list[float | None] = [None] * len(values)
        for index in range(len(values)):
            if index - period + 1 < 0:
                continue
            window = values[index - period + 1: index + 1]
            if any(item is None for item in window):
                continue
            result[index] = sum(window) / period
        return result

    k = _sma(raw_stoch, smooth_k)
    d = _sma(k, smooth_d)
    return k, d


@dataclass
class Signal:
    index: int
    timestamp: datetime
    side: str  # "BUY" or "SELL"
    price: float
    vwap_gap_pct: float
    rsi: float | None


def detect_signals(
    bars: list[Bar],
    vwap: list[float],
    rsi: list[float | None],
    *,
    vwap_gap_pct: float = 1.5,
    rsi_buy: float = 2.0,
    rsi_sell: float = 98.0,
) -> list[Signal]:
    """Edge-triggered BUY/SELL signals: fires once per excursion (the bar
    where the condition first becomes true), not on every bar it holds --
    otherwise one dip/spike would be counted dozens of times.

    Both the VWAP-gap and RSI-extreme conditions must hold at once (AND):
    a lone RSI extreme or a lone VWAP gap is not enough on its own."""
    signals: list[Signal] = []
    armed_buy = armed_sell = False
    for index, bar in enumerate(bars):
        gap = (bar.close - vwap[index]) / vwap[index] * 100 if vwap[index] else 0.0
        bar_rsi = rsi[index]
        buy_condition = gap <= -vwap_gap_pct and bar_rsi is not None and bar_rsi <= rsi_buy
        sell_condition = gap >= vwap_gap_pct and bar_rsi is not None and bar_rsi >= rsi_sell
        if buy_condition and not armed_buy:
            signals.append(Signal(index, bar.timestamp, "BUY", bar.close, gap, bar_rsi))
        if sell_condition and not armed_sell:
            signals.append(Signal(index, bar.timestamp, "SELL", bar.close, gap, bar_rsi))
        armed_buy, armed_sell = buy_condition, sell_condition
    return signals


@dataclass
class SignalOutcome:
    signal: Signal
    forward_return_pct: float  # price change at window end vs. entry
    best_case_pct: float       # most favorable move seen within the window
    favorable: bool


def evaluate_signals(bars: list[Bar], signals: list[Signal], *, forward_bars: int = 10) -> list[SignalOutcome]:
    outcomes = []
    for signal in signals:
        window = bars[signal.index + 1: signal.index + 1 + forward_bars]
        if not window:
            continue
        end_price = window[-1].close
        forward_return = (end_price - signal.price) / signal.price * 100
        if signal.side == "BUY":
            best_case = (max(item.close for item in window) - signal.price) / signal.price * 100
            favorable = forward_return > 0
        else:
            best_case = (signal.price - min(item.close for item in window)) / signal.price * 100
            favorable = forward_return < 0
        outcomes.append(SignalOutcome(signal, forward_return, best_case, favorable))
    return outcomes


def summarize(outcomes: list[SignalOutcome], side: str) -> dict:
    subset = [item for item in outcomes if item.signal.side == side]
    if not subset:
        return {"count": 0}
    returns = [item.forward_return_pct for item in subset]
    best = [item.best_case_pct for item in subset]
    hits = sum(1 for item in subset if item.favorable)
    return {
        "count": len(subset),
        "hit_rate_pct": round(hits / len(subset) * 100, 1),
        "avg_forward_return_pct": round(statistics.mean(returns), 3),
        "median_forward_return_pct": round(statistics.median(returns), 3),
        "avg_best_case_pct": round(statistics.mean(best), 3),
    }


def run_backtest(
    symbol: str,
    *,
    max_pages: int = 30,
    forward_bars: int = 10,
    vwap_gap_pct: float = 1.5,
    rsi_buy: float = 2.0,
    rsi_sell: float = 98.0,
) -> dict:
    broker = TossBroker()
    minute_bars = fetch_minute_candles(broker, symbol, max_pages=max_pages)
    bars = resample(minute_bars)
    vwap = compute_vwap(bars)
    stoch_k, _stoch_d = compute_stoch_rsi([bar.close for bar in bars])
    signals = detect_signals(bars, vwap, stoch_k, vwap_gap_pct=vwap_gap_pct, rsi_buy=rsi_buy, rsi_sell=rsi_sell)
    outcomes = evaluate_signals(bars, signals, forward_bars=forward_bars)
    return {
        "symbol": symbol,
        "minute_candles": len(minute_bars),
        "resampled_bars": len(bars),
        "range": (bars[0].timestamp.isoformat(), bars[-1].timestamp.isoformat()) if bars else None,
        "buy": summarize(outcomes, "BUY"),
        "sell": summarize(outcomes, "SELL"),
        "signals": outcomes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="VWAP 괴리 AND 스토캐스틱 RSI(14,14,3,3) 극단값 기반 3분봉 매수·매도 포인트 백테스트")
    parser.add_argument("symbol", nargs="?", default="KORU")
    parser.add_argument("--pages", type=int, default=30, help="1분봉 페이지 수 (페이지당 최대 200개, 실제 남아있는 만큼만 조회됨)")
    parser.add_argument("--forward-bars", type=int, default=10, help="신호 이후 결과를 확인할 3분봉 개수")
    parser.add_argument("--vwap-gap", type=float, default=1.5, help="VWAP 대비 괴리율(%) 임계값")
    parser.add_argument("--rsi-buy", type=float, default=2.0, help="StochRSI %%K 매수 임계값 (이하)")
    parser.add_argument("--rsi-sell", type=float, default=98.0, help="StochRSI %%K 매도 임계값 (이상)")
    args = parser.parse_args()

    result = run_backtest(
        args.symbol,
        max_pages=args.pages,
        forward_bars=args.forward_bars,
        vwap_gap_pct=args.vwap_gap,
        rsi_buy=args.rsi_buy,
        rsi_sell=args.rsi_sell,
    )

    print(f"{result['symbol']}: 1분봉 {result['minute_candles']}개 -> {RESAMPLE_MINUTES}분봉 {result['resampled_bars']}개")
    if result["range"]:
        print(f"기간: {result['range'][0]} ~ {result['range'][1]}")
    for side in ("buy", "sell"):
        stats = result[side]
        label = "매수(급락 AND StochRSI저)" if side == "buy" else "매도(급등 AND StochRSI고)"
        if stats["count"] == 0:
            print(f"{label}: 신호 없음")
            continue
        print(
            f"{label}: {stats['count']}건 · 적중률 {stats['hit_rate_pct']}% · "
            f"평균 결과 {stats['avg_forward_return_pct']}% · 중앙값 {stats['median_forward_return_pct']}% · "
            f"평균 최선 {stats['avg_best_case_pct']}%"
        )
    print()
    print(f"{'시각':19} {'구분':4} {'가격':>10} {'VWAP괴리%':>10} {'StochRSI':>8} {'결과%':>8}")
    for outcome in result["signals"]:
        signal = outcome.signal
        rsi_text = f"{signal.rsi:.1f}" if signal.rsi is not None else "-"
        print(
            f"{signal.timestamp.strftime('%Y-%m-%d %H:%M'):19} {signal.side:4} "
            f"{signal.price:>10.2f} {signal.vwap_gap_pct:>10.2f} {rsi_text:>8} {outcome.forward_return_pct:>8.2f}"
        )


if __name__ == "__main__":
    main()
