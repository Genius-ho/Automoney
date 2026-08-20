import json
import unittest
from datetime import date
from decimal import Decimal

from vr_engine import (
    CycleTransitionBlocked,
    cancel_cycle_orders,
    schedule_config,
    transition_cycle,
)
from vr_state_store import VRConditionalOrder, VRCycle, VRState


class FakeConditionalOrderBroker:
    """Same fully in-memory _request simulation used in
    test_vr_execution_policy.py -- zero real network calls."""

    def __init__(self, mode="LIVE"):
        self.mode = mode
        self.live_ack = True
        self.orders: dict[str, dict] = {}
        self.cancelled: set[str] = set()
        self._next_id = 1

    def _account_headers(self):
        return {}

    def _request(self, method, path, data=None, headers=None):
        # Matches the real, verified schema (Phase 13): create nests
        # orderSide under "first"; cancel is DELETE -> 204 (empty dict, no
        # "status" field); list is GET with a required status= query.
        if method == "POST" and path == "/api/v1/conditional-orders":
            payload = json.loads(data)
            conditional_order_id = f"co-{self._next_id}"
            self._next_id += 1
            self.orders[conditional_order_id] = {
                "conditionalOrderId": conditional_order_id,
                "clientOrderId": payload["clientOrderId"],
                "symbol": payload["symbol"], "status": "WATCHING",
                "first": {"status": "WATCHING", "orderSide": payload["first"]["orderSide"], "triggeredOrderId": None},
            }
            return {"result": {"conditionalOrderId": conditional_order_id, "clientOrderId": payload["clientOrderId"]}}
        if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
            conditional_order_id = path.rsplit("/", 1)[-1]
            if conditional_order_id not in self.orders:
                from toss_api import TossApiError
                raise TossApiError("Toss API HTTP 404: not found")
            del self.orders[conditional_order_id]
            self.cancelled.add(conditional_order_id)
            return {}
        if method == "GET" and path.startswith("/api/v1/conditional-orders"):
            symbol = path.split("symbol=")[1].split("&")[0] if "symbol=" in path else None
            rows = [row for row in self.orders.values() if symbol is None or row["symbol"] == symbol]
            return {"result": {"conditionalOrders": rows, "hasNext": False, "nextCursor": None}}
        raise AssertionError(f"unexpected _request call: {method} {path}")

    def seed_order(self, symbol, side, client_order_id, status="WATCHING"):
        conditional_order_id = f"co-{self._next_id}"
        self._next_id += 1
        self.orders[conditional_order_id] = {
            "conditionalOrderId": conditional_order_id, "clientOrderId": client_order_id,
            "symbol": symbol, "status": status,
            "first": {"status": status, "orderSide": side.upper(), "triggeredOrderId": None},
        }
        return conditional_order_id


def _active_state(V="18500", pool="1231.51", G="10", band_pct="15", cycle_id="c1"):
    cycle = VRCycle(
        cycle_id=cycle_id, start_session="2026-07-24", end_session="2026-08-07",
        V=Decimal(V), G=Decimal(G), band_pct=Decimal(band_pct),
        pool_start=Decimal(pool), pool_current=Decimal(pool),
        lower_band=Decimal(V) * Decimal("0.85"), upper_band=Decimal(V) * Decimal("1.15"),
    )
    return VRState(symbol="TQQQ", strategy_type="VR_SKILL", status="ACTIVE",
                    initialized_at="2026-07-24T21:00:00+00:00", current_cycle=cycle)


class CancelCycleOrdersTests(unittest.TestCase):
    def test_blocks_when_orders_are_still_open_after_sync(self):
        broker = FakeConditionalOrderBroker()
        with self.assertRaises(CycleTransitionBlocked):
            cancel_cycle_orders(broker, [], still_open_after_sync=True)

    def test_cancels_and_confirms_every_given_order(self):
        broker = FakeConditionalOrderBroker()
        buy_id = broker.seed_order("TQQQ", "buy", "old-buy")
        sell_id = broker.seed_order("TQQQ", "sell", "old-sell")
        cancel_cycle_orders(broker, [buy_id, sell_id], still_open_after_sync=False)
        self.assertIn(buy_id, broker.cancelled)
        self.assertIn(sell_id, broker.cancelled)

    def test_blocks_when_a_cancellation_does_not_confirm(self):
        class StubbornBroker(FakeConditionalOrderBroker):
            def _request(self, method, path, data=None, headers=None):
                if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
                    from toss_api import TossApiError
                    raise TossApiError("Toss API HTTP 400: cannot cancel")
                return super()._request(method, path, data=data, headers=headers)

        broker = StubbornBroker()
        stuck_id = broker.seed_order("TQQQ", "buy", "old-buy")
        with self.assertRaises(CycleTransitionBlocked):
            cancel_cycle_orders(broker, [stuck_id], still_open_after_sync=False)


class TransitionCycleHappyPathTests(unittest.TestCase):
    def test_e_equals_final_quantity_times_close_price(self):
        broker = FakeConditionalOrderBroker()
        state = _active_state(V="18500", pool="1231.51", G="10")
        new_state, new_orders = transition_cycle(
            broker=broker, state=state, symbol="TQQQ",
            final_qty=100, close_price=Decimal("163.80"),
            next_cycle_id="c2", next_start_session=date(2026, 8, 10),
            next_end_session=date(2026, 8, 21),
            available_buying_power=Decimal("10000"), available_sell_qty=100,
        )
        self.assertEqual(new_state.history[-1]["E_at_close"], "16380.00")

    def test_matches_the_spec_worked_example_v_next(self):
        # V=18500, E=16380 (100 shares * 163.80), Pool=1231.51, G=10
        # -> V_next = 18287.95 (exact value from the spec's own breakdown).
        broker = FakeConditionalOrderBroker()
        state = _active_state(V="18500", pool="1231.51", G="10")
        new_state, _ = transition_cycle(
            broker=broker, state=state, symbol="TQQQ",
            final_qty=100, close_price=Decimal("163.80"),
            next_cycle_id="c2", next_start_session=date(2026, 8, 10),
            next_end_session=date(2026, 8, 21),
            available_buying_power=Decimal("10000"), available_sell_qty=100,
        )
        self.assertEqual(new_state.current_cycle.V, Decimal("18287.95"))
        self.assertEqual(new_state.current_cycle.cycle_id, "c2")
        self.assertEqual(new_state.current_cycle.G, Decimal("10"))
        self.assertEqual(new_state.status, "ACTIVE")

    def test_pending_g_and_band_are_promoted_and_then_cleared(self):
        broker = FakeConditionalOrderBroker()
        state = schedule_config(_active_state(G="10", band_pct="15"), G=Decimal("20"), band_pct=Decimal("10"))
        new_state, _ = transition_cycle(
            broker=broker, state=state, symbol="TQQQ",
            final_qty=100, close_price=Decimal("163.80"),
            next_cycle_id="c2", next_start_session=date(2026, 8, 10),
            next_end_session=date(2026, 8, 21),
            available_buying_power=Decimal("10000"), available_sell_qty=100,
        )
        self.assertEqual(new_state.current_cycle.G, Decimal("20"))
        self.assertEqual(new_state.current_cycle.band_pct, Decimal("10"))
        self.assertIsNone(new_state.pending_config.G)
        self.assertIsNone(new_state.pending_config.band_pct)

    def test_pending_pool_adjustment_is_applied_once_at_transition(self):
        broker = FakeConditionalOrderBroker()
        state = schedule_config(_active_state(pool="1231.51"), pool_adjustment=Decimal("300"))
        new_state, _ = transition_cycle(
            broker=broker, state=state, symbol="TQQQ",
            final_qty=100, close_price=Decimal("163.80"),
            next_cycle_id="c2", next_start_session=date(2026, 8, 10),
            next_end_session=date(2026, 8, 21),
            available_buying_power=Decimal("10000"), available_sell_qty=100,
        )
        self.assertEqual(new_state.current_cycle.pool_start, Decimal("1531.51"))
        self.assertIsNone(new_state.pending_config.pool_adjustment)

    def test_new_conditional_orders_are_registered_with_next_cycle_expiry(self):
        broker = FakeConditionalOrderBroker()
        state = _active_state(V="18500", pool="1231.51")
        new_state, new_orders = transition_cycle(
            broker=broker, state=state, symbol="TQQQ",
            final_qty=100, close_price=Decimal("163.80"),
            next_cycle_id="c2", next_start_session=date(2026, 8, 10),
            next_end_session=date(2026, 8, 21),
            available_buying_power=Decimal("10000"), available_sell_qty=100,
        )
        self.assertGreater(len(new_orders), 0)
        for order in new_orders:
            self.assertEqual(order.expire_date, "2026-08-21")
            self.assertEqual(order.cycle_id, "c2")
            self.assertEqual(order.status, "OPEN")
        self.assertEqual(new_state.conditional_orders, new_orders)

    def test_cycle_number_increments(self):
        broker = FakeConditionalOrderBroker()
        state = _active_state(V="18500", pool="1231.51")
        state.anchor_friday = "2026-08-07"
        state.cycle_number = 3
        new_state, _ = transition_cycle(
            broker=broker, state=state, symbol="TQQQ",
            final_qty=100, close_price=Decimal("163.80"),
            next_cycle_id="c2", next_start_session=date(2026, 8, 10),
            next_end_session=date(2026, 8, 21),
            available_buying_power=Decimal("10000"), available_sell_qty=100,
        )
        self.assertEqual(new_state.cycle_number, 4)
        self.assertEqual(new_state.anchor_friday, "2026-08-07")

    def test_history_snapshot_records_the_closed_cycle(self):
        broker = FakeConditionalOrderBroker()
        state = _active_state(V="18500", pool="1231.51", cycle_id="c1")
        new_state, _ = transition_cycle(
            broker=broker, state=state, symbol="TQQQ",
            final_qty=100, close_price=Decimal("163.80"),
            next_cycle_id="c2", next_start_session=date(2026, 8, 10),
            next_end_session=date(2026, 8, 21),
            available_buying_power=Decimal("10000"), available_sell_qty=100,
        )
        self.assertEqual(len(new_state.history), 1)
        self.assertEqual(new_state.history[0]["cycle_id"], "c1")
        self.assertEqual(new_state.history[0]["V"], "18500")


class TransitionCycleBlockingTests(unittest.TestCase):
    def test_missing_close_price_blocks_transition(self):
        broker = FakeConditionalOrderBroker()
        state = _active_state()
        with self.assertRaises(CycleTransitionBlocked):
            transition_cycle(
                broker=broker, state=state, symbol="TQQQ",
                final_qty=100, close_price=None,
                next_cycle_id="c2", next_start_session=date(2026, 8, 10),
                next_end_session=date(2026, 8, 21),
                available_buying_power=Decimal("10000"), available_sell_qty=100,
            )

    def test_no_active_cycle_blocks_transition(self):
        broker = FakeConditionalOrderBroker()
        state = VRState(symbol="TQQQ", status="UNINITIALIZED", current_cycle=None)
        with self.assertRaises(CycleTransitionBlocked):
            transition_cycle(
                broker=broker, state=state, symbol="TQQQ",
                final_qty=100, close_price=Decimal("100"),
                next_cycle_id="c2", next_start_session=date(2026, 8, 10),
                next_end_session=date(2026, 8, 21),
                available_buying_power=Decimal("10000"), available_sell_qty=100,
            )

    def test_a_blocked_symbol_does_not_affect_a_healthy_symbols_state(self):
        broker = FakeConditionalOrderBroker()
        healthy_state = _active_state(V="10000", pool="500")
        blocked_state = _active_state(V="5000", pool="200")

        results = {}
        for symbol, state, close_price in (
            ("TQQQ", healthy_state, Decimal("100")),
            ("SOXL", blocked_state, None),
        ):
            try:
                new_state, _ = transition_cycle(
                    broker=broker, state=state, symbol=symbol,
                    final_qty=50, close_price=close_price,
                    next_cycle_id="c2", next_start_session=date(2026, 8, 10),
                    next_end_session=date(2026, 8, 21),
                    available_buying_power=Decimal("10000"), available_sell_qty=50,
                )
                results[symbol] = new_state
            except CycleTransitionBlocked:
                results[symbol] = "BLOCKED"

        self.assertEqual(results["SOXL"], "BLOCKED")
        self.assertNotEqual(results["TQQQ"], "BLOCKED")
        self.assertEqual(results["TQQQ"].current_cycle.cycle_id, "c2")
        # The healthy symbol's original state object was never mutated.
        self.assertEqual(healthy_state.current_cycle.cycle_id, "c1")


if __name__ == "__main__":
    unittest.main()
