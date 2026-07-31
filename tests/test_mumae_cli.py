import io
import json
import unittest

from mumae_cli import ensure_utf8_console, main


class FakeEngine:
    def __init__(self):
        self.calls = []

    def snapshot(self, symbol):
        self.calls.append(("snapshot", symbol))
        return {"state": {"symbol": symbol, "t_value": "2"}, "orders": []}

    def audit_entries(self):
        return [{"command": "strategy.update", "success": True}]

    def execute(self, command, payload, *, source, actor):
        self.calls.append((command, payload, source, actor))
        return {"ok": True, "command": command, "state": payload}


class MumaeCliTests(unittest.TestCase):
    def test_status_json_uses_engine_snapshot(self):
        engine = FakeEngine()
        stdout = io.StringIO()

        result = main(
            ["--json", "status", "TQQQ"],
            engine=engine,
            stdout=stdout,
        )

        self.assertEqual(result, 0)
        self.assertEqual(json.loads(stdout.getvalue())["state"]["symbol"], "TQQQ")
        self.assertEqual(engine.calls, [("snapshot", "TQQQ")])

    def test_strategy_set_routes_through_the_cli_engine(self):
        engine = FakeEngine()
        stdout = io.StringIO()

        result = main(
            ["--json", "strategy-set", "TQQQ", "--t", "3"],
            engine=engine,
            stdout=stdout,
        )

        self.assertEqual(result, 0)
        self.assertEqual(engine.calls[0][0], "strategy.update")
        self.assertEqual(engine.calls[0][1]["t_value"], "3")
        self.assertEqual(engine.calls[0][2], "CLI")

    def test_api_set_never_echoes_the_secret(self):
        engine = FakeEngine()
        stdout = io.StringIO()

        result = main(
            [
                "--json",
                "api-set",
                "--client-id",
                "client-id",
                "--client-secret",
                "secret-value",
                "--account-seq",
                "account-1",
            ],
            engine=engine,
            stdout=stdout,
        )

        self.assertEqual(result, 0)
        self.assertNotIn("secret-value", stdout.getvalue())
        self.assertEqual(engine.calls[0][0], "api.update")


class EnsureUtf8ConsoleTests(unittest.TestCase):
    """Windows consoles (cmd.exe, PowerShell 5) default to a non-UTF-8 code
    page; every message this app prints is Korean, so without forcing UTF-8,
    the first Korean string -- including from the background auto-tick
    thread's error logging -- raises UnicodeEncodeError and silently kills
    that thread with no systemd-style auto-restart to catch it."""

    def test_reconfigures_streams_that_support_it(self):
        calls = []

        class FakeConsoleStream:
            def reconfigure(self, encoding, errors):
                calls.append((encoding, errors))

        ensure_utf8_console([FakeConsoleStream()])

        self.assertEqual(calls, [("utf-8", "replace")])

    def test_skips_streams_without_reconfigure(self):
        # io.StringIO (what tests use to capture output) has no reconfigure
        # method -- must be skipped, not raise.
        ensure_utf8_console([io.StringIO()])

    def test_swallows_reconfigure_failures(self):
        class BrokenStream:
            def reconfigure(self, encoding, errors):
                raise OSError("no console attached")

        ensure_utf8_console([BrokenStream()])


if __name__ == "__main__":
    unittest.main()
