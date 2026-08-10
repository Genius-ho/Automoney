import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backtest_indicator_sweep import (
    Bar,
    SweepSignal,
    above,
    below,
    both,
    compute_bollinger_percent_b,
    compute_roc_pct,
    compute_sma,
    compute_sma_gap_pct,
    compute_volume_zscore,
    edge_trigger,
    evaluate,
    load_bars,
    sweep_report,
    telegram_summary,
)


def _bar(minute: int, price: float, volume: float = 1.0) -> Bar:
    ts = datetime(2026, 8, 7, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minute)
    return Bar(timestamp=ts, open=price, high=price, low=price, close=price, volume=volume)


class ComputeSmaTests(unittest.TestCase):
    def test_none_until_window_is_full(self):
        result = compute_sma([1.0, 2.0, 3.0], period=3)

        self.assertEqual(result, [None, None, 2.0])


class SmaGapTests(unittest.TestCase):
    def test_matches_manual_percent_deviation(self):
        bars = [_bar(0, 10.0), _bar(3, 10.0), _bar(6, 20.0)]

        gap = compute_sma_gap_pct(bars, period=3)

        expected_sma = (10.0 + 10.0 + 20.0) / 3
        self.assertAlmostEqual(gap[2], (20.0 - expected_sma) / expected_sma * 100)


class BollingerTests(unittest.TestCase):
    def test_flat_window_returns_neutral_50(self):
        bars = [_bar(index * 3, 10.0) for index in range(3)]

        result = compute_bollinger_percent_b(bars, period=3)

        self.assertEqual(result[2], 50.0)

    def test_price_above_upper_band_exceeds_100(self):
        bars = [_bar(index * 3, 10.0) for index in range(9)] + [_bar(27, 50.0)]

        result = compute_bollinger_percent_b(bars, period=10, num_std=2.0)

        self.assertGreater(result[9], 100.0)


class VolumeZscoreTests(unittest.TestCase):
    def test_flat_volume_window_is_zero(self):
        bars = [_bar(index * 3, 10.0, volume=5.0) for index in range(3)]

        result = compute_volume_zscore(bars, period=3)

        self.assertEqual(result[2], 0.0)

    def test_spike_bar_has_a_positive_zscore(self):
        bars = [_bar(0, 10.0, volume=5.0), _bar(3, 10.0, volume=5.0), _bar(6, 10.0, volume=50.0)]

        result = compute_volume_zscore(bars, period=3)

        self.assertGreater(result[2], 0.0)


class RocTests(unittest.TestCase):
    def test_matches_manual_percent_change_over_period(self):
        bars = [_bar(0, 100.0), _bar(3, 110.0), _bar(6, 90.0)]

        result = compute_roc_pct(bars, period=2)

        self.assertAlmostEqual(result[2], (90.0 - 100.0) / 100.0 * 100)


class MaskHelperTests(unittest.TestCase):
    def test_below_ignores_none_values(self):
        self.assertEqual(below([1.0, None, 5.0], 2.0), [True, False, False])

    def test_above_ignores_none_values(self):
        self.assertEqual(above([1.0, None, 5.0], 2.0), [False, False, True])

    def test_both_requires_both_masks_true(self):
        self.assertEqual(both([True, True, False], [True, False, False]), [True, False, False])


class EdgeTriggerTests(unittest.TestCase):
    def test_fires_once_per_excursion(self):
        bars = [_bar(index * 3, 100.0) for index in range(4)]
        buy_mask = [False, True, True, False]
        sell_mask = [False, False, False, False]

        signals = edge_trigger(bars, buy_mask, sell_mask)

        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].index, 1)
        self.assertEqual(signals[0].side, "BUY")


class EvaluateTests(unittest.TestCase):
    def test_buy_forward_return_and_hit_rate(self):
        bars = [_bar(index * 3, price) for index, price in enumerate([100.0, 90.0, 110.0])]
        signal = SweepSignal(index=0, timestamp=bars[0].timestamp, side="BUY", price=100.0)

        result = evaluate(bars, [signal], forward_bars=2)

        self.assertEqual(result["BUY"]["count"], 1)
        self.assertAlmostEqual(result["BUY"]["avg_return_pct"], 10.0)
        self.assertEqual(result["BUY"]["hit_rate_pct"], 100.0)

    def test_side_with_no_signals_reports_none_stats(self):
        bars = [_bar(0, 100.0)]

        result = evaluate(bars, [])

        self.assertEqual(result["SELL"], {"count": 0, "hit_rate_pct": None, "avg_return_pct": None})


class LoadBarsTests(unittest.TestCase):
    def test_live_source_skips_the_cache(self):
        with patch("backtest_indicator_sweep.TossBroker"), \
             patch("backtest_indicator_sweep.fetch_minute_candles") as mock_fetch, \
             patch("backtest_indicator_sweep.candle_logger") as mock_cache:
            mock_fetch.return_value = [_bar(0, 10.0), _bar(1, 10.0), _bar(2, 10.0)]

            bars = load_bars("KORU", source="live")

            mock_cache.update_symbol.assert_not_called()
            self.assertEqual(len(bars), 1)  # 3 one-minute bars resample into 1 three-minute bar

    def test_cache_source_tops_up_then_reads_the_full_accumulated_file(self):
        with patch("backtest_indicator_sweep.TossBroker"), \
             patch("backtest_indicator_sweep.candle_logger") as mock_cache:
            mock_cache.update_symbol.return_value = (0, 3)
            mock_cache.load_existing.return_value = {
                bar.timestamp.isoformat(): bar for bar in [_bar(0, 10.0), _bar(1, 10.0), _bar(2, 10.0)]
            }

            bars = load_bars("KORU", source="cache")

            mock_cache.update_symbol.assert_called_once()
            self.assertEqual(len(bars), 1)


class SweepReportTests(unittest.TestCase):
    def test_report_has_expected_shape_and_counts_distinct_days(self):
        bars = [_bar(index * 3, 10.0 + (index % 5)) for index in range(80)]

        report = sweep_report(bars, "KORU")

        self.assertEqual(report["symbol"], "KORU")
        self.assertEqual(report["bar_count"], 80)
        self.assertEqual(report["days"], 1)
        self.assertIn("grid", report)
        self.assertLessEqual(len(report["buy_top"]), 5)
        self.assertLessEqual(len(report["sell_top"]), 5)


class TelegramSummaryTests(unittest.TestCase):
    def test_includes_symbol_and_falls_back_to_no_match_message(self):
        report = {"symbol": "KORU", "bar_count": 10, "days": 1, "buy_top": [], "sell_top": []}

        text = telegram_summary(report)

        self.assertIn("KORU", text)
        self.assertIn("조건을 만족하는 조합 없음", text)


if __name__ == "__main__":
    unittest.main()
