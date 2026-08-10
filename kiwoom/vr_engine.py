"""VR5.0 band-rebalancing decision logic, adapted for live/CLI use.

Same formulas as backtest_vr.py (reverse-engineered from a live Fire Gate
VR calculator screenshot and confirmed against its order ladder):

    V2 = V1 + Pool/G + contribution
    band = V * (1 - band_pct) .. V * (1 + band_pct)
    sell target shares @ price = floor(V_high / price)
    buy target shares @ price  = ceil(V_low / price)

Differences from the backtest module: this evaluates a single live price
at a time (not a stream of daily closes) and rolls cycles on elapsed
*calendar* days rather than trading days -- a live engine doesn't need a
market-calendar dependency just to decide "has ~2 weeks passed", so this
is a deliberate simplification versus backtest_vr.py's 10-trading-day
cycle length. Pass an equivalent cycle_length_days (default 14) to match.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

from kiwoom.vr_state import Trade, VrRuntimeState


def next_v(v: float, pool: float, g: float, contribution: float) -> float:
    return v + pool / g + contribution


def band(v: float, band_pct: float) -> tuple[float, float]:
    return v * (1 - band_pct), v * (1 + band_pct)


def initialize_state(
    profile: str,
    symbol: str,
    current_price: float,
    initial_cash: float,
    *,
    g: float = 10.0,
    band_pct: float = 0.15,
    contribution: float = 20.0,
    cycle_length_days: int = 14,
    pool_seed_pct: float = 0.10,
    pool_usage_cap_pct: float = 0.75,
    today: date | None = None,
) -> VrRuntimeState:
    seed_pool = initial_cash * pool_seed_pct
    invested = initial_cash - seed_pool
    shares = int(invested // current_price)
    leftover_cash = invested - shares * current_price
    pool = seed_pool + leftover_cash
    state = VrRuntimeState(
        profile=profile,
        symbol=symbol.upper(),
        shares=shares,
        pool=pool,
        v=shares * current_price,
        g=g,
        band_pct=band_pct,
        contribution=contribution,
        cycle_length_days=cycle_length_days,
        pool_usage_cap_pct=pool_usage_cap_pct,
        cycle_start_date=(today or date.today()).isoformat(),
    )
    state.cycle_pool_budget = state.pool * pool_usage_cap_pct
    return state


@dataclass
class RebalancePlan:
    side: str  # "BUY" or "SELL"
    shares: int
    price: float
    resulting_shares: int
    resulting_pool: float


def plan_rebalance(state: VrRuntimeState, current_price: float) -> RebalancePlan | None:
    """Pure decision function: does today's price call for a trade, and how
    big? Does not mutate state -- see apply_trade() for that."""
    band_low, band_high = band(state.v, state.band_pct)
    position_value = state.shares * current_price

    if position_value > band_high:
        target_shares = max(0, math.floor(band_high / current_price))
        sell_qty = state.shares - target_shares
        if sell_qty <= 0:
            return None
        return RebalancePlan(
            side="SELL",
            shares=sell_qty,
            price=current_price,
            resulting_shares=state.shares - sell_qty,
            resulting_pool=state.pool + sell_qty * current_price,
        )

    if position_value < band_low:
        target_shares = math.ceil(band_low / current_price)
        buy_qty = target_shares - state.shares
        if buy_qty <= 0:
            return None
        remaining_budget = state.cycle_pool_budget - state.cycle_buy_spent
        max_affordable = min(state.pool, remaining_budget) / current_price if current_price else 0
        buy_qty = min(buy_qty, math.floor(max_affordable))
        if buy_qty <= 0:
            return None
        return RebalancePlan(
            side="BUY",
            shares=buy_qty,
            price=current_price,
            resulting_shares=state.shares + buy_qty,
            resulting_pool=state.pool - buy_qty * current_price,
        )

    return None


def apply_trade(state: VrRuntimeState, plan: RebalancePlan, trade_date: date) -> None:
    """Mutate state to reflect a trade that has actually been executed at
    the broker. Call this only after KiwoomBroker confirms the fill."""
    if plan.side == "SELL":
        state.shares -= plan.shares
        state.pool += plan.shares * plan.price
    else:
        state.shares += plan.shares
        state.pool -= plan.shares * plan.price
        state.cycle_buy_spent += plan.shares * plan.price
    state.trades.append(Trade(
        day=trade_date.isoformat(),
        side=plan.side,
        shares=plan.shares,
        price=str(plan.price),
    ))


def maybe_roll_cycle(state: VrRuntimeState, today: date) -> bool:
    """Advance to the next cycle (grow V, refresh the Pool budget) once
    cycle_length_days have elapsed. Returns True if it rolled."""
    elapsed = (today - state.cycle_start()).days
    if elapsed < state.cycle_length_days:
        return False
    state.pool += state.contribution
    state.v = next_v(state.v, state.pool, state.g, state.contribution)
    state.cycle_start_date = today.isoformat()
    state.cycle_buy_spent = 0.0
    state.cycle_pool_budget = state.pool * state.pool_usage_cap_pct
    state.cycles_completed += 1
    return True
