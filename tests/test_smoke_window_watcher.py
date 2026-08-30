import unittest
from datetime import date, datetime, timezone
from unittest.mock import patch

import smoke_window_watcher
from smoke_window_watcher import run, wait_for_closed_session


def _session(date_str, start, end):
    return {"startTime": f"{date_str}T{start}", "endTime": f"{date_str}T{end}"}


class FakeCalendarBroker:
    def __init__(self):
        self.calendar_by_date: dict[str, dict] = {}

    def set_calendar_day(self, target_date, **sessions):
        entry = self.calendar_by_date.setdefault(target_date, {"date": target_date})
        for key, (start, end) in sessions.items():
            entry[key] = _session(target_date, start, end)

    def get_us_market_calendar_raw(self, date_value=None):
        target = date_value or date.today().isoformat()
        return {"result": {"today": self.calendar_by_date.get(target, {"date": target})}}


class FakeNotifier:
    chat_id = "12345"
    enabled = True

    def __init__(self):
        self.messages: list[str] = []

    def send_message(self, text, **kwargs):
        self.messages.append(text)
        return {"result": {"message_id": 1}}


class WaitForClosedSessionTests(unittest.TestCase):
    def test_polls_until_closed_and_never_calls_a_mutating_method(self):
        broker = FakeCalendarBroker()
        broker.set_calendar_day("2026-08-21", dayMarket=("00:00:00+00:00", "08:00:00+00:00"))
        clocks = [
            datetime(2026, 8, 21, 1, 0, tzinfo=timezone.utc),  # inside dayMarket -> not closed
            datetime(2026, 8, 22, 3, 0, tzinfo=timezone.utc),  # no session that day -> closed
        ]
        sleeps: list[float] = []

        def fake_clock():
            return clocks.pop(0)

        def fake_sleeper(seconds):
            sleeps.append(seconds)

        result = wait_for_closed_session(broker, poll_interval=300.0, sleeper=fake_sleeper, clock=fake_clock)
        self.assertEqual(result, "CLOSED")
        self.assertEqual(sleeps, [300.0])
        # FakeCalendarBroker exposes no mutating methods at all -- if the
        # watcher ever called one, this test would fail with AttributeError.


class RunTests(unittest.TestCase):
    def test_sends_initial_wait_message_then_closed_message_when_already_closed(self):
        broker = FakeCalendarBroker()  # no sessions configured anywhere -> always CLOSED
        notifier = FakeNotifier()
        run("tqqq", "deploy/mumae.env", broker=broker, notifier=notifier, wait=False)
        self.assertEqual(len(notifier.messages), 2)
        self.assertIn("대기 시작", notifier.messages[0])
        self.assertIn("TQQQ", notifier.messages[0])
        self.assertIn("CLOSED", notifier.messages[1])
        self.assertIn("smoke_conditional_order.py --symbol TQQQ", notifier.messages[1])
        self.assertIn("CREATE/DELETE", notifier.messages[1])

    def test_uppercases_symbol_in_messages(self):
        broker = FakeCalendarBroker()
        notifier = FakeNotifier()
        run("soxl", "deploy/mumae.env", broker=broker, notifier=notifier, wait=False)
        self.assertTrue(all("soxl" not in message for message in notifier.messages))
        self.assertTrue(any("SOXL" in message for message in notifier.messages))

    def test_raises_if_telegram_not_configured(self):
        broker = FakeCalendarBroker()
        notifier = FakeNotifier()
        notifier.enabled = False
        with self.assertRaises(SystemExit):
            run("tqqq", "deploy/mumae.env", broker=broker, notifier=notifier, wait=False)

    def test_wait_true_calls_wait_for_closed_session_before_final_message(self):
        broker = FakeCalendarBroker()
        broker.set_calendar_day("2026-08-21", dayMarket=("00:00:00+00:00", "08:00:00+00:00"))
        notifier = FakeNotifier()
        calls = []

        # Force wait=True but immediately-closed by not configuring any
        # session for "today" as seen by the real clock -- just verify the
        # wait path is exercised without hanging, using a monkeypatched
        # broker whose calendar has no entries at all (always CLOSED).
        empty_broker = FakeCalendarBroker()
        run("tqqq", "deploy/mumae.env", broker=empty_broker, notifier=notifier, wait=True)
        self.assertEqual(len(notifier.messages), 2)

    def test_does_not_load_the_real_env_file_when_fakes_are_already_supplied(self):
        """Regression: run() used to call load_env(env_file) unconditionally,
        even when the caller (e.g. a test) already injected fake broker/
        notifier. load_env() sets real env vars process-wide via
        os.environ.setdefault(), so every *other* test in the same
        unittest-discover run that later constructs a bare TelegramNotifier()
        (e.g. auto_tick's default self.telegram) picked up the real, enabled
        bot token/chat id -- turning fake-broker auto_tick tests into live
        sends of real Telegram messages with real-looking order IDs."""
        broker = FakeCalendarBroker()
        notifier = FakeNotifier()
        with patch.object(smoke_window_watcher, "load_env") as loader:
            run("tqqq", "deploy/mumae.env", broker=broker, notifier=notifier, wait=False)
        loader.assert_not_called()

    def test_still_loads_the_real_env_file_when_the_caller_wants_real_dependencies(self):
        with patch.object(smoke_window_watcher, "load_env") as loader, \
             patch.object(smoke_window_watcher, "TossBroker", return_value=FakeCalendarBroker()), \
             patch.object(smoke_window_watcher, "TelegramNotifier", return_value=FakeNotifier()):
            run("tqqq", "deploy/mumae.env", wait=False)
        loader.assert_called_once_with("deploy/mumae.env")


if __name__ == "__main__":
    unittest.main()
