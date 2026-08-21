import json
import unittest
from decimal import Decimal

from vr_execution_policy import (
    CancellationNotConfirmedError,
    buy_ladder_prices,
    cancel_and_confirm,
    plan_buy_ladder,
    plan_sell_ladder,
    select_buy_ladder_length,
    sell_ladder_prices,
)


class BuyLadderPricesTests(unittest.TestCase):
    def test_matches_the_book_worked_example(self):
        # L=4695.91, Q0=110 -> 42.69, 42.31, 41.93, 41.56 ...
        prices = buy_ladder_prices(Decimal("4695.91"), 110, 4)
        self.assertEqual(prices, [Decimal("42.69"), Decimal("42.31"), Decimal("41.93"), Decimal("41.56")])

    def test_denominator_increases_by_one_each_rung(self):
        prices = buy_ladder_prices(Decimal("4249.58"), 110, 3)
        self.assertEqual(prices, [Decimal("38.63"), Decimal("38.28"), Decimal("37.94")])

    def test_prices_strictly_decrease(self):
        prices = buy_ladder_prices(Decimal("4695.91"), 110, 10)
        self.assertEqual(prices, sorted(prices, reverse=True))
        self.assertEqual(len(set(prices)), len(prices))

    def test_rejects_nonpositive_starting_qty(self):
        with self.assertRaises(ValueError):
            buy_ladder_prices(Decimal("4695.91"), 0, 5)


class SellLadderPricesTests(unittest.TestCase):
    def test_matches_the_book_worked_example(self):
        # U=5749.43, Q0=110 -> 52.27, 52.75, 53.24
        prices = sell_ladder_prices(Decimal("5749.43"), 110, 3)
        self.assertEqual(prices, [Decimal("52.27"), Decimal("52.75"), Decimal("53.24")])

    def test_prices_strictly_increase(self):
        prices = sell_ladder_prices(Decimal("6353.29"), 110, 10)
        self.assertEqual(prices, sorted(prices))
        self.assertEqual(len(set(prices)), len(prices))

    def test_count_cannot_exceed_starting_qty(self):
        with self.assertRaises(ValueError):
            sell_ladder_prices(Decimal("5749.43"), 110, 111)

    def test_count_equal_to_starting_qty_is_the_full_position(self):
        prices = sell_ladder_prices(Decimal("5749.43"), 3, 3)
        self.assertEqual(len(prices), 3)


class SelectBuyLadderLengthGoldenExampleTests(unittest.TestCase):
    """The three book examples for the Pool 75% target-spend rule, verified
    exactly (prices, level count, and remaining Pool)."""

    def test_example_a_pool_250_50(self):
        prices = buy_ladder_prices(Decimal("4462.12"), 110, 10)
        n, cumulative = select_buy_ladder_length(prices, Decimal("250.50"))
        self.assertEqual(n, 5)
        self.assertEqual(cumulative, Decimal("199.23"))
        self.assertEqual(Decimal("250.50") - cumulative, Decimal("51.27"))

    def test_example_b_pool_500_50(self):
        prices = buy_ladder_prices(Decimal("4695.91"), 110, 15)
        n, cumulative = select_buy_ladder_length(prices, Decimal("500.50"))
        self.assertEqual(n, 9)
        self.assertEqual(cumulative, Decimal("370.93"))
        self.assertEqual(Decimal("500.50") - cumulative, Decimal("129.57"))

    def test_example_c_pool_1044_70(self):
        prices = buy_ladder_prices(Decimal("4975.96"), 105, 25)
        n, cumulative = select_buy_ladder_length(prices, Decimal("1044.70"))
        self.assertEqual(n, 18)
        self.assertEqual(cumulative, Decimal("790.80"))
        self.assertEqual(Decimal("1044.70") - cumulative, Decimal("253.90"))


class SelectBuyLadderLengthEdgeCaseTests(unittest.TestCase):
    def test_pool_smaller_than_first_rung_selects_zero_levels(self):
        # Book's first-cycle example: Pool=$0.50, first rung >= $38 -> 0 buys.
        prices = buy_ladder_prices(Decimal("4249.58"), 110, 5)
        n, cumulative = select_buy_ladder_length(prices, Decimal("0.50"))
        self.assertEqual(n, 0)
        self.assertEqual(cumulative, Decimal("0"))

    def test_never_exceeds_cycle_start_pool(self):
        prices = buy_ladder_prices(Decimal("4249.58"), 110, 200)
        pool = Decimal("300.00")
        n, cumulative = select_buy_ladder_length(prices, pool)
        self.assertLessEqual(cumulative, pool)

    def test_available_buying_power_caps_spend_below_pool(self):
        prices = buy_ladder_prices(Decimal("4249.58"), 110, 50)
        n, cumulative = select_buy_ladder_length(
            prices, cycle_start_pool=Decimal("1000"), available_buying_power=Decimal("100"),
        )
        self.assertLessEqual(cumulative, Decimal("100"))

    def test_tie_prefers_smaller_cumulative_spend(self):
        # prices=[40,40], target=100*0.6=60: n=1 -> cumulative=40 (diff 20);
        # n=2 -> cumulative=80 (diff 20) -- an exact tie. Book: ties keep
        # more Pool unspent, so the smaller cumulative (n=1) must win.
        prices = [Decimal("40"), Decimal("40")]
        n, cumulative = select_buy_ladder_length(
            prices, cycle_start_pool=Decimal("100"), pool_usage_limit_pct=Decimal("0.6"),
        )
        self.assertEqual(n, 1)
        self.assertEqual(cumulative, Decimal("40"))


class PlanBuyLadderTests(unittest.TestCase):
    def test_returns_one_share_legs_and_the_projected_spend(self):
        legs, planned_spend = plan_buy_ladder(Decimal("4695.91"), 110, Decimal("500.50"))
        self.assertEqual(len(legs), 9)
        self.assertEqual(planned_spend, Decimal("370.93"))
        for leg in legs:
            self.assertEqual(leg.side, "buy")
            self.assertEqual(leg.quantity, 1)
        self.assertEqual(legs[0].trigger_price, Decimal("42.69"))

    def test_empty_ladder_when_pool_cannot_afford_the_first_rung(self):
        legs, planned_spend = plan_buy_ladder(Decimal("4249.58"), 110, Decimal("0.50"))
        self.assertEqual(legs, [])
        self.assertEqual(planned_spend, Decimal("0"))


class PlanSellLadderTests(unittest.TestCase):
    def test_returns_one_share_legs_up_to_starting_qty(self):
        legs = plan_sell_ladder(Decimal("5749.43"), 110, available_sell_qty=110)
        self.assertEqual(len(legs), 110)
        for leg in legs:
            self.assertEqual(leg.side, "sell")
            self.assertEqual(leg.quantity, 1)
        self.assertEqual(legs[0].trigger_price, Decimal("52.27"))
        self.assertEqual(legs[1].trigger_price, Decimal("52.75"))
        self.assertEqual(legs[2].trigger_price, Decimal("53.24"))

    def test_capped_by_available_sell_qty_when_smaller_than_position(self):
        legs = plan_sell_ladder(Decimal("5749.43"), 110, available_sell_qty=3)
        self.assertEqual(len(legs), 3)

    def test_no_pool_based_limit_unlike_the_buy_side(self):
        # The book states SELL has no Pool constraint -- plan_sell_ladder
        # doesn't even take a pool argument, so this is really a signature
        # check that no such cap can accidentally be reintroduced.
        import inspect
        params = inspect.signature(plan_sell_ladder).parameters
        self.assertNotIn("pool", " ".join(params))


class FakeConditionalOrderBroker:
    """In-memory simulation of the Toss conditional-order HTTP surface via
    _request, matching the real verified schema (nested first.orderSide/
    triggerPrice/orderPrice; DELETE -> 204; GET requires status=). Used to
    exercise cancel_and_confirm's real call path with zero network calls."""

    def __init__(self, mode="LIVE"):
        self.mode = mode
        self.live_ack = True
        self.orders: dict[str, dict] = {}
        self.cancelled: set[str] = set()
        self._next_id = 1

    def _account_headers(self):
        return {}

    def _request(self, method, path, data=None, headers=None):
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


class CancelAndConfirmTests(unittest.TestCase):
    """cancel_and_confirm is still used at cycle-end (cancel every ladder
    rung still OPEN) even though rearm no longer calls it mid-cycle."""

    def test_confirmed_cancellation_removes_the_order(self):
        broker = FakeConditionalOrderBroker(mode="LIVE")
        order_id = broker.seed_order("TQQQ", "buy", "old-buy")
        cancel_and_confirm(broker, order_id)
        self.assertIn(order_id, broker.cancelled)
        self.assertNotIn(order_id, broker.orders)

    def test_raises_if_cancellation_does_not_confirm(self):
        class StubbornBroker(FakeConditionalOrderBroker):
            def _request(self, method, path, data=None, headers=None):
                if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
                    from toss_api import TossApiError
                    raise TossApiError("Toss API HTTP 400: cannot cancel")
                return super()._request(method, path, data=data, headers=headers)

        broker = StubbornBroker(mode="LIVE")
        stuck_id = broker.seed_order("TQQQ", "sell", "old-sell")
        with self.assertRaises(CancellationNotConfirmedError):
            cancel_and_confirm(broker, stuck_id)

    def test_404_on_cancel_retry_is_treated_as_already_confirmed(self):
        # Spec 13-4 crash recovery: a retried DELETE for an order Toss
        # already cancelled 404s -- treated as confirmed, not a failure.
        class AlreadyGoneBroker(FakeConditionalOrderBroker):
            def _request(self, method, path, data=None, headers=None):
                if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
                    from toss_api import TossApiError
                    raise TossApiError("Toss API HTTP 404: not found")
                return super()._request(method, path, data=data, headers=headers)

        broker = AlreadyGoneBroker(mode="LIVE")
        cancel_and_confirm(broker, "already-gone-id")  # must not raise


if __name__ == "__main__":
    unittest.main()
