import unittest
from datetime import date
from decimal import Decimal

from mumae_core import (
    Mode,
    OrderIntent,
    OrderKind,
    StrategyState,
    apply_fill,
    attempt_amount,
    build_big_number_plan,
    build_plan,
    down_ladder_prices,
    final_take_profit_price,
    normalize_down_ladder_levels,
    star_price,
)


class StrategyFormulaTests(unittest.TestCase):
    def setUp(self):
        self.state = StrategyState(cash_usd=Decimal("4000"), position_qty=100, avg_cost=Decimal("50"), t_value=Decimal("10"), cycle_id="test")

    def test_v4_star_formula(self):
        self.assertEqual(star_price(self.state), Decimal("53.75"))

    def test_attempt_amount_recalculates_with_t(self):
        self.assertEqual(attempt_amount(self.state), Decimal("133.33"))

    def test_final_take_profit_is_avg_plus_15_percent(self):
        self.assertEqual(final_take_profit_price(self.state), Decimal("57.50"))

    def test_verified_down_ladder_example(self):
        prices = down_ladder_prices(Decimal("629.63"), Decimal("185.18"), steps=7)
        self.assertEqual(prices, (Decimal("157.41"), Decimal("125.93"), Decimal("104.94"), Decimal("89.95"), Decimal("78.70"), Decimal("69.96"), Decimal("62.96")))

    def test_first_half_plan_has_star_average_and_ladder(self):
        self.state.down_ladder_enabled_levels = [1, 2, 3]
        plan = build_plan(self.state, Decimal("51"), date(2026, 7, 14), previous_close=Decimal("50"), ladder_steps=3)
        buys = [order for order in plan.orders if order.side == "buy"]
        self.assertEqual([order.reason for order in buys], ["First-half star LOC buy (50%)", "First-half average LOC buy (50%)", "Down ladder 1/3", "Down ladder 2/3", "Down ladder 3/3"])
        self.assertEqual([order.limit_price for order in buys[-3:]], [Decimal("33.33"), Decimal("25.00"), Decimal("20.00")])
        self.assertTrue(plan.warnings)

    def test_second_half_uses_star_as_ladder_anchor(self):
        self.state.t_value = Decimal("20")
        plan = build_plan(self.state, Decimal("51"), date(2026, 7, 14), ladder_steps=1)
        buys = [order for order in plan.orders if order.side == "buy"]
        self.assertEqual(buys[0].reason, "Second-half star LOC buy")
        self.assertEqual(buys[1].limit_price, Decimal("33.33"))

    def test_down_ladder_uses_base_buy_quantity(self):
        self.state.symbol = "KORU"
        self.state.base_buy_qty = 10
        self.state.down_ladder_enabled_levels = [1, 2, 3, 4, 5]
        plan = build_plan(self.state, Decimal("51"), date(2026, 7, 15), ladder_steps=5)
        ladder = [order for order in plan.orders if order.reason.startswith("Down ladder ")]
        self.assertEqual([order.quantity for order in ladder], [10, 10, 10, 10, 10])

    def test_new_cycle_uses_previous_close_plus_ten_percent(self):
        state = StrategyState(cash_usd=Decimal("4400"), big_number_pct=Decimal("10"), cycle_id="test")
        plan = build_plan(state, Decimal("105"), date(2026, 7, 14), previous_close=Decimal("100"))
        self.assertEqual(plan.orders[0].limit_price, Decimal("110.00"))
        self.assertEqual(plan.orders[0].quantity, 2)

    def test_big_number_buffer_and_replacement_quantity(self):
        orders = (
            OrderIntent("a", "buy", 2, Decimal("126"), OrderKind.LIMIT, "First-half star LOC buy"),
            OrderIntent("b", "buy", 1, Decimal("120"), OrderKind.LIMIT, "low"),
            OrderIntent("sell", "sell", 10, Decimal("125"), OrderKind.LIMIT, "must not count"),
        )
        result = build_big_number_plan(Decimal("100"), Decimal("15"), orders, trigger=True, star_ceiling=Decimal("130"))
        self.assertEqual(result.buffer_pct, Decimal("15.00"))
        self.assertEqual(result.replacement_price, Decimal("115.00"))
        self.assertEqual(result.replacement_qty, 3)
        above_star = build_big_number_plan(Decimal("100"), Decimal("30"), orders, trigger=True, star_ceiling=Decimal("125"))
        self.assertEqual(above_star.replacement_price, Decimal("130.00"))
        self.assertEqual(above_star.replacement_qty, 2)

    def test_reverse_first_day_is_close_auction_one_twentieth(self):
        self.state.mode = Mode.REVERSE_FIRST_DAY
        plan = build_plan(self.state, Decimal("51"), date(2026, 7, 14))
        self.assertEqual(len(plan.orders), 1)
        self.assertEqual(plan.orders[0].quantity, 5)
        self.assertEqual(plan.orders[0].kind, OrderKind.CLOSE_AUCTION)

    def test_t_updates_follow_normal_and_reverse_rules(self):
        apply_fill(self.state, "buy", 1, "half_buy")
        self.assertEqual(self.state.t_value, Decimal("10.5"))
        apply_fill(self.state, "sell", 1, "quarter_sell")
        self.assertEqual(self.state.t_value, Decimal("7.875"))
        self.state.mode = Mode.REVERSE
        apply_fill(self.state, "sell", 1)
        self.assertEqual(self.state.t_value, Decimal("7.48125"))


class DownLadderLevelSelectionTests(unittest.TestCase):
    def setUp(self):
        self.state = StrategyState(cash_usd=Decimal("4000"), position_qty=100, avg_cost=Decimal("50"), t_value=Decimal("10"), cycle_id="test")

    def test_default_down_ladder_levels_are_one_and_two(self):
        self.assertEqual(StrategyState().down_ladder_enabled_levels, [1, 2])

    def test_build_plan_only_includes_enabled_ladder_levels(self):
        self.state.down_ladder_enabled_levels = [1, 2, 4]
        plan = build_plan(self.state, Decimal("51"), date(2026, 7, 15), ladder_steps=5)
        ladder = [order.reason for order in plan.orders if order.reason.startswith("Down ladder ")]
        self.assertEqual(ladder, ["Down ladder 1/5", "Down ladder 2/5", "Down ladder 4/5"])

    def test_build_plan_default_levels_only_produce_two_ladder_orders(self):
        plan = build_plan(self.state, Decimal("51"), date(2026, 7, 15), ladder_steps=5)
        ladder = [order.reason for order in plan.orders if order.reason.startswith("Down ladder ")]
        self.assertEqual(ladder, ["Down ladder 1/5", "Down ladder 2/5"])

    def test_disabled_ladder_levels_are_excluded_from_buy_notional(self):
        self.state.down_ladder_enabled_levels = [1, 2]
        minimal_plan = build_plan(self.state, Decimal("51"), date(2026, 7, 15), ladder_steps=5)
        self.state.down_ladder_enabled_levels = [1, 2, 3, 4, 5]
        full_plan = build_plan(self.state, Decimal("51"), date(2026, 7, 15), ladder_steps=5)
        minimal_notional = sum(order.limit_price * order.quantity for order in minimal_plan.orders if order.side == "buy")
        full_notional = sum(order.limit_price * order.quantity for order in full_plan.orders if order.side == "buy")
        self.assertLess(minimal_notional, full_notional)

    def test_down_ladder_price_formula_is_unchanged_by_filtering(self):
        self.state.down_ladder_enabled_levels = [1, 2, 3, 4, 5]
        plan = build_plan(self.state, Decimal("51"), date(2026, 7, 15), ladder_steps=5)
        ladder = [order for order in plan.orders if order.reason.startswith("Down ladder ")]
        self.state.down_ladder_enabled_levels = [1, 2, 5]
        filtered_plan = build_plan(self.state, Decimal("51"), date(2026, 7, 15), ladder_steps=5)
        filtered_fifth = next(order for order in filtered_plan.orders if order.reason == "Down ladder 5/5")
        self.assertEqual(filtered_fifth.limit_price, ladder[4].limit_price)
        self.assertEqual(filtered_fifth.quantity, ladder[4].quantity)


class NormalizeDownLadderLevelsTests(unittest.TestCase):
    def test_dedupes_sorts_and_forces_one_and_two(self):
        self.assertEqual(normalize_down_ladder_levels([4, 3, 3]), [1, 2, 3, 4])

    def test_empty_input_defaults_to_one_and_two(self):
        self.assertEqual(normalize_down_ladder_levels([]), [1, 2])

    def test_strict_mode_rejects_out_of_range_values(self):
        with self.assertRaises(ValueError):
            normalize_down_ladder_levels([1, 2, 9], strict=True)

    def test_lenient_mode_silently_drops_out_of_range_values(self):
        self.assertEqual(normalize_down_ladder_levels([1, 9, 3], strict=False), [1, 2, 3])

    def test_strict_mode_rejects_non_integer_values(self):
        with self.assertRaises(ValueError):
            normalize_down_ladder_levels([1, "x"], strict=True)


class DownLadderValidationTests(unittest.TestCase):
    def test_validate_rejects_state_missing_required_levels(self):
        state = StrategyState(down_ladder_enabled_levels=[3, 4])
        with self.assertRaises(ValueError):
            state.validate()

    def test_validate_rejects_out_of_range_or_duplicate_levels(self):
        with self.assertRaises(ValueError):
            StrategyState(down_ladder_enabled_levels=[1, 2, 9]).validate()
        with self.assertRaises(ValueError):
            StrategyState(down_ladder_enabled_levels=[1, 1, 2]).validate()

    def test_validate_accepts_normalized_levels(self):
        StrategyState(down_ladder_enabled_levels=[1, 2, 3]).validate()


if __name__ == "__main__":
    unittest.main()
