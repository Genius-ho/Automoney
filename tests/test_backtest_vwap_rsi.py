import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from backtest_vwap_rsi import (
    Bar,
    compute_rsi,
    compute_stoch_rsi,
    compute_vwap,
    detect_signals,
    evaluate_signals,
    fetch_minute_candles,
    resample,
)


def _bar(minute: int, price: float, volume: float = 1.0, day: int = 1) -> Bar:
    ts = datetime(2026, 8, day, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minute)
    return Bar(timestamp=ts, open=price, high=price, low=price, close=price, volume=volume)


class ResampleTests(unittest.TestCase):
    def test_groups_three_one_minute_bars_into_one_bar_with_correct_ohlcv(self):
        bars = [_bar(0, 10.0), _bar(1, 12.0), _bar(2, 9.0)]

        resampled = resample(bars, minutes=3)

        self.assertEqual(len(resampled), 1)
        bucket = resampled[0]
        self.assertEqual(bucket.open, 10.0)
        self.assertEqual(bucket.high, 12.0)
        self.assertEqual(bucket.low, 9.0)
        self.assertEqual(bucket.close, 9.0)
        self.assertEqual(bucket.volume, 3.0)

    def test_wall_clock_boundary_starts_a_new_bucket(self):
        bars = [_bar(2, 10.0), _bar(3, 11.0)]

        resampled = resample(bars, minutes=3)

        self.assertEqual(len(resampled), 2)


class VwapTests(unittest.TestCase):
    def test_matches_manual_volume_weighted_average(self):
        bars = [_bar(0, 10.0, volume=1.0), _bar(3, 20.0, volume=3.0)]

        vwap = compute_vwap(bars)

        self.assertAlmostEqual(vwap[0], 10.0)
        self.assertAlmostEqual(vwap[1], (10.0 * 1.0 + 20.0 * 3.0) / 4.0)

    def test_resets_cumulative_sums_on_a_new_calendar_day(self):
        bars = [_bar(0, 10.0, volume=1.0, day=1), _bar(0, 50.0, volume=1.0, day=2)]

        vwap = compute_vwap(bars)

        self.assertAlmostEqual(vwap[1], 50.0)


class RsiTests(unittest.TestCase):
    def test_returns_none_until_enough_bars_exist(self):
        closes = [float(value) for value in range(10)]

        rsi = compute_rsi(closes, period=14)

        self.assertTrue(all(value is None for value in rsi))

    def test_monotonically_rising_closes_hit_rsi_100(self):
        closes = [float(value) for value in range(20)]

        rsi = compute_rsi(closes, period=14)

        self.assertEqual(rsi[14], 100.0)

    def test_monotonically_falling_closes_hit_rsi_0(self):
        closes = [float(20 - value) for value in range(20)]

        rsi = compute_rsi(closes, period=14)

        self.assertEqual(rsi[14], 0.0)


class StochRsiTests(unittest.TestCase):
    def test_returns_none_until_enough_bars_for_rsi_and_stoch_window(self):
        closes = [float(value) for value in range(20)]

        k, d = compute_stoch_rsi(closes, rsi_period=14, stoch_period=14, smooth_k=3, smooth_d=3)

        self.assertTrue(all(value is None for value in k))
        self.assertTrue(all(value is None for value in d))

    def test_sustained_monotonic_rise_saturates_near_100(self):
        closes = [float(value) for value in range(60)]

        k, _d = compute_stoch_rsi(closes, rsi_period=14, stoch_period=14, smooth_k=3, smooth_d=3)

        self.assertAlmostEqual(k[-1], 100.0)

    def test_sustained_monotonic_fall_saturates_near_0(self):
        closes = [float(60 - value) for value in range(60)]

        k, _d = compute_stoch_rsi(closes, rsi_period=14, stoch_period=14, smooth_k=3, smooth_d=3)

        self.assertAlmostEqual(k[-1], 0.0)

    def test_k_and_d_stay_within_0_100_bounds(self):
        import math
        closes = [50.0 + 10.0 * math.sin(index / 3.0) for index in range(80)]

        k, d = compute_stoch_rsi(closes)

        for value in k + d:
            if value is not None:
                self.assertGreaterEqual(value, 0.0)
                self.assertLessEqual(value, 100.0)


class DetectSignalsTests(unittest.TestCase):
    def test_fires_once_per_excursion_not_once_per_bar(self):
        prices = [100.0, 80.0, 80.0, 100.0, 100.0]
        bars = [_bar(index * 3, price) for index, price in enumerate(prices)]
        vwap = [100.0] * 5
        # Two consecutive bars have both a big VWAP gap and an extreme RSI.
        rsi = [50.0, 1.0, 1.0, 50.0, 50.0]

        signals = detect_signals(bars, vwap, rsi, vwap_gap_pct=1.5, rsi_buy=2.0)

        buy_signals = [item for item in signals if item.side == "BUY"]
        self.assertEqual(len(buy_signals), 1)
        self.assertEqual(buy_signals[0].index, 1)

    def test_vwap_gap_alone_does_not_trigger_without_an_extreme_rsi(self):
        bars = [_bar(0, 100.0), _bar(3, 103.0)]
        vwap = [100.0, 100.0]
        rsi = [50.0, 50.0]  # not extreme

        signals = detect_signals(bars, vwap, rsi, vwap_gap_pct=1.5, rsi_sell=98.0)

        self.assertEqual(signals, [])

    def test_extreme_rsi_alone_does_not_trigger_without_a_vwap_gap(self):
        bars = [_bar(0, 100.0), _bar(3, 100.0)]
        vwap = [100.0, 100.0]  # no gap
        rsi = [50.0, 99.0]

        signals = detect_signals(bars, vwap, rsi, vwap_gap_pct=1.5, rsi_sell=98.0)

        self.assertEqual(signals, [])

    def test_fires_when_both_vwap_gap_and_extreme_rsi_hold_together(self):
        bars = [_bar(0, 100.0), _bar(3, 103.0)]
        vwap = [100.0, 100.0]
        rsi = [50.0, 99.0]

        signals = detect_signals(bars, vwap, rsi, vwap_gap_pct=1.5, rsi_sell=98.0)

        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].side, "SELL")


class EvaluateSignalsTests(unittest.TestCase):
    def test_buy_signal_forward_return_reflects_price_recovery(self):
        bars = [_bar(index * 3, price) for index, price in enumerate([90.0, 100.0, 105.0])]
        from backtest_vwap_rsi import Signal
        signal = Signal(index=0, timestamp=bars[0].timestamp, side="BUY", price=90.0, vwap_gap_pct=-2.0, rsi=None)

        outcomes = evaluate_signals(bars, [signal], forward_bars=2)

        self.assertEqual(len(outcomes), 1)
        outcome = outcomes[0]
        self.assertAlmostEqual(outcome.forward_return_pct, (105.0 - 90.0) / 90.0 * 100)
        self.assertTrue(outcome.favorable)

    def test_signal_with_no_forward_bars_is_dropped(self):
        bars = [_bar(0, 100.0)]
        from backtest_vwap_rsi import Signal
        signal = Signal(index=0, timestamp=bars[0].timestamp, side="BUY", price=100.0, vwap_gap_pct=-2.0, rsi=None)

        outcomes = evaluate_signals(bars, [signal], forward_bars=5)

        self.assertEqual(outcomes, [])


class FetchMinuteCandlesTests(unittest.TestCase):
    def test_stops_paging_once_next_before_is_null(self):
        broker = MagicMock()
        broker.get_minute_candles_raw.side_effect = [
            {"result": {"candles": [{
                "timestamp": "2026-08-04T09:00:00+00:00",
                "openPrice": "10", "highPrice": "11", "lowPrice": "9", "closePrice": "10.5", "volume": "100",
            }], "nextBefore": "2026-08-04T09:00:00+00:00"}},
            {"result": {"candles": [{
                "timestamp": "2026-08-04T08:59:00+00:00",
                "openPrice": "9", "highPrice": "10", "lowPrice": "9", "closePrice": "9.5", "volume": "50",
            }], "nextBefore": None}},
        ]

        bars = fetch_minute_candles(broker, "KORU", max_pages=10)

        self.assertEqual(broker.get_minute_candles_raw.call_count, 2)
        self.assertEqual(len(bars), 2)
        self.assertLess(bars[0].timestamp, bars[1].timestamp)

    def test_stops_at_max_pages_even_if_more_history_is_available(self):
        broker = MagicMock()
        broker.get_minute_candles_raw.return_value = {
            "result": {
                "candles": [{
                    "timestamp": "2026-08-04T09:00:00+00:00",
                    "openPrice": "10", "highPrice": "10", "lowPrice": "10", "closePrice": "10", "volume": "1",
                }],
                "nextBefore": "2026-08-04T09:00:00+00:00",
            }
        }

        bars = fetch_minute_candles(broker, "KORU", max_pages=3)

        self.assertEqual(broker.get_minute_candles_raw.call_count, 3)
        self.assertEqual(len(bars), 3)


if __name__ == "__main__":
    unittest.main()
