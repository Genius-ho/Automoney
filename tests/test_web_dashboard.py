import json
import os
import tempfile
import threading
import unittest
from datetime import date, timedelta
from decimal import Decimal
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from application_engine import ApplicationEngine
from secure_credentials import TossCredentials
from web_gui.dashboard.server import Auth, Handler
from web_gui.dashboard.service import DashboardService, EngineDashboardService

_TODAY = date.today().isoformat()
_YESTERDAY = (date.today() - timedelta(days=1)).isoformat()


class FakeBroker:
    mode = "DRY_RUN"
    live_ack = False
    client_id = ""
    client_secret = ""
    account_seq = ""

    def get_holdings_raw(self):
        return {"result": {"holdings": [
            {"symbol": "TQQQ", "quantity": "8", "averagePrice": "75"},
            {"symbol": "SOXL", "quantity": "4", "averagePrice": "30"},
            {"symbol": "AAPL", "quantity": "2", "averagePrice": "200"},
        ]}}

    def get_prices_raw(self, symbols):
        prices = {"TQQQ": "84.5", "SOXL": "35"}
        return {"result": [{"symbol": symbol, "lastPrice": prices.get(symbol, "1"), "timestamp": _TODAY + "T13:00:00+09:00"} for symbol in symbols]}

    def get_buying_power_raw(self):
        return {"result": {"cashBuyingPower": "1200"}}

    open_orders = []
    closed_orders = []

    def get_daily_candles_raw(self, symbol, count):
        return {"result": {"candles": [
            {"timestamp": _TODAY + "T13:00:00+09:00", "closePrice": "84.5"},
            {"timestamp": _YESTERDAY + "T13:00:00+09:00", "closePrice": "82"},
        ]}}

    def get_all_orders_raw(self, status, symbol, from_date, to_date):
        return list(self.open_orders if status == "OPEN" else self.closed_orders)


def credentials():
    return TossCredentials("windows-client-id", "windows-secret", "account-1", True)


class WebDashboardLoginUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        static = Path(__file__).resolve().parents[1] / "web_gui" / "dashboard" / "static"
        cls.html = (static / "index.html").read_text(encoding="utf-8")
        cls.javascript = (static / "app.js").read_text(encoding="utf-8")

    def test_login_does_not_reuse_a_saved_browser_password(self):
        self.assertIn('autocomplete="off"', self.html)
        self.assertIn('password.value=""', self.javascript)

    def test_login_password_can_be_visually_verified(self):
        self.assertIn('id="togglePassword"', self.html)
        self.assertIn('password.type=password.type==="password"?"text":"password"', self.javascript)

    def test_login_session_is_sent_without_relying_on_browser_cookies(self):
        self.assertIn('sessionToken=data.session', self.javascript)
        self.assertIn('"X-Mumae-Session":sessionToken', self.javascript)

    def test_etfs_are_horizontal_radio_buttons_and_not_a_select(self):
        self.assertIn('class="etf-picker"', self.html)
        self.assertGreaterEqual(self.html.count('name="symbol" type="radio"'), 11)
        self.assertNotIn('<select id="symbol">', self.html)

    def test_selected_metrics_and_emergency_editor_are_present(self):
        self.assertIn('id="selectedValue"', self.html)
        self.assertIn('metrics.selected_value', self.javascript)
        self.assertNotIn('metrics.holdings_value', self.javascript)
        for identifier in (
            'emergencyForm', 'editPositionQty', 'editAverageCost', 'editTValue',
            'editCash', 'editBaseBuyQty', 'editBigNumberPct', 'editBigNumberEnabled',
        ):
            self.assertIn(identifier, self.html)
        self.assertIn('/api/strategy/update', self.javascript)

    def test_holdings_are_on_top_and_daily_orders_replace_the_old_left_panel(self):
        for identifier in ('orderPlanBody', 'autoPlanStatus', 'orderStatusRefresh'):
            self.assertIn(identifier, self.html)
        for label in ('매수/매도', '수량', '지정가', '주문 방식', '사유', '상태'):
            self.assertIn(label, self.html)
        self.assertLess(self.html.index('전체 계좌 보유종목'), self.html.index('class="metrics"'))
        self.assertLess(self.html.index('class="card order-plan-card"'), self.html.index('class="card emergency-card mumae-only"'))
        self.assertIn('order.status', self.javascript)

    def test_etf_control_table_has_status_start_stop_and_ladder_checkboxes(self):
        for identifier in ('etfOverviewBody', 'autoOrderDelay', 'saveAutoOrderDelay'):
            self.assertIn(identifier, self.html)
        for label in ('상태', '시작', '중지', '마지막 신규 주문 실행 시각', '최근 오류', '미체결 주문'):
            self.assertIn(label, self.html)
        for command in ('auto.start', 'auto.stop', 'strategy.set_ladder_levels', 'schedule.update'):
            self.assertIn(command, self.javascript)
        self.assertIn('/api/etf-status', self.javascript)

    def test_all_five_ladder_checkboxes_are_toggleable(self):
        """Levels 1-2 used to be force-enabled/disabled; a shrinking seed can
        make a trader want to turn those off too, so every level (1-5) must
        now carry the same change listener with no special-cased disabling."""
        self.assertNotIn('level<=2', self.javascript.replace(' ', ''))
        self.assertNotIn('.disabled=true', self.javascript.replace(' ', '').split('ladder-levels')[1].split('body.append(tr)')[0])


class DashboardServiceTests(unittest.TestCase):
    def test_bootstrap_reads_the_windows_data_directory_and_masks_the_secret_context(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "account_alias.txt").write_text("???좎뒪 怨꾩쥖", encoding="utf-8")
            service = DashboardService(root, broker_factory=FakeBroker, credentials_loader=credentials)

            result = service.bootstrap("TQQQ")

            self.assertEqual(result["account_alias"], "???좎뒪 怨꾩쥖")
            self.assertTrue(result["settings"]["configured"])
            self.assertTrue(result["settings"]["client_id"].endswith("t-id"))
            self.assertNotIn("windows-secret", json.dumps(result, ensure_ascii=False))
            self.assertEqual(result["settings"]["data_dir"], str(root.resolve()))

    def test_refresh_uses_loaded_credentials_and_updates_the_shared_state(self):
        with tempfile.TemporaryDirectory() as temp:
            service = DashboardService(temp, broker_factory=FakeBroker, credentials_loader=credentials)

            result = service.refresh_account("TQQQ")

            self.assertTrue(result["api_connected"])
            self.assertEqual([row["symbol"] for row in result["holdings"]], ["SOXL", "TQQQ"])
            self.assertEqual(result["state"]["position_qty"], 8)
            self.assertEqual(result["state"]["avg_cost"], "75")
            self.assertEqual(result["state"]["cash_usd"], "1200")
            self.assertAlmostEqual(
                Decimal(next(row for row in result["holdings"] if row["symbol"] == "TQQQ")["day_change_pct"]),
                (Decimal("84.5") - Decimal("82")) / Decimal("82") * 100,
            )
            self.assertEqual(result["metrics"]["total_asset"], "2016.0")
            self.assertEqual(result["metrics"]["selected_value"], "676.0")
            self.assertEqual({order["side"] for order in result["orders"]}, {"buy", "sell"})
            self.assertIn("selected_active", result["plan_status"])
            self.assertEqual(service.state_store.load("TQQQ").position_qty, 8)

    def test_daily_plan_matches_a_real_toss_order_status(self):
        class StatusBroker(FakeBroker):
            open_orders = []
            closed_orders = []

        with tempfile.TemporaryDirectory() as temp:
            service = DashboardService(temp, broker_factory=StatusBroker, credentials_loader=credentials)
            first = service.refresh_account("TQQQ")
            planned = first["orders"][0]
            StatusBroker.open_orders = [{
                "orderId": "real-order-1", "side": planned["side"].upper(),
                "quantity": planned["quantity"], "price": planned["price"], "status": "PENDING",
            }]
            runtime = service.runtime_store.load()
            runtime.broker_order_ids[planned["id"]] = "real-order-1"
            service.runtime_store.save(runtime)

            refreshed = service.refresh_account("TQQQ")

            matched = next(order for order in refreshed["orders"] if order["id"] == planned["id"])
            self.assertEqual(matched["status"], "PENDING")
            self.assertTrue(refreshed["orders_synced"])

    def test_same_price_broker_order_without_persisted_id_stays_broker_only(self):
        class StatusBroker(FakeBroker):
            open_orders = []
            closed_orders = []

        with tempfile.TemporaryDirectory() as temp:
            service = DashboardService(temp, broker_factory=StatusBroker, credentials_loader=credentials)
            first = service.refresh_account("TQQQ")
            planned = first["orders"][0]
            StatusBroker.open_orders = [{
                "orderId": "manual-order-1", "side": planned["side"].upper(),
                "quantity": planned["quantity"], "price": planned["price"], "status": "PENDING",
            }]

            refreshed = service.refresh_account("TQQQ")

            strategy = next(order for order in refreshed["orders"] if order["id"] == planned["id"])
            broker_only = next(order for order in refreshed["orders"] if order.get("broker_only"))
            self.assertEqual(strategy["status"], "PLANNED")
            self.assertEqual(broker_only["status"], "PENDING")

    def test_emergency_update_persists_the_selected_etf_state(self):
        with tempfile.TemporaryDirectory() as temp:
            service = DashboardService(temp, broker_factory=FakeBroker, credentials_loader=credentials)

            result = service.update_strategy({
                "symbol": "SOXL",
                "position_qty": "7",
                "avg_cost": "31.25",
                "t_value": "4.5",
                "cash_usd": "987.65",
                "base_buy_qty": "4",
                "big_number_pct": "18",
                "big_number_enabled": True,
            })

            state = service.state_store.load("SOXL")
            self.assertEqual(state.position_qty, 7)
            self.assertEqual(str(state.avg_cost), "31.25")
            self.assertEqual(str(state.t_value), "4.5")
            self.assertEqual(str(state.cash_usd), "987.65")
            self.assertEqual(state.base_buy_qty, 4)
            self.assertEqual(str(state.big_number_pct), "18")
            self.assertTrue(state.big_number_enabled)
            self.assertTrue(result["updated"])

class EngineDashboardServiceTests(unittest.TestCase):
    def test_dashboard_refresh_and_emergency_update_use_the_same_engine(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(temp, broker_factory=FakeBroker)
            service = EngineDashboardService(engine)

            refreshed = service.refresh_account("TQQQ")
            updated = service.update_strategy({"symbol": "TQQQ", "t_value": "3"})

            self.assertEqual(refreshed["state"]["position_qty"], 8)
            self.assertEqual(updated["state"]["t_value"], "3")
            self.assertEqual(engine.store.load("TQQQ").t_value, Decimal("3"))
            self.assertEqual(engine.audit_entries()[-1]["command"], "strategy.update")


class WebDashboardHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        Handler.service = DashboardService(
            self.temp.name,
            broker_factory=FakeBroker,
            credentials_loader=credentials,
        )
        Handler.auth = Auth("web-secret")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def _post(self, path, body, headers=None):
        request = Request(
            self.base + path,
            data=json.dumps(body).encode(),
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

    def test_refresh_requires_a_current_login(self):
        status, body, _ = self._post("/api/account/refresh", {"symbol": "TQQQ"})

        self.assertEqual(status, 401)
        self.assertFalse(body["ok"])

    def test_login_response_tells_the_client_how_long_the_session_lasts(self):
        """The frontend warns the user before the session silently expires --
        it needs the actual TTL, not a guess, to compute when to show that."""
        status, login, _ = self._post("/api/login", {"password": "web-secret"})

        self.assertEqual(status, 200)
        self.assertEqual(login["expires_in"], 43200)

    def test_login_then_refresh_returns_the_real_account_contract_in_one_request(self):
        status, login, headers = self._post("/api/login", {"password": "web-secret"})
        cookie = headers["Set-Cookie"].split(";", 1)[0]

        refresh_status, result, _ = self._post(
            "/api/account/refresh",
            {"symbol": "TQQQ"},
            {"Cookie": cookie, "X-Mumae-CSRF": login["csrf"]},
        )

        self.assertEqual(status, 200)
        self.assertEqual(refresh_status, 200)
        self.assertTrue(result["api_connected"])
        self.assertEqual(len(result["holdings"]), 2)

    def test_login_then_refresh_works_when_browser_does_not_store_the_cookie(self):
        status, login, _ = self._post("/api/login", {"password": "web-secret"})

        refresh_status, result, _ = self._post(
            "/api/account/refresh",
            {"symbol": "TQQQ"},
            {"X-Mumae-Session": login["session"], "X-Mumae-CSRF": login["csrf"]},
        )

        self.assertEqual(status, 200)
        self.assertEqual(refresh_status, 200)
        self.assertTrue(result["api_connected"])

    def test_authenticated_emergency_update_persists_state(self):
        _, login, _ = self._post("/api/login", {"password": "web-secret"})
        headers = {"X-Mumae-Session": login["session"], "X-Mumae-CSRF": login["csrf"]}

        status, result, _ = self._post(
            "/api/strategy/update",
            {"symbol": "TQQQ", "position_qty": 3, "avg_cost": "70", "t_value": "2",
             "cash_usd": "500", "base_buy_qty": 2, "big_number_pct": "15",
             "big_number_enabled": False},
            headers,
        )

        self.assertEqual(status, 200)
        self.assertTrue(result["updated"])
        self.assertEqual(Handler.service.state_store.load("TQQQ").position_qty, 3)


class ApiUpdateBroker(FakeBroker):
    def list_accounts(self):
        return {"result": []}


class EngineCommandGateHttpTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False)
        self.env.start()
        self.temp = tempfile.TemporaryDirectory()
        self.engine = ApplicationEngine(self.temp.name, broker_factory=ApiUpdateBroker)
        Handler.service = EngineDashboardService(self.engine)
        Handler.auth = Auth("web-secret")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()
        self.env.stop()

    def _post(self, path, body, headers=None):
        request = Request(
            self.base + path,
            data=json.dumps(body).encode(),
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
        status, login, _ = self._post("/api/login", {"password": "web-secret"})
        self.assertEqual(status, 200)
        return {"X-Mumae-Session": login["session"], "X-Mumae-CSRF": login["csrf"]}

    def _api_update_payload(self):
        return {
            "command": "api.update",
            "payload": {
                "client_id": "new-id",
                "client_secret": "new-secret",
                "account_seq": "acct-1",
                "live_trading": True,
            },
        }

    def test_api_update_via_command_requires_the_live_actions_gate(self):
        headers = self._login()

        status, body, _ = self._post("/api/command", self._api_update_payload(), headers)

        self.assertEqual(status, 401)
        self.assertFalse(body["ok"])

    def test_api_update_via_command_succeeds_once_live_actions_is_enabled(self):
        headers = self._login()
        with patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": "I_UNDERSTAND_WEB_LIVE_TRADING"}, clear=False):
            status, body, _ = self._post("/api/command", self._api_update_payload(), headers)

        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_retry_commands_require_the_live_actions_gate(self):
        headers = self._login()

        for command, payload in (
            ("order.retry_failed", {"client_order_id": "default-SOXL-20260803-star-buy"}),
            ("order.retry_failed_price", {"client_order_id": "default-SOXL-20260803-star-buy", "price": "65.25"}),
        ):
            with self.subTest(command=command):
                status, body, _ = self._post("/api/command", {
                    "command": command,
                    "payload": payload,
                }, headers)
                self.assertEqual(status, 401)
                self.assertFalse(body["ok"])


class DryRunBroker(FakeBroker):
    mode = "DRY_RUN"


class LiveModeBroker(FakeBroker):
    mode = "LIVE"
    live_ack = True


class SettingsCommandHttpTests(unittest.TestCase):
    """strategy.set_ladder_levels / schedule.update: DRY_RUN always allowed,
    LIVE requires MUMAE_WEB_LIVE_ACTIONS (403 when off, not the 401 used by
    login/CSRF failures)."""

    def _server_for(self, broker_factory):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = ApplicationEngine(self.temp.name, broker_factory=broker_factory)
        Handler.service = EngineDashboardService(self.engine)
        Handler.auth = Auth("web-secret")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def _post(self, path, body, headers=None):
        request = Request(
            self.base + path,
            data=json.dumps(body).encode(),
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

    def _get(self, path, headers=None):
        request = Request(self.base + path, headers=headers or {})
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read()), response.headers
        except HTTPError as error:
            try:
                return error.code, json.loads(error.read()), error.headers
            finally:
                error.close()

    def _login(self):
        status, login, _ = self._post("/api/login", {"password": "web-secret"})
        self.assertEqual(status, 200)
        return {"X-Mumae-Session": login["session"], "X-Mumae-CSRF": login["csrf"]}

    def test_ladder_levels_change_succeeds_in_dry_run_with_no_live_actions_env(self):
        with patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
            self._server_for(DryRunBroker)
            headers = self._login()

            status, body, _ = self._post("/api/command", {
                "command": "strategy.set_ladder_levels",
                "payload": {"symbol": "SOXL", "levels": [1, 2, 3]},
            }, headers)

        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["state"]["down_ladder_enabled_levels"], [1, 2, 3])

    def test_ladder_levels_change_returns_403_in_live_mode_without_the_gate(self):
        with patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
            self._server_for(LiveModeBroker)
            headers = self._login()

            status, body, _ = self._post("/api/command", {
                "command": "strategy.set_ladder_levels",
                "payload": {"symbol": "SOXL", "levels": [1, 2, 3]},
            }, headers)

        self.assertEqual(status, 403)
        self.assertFalse(body["ok"])

    def test_schedule_update_succeeds_in_dry_run_and_persists(self):
        with patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
            self._server_for(DryRunBroker)
            headers = self._login()

            status, body, _ = self._post("/api/command", {
                "command": "schedule.update",
                "payload": {"delay_minutes": 25},
            }, headers)

        self.assertEqual(status, 200)
        self.assertEqual(body["auto_order_delay_minutes"], 25)
        self.assertEqual(self.engine.runtime_store.load().auto_order_delay_minutes, 25)

    def test_schedule_update_returns_403_in_live_mode_without_the_gate(self):
        with patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
            self._server_for(LiveModeBroker)
            headers = self._login()

            status, body, _ = self._post("/api/command", {
                "command": "schedule.update",
                "payload": {"delay_minutes": 25},
            }, headers)

        self.assertEqual(status, 403)
        self.assertFalse(body["ok"])

    def test_etf_status_endpoint_returns_every_symbol_and_requires_login(self):
        with patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
            self._server_for(DryRunBroker)

            unauthenticated_status, _, _ = self._get("/api/etf-status")
            headers = self._login()
            status, body, _ = self._get("/api/etf-status", headers)

        self.assertEqual(unauthenticated_status, 401)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(len(body["etf_overview"]), 11)
        self.assertIn("running", body["etf_overview"][0])
        self.assertIn("pending_orders", body["etf_overview"][0])

    def test_etf_status_response_uses_the_exact_down_ladder_field_name(self):
        """Pins the wire field name so a typo (e.g. lan_ladder_enabled_levels)
        would fail this test instead of silently shipping to the frontend."""
        with patch.dict(os.environ, {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
            self._server_for(DryRunBroker)
            headers = self._login()
            status, body, _ = self._get("/api/etf-status", headers)

        row = body["etf_overview"][0]
        self.assertIn("down_ladder_enabled_levels", row)
        self.assertNotIn("lan_ladder_enabled_levels", row)
        self.assertEqual(row["down_ladder_enabled_levels"], [1, 2])


if __name__ == "__main__":
    unittest.main()
