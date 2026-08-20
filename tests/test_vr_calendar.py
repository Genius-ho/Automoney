import unittest
from datetime import date, datetime, timedelta, timezone

from vr_engine import (
    anchor_friday_on_or_after,
    find_last_trading_day_on_or_before,
    is_cycle_due_for_transition,
    scheduled_cycle_end_friday,
)


class FakeCalendarBroker:
    """holidays: set of ISO date strings with no regularMarket session.
    sessions: optional dict mapping ISO date string -> (startTime, endTime)
    ISO strings, for dates that need an explicit override (early close, DST
    edge case). Any other non-holiday date gets a generic 09:30-16:00 ET
    (-04:00) session for that date."""

    def __init__(self, holidays=None, sessions=None):
        self.holidays = holidays or set()
        self.sessions = sessions or {}

    def get_us_market_calendar_raw(self, date_str):
        if date_str in self.holidays:
            return {"result": {"today": {"date": date_str}}}
        if date_str in self.sessions:
            start, end = self.sessions[date_str]
        else:
            start = f"{date_str}T09:30:00-04:00"
            end = f"{date_str}T16:00:00-04:00"
        return {"result": {"today": {
            "date": date_str,
            "regularMarket": {"startTime": start, "endTime": end},
        }}}


class AnchorFridayTests(unittest.TestCase):
    def test_start_on_monday_anchors_to_that_weeks_friday(self):
        monday = date(2026, 8, 3)
        self.assertEqual(anchor_friday_on_or_after(monday), date(2026, 8, 7))

    def test_start_on_friday_anchors_to_itself(self):
        friday = date(2026, 8, 7)
        self.assertEqual(anchor_friday_on_or_after(friday), friday)

    def test_start_on_saturday_anchors_to_next_friday(self):
        saturday = date(2026, 8, 8)
        self.assertEqual(anchor_friday_on_or_after(saturday), date(2026, 8, 14))


class ScheduledCycleEndFridayTests(unittest.TestCase):
    def test_cycle_1_is_the_anchor_friday_itself(self):
        anchor = date(2026, 8, 7)
        self.assertEqual(scheduled_cycle_end_friday(anchor, 1), anchor)

    def test_cycles_recur_every_14_days_from_the_anchor_never_drifting(self):
        anchor = date(2026, 8, 7)
        self.assertEqual(scheduled_cycle_end_friday(anchor, 2), date(2026, 8, 21))
        self.assertEqual(scheduled_cycle_end_friday(anchor, 3), date(2026, 9, 4))
        self.assertEqual(scheduled_cycle_end_friday(anchor, 4), date(2026, 9, 18))

    def test_rejects_cycle_number_below_one(self):
        with self.assertRaises(ValueError):
            scheduled_cycle_end_friday(date(2026, 8, 7), 0)


class LastTradingDayResolutionTests(unittest.TestCase):
    def test_normal_friday_resolves_to_itself(self):
        broker = FakeCalendarBroker()
        resolved, session = find_last_trading_day_on_or_before(broker, date(2026, 8, 21))
        self.assertEqual(resolved, date(2026, 8, 21))
        self.assertTrue(session["endTime"].startswith("2026-08-21"))

    def test_holiday_friday_falls_back_to_last_trading_day_that_week(self):
        # 2026-08-21 (Friday) is a holiday; Thursday 08-20 is the real close.
        broker = FakeCalendarBroker(holidays={"2026-08-21"})
        resolved, session = find_last_trading_day_on_or_before(broker, date(2026, 8, 21))
        self.assertEqual(resolved, date(2026, 8, 20))

    def test_multiple_consecutive_holidays_keep_walking_back(self):
        broker = FakeCalendarBroker(holidays={"2026-08-21", "2026-08-20"})
        resolved, session = find_last_trading_day_on_or_before(broker, date(2026, 8, 21))
        self.assertEqual(resolved, date(2026, 8, 19))

    def test_raises_if_no_trading_day_found_within_search_window(self):
        holidays = {(date(2026, 8, 21) - timedelta(days=i)).isoformat() for i in range(10)}
        broker = FakeCalendarBroker(holidays=holidays)
        with self.assertRaises(ValueError):
            find_last_trading_day_on_or_before(broker, date(2026, 8, 21))


class CycleTransitionDueTests(unittest.TestCase):
    def test_not_due_before_session_close(self):
        broker = FakeCalendarBroker(sessions={
            "2026-08-21": ("2026-08-21T09:30:00-04:00", "2026-08-21T16:00:00-04:00"),
        })
        now = datetime(2026, 8, 21, 19, 0, tzinfo=timezone.utc)  # 15:00 ET, before close
        self.assertFalse(is_cycle_due_for_transition(broker, date(2026, 8, 21), now))

    def test_due_after_session_close(self):
        broker = FakeCalendarBroker(sessions={
            "2026-08-21": ("2026-08-21T09:30:00-04:00", "2026-08-21T16:00:00-04:00"),
        })
        now = datetime(2026, 8, 21, 20, 1, tzinfo=timezone.utc)  # just after 16:00 ET close
        self.assertTrue(is_cycle_due_for_transition(broker, date(2026, 8, 21), now))

    def test_early_close_is_read_from_the_calendar_not_hardcoded(self):
        # A 13:00 ET early close (half day) -- must trigger transition right
        # after 13:00 ET, not the usual 16:00 ET.
        broker = FakeCalendarBroker(sessions={
            "2026-11-27": ("2026-11-27T09:30:00-05:00", "2026-11-27T13:00:00-05:00"),
        })
        just_after_early_close = datetime(2026, 11, 27, 18, 1, tzinfo=timezone.utc)  # 13:01 ET
        just_before_early_close = datetime(2026, 11, 27, 17, 59, tzinfo=timezone.utc)  # 12:59 ET
        self.assertTrue(is_cycle_due_for_transition(broker, date(2026, 11, 27), just_after_early_close))
        self.assertFalse(is_cycle_due_for_transition(broker, date(2026, 11, 27), just_before_early_close))

    def test_dst_offset_change_is_honored_via_the_api_provided_offset(self):
        # Same wall-clock ET close time (16:00) but different UTC offsets
        # either side of a DST changeover -- the comparison must use each
        # date's own offset, never a fixed UTC delta.
        broker = FakeCalendarBroker(sessions={
            "2026-03-06": ("2026-03-06T09:30:00-05:00", "2026-03-06T16:00:00-05:00"),  # EST
            "2026-03-20": ("2026-03-20T09:30:00-04:00", "2026-03-20T16:00:00-04:00"),  # EDT
        })
        self.assertTrue(is_cycle_due_for_transition(
            broker, date(2026, 3, 6), datetime(2026, 3, 6, 21, 1, tzinfo=timezone.utc)))
        self.assertFalse(is_cycle_due_for_transition(
            broker, date(2026, 3, 6), datetime(2026, 3, 6, 20, 59, tzinfo=timezone.utc)))
        self.assertTrue(is_cycle_due_for_transition(
            broker, date(2026, 3, 20), datetime(2026, 3, 20, 20, 1, tzinfo=timezone.utc)))
        self.assertFalse(is_cycle_due_for_transition(
            broker, date(2026, 3, 20), datetime(2026, 3, 20, 19, 59, tzinfo=timezone.utc)))


if __name__ == "__main__":
    unittest.main()
