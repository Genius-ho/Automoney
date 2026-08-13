import unittest
from decimal import Decimal

from market_quote import resolve_day_quote


class ResolveDayQuoteTests(unittest.TestCase):
    def test_uses_previous_session_when_current_daily_candle_exists(self):
        resolved = resolve_day_quote(
            {"lastPrice": "105", "timestamp": "2026-08-12T23:30:00+09:00"},
            [
                {"timestamp": "2026-08-12T13:00:00+09:00", "closePrice": "104"},
                {"timestamp": "2026-08-11T13:00:00+09:00", "closePrice": "100"},
            ],
        )

        self.assertEqual(resolved.current_price, Decimal("105"))
        self.assertEqual(resolved.previous_close, Decimal("100"))
        self.assertEqual(resolved.day_change_pct, Decimal("5"))

    def test_uses_latest_completed_candle_when_current_daily_candle_is_missing(self):
        resolved = resolve_day_quote(
            {"lastPrice": "105", "timestamp": "2026-08-12T23:30:00+09:00"},
            [
                {"timestamp": "2026-08-11T13:00:00+09:00", "closePrice": "100"},
                {"timestamp": "2026-08-08T13:00:00+09:00", "closePrice": "80"},
            ],
        )

        self.assertEqual(resolved.previous_close, Decimal("100"))
        self.assertEqual(resolved.day_change_pct, Decimal("5"))

    def test_is_order_independent_and_ignores_malformed_candles(self):
        resolved = resolve_day_quote(
            {"lastPrice": "105", "timestamp": "2026-08-12T23:30:00+09:00"},
            [
                {"timestamp": "bad", "closePrice": "999"},
                {"timestamp": "2026-08-10T13:00:00+09:00", "closePrice": "90"},
                {"timestamp": "2026-08-12T13:00:00+09:00", "closePrice": "104"},
                {"timestamp": "2026-08-11T13:00:00+09:00", "closePrice": "100"},
                {"timestamp": "2026-08-11T13:00:00+09:00", "closePrice": "not-a-number"},
            ],
        )

        self.assertEqual(resolved.previous_close, Decimal("100"))

    def test_converts_korean_quote_clock_to_us_market_date(self):
        resolved = resolve_day_quote(
            {"lastPrice": "105", "timestamp": "2026-08-13T00:30:00+09:00"},
            [
                {"timestamp": "2026-08-12T13:00:00+09:00", "closePrice": "104"},
                {"timestamp": "2026-08-11T13:00:00+09:00", "closePrice": "100"},
            ],
        )

        self.assertEqual(resolved.previous_close, Decimal("100"))

    def test_returns_no_change_when_quote_timestamp_is_missing(self):
        resolved = resolve_day_quote(
            {"lastPrice": "105"},
            [{"timestamp": "2026-08-11T13:00:00+09:00", "closePrice": "100"}],
        )

        self.assertEqual(resolved.current_price, Decimal("105"))
        self.assertIsNone(resolved.previous_close)
        self.assertIsNone(resolved.day_change_pct)

    def test_returns_no_change_for_invalid_or_nonpositive_values(self):
        invalid_price = resolve_day_quote(
            {"lastPrice": "bad", "timestamp": "2026-08-12T23:30:00+09:00"}, []
        )
        invalid_close = resolve_day_quote(
            {"lastPrice": "105", "timestamp": "2026-08-12T23:30:00+09:00"},
            [{"timestamp": "2026-08-11T13:00:00+09:00", "closePrice": "0"}],
        )

        self.assertEqual(invalid_price.current_price, Decimal("0"))
        self.assertIsNone(invalid_price.day_change_pct)
        self.assertIsNone(invalid_close.previous_close)
        self.assertIsNone(invalid_close.day_change_pct)


if __name__ == "__main__":
    unittest.main()
