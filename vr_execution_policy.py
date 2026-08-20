"""VR_SKILL Execution Policy: the "V 복귀" (return-to-V) band-edge policy.

Not specified by the book -- this is an explicit implementation choice
(confirmed with the operator), kept separate from vr_formula.py's V/E/Pool/G
math and vr_engine.py's biweekly cycle boundaries. Two conditional order
legs are planned per cycle, priced at the VALUE band's edges converted to a
per-share trigger price:

    lower_trigger_price = lower_band_value / current_qty
    upper_trigger_price = upper_band_value / current_qty

When a trigger fires, the planned quantity brings the position's value back
to exactly V (not to the band edge, and not the whole Pool/position):

    upper (sell):  target_qty = V / upper_trigger_price; sell = current - target
    lower (buy):   target_qty = V / lower_trigger_price; buy  = target - current

Because filling one leg changes position_qty and/or Pool, it invalidates the
other, still-open leg (which was sized against stale state). rearm_after_fill
implements the intra-cycle "re-arm" loop that fires after every VR fill:
cancel the stale remaining leg, confirm the cancellation, recompute both legs
from the fresh position/Pool, and register new conditional orders. V, G, and
band_pct are never recalculated here -- those stay fixed for the whole
2-week cycle; only the trigger price (which depends on current_qty) and the
planned quantities change intra-cycle.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import ROUND_FLOOR, Decimal

from mumae_core import money
from toss_api import TossApiError
from vr_conditional_orders import (
    ConditionalOrderRequest,
    build_client_order_id,
    cancel_conditional_order,
    create_conditional_order,
)
from vr_state_store import VRConditionalOrder, VRCycle


class CancellationNotConfirmedError(RuntimeError):
    """Raised when a remaining VR conditional order's cancellation cannot be
    confirmed. Per spec, rearm must never register new orders on top of a
    still-open stale order, so callers should treat this the same as a
    blocked cycle transition and leave existing state untouched."""


@dataclass(frozen=True)
class PlannedLeg:
    side: str  # "buy" | "sell"
    trigger_price: Decimal
    quantity: int


def round_target_qty(V: Decimal, trigger_price: Decimal) -> int:
    """The integer share count whose value (qty * trigger_price) lands
    closest to V. Ties prefer the smaller quantity (the more conservative,
    less-committed choice)."""
    if trigger_price <= 0:
        raise ValueError("Trigger price must be positive.")
    exact = V / trigger_price
    floor_qty = int(exact.to_integral_value(rounding=ROUND_FLOOR))
    candidates = [q for q in (floor_qty, floor_qty + 1) if q >= 0]

    def distance(q: int) -> Decimal:
        return abs(Decimal(q) * trigger_price - V)

    return min(candidates, key=lambda q: (distance(q), q))


def trigger_prices(cycle: VRCycle, current_qty: int) -> tuple[Decimal, Decimal]:
    """(lower_trigger_price, upper_trigger_price) = the cycle's fixed VALUE
    band converted to a per-share price at the current holding size, rounded
    to the cent via mumae_core.money (the same normalization used for
    regular MUMAE order prices)."""
    if current_qty <= 0:
        raise ValueError("Trigger prices require a positive current quantity.")
    lower = money(cycle.lower_band / Decimal(current_qty))
    upper = money(cycle.upper_band / Decimal(current_qty))
    return lower, upper


def plan_rebalance_legs(
    V: Decimal,
    current_qty: int,
    lower_trigger: Decimal,
    upper_trigger: Decimal,
    vr_pool: Decimal,
    available_buying_power: Decimal,
    available_sell_qty: int,
) -> tuple[PlannedLeg | None, PlannedLeg | None]:
    """Plan the (buy_leg, sell_leg) that return the position's value to V if
    either trigger fires. A leg is omitted (None) once its quantity would be
    <= 0, rather than emitting a zero-quantity order."""
    sell_target = round_target_qty(V, upper_trigger)
    sell_qty = min(max(0, current_qty - sell_target), max(0, available_sell_qty))
    sell_leg = PlannedLeg("sell", upper_trigger, sell_qty) if sell_qty > 0 else None

    buy_target = round_target_qty(V, lower_trigger)
    buy_qty_needed = max(0, buy_target - current_qty)
    pool_affordable = int((vr_pool / lower_trigger).to_integral_value(rounding=ROUND_FLOOR))
    power_affordable = int((available_buying_power / lower_trigger).to_integral_value(rounding=ROUND_FLOOR))
    buy_qty = min(buy_qty_needed, max(0, pool_affordable), max(0, power_affordable))
    buy_leg = PlannedLeg("buy", lower_trigger, buy_qty) if buy_qty > 0 else None

    return buy_leg, sell_leg


def cancel_and_confirm(broker, conditional_order_id: str) -> None:
    """The real DELETE /api/v1/conditional-orders/{id} returns 204 No
    Content on success (no status field to inspect) and raises TossApiError
    (via TossBroker._request) on failure -- so "the call returned without
    raising" is the confirmation signal. DRY_RUN's synthetic {"status":
    "DRY_RUN", ...} response never reaches the broker at all (matches
    TossBroker.cancel_order's own gate) and is likewise treated as confirmed.

    A 404 ("조건주문 없음") is treated as confirmed too, not failed: it means
    the order is already gone -- exactly the outcome being confirmed. This
    matters for crash recovery (spec 13-4): if the process crashes after
    cancelling some orders but before persisting that fact, a retry re-issues
    DELETE for orders already cancelled at Toss; those must not be mistaken
    for a failed cancellation and block the transition."""
    try:
        cancel_conditional_order(broker, conditional_order_id)
    except TossApiError as error:
        if error.status == 404:
            return
        raise CancellationNotConfirmedError(
            f"Conditional order {conditional_order_id} cancellation failed: {error}"
        ) from error


def rearm_after_fill(
    broker,
    cycle: VRCycle,
    symbol: str,
    updated_qty: int,
    updated_pool: Decimal,
    available_buying_power: Decimal,
    available_sell_qty: int,
    remaining_conditional_order_ids: list[str],
) -> tuple[VRCycle, list[VRConditionalOrder]]:
    """Steps 4-7 of the intra-cycle rearm procedure (module docstring):
    cancel the other, now-stale VR conditional order(s), confirm the
    cancellation, recompute both legs from the fresh position/Pool, and
    register new conditional orders. Raises CancellationNotConfirmedError
    (without registering anything new) if any cancellation cannot be
    confirmed. V/G/band_pct are never touched; only pool_current -- already
    updated by the caller from the fill via apply_fill_to_pool -- carries
    into the returned cycle.
    """
    for conditional_order_id in remaining_conditional_order_ids:
        cancel_and_confirm(broker, conditional_order_id)

    lower_trigger, upper_trigger = trigger_prices(cycle, updated_qty)
    buy_leg, sell_leg = plan_rebalance_legs(
        cycle.V, updated_qty, lower_trigger, upper_trigger,
        updated_pool, available_buying_power, available_sell_qty,
    )

    new_orders: list[VRConditionalOrder] = []
    for sequence, leg in enumerate((leg for leg in (buy_leg, sell_leg) if leg is not None), start=1):
        client_order_id = build_client_order_id(symbol, cycle.cycle_id, leg.side, sequence)
        request = ConditionalOrderRequest(
            symbol=symbol, side=leg.side, trigger_price=leg.trigger_price,
            order_price=leg.trigger_price, quantity=leg.quantity,
            expire_date=cycle.end_session, client_order_id=client_order_id,
        )
        response = create_conditional_order(broker, request)
        result = response.get("result", {})
        new_orders.append(VRConditionalOrder(
            symbol=symbol, cycle_id=cycle.cycle_id,
            conditional_order_id=result.get("conditionalOrderId"),
            client_order_id=client_order_id, side=leg.side,
            trigger_price=leg.trigger_price, order_price=leg.trigger_price,
            quantity=leg.quantity, expire_date=cycle.end_session, status="OPEN",
        ))

    new_cycle = replace(cycle, pool_current=updated_pool)
    return new_cycle, new_orders
