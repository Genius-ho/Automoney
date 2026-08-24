import unittest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from backtest_vwap_rsi import Bar, compute_segmented_rsi, compute_vwap, resample, segment_ranges


NY = ZoneInfo("America/New_York")


def _minute(timestamp: datetime, price: float, volume: float = 1.0) -> Bar:
    return Bar(timestamp, price, price, price, price, volume)


class SessionAwareResamplingTests(unittest.TestCase):
    def test_keeps_only_three_consecutive_minutes_in_one_phase(self):
        start = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        bars = [_minute(start + timedelta(minutes=index), 100 + index) for index in range(3)]

        result = resample(bars)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].open, 100)
        self.assertEqual(result[0].close, 102)
        self.assertEqual(result[0].phase, "REGULAR")
        self.assertEqual(result[0].session_date.isoformat(), "2026-08-25")

    def test_drops_partial_and_missing_minute_buckets(self):
        start = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        bars = [
            _minute(start, 100),
            _minute(start + timedelta(minutes=2), 102),
            _minute(start + timedelta(minutes=3), 103),
        ]

        self.assertEqual(resample(bars), [])

    def test_drops_bucket_that_crosses_a_phase_boundary(self):
        start = datetime(2026, 8, 25, 15, 59, tzinfo=NY)
        bars = [_minute(start + timedelta(minutes=index), 100 + index) for index in range(3)]

        self.assertEqual(resample(bars), [])

    def test_vwap_resets_at_phase_boundary(self):
        regular = datetime(2026, 8, 25, 15, 57, tzinfo=NY)
        after = datetime(2026, 8, 25, 16, 0, tzinfo=NY)
        bars = [
            Bar(regular, 100, 100, 100, 100, 1),
            Bar(after, 50, 50, 50, 50, 1),
        ]

        vwap = compute_vwap(bars)

        self.assertEqual(vwap, [100.0, 50.0])

    def test_vwap_resets_after_a_missing_resampled_bar(self):
        start = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        bars = [
            Bar(start, 100, 100, 100, 100, 1),
            Bar(start + timedelta(minutes=3), 110, 110, 110, 110, 1),
            Bar(start + timedelta(minutes=9), 200, 200, 200, 200, 1),
        ]

        vwap = compute_vwap(bars)

        self.assertEqual(vwap, [100.0, 105.0, 200.0])

    def test_rsi_warmup_restarts_at_phase_boundary(self):
        regular = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        after = datetime(2026, 8, 25, 16, 0, tzinfo=NY)
        bars = [
            Bar(regular + timedelta(minutes=3 * index), 100 + index, 100 + index, 100 + index, 100 + index, 1)
            for index in range(15)
        ] + [
            Bar(after, 200, 200, 200, 200, 1),
        ]

        rsi = compute_segmented_rsi(bars, period=14)

        self.assertEqual(rsi[14], 100.0)
        self.assertIsNone(rsi[15])

    def test_missing_resampled_bar_starts_a_new_indicator_segment(self):
        start = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        bars = [
            Bar(start, 100, 100, 100, 100, 1),
            Bar(start + timedelta(minutes=3), 101, 101, 101, 101, 1),
            Bar(start + timedelta(minutes=9), 102, 102, 102, 102, 1),
        ]

        self.assertEqual(segment_ranges(bars), [(0, 2), (2, 3)])

        rsi = compute_segmented_rsi(bars, period=2)

        self.assertIsNone(rsi[2])


if __name__ == "__main__":
    unittest.main()
