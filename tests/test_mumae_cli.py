import io
import json
import unittest

from mumae_cli import main


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


if __name__ == "__main__":
    unittest.main()
