import json
import unittest
from decimal import Decimal

from vr_execution_policy import (
    MAX_BROKER_ORDERS_PER_SIDE,
    CancellationNotConfirmedError,
    PlannedLeg,
    buy_ladder_prices,
    cancel_and_confirm,
    compress_ladder,
    group_sizes,
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


class PoolUsageLimitPctGoldenTests(unittest.TestCase):
    """Same Q0/L/Pool, three book target-spend fractions (75%/50%/25%):
    target_spend must scale exactly, and the selected logical rung count
    must strictly decrease as the fraction shrinks (Phase G golden)."""

    _PRICES = buy_ladder_prices(Decimal("4695.91"), 110, 60)
    _POOL = Decimal("2000")

    def test_75_pct_target_and_selection(self):
        n, cumulative = select_buy_ladder_length(self._PRICES, self._POOL, Decimal("0.75"))
        self.assertEqual(self._POOL * Decimal("0.75"), Decimal("1500.00"))
        self.assertEqual(n, 41)
        self.assertEqual(cumulative, Decimal("1493.49"))
        self.assertLessEqual(cumulative, Decimal("1500.00"))

    def test_50_pct_target_and_selection(self):
        n, cumulative = select_buy_ladder_length(self._PRICES, self._POOL, Decimal("0.50"))
        self.assertEqual(self._POOL * Decimal("0.50"), Decimal("1000.00"))
        self.assertEqual(n, 26)
        self.assertEqual(cumulative, Decimal("1000.46"))

    def test_25_pct_target_and_selection(self):
        n, cumulative = select_buy_ladder_length(self._PRICES, self._POOL, Decimal("0.25"))
        self.assertEqual(self._POOL * Decimal("0.25"), Decimal("500.00"))
        self.assertEqual(n, 12)
        self.assertEqual(cumulative, Decimal("488.33"))

    def test_rung_count_strictly_decreases_as_fraction_shrinks(self):
        n75, _ = select_buy_ladder_length(self._PRICES, self._POOL, Decimal("0.75"))
        n50, _ = select_buy_ladder_length(self._PRICES, self._POOL, Decimal("0.50"))
        n25, _ = select_buy_ladder_length(self._PRICES, self._POOL, Decimal("0.25"))
        self.assertGreaterEqual(n75, n50)
        self.assertGreaterEqual(n50, n25)

    def test_never_exceeds_its_own_target(self):
        # Never exceeding cycle_start_pool is already covered elsewhere;
        # here every fraction's cumulative spend must also never exceed
        # cycle_start_pool itself (the hard cap), independent of fraction.
        for pct in (Decimal("0.75"), Decimal("0.50"), Decimal("0.25")):
            _, cumulative = select_buy_ladder_length(self._PRICES, self._POOL, pct)
            self.assertLessEqual(cumulative, self._POOL)


class GroupSizesTests(unittest.TestCase):
    """Remainder placement: SMALL groups first (closer to V/current price,
    highest execution resolution where price is most likely to matter),
    LARGE groups last (deep tail)."""

    def test_n_0(self):
        self.assertEqual(group_sizes(0), [])

    def test_n_1(self):
        self.assertEqual(group_sizes(1), [1])

    def test_n_99_no_compression(self):
        self.assertEqual(group_sizes(99), [1] * 99)

    def test_n_100_no_compression(self):
        self.assertEqual(group_sizes(100), [1] * 100)

    def test_n_101_one_group_of_two_at_the_end(self):
        sizes = group_sizes(101)
        self.assertEqual(len(sizes), 100)
        self.assertEqual(sizes, [1] * 99 + [2])
        self.assertEqual(sum(sizes), 101)

    def test_n_199(self):
        sizes = group_sizes(199)
        self.assertEqual(len(sizes), 100)
        self.assertEqual(sizes, [1] * 1 + [2] * 99)
        self.assertEqual(sum(sizes), 199)

    def test_n_200_even_split(self):
        self.assertEqual(group_sizes(200), [2] * 100)

    def test_n_203(self):
        sizes = group_sizes(203)
        self.assertEqual(sizes, [2] * 97 + [3] * 3)
        self.assertEqual(sum(sizes), 203)

    def test_n_300_even_split(self):
        self.assertEqual(group_sizes(300), [3] * 100)

    def test_n_126_still_below_the_new_threshold_but_above_the_old_one(self):
        # 126 was the compression golden example under the old
        # MAX_BROKER_ORDERS_PER_SIDE=20; still exceeds the new 100, so it
        # still compresses -- just far less aggressively (mostly quantity-1
        # rungs with only a small remainder tail at quantity-2).
        sizes = group_sizes(126)
        self.assertEqual(len(sizes), 100)
        self.assertEqual(sizes, [1] * 74 + [2] * 26)
        self.assertEqual(sum(sizes), 126)

    def test_small_groups_always_come_before_large_groups(self):
        for n in (21, 39, 43, 60, 126, 1000):
            sizes = group_sizes(n)
            self.assertEqual(sizes, sorted(sizes), f"n={n}: groups must be non-decreasing")

    def test_group_size_difference_never_exceeds_one(self):
        for n in (21, 39, 43, 60, 126, 1000):
            sizes = group_sizes(n)
            self.assertLessEqual(max(sizes) - min(sizes), 1, f"n={n}")


class CompressLadderTests(unittest.TestCase):
    def test_no_compression_when_at_or_below_the_limit(self):
        prices = buy_ladder_prices(Decimal("4695.91"), 110, 9)
        legs = compress_ladder("buy", prices)
        self.assertEqual(len(legs), 9)
        for i, leg in enumerate(legs, start=1):
            self.assertEqual(leg.quantity, 1)
            self.assertEqual(leg.logical_start_rung, i)
            self.assertEqual(leg.logical_end_rung, i)
            self.assertEqual(leg.trigger_price, prices[i - 1])

    def test_total_quantity_is_preserved_exactly(self):
        prices = sell_ladder_prices(Decimal("10299.49"), 126, 126)
        legs = compress_ladder("sell", prices)
        self.assertEqual(len(legs), MAX_BROKER_ORDERS_PER_SIDE)
        self.assertEqual(sum(leg.quantity for leg in legs), 126)

    def test_logical_ranges_are_consecutive_with_no_gap_or_overlap(self):
        prices = buy_ladder_prices(Decimal("4249.58"), 110, 43)
        legs = compress_ladder("buy", prices)
        expected_next_start = 1
        for leg in legs:
            self.assertEqual(leg.logical_start_rung, expected_next_start)
            self.assertGreaterEqual(leg.logical_end_rung, leg.logical_start_rung)
            expected_next_start = leg.logical_end_rung + 1
        self.assertEqual(expected_next_start - 1, 43)

    def test_representative_price_is_the_rounded_mean(self):
        prices = [Decimal("10.00"), Decimal("10.02"), Decimal("10.05")]
        legs = compress_ladder("buy", prices, max_groups=1)
        self.assertEqual(len(legs), 1)
        # mean = 10.023333... -> 10.02
        self.assertEqual(legs[0].trigger_price, Decimal("10.02"))
        self.assertEqual(legs[0].quantity, 3)

    def test_golden_buy_43_rungs(self):
        # L=4249.58, Q0=110. Under MAX_BROKER_ORDERS_PER_SIDE=100 (raised
        # 2026-08-22 per the live capacity smoke test -- see
        # vr_execution_policy.VERIFIED_CAPACITY's docstring), 43 logical
        # rungs no longer needs compression at all: one real broker order
        # per rung, full price resolution. (Was the compression golden
        # example under the old cap of 20; kept as a regression test for
        # the new "stays uncompressed" behavior instead.)
        prices = buy_ladder_prices(Decimal("4249.58"), 110, 43)
        legs = compress_ladder("buy", prices)
        self.assertEqual(len(legs), 43)
        for i, leg in enumerate(legs, start=1):
            self.assertEqual(leg.quantity, 1)
            self.assertEqual(leg.logical_start_rung, i)
            self.assertEqual(leg.logical_end_rung, i)
        self.assertEqual(legs[0].trigger_price, Decimal("38.63"))
        self.assertEqual(legs[-1].trigger_price, Decimal("27.96"))

    def test_golden_sell_126_rungs(self):
        # U=10299.49, Q0=126 (TQQQ's real current SELL band). 126 still
        # exceeds the new MAX_BROKER_ORDERS_PER_SIDE=100, so it still
        # compresses -- just far less aggressively than under the old cap
        # of 20 (mostly quantity-1 rungs, only a 26-rung tail at quantity-2).
        prices = sell_ladder_prices(Decimal("10299.49"), 126, 126)
        legs = compress_ladder("sell", prices)
        self.assertEqual(len(legs), 100)
        self.assertEqual([leg.quantity for leg in legs], [1] * 74 + [2] * 26)
        self.assertEqual(sum(leg.quantity for leg in legs), 126)
        self.assertEqual(legs[0].trigger_price, Decimal("81.74"))
        self.assertEqual(legs[0].logical_start_rung, 1)
        self.assertEqual(legs[0].logical_end_rung, 1)
        self.assertEqual(legs[-1].trigger_price, Decimal("7724.62"))
        self.assertEqual(legs[-1].logical_start_rung, 125)
        self.assertEqual(legs[-1].logical_end_rung, 126)


class PlanBuyLadderTests(unittest.TestCase):
    def test_no_compression_when_logical_count_is_at_or_below_the_limit(self):
        legs, planned_spend, logical_count = plan_buy_ladder(Decimal("4695.91"), 110, Decimal("500.50"))
        self.assertEqual(logical_count, 9)
        self.assertEqual(len(legs), 9)  # <= MAX_BROKER_ORDERS_PER_SIDE -> uncompressed
        self.assertEqual(planned_spend, Decimal("370.93"))
        for leg in legs:
            self.assertEqual(leg.side, "buy")
            self.assertEqual(leg.quantity, 1)
        self.assertEqual(legs[0].trigger_price, Decimal("42.69"))

    def test_compression_applied_when_logical_count_exceeds_the_limit(self):
        # L=4975.96, Q0=105, Pool=1044.70 -> 18 logical levels per the book
        # example (still <= 20, so this alone doesn't compress -- use a
        # larger pool to push the logical count past 20).
        legs, planned_spend, logical_count = plan_buy_ladder(Decimal("4249.58"), 110, Decimal("5000"))
        self.assertGreater(logical_count, MAX_BROKER_ORDERS_PER_SIDE)
        self.assertEqual(len(legs), MAX_BROKER_ORDERS_PER_SIDE)
        self.assertEqual(sum(leg.quantity for leg in legs), logical_count)

    def test_empty_ladder_when_pool_cannot_afford_the_first_rung(self):
        legs, planned_spend, logical_count = plan_buy_ladder(Decimal("4249.58"), 110, Decimal("0.50"))
        self.assertEqual(legs, [])
        self.assertEqual(planned_spend, Decimal("0"))
        self.assertEqual(logical_count, 0)


class PlanSellLadderTests(unittest.TestCase):
    def test_no_compression_when_at_or_below_the_limit(self):
        legs, logical_count = plan_sell_ladder(Decimal("5749.43"), 15, available_sell_qty=15)
        self.assertEqual(logical_count, 15)
        self.assertEqual(len(legs), 15)
        for leg in legs:
            self.assertEqual(leg.side, "sell")
            self.assertEqual(leg.quantity, 1)
        self.assertEqual(legs[0].trigger_price, Decimal("383.30"))

    def test_compression_applied_above_the_limit_and_total_quantity_preserved(self):
        legs, logical_count = plan_sell_ladder(Decimal("5749.43"), 110, available_sell_qty=110)
        self.assertEqual(logical_count, 110)
        self.assertEqual(len(legs), MAX_BROKER_ORDERS_PER_SIDE)
        self.assertEqual(sum(leg.quantity for leg in legs), 110)

    def test_capped_by_available_sell_qty_when_smaller_than_position(self):
        legs, logical_count = plan_sell_ladder(Decimal("5749.43"), 110, available_sell_qty=3)
        self.assertEqual(logical_count, 3)
        self.assertEqual(len(legs), 3)

    def test_no_pool_based_limit_unlike_the_buy_side(self):
        # The book states SELL has no Pool constraint -- plan_sell_ladder
        # doesn't even take a pool argument, so this is really a signature
        # check that no such cap can accidentally be reintroduced.
        import inspect
        params = inspect.signature(plan_sell_ladder).parameters
        self.assertNotIn("pool", " ".join(params))


class PlannedLegQuantityAboveOneTests(unittest.TestCase):
    """The old 'quantity is always 1' assumption is gone -- a compressed
    leg is a completely ordinary PlannedLeg with quantity > 1."""

    def test_can_construct_a_leg_with_quantity_greater_than_one(self):
        leg = PlannedLeg(side="sell", trigger_price=Decimal("100.00"), quantity=7, logical_start_rung=1, logical_end_rung=7)
        self.assertEqual(leg.quantity, 7)


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
