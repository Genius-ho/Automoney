"""VR_SKILL Execution Policy: the book's Ladder Execution Policy.

Not specified by vr_formula.py's V/E/Pool/G math -- this module turns a
cycle's fixed V/band into the actual per-share conditional orders the book
describes. At cycle start (vr_engine.initialize_cycle / transition_cycle),
the FULL 2-week BUY/SELL order table is computed once from the position
size at that moment (Q0) and registered as independent 1-share conditional
orders. Filling one rung never cancels or recomputes any other rung -- the
initial ladder stays fixed for the whole cycle; there is no per-fill rearm
(replaces the earlier "V 복귀" band-edge-with-rearm policy this module used
to implement).

BUY ladder (book formula):
    buy_price[n] = lower_band / (Q0 + n - 1),  n = 1, 2, 3, ...
each for exactly 1 share, continuing until the cumulative spend lands
closest to cycle_start_pool * pool_usage_limit_pct (book: "약 75%"), never
exceeding cycle_start_pool itself. Ties prefer the smaller cumulative spend
(leaves more Pool unspent) -- see select_buy_ladder_length.

SELL ladder (book formula):
    sell_price[n] = upper_band / (Q0 - n + 1),  n = 1, 2, 3, ...
each for exactly 1 share. The book states no Pool-based limit on the sell
side; the only hard bound is the position itself (n cannot exceed Q0), plus
however many shares are actually sellable right now.

Prices are rounded to the cent (ROUND_HALF_UP, via mumae_core.money) at
each rung, matching the book's own tables.

Toss's official API does not document a maximum number of open conditional
orders per account/symbol (checked against the live OpenAPI spec). Arming a
ladder on a LIVE broker is refused (BrokerCapacityUnknownError) unless
VERIFIED_MAX_LIVE_CONDITIONAL_ORDERS has been explicitly set to a real,
deliberately-tested number -- never guessed, never silently truncated.
DRY_RUN/fake brokers are unaffected (no real order is ever placed there),
so the full logical ladder can still be planned and tested.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from mumae_core import money
from toss_api import TossApiError
from vr_conditional_orders import (
    ConditionalOrderRequest,
    build_client_order_id,
    cancel_conditional_order,
    create_conditional_order,
)
from vr_state_store import VRConditionalOrder, VRCycle

DEFAULT_POOL_USAGE_LIMIT_PCT = Decimal("0.75")

# The book documents exactly three target-spend fractions by investment mode
# (적립식/accumulation=0.75, 거치식/lump-sum=0.50, 인출식/withdrawal=0.25) --
# same formula throughout, only this target differs. The engine layer
# (vr_engine.initialize_cycle/schedule_config) fails closed on anything
# outside this set rather than accepting an arbitrary user-typed fraction.
ALLOWED_POOL_USAGE_LIMIT_PCTS = (Decimal("0.75"), Decimal("0.50"), Decimal("0.25"))

CAPACITY_SCOPE_ACCOUNT = "ACCOUNT"
CAPACITY_SCOPE_SYMBOL = "SYMBOL"
CAPACITY_SCOPE_UNKNOWN = "UNKNOWN"


@dataclass
class ConditionalOrderCapacity:
    """Structured record of what's actually been confirmed about Toss's
    real open-conditional-order capacity, with provenance -- so a future
    answer (an official support reply, or a deliberate incremental live
    test per the Phase 15 plan) can be recorded honestly instead of just
    overwriting a bare int with no trail. verified_max stays None until a
    real, dated, sourced answer exists; never guessed.

    scope: CAPACITY_SCOPE_ACCOUNT if the confirmed number is a total across
    the whole account, CAPACITY_SCOPE_SYMBOL if it's per-symbol, UNKNOWN
    while unconfirmed (the scope itself may not even be known yet)."""

    verified_max: int | None = None
    scope: str = CAPACITY_SCOPE_UNKNOWN
    verified_at: str | None = None  # ISO date the number was confirmed
    source: str | None = None  # e.g. "Toss 개발자지원팀 문의 회신 (2026-09-01)"
    notes: str | None = None


# Empirically verified live (2026-08-22, TQQQ, real account): 140 BUY-only
# conditional orders simultaneously OPEN with no failures, then (separately)
# 100 BUY + 100 SELL = 200 combined simultaneously OPEN with no failures --
# all WATCHING, no triggeredOrderId, cleanly cancellable. See
# smoke_capacity_test.py and smoke_artifacts/TQQQ-capacity-*.json for the
# raw (redacted) exchange. This is a conservative *supported* count, not a
# claimed true maximum (201+ was never attempted) -- see notes. Tested on
# TQQQ only, one symbol at a time; cross-symbol account-wide interaction
# (e.g. TQQQ+SOXL+KORU armed simultaneously) was NOT tested, which matters
# if the real limit turns out to be account-wide rather than per-symbol.
VERIFIED_CAPACITY = ConditionalOrderCapacity(
    verified_max=200,
    scope=CAPACITY_SCOPE_UNKNOWN,
    verified_at="2026-08-22",
    source="Live capacity smoke test (smoke_capacity_test.py), TQQQ, real account",
    notes=(
        "200 = a verified-supported count, not a confirmed true ceiling (untested past 200). "
        "Scope left UNKNOWN, not SYMBOL: only ever tested one symbol (TQQQ) at a time, so "
        "whether this budget is shared account-wide across TQQQ/SOXL/KORU running VR "
        "simultaneously is unconfirmed -- arm_cycle_orders currently checks each symbol's own "
        "total_broker_legs against this value independently, which could understate real "
        "account-wide usage if the true limit is in fact account-scoped."
    ),
)

SELL_RESERVATION_UNKNOWN = "UNKNOWN"
SELL_RESERVATION_RESERVES_QUANTITY = "RESERVES_QUANTITY"
SELL_RESERVATION_DOES_NOT_RESERVE_UNTIL_TRIGGER = "DOES_NOT_RESERVE_UNTIL_TRIGGER"
SELL_RESERVATION_OTHER = "OTHER"

# Whether registering multiple concurrent SELL conditional orders for the
# same symbol actually reserves/holds sellable quantity against double-
# selling (GET /api/v1/sellable-quantity), or only checks it at trigger
# time. Not documented in the official spec, not yet empirically tested.
# UNKNOWN blocks arming any ladder with a nonzero SELL leg count on a LIVE
# broker -- same fail-closed spirit as capacity, kept as a separate gate
# since it's a distinct, independently-confirmable fact about the broker.
CONDITIONAL_SELL_RESERVATION_BEHAVIOR: str = SELL_RESERVATION_UNKNOWN

# Pure runaway-loop guard for buy_ladder_prices' search -- not a business
# rule. Should never bind for realistic Pool/price ratios (the book's
# largest example, Pool=1044.70, needed 18 rungs).
_MAX_LADDER_SEARCH = 2000


class CancellationNotConfirmedError(RuntimeError):
    """Raised when a VR conditional order's cancellation cannot be
    confirmed. Callers must never register new orders on top of a
    still-open stale order, so this should be treated the same as a
    blocked cycle transition and leave existing state untouched."""


class BrokerCapacityBlockedError(RuntimeError):
    """Base for both broker-capacity blockers. buy_count/sell_count/
    total_count are the REQUIRED BROKER (post-compression) order counts --
    what capacity must actually satisfy -- since compression already caps
    each side at MAX_BROKER_ORDERS_PER_SIDE regardless of position size.
    logical_buy_count/logical_sell_count are the uncompressed Book Ladder
    counts, kept separately for display (UI: Logical vs Broker counts,
    verified capacity, blocker reason) rather than parsing a message
    string."""

    def __init__(
        self, message: str, *, buy_count: int, sell_count: int, verified_capacity: int | None,
        logical_buy_count: int = 0, logical_sell_count: int = 0,
    ) -> None:
        super().__init__(message)
        self.buy_count = buy_count
        self.sell_count = sell_count
        self.total_count = buy_count + sell_count
        self.verified_capacity = verified_capacity
        self.logical_buy_count = logical_buy_count
        self.logical_sell_count = logical_sell_count


class BrokerCapacityUnknownError(BrokerCapacityBlockedError):
    """Raised when arming a ladder on a LIVE broker and
    VERIFIED_CAPACITY.verified_max is still None -- Toss's real open-
    conditional-order capacity has never been empirically verified at all.
    Never guessed and never silently truncated -- the caller must persist a
    blocked state (BROKER_CONDITIONAL_CAPACITY_UNKNOWN) and let a human
    decide, exactly like a blocked cycle transition."""


class BrokerCapacityExceededError(BrokerCapacityBlockedError):
    """Raised when VERIFIED_CAPACITY.verified_max is a real, verified
    number, but the planned ladder needs more legs than that. Never
    truncate the ladder to fit -- surface this
    (BROKER_CONDITIONAL_CAPACITY_EXCEEDED) and let a human decide (raise
    the verified capacity after re-confirming it, or shrink the ladder via
    G/Pool/pool_usage_limit_pct/band)."""


class SellReservationUnknownError(RuntimeError):
    """Raised when arming a ladder with at least one SELL leg on a LIVE
    broker and CONDITIONAL_SELL_RESERVATION_BEHAVIOR is still UNKNOWN --
    whether Toss actually reserves sellable quantity against concurrent
    SELL conditional orders (vs. only checking at trigger time, which could
    let more shares be committed than are actually available) has not been
    confirmed. Never guessed -- the caller must persist a blocked state
    (SELL_RESERVATION_UNKNOWN) and let a human decide."""

    def __init__(self, message: str, *, sell_count: int) -> None:
        super().__init__(message)
        self.sell_count = sell_count


# Half of VERIFIED_CAPACITY.verified_max (200), split symmetrically between
# BUY and SELL so the worst case (both sides maxed) never exceeds the
# verified total. Below this per-side count, the logical ladder is placed
# uncompressed (one real broker order per rung, full price resolution);
# only a side whose logical rung count exceeds this is compressed down to
# fit. Update alongside VERIFIED_CAPACITY.verified_max if that number ever
# changes -- the two are meant to move together (see that constant's
# docstring for the empirical basis).
MAX_BROKER_ORDERS_PER_SIDE = 100


@dataclass(frozen=True)
class PlannedLeg:
    """One BROKER conditional order. quantity is 1 for an uncompressed
    ladder (logical count <= MAX_BROKER_ORDERS_PER_SIDE) but can be > 1
    after compression -- never assume quantity == 1 downstream (fill
    bookkeeping, partial-fill handling, etc.). logical_start_rung/
    logical_end_rung (1-indexed, inclusive) record which contiguous span of
    the uncompressed Book Ladder this one broker order covers; equal to
    each other when uncompressed."""
    side: str  # "buy" | "sell"
    trigger_price: Decimal
    quantity: int
    logical_start_rung: int
    logical_end_rung: int


def group_sizes(n: int, max_groups: int = MAX_BROKER_ORDERS_PER_SIDE) -> list[int]:
    """As-even-as-possible partition of n into at most max_groups
    consecutive groups (sizes differ by at most 1). Smaller groups come
    FIRST (index 0 is nearest V/current price in the book's own ordering),
    larger groups LAST (deep tail) -- keeps execution resolution highest
    where price is most likely to actually move, at the cost of coarser
    resolution far from the money where it matters least."""
    if n <= 0:
        return []
    if n <= max_groups:
        return [1] * n
    q, r = divmod(n, max_groups)
    return [q] * (max_groups - r) + [q + 1] * r


def compress_ladder(side: str, prices: list[Decimal], max_groups: int = MAX_BROKER_ORDERS_PER_SIDE) -> list[PlannedLeg]:
    """Group the full logical ladder (already computed by
    buy_ladder_prices/sell_ladder_prices, in book order) into at most
    max_groups consecutive broker orders. Each group's representative
    price is the arithmetic mean of its logical prices (every logical rung
    is 1 share), rounded to the cent at the end -- total quantity across
    all returned legs always equals len(prices) exactly; no rung is ever
    dropped or duplicated."""
    sizes = group_sizes(len(prices), max_groups)
    legs: list[PlannedLeg] = []
    idx = 0
    for size in sizes:
        chunk = prices[idx:idx + size]
        rep_price = money(sum(chunk) / Decimal(len(chunk)))
        legs.append(PlannedLeg(
            side=side, trigger_price=rep_price, quantity=len(chunk),
            logical_start_rung=idx + 1, logical_end_rung=idx + size,
        ))
        idx += size
    return legs


def buy_ladder_prices(lower_band: Decimal, starting_qty: int, count: int) -> list[Decimal]:
    """buy_price[n] = lower_band / (starting_qty + n - 1) for n = 1..count,
    each rounded to the cent. starting_qty is Q0 -- the position size at the
    moment this cycle's ladder is armed, fixed for the ladder's entire life
    (never the live/current qty)."""
    if starting_qty <= 0:
        raise ValueError("starting_qty must be positive.")
    if count < 0:
        raise ValueError("count cannot be negative.")
    return [money(lower_band / Decimal(starting_qty + i)) for i in range(count)]


def sell_ladder_prices(upper_band: Decimal, starting_qty: int, count: int) -> list[Decimal]:
    """sell_price[n] = upper_band / (starting_qty - n + 1) for n = 1..count.
    count must not exceed starting_qty (the denominator would reach 0)."""
    if starting_qty <= 0:
        raise ValueError("starting_qty must be positive.")
    if count < 0:
        raise ValueError("count cannot be negative.")
    if count > starting_qty:
        raise ValueError("count cannot exceed starting_qty (a sell ladder cannot exceed the position size).")
    return [money(upper_band / Decimal(starting_qty - i)) for i in range(count)]


def select_buy_ladder_length(
    prices: list[Decimal],
    cycle_start_pool: Decimal,
    pool_usage_limit_pct: Decimal = DEFAULT_POOL_USAGE_LIMIT_PCT,
    available_buying_power: Decimal | None = None,
) -> tuple[int, Decimal]:
    """How many BUY rungs (1 share each, taken in order) to actually
    register: whichever cumulative spend lands closest to
    cycle_start_pool * pool_usage_limit_pct, never exceeding cycle_start_pool
    (or, if given, the smaller of cycle_start_pool and
    available_buying_power -- a defense-in-depth cap beyond the book's own
    rule, in case Pool bookkeeping ever drifts ahead of real account cash).
    Ties prefer the smaller cumulative spend. Returns (n, cumulative_spend);
    n=0 if even the first rung is unaffordable."""
    spend_cap = cycle_start_pool
    if available_buying_power is not None:
        spend_cap = min(spend_cap, available_buying_power)
    target = cycle_start_pool * pool_usage_limit_pct
    cumulative = Decimal("0")
    best_n, best_cumulative, best_diff = 0, Decimal("0"), abs(target)
    for index, price in enumerate(prices, start=1):
        if cumulative + price > spend_cap:
            break
        cumulative += price
        diff = abs(cumulative - target)
        if diff < best_diff or (diff == best_diff and cumulative < best_cumulative):
            best_n, best_cumulative, best_diff = index, cumulative, diff
    return best_n, best_cumulative


def plan_buy_ladder(
    lower_band: Decimal,
    starting_qty: int,
    cycle_start_pool: Decimal,
    pool_usage_limit_pct: Decimal = DEFAULT_POOL_USAGE_LIMIT_PCT,
    available_buying_power: Decimal | None = None,
) -> tuple[list[PlannedLeg], Decimal, int]:
    """Computes the full logical BUY ladder (Pool-target selection
    unaffected by compression) and its projected total spend, then
    compresses it into at most MAX_BROKER_ORDERS_PER_SIDE broker orders
    (see compress_ladder). Returns (broker_legs, planned_buy_spend,
    logical_count) -- no broker-capacity gating here (see
    arm_cycle_orders); logical_count is the pre-compression rung count,
    kept for UI display and capacity-blocker reporting."""
    prices = buy_ladder_prices(lower_band, starting_qty, _MAX_LADDER_SEARCH)
    n, cumulative = select_buy_ladder_length(prices, cycle_start_pool, pool_usage_limit_pct, available_buying_power)
    legs = compress_ladder("buy", prices[:n])
    return legs, cumulative, n


def plan_sell_ladder(upper_band: Decimal, starting_qty: int, available_sell_qty: int) -> tuple[list[PlannedLeg], int]:
    """Computes the full logical SELL ladder: 1 share at each of up to
    starting_qty rungs (book: no Pool-based limit on the sell side),
    further capped by however many shares are actually sellable right now
    -- then compresses it into at most MAX_BROKER_ORDERS_PER_SIDE broker
    orders. Returns (broker_legs, logical_count)."""
    count = min(starting_qty, max(0, available_sell_qty))
    prices = sell_ladder_prices(upper_band, starting_qty, count)
    legs = compress_ladder("sell", prices)
    return legs, count


def cancel_and_confirm(broker, conditional_order_id: str) -> None:
    """The real DELETE /api/v1/conditional-orders/{id} returns 204 No
    Content on success (no status field to inspect) and raises TossApiError
    (via TossBroker._request) on failure -- so "the call returned without
    raising" is the confirmation signal. DRY_RUN's synthetic {"status":
    "DRY_RUN", ...} response never reaches the broker at all (matches
    TossBroker.cancel_order's own gate) and is likewise treated as confirmed.

    A 404 ("조건주문 없음") is treated as confirmed too, not failed: it means
    the order is already gone -- exactly the outcome being confirmed. This
    matters for crash recovery: if the process crashes after cancelling some
    orders but before persisting that fact, a retry re-issues DELETE for
    orders already cancelled at Toss; those must not be mistaken for a
    failed cancellation and block the transition."""
    try:
        cancel_conditional_order(broker, conditional_order_id)
    except TossApiError as error:
        if error.status == 404:
            return
        raise CancellationNotConfirmedError(
            f"Conditional order {conditional_order_id} cancellation failed: {error}"
        ) from error


def register_ladder_orders(
    broker,
    cycle: VRCycle,
    symbol: str,
    legs: list[PlannedLeg],
    starting_sequence: int,
) -> list[VRConditionalOrder]:
    """Create one conditional order per planned leg and return the matching
    VRConditionalOrder records. Sequence numbers are per-call (callers pass
    a fresh starting_sequence per side) so buy and sell ladders never share
    a clientOrderId sequence space."""
    new_orders: list[VRConditionalOrder] = []
    for offset, leg in enumerate(legs):
        sequence = starting_sequence + offset
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
            logical_start_rung=leg.logical_start_rung, logical_end_rung=leg.logical_end_rung,
        ))
    return new_orders
