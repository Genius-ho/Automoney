import json
import tempfile
import unittest
import unittest.mock
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import vr_execution_policy
from runtime_store import get_strategy_type, set_strategy_type
from vr_engine import CycleTransitionBlocked
from vr_execution_policy import BrokerCapacityExceededError, BrokerCapacityUnknownError, SellReservationUnknownError
from web_gui.trading_service import TradingWebService


def setUpModule():
    # These tests aren't about the broker-capacity/sell-reservation gates
    # themselves (see BrokerCapacityGateTests/SellReservationGateTests for
    # those) -- a generous verified cap and a known reservation behavior
    # keep ladder arming unblocked everywhere else in this module.
    vr_execution_policy.VERIFIED_CAPACITY = vr_execution_policy.ConditionalOrderCapacity(
        verified_max=1000, scope=vr_execution_policy.CAPACITY_SCOPE_ACCOUNT,
        verified_at="2026-08-21", source="test setup",
    )
    vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR = vr_execution_policy.SELL_RESERVATION_RESERVES_QUANTITY


def tearDownModule():
    vr_execution_policy.VERIFIED_CAPACITY = vr_execution_policy.ConditionalOrderCapacity()
    vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR = vr_execution_policy.SELL_RESERVATION_UNKNOWN


def _session(date_str: str) -> dict:
    return {
        "date": date_str,
        "dayMarket": {"startTime": f"{date_str}T22:00:00+09:00", "endTime": f"{date_str}T22:30:00+09:00"},
        "preMarket": {"startTime": f"{date_str}T22:30:00+09:00", "endTime": f"{date_str}T23:30:00+09:00"},
        "regularMarket": {"startTime": f"{date_str}T09:30:00-04:00", "endTime": f"{date_str}T16:00:00-04:00"},
    }


class IntegratedFakeBroker:
    """One fake broker instance driving both the existing MUMAE path and
    the new VR path through a single TradingWebService, matching a real
    deployment (one broker per process). Fully in-memory; mode starts
    DRY_RUN so create/cancel conditional-order calls never reach _request
    unless a test explicitly switches to LIVE (still 100% fake -- _request
    never opens a socket)."""

    def __init__(self, mode: str = "DRY_RUN"):
        self.mode = mode
        self.live_ack = mode == "LIVE"
        self.holdings: dict[str, tuple[str, str]] = {}  # symbol -> (qty, avg_cost)
        self.prices: dict[str, str] = {}
        self.buying_power = "100000"
        self.candles: dict[str, list[dict]] = {}
        self.open_orders: list[dict] = []
        self.closed_orders: list[dict] = []
        self.conditional_orders: dict[str, dict] = {}
        self.cancelled_conditional_order_ids: set[str] = set()
        # Persists across cancel/delete -- simulates Toss's documented
        # clientOrderId idempotency ("동일한 값으로 재요청 시 중복 생성을
        # 방지합니다"): a create retry with a clientOrderId already seen
        # returns the SAME conditionalOrderId rather than minting a new one.
        self.client_order_id_index: dict[str, str] = {}
        self._next_co_id = 1
        self.holidays: set[str] = set()
        # Test-only crash injection: raise on the Nth conditional-order
        # create call (1-indexed), simulating a process crash mid-arm.
        self.crash_after_create_count: int | None = None
        self._create_count = 0
        # Same idea for the cancel phase: raise after the Nth DELETE call.
        self.crash_after_cancel_count: int | None = None
        self._cancel_count = 0

    # --- shared read endpoints ---
    def get_holdings_raw(self):
        return {"result": {"holdings": [
            {"symbol": symbol, "quantity": qty, "averagePrice": avg}
            for symbol, (qty, avg) in self.holdings.items()
        ]}}

    def get_prices_raw(self, symbols):
        return {"result": [
            {"symbol": symbol, "lastPrice": self.prices.get(symbol, "0"),
             "timestamp": date.today().isoformat() + "T13:00:00+09:00"}
            for symbol in symbols
        ]}

    def get_buying_power_raw(self):
        return {"result": {"cashBuyingPower": self.buying_power}}

    def get_daily_candles_raw(self, symbol, count, before=None, adjusted=True):
        return {"result": {"candles": self.candles.get(symbol, [])}}

    def get_us_market_calendar_raw(self, date_value=None):
        target = date_value or date.today().isoformat()
        if target in self.holidays:
            return {"result": {"today": {"date": target}}}
        return {"result": {"today": _session(target)}}

    def get_all_orders_raw(self, status, symbol, from_date, to_date):
        rows = self.open_orders if status == "OPEN" else self.closed_orders
        return [row for row in rows if row.get("symbol") == symbol]

    # --- MUMAE order path (unused by VR tests but required by the shared class) ---
    def submit_order(self, order, client_order_id):
        return {"result": {"orderId": f"mumae-{client_order_id}"}}

    def cancel_order(self, order_id):
        return {"status": "DRY_RUN", "orderId": order_id}

    # --- VR conditional-order path ---
    def _account_headers(self):
        return {}

    def _request(self, method, path, data=None, headers=None):
        # Matches the real, verified schema (Phase 13): create nests
        # orderSide/triggerPrice/orderPrice under "first"; cancel is DELETE
        # -> 204 (empty dict, no "status" field); list is GET with a
        # required status= query and a "conditionalOrders" body key;
        # triggeredOrderId lives on the leg, not the top level.
        if method == "POST" and path == "/api/v1/conditional-orders":
            payload = json.loads(data)
            client_order_id = payload["clientOrderId"]
            existing = self.client_order_id_index.get(client_order_id)
            if existing is not None:
                # Idempotent replay: same clientOrderId -> same conditional
                # order, no new order created.
                return {"result": {"conditionalOrderId": existing, "clientOrderId": client_order_id}}
            self._create_count += 1
            if self.crash_after_create_count is not None and self._create_count > self.crash_after_create_count:
                raise ConnectionError("simulated process crash mid conditional-order creation")
            conditional_order_id = f"co-{self._next_co_id}"
            self._next_co_id += 1
            self.client_order_id_index[client_order_id] = conditional_order_id
            self.conditional_orders[conditional_order_id] = {
                "conditionalOrderId": conditional_order_id,
                "clientOrderId": client_order_id,
                "symbol": payload["symbol"], "status": "WATCHING",
                "first": {
                    "status": "WATCHING", "orderSide": payload["first"]["orderSide"],
                    "triggerPrice": payload["first"]["triggerPrice"], "orderPrice": payload["first"]["orderPrice"],
                    "triggeredOrderId": None,
                },
            }
            return {"result": {"conditionalOrderId": conditional_order_id, "clientOrderId": client_order_id}}
        if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
            conditional_order_id = path.rsplit("/", 1)[-1]
            if conditional_order_id not in self.conditional_orders:
                from toss_api import TossApiError
                raise TossApiError("Toss API HTTP 404: not found")
            self._cancel_count += 1
            if self.crash_after_cancel_count is not None and self._cancel_count > self.crash_after_cancel_count:
                raise ConnectionError("simulated process crash mid cancellation")
            del self.conditional_orders[conditional_order_id]
            self.cancelled_conditional_order_ids.add(conditional_order_id)
            return {}
        if method == "GET" and path.startswith("/api/v1/conditional-orders"):
            symbol = path.split("symbol=")[1].split("&")[0] if "symbol=" in path else None
            rows = [row for row in self.conditional_orders.values() if symbol is None or row["symbol"] == symbol]
            return {"result": {"conditionalOrders": rows, "hasNext": False, "nextCursor": None}}
        raise AssertionError(f"unexpected _request call: {method} {path}")

    # --- test-only simulation helpers ---
    def trigger_and_fill(self, conditional_order_id: str, quantity: int) -> str:
        """Simulate Toss triggering a conditional order and its regular
        order filling completely."""
        row = self.conditional_orders[conditional_order_id]
        row["status"] = "ORDERED"
        row["first"]["status"] = "ORDERED"
        regular_order_id = f"reg-{conditional_order_id}"
        row["first"]["triggeredOrderId"] = regular_order_id
        self.closed_orders.append({
            "orderId": regular_order_id, "symbol": row["symbol"], "side": row["first"]["orderSide"],
            "status": "FILLED", "quantity": str(quantity),
            "execution": {"filledQuantity": str(quantity), "filledAt": datetime.now(timezone.utc).isoformat()},
        })
        return regular_order_id

    def trigger_partial_fill_then_cancel(self, conditional_order_id: str, planned_quantity: int, filled_quantity: int) -> str:
        """Simulate a compressed (quantity > 1) leg triggering, partially
        filling, and then being cancelled (e.g. cycle-end cleanup) with the
        remainder unfilled -- the real Toss OrderStatus schema documents
        CANCELED as still possibly carrying a nonzero
        execution.filledQuantity ("취소 완료. execution.filledQuantity를
        통해 부분 체결 여부를 확인할 수 있음")."""
        row = self.conditional_orders[conditional_order_id]
        row["status"] = "ORDERED"
        row["first"]["status"] = "ORDERED"
        regular_order_id = f"reg-{conditional_order_id}"
        row["first"]["triggeredOrderId"] = regular_order_id
        self.closed_orders.append({
            "orderId": regular_order_id, "symbol": row["symbol"], "side": row["first"]["orderSide"],
            "status": "CANCELED", "quantity": str(planned_quantity),
            "execution": {"filledQuantity": str(filled_quantity), "filledAt": datetime.now(timezone.utc).isoformat()},
        })
        return regular_order_id


class VRServiceHarness:
    def __init__(self, broker: IntegratedFakeBroker):
        self._tempdir = tempfile.TemporaryDirectory()
        self.service = TradingWebService(Path(self._tempdir.name), broker_factory=lambda: broker)
        self.broker = broker

    def close(self):
        self._tempdir.cleanup()


def _make_service(broker: IntegratedFakeBroker) -> tuple[TradingWebService, tempfile.TemporaryDirectory]:
    tempdir = tempfile.TemporaryDirectory()
    service = TradingWebService(Path(tempdir.name), broker_factory=lambda: broker)
    return service, tempdir


class VRInitializeAndArmTests(unittest.TestCase):
    def test_initialize_computes_v1_and_arms_initial_orders(self):
        broker = IntegratedFakeBroker()
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            result = service.vr_initialize("TQQQ", Decimal("1000"), Decimal("10"), Decimal("15"))
            self.assertEqual(result["V1"], "11000.00")
            state = service.vr_store.load("TQQQ")
            self.assertEqual(state.status, "ACTIVE")
            self.assertGreater(len(state.conditional_orders), 0)
        finally:
            tempdir.cleanup()

    def test_compression_never_changes_v_g_band_or_pool(self):
        # Same G/band_pct/pool for a small (uncompressed) vs. a huge
        # (heavily compressed) position -- V/G/band_pct/lower_band/
        # upper_band/pool_start must be identical either way; only the
        # number of registered broker orders differs.
        small_broker = IntegratedFakeBroker()
        small_service, small_tempdir = _make_service(small_broker)
        big_broker = IntegratedFakeBroker()
        big_service, big_tempdir = _make_service(big_broker)
        try:
            small_broker.holdings["TQQQ"] = ("10", "105")
            small_broker.prices["TQQQ"] = "110"
            small_service.vr_initialize("TQQQ", Decimal("1000"), Decimal("10"), Decimal("15"))
            small_cycle = small_service.vr_store.load("TQQQ").current_cycle

            big_broker.holdings["TQQQ"] = ("500", "105")
            big_broker.prices["TQQQ"] = "110"
            big_service.vr_initialize("TQQQ", Decimal("1000"), Decimal("10"), Decimal("15"))
            big_cycle = big_service.vr_store.load("TQQQ").current_cycle

            # V differs (different qty x price), but G/band_pct/pool_start
            # -- and the band-computation relationship -- are the policy
            # inputs unaffected by compression.
            self.assertEqual(small_cycle.G, big_cycle.G)
            self.assertEqual(small_cycle.band_pct, big_cycle.band_pct)
            self.assertEqual(small_cycle.pool_start, big_cycle.pool_start)
            self.assertEqual(small_cycle.lower_band, small_cycle.V * Decimal("0.85"))
            self.assertEqual(big_cycle.lower_band, big_cycle.V * Decimal("0.85"))
            big_broker_orders = len(big_service.vr_store.load("TQQQ").conditional_orders)
            small_broker_orders = len(small_service.vr_store.load("TQQQ").conditional_orders)
            self.assertLessEqual(big_broker_orders, 40)
            self.assertLess(small_broker_orders, big_broker_orders)
        finally:
            small_tempdir.cleanup()
            big_tempdir.cleanup()

    def test_initializing_on_a_friday_never_produces_a_zero_day_first_cycle(self):
        # Regression: anchor_friday_on_or_after(today) returns today when
        # today is itself a Friday, which used to make cycle 1's
        # end_session equal start_session -- a same-day transition. Found
        # live on 2026-08-21 (a Friday) when TQQQ was switched to VR_SKILL.
        broker = IntegratedFakeBroker()
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            friday = datetime(2026, 8, 21, 3, 0, tzinfo=timezone.utc)
            self.assertEqual(friday.date().weekday(), 4)  # sanity: is a Friday
            service.vr_initialize("TQQQ", Decimal("1000"), Decimal("10"), Decimal("15"), now=friday)
            state = service.vr_store.load("TQQQ")
            self.assertEqual(state.anchor_friday, "2026-08-28")
            self.assertNotEqual(state.current_cycle.end_session, state.current_cycle.start_session)
            self.assertEqual(state.current_cycle.start_session, "2026-08-21")
            self.assertEqual(state.current_cycle.end_session, "2026-08-28")
            for order in state.conditional_orders:
                self.assertEqual(order.expire_date, "2026-08-28")
        finally:
            tempdir.cleanup()


class StrategyIsolationTests(unittest.TestCase):
    def test_vr_tick_never_touches_mumae_state_and_vice_versa(self):
        broker = IntegratedFakeBroker()
        service, tempdir = _make_service(broker)
        try:
            set_strategy_type(service.runtime, "TQQQ", "VR_SKILL")
            set_strategy_type(service.runtime, "SOXL", "MUMAE")
            service.runtime_store.save(service.runtime)

            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            service.vr_initialize("TQQQ", Decimal("1000"), Decimal("10"), Decimal("15"))

            mumae_state_before = service.store.load("SOXL")

            # Run the VR-only sync path directly (mirrors what auto_tick's
            # branch does for a VR symbol) and confirm SOXL's MUMAE state
            # file is untouched.
            service.vr_refresh_account("TQQQ")
            service.vr_sync_orders("TQQQ")

            mumae_state_after = service.store.load("SOXL")
            self.assertEqual(mumae_state_before, mumae_state_after)

            # And the reverse: MUMAE's own refresh_account/sync_orders for
            # SOXL must never write to vr_state.json for TQQQ.
            vr_state_before = service.vr_store.load("TQQQ")
            broker.holdings["SOXL"] = ("0", "0")
            broker.prices["SOXL"] = "25"
            try:
                service.refresh_account("SOXL")
                service.sync_orders("SOXL")
            except Exception:
                pass
            vr_state_after = service.vr_store.load("TQQQ")
            self.assertEqual(vr_state_before, vr_state_after)
        finally:
            tempdir.cleanup()


class ExactlyOnceFillTests(unittest.TestCase):
    def _init(self, broker):
        service, tempdir = _make_service(broker)
        broker.holdings["TQQQ"] = ("100", "105")
        broker.prices["TQQQ"] = "110"
        service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
        return service, tempdir

    def test_buy_fill_decreases_pool_exactly_once_even_if_synced_twice(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            buy_order = next(o for o in state.conditional_orders if o.side == "buy")
            broker.trigger_and_fill(buy_order.conditional_order_id, quantity=5)

            service.vr_sync_orders("TQQQ")
            pool_after_first_sync = service.vr_store.load("TQQQ").current_cycle.pool_current

            service.vr_sync_orders("TQQQ")
            pool_after_second_sync = service.vr_store.load("TQQQ").current_cycle.pool_current

            self.assertEqual(pool_after_first_sync, pool_after_second_sync)
            self.assertLess(pool_after_first_sync, Decimal("2000"))
        finally:
            tempdir.cleanup()

    def test_sell_fill_increases_pool_exactly_once(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            sell_order = next((o for o in state.conditional_orders if o.side == "sell"), None)
            if sell_order is None:
                self.skipTest("no sell leg planned for this fixture")
            broker.trigger_and_fill(sell_order.conditional_order_id, quantity=3)

            service.vr_sync_orders("TQQQ")
            pool_after_first = service.vr_store.load("TQQQ").current_cycle.pool_current
            service.vr_sync_orders("TQQQ")
            pool_after_second = service.vr_store.load("TQQQ").current_cycle.pool_current

            self.assertEqual(pool_after_first, pool_after_second)
            self.assertGreater(pool_after_first, Decimal("2000"))
        finally:
            tempdir.cleanup()


class CompressedLegFillBookkeepingTests(unittest.TestCase):
    """Compression means SELL/BUY legs can have quantity > 1 -- Pool
    bookkeeping must never assume quantity == 1, and CANCELED/REJECTED
    orders must still have any partial fill applied (real Toss schema:
    execution.filledQuantity can be nonzero even for CANCELED/REJECTED)."""

    def _init_with_compressed_sell_ladder(self, broker):
        service, tempdir = _make_service(broker)
        broker.holdings["TQQQ"] = ("200", "105")  # forces > 20 logical SELL rungs
        broker.prices["TQQQ"] = "110"
        service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
        state = service.vr_store.load("TQQQ")
        sell_orders = [o for o in state.conditional_orders if o.side == "sell"]
        self.assertEqual(len(sell_orders), 20, "fixture expects the sell ladder to be compressed to 20")
        compressed_leg = next(o for o in sell_orders if o.quantity > 1)
        return service, tempdir, compressed_leg

    def test_full_fill_on_a_compressed_leg_applies_its_whole_quantity(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir, leg = self._init_with_compressed_sell_ladder(broker)
        try:
            pool_before = service.vr_store.load("TQQQ").current_cycle.pool_current
            broker.trigger_and_fill(leg.conditional_order_id, quantity=leg.quantity)

            service.vr_sync_orders("TQQQ")

            pool_after = service.vr_store.load("TQQQ").current_cycle.pool_current
            self.assertEqual(pool_after - pool_before, Decimal(leg.quantity) * leg.trigger_price)
        finally:
            tempdir.cleanup()

    def test_partial_fill_then_canceled_applies_only_the_partial_quantity(self):
        # Regression: CANCELED previously never checked execution.
        # filledQuantity at all, silently dropping any partial fill's real
        # Pool impact.
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir, leg = self._init_with_compressed_sell_ladder(broker)
        try:
            self.assertGreater(leg.quantity, 1)
            partial = leg.quantity - 1
            pool_before = service.vr_store.load("TQQQ").current_cycle.pool_current
            broker.trigger_partial_fill_then_cancel(leg.conditional_order_id, leg.quantity, filled_quantity=partial)

            service.vr_sync_orders("TQQQ")

            state = service.vr_store.load("TQQQ")
            pool_after = state.current_cycle.pool_current
            self.assertEqual(pool_after - pool_before, Decimal(partial) * leg.trigger_price)
            updated_leg = next(o for o in state.conditional_orders if o.client_order_id == leg.client_order_id)
            self.assertEqual(updated_leg.status, "REJECTED")
        finally:
            tempdir.cleanup()

    def test_rejected_with_zero_fill_never_touches_pool(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir, leg = self._init_with_compressed_sell_ladder(broker)
        try:
            pool_before = service.vr_store.load("TQQQ").current_cycle.pool_current
            broker.trigger_partial_fill_then_cancel(leg.conditional_order_id, leg.quantity, filled_quantity=0)

            service.vr_sync_orders("TQQQ")

            pool_after = service.vr_store.load("TQQQ").current_cycle.pool_current
            self.assertEqual(pool_after, pool_before)
        finally:
            tempdir.cleanup()

    def test_partial_fill_then_canceled_is_applied_exactly_once_across_repeated_syncs(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir, leg = self._init_with_compressed_sell_ladder(broker)
        try:
            partial = leg.quantity - 1
            broker.trigger_partial_fill_then_cancel(leg.conditional_order_id, leg.quantity, filled_quantity=partial)

            service.vr_sync_orders("TQQQ")
            pool_after_first = service.vr_store.load("TQQQ").current_cycle.pool_current
            service.vr_sync_orders("TQQQ")
            pool_after_second = service.vr_store.load("TQQQ").current_cycle.pool_current

            self.assertEqual(pool_after_first, pool_after_second)
        finally:
            tempdir.cleanup()


class RearmTests(unittest.TestCase):
    """Book Ladder execution policy: the cycle's full BUY/SELL order table
    is armed once at cycle start and stays fixed for the whole 2-week
    cycle. A fill updates Pool but never cancels or recomputes any other
    rung -- there is no rearm (replaces the old V-restore policy's
    cancel-sibling-and-recompute behavior)."""

    def test_fill_never_cancels_or_recomputes_sibling_rungs(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            state = service.vr_store.load("TQQQ")
            buy_order = next(o for o in state.conditional_orders if o.side == "buy")
            other_orders = [o for o in state.conditional_orders if o.conditional_order_id != buy_order.conditional_order_id]
            open_ids_before = {o.conditional_order_id for o in other_orders}

            broker.holdings["TQQQ"] = ("101", "105")  # the buy fill changed the position
            broker.trigger_and_fill(buy_order.conditional_order_id, quantity=1)
            service.vr_sync_orders("TQQQ")

            new_state = service.vr_store.load("TQQQ")
            # Every sibling rung is untouched: still OPEN, same trigger
            # price/quantity/conditionalOrderId as before the fill -- no
            # cancel-and-recompute happened.
            for stale in other_orders:
                match = next(o for o in new_state.conditional_orders if o.client_order_id == stale.client_order_id)
                self.assertEqual(match.status, "OPEN")
                self.assertEqual(match.conditional_order_id, stale.conditional_order_id)
                self.assertEqual(match.trigger_price, stale.trigger_price)
            # No new orders were created at the broker as a side effect of
            # the fill (the ladder was fully armed at cycle start).
            still_open_ids = {o.conditional_order_id for o in new_state.conditional_orders if o.status == "OPEN"}
            self.assertEqual(still_open_ids, open_ids_before)
        finally:
            tempdir.cleanup()

    def test_partial_fill_does_not_rearm(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            state = service.vr_store.load("TQQQ")
            buy_order = next(o for o in state.conditional_orders if o.side == "buy")

            row = broker.conditional_orders[buy_order.conditional_order_id]
            row["status"] = "ORDERED"
            row["first"]["status"] = "ORDERED"
            row["first"]["triggeredOrderId"] = "reg-partial"
            broker.open_orders.append({
                "orderId": "reg-partial", "symbol": "TQQQ", "side": "BUY",
                "status": "PARTIALLY_FILLED", "quantity": "10",
                "execution": {"filledQuantity": "3"},
            })

            service.vr_sync_orders("TQQQ")
            after = service.vr_store.load("TQQQ")
            still_open = next(o for o in after.conditional_orders if o.client_order_id == buy_order.client_order_id)
            self.assertEqual(still_open.status, "OPEN")
            self.assertEqual(after.current_cycle.pool_current, Decimal("2000"))
        finally:
            tempdir.cleanup()


class ConditionalOrderLifecycleAndFailClosedTests(unittest.TestCase):
    """Spec 13-3: each named lifecycle state of a triggered conditional
    order, verified against the real schema. Spec 13-2: unexpected
    status/fields fail closed into UNKNOWN_CONDITIONAL_STATUS rather than
    being guessed at, blocking new VR orders for that symbol."""

    def _init(self, broker):
        service, tempdir = _make_service(broker)
        broker.holdings["TQQQ"] = ("100", "105")
        broker.prices["TQQQ"] = "110"
        service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
        return service, tempdir

    def test_active_watching_leaves_order_untouched(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            before = service.vr_store.load("TQQQ")
            service.vr_sync_orders("TQQQ")
            after = service.vr_store.load("TQQQ")
            self.assertEqual(before.conditional_orders, after.conditional_orders)
        finally:
            tempdir.cleanup()

    def test_condition_met_but_no_triggered_order_id_yet_stays_open(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["status"] = "ORDERING"
            row["first"]["status"] = "ORDERING"
            # triggeredOrderId still null -- condition met, order not
            # created yet.
            service.vr_sync_orders("TQQQ")
            after = service.vr_store.load("TQQQ")
            still = next(o for o in after.conditional_orders if o.client_order_id == order.client_order_id)
            self.assertEqual(still.status, "OPEN")
            self.assertIsNone(still.triggered_order_id)
        finally:
            tempdir.cleanup()

    def test_triggered_order_id_present_but_regular_order_not_yet_synced(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["status"] = "ORDERED"
            row["first"]["status"] = "ORDERED"
            row["first"]["triggeredOrderId"] = "reg-not-yet-visible"
            # Deliberately do NOT add it to broker.open_orders/closed_orders
            # -- simulates a race where the regular order isn't in the
            # order-history window yet.
            service.vr_sync_orders("TQQQ")
            after = service.vr_store.load("TQQQ")
            still = next(o for o in after.conditional_orders if o.client_order_id == order.client_order_id)
            self.assertEqual(still.status, "OPEN")
            self.assertEqual(still.triggered_order_id, "reg-not-yet-visible")
            self.assertEqual(after.current_cycle.pool_current, Decimal("2000"))
        finally:
            tempdir.cleanup()

    def test_regular_order_pending_leaves_pool_untouched(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["status"] = "ORDERED"
            row["first"]["status"] = "ORDERED"
            row["first"]["triggeredOrderId"] = "reg-pending"
            broker.open_orders.append({
                "orderId": "reg-pending", "symbol": "TQQQ", "side": order.side.upper(),
                "status": "PENDING", "quantity": "5", "execution": {},
            })
            service.vr_sync_orders("TQQQ")
            after = service.vr_store.load("TQQQ")
            self.assertEqual(after.current_cycle.pool_current, Decimal("2000"))
        finally:
            tempdir.cleanup()

    def test_regular_order_canceled_marks_leg_rejected_without_pool_change(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["status"] = "ORDERED"
            row["first"]["status"] = "ORDERED"
            row["first"]["triggeredOrderId"] = "reg-canceled"
            broker.closed_orders.append({
                "orderId": "reg-canceled", "symbol": "TQQQ", "side": order.side.upper(),
                "status": "CANCELED", "quantity": "5", "execution": {},
            })
            service.vr_sync_orders("TQQQ")
            after = service.vr_store.load("TQQQ")
            updated = next(o for o in after.conditional_orders if o.client_order_id == order.client_order_id)
            self.assertEqual(updated.status, "REJECTED")
            self.assertEqual(after.current_cycle.pool_current, Decimal("2000"))
        finally:
            tempdir.cleanup()

    def test_regular_order_rejected_marks_leg_rejected_without_pool_change(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["status"] = "ORDERED"
            row["first"]["status"] = "ORDERED"
            row["first"]["triggeredOrderId"] = "reg-rejected"
            broker.closed_orders.append({
                "orderId": "reg-rejected", "symbol": "TQQQ", "side": order.side.upper(),
                "status": "REJECTED", "quantity": "5", "execution": {},
            })
            service.vr_sync_orders("TQQQ")
            after = service.vr_store.load("TQQQ")
            updated = next(o for o in after.conditional_orders if o.client_order_id == order.client_order_id)
            self.assertEqual(updated.status, "REJECTED")
            self.assertEqual(after.current_cycle.pool_current, Decimal("2000"))
        finally:
            tempdir.cleanup()

    def test_unknown_leg_status_fails_closed(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["first"]["status"] = "SOMETHING_NEW"

            result = service.vr_sync_orders("TQQQ")

            self.assertTrue(result.get("blocked"))
            after = service.vr_store.load("TQQQ")
            self.assertEqual(after.status, "UNKNOWN_CONDITIONAL_STATUS")
            self.assertIn("SOMETHING_NEW", after.blocked_reason)
            # Pool must be untouched -- nothing was guessed at.
            self.assertEqual(after.current_cycle.pool_current, Decimal("2000"))
        finally:
            tempdir.cleanup()

    def test_malformed_filled_quantity_fails_closed(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["status"] = "ORDERED"
            row["first"]["status"] = "ORDERED"
            row["first"]["triggeredOrderId"] = "reg-malformed"
            broker.closed_orders.append({
                "orderId": "reg-malformed", "symbol": "TQQQ", "side": order.side.upper(),
                "status": "FILLED", "quantity": "5",
                "execution": {"filledQuantity": "not-a-number"},
            })

            result = service.vr_sync_orders("TQQQ")

            self.assertTrue(result.get("blocked"))
            after = service.vr_store.load("TQQQ")
            self.assertEqual(after.status, "UNKNOWN_CONDITIONAL_STATUS")
            self.assertEqual(after.current_cycle.pool_current, Decimal("2000"))
        finally:
            tempdir.cleanup()

    def test_unrecognized_side_on_the_triggered_order_fails_closed(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["status"] = "ORDERED"
            row["first"]["status"] = "ORDERED"
            row["first"]["triggeredOrderId"] = "reg-badside"
            broker.closed_orders.append({
                "orderId": "reg-badside", "symbol": "TQQQ", "side": "SIDEWAYS",
                "status": "FILLED", "quantity": "5",
                "execution": {"filledQuantity": "5"},
            })

            result = service.vr_sync_orders("TQQQ")

            self.assertTrue(result.get("blocked"))
            after = service.vr_store.load("TQQQ")
            self.assertEqual(after.status, "UNKNOWN_CONDITIONAL_STATUS")
        finally:
            tempdir.cleanup()

    def test_blocked_symbol_never_triggers_new_orders_on_auto_tick(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._init(broker)
        try:
            state = service.vr_store.load("TQQQ")
            order = state.conditional_orders[0]
            row = broker.conditional_orders[order.conditional_order_id]
            row["first"]["status"] = "SOMETHING_NEW"
            service.vr_sync_orders("TQQQ")

            open_orders_before = len(broker.conditional_orders)
            service.vr_auto_tick_for_symbol("TQQQ", now=datetime(2026, 8, 21, 20, 1, tzinfo=timezone.utc))
            self.assertEqual(len(broker.conditional_orders), open_orders_before)
        finally:
            tempdir.cleanup()


def _restart_service(tempdir, broker):
    """Simulate a process restart: a brand-new TradingWebService reading
    from the same on-disk data dir, sharing the SAME broker instance (Toss's
    own server-side state persists across our process restart; only our
    local process memory is lost)."""
    return TradingWebService(Path(tempdir.name), broker_factory=lambda: broker)


class CompressedLegRestartRecoveryTests(unittest.TestCase):
    def test_logical_range_and_quantity_survive_a_restart(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("500", "105")  # forces compression
            broker.prices["TQQQ"] = "110"
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            before = {o.client_order_id: (o.quantity, o.logical_start_rung, o.logical_end_rung)
                      for o in service.vr_store.load("TQQQ").conditional_orders}
            self.assertTrue(any(q > 1 for q, _s, _e in before.values()), "fixture expects at least one compressed leg")

            restarted = _restart_service(tempdir, broker)
            after = {o.client_order_id: (o.quantity, o.logical_start_rung, o.logical_end_rung)
                     for o in restarted.vr_store.load("TQQQ").conditional_orders}

            self.assertEqual(before, after)
        finally:
            tempdir.cleanup()


class CrashRecoveryMatrixTests(unittest.TestCase):
    """Spec 13-4: force a crash at each named point in the cycle-transition
    procedure, restart, and verify: no duplicate orders, no double Pool
    application, no duplicate cycle, no stale old-cycle orders, no missing
    new-cycle orders. Point letters follow the spec's own A-K matrix; where
    this implementation's actual code ordering makes two spec points
    behaviorally identical (see vr_web_service.py's _vr_run_transition/
    _vr_finish_transition), the tests are consolidated and say so.
    """

    def _setup_due_cycle(self, broker):
        service, tempdir = _make_service(broker)
        broker.holdings["TQQQ"] = ("100", "105")
        broker.prices["TQQQ"] = "110"
        broker.candles["TQQQ"] = [{"date": "2026-08-07", "closePrice": "112"}]
        service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
        state = service.vr_store.load("TQQQ")
        state.current_cycle.end_session = "2026-08-07"
        state.anchor_friday = "2026-08-07"
        service.vr_store.save(state)
        return service, tempdir

    def test_point_a_crash_before_any_cancel_request(self):
        # Nothing has happened yet -- resuming is just a normal first
        # attempt. Included for traceability against the spec's matrix.
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._setup_due_cycle(broker)
        try:
            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)
            state = service.vr_store.load("TQQQ")
            self.assertEqual(state.status, "ACTIVE")
            self.assertEqual(state.current_cycle.cycle_id, "TQQQ-c2")
        finally:
            tempdir.cleanup()

    def test_point_b_crash_after_some_but_not_all_cancellations(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._setup_due_cycle(broker)
        try:
            state = service.vr_store.load("TQQQ")
            self.assertGreater(len(state.conditional_orders), 1, "fixture expects a multi-rung ladder armed")
            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)

            broker.crash_after_cancel_count = 1  # first DELETE succeeds, second crashes
            with self.assertRaises(ConnectionError):
                service.vr_auto_tick_for_symbol("TQQQ", now=now)

            # "Restart": fresh service, same broker, crash trigger cleared.
            broker.crash_after_cancel_count = None
            service = _restart_service(tempdir, broker)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.status, "ACTIVE")
            self.assertEqual(final_state.current_cycle.cycle_id, "TQQQ-c2")
            self.assertEqual(len(final_state.history), 1, "cycle must not be duplicated in history")
            open_orders = [o for o in final_state.conditional_orders if o.status == "OPEN"]
            self.assertEqual(len(open_orders), len(broker.conditional_orders), "no stale/duplicate live orders")
        finally:
            tempdir.cleanup()

    def test_point_c_and_d_crash_after_all_cancellations_before_stage_save(self):
        # Spec points C ("모든 취소 요청 후, 확인 전") and D ("모든 취소 확인
        # 후, state 저장 전") are indistinguishable in this implementation:
        # cancel_and_confirm() is a single synchronous DELETE per order, so
        # there is no separately observable "requested but not confirmed"
        # state -- either the call returned (confirmed) or it didn't
        # happen. Both collapse to "all cancels already succeeded at Toss,
        # but the in-progress marker was never persisted" -- simulated here
        # by making the FIRST vr_store.save() call (the in-progress marker)
        # raise, after every DELETE has already gone through.
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._setup_due_cycle(broker)
        try:
            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)
            original_save = service.vr_store.save

            def crash_on_first_save(saved_state):
                raise ConnectionError("simulated crash right after cancellation, before any save")

            service.vr_store.save = crash_on_first_save
            with self.assertRaises(ConnectionError):
                service.vr_auto_tick_for_symbol("TQQQ", now=now)
            self.assertEqual(len(broker.conditional_orders), 0, "all legs really were cancelled at Toss")

            # The crash happened before any local save, so state.json still
            # shows the stale pre-transition snapshot.
            stale = original_save.__self__.load("TQQQ")
            self.assertEqual(stale.status, "ACTIVE")
            self.assertTrue(all(o.status == "OPEN" for o in stale.conditional_orders))

            service = _restart_service(tempdir, broker)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.status, "ACTIVE")
            self.assertEqual(final_state.current_cycle.cycle_id, "TQQQ-c2")
            self.assertEqual(len(final_state.history), 1)
        finally:
            tempdir.cleanup()

    def test_point_e_crash_right_after_in_progress_marker_saved(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._setup_due_cycle(broker)
        try:
            state = service.vr_store.load("TQQQ")
            # Simulate: cancellation already fully confirmed and the
            # in-progress marker already persisted (matches what
            # _vr_run_transition does right before calling
            # _vr_finish_transition), then the process dies.
            for order in list(state.conditional_orders):
                broker.conditional_orders.pop(order.conditional_order_id, None)
            state.conditional_orders = [replace(o, status="CANCELLED") for o in state.conditional_orders]
            state.status = "CYCLE_TRANSITION_IN_PROGRESS"
            service.vr_store.save(state)

            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)
            service = _restart_service(tempdir, broker)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.status, "ACTIVE")
            self.assertEqual(final_state.current_cycle.cycle_id, "TQQQ-c2")
            self.assertEqual(len(final_state.history), 1)
        finally:
            tempdir.cleanup()

    def test_points_f_g_h_crash_during_pure_computation_before_any_new_order(self):
        # Spec points F (fills sync), G (E calculated), H (V_next
        # calculated) all happen inside _vr_finish_transition/
        # transition_cycle's in-memory computation, with zero I/O between
        # them -- there is nothing to persist mid-computation, so a crash
        # anywhere in that span is equivalent to "resume from
        # CYCLE_TRANSITION_IN_PROGRESS with zero new orders created yet."
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._setup_due_cycle(broker)
        try:
            state = service.vr_store.load("TQQQ")
            for order in list(state.conditional_orders):
                broker.conditional_orders.pop(order.conditional_order_id, None)
            state.conditional_orders = [replace(o, status="CANCELLED") for o in state.conditional_orders]
            state.status = "CYCLE_TRANSITION_IN_PROGRESS"
            service.vr_store.save(state)
            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)

            broker.crash_after_create_count = 0  # crash before the first new order
            with self.assertRaises(ConnectionError):
                service.vr_auto_tick_for_symbol("TQQQ", now=now)
            self.assertEqual(len(broker.conditional_orders), 0)

            broker.crash_after_create_count = None
            service = _restart_service(tempdir, broker)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.status, "ACTIVE")
            self.assertEqual(len(final_state.history), 1)
        finally:
            tempdir.cleanup()

    def test_point_i_new_cycle_is_never_persisted_before_its_orders_are_armed(self):
        # Spec point I ("새 cycle state 저장 후, 신규 주문 생성 전") does not
        # exist as a reachable state in this implementation: transition_cycle
        # only returns (and only then does the caller persist) after
        # arm_cycle_orders has already run. This test proves that ordering
        # by crashing mid-arm and checking the on-disk file was never
        # touched with a half-new cycle in between.
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._setup_due_cycle(broker)
        try:
            state = service.vr_store.load("TQQQ")
            for order in list(state.conditional_orders):
                broker.conditional_orders.pop(order.conditional_order_id, None)
            state.conditional_orders = [replace(o, status="CANCELLED") for o in state.conditional_orders]
            state.status = "CYCLE_TRANSITION_IN_PROGRESS"
            service.vr_store.save(state)
            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)

            broker._create_count = 0
            broker.crash_after_create_count = 1
            with self.assertRaises(ConnectionError):
                service.vr_auto_tick_for_symbol("TQQQ", now=now)

            # Exactly one order was created at Toss, but state.json must
            # still show the OLD cycle (c1) -- never a half-updated c2.
            mid_crash = service.vr_store.load("TQQQ")
            self.assertEqual(mid_crash.status, "CYCLE_TRANSITION_IN_PROGRESS")
            self.assertEqual(mid_crash.current_cycle.cycle_id, "TQQQ-c1")
            self.assertEqual(len(broker.conditional_orders), 1)
        finally:
            tempdir.cleanup()

    def test_point_j_crash_after_some_new_orders_created(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._setup_due_cycle(broker)
        try:
            state = service.vr_store.load("TQQQ")
            for order in list(state.conditional_orders):
                broker.conditional_orders.pop(order.conditional_order_id, None)
            state.conditional_orders = [replace(o, status="CANCELLED") for o in state.conditional_orders]
            state.status = "CYCLE_TRANSITION_IN_PROGRESS"
            service.vr_store.save(state)
            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)

            broker._create_count = 0
            broker.crash_after_create_count = 1
            with self.assertRaises(ConnectionError):
                service.vr_auto_tick_for_symbol("TQQQ", now=now)
            created_before_restart = set(broker.conditional_orders)
            self.assertEqual(len(created_before_restart), 1)

            broker.crash_after_create_count = None
            service = _restart_service(tempdir, broker)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.status, "ACTIVE")
            open_orders = [o for o in final_state.conditional_orders if o.status == "OPEN"]
            # Deterministic clientOrderId + Toss's documented idempotency
            # means the pre-crash order is reused, not duplicated.
            self.assertEqual(len(open_orders), len(broker.conditional_orders))
            self.assertTrue(created_before_restart <= set(broker.conditional_orders))
        finally:
            tempdir.cleanup()

    def test_point_k_crash_after_all_new_orders_before_active_save(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = self._setup_due_cycle(broker)
        try:
            state = service.vr_store.load("TQQQ")
            for order in list(state.conditional_orders):
                broker.conditional_orders.pop(order.conditional_order_id, None)
            state.conditional_orders = [replace(o, status="CANCELLED") for o in state.conditional_orders]
            state.status = "CYCLE_TRANSITION_IN_PROGRESS"
            service.vr_store.save(state)
            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)

            original_save = service.vr_store.save
            call_count = {"n": 0}

            def crashing_save(saved_state):
                call_count["n"] += 1
                if call_count["n"] == 1:
                    raise ConnectionError("simulated crash right before the ACTIVE save")
                return original_save(saved_state)

            service.vr_store.save = crashing_save
            with self.assertRaises(ConnectionError):
                service.vr_auto_tick_for_symbol("TQQQ", now=now)
            orders_created_before_crash = set(broker.conditional_orders)
            self.assertGreater(len(orders_created_before_crash), 0)

            service = _restart_service(tempdir, broker)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.status, "ACTIVE")
            open_orders = [o for o in final_state.conditional_orders if o.status == "OPEN"]
            self.assertEqual(len(open_orders), len(broker.conditional_orders))
            # No duplicate orders were created by the retry.
            self.assertEqual(orders_created_before_crash, set(broker.conditional_orders))
        finally:
            tempdir.cleanup()


class CycleTransitionIntegrationTests(unittest.TestCase):
    def test_due_cycle_transitions_exactly_once_across_repeated_ticks(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            broker.candles["TQQQ"] = [{"date": "2026-08-07", "closePrice": "112"}]
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            state = service.vr_store.load("TQQQ")
            state.current_cycle.end_session = "2026-08-07"
            state.anchor_friday = "2026-08-07"
            service.vr_store.save(state)

            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)  # just after 16:00 ET close
            for _ in range(5):
                service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.current_cycle.cycle_id, "TQQQ-c2")
            self.assertEqual(len(final_state.history), 1)
        finally:
            tempdir.cleanup()

    def test_restart_mid_transition_resumes_without_recancelling(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            broker.candles["TQQQ"] = [{"date": "2026-08-07", "closePrice": "112"}]
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            state = service.vr_store.load("TQQQ")
            state.current_cycle.end_session = "2026-08-07"
            state.anchor_friday = "2026-08-07"
            # Simulate a crash that happened exactly after cancellation was
            # confirmed but before the new cycle was created.
            state.status = "CYCLE_TRANSITION_IN_PROGRESS"
            state.conditional_orders = [o for o in state.conditional_orders]
            service.vr_store.save(state)

            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)

            resumed = service.vr_store.load("TQQQ")
            self.assertEqual(resumed.status, "ACTIVE")
            self.assertEqual(resumed.current_cycle.cycle_id, "TQQQ-c2")
        finally:
            tempdir.cleanup()

    def test_one_symbols_blocked_transition_does_not_affect_another_symbol(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            for symbol, qty, price in (("TQQQ", "100", "110"), ("SOXL", "50", "25")):
                broker.holdings[symbol] = (qty, "20")
                broker.prices[symbol] = price
            broker.candles["TQQQ"] = [{"date": "2026-08-07", "closePrice": "112"}]
            # SOXL deliberately has no candle for the close date -> blocked.
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            service.vr_initialize("SOXL", Decimal("500"), Decimal("10"), Decimal("15"))
            for symbol in ("TQQQ", "SOXL"):
                state = service.vr_store.load(symbol)
                state.current_cycle.end_session = "2026-08-07"
                state.anchor_friday = "2026-08-07"
                service.vr_store.save(state)

            now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)
            service.vr_auto_tick_for_symbol("SOXL", now=now)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)

            soxl_state = service.vr_store.load("SOXL")
            tqqq_state = service.vr_store.load("TQQQ")
            self.assertEqual(soxl_state.status, "CYCLE_TRANSITION_BLOCKED")
            self.assertEqual(tqqq_state.status, "ACTIVE")
            self.assertEqual(tqqq_state.current_cycle.cycle_id, "TQQQ-c2")
        finally:
            tempdir.cleanup()


class StopSemanticsTests(unittest.TestCase):
    def test_stop_prevents_new_orders_but_keeps_syncing(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            service.vr_stop("TQQQ")

            state = service.vr_store.load("TQQQ")
            self.assertEqual(state.status, "STOPPED")
            open_before = [o.conditional_order_id for o in state.conditional_orders if o.status == "OPEN"]
            self.assertGreater(len(open_before), 0)

            buy_order = next(o for o in state.conditional_orders if o.side == "buy")
            broker.trigger_and_fill(buy_order.conditional_order_id, quantity=5)
            service.vr_refresh_account("TQQQ")
            service.vr_sync_orders("TQQQ")

            after = service.vr_store.load("TQQQ")
            filled = next(o for o in after.conditional_orders if o.client_order_id == buy_order.client_order_id)
            self.assertEqual(filled.status, "FILLED")
            self.assertLess(after.current_cycle.pool_current, Decimal("2000"))

            end_session = date.fromisoformat(after.current_cycle.end_session)
            now = datetime.combine(end_session, datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=20)
            service.vr_auto_tick_for_symbol("TQQQ", now=now)
            due_state = service.vr_store.load("TQQQ")
            self.assertEqual(due_state.status, "CYCLE_DUE_STOPPED")
            self.assertEqual(due_state.current_cycle.cycle_id, after.current_cycle.cycle_id)
        finally:
            tempdir.cleanup()


class StrategySwitchSafetyTests(unittest.TestCase):
    def test_switch_is_blocked_while_vr_conditional_orders_are_open(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            set_strategy_type(service.runtime, "TQQQ", "VR_SKILL")
            service.runtime_store.save(service.runtime)
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))

            with self.assertRaises(ValueError):
                service.vr_set_strategy_type("TQQQ", "MUMAE")
            self.assertEqual(get_strategy_type(service.runtime, "TQQQ"), "VR_SKILL")
        finally:
            tempdir.cleanup()

    def test_switch_succeeds_once_no_open_orders_remain(self):
        broker = IntegratedFakeBroker()
        service, tempdir = _make_service(broker)
        try:
            set_strategy_type(service.runtime, "TQQQ", "VR_SKILL")
            service.runtime_store.save(service.runtime)
            # No VR init -> no open conditional orders; MUMAE sync never ran
            # -> pending_order_count is 0 by construction.
            service.vr_set_strategy_type("TQQQ", "MUMAE")
            self.assertEqual(get_strategy_type(service.runtime, "TQQQ"), "MUMAE")
        finally:
            tempdir.cleanup()

    def test_switching_to_vr_skill_stops_mumaes_active_symbols_flag(self):
        # Regression: found live on 2026-08-21 -- MUMAE's active_symbols
        # ("running") flag is separate state from strategy_type and used to
        # survive a switch to VR_SKILL untouched, letting auto_tick's MUMAE
        # order-submission loop keep firing for the symbol.
        broker = IntegratedFakeBroker()
        service, tempdir = _make_service(broker)
        try:
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            service.runtime_store.save(service.runtime)
            self.assertIn("TQQQ", service.runtime.active_symbols)

            service.vr_set_strategy_type("TQQQ", "VR_SKILL")

            self.assertNotIn("TQQQ", service.runtime.active_symbols)
            self.assertEqual(get_strategy_type(service.runtime, "TQQQ"), "VR_SKILL")
        finally:
            tempdir.cleanup()


def _capacity(verified_max):
    return vr_execution_policy.ConditionalOrderCapacity(
        verified_max=verified_max,
        scope=vr_execution_policy.CAPACITY_SCOPE_ACCOUNT if verified_max is not None else vr_execution_policy.CAPACITY_SCOPE_UNKNOWN,
        verified_at="2026-08-21" if verified_max is not None else None,
        source="test" if verified_max is not None else None,
    )


class BrokerCapacityGateTests(unittest.TestCase):
    """vr_execution_policy.VERIFIED_CAPACITY.verified_max gates arming a
    ladder on a LIVE broker -- Toss's real open-conditional-order capacity
    is not documented, so None (unverified) must fail closed rather than
    guess or silently truncate."""

    def test_vr_initialize_raises_and_persists_a_capacity_unknown_blocked_state(self):
        with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(None)):
            broker = IntegratedFakeBroker(mode="LIVE")
            service, tempdir = _make_service(broker)
            try:
                broker.holdings["TQQQ"] = ("100", "105")
                broker.prices["TQQQ"] = "110"
                with self.assertRaises(BrokerCapacityUnknownError):
                    service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
                state = service.vr_store.load("TQQQ")
                # V/band are kept visible (not discarded) even though the
                # ladder itself never armed.
                self.assertEqual(state.status, "BROKER_CONDITIONAL_CAPACITY_UNKNOWN")
                self.assertIsNotNone(state.current_cycle)
                self.assertIsNotNone(state.blocked_reason)
                self.assertEqual(state.conditional_orders, [])
                self.assertEqual(state.capacity_blocker["verified_capacity"], None)
                self.assertEqual(
                    state.capacity_blocker["total_count"],
                    state.capacity_blocker["buy_count"] + state.capacity_blocker["sell_count"],
                )
                self.assertGreater(state.capacity_blocker["total_count"], 0)
            finally:
                tempdir.cleanup()

    def test_vr_initialize_raises_a_capacity_exceeded_error_with_a_small_verified_cap(self):
        with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(2)):
            broker = IntegratedFakeBroker(mode="LIVE")
            service, tempdir = _make_service(broker)
            try:
                broker.holdings["TQQQ"] = ("100", "105")  # ladder needs far more than 2 legs
                broker.prices["TQQQ"] = "110"
                with self.assertRaises(BrokerCapacityExceededError):
                    service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
                state = service.vr_store.load("TQQQ")
                self.assertEqual(state.status, "BROKER_CONDITIONAL_CAPACITY_EXCEEDED")
                self.assertEqual(state.capacity_blocker["verified_capacity"], 2)
                self.assertGreater(state.capacity_blocker["total_count"], 2)
            finally:
                tempdir.cleanup()

    def test_capacity_check_uses_the_compressed_broker_count_not_the_logical_count(self):
        # Regression: before compression, a large position (e.g. 500
        # shares -> ~500 logical SELL rungs) needed verified_max >= ~500.
        # After compression, arming ANY position size never needs more than
        # 2 * MAX_BROKER_ORDERS_PER_SIDE = 40 broker orders.
        with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(40)):
            broker = IntegratedFakeBroker(mode="LIVE")
            service, tempdir = _make_service(broker)
            try:
                broker.holdings["TQQQ"] = ("500", "105")  # huge logical ladder
                broker.prices["TQQQ"] = "110"
                result = service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
                self.assertEqual(result["status"], "ACTIVE")
                state = service.vr_store.load("TQQQ")
                broker_count = len(state.conditional_orders)
                self.assertLessEqual(broker_count, 40)
                logical_sell_count = max(o.logical_end_rung for o in state.conditional_orders if o.side == "sell")
                self.assertGreater(logical_sell_count, 40, "sanity: the logical ladder really was larger than capacity")
            finally:
                tempdir.cleanup()

    def test_dry_run_ignores_the_capacity_gate(self):
        # DRY_RUN never reaches the broker for create/cancel, so the full
        # logical ladder can still be planned and tested even with capacity
        # unverified -- only a LIVE broker is gated.
        with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(None)):
            broker = IntegratedFakeBroker(mode="DRY_RUN")
            service, tempdir = _make_service(broker)
            try:
                broker.holdings["TQQQ"] = ("100", "105")
                broker.prices["TQQQ"] = "110"
                result = service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
                self.assertEqual(result["status"], "ACTIVE")
                state = service.vr_store.load("TQQQ")
                self.assertGreater(len(state.conditional_orders), 2)
            finally:
                tempdir.cleanup()

    def test_cycle_transition_blocks_with_a_dedicated_status_when_capacity_unverified(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            broker.candles["TQQQ"] = [{"date": "2026-08-07", "closePrice": "112"}]
            with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(1000)):
                service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            state = service.vr_store.load("TQQQ")
            state.current_cycle.end_session = "2026-08-07"
            state.anchor_friday = "2026-08-07"
            service.vr_store.save(state)

            with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(None)):
                now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)
                service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.status, "BROKER_CONDITIONAL_CAPACITY_UNKNOWN")
            self.assertIsNotNone(final_state.blocked_reason)
            self.assertEqual(final_state.capacity_blocker["verified_capacity"], None)
            self.assertGreater(final_state.capacity_blocker["total_count"], 0)
            # The old cycle's orders were already cancelled before arming
            # the new ladder was attempted -- this symbol now has none.
            self.assertEqual([o for o in final_state.conditional_orders if o.status == "OPEN"], [])
        finally:
            tempdir.cleanup()

    def test_cycle_transition_blocks_as_exceeded_when_capacity_is_verified_but_too_small(self):
        broker = IntegratedFakeBroker(mode="LIVE")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            broker.candles["TQQQ"] = [{"date": "2026-08-07", "closePrice": "112"}]
            with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(1000)):
                service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            state = service.vr_store.load("TQQQ")
            state.current_cycle.end_session = "2026-08-07"
            state.anchor_friday = "2026-08-07"
            service.vr_store.save(state)

            with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(2)):
                now = datetime(2026, 8, 7, 20, 1, tzinfo=timezone.utc)
                service.vr_auto_tick_for_symbol("TQQQ", now=now)

            final_state = service.vr_store.load("TQQQ")
            self.assertEqual(final_state.status, "BROKER_CONDITIONAL_CAPACITY_EXCEEDED")
            self.assertEqual(final_state.capacity_blocker["verified_capacity"], 2)
            self.assertGreater(final_state.capacity_blocker["total_count"], 2)
        finally:
            tempdir.cleanup()


class SellReservationGateTests(unittest.TestCase):
    """vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR gates
    arming any ladder with a nonzero SELL leg count on a LIVE broker,
    separately from (and checked after) the capacity gate -- whether Toss
    actually reserves sellable quantity against concurrent SELL conditional
    orders is undocumented and not yet empirically confirmed."""

    def test_vr_initialize_raises_and_persists_a_sell_reservation_unknown_blocked_state(self):
        with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(1000)), \
             unittest.mock.patch.object(
                 vr_execution_policy, "CONDITIONAL_SELL_RESERVATION_BEHAVIOR",
                 vr_execution_policy.SELL_RESERVATION_UNKNOWN,
             ):
            broker = IntegratedFakeBroker(mode="LIVE")
            service, tempdir = _make_service(broker)
            try:
                broker.holdings["TQQQ"] = ("100", "105")  # produces sell legs
                broker.prices["TQQQ"] = "110"
                with self.assertRaises(SellReservationUnknownError):
                    service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
                state = service.vr_store.load("TQQQ")
                self.assertEqual(state.status, "SELL_RESERVATION_UNKNOWN")
                self.assertIsNotNone(state.current_cycle)
                self.assertEqual(state.conditional_orders, [])
                self.assertGreater(state.sell_reservation_blocker["sell_count"], 0)
            finally:
                tempdir.cleanup()

    def test_capacity_gate_is_checked_before_the_sell_reservation_gate(self):
        # Both unresolved at once -- capacity (the more fundamental gate)
        # must be the one that actually fires.
        with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(None)), \
             unittest.mock.patch.object(
                 vr_execution_policy, "CONDITIONAL_SELL_RESERVATION_BEHAVIOR",
                 vr_execution_policy.SELL_RESERVATION_UNKNOWN,
             ):
            broker = IntegratedFakeBroker(mode="LIVE")
            service, tempdir = _make_service(broker)
            try:
                broker.holdings["TQQQ"] = ("100", "105")
                broker.prices["TQQQ"] = "110"
                with self.assertRaises(BrokerCapacityUnknownError):
                    service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
                state = service.vr_store.load("TQQQ")
                self.assertEqual(state.status, "BROKER_CONDITIONAL_CAPACITY_UNKNOWN")
            finally:
                tempdir.cleanup()

    def test_arm_succeeds_once_sell_reservation_behavior_is_known(self):
        with unittest.mock.patch.object(vr_execution_policy, "VERIFIED_CAPACITY", _capacity(1000)), \
             unittest.mock.patch.object(
                 vr_execution_policy, "CONDITIONAL_SELL_RESERVATION_BEHAVIOR",
                 vr_execution_policy.SELL_RESERVATION_RESERVES_QUANTITY,
             ):
            broker = IntegratedFakeBroker(mode="LIVE")
            service, tempdir = _make_service(broker)
            try:
                broker.holdings["TQQQ"] = ("100", "105")
                broker.prices["TQQQ"] = "110"
                result = service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
                self.assertEqual(result["status"], "ACTIVE")
                state = service.vr_store.load("TQQQ")
                self.assertGreater(len([o for o in state.conditional_orders if o.side == "sell"]), 0)
            finally:
                tempdir.cleanup()

    def test_dry_run_ignores_the_sell_reservation_gate(self):
        with unittest.mock.patch.object(
            vr_execution_policy, "CONDITIONAL_SELL_RESERVATION_BEHAVIOR", vr_execution_policy.SELL_RESERVATION_UNKNOWN,
        ):
            broker = IntegratedFakeBroker(mode="DRY_RUN")
            service, tempdir = _make_service(broker)
            try:
                broker.holdings["TQQQ"] = ("100", "105")
                broker.prices["TQQQ"] = "110"
                result = service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
                self.assertEqual(result["status"], "ACTIVE")
            finally:
                tempdir.cleanup()


class ZeroNetworkCallsTests(unittest.TestCase):
    def test_dry_run_never_calls_real_conditional_order_endpoints(self):
        broker = IntegratedFakeBroker(mode="DRY_RUN")
        service, tempdir = _make_service(broker)
        try:
            broker.holdings["TQQQ"] = ("100", "105")
            broker.prices["TQQQ"] = "110"
            service.vr_initialize("TQQQ", Decimal("2000"), Decimal("10"), Decimal("15"))
            # DRY_RUN create/cancel never reach _request's POST branches, so
            # no conditional order was ever actually registered anywhere.
            self.assertEqual(broker.conditional_orders, {})
        finally:
            tempdir.cleanup()


if __name__ == "__main__":
    unittest.main()
