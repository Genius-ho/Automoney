"""VR_SKILL integration mixin for TradingWebService.

Kept as a separate mixin/module so MUMAE's TradingWebService/WebService code
is touched only at the few explicit strategy_type branch points documented
in trading_service.py's auto_tick() -- every MUMAE calculation and order-
submission code path in mumae_core.py/web_service.py/trading_service.py is
completely unmodified by VR's presence. TradingWebService mixes this class
in (`class TradingWebService(VRWebServiceMixin, WebService)`) and calls
`self._vr_init_stores()` once from its own __init__.

Layering mirrors the rest of the VR codebase: this module is the only place
that turns "a tick happened" into calls against vr_engine.py (pure cycle/
config logic), vr_execution_policy.py (order sizing), and
vr_conditional_orders.py/vr_funds_ledger.py (broker/reservation I/O). None
of those modules import this one.
"""
from __future__ import annotations

from dataclasses import asdict, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from market_quote import fetch_unadjusted_daily_candles
from mumae_core import StrategyState, money
from runtime_store import STRATEGY_MUMAE, get_strategy_type, set_strategy_type
from vr_conditional_orders import (
    UnknownConditionalOrderStatusError,
    get_all_conditional_orders,
    parse_triggered_order_id,
    validate_leg_status,
)
from vr_engine import (
    CycleTransitionBlocked,
    anchor_friday_on_or_after,
    apply_fill_to_pool,
    arm_cycle_orders,
    cancel_cycle_orders,
    cancel_pending_config,
    find_last_trading_day_on_or_before,
    initialize_cycle,
    is_cycle_due_for_transition,
    schedule_config,
    scheduled_cycle_end_friday,
    transition_cycle,
)
import vr_execution_policy
from vr_execution_policy import (
    BrokerCapacityBlockedError,
    BrokerCapacityExceededError,
    BrokerCapacityUnknownError,
    SellReservationUnknownError,
)
from vr_formula import band
from vr_funds_ledger import FundsReservationLedger, available_vr_buying_power
from vr_state_store import VRConditionalOrder, VRState, VRStateStore
from web_gui.web_service import _collect_symbol_rows, _find_decimal, _text_decimal

# Statuses in which no new VR order (cycle transition) may ever be created,
# per spec section 12 (STOP) and section 6 (blocked transitions).
# UNKNOWN_CONDITIONAL_STATUS (spec 13-2): a conditional order/leg reported a
# status or field outside the documented schema -- fail closed rather than
# guess, and require a human to look before any new VR order is placed.
# REARM_BLOCKED no longer exists: the book Ladder execution policy never
# rearms mid-cycle (vr_execution_policy's module docstring), so nothing in
# this codebase can produce that status anymore.
_NO_NEW_ORDER_STATUSES = {
    "UNINITIALIZED", "CYCLE_TRANSITION_BLOCKED", "UNKNOWN_CONDITIONAL_STATUS",
    "BROKER_CONDITIONAL_CAPACITY_UNKNOWN", "BROKER_CONDITIONAL_CAPACITY_EXCEEDED",
    "SELL_RESERVATION_UNKNOWN",
}


class VRWebServiceMixin:
    def _vr_init_stores(self) -> None:
        self.vr_store = VRStateStore(self.data_dir / "vr_state.json")
        self.vr_funds_ledger = FundsReservationLedger(self.data_dir / "vr_funds_reservations.json")

    # --- read-only account/position fetch -----------------------------------

    def _vr_fetch_account(self, symbol: str) -> tuple[int, Decimal, Decimal]:
        """(position_qty, current_price, buying_power). Never writes to
        state.json and never calls MUMAE's build_plan()/dashboard(), so the
        MUMAE planner can never generate an order for a VR-managed symbol."""
        symbol = symbol.upper()
        broker = self.broker()
        holding_rows = _collect_symbol_rows(broker.get_holdings_raw())
        row = holding_rows.get(symbol, {})
        quantity = int(_find_decimal(row, ("quantity", "holdingQuantity", "holdingQty", "availableQuantity", "sellableQuantity")))
        price_rows = _collect_symbol_rows(broker.get_prices_raw([symbol]))
        price = _find_decimal(price_rows.get(symbol, {}), ("lastPrice", "price", "currentPrice"))
        buying_power_raw = broker.get_buying_power_raw()
        cash = _text_decimal(buying_power_raw.get("result", {}).get("cashBuyingPower"))
        return quantity, price, cash

    def vr_refresh_account(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        quantity, price, cash = self._vr_fetch_account(symbol)
        return {"symbol": symbol, "position_qty": quantity, "current_price": str(price), "buying_power": str(cash)}

    def _mumae_projected_states(self) -> list[StrategyState]:
        """Read-only: every MUMAE-strategy symbol's persisted state, used
        only to estimate MUMAE's near-term cash need (vr_funds_ledger.
        mumae_projected_reserve). Never mutated, never fed back into MUMAE."""
        return [
            self.store.load(symbol)
            for symbol in self.runtime.known_symbols
            if get_strategy_type(self.runtime, symbol) == STRATEGY_MUMAE
        ]

    def _vr_available_buying_power(self, symbol: str, pool_current: Decimal, buying_power: Decimal) -> Decimal:
        return available_vr_buying_power(
            buying_power, self.vr_funds_ledger, symbol, pool_current,
            mumae_states=self._mumae_projected_states(),
        )

    # --- order/fill sync + exactly-once Pool updates + rearm ---------------

    def vr_sync_orders(self, symbol: str) -> dict[str, Any]:
        """Sync VR conditional orders against the real Toss schema (spec
        13-1/13-2/13-3): the trigger signal is the leg's own
        `triggeredOrderId` (populated once Toss creates the underlying
        regular order), never the group-level status enum, which is
        deliberately not relied on for fill detection -- the triggered
        regular order's own status/execution (from the same
        get_all_orders_raw MUMAE already uses) is the sole authority for
        "is this filled and by how much". Any status/field outside the
        documented schema fails closed into UNKNOWN_CONDITIONAL_STATUS
        rather than being guessed at.
        """
        symbol = symbol.upper()
        state = self.vr_store.load(symbol)
        if state.current_cycle is None:
            return {"symbol": symbol, "orders": [], "synced": True}

        broker = self.broker()
        conditional_rows: list[dict[str, Any]] = []
        for group in ("OPEN", "CLOSED"):
            conditional_rows.extend(get_all_conditional_orders(broker, status=group, symbol=symbol))
        conditional_by_id = {str(row.get("conditionalOrderId")): row for row in conditional_rows}

        today_value = date.today()
        regular_rows: list[dict[str, Any]] = []
        for group in ("CLOSED", "OPEN"):
            regular_rows.extend(broker.get_all_orders_raw(
                group, symbol, (today_value - timedelta(days=7)).isoformat(), today_value.isoformat()
            ))
        regular_by_id = {str(row.get("orderId")): row for row in regular_rows}

        changed = False
        updated_orders: list[VRConditionalOrder] = []
        try:
            for order in state.conditional_orders:
                if order.status != "OPEN" or order.conditional_order_id is None:
                    updated_orders.append(order)
                    continue
                row = conditional_by_id.get(order.conditional_order_id)
                if row is None:
                    # Confirmed real behavior (Phase 14): a DELETE-cancelled
                    # conditional order disappears from BOTH the OPEN and
                    # CLOSED lists entirely -- it never lingers in CLOSED.
                    # So a locally-OPEN order missing from both here means
                    # it was cancelled outside the normal cycle-transition
                    # path (e.g. a manual DELETE) -- the same "gone means
                    # confirmed" interpretation cancel_and_confirm already
                    # uses for a 404. Mark it CANCELLED rather than leaving
                    # it stale forever (which used to silently block
                    # can_switch_strategy indefinitely).
                    updated_orders.append(replace(order, status="CANCELLED"))
                    changed = True
                    continue
                # VR only ever creates SINGLE conditional orders (one leg,
                # `first`); OCO/OTO's `second` is a real API feature this
                # module never exercises. `first` missing/malformed on our
                # own order is itself an unknown-schema condition.
                leg = row.get("first")
                if not isinstance(leg, dict):
                    raise UnknownConditionalOrderStatusError(
                        f"Conditional order {order.conditional_order_id} has no usable 'first' leg: {row!r}"
                    )
                validate_leg_status(leg.get("status"))
                triggered_order_id = parse_triggered_order_id(leg)
                if triggered_order_id is None:
                    updated_orders.append(order)
                    continue
                regular_row = regular_by_id.get(triggered_order_id)
                if regular_row is None:
                    updated_orders.append(replace(order, triggered_order_id=triggered_order_id))
                    changed = changed or triggered_order_id != order.triggered_order_id
                    continue
                regular_side = str(regular_row.get("side") or "").upper()
                if regular_side not in ("BUY", "SELL"):
                    raise UnknownConditionalOrderStatusError(
                        f"Triggered order {triggered_order_id} has an unrecognized side: {regular_row.get('side')!r}"
                    )
                if regular_side != order.side.upper():
                    raise UnknownConditionalOrderStatusError(
                        f"Triggered order {triggered_order_id} side {regular_side!r} does not match "
                        f"planned leg side {order.side!r}."
                    )
                regular_status = str(regular_row.get("status", "")).upper()
                # Real schema fact (Toss OrderStatus enum): CANCELED and
                # REJECTED can both still carry a nonzero
                # execution.filledQuantity ("부분 체결 여부를
                # execution.filledQuantity를 통해 확인") -- a compressed leg
                # (quantity > 1) can partially fill before being cancelled/
                # rejected, and that partial fill's real Pool impact must
                # never be silently dropped. Only FILLED gets a "no explicit
                # filledQuantity -> assume the full order quantity" fallback;
                # REJECTED/CANCELED default to 0, never to the full quantity.
                if regular_status == "FILLED":
                    final_leg_status = "FILLED"
                    fallback_quantity = regular_row.get("quantity")
                elif regular_status in ("REJECTED", "CANCELED", "CANCELLED"):
                    final_leg_status = "REJECTED"
                    fallback_quantity = "0"
                else:
                    # PENDING/PARTIAL_FILLED/PENDING_CANCEL/PENDING_REPLACE
                    # or otherwise non-terminal: leave OPEN and do not touch
                    # Pool -- only a terminal status ever updates Pool.
                    updated_orders.append(replace(order, triggered_order_id=triggered_order_id))
                    changed = changed or triggered_order_id != order.triggered_order_id
                    continue

                if triggered_order_id not in state.applied_fill_order_ids:
                    execution = regular_row.get("execution") or {}
                    raw_quantity = execution.get("filledQuantity")
                    if raw_quantity is None:
                        raw_quantity = fallback_quantity if fallback_quantity is not None else "0"
                    try:
                        filled_qty = Decimal(str(raw_quantity))
                    except Exception as error:
                        raise UnknownConditionalOrderStatusError(
                            f"Triggered order {triggered_order_id} has a malformed filled quantity: {raw_quantity!r}"
                        ) from error
                    if filled_qty > 0:
                        state.current_cycle = apply_fill_to_pool(
                            state.current_cycle, order.side, filled_qty * order.trigger_price
                        )
                        state.applied_fill_order_ids.append(triggered_order_id)
                updated_orders.append(replace(order, status=final_leg_status, triggered_order_id=triggered_order_id))
                changed = True
        except UnknownConditionalOrderStatusError as error:
            state.status = "UNKNOWN_CONDITIONAL_STATUS"
            state.blocked_reason = str(error)
            self.vr_store.save(state)
            return {"symbol": symbol, "orders": [asdict(o) for o in state.conditional_orders], "synced": True, "blocked": True}

        state.conditional_orders = updated_orders
        if changed:
            self.vr_store.save(state)

        # Book Ladder execution policy: the cycle's full BUY/SELL order
        # table is armed once at cycle start and stays fixed for the whole
        # 2-week cycle. A fill only updates Pool (already done above via
        # apply_fill_to_pool) -- it never cancels or recomputes any other
        # rung (no rearm; see vr_execution_policy's module docstring).
        return {"symbol": symbol, "orders": [asdict(o) for o in state.conditional_orders], "synced": True}

    # --- biweekly cycle transition, with crash-safe resume ------------------

    def _vr_confirmed_close_price(self, symbol: str, session_date: date) -> Decimal | None:
        candles = fetch_unadjusted_daily_candles(self.broker(), symbol, count=10)
        for candle in candles:
            raw = candle.get("timestamp") or candle.get("date")
            try:
                candle_date = datetime.fromisoformat(str(raw)).date()
            except (TypeError, ValueError):
                continue
            if candle_date == session_date and candle.get("closePrice") is not None:
                return Decimal(str(candle["closePrice"]))
        return None

    def _vr_run_transition(self, symbol: str, state: VRState, now: datetime) -> None:
        broker = self.broker()
        open_ids = [
            order.conditional_order_id for order in state.conditional_orders
            if order.status == "OPEN" and order.conditional_order_id
        ]
        try:
            cancel_cycle_orders(broker, open_ids, still_open_after_sync=False)
        except CycleTransitionBlocked as error:
            state.status = "CYCLE_TRANSITION_BLOCKED"
            state.blocked_reason = str(error)
            self.vr_store.save(state)
            return
        # Cancellation is confirmed. Persist an in-progress marker before
        # doing anything else, so a crash here resumes at
        # _vr_finish_transition on restart rather than re-cancelling
        # (harmless but wasteful) or, worse, silently doing nothing.
        state.conditional_orders = [
            replace(order, status="CANCELLED") if order.status == "OPEN" else order
            for order in state.conditional_orders
        ]
        state.status = "CYCLE_TRANSITION_IN_PROGRESS"
        self.vr_store.save(state)
        self._vr_finish_transition(symbol, state, now)

    def _vr_resume_transition(self, symbol: str, state: VRState, now: datetime) -> None:
        """Reached only when status == CYCLE_TRANSITION_IN_PROGRESS on
        load -- the only way to reach that status is after cancellation was
        already confirmed (see _vr_run_transition), so resuming means
        finishing the transition, never re-cancelling."""
        self._vr_finish_transition(symbol, state, now)

    def _vr_finish_transition(self, symbol: str, state: VRState, now: datetime) -> None:
        broker = self.broker()
        qty, _price, buying_power = self._vr_fetch_account(symbol)
        end_session = date.fromisoformat(state.current_cycle.end_session)
        close_price = self._vr_confirmed_close_price(symbol, end_session)
        anchor = date.fromisoformat(state.anchor_friday) if state.anchor_friday else end_session
        next_cycle_number = state.cycle_number + 1
        scheduled_friday = scheduled_cycle_end_friday(anchor, next_cycle_number)
        next_end_session, _ = find_last_trading_day_on_or_before(broker, scheduled_friday)
        next_start_session = end_session + timedelta(days=1)
        next_cycle_id = f"{symbol}-c{next_cycle_number}"
        available = self._vr_available_buying_power(symbol, state.current_cycle.pool_current, buying_power)
        try:
            new_state, _new_orders = transition_cycle(
                broker=broker, state=state, symbol=symbol,
                final_qty=qty, close_price=close_price,
                next_cycle_id=next_cycle_id, next_start_session=next_start_session,
                next_end_session=next_end_session,
                available_buying_power=available, available_sell_qty=qty,
            )
        except CycleTransitionBlocked as error:
            state.status = "CYCLE_TRANSITION_BLOCKED"
            state.blocked_reason = str(error)
            self.vr_store.save(state)
            return
        except BrokerCapacityBlockedError as error:
            # The old cycle's orders are already cancelled by this point
            # (_vr_run_transition ran first) -- this symbol is left with no
            # armed ladder until a human resolves the capacity question and
            # retries (e.g. via vr_start), never a silently truncated ladder.
            state.status = (
                "BROKER_CONDITIONAL_CAPACITY_UNKNOWN" if isinstance(error, BrokerCapacityUnknownError)
                else "BROKER_CONDITIONAL_CAPACITY_EXCEEDED"
            )
            state.blocked_reason = str(error)
            state.capacity_blocker = {
                "buy_count": error.buy_count,
                "sell_count": error.sell_count,
                "total_count": error.total_count,
                "verified_capacity": error.verified_capacity,
                "logical_buy_count": error.logical_buy_count,
                "logical_sell_count": error.logical_sell_count,
            }
            self.vr_store.save(state)
            return
        except SellReservationUnknownError as error:
            # Same reasoning as the capacity blocker above: the old cycle's
            # orders are already gone, this symbol stays unarmed until a
            # human confirms the SELL reservation behavior and retries.
            state.status = "SELL_RESERVATION_UNKNOWN"
            state.blocked_reason = str(error)
            state.sell_reservation_blocker = {"sell_count": error.sell_count}
            self.vr_store.save(state)
            return
        self.vr_store.save(new_state)

    def vr_auto_tick_for_symbol(self, symbol: str, now: datetime | None = None) -> None:
        """Called once per known VR_SKILL symbol per auto_tick(). Common
        account/order sync (vr_refresh_account/vr_sync_orders) is expected
        to already have run for this tick -- this method only evaluates
        whether a cycle transition is due and dispatches it (or resumes one
        interrupted by a restart)."""
        symbol = symbol.upper()
        now = now or datetime.now(timezone.utc)
        state = self.vr_store.load(symbol)
        if state.status in _NO_NEW_ORDER_STATUSES or state.current_cycle is None:
            return
        broker = self.broker()
        if state.status == "CYCLE_TRANSITION_IN_PROGRESS":
            self._vr_resume_transition(symbol, state, now)
            return
        end_session = date.fromisoformat(state.current_cycle.end_session)
        if not is_cycle_due_for_transition(broker, end_session, now):
            return
        if state.status == "STOPPED":
            state.status = "CYCLE_DUE_STOPPED"
            self.vr_store.save(state)
            return
        self._vr_run_transition(symbol, state, now)

    # --- initialize / start / stop / config -------------------------------

    def vr_initialize(
        self, symbol: str, initial_pool: Decimal, G: Decimal, band_pct: Decimal,
        now: datetime | None = None,
        pool_usage_limit_pct: Decimal = vr_execution_policy.DEFAULT_POOL_USAGE_LIMIT_PCT,
        recurring_contribution: Decimal = Decimal("0"),
    ) -> dict[str, Any]:
        symbol = symbol.upper()
        existing = self.vr_store.load(symbol)
        if existing.status != "UNINITIALIZED":
            raise ValueError(f"{symbol}: 이미 VR이 초기화되어 있습니다.")
        qty, price, _cash = self._vr_fetch_account(symbol)
        if qty <= 0 or price <= 0:
            raise ValueError(f"{symbol}: 초기화하려면 보유수량과 현재가가 모두 0보다 커야 합니다.")
        today = (now or datetime.now(timezone.utc)).date()
        anchor = anchor_friday_on_or_after(today)
        if anchor == today:
            # A first cycle can never be zero days long: if today is itself
            # the anchor Friday, anchor_friday_on_or_after(today) returns
            # today, which would make cycle 1 end the instant it starts.
            # Push out to the following Friday instead; every later cycle
            # still lands on this new anchor + 14/28/... days as usual.
            anchor += timedelta(days=7)
        end_session, _session = find_last_trading_day_on_or_before(self.broker(), scheduled_cycle_end_friday(anchor, 1))
        state = initialize_cycle(
            symbol=symbol, position_qty=qty, current_price=price,
            initial_pool=initial_pool, G=G, band_pct=band_pct,
            cycle_id=f"{symbol}-c1", start_session=today.isoformat(),
            end_session=end_session.isoformat(), anchor_friday=anchor.isoformat(),
            pool_usage_limit_pct=pool_usage_limit_pct,
            recurring_contribution=recurring_contribution,
        )
        _, _, buying_power = self._vr_fetch_account(symbol)
        available = self._vr_available_buying_power(symbol, initial_pool, buying_power)
        try:
            orders, planned_buy_spend = arm_cycle_orders(
                self.broker(), state.current_cycle, symbol, qty, available, qty,
            )
        except BrokerCapacityBlockedError as error:
            # V/band are already computed and worth keeping visible -- only
            # the ladder itself failed to arm. Persisted (not just raised)
            # so the same structured UI (logical BUY/SELL/total counts,
            # verified capacity, blocker reason) used for a blocked cycle
            # transition also covers a blocked first-time initialization.
            state.status = (
                "BROKER_CONDITIONAL_CAPACITY_UNKNOWN" if isinstance(error, BrokerCapacityUnknownError)
                else "BROKER_CONDITIONAL_CAPACITY_EXCEEDED"
            )
            state.blocked_reason = str(error)
            state.capacity_blocker = {
                "buy_count": error.buy_count,
                "sell_count": error.sell_count,
                "total_count": error.total_count,
                "verified_capacity": error.verified_capacity,
                "logical_buy_count": error.logical_buy_count,
                "logical_sell_count": error.logical_sell_count,
            }
            self.vr_store.save(state)
            raise
        except SellReservationUnknownError as error:
            state.status = "SELL_RESERVATION_UNKNOWN"
            state.blocked_reason = str(error)
            state.sell_reservation_blocker = {"sell_count": error.sell_count}
            self.vr_store.save(state)
            raise
        state.conditional_orders = orders
        state.current_cycle = replace(state.current_cycle, planned_buy_spend=planned_buy_spend)
        self.vr_store.save(state)
        return {"symbol": symbol, "V1": str(state.current_cycle.V), "status": state.status}

    def vr_start(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        state = self.vr_store.load(symbol)
        if state.status == "UNINITIALIZED":
            raise ValueError(f"{symbol}: VR이 아직 초기화되지 않았습니다.")
        if state.status in (
            "CYCLE_TRANSITION_BLOCKED", "BROKER_CONDITIONAL_CAPACITY_UNKNOWN", "BROKER_CONDITIONAL_CAPACITY_EXCEEDED",
            "SELL_RESERVATION_UNKNOWN",
        ):
            raise ValueError(f"{symbol}: {state.status} 상태입니다. 먼저 원인을 해결하세요: {state.blocked_reason}")
        if state.status == "ACTIVE":
            return {"symbol": symbol, "status": state.status}
        # STOPPED or CYCLE_DUE_STOPPED: reconcile, resolve any overdue cycle,
        # and only then flip to ACTIVE. Pressing START never creates a new
        # order as a direct side effect.
        self.vr_refresh_account(symbol)
        self.vr_sync_orders(symbol)
        state = self.vr_store.load(symbol)
        now = datetime.now(timezone.utc)
        if state.current_cycle is not None:
            end_session = date.fromisoformat(state.current_cycle.end_session)
            if is_cycle_due_for_transition(self.broker(), end_session, now):
                self._vr_run_transition(symbol, state, now)
                state = self.vr_store.load(symbol)
                if state.status in ("CYCLE_TRANSITION_BLOCKED", "CYCLE_TRANSITION_IN_PROGRESS"):
                    return {"symbol": symbol, "status": state.status, "blocked_reason": state.blocked_reason}
        state.status = "ACTIVE"
        self.vr_store.save(state)
        return {"symbol": symbol, "status": "ACTIVE"}

    def vr_stop(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        state = self.vr_store.load(symbol)
        if state.status in ("ACTIVE", "CYCLE_DUE_STOPPED"):
            state.status = "STOPPED"
            self.vr_store.save(state)
        return {"symbol": symbol, "status": state.status}

    def vr_schedule_config(
        self, symbol: str, G: Decimal | None = None,
        band_pct: Decimal | None = None, pool_adjustment: Decimal | None = None,
        pool_usage_limit_pct: Decimal | None = None,
        recurring_contribution: Decimal | None = None,
    ) -> dict[str, Any]:
        symbol = symbol.upper()
        state = self.vr_store.load(symbol)
        if state.current_cycle is None:
            raise ValueError(f"{symbol}: VR이 초기화되지 않았습니다.")
        state = schedule_config(
            state, G=G, band_pct=band_pct, pool_adjustment=pool_adjustment,
            pool_usage_limit_pct=pool_usage_limit_pct,
            recurring_contribution=recurring_contribution,
        )
        self.vr_store.save(state)
        return {"symbol": symbol, "pending_config": asdict(state.pending_config)}

    def vr_cancel_pending_config(
        self, symbol: str, *, G: bool = False, band_pct: bool = False,
        pool_adjustment: bool = False, pool_usage_limit_pct: bool = False,
        recurring_contribution: bool = False, all: bool = False,
    ) -> dict[str, Any]:
        symbol = symbol.upper()
        state = self.vr_store.load(symbol)
        state = cancel_pending_config(
            state, G=G, band_pct=band_pct, pool_adjustment=pool_adjustment,
            pool_usage_limit_pct=pool_usage_limit_pct, recurring_contribution=recurring_contribution, all=all,
        )
        self.vr_store.save(state)
        return {"symbol": symbol, "pending_config": asdict(state.pending_config)}

    # --- strategy-switch safety ---------------------------------------------

    def can_switch_strategy(self, symbol: str) -> tuple[bool, str]:
        """False + reason if symbol has any OPEN regular or VR conditional
        order. Switching strategies never auto-cancels existing orders --
        the switch stays blocked until the operator clears them."""
        symbol = symbol.upper()
        if self.pending_order_count(symbol) > 0:
            return False, f"{symbol}: 처리되지 않은 일반 주문이 있어 전략을 변경할 수 없습니다."
        state = self.vr_store.load(symbol)
        if any(order.status == "OPEN" for order in state.conditional_orders):
            return False, f"{symbol}: 처리되지 않은 VR 조건주문이 있어 전략을 변경할 수 없습니다."
        return True, ""

    # --- read-only dashboard payload -----------------------------------

    def vr_snapshot(self, symbol: str) -> dict[str, Any]:
        """A single consolidated, JSON-ready payload for the VR web panel:
        current status/cycle/config, the always-visible formula + term
        explanations (spec section 11), and the last completed cycle's full
        V_next breakdown for audit display."""
        symbol = symbol.upper()
        state = self.vr_store.load(symbol)
        payload: dict[str, Any] = {
            "symbol": symbol,
            "status": state.status,
            "blocked_reason": state.blocked_reason,
            "capacity_blocker": state.capacity_blocker,
            "sell_reservation_blocker": state.sell_reservation_blocker,
            "cycle_number": state.cycle_number,
            "anchor_friday": state.anchor_friday,
            "current_cycle": None,
            "pending_config": {
                "G": None if state.pending_config.G is None else str(state.pending_config.G),
                "band_pct": None if state.pending_config.band_pct is None else str(state.pending_config.band_pct),
                "pool_adjustment": None if state.pending_config.pool_adjustment is None else str(state.pending_config.pool_adjustment),
                "pool_usage_limit_pct": None if state.pending_config.pool_usage_limit_pct is None else str(state.pending_config.pool_usage_limit_pct),
                "recurring_contribution": None if state.pending_config.recurring_contribution is None else str(state.pending_config.recurring_contribution),
            },
            "conditional_orders": [
                {**asdict(order), "trigger_price": str(order.trigger_price), "order_price": str(order.order_price)}
                for order in state.conditional_orders
            ],
            # Logical Book Ladder vs Broker Execution Ladder (compression):
            # broker_*_count is len(...); logical_*_count is the largest
            # logical_end_rung on that side (compression covers the full
            # logical ladder contiguously from rung 1, so the max end rung
            # equals the total logical count). 0/0 if nothing armed yet.
            "ladder_counts": {
                "logical_buy_count": max(
                    (o.logical_end_rung for o in state.conditional_orders if o.side == "buy" and o.logical_end_rung is not None),
                    default=0,
                ),
                "logical_sell_count": max(
                    (o.logical_end_rung for o in state.conditional_orders if o.side == "sell" and o.logical_end_rung is not None),
                    default=0,
                ),
                "broker_buy_count": sum(1 for o in state.conditional_orders if o.side == "buy"),
                "broker_sell_count": sum(1 for o in state.conditional_orders if o.side == "sell"),
            },
            "explain": {
                "V": "VR이 목표로 하는 해당 종목의 평가금액입니다. 최초 V1은 현재 보유수량 × 현재 시장가격으로 자동 계산합니다.",
                "E": "직전 2주 사이클 종료 시 실제 보유주식의 시장 평가금액입니다. 다음 V 계산에서 시장 움직임을 반영하는 데 사용합니다.",
                "Pool": "이 VR 종목에 별도로 배정된 현금입니다. 계좌 전체 현금과 다르며, VR 매수 시 감소하고 VR 매도 시 증가합니다.",
                "G": "V의 변화속도를 조절하는 값입니다. 작을수록 주식 비중이 높아지는 공격적인 방향, 클수록 현금을 더 유지하는 상대적으로 보수적인 방향입니다.",
                "Band": "V를 중심으로 주문 영역을 결정하는 범위입니다. 책에서는 ±15%, ±20% 등을 대표적으로 설명합니다. 과거 비율/백테스트 수치는 참고정보일 뿐 미래 수익을 보장하지 않습니다.",
            },
            "formula": "V(next) = V + Pool/G + (E - V) / (2 * sqrt(G))",
        }
        cycle = state.current_cycle
        if cycle is not None:
            pool_to_v_pct = (cycle.pool_current / cycle.V * 100) if cycle.V else Decimal("0")
            projected_pool = None
            if cycle.planned_buy_spend is not None:
                projected_pool = str(cycle.pool_start - cycle.planned_buy_spend)
            payload["current_cycle"] = {
                "cycle_id": cycle.cycle_id,
                "start_session": cycle.start_session,
                "end_session": cycle.end_session,
                "V": str(cycle.V),
                "G": str(cycle.G),
                "band_pct": str(cycle.band_pct),
                "pool_start": str(cycle.pool_start),
                "pool_current": str(cycle.pool_current),
                "pool_usage_limit_pct": str(cycle.pool_usage_limit_pct),
                "recurring_contribution": str(cycle.recurring_contribution),
                # cycle_start_pool * pool_usage_limit_pct -- the BUY ladder's
                # target (select_buy_ladder_length picks the logical rung
                # count whose cumulative spend lands closest to this, never
                # exceeding pool_start). Distinct from planned_buy_spend,
                # which is the actually-selected cumulative spend.
                "target_buy_spend": str(money(cycle.pool_start * cycle.pool_usage_limit_pct)),
                "pool_to_v_pct": str(pool_to_v_pct.quantize(Decimal("0.01"))),
                # Planned/projected: what the book's order table assumes if
                # every armed BUY rung eventually fills, fixed at arm time.
                # pool_current instead tracks Pool from real Toss fills only.
                "planned_buy_spend": str(cycle.planned_buy_spend) if cycle.planned_buy_spend is not None else None,
                "projected_pool": projected_pool,
                "lower_band": str(cycle.lower_band),
                "upper_band": str(cycle.upper_band),
                "E_at_close": str(cycle.E_at_close) if cycle.E_at_close is not None else None,
            }
        if state.history:
            last = state.history[-1]
            payload["last_breakdown"] = {
                "cycle_id": last.get("cycle_id"),
                "old_V": last.get("V"),
                "E": last.get("E_at_close"),
                "Pool": last.get("pool_start"),
                "G": last.get("G"),
                "pool_term": last.get("pool_term"),
                "market_adjustment_term": last.get("market_adjustment_term"),
                "new_V": last.get("new_V"),
            }

        # V1 -> V2 -> ... progression for the chart/gauge visualizations:
        # one point per closed cycle (from history) plus the current cycle
        # (if any). E_at_close is null for the current cycle since it isn't
        # closed yet -- the frontend uses vr.refresh's live position value
        # instead for that last point.
        history_points: list[dict[str, Any]] = []
        for entry in state.history:
            entry_v = Decimal(str(entry.get("V") or "0"))
            entry_band_pct = Decimal(str(entry.get("band_pct") or "0"))
            lower, upper = band(entry_v, entry_band_pct) if entry_band_pct > 0 else (entry_v, entry_v)
            history_points.append({
                "cycle_id": entry.get("cycle_id"),
                "V": entry.get("V"),
                "lower_band": str(lower),
                "upper_band": str(upper),
                "E_at_close": entry.get("E_at_close"),
            })
        if cycle is not None:
            history_points.append({
                "cycle_id": cycle.cycle_id,
                "V": str(cycle.V),
                "lower_band": str(cycle.lower_band),
                "upper_band": str(cycle.upper_band),
                "E_at_close": str(cycle.E_at_close) if cycle.E_at_close is not None else None,
            })
        payload["history_points"] = history_points
        return payload

    def vr_set_strategy_type(self, symbol: str, new_strategy_type: str) -> dict[str, Any]:
        symbol = symbol.upper()
        current = get_strategy_type(self.runtime, symbol)
        if current == new_strategy_type:
            return {"symbol": symbol, "strategy_type": current}
        ok, reason = self.can_switch_strategy(symbol)
        if not ok:
            raise ValueError(reason)
        if new_strategy_type == "VR_SKILL" and symbol in self.runtime.active_symbols:
            # MUMAE's active_symbols ("running") flag is a separate piece of
            # state from strategy_type and switching away from MUMAE does
            # not clear it on its own -- leaving it set would let a stale
            # plan_cache entry from before the switch still be submitted by
            # auto_tick's MUMAE order loop (guarded there too, but this
            # keeps the ETF-status "running" flag honest as well).
            self.stop_auto(symbol)
        set_strategy_type(self.runtime, symbol, new_strategy_type)
        self.runtime_store.save(self.runtime)
        return {"symbol": symbol, "strategy_type": new_strategy_type}
