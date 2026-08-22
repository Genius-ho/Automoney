import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from application_engine import ApplicationEngine, LiveActionsRequiredError
from runtime_store import get_strategy_type


class VRFakeBroker:
    def __init__(self, mode="DRY_RUN"):
        self.mode = mode
        self.live_ack = mode == "LIVE"
        self.holdings = {"TQQQ": ("100", "105")}
        self.prices = {"TQQQ": "110"}

    def get_holdings_raw(self):
        return {"result": {"holdings": [
            {"symbol": symbol, "quantity": qty, "averagePrice": avg}
            for symbol, (qty, avg) in self.holdings.items()
        ]}}

    def get_prices_raw(self, symbols):
        return {"result": [
            {"symbol": symbol, "lastPrice": self.prices.get(symbol, "0"),
             "timestamp": date.today().isoformat() + "T13:00:00+09:00"}
            for symbol in symbols
        ]}

    def get_buying_power_raw(self):
        return {"result": {"cashBuyingPower": "100000"}}

    def get_us_market_calendar_raw(self, date_value=None):
        target = date_value or date.today().isoformat()
        return {"result": {"today": {
            "date": target,
            "regularMarket": {"startTime": f"{target}T09:30:00-04:00", "endTime": f"{target}T16:00:00-04:00"},
        }}}

    def get_all_orders_raw(self, status, symbol, from_date, to_date):
        return []

    def _account_headers(self):
        return {}

    def _request(self, method, path, data=None, headers=None):
        # Matches the real, verified schema (Phase 13): create response has
        # no "status"; cancel is DELETE -> 204 (empty dict); list is GET
        # with a "conditionalOrders" body key.
        if method == "POST" and path == "/api/v1/conditional-orders":
            return {"result": {"conditionalOrderId": "co-1", "clientOrderId": None}}
        if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
            return {}
        if method == "GET" and path.startswith("/api/v1/conditional-orders"):
            return {"result": {"conditionalOrders": [], "hasNext": False, "nextCursor": None}}
        raise AssertionError(f"unexpected _request call: {method} {path}")


class VRDispatchTests(unittest.TestCase):
    def test_vr_initialize_via_execute_creates_active_cycle(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            result = engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            self.assertEqual(result["status"], "ACTIVE")
            self.assertEqual(result["V1"], "11000.00")

    def test_vr_commands_are_recorded_in_the_audit_log(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            entries = engine.audit_entries()
            self.assertTrue(any(entry["command"] == "vr.initialize" and entry["success"] for entry in entries))

    def test_vr_stop_then_start_round_trip_via_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            stopped = engine.execute("vr.stop", {"symbol": "TQQQ"}, source="TEST", actor="tester")
            self.assertEqual(stopped["status"], "STOPPED")
            started = engine.execute("vr.start", {"symbol": "TQQQ"}, source="TEST", actor="tester")
            self.assertEqual(started["status"], "ACTIVE")

    def test_vr_schedule_config_and_cancel_via_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            result = engine.execute(
                "vr.schedule_config", {"symbol": "TQQQ", "G": "20"}, source="TEST", actor="tester"
            )
            self.assertEqual(result["pending_config"]["G"], "20")
            cancelled = engine.execute(
                "vr.cancel_pending_config", {"symbol": "TQQQ", "all": True}, source="TEST", actor="tester"
            )
            self.assertIsNone(cancelled["pending_config"]["G"])

    def test_vr_initialize_accepts_pool_usage_limit_pct_via_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15", "pool_usage_limit_pct": "0.50"},
                source="TEST", actor="tester",
            )
            snapshot = engine.execute("vr.snapshot", {"symbol": "TQQQ"}, source="TEST", actor="tester")
            self.assertEqual(snapshot["current_cycle"]["pool_usage_limit_pct"], "0.50")

    def test_vr_initialize_rejects_invalid_pool_usage_limit_pct_via_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            with self.assertRaises(ValueError):
                engine.execute(
                    "vr.initialize",
                    {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15", "pool_usage_limit_pct": "0.40"},
                    source="TEST", actor="tester",
                )

    def test_vr_schedule_config_pool_usage_limit_pct_via_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            result = engine.execute(
                "vr.schedule_config", {"symbol": "TQQQ", "pool_usage_limit_pct": "0.25"},
                source="TEST", actor="tester",
            )
            self.assertEqual(result["pending_config"]["pool_usage_limit_pct"], "0.25")
            cancelled = engine.execute(
                "vr.cancel_pending_config", {"symbol": "TQQQ", "pool_usage_limit_pct": True},
                source="TEST", actor="tester",
            )
            self.assertIsNone(cancelled["pending_config"]["pool_usage_limit_pct"])

    def test_vr_initialize_accepts_recurring_contribution_via_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15", "recurring_contribution": "500"},
                source="TEST", actor="tester",
            )
            snapshot = engine.execute("vr.snapshot", {"symbol": "TQQQ"}, source="TEST", actor="tester")
            self.assertEqual(snapshot["current_cycle"]["recurring_contribution"], "500")

    def test_vr_schedule_config_recurring_contribution_via_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            result = engine.execute(
                "vr.schedule_config", {"symbol": "TQQQ", "recurring_contribution": "-150"},
                source="TEST", actor="tester",
            )
            self.assertEqual(result["pending_config"]["recurring_contribution"], "-150")
            cancelled = engine.execute(
                "vr.cancel_pending_config", {"symbol": "TQQQ", "recurring_contribution": True},
                source="TEST", actor="tester",
            )
            self.assertIsNone(cancelled["pending_config"]["recurring_contribution"])

    def test_vr_initialize_blocked_in_live_without_web_live_actions_ack(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker(mode="LIVE")
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("MUMAE_WEB_LIVE_ACTIONS", None)
                with self.assertRaises(LiveActionsRequiredError):
                    engine.execute(
                        "vr.initialize",
                        {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                        source="TEST", actor="tester",
                    )

    def test_strategy_set_type_updates_authoritative_source(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "strategy.set_type", {"symbol": "TQQQ", "strategy_type": "VR_SKILL"}, source="TEST", actor="tester"
            )
            self.assertEqual(get_strategy_type(engine.runtime, "TQQQ"), "VR_SKILL")

    def test_strategy_set_type_blocked_by_open_vr_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "strategy.set_type", {"symbol": "TQQQ", "strategy_type": "VR_SKILL"}, source="TEST", actor="tester"
            )
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            with self.assertRaises(ValueError):
                engine.execute(
                    "strategy.set_type", {"symbol": "TQQQ", "strategy_type": "MUMAE"}, source="TEST", actor="tester"
                )


class VRSnapshotAndOverviewTests(unittest.TestCase):
    def test_etf_overview_reports_strategy_type(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "strategy.set_type", {"symbol": "TQQQ", "strategy_type": "VR_SKILL"}, source="TEST", actor="tester"
            )
            overview = {row["symbol"]: row for row in engine.etf_overview()}
            self.assertEqual(overview["TQQQ"]["strategy_type"], "VR_SKILL")
            self.assertEqual(overview["SOXL"]["strategy_type"], "MUMAE")

    def test_vr_snapshot_includes_formula_explain_and_current_cycle(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            snapshot = engine.execute("vr.snapshot", {"symbol": "TQQQ"}, source="TEST", actor="tester")
            self.assertIn("V(next)", snapshot["formula"])
            self.assertEqual(snapshot["current_cycle"]["V"], "11000.00")
            self.assertIn("V", snapshot["explain"])
            self.assertIn("Pool", snapshot["explain"])

    def test_vr_snapshot_includes_history_points_for_the_v1_v2_chart(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = VRFakeBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "vr.initialize",
                {"symbol": "TQQQ", "initial_pool": "1000", "G": "10", "band_pct": "15"},
                source="TEST", actor="tester",
            )
            snapshot = engine.execute("vr.snapshot", {"symbol": "TQQQ"}, source="TEST", actor="tester")
            points = snapshot["history_points"]
            self.assertEqual(len(points), 1)
            self.assertEqual(points[0]["cycle_id"], "TQQQ-c1")
            self.assertEqual(points[0]["V"], "11000.00")
            self.assertIsNone(points[0]["E_at_close"])
            self.assertEqual(points[0]["lower_band"], "9350.00")
            self.assertEqual(points[0]["upper_band"], "12650.00")


if __name__ == "__main__":
    unittest.main()
