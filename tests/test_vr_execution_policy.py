import json
import unittest
from decimal import Decimal

from vr_execution_policy import (
    CancellationNotConfirmedError,
    plan_rebalance_legs,
    rearm_after_fill,
    round_target_qty,
    trigger_prices,
)
from vr_state_store import VRCycle


def _cycle(V="10000", band_pct="15", pool="1000", cycle_id="c1"):
    return VRCycle(
        cycle_id=cycle_id, start_session="2026-08-07", end_session="2026-08-21",
        V=Decimal(V), G=Decimal("10"), band_pct=Decimal(band_pct),
        pool_start=Decimal(pool), pool_current=Decimal(pool),
        lower_band=Decimal(V) * (1 - Decimal(band_pct) / 100),
        upper_band=Decimal(V) * (1 + Decimal(band_pct) / 100),
    )


class RoundTargetQtyTests(unittest.TestCase):
    def test_exact_division_returns_that_integer(self):
        self.assertEqual(round_target_qty(Decimal("1000"), Decimal("100")), 10)

    def test_rounds_to_whichever_side_is_closer_to_v(self):
        # 1000/99 = 10.10..., 10*99=990 (dist 10), 11*99=1089 (dist 89) -> 10
        self.assertEqual(round_target_qty(Decimal("1000"), Decimal("99")), 10)
        # 1000/91 = 10.98..., 10*91=910 (dist 90), 11*91=1001 (dist 1) -> 11
        self.assertEqual(round_target_qty(Decimal("1000"), Decimal("91")), 11)

    def test_tie_break_prefers_the_smaller_quantity(self):
        # V=950, price=100: 9*100=900 (dist 50), 10*100=1000 (dist 50) -> tie -> 9
        self.assertEqual(round_target_qty(Decimal("950"), Decimal("100")), 9)

    def test_never_negative(self):
        self.assertGreaterEqual(round_target_qty(Decimal("1"), Decimal("1000")), 0)


class TriggerPricesTests(unittest.TestCase):
    def test_matches_the_worked_example(self):
        cycle = _cycle(V="10000", band_pct="15")
        lower, upper = trigger_prices(cycle, current_qty=100)
        self.assertEqual(lower, Decimal("85.00"))
        self.assertEqual(upper, Decimal("115.00"))

    def test_rejects_zero_quantity(self):
        cycle = _cycle()
        with self.assertRaises(ValueError):
            trigger_prices(cycle, current_qty=0)


class PlanRebalanceLegsTests(unittest.TestCase):
    def test_sell_leg_targets_v_and_is_capped_by_available_sell_qty(self):
        # current_qty=120 at upper_trigger=115: target=10000/115=86.9->87
        # sell = 120-87=33, but only 20 sellable
        buy_leg, sell_leg = plan_rebalance_legs(
            V=Decimal("10000"), current_qty=120,
            lower_trigger=Decimal("85"), upper_trigger=Decimal("115"),
            vr_pool=Decimal("1000"), available_buying_power=Decimal("5000"),
            available_sell_qty=20,
        )
        self.assertEqual(sell_leg.quantity, 20)
        self.assertEqual(sell_leg.side, "sell")
        self.assertEqual(sell_leg.trigger_price, Decimal("115"))

    def test_buy_leg_targets_v_and_is_capped_by_pool(self):
        # current_qty=80 at lower_trigger=85: target=10000/85=117.6->118
        # buy_needed=38, but pool only affords floor(1000/85)=11
        buy_leg, sell_leg = plan_rebalance_legs(
            V=Decimal("10000"), current_qty=80,
            lower_trigger=Decimal("85"), upper_trigger=Decimal("115"),
            vr_pool=Decimal("1000"), available_buying_power=Decimal("5000"),
            available_sell_qty=80,
        )
        self.assertEqual(buy_leg.quantity, 11)
        self.assertEqual(buy_leg.side, "buy")

    def test_buy_leg_is_capped_by_buying_power_even_if_pool_allows_more(self):
        buy_leg, sell_leg = plan_rebalance_legs(
            V=Decimal("10000"), current_qty=80,
            lower_trigger=Decimal("85"), upper_trigger=Decimal("115"),
            vr_pool=Decimal("5000"), available_buying_power=Decimal("170"),
            available_sell_qty=80,
        )
        self.assertEqual(buy_leg.quantity, 2)  # floor(170/85)

    def test_no_sell_leg_when_already_at_or_below_target(self):
        buy_leg, sell_leg = plan_rebalance_legs(
            V=Decimal("10000"), current_qty=80,
            lower_trigger=Decimal("85"), upper_trigger=Decimal("115"),
            vr_pool=Decimal("1000"), available_buying_power=Decimal("5000"),
            available_sell_qty=80,
        )
        self.assertIsNone(sell_leg)

    def test_no_buy_leg_when_already_at_or_above_target(self):
        buy_leg, sell_leg = plan_rebalance_legs(
            V=Decimal("10000"), current_qty=120,
            lower_trigger=Decimal("85"), upper_trigger=Decimal("115"),
            vr_pool=Decimal("1000"), available_buying_power=Decimal("5000"),
            available_sell_qty=120,
        )
        self.assertIsNone(buy_leg)

    def test_no_buy_leg_when_pool_is_exhausted(self):
        buy_leg, sell_leg = plan_rebalance_legs(
            V=Decimal("10000"), current_qty=80,
            lower_trigger=Decimal("85"), upper_trigger=Decimal("115"),
            vr_pool=Decimal("0"), available_buying_power=Decimal("5000"),
            available_sell_qty=80,
        )
        self.assertIsNone(buy_leg)


class FakeConditionalOrderBroker:
    """Fully in-memory simulation of the Toss conditional-order HTTP surface
    via _request -- so rearm_after_fill exercises the exact same
    create_conditional_order/cancel_conditional_order/get_conditional_orders
    call path a real TossBroker would use, with zero real network calls.
    mode is configurable so both the DRY_RUN short-circuit path (create/
    cancel never reach _request) and the LIVE path (fully faked _request)
    are exercisable."""

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
        # orderSide/triggerPrice/orderPrice under "first"; cancel is DELETE
        # returning 204 (empty dict here, no "status" field); list is GET
        # with a required status= query and a "conditionalOrders" body key.
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
            row = self.orders.get(conditional_order_id)
            if row is None:
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


class RearmAfterFillTests(unittest.TestCase):
    def test_sell_fill_cancels_remaining_buy_leg_and_reregisters_both(self):
        broker = FakeConditionalOrderBroker(mode="LIVE")
        cycle = _cycle(V="10000", band_pct="15", pool="1000")
        remaining_buy_id = broker.seed_order("TQQQ", "buy", "old-buy")

        new_cycle, new_orders = rearm_after_fill(
            broker, cycle, symbol="TQQQ",
            updated_qty=87,  # a sell fill already brought qty from 120 to 87
            updated_pool=Decimal("3805.00"),  # pool credited from the sell fill
            available_buying_power=Decimal("5000"),
            available_sell_qty=87,
            remaining_conditional_order_ids=[remaining_buy_id],
        )

        self.assertIn(remaining_buy_id, broker.cancelled)
        self.assertNotIn(remaining_buy_id, broker.orders)
        # V/G/Band on the cycle are untouched by a rearm -- only pool_current
        # (which the caller already updated from the fill) carries forward.
        self.assertEqual(new_cycle.V, Decimal("10000"))
        self.assertEqual(new_cycle.G, Decimal("10"))
        self.assertEqual(new_cycle.band_pct, Decimal("15"))
        self.assertEqual(new_cycle.pool_current, Decimal("3805.00"))
        sides = {order.side for order in new_orders}
        self.assertTrue(sides <= {"buy", "sell"})
        for order in new_orders:
            self.assertEqual(order.status, "OPEN")
            self.assertEqual(order.cycle_id, "c1")

    def test_dry_run_cancellations_are_treated_as_confirmed_synchronously(self):
        # In DRY_RUN, cancel_conditional_order never reaches _request at all
        # (matches TossBroker.cancel_order's own gate) -- rearm must not
        # require a network round trip to "confirm" a DRY_RUN cancellation.
        broker = FakeConditionalOrderBroker(mode="DRY_RUN")
        cycle = _cycle()
        new_cycle, new_orders = rearm_after_fill(
            broker, cycle, symbol="TQQQ", updated_qty=87,
            updated_pool=Decimal("3805.00"), available_buying_power=Decimal("5000"),
            available_sell_qty=87, remaining_conditional_order_ids=["some-old-id"],
        )
        self.assertEqual(new_cycle.pool_current, Decimal("3805.00"))

    def test_raises_if_cancellation_does_not_confirm(self):
        class StubbornBroker(FakeConditionalOrderBroker):
            def _request(self, method, path, data=None, headers=None):
                if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
                    # Simulate Toss rejecting the cancel (e.g. already
                    # triggered/expired) -- the real API raises via a 4xx,
                    # never returns a "still OPEN" body.
                    from toss_api import TossApiError
                    raise TossApiError("Toss API HTTP 400: cannot cancel")
                return super()._request(method, path, data=data, headers=headers)

        broker = StubbornBroker(mode="LIVE")
        cycle = _cycle()
        stuck_id = broker.seed_order("TQQQ", "sell", "old-sell")

        with self.assertRaises(CancellationNotConfirmedError):
            rearm_after_fill(
                broker, cycle, symbol="TQQQ", updated_qty=80,
                updated_pool=Decimal("1000"), available_buying_power=Decimal("5000"),
                available_sell_qty=80, remaining_conditional_order_ids=[stuck_id],
            )
        # A failed confirmation must not proceed to register new orders.
        self.assertEqual(len(broker.orders), 1)

    def test_404_on_cancel_retry_is_treated_as_already_confirmed(self):
        # Spec 13-4 crash recovery: a retried DELETE for an order Toss
        # already cancelled 404s -- that must be treated as confirmed
        # cancellation, not a failure, or a crash-then-retry could never
        # recover past an already-cancelled order.
        class AlreadyGoneBroker(FakeConditionalOrderBroker):
            def _request(self, method, path, data=None, headers=None):
                if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
                    from toss_api import TossApiError
                    raise TossApiError("Toss API HTTP 404: not found")
                return super()._request(method, path, data=data, headers=headers)

        broker = AlreadyGoneBroker(mode="LIVE")
        cycle = _cycle()

        new_cycle, new_orders = rearm_after_fill(
            broker, cycle, symbol="TQQQ", updated_qty=80,
            updated_pool=Decimal("1000"), available_buying_power=Decimal("5000"),
            available_sell_qty=80, remaining_conditional_order_ids=["already-gone-id"],
        )
        self.assertGreater(len(new_orders), 0)


if __name__ == "__main__":
    unittest.main()
