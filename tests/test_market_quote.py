import unittest
from decimal import Decimal

from datetime import date

from market_quote import KOREA, fetch_krx_regular_close, resolve_day_quote, with_previous_close


class ResolveDayQuoteTests(unittest.TestCase):
    def test_krx_morning_quote_uses_yesterdays_close_not_two_sessions_back(self):
        """10:00 KST is still the previous calendar day in US Eastern, which
        used to make the previous close two sessions old."""
        candles = [
            {"timestamp": "2026-09-21T00:00:00+09:00", "closePrice": "100000"},
            {"timestamp": "2026-09-18T00:00:00+09:00", "closePrice": "90000"},
        ]
        quote = {"lastPrice": "101000", "timestamp": "2026-09-22T10:00:00+09:00"}

        resolved = resolve_day_quote(quote, candles, KOREA)

        self.assertEqual(resolved.previous_close, Decimal("100000"))
        self.assertEqual(resolved.day_change_pct, Decimal("1"))
        # Same quote in the default US zone reproduces the old wrong pick.
        self.assertEqual(resolve_day_quote(quote, candles).previous_close, Decimal("90000"))

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

    def test_returns_no_change_when_quote_timestamp_is_missing_and_no_earlier_candle_exists(self):
        resolved = resolve_day_quote(
            {"lastPrice": "105"},
            [{"timestamp": "2026-08-11T13:00:00+09:00", "closePrice": "100"}],
        )

        self.assertEqual(resolved.current_price, Decimal("105"))
        self.assertIsNone(resolved.previous_close)
        self.assertIsNone(resolved.day_change_pct)

    def test_falls_back_to_newest_candle_date_when_quote_timestamp_is_null(self):
        # Toss's market-indicators price endpoint (KOSPI/KOSDAQ) always
        # returns timestamp: null, unlike the regular stock quote endpoint.
        resolved = resolve_day_quote(
            {"lastPrice": "6912.95", "timestamp": None},
            [
                {"timestamp": "2026-08-21T00:00:00.000+09:00", "closePrice": "6912.95"},
                {"timestamp": "2026-08-20T00:00:00.000+09:00", "closePrice": "6852.58"},
                {"timestamp": "2026-08-19T00:00:00.000+09:00", "closePrice": "6471.17"},
            ],
        )

        self.assertEqual(resolved.previous_close, Decimal("6852.58"))
        self.assertAlmostEqual(float(resolved.day_change_pct), 0.881, places=2)

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


class KrxRegularCloseTests(unittest.TestCase):
    class Broker:
        def __init__(self, candles=None, error=None):
            self.candles, self.error, self.calls = candles or [], error, []

        def get_minute_candles_raw(self, symbol, count, before):
            self.calls.append((symbol, count, before))
            if self.error:
                raise self.error
            return {"result": {"candles": self.candles}}

    def test_reads_the_close_of_the_15_35_minute_candle(self):
        broker = self.Broker([{"timestamp": "2026-09-18T15:35:00.000+09:00", "closePrice": "261000"}])

        close = fetch_krx_regular_close(broker, "005930", date(2026, 9, 18))

        self.assertEqual(close, Decimal("261000"))
        self.assertEqual(broker.calls, [("005930", 1, "2026-09-18T15:35:00+09:00")])

    def test_returns_none_on_error_empty_or_wrong_date(self):
        d = date(2026, 9, 18)
        self.assertIsNone(fetch_krx_regular_close(self.Broker(error=RuntimeError("429")), "005930", d))
        self.assertIsNone(fetch_krx_regular_close(self.Broker([]), "005930", d))
        stale = self.Broker([{"timestamp": "2026-09-17T15:35:00.000+09:00", "closePrice": "252500"}])
        self.assertIsNone(fetch_krx_regular_close(stale, "005930", d))

    def test_with_previous_close_rebases_the_day_change(self):
        candles = [{"timestamp": "2026-09-18T00:00:00.000+09:00", "closePrice": "260000"}]
        resolved = resolve_day_quote({"lastPrice": "274000", "timestamp": "2026-09-21T12:00:00+09:00"}, candles, KOREA)
        self.assertEqual(resolved.previous_session_date, date(2026, 9, 18))

        rebased = with_previous_close(resolved, Decimal("261000"))

        self.assertEqual(round(rebased.day_change_pct, 2), Decimal("4.98"))
        self.assertEqual(rebased.previous_close, Decimal("261000"))


if __name__ == "__main__":
    unittest.main()