import unittest
from datetime import date, datetime
from zoneinfo import ZoneInfo

from intraday_sessions import classify_timestamp, session_phase_key


NY = ZoneInfo("America/New_York")


class IntradaySessionTests(unittest.TestCase):
    def test_session_date_rolls_forward_at_eight_pm_eastern(self):
        context = classify_timestamp(datetime(2026, 8, 24, 20, 0, tzinfo=NY))

        self.assertEqual(context.session_date, date(2026, 8, 25))
        self.assertEqual(context.phase, "DAY")

    def test_phase_boundaries_are_exchange_local(self):
        self.assertEqual(classify_timestamp(datetime(2026, 8, 25, 4, 0, tzinfo=NY)).phase, "PREMARKET")
        self.assertEqual(classify_timestamp(datetime(2026, 8, 25, 9, 30, tzinfo=NY)).phase, "REGULAR")
        self.assertEqual(classify_timestamp(datetime(2026, 8, 25, 16, 0, tzinfo=NY)).phase, "AFTER")
        self.assertEqual(classify_timestamp(datetime(2026, 8, 25, 20, 0, tzinfo=NY)).phase, "DAY")

    def test_same_us_session_spans_midnight(self):
        before_midnight = classify_timestamp(datetime(2026, 8, 24, 23, 59, tzinfo=NY))
        after_midnight = classify_timestamp(datetime(2026, 8, 25, 0, 1, tzinfo=NY))

        self.assertEqual(before_midnight.session_date, date(2026, 8, 25))
        self.assertEqual(after_midnight.session_date, date(2026, 8, 25))
        self.assertEqual(before_midnight.phase, after_midnight.phase)
        self.assertEqual(
            session_phase_key(datetime(2026, 8, 25, 0, 1, tzinfo=NY)),
            (date(2026, 8, 25), "DAY"),
        )

    def test_dst_conversion_does_not_use_a_fixed_korean_offset(self):
        summer = classify_timestamp(datetime(2026, 7, 1, 20, 0, tzinfo=NY))
        winter = classify_timestamp(datetime(2026, 12, 1, 20, 0, tzinfo=NY))

        self.assertEqual(summer.session_date, date(2026, 7, 2))
        self.assertEqual(winter.session_date, date(2026, 12, 2))

    def test_naive_timestamp_is_rejected(self):
        with self.assertRaises(ValueError):
            classify_timestamp(datetime(2026, 8, 25, 9, 30))


if __name__ == "__main__":
    unittest.main()
