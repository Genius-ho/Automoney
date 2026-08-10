import unittest
from datetime import date

from kiwoom.vr_engine import apply_trade, band, initialize_state, maybe_roll_cycle, next_v, plan_rebalance
from kiwoom.vr_state import VrRuntimeState


class NextVTests(unittest.TestCase):
    def test_matches_the_pasted_fire_gate_example(self):
        self.assertAlmostEqual(next_v(v=5707.88, pool=1040.00, g=10, contribution=20), 5831.88)


class BandTests(unittest.TestCase):
    def test_matches_the_pasted_fire_gate_example(self):
        low, high = band(5707.88, 0.15)
        self.assertAlmostEqual(low, 4851.698)
        self.assertAlmostEqual(high, 6564.062)


class InitializeStateTests(unittest.TestCase):
    def test_seeds_pool_and_position_from_initial_cash(self):
        state = initialize_state("child1", "tqqq", current_price=100.0, initial_cash=10_000.0, today=date(2026, 8, 10))

        self.assertEqual(state.symbol, "TQQQ")
        self.assertEqual(state.shares, 90)  # (10000 - 1000 seed pool) / 100
        self.assertAlmostEqual(state.pool, 1000.0)
        self.assertAlmostEqual(state.v, 9000.0)
        self.assertEqual(state.cycle_start_date, "2026-08-10")


class PlanRebalanceTests(unittest.TestCase):
    def test_no_plan_inside_the_band(self):
        state = VrRuntimeState(
            profile="child1", symbol="TQQQ", shares=100, pool=1000.0, v=10000.0, g=10.0,
            band_pct=0.15, contribution=20.0, cycle_length_days=14, pool_usage_cap_pct=0.75,
            cycle_start_date="2026-08-10",
        )

        self.assertIsNone(plan_rebalance(state, 100.0))

    def test_sell_plan_targets_the_band_edge(self):
        state = VrRuntimeState(
            profile="child1", symbol="TQQQ", shares=100, pool=1000.0, v=10000.0, g=10.0,
            band_pct=0.15, contribution=20.0, cycle_length_days=14, pool_usage_cap_pct=0.75,
            cycle_start_date="2026-08-10",
        )

        plan = plan_rebalance(state, 120.0)  # 100*120=12000 > band_high 11500

        self.assertEqual(plan.side, "SELL")
        self.assertEqual(plan.shares, 5)  # target floor(11500/120)=95
        self.assertEqual(plan.resulting_shares, 95)

    def test_buy_plan_capped_by_cycle_pool_budget(self):
        state = VrRuntimeState(
            profile="child1", symbol="TQQQ", shares=100, pool=1000.0, v=10000.0, g=10.0,
            band_pct=0.15, contribution=20.0, cycle_length_days=14, pool_usage_cap_pct=0.75,
            cycle_start_date="2026-08-10", cycle_pool_budget=3 * 80.0,
        )

        plan = plan_rebalance(state, 80.0)  # would want ceil(8500/80)-100=7 shares, capped to 3

        self.assertEqual(plan.side, "BUY")
        self.assertEqual(plan.shares, 3)


class ApplyTradeTests(unittest.TestCase):
    def test_sell_reduces_shares_and_credits_pool(self):
        state = VrRuntimeState(
            profile="child1", symbol="TQQQ", shares=100, pool=1000.0, v=10000.0, g=10.0,
            band_pct=0.15, contribution=20.0, cycle_length_days=14, pool_usage_cap_pct=0.75,
            cycle_start_date="2026-08-10",
        )
        plan = plan_rebalance(state, 120.0)

        apply_trade(state, plan, date(2026, 8, 11))

        self.assertEqual(state.shares, 95)
        self.assertAlmostEqual(state.pool, 1000.0 + 5 * 120.0)
        self.assertEqual(len(state.trades), 1)
        self.assertEqual(state.trades[0].side, "SELL")

    def test_buy_increases_shares_debits_pool_and_tracks_cycle_spend(self):
        state = VrRuntimeState(
            profile="child1", symbol="TQQQ", shares=100, pool=1000.0, v=10000.0, g=10.0,
            band_pct=0.15, contribution=20.0, cycle_length_days=14, pool_usage_cap_pct=0.75,
            cycle_start_date="2026-08-10", cycle_pool_budget=1000.0,
        )
        plan = plan_rebalance(state, 80.0)

        apply_trade(state, plan, date(2026, 8, 11))

        self.assertEqual(state.shares, 107)
        self.assertAlmostEqual(state.pool, 1000.0 - 7 * 80.0)
        self.assertAlmostEqual(state.cycle_buy_spent, 7 * 80.0)


class MaybeRollCycleTests(unittest.TestCase):
    def test_does_not_roll_before_cycle_length_elapses(self):
        state = VrRuntimeState(
            profile="child1", symbol="TQQQ", shares=100, pool=1000.0, v=10000.0, g=10.0,
            band_pct=0.15, contribution=20.0, cycle_length_days=14, pool_usage_cap_pct=0.75,
            cycle_start_date="2026-08-10",
        )

        rolled = maybe_roll_cycle(state, date(2026, 8, 20))

        self.assertFalse(rolled)
        self.assertEqual(state.cycles_completed, 0)

    def test_rolls_and_grows_v_once_cycle_length_elapses(self):
        state = VrRuntimeState(
            profile="child1", symbol="TQQQ", shares=100, pool=1040.0, v=5707.88, g=10.0,
            band_pct=0.15, contribution=20.0, cycle_length_days=14, pool_usage_cap_pct=0.75,
            cycle_start_date="2026-08-10",
        )

        rolled = maybe_roll_cycle(state, date(2026, 8, 24))

        self.assertTrue(rolled)
        self.assertEqual(state.cycles_completed, 1)
        self.assertAlmostEqual(state.pool, 1040.0 + 20.0)
        self.assertAlmostEqual(state.v, 5707.88 + (1040.0 + 20.0) / 10.0 + 20.0)
        self.assertEqual(state.cycle_start_date, "2026-08-24")
        self.assertEqual(state.cycle_buy_spent, 0.0)


if __name__ == "__main__":
    unittest.main()
