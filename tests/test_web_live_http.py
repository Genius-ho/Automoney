import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from web_gui.server import WebHandler
from web_gui.web_auth import WebAuth


class FakeLiveService:
    def __init__(self):
        self.calls = []

    def execute(self, command, payload, *, source, actor):
        self.calls.append((command, payload, source, actor))
        if command == "order.submit":
            return {"submitted": payload["ids"], "confirmed": len(payload["ids"]), "errors": []}
        if command == "order.cancel":
            return {"canceled": payload["ids"], "errors": []}
        if command == "auto.start":
            return {"auto_enabled": True, "active_symbols": [payload["symbol"]]}
        if command == "auto.stop":
            return {"auto_enabled": False, "active_symbols": []}
        raise AssertionError(command)


class WebLiveHttpTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "MUMAE_WEB_PASSWORD": "web-secret",
            "MUMAE_WEB_LIVE_ACTIONS": "I_UNDERSTAND_WEB_LIVE_TRADING",
        }, clear=False)
        self.env.start()
        self.service = FakeLiveService()
        WebHandler.service = self.service
        WebHandler.auth = WebAuth()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), WebHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.env.stop()

    def _post(self, path, payload, headers=None):
        request = Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            method="POST",
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read()), response.headers
        except HTTPError as error:
            try:
                return error.code, json.loads(error.read()), error.headers
            finally:
                error.close()

    def _login(self):
        status, payload, headers = self._post("/api/auth/login", {"password": "web-secret"})
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        return {"Cookie": cookie, "X-Mumae-CSRF": payload["csrf"]}

    def test_submit_endpoint_rejects_an_unauthenticated_request(self):
        status, payload, _ = self._post("/api/orders/submit", {
            "symbol": "TQQQ", "ids": ["plan-1"], "confirmation": "SUBMIT TQQQ 1"
        })

        self.assertEqual(status, 403)
        self.assertFalse(payload["ok"])
        self.assertEqual(self.service.calls, [])

    def test_account_refresh_rejects_an_unauthenticated_emergency_change(self):
        status, payload, _ = self._post(
            "/api/account/refresh",
            {"symbol": "TQQQ"},
        )

        self.assertEqual(status, 403)
        self.assertFalse(payload["ok"])
        self.assertEqual(self.service.calls, [])

    def test_loopback_status_does_not_create_an_authenticated_session(self):
        original_auth = WebHandler.auth
        try:
            with patch.dict(os.environ, {"MUMAE_LOCAL_AUTO_LOGIN": "1"}, clear=False):
                WebHandler.auth = WebAuth()
                with urlopen(self.base + "/api/auth/status", timeout=3) as response:
                    payload = json.loads(response.read())
                    self.assertFalse(payload["authenticated"])
                    self.assertIsNone(response.headers.get("Set-Cookie"))
        finally:
            WebHandler.auth = original_auth

    def test_authenticated_submit_routes_to_the_application_engine(self):
        headers = self._login()
        status, payload, _ = self._post("/api/orders/submit", {
            "symbol": "TQQQ", "ids": ["plan-1"], "confirmation": "SUBMIT TQQQ 1"
        }, headers)

        self.assertEqual(status, 200)
        self.assertEqual(payload["confirmed"], 1)
        self.assertEqual(self.service.calls[0][0], "order.submit")
        self.assertEqual(self.service.calls[0][2], "WEB")

    def test_authenticated_cancel_routes_to_the_trading_service(self):
        headers = self._login()
        status, payload, _ = self._post("/api/orders/cancel", {
            "symbol": "TQQQ", "ids": ["plan-1"], "confirmation": "CANCEL TQQQ 1"
        }, headers)

        self.assertEqual(status, 200)
        self.assertEqual(payload["canceled"], ["plan-1"])

    def test_authenticated_auto_start_and_stop_route_to_the_service(self):
        headers = self._login()
        start_status, _, _ = self._post("/api/auto/start", {
            "symbol": "TQQQ", "confirmation": "SUBMIT TQQQ 1"
        }, headers)
        stop_status, _, _ = self._post("/api/auto/stop", {"symbol": "TQQQ"}, headers)

        self.assertEqual(start_status, 200)
        self.assertEqual(stop_status, 200)
        self.assertEqual([call[0] for call in self.service.calls], ["auto.start", "auto.stop"])

    def test_authenticated_generic_command_routes_to_the_engine(self):
        headers = self._login()
        status, payload, _ = self._post(
            "/api/command",
            {
                "command": "auto.stop",
                "payload": {"symbol": "TQQQ"},
            },
            headers,
        )

        self.assertEqual(status, 200)
        self.assertFalse(payload["auto_enabled"])
        self.assertEqual(self.service.calls[-1][0], "auto.stop")


class AutoSchedulerTests(unittest.TestCase):
    def test_live_status_message_reflects_runtime_auth_setting(self):
        from web_gui import server

        message = getattr(server, "_live_status_message", None)
        self.assertIsNotNone(message, "server must report the runtime live-order setting")
        with patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
            self.assertEqual(message(WebAuth()), "Live order submission: DISABLED")
        with patch.dict(
            os.environ,
            {"MUMAE_WEB_LIVE_ACTIONS": "I_UNDERSTAND_WEB_LIVE_TRADING"},
            clear=False,
        ):
            self.assertEqual(message(WebAuth()), "Live order submission: ENABLED")

    def test_background_loop_calls_auto_tick_until_stopped(self):
        from web_gui import server

        auto_loop = getattr(server, "_auto_loop", None)
        self.assertIsNotNone(auto_loop, "server must provide the recurring auto-order loop")

        stopped = threading.Event()
        called = threading.Event()

        class Service:
            def auto_tick(self):
                called.set()
                stopped.set()

        thread = threading.Thread(target=auto_loop, args=(Service(), stopped, 0.01), daemon=True)
        thread.start()
        self.assertTrue(called.wait(1), "auto_tick was not called")
        thread.join(timeout=1)

    def test_auth_factory_loads_dotenv_before_reading_web_settings(self):
        from web_gui import server

        create_auth = getattr(server, "_create_auth", None)
        self.assertIsNotNone(create_auth, "server must create auth after loading .env")
        with patch.object(server, "load_env") as loader:
            create_auth()
        loader.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
