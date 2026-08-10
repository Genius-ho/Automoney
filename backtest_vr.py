"""Backtest Laoer's VR5.0 (밸류 리밸런싱) band-rebalancing method on daily bars.

Reverse-engineered from a live Fire Gate (fire-gate.app) VR calculator
screenshot the user shared, and confirmed against its per-share order
ladder:

    V2 = V1 + Pool/G + contribution              (V grows every cycle)
    band = V * (1 - band_pct) .. V * (1 + band_pct)
    sell price for N shares remaining = V_high / (N + 1)
    buy price for N shares held       = V_low  / (N - 1)

Daily bars (not the per-share limit-order ladder) drive this backtest, so
a day that closes outside the band is modeled as one batch trade that
brings the position to the band edge at that day's close, rather than
replaying the exact 1-share-at-a-time ladder intraday.
"""
from __future__ import annotations

import argparse
import math
import time
from dataclasses import dataclass, field
from datetime import date, datetime

from toss_api import TossBroker

CYCLE_TRADING_DAYS = 10  # ~2 weeks, matching the pasted Fire Gate example


@dataclass
class DailyBar:
    date: date
    close: float


def fetch_daily_bars(broker: TossBroker, symbol: str, max_pages: int = 20, page_size: int = 200) -> list[DailyBar]:
    """Page backward through daily candles as far as the API returns data."""
    bars: list[DailyBar] = []
    before: str | None = None
    for page in range(max_pages):
        payload = broker.get_daily_candles_raw(symbol, page_size, before=before)
        candles = payload.get("result", {}).get("candles", [])
        if not candles:
            break
        for candle in candles:
            bars.append(DailyBar(
                date=datetime.fromisoformat(candle["timestamp"]).date(),
                close=float(candle["closePrice"]),
            ))
        before = payload.get("result", {}).get("nextBefore")
        if not before:
            break
        if page < max_pages - 1:
            time.sleep(0.25)  # Stay under the MARKET_DATA_CHART group's 5 TPS limit.
    seen: dict[date, DailyBar] = {bar.date: bar for bar in bars}
    return sorted(seen.values(), key=lambda bar: bar.date)


def next_v(v: float, pool: float, g: float, contribution: float) -> float:
    return v + pool / g + contribution


def band(v: float, band_pct: float) -> tuple[float, float]:
    return v * (1 - band_pct), v * (1 + band_pct)


@dataclass
class VrState:
    shares: int
    pool: float
    v: float
    cycle_day: int = 0
    cycle_buy_spent: float = 0.0
    cycle_pool_budget: float = 0.0


@dataclass
class RebalanceResult:
    side: str
    shares: int
    price: float


@dataclass
class VrTrade:
    day: date
    side: str
    shares: int
    price: float


def rebalance_at_close(
    state: VrState,
    price: float,
    band_low: float,
    band_high: float,
) -> RebalanceResult | None:
    """One day's worth of band rebalancing, executed as a single batch trade
    at that day's close (see module docstring for why this isn't per-share)."""
    position_value = state.shares * price
    if position_value > band_high:
        target_shares = max(0, math.floor(band_high / price))
        sell_qty = state.shares - target_shares
        if sell_qty <= 0:
            return None
        state.shares -= sell_qty
        state.pool += sell_qty * price
        return RebalanceResult(side="SELL", shares=sell_qty, price=price)
    if position_value < band_low:
        target_shares = math.ceil(band_low / price)
        buy_qty = target_shares - state.shares
        if buy_qty <= 0:
            return None
        remaining_budget = state.cycle_pool_budget - state.cycle_buy_spent
        max_affordable = min(state.pool, remaining_budget) / price if price else 0
        buy_qty = min(buy_qty, math.floor(max_affordable))
        if buy_qty <= 0:
            return None
        cost = buy_qty * price
        state.shares += buy_qty
        state.pool -= cost
        state.cycle_buy_spent += cost
        return RebalanceResult(side="BUY", shares=buy_qty, price=price)
    return None


def run_backtest(
    bars: list[DailyBar],
    *,
    initial_cash: float = 10_000.0,
    g: float = 10.0,
    band_pct: float = 0.15,
    contribution: float = 20.0,
    cycle_days: int = CYCLE_TRADING_DAYS,
    pool_seed_pct: float = 0.10,
    pool_usage_cap_pct: float = 0.75,
) -> dict:
    if not bars:
        raise ValueError("No daily bars to backtest.")

    entry_price = bars[0].close
    seed_pool = initial_cash * pool_seed_pct
    invested = initial_cash - seed_pool
    shares = int(invested // entry_price)
    leftover_cash = invested - shares * entry_price

    state = VrState(
        shares=shares,
        pool=seed_pool + leftover_cash,
        v=shares * entry_price,
    )
    band_low, band_high = band(state.v, band_pct)
    state.cycle_pool_budget = state.pool * pool_usage_cap_pct

    trades: list[VrTrade] = []
    equity_curve: list[tuple[date, float]] = []
    cycles = 0

    for bar in bars:
        trade = rebalance_at_close(state, bar.close, band_low, band_high)
        if trade is not None:
            trades.append(VrTrade(day=bar.date, side=trade.side, shares=trade.shares, price=trade.price))

        state.cycle_day += 1
        if state.cycle_day >= cycle_days:
            state.pool += contribution
            state.v = next_v(state.v, state.pool, g, contribution)
            band_low, band_high = band(state.v, band_pct)
            state.cycle_day = 0
            state.cycle_buy_spent = 0.0
            state.cycle_pool_budget = state.pool * pool_usage_cap_pct
            cycles += 1

        equity_curve.append((bar.date, state.shares * bar.close + state.pool))

    final_equity = equity_curve[-1][1]
    peak = float("-inf")
    max_drawdown_pct = 0.0
    for _, value in equity_curve:
        peak = max(peak, value)
        if peak > 0:
            max_drawdown_pct = min(max_drawdown_pct, (value - peak) / peak * 100)

    years = (bars[-1].date - bars[0].date).days / 365.25
    cagr_pct = ((final_equity / initial_cash) ** (1 / years) - 1) * 100 if years > 0 else 0.0

    buy_hold_shares = initial_cash / entry_price
    buy_hold_final = buy_hold_shares * bars[-1].close

    return {
        "start": bars[0].date.isoformat(),
        "end": bars[-1].date.isoformat(),
        "bar_count": len(bars),
        "cycles": cycles,
        "initial_cash": initial_cash,
        "final_equity": final_equity,
        "total_return_pct": (final_equity / initial_cash - 1) * 100,
        "cagr_pct": cagr_pct,
        "max_drawdown_pct": max_drawdown_pct,
        "trade_count": len(trades),
        "buy_count": sum(1 for t in trades if t.side == "BUY"),
        "sell_count": sum(1 for t in trades if t.side == "SELL"),
        "final_shares": state.shares,
        "final_pool": state.pool,
        "final_v": state.v,
        "buy_hold_final": buy_hold_final,
        "buy_hold_return_pct": (buy_hold_final / initial_cash - 1) * 100,
    }


def common_start_date(bars_by_symbol: dict[str, list[DailyBar]]) -> date:
    return max(bars[0].date for bars in bars_by_symbol.values() if bars)


def main() -> None:
    parser = argparse.ArgumentParser(description="VR5.0 밴드 리밸런싱 백테스트 (일봉 기준)")
    parser.add_argument("symbols", nargs="*", default=["SOXL", "TQQQ", "KORU"])
    parser.add_argument("--pages", type=int, default=20)
    parser.add_argument("--cash", type=float, default=10_000.0)
    parser.add_argument("--g", type=float, default=10.0)
    parser.add_argument("--band", type=float, default=0.15)
    parser.add_argument("--contribution", type=float, default=20.0)
    args = parser.parse_args()

    broker = TossBroker()
    bars_by_symbol = {symbol: fetch_daily_bars(broker, symbol, max_pages=args.pages) for symbol in args.symbols}
    start = common_start_date(bars_by_symbol)
    print(f"공통 시작일: {start.isoformat()}")
    print()

    header = f"{'심볼':6} {'기간':23} {'봉수':>6} {'사이클':>6} {'최종평가액':>14} {'총수익%':>9} {'CAGR%':>8} {'MDD%':>8} {'매수/매도':>10}   {'단순보유수익%':>12}"
    print(header)
    print("-" * len(header))
    for symbol, bars in bars_by_symbol.items():
        trimmed = [bar for bar in bars if bar.date >= start]
        result = run_backtest(
            trimmed,
            initial_cash=args.cash,
            g=args.g,
            band_pct=args.band,
            contribution=args.contribution,
        )
        period = f"{result['start']}~{result['end']}"
        print(
            f"{symbol:6} {period:23} {result['bar_count']:>6} {result['cycles']:>6} "
            f"${result['final_equity']:>13,.0f} {result['total_return_pct']:>8.1f}% {result['cagr_pct']:>7.1f}% "
            f"{result['max_drawdown_pct']:>7.1f}% {result['buy_count']:>4}/{result['sell_count']:<4}   "
            f"{result['buy_hold_return_pct']:>11.1f}%"
        )


if __name__ == "__main__":
    main()
