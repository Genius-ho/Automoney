import unittest
from datetime import date, timedelta

from backtest_vr import (
    DailyBar,
    VrState,
    band,
    common_start_date,
    next_v,
    rebalance_at_close,
    run_backtest,
)


class NextVTests(unittest.TestCase):
    def test_matches_the_pasted_fire_gate_example(self):
        result = next_v(v=5707.88, pool=1040.00, g=10, contribution=20)

        self.assertAlmostEqual(result, 5831.88)


class BandTests(unittest.TestCase):
    def test_matches_the_pasted_fire_gate_example(self):
        low, high = band(5707.88, 0.15)

        self.assertAlmostEqual(low, 4851.698)
        self.assertAlmostEqual(high, 6564.062)


class RebalanceAtCloseTests(unittest.TestCase):
    def test_no_trade_inside_the_band(self):
        state = VrState(shares=100, pool=1000.0, v=10000.0)

        result = rebalance_at_close(state, price=100.0, band_low=8500.0, band_high=11500.0)

        self.assertIsNone(result)
        self.assertEqual(state.shares, 100)
        self.assertEqual(state.pool, 1000.0)

    def test_sells_down_to_the_band_edge_and_credits_the_pool(self):
        # 100 shares @ 120 = 12000, above band_high 11500 -> sell to floor(11500/120)=95
        state = VrState(shares=100, pool=1000.0, v=10000.0)

        result = rebalance_at_close(state, price=120.0, band_low=8500.0, band_high=11500.0)

        self.assertEqual(result.side, "SELL")
        self.assertEqual(result.shares, 5)
        self.assertEqual(state.shares, 95)
        self.assertAlmostEqual(state.pool, 1000.0 + 5 * 120.0)

    def test_buys_up_to_the_band_edge_and_debits_the_pool(self):
        # 100 shares @ 80 = 8000, below band_low 8500 -> buy to ceil(8500/80)=107
        state = VrState(shares=100, pool=1000.0, v=10000.0, cycle_pool_budget=1000.0)

        result = rebalance_at_close(state, price=80.0, band_low=8500.0, band_high=11500.0)

        self.assertEqual(result.side, "BUY")
        self.assertEqual(result.shares, 7)
        self.assertEqual(state.shares, 107)
        self.assertAlmostEqual(state.pool, 1000.0 - 7 * 80.0)

    def test_buy_is_capped_by_the_remaining_cycle_pool_budget(self):
        # Same setup as above, but budget only allows 3 shares this cycle.
        state = VrState(shares=100, pool=1000.0, v=10000.0, cycle_pool_budget=3 * 80.0)

        result = rebalance_at_close(state, price=80.0, band_low=8500.0, band_high=11500.0)

        self.assertEqual(result.shares, 3)
        self.assertEqual(state.shares, 103)

    def test_buy_is_capped_by_available_pool_cash(self):
        state = VrState(shares=100, pool=150.0, v=10000.0, cycle_pool_budget=1000.0)

        result = rebalance_at_close(state, price=80.0, band_low=8500.0, band_high=11500.0)

        self.assertEqual(result.shares, 1)  # floor(150/80) == 1
        self.assertEqual(state.shares, 101)


class RunBacktestTests(unittest.TestCase):
    def test_flat_price_produces_no_trades_and_equity_equals_initial_cash(self):
        bars = [DailyBar(date(2020, 1, 1) + timedelta(days=index), 100.0) for index in range(30)]

        result = run_backtest(bars, initial_cash=10_000.0, contribution=0.0)

        self.assertEqual(result["trade_count"], 0)
        self.assertAlmostEqual(result["final_equity"], 10_000.0, delta=1.0)

    def test_price_crash_then_recovery_triggers_buys_then_sells(self):
        bars = (
            [DailyBar(date(2020, 1, 1) + timedelta(days=i), 100.0) for i in range(3)]
            + [DailyBar(date(2020, 1, 4) + timedelta(days=i), 60.0) for i in range(10)]
            + [DailyBar(date(2020, 1, 14) + timedelta(days=i), 140.0) for i in range(10)]
        )

        result = run_backtest(bars, initial_cash=10_000.0)

        self.assertGreater(result["buy_count"], 0)
        self.assertGreater(result["sell_count"], 0)

    def test_records_a_buy_and_hold_comparison(self):
        bars = [DailyBar(date(2020, 1, 1), 100.0), DailyBar(date(2020, 1, 2), 110.0)]

        result = run_backtest(bars, initial_cash=10_000.0)

        self.assertAlmostEqual(result["buy_hold_return_pct"], 10.0, delta=0.5)


class CommonStartDateTests(unittest.TestCase):
    def test_picks_the_latest_of_each_symbols_earliest_date(self):
        bars_by_symbol = {
            "A": [DailyBar(date(2015, 1, 1), 1.0)],
            "B": [DailyBar(date(2018, 6, 1), 1.0)],
        }

        self.assertEqual(common_start_date(bars_by_symbol), date(2018, 6, 1))


if __name__ == "__main__":
    unittest.main()
