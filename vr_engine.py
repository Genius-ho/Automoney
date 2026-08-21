"""VR_SKILL cycle engine.

Phase 3 scope: initialization only -- turning a symbol's current Toss
holdings into VR_SKILL's V1 and starting Pool. Cycle transition / market
calendar / conditional-order logic land in later phases (see
vr_formula.py's module docstring for the formula this builds on).
"""
from __future__ import annotations

from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import vr_execution_policy
from mumae_core import money
from vr_execution_policy import (
    BrokerCapacityExceededError,
    BrokerCapacityUnknownError,
    CancellationNotConfirmedError,
    SellReservationUnknownError,
    cancel_and_confirm,
    plan_buy_ladder,
    plan_sell_ladder,
    register_ladder_orders,
)
from vr_formula import band, next_v
from vr_state_store import VRConditionalOrder, VRCycle, VRPendingConfig, VRState


def initial_v(position_qty: int, current_price: Decimal) -> Decimal:
    """V1 = current holding quantity x current market price.

    Deliberately takes no avg_cost parameter: average cost is P&L display
    information only and must never influence V1, per spec.
    """
    if position_qty < 0:
        raise ValueError("Position quantity cannot be negative.")
    if current_price <= 0:
        raise ValueError("Current price must be positive.")
    return money(Decimal(position_qty) * current_price)


def initialize_cycle(
    symbol: str,
    position_qty: int,
    current_price: Decimal,
    initial_pool: Decimal,
    G: Decimal,
    band_pct: Decimal,
    cycle_id: str,
    start_session: str,
    end_session: str,
    now: datetime | None = None,
    anchor_friday: str | None = None,
) -> VRState:
    """Build the VRState for a symbol's first VR_SKILL cycle.

    The symbol's entire current holding becomes its VR position; partial VR
    enrollment is out of scope for this version, per spec. anchor_friday
    defaults to start_session for callers (e.g. existing tests) that don't
    care about real biweekly scheduling; live callers pass the real
    anchor_friday_on_or_after(start_date) result.
    """
    if initial_pool < 0:
        raise ValueError("Initial pool cannot be negative.")
    V1 = initial_v(position_qty, current_price)
    lower, upper = band(V1, band_pct)
    now = now or datetime.now(timezone.utc)
    cycle = VRCycle(
        cycle_id=cycle_id,
        start_session=start_session,
        end_session=end_session,
        V=V1,
        G=G,
        band_pct=band_pct,
        pool_start=initial_pool,
        pool_current=initial_pool,
        lower_band=lower,
        upper_band=upper,
        E_at_close=None,
    )
    return VRState(
        symbol=symbol,
        strategy_type="VR_SKILL",
        status="ACTIVE",
        initialized_at=now.isoformat(),
        current_cycle=cycle,
        anchor_friday=anchor_friday or start_session,
        cycle_number=1,
    )


def apply_fill_to_pool(cycle: VRCycle, side: str, amount: Decimal) -> VRCycle:
    """Update a single symbol's VR Pool ledger from one VR fill.

    Buys decrease pool_current, sells increase it. Returns a new VRCycle
    (the input is not mutated) so callers can never accidentally leak a pool
    change into another symbol's cycle object. Pool is never allowed to go
    negative -- a buy fill larger than the remaining pool indicates a bug
    upstream (the execution policy should never plan such an order) and is
    rejected rather than silently clamped.
    """
    if amount <= 0:
        raise ValueError("Fill amount must be positive.")
    if side == "buy":
        new_pool = cycle.pool_current - amount
        if new_pool < 0:
            raise ValueError("Buy fill would drive VR Pool negative.")
    elif side == "sell":
        new_pool = cycle.pool_current + amount
    else:
        raise ValueError("side must be buy or sell")
    return replace(cycle, pool_current=new_pool)


def schedule_config(
    state: VRState,
    G: Decimal | None = None,
    band_pct: Decimal | None = None,
    pool_adjustment: Decimal | None = None,
) -> VRState:
    """Schedule G/Band/Pool changes for the NEXT cycle only.

    Never touches state.current_cycle -- the running cycle's orders, V, and
    Band are completely unaffected. Only fields explicitly passed here are
    written into pending_config; omitted fields keep whatever was already
    pending (so G, Band, and Pool can each be scheduled independently,
    at different times, without clobbering each other).
    """
    if G is not None and G <= 0:
        raise ValueError("G must be positive.")
    if band_pct is not None and band_pct <= 0:
        raise ValueError("Band percentage must be positive.")
    pending = replace(
        state.pending_config,
        G=G if G is not None else state.pending_config.G,
        band_pct=band_pct if band_pct is not None else state.pending_config.band_pct,
        pool_adjustment=pool_adjustment if pool_adjustment is not None else state.pending_config.pool_adjustment,
    )
    return replace(state, pending_config=pending)


def cancel_pending_config(
    state: VRState,
    *,
    G: bool = False,
    band_pct: bool = False,
    pool_adjustment: bool = False,
    all: bool = False,
) -> VRState:
    """Cancel some or all pending config fields, reverting to 'no change
    scheduled for the next cycle'. The current cycle was never affected by
    the pending values in the first place, so cancelling is a pure no-op on
    it."""
    if all:
        return replace(state, pending_config=VRPendingConfig())
    pending = state.pending_config
    return replace(state, pending_config=VRPendingConfig(
        G=None if G else pending.G,
        band_pct=None if band_pct else pending.band_pct,
        pool_adjustment=None if pool_adjustment else pending.pool_adjustment,
    ))


def promote_pending_config(state: VRState) -> tuple[Decimal, Decimal, Decimal]:
    """Resolve the G/band_pct/pool_adjustment to use for the NEXT cycle.

    Pending values win when set; otherwise the current cycle's values carry
    forward unchanged (so G/Band stay identical cycle after cycle until the
    user explicitly changes them). pool_adjustment is 0 when nothing is
    pending. This only *computes* the resolved values -- it does not mutate
    state or clear pending_config; the cycle-transition state machine (later
    phase) is responsible for creating the new cycle and clearing
    pending_config only once that succeeds.
    """
    current = state.current_cycle
    pending = state.pending_config
    new_g = pending.G if pending.G is not None else current.G
    new_band_pct = pending.band_pct if pending.band_pct is not None else current.band_pct
    pool_adjustment = pending.pool_adjustment if pending.pool_adjustment is not None else Decimal("0")
    return new_g, new_band_pct, pool_adjustment


def apply_pool_adjustment(pool_current: Decimal, adjustment: Decimal) -> Decimal:
    """Apply a +deposit/-withdrawal pending_pool_adjustment to a Pool.

    Rejects any adjustment that would drive the Pool negative, per spec.
    """
    new_pool = pool_current + adjustment
    if new_pool < 0:
        raise ValueError("Pool adjustment would drive VR Pool negative.")
    return new_pool


# --- Biweekly US market cycle boundaries -----------------------------------
#
# The cycle cadence is anchored to a fixed Friday chosen at VR initialization
# (anchor_friday_on_or_after) and then recurs every 14 days from that anchor
# (scheduled_cycle_end_friday) -- so a holiday adjustment in one cycle never
# drifts the schedule of later cycles. The *actual* trading day and session
# close used for E/transition timing always come from the live Toss market
# calendar (find_last_trading_day_on_or_before / is_cycle_due_for_transition),
# never a hardcoded KST/ET clock time, so early closes and DST are handled
# correctly by construction.

_FRIDAY = 4  # date.weekday(): Monday=0 .. Sunday=6
_MAX_HOLIDAY_LOOKBACK_DAYS = 10


def anchor_friday_on_or_after(start_date: date) -> date:
    """The first Friday on or after start_date, used as cycle 1's anchor."""
    return start_date + timedelta(days=(_FRIDAY - start_date.weekday()) % 7)


def scheduled_cycle_end_friday(anchor_friday: date, cycle_number: int) -> date:
    """The Friday a given (1-indexed) cycle is scheduled to end on.

    cycle_number=1 ends on anchor_friday itself; cycle_number=2 on
    anchor_friday+14, etc. Always a fixed multiple of 14 days from the
    anchor, regardless of any holiday adjustment applied to earlier cycles.
    """
    if cycle_number < 1:
        raise ValueError("cycle_number must be >= 1.")
    return anchor_friday + timedelta(days=14 * (cycle_number - 1))


def find_last_trading_day_on_or_before(broker, target_date: date) -> tuple[date, dict]:
    """Walk backwards from target_date until the Toss US market calendar
    reports an actual regular-market session, per spec: '금요일이 미국
    휴장일이면 그 주의 마지막 정규 거래일을 사이클 종료 거래일로 사용'.

    Returns (trading_date, regularMarket session dict with startTime/endTime).
    """
    for offset in range(_MAX_HOLIDAY_LOOKBACK_DAYS):
        candidate = target_date - timedelta(days=offset)
        result = broker.get_us_market_calendar_raw(candidate.isoformat())
        today = (result or {}).get("result", {}).get("today", {}) or {}
        regular = today.get("regularMarket")
        if regular and regular.get("startTime") and regular.get("endTime"):
            resolved_raw = today.get("date")
            resolved = date.fromisoformat(resolved_raw) if resolved_raw else candidate
            return resolved, regular
    raise ValueError(f"No US trading day found within {_MAX_HOLIDAY_LOOKBACK_DAYS} days before {target_date.isoformat()}.")


def is_cycle_due_for_transition(broker, end_session: date, now: datetime | None = None) -> bool:
    """True once end_session's actual regular-market close, as reported by
    the live Toss market calendar for that specific date, has passed.

    Reads startTime/endTime directly from the API response (each carries its
    own UTC offset), so early closes and DST changes are handled correctly
    without any hardcoded KST/ET clock time.
    """
    now = now or datetime.now(timezone.utc)
    result = broker.get_us_market_calendar_raw(end_session.isoformat())
    today = (result or {}).get("result", {}).get("today", {}) or {}
    regular = today.get("regularMarket") or {}
    end_time = regular.get("endTime")
    if not end_time:
        return False
    close = datetime.fromisoformat(end_time).astimezone(timezone.utc)
    return now >= close


# --- Biweekly cycle transition state machine --------------------------------
#
# Implements spec section 6's 21-step procedure. Split into two functions
# matching the two halves of that procedure:
#
#   cancel_cycle_orders  -- steps 1-5: cancel every OPEN VR conditional order
#                           for the ending cycle and confirm none remain
#                           open/unknown. (Regular-order resync, step 1/4, is
#                           existing MUMAE order-sync machinery and is the
#                           caller's responsibility -- Phase 9 wiring --
#                           summarized here as still_open_after_sync.)
#   transition_cycle     -- steps 6-22: E, pending-config promotion, V_next,
#                           new band, history snapshot, new cycle, new
#                           conditional orders. Callers must only call this
#                           after cancel_cycle_orders returns without raising.
#
# Both raise CycleTransitionBlocked rather than silently proceeding, per
# spec: "새 사이클의 신규 주문을 절대 넣지 않는다... 다른 종목의 전략은 계속
# 운용되어야 한다" -- callers (the auto_tick wiring) are expected to catch
# this per symbol, persist status="CYCLE_TRANSITION_BLOCKED" with the
# reason, and continue processing every other symbol independently.


class CycleTransitionBlocked(RuntimeError):
    """A step of the cycle-transition procedure could not be completed
    safely. The caller must not place any new-cycle order and must leave
    this symbol's existing state untouched other than recording the block."""


def cancel_cycle_orders(broker, conditional_order_ids: list[str], still_open_after_sync: bool) -> None:
    """Steps 1-5: cancel every OPEN VR conditional order for the ending
    cycle and confirm none remain open/unknown."""
    if still_open_after_sync:
        raise CycleTransitionBlocked(
            "One or more VR orders for this cycle are still OPEN/UNKNOWN after resync."
        )
    for conditional_order_id in conditional_order_ids:
        try:
            cancel_and_confirm(broker, conditional_order_id)
        except CancellationNotConfirmedError as error:
            raise CycleTransitionBlocked(str(error)) from error


def arm_cycle_orders(
    broker,
    cycle: VRCycle,
    symbol: str,
    current_qty: int,
    available_buying_power: Decimal,
    available_sell_qty: int,
) -> tuple[list[VRConditionalOrder], Decimal]:
    """Plan (book Ladder execution policy) and register a cycle's full BUY/
    SELL order table. Shared by transition_cycle (Cycle N+1) and
    vr_initialize (Cycle 1) so both go through the identical planning +
    registration path. current_qty is Q0 -- the position size at the moment
    this cycle's ladder is armed, fixed for the ladder's entire 2-week life
    (no per-fill recompute; see vr_execution_policy's module docstring).

    Returns (orders, planned_buy_spend) -- the latter is the ladder's
    projected total BUY cost if every armed rung eventually fills, for the
    "Projected Pool" display (cycle.pool_current instead tracks Pool from
    real fills only).

    The full logical Book Ladder is always computed in full (never
    truncated) and only compressed into at most
    vr_execution_policy.MAX_BROKER_ORDERS_PER_SIDE broker orders per side
    afterward (vr_execution_policy.compress_ladder) -- so the required
    broker capacity is always <= 2 * MAX_BROKER_ORDERS_PER_SIDE regardless
    of position size. Refuses to register anything on a LIVE broker if that
    compressed leg count exceeds
    vr_execution_policy.VERIFIED_CAPACITY.verified_max (raises
    BrokerCapacityUnknownError/BrokerCapacityExceededError), or if there's
    a nonzero SELL leg count and
    vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR is still
    UNKNOWN (raises SellReservationUnknownError) -- see that module's
    docstring for both gates."""
    buy_legs, planned_buy_spend, logical_buy_count = plan_buy_ladder(
        cycle.lower_band, current_qty, cycle.pool_current,
        available_buying_power=available_buying_power,
    )
    sell_legs, logical_sell_count = plan_sell_ladder(cycle.upper_band, current_qty, available_sell_qty)

    broker_buy_count = len(buy_legs)
    broker_sell_count = len(sell_legs)
    total_broker_legs = broker_buy_count + broker_sell_count
    is_live = getattr(broker, "mode", None) == "LIVE"
    if total_broker_legs > 0 and is_live:
        verified_max = vr_execution_policy.VERIFIED_CAPACITY.verified_max
        if verified_max is None:
            raise BrokerCapacityUnknownError(
                f"{symbol}: requires {total_broker_legs} broker conditional orders "
                f"({broker_buy_count} buy + {broker_sell_count} sell; logical ladder is "
                f"{logical_buy_count} buy + {logical_sell_count} sell), but Toss's real open-conditional-order "
                "capacity has not been empirically verified (VERIFIED_CAPACITY.verified_max is None). "
                "Refusing to arm on a LIVE broker.",
                buy_count=broker_buy_count, sell_count=broker_sell_count, verified_capacity=None,
                logical_buy_count=logical_buy_count, logical_sell_count=logical_sell_count,
            )
        if total_broker_legs > verified_max:
            raise BrokerCapacityExceededError(
                f"{symbol}: requires {total_broker_legs} broker conditional orders "
                f"({broker_buy_count} buy + {broker_sell_count} sell; logical ladder is "
                f"{logical_buy_count} buy + {logical_sell_count} sell), which exceeds the verified capacity of "
                f"{verified_max}. Refusing to truncate -- raise VERIFIED_CAPACITY.verified_max after "
                "re-confirming it, or shrink the ladder.",
                buy_count=broker_buy_count, sell_count=broker_sell_count, verified_capacity=verified_max,
                logical_buy_count=logical_buy_count, logical_sell_count=logical_sell_count,
            )
    if broker_sell_count > 0 and is_live:
        if vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR == vr_execution_policy.SELL_RESERVATION_UNKNOWN:
            raise SellReservationUnknownError(
                f"{symbol}: requires {broker_sell_count} broker sell conditional orders, but Toss's SELL-side "
                "sellable-quantity reservation behavior has not been confirmed "
                "(CONDITIONAL_SELL_RESERVATION_BEHAVIOR is UNKNOWN). Refusing to arm on a LIVE broker.",
                sell_count=broker_sell_count,
            )

    new_orders = register_ladder_orders(broker, cycle, symbol, buy_legs, starting_sequence=1)
    new_orders += register_ladder_orders(broker, cycle, symbol, sell_legs, starting_sequence=1)
    return new_orders, planned_buy_spend


def transition_cycle(
    broker,
    state: VRState,
    symbol: str,
    final_qty: int,
    close_price: Decimal | None,
    next_cycle_id: str,
    next_start_session: date,
    next_end_session: date,
    available_buying_power: Decimal,
    available_sell_qty: int,
) -> tuple[VRState, list[VRConditionalOrder]]:
    """Steps 6-22: compute E, promote pending config, compute V_next/band,
    snapshot the closed cycle into history, create Cycle N+1, and register
    its initial conditional orders. Assumes cancel_cycle_orders has already
    succeeded for this symbol.
    """
    current = state.current_cycle
    if current is None:
        raise CycleTransitionBlocked(f"{symbol}: no active VR cycle to transition.")
    if close_price is None or close_price <= 0:
        raise CycleTransitionBlocked(
            f"{symbol}: could not obtain a confirmed regular-session close price for E."
        )

    # Step 6/9: E = final confirmed holdings x confirmed regular close.
    E = money(Decimal(final_qty) * close_price)

    # Steps 10-13: promote pending config (computed, not yet applied).
    new_g, new_band_pct, pool_adjustment = promote_pending_config(state)

    # Step 7/13: reconcile + apply the pending pool adjustment, if any.
    reconciled_pool = apply_pool_adjustment(current.pool_current, pool_adjustment)

    # Step 14: V_next via the skill formula -- the new G takes effect here.
    breakdown = next_v(current.V, E, reconciled_pool, new_g)

    # Step 15: new band from the new V/band_pct.
    lower, upper = band(breakdown.new_V, new_band_pct)

    # Step 16: persist the closed cycle's snapshot into history.
    closed_snapshot = {
        "cycle_id": current.cycle_id,
        "start_session": current.start_session,
        "end_session": current.end_session,
        "V": str(current.V),
        "E_at_close": str(E),
        "G": str(current.G),
        "band_pct": str(current.band_pct),
        "pool_start": str(current.pool_start),
        "pool_end": str(reconciled_pool),
        "new_V": str(breakdown.new_V),
        "pool_term": str(breakdown.pool_term),
        "market_adjustment_term": str(breakdown.market_adjustment_term),
    }

    # Step 17: create Cycle N+1.
    new_cycle = VRCycle(
        cycle_id=next_cycle_id,
        start_session=next_start_session.isoformat(),
        end_session=next_end_session.isoformat(),
        V=breakdown.new_V, G=new_g, band_pct=new_band_pct,
        pool_start=reconciled_pool, pool_current=reconciled_pool,
        lower_band=lower, upper_band=upper, E_at_close=None,
    )

    # Steps 18-21: plan, validate, and register the new cycle's full BUY/
    # SELL ladder (book Ladder execution policy -- see
    # vr_execution_policy.py). Shared with vr_initialize's first cycle via
    # arm_cycle_orders so the two never drift apart.
    new_orders, planned_buy_spend = arm_cycle_orders(
        broker, new_cycle, symbol, final_qty, available_buying_power, available_sell_qty,
    )
    new_cycle = replace(new_cycle, planned_buy_spend=planned_buy_spend)

    # Step 22: Cycle N+1 ACTIVE.
    new_state = replace(
        state,
        status="ACTIVE",
        blocked_reason=None,
        capacity_blocker=None,
        sell_reservation_blocker=None,
        current_cycle=new_cycle,
        pending_config=VRPendingConfig(),
        conditional_orders=new_orders,
        history=[*state.history, closed_snapshot],
        cycle_number=state.cycle_number + 1,
    )
    return new_state, new_orders
