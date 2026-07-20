import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from management_client import DEFAULT_ENGINE_URL, ManagementClient
from web_gui.server import WebHandler
from web_gui.web_auth import WebAuth


class ClientTestEngine:
    def __init__(self):
        self.calls = []

    def snapshot(self, symbol):
        return {"state": {"symbol": symbol, "t_value": "4"}, "orders": []}

    def execute(self, command, payload, *, source, actor):
        self.calls.append((command, payload, source, actor))
        return {"command": command, "state": payload}


class ManagementClientTests(unittest.TestCase):
    def test_windows_default_points_to_the_local_cli_engine(self):
        self.assertEqual(DEFAULT_ENGINE_URL, "http://127.0.0.1:8765")

    def setUp(self):
        self.env = patch.dict(
            os.environ,
            {
                "MUMAE_WEB_PASSWORD": "client-password",
                "MUMAE_WEB_LIVE_ACTIONS": "",
            },
            clear=False,
        )
        self.env.start()
        self.engine = ClientTestEngine()
        WebHandler.service = self.engine
        WebHandler.auth = WebAuth()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), WebHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = ManagementClient(
            f"http://127.0.0.1:{self.server.server_port}"
        )

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.env.stop()

    def test_reads_the_same_engine_snapshot(self):
        result = self.client.get_snapshot("TQQQ")
        self.assertEqual(result["state"]["t_value"], "4")

    def test_emergency_change_requires_login_and_routes_once(self):
        with self.assertRaisesRegex(PermissionError, "로그인"):
            self.client.execute("strategy.update", {"symbol": "TQQQ", "t_value": "5"})

        self.client.login("client-password")
        result = self.client.execute(
            "strategy.update",
            {"symbol": "TQQQ", "t_value": "5"},
        )

        self.assertEqual(result["command"], "strategy.update")
        self.assertEqual(len(self.engine.calls), 1)
        self.assertEqual(self.engine.calls[0][2], "WINDOWS")


if __name__ == "__main__":
    unittest.main()
