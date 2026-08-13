import tempfile
import unittest
from datetime import date, timedelta
from unittest.mock import patch
from pathlib import Path

from application_engine import ApplicationEngine

_TODAY = date.today().isoformat()
_YESTERDAY = (date.today() - timedelta(days=1)).isoformat()


class MixedAccountBroker:
    mode = "DRY_RUN"
    live_ack = False

    def get_holdings_raw(self):
        return {
            "result": {
                "holdings": [
                    {"symbol": "TQQQ", "quantity": "8", "averagePrice": "75"},
                    {"symbol": "AAPL", "quantity": "3", "averagePrice": "200"},
                    {"symbol": "SOXL", "quantity": "4", "averagePrice": "30"},
                    {"symbol": "BIL", "quantity": "2", "averagePrice": "90"},
                ]
            }
        }

    def get_prices_raw(self, symbols):
        return {
            "result": [
                {"symbol": symbol, "lastPrice": "84.5", "timestamp": _TODAY + "T13:00:00+09:00"}
                for symbol in symbols
            ]
        }

    def get_buying_power_raw(self):
        return {"result": {"cashBuyingPower": "1200"}}

    def get_daily_candles_raw(self, symbol, count):
        return {
            "result": {
                "candles": [
                    {"timestamp": _TODAY + "T13:00:00+09:00", "closePrice": "84.5"},
                    {"timestamp": _YESTERDAY + "T13:00:00+09:00", "closePrice": "82"},
                ]
            }
        }


class ConfigurableBroker:
    mode = "DRY_RUN"
    live_ack = False

    def __init__(self, reject=False):
        self.client_id = ""
        self.client_secret = ""
        self.account_seq = ""
        self.reject = reject

    def list_accounts(self):
        if self.reject:
            raise RuntimeError("invalid credentials")
        if not self.client_id or not self.client_secret or not self.account_seq:
            raise RuntimeError("credentials missing")
        return {"result": []}


class ApplicationEngineAccountTests(unittest.TestCase):
    def test_filters_non_strategy_holdings_before_building_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = MixedAccountBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)

            result = engine.refresh_account("TQQQ")

            self.assertEqual(
                [row["symbol"] for row in result["holdings"]],
                ["SOXL", "TQQQ"],
            )

    def test_snapshot_reads_the_engine_owned_state(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp))

            result = engine.snapshot("TQQQ")

            self.assertEqual(result["state"]["symbol"], "TQQQ")
            self.assertEqual(result["state"]["t_value"], "0")

class LinuxEnvironmentCredentialTests(unittest.TestCase):
    def test_engine_reads_systemd_toss_credentials_from_environment(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(temp)
            with patch("application_engine.os.name", "posix"), patch.dict(
                "application_engine.os.environ",
                {
                    "TOSS_CLIENT_ID": "linux-client",
                    "TOSS_CLIENT_SECRET": "linux-secret",
                    "TOSS_ACCOUNT_SEQ": "linux-account",
                    "MUMAE_MODE": "LIVE",
                },
                clear=False,
            ):
                credentials = engine._stored_credentials()

            self.assertEqual(credentials.client_id, "linux-client")
            self.assertEqual(credentials.client_secret, "linux-secret")
            self.assertEqual(credentials.account_seq, "linux-account")
            self.assertTrue(credentials.live_trading)


class ApplicationEngineCommandTests(unittest.TestCase):
    def test_execute_updates_state_and_records_the_command_source(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp))

            result = engine.execute(
                "strategy.update",
                {"symbol": "TQQQ", "t_value": "3"},
                source="WEB",
                actor="admin-session",
            )

            self.assertEqual(result["state"]["t_value"], "3")
            self.assertEqual(engine.audit_entries()[-1]["source"], "WEB")
            self.assertEqual(engine.audit_entries()[-1]["command"], "strategy.update")

    def test_execute_rejects_unsupported_symbol_before_state_write(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp))

            with self.assertRaisesRegex(ValueError, "지원하지 않는 ETF"):
                engine.execute(
                    "strategy.update",
                    {"symbol": "AAPL"},
                    source="CLI",
                    actor="local",
                )

            self.assertFalse(engine.audit_entries()[-1]["success"])

    def test_api_update_validates_before_saving_and_redacts_the_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = ConfigurableBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)

            result = engine.execute(
                "api.update",
                {
                    "client_id": "client-id",
                    "client_secret": "secret-value",
                    "account_seq": "account-1",
                    "live_trading": False,
                },
                source="CLI",
                actor="local",
            )

            self.assertTrue(result["api_connected"])
            self.assertIs(engine.broker(), broker)
            audit_text = (Path(temp) / "audit.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("secret-value", audit_text)

    def test_api_update_failure_does_not_replace_the_active_broker(self):
        with tempfile.TemporaryDirectory() as temp:
            active = ConfigurableBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: active)
            engine._broker = active
            engine.broker_factory = lambda: ConfigurableBroker(reject=True)

            with self.assertRaisesRegex(RuntimeError, "invalid credentials"):
                engine.execute(
                    "api.update",
                    {
                        "client_id": "bad-id",
                        "client_secret": "bad-secret",
                        "account_seq": "bad-account",
                    },
                    source="CLI",
                    actor="local",
                )

            self.assertIs(engine.broker(), active)


    def test_api_settings_are_readable_without_exposing_the_secret(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = ConfigurableBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute(
                "api.update",
                {
                    "client_id": "client-id",
                    "client_secret": "secret-value",
                    "account_seq": "account-1",
                    "live_trading": True,
                },
                source="WEB",
                actor="admin",
            )

            result = engine.execute("api.settings", {}, source="WEB", actor="admin")

            self.assertTrue(result["configured"])
            self.assertEqual(result["client_id"], "client-id")
            self.assertEqual(result["account_seq"], "account-1")
            self.assertTrue(result["live_trading"])
            self.assertTrue(result["secret_configured"])
            self.assertNotIn("client_secret", result)

    def test_api_update_preserves_a_stored_secret_when_the_field_is_blank(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=ConfigurableBroker)
            engine.execute(
                "api.update",
                {
                    "client_id": "client-id",
                    "client_secret": "secret-value",
                    "account_seq": "account-1",
                },
                source="WEB",
                actor="admin",
            )
            engine.execute(
                "api.update",
                {
                    "client_id": "client-id",
                    "client_secret": "",
                    "account_seq": "account-2",
                },
                source="WEB",
                actor="admin",
            )

            stored = engine._stored_credentials()
            self.assertEqual(stored.client_secret, "secret-value")
            self.assertEqual(stored.account_seq, "account-2")


class ModeBroker:
    def __init__(self, mode="DRY_RUN"):
        self.mode = mode
        self.live_ack = mode == "LIVE"


class SettingsCommandGateTests(unittest.TestCase):
    def test_ladder_levels_change_is_allowed_in_dry_run_without_the_live_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("DRY_RUN"))

            result = engine.execute(
                "strategy.set_ladder_levels",
                {"symbol": "SOXL", "levels": [1, 2, 3]},
                source="WEB", actor="admin",
            )

            self.assertEqual(result["state"]["down_ladder_enabled_levels"], [1, 2, 3])

    def test_ladder_levels_change_is_blocked_in_live_mode_without_the_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("LIVE"))
            with patch.dict("os.environ", {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
                with self.assertRaises(PermissionError):
                    engine.execute(
                        "strategy.set_ladder_levels",
                        {"symbol": "SOXL", "levels": [1, 2, 3]},
                        source="WEB", actor="admin",
                    )

    def test_ladder_levels_change_succeeds_in_live_mode_once_the_gate_is_enabled(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("LIVE"))
            with patch.dict("os.environ", {"MUMAE_WEB_LIVE_ACTIONS": "I_UNDERSTAND_WEB_LIVE_TRADING"}, clear=False):
                result = engine.execute(
                    "strategy.set_ladder_levels",
                    {"symbol": "SOXL", "levels": [1, 2, 3]},
                    source="WEB", actor="admin",
                )

            self.assertEqual(result["state"]["down_ladder_enabled_levels"], [1, 2, 3])

    def test_ladder_levels_rejects_invalid_duplicate_and_unknown_symbol(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("DRY_RUN"))

            with self.assertRaises(ValueError):
                engine.execute("strategy.set_ladder_levels", {"symbol": "SOXL", "levels": [1, 2, 9]}, source="WEB", actor="admin")
            with self.assertRaises(ValueError):
                engine.execute("strategy.set_ladder_levels", {"symbol": "AAPL", "levels": [1, 2, 3]}, source="WEB", actor="admin")

    def test_ladder_levels_change_records_before_and_after_in_the_audit_log(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("DRY_RUN"))

            engine.execute("strategy.set_ladder_levels", {"symbol": "SOXL", "levels": [1, 2, 4]}, source="WEB", actor="admin")

            entry = engine.audit_entries()[-1]
            self.assertEqual(entry["command"], "strategy.set_ladder_levels")
            self.assertEqual(entry["symbol"], "SOXL")
            self.assertEqual(entry["payload"]["before"], [1, 2])
            self.assertEqual(entry["payload"]["after"], [1, 2, 4])

    def test_ladder_levels_change_does_not_touch_broker_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("DRY_RUN"))

            engine.execute("strategy.set_ladder_levels", {"symbol": "SOXL", "levels": [1, 2, 3]}, source="WEB", actor="admin")

            # ModeBroker has no submit_order/cancel_order at all: any attempt to touch
            # broker orders would raise AttributeError, so a clean run proves none happened.

    def test_schedule_update_is_allowed_in_dry_run(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("DRY_RUN"))

            result = engine.execute("schedule.update", {"delay_minutes": 20}, source="WEB", actor="admin")

            self.assertEqual(result["auto_order_delay_minutes"], 20)
            self.assertEqual(engine.runtime_store.load().auto_order_delay_minutes, 20)

    def test_schedule_update_is_blocked_in_live_mode_without_the_gate(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("LIVE"))
            with patch.dict("os.environ", {"MUMAE_WEB_LIVE_ACTIONS": ""}, clear=False):
                with self.assertRaises(PermissionError):
                    engine.execute("schedule.update", {"delay_minutes": 20}, source="WEB", actor="admin")

    def test_schedule_update_rejects_out_of_range_delay(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("DRY_RUN"))

            with self.assertRaises(ValueError):
                engine.execute("schedule.update", {"delay_minutes": 200}, source="WEB", actor="admin")

    def test_schedule_update_records_before_and_after_in_the_audit_log(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("DRY_RUN"))

            engine.execute("schedule.update", {"delay_minutes": 30}, source="WEB", actor="admin")

            entry = engine.audit_entries()[-1]
            self.assertEqual(entry["payload"]["before"], 15)
            self.assertEqual(entry["payload"]["after"], 30)

    def test_settings_commands_do_not_leak_credentials_into_the_audit_log(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: ModeBroker("DRY_RUN"))

            engine.execute("strategy.set_ladder_levels", {"symbol": "SOXL", "levels": [1, 2]}, source="WEB", actor="admin")
            engine.execute("schedule.update", {"delay_minutes": 10}, source="WEB", actor="admin")

            audit_text = (Path(temp) / "audit.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("client_secret", audit_text.lower())


class EtfOverviewTests(unittest.TestCase):
    def test_reports_running_state_last_order_time_error_and_pending_count(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = ApplicationEngine(Path(temp))
            engine.runtime.active_symbols = ["TQQQ"]
            engine.runtime.last_auto_attempt_at = {"TQQQ": "2026-07-20T09:45:03+00:00"}
            engine.runtime.last_auto_error = {"KORU": "가격 범위를 벗어난 주문입니다."}

            overview = {row["symbol"]: row for row in engine.etf_overview()}

            self.assertTrue(overview["TQQQ"]["running"])
            self.assertFalse(overview["KORU"]["running"])
            self.assertEqual(overview["TQQQ"]["last_order_at"], "2026-07-20T09:45:03+00:00")
            self.assertEqual(overview["KORU"]["last_error"], "가격 범위를 벗어난 주문입니다.")
            self.assertEqual(overview["TQQQ"]["pending_orders"], 0)
            self.assertEqual(overview["KORU"]["down_ladder_enabled_levels"], [1, 2])

    def test_covers_every_symbol_in_the_etf_universe(self):
        with tempfile.TemporaryDirectory() as temp:
            from mumae_core import ETF_UNIVERSE
            engine = ApplicationEngine(Path(temp))

            overview = engine.etf_overview()

            self.assertEqual({row["symbol"] for row in overview}, set(ETF_UNIVERSE))


class NoDuplicateSubmissionUnderConcurrencyTests(unittest.TestCase):
    def test_concurrent_auto_tick_and_manual_command_do_not_interleave(self):
        import threading
        import time as time_module

        class SlowLiveBroker:
            mode = "LIVE"
            live_ack = True

            def __init__(self):
                self.calls = []
                self.open_orders = []
                self.closed_orders = []

            def get_all_orders_raw(self, status, symbol, from_date, to_date):
                return list(self.open_orders if status == "OPEN" else self.closed_orders)

            def submit_order(self, order, client_order_id):
                self.calls.append(("start", order.client_order_id))
                time_module.sleep(0.05)
                self.calls.append(("end", order.client_order_id))
                return {"result": {"orderId": f"broker-{len(self.calls)}"}}

        with tempfile.TemporaryDirectory() as temp:
            broker = SlowLiveBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute("plan.calculate", {
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 8, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            }, source="CLI", actor="test")
            engine.execute("orders.sync", {"symbol": "TQQQ"}, source="CLI", actor="test")
            planned = engine.plan_cache["TQQQ"]
            engine.runtime.active_symbols = ["TQQQ"]
            engine.runtime.known_symbols = ["TQQQ"]
            engine.runtime_store.save(engine.runtime)

            errors = []

            def submit_via_command():
                try:
                    engine.execute("order.submit", {
                        "symbol": "TQQQ",
                        "ids": [item.client_order_id for item in planned],
                        "confirmation": f"SUBMIT TQQQ {len(planned)}",
                    }, source="WEB", actor="test")
                except Exception as error:  # noqa: BLE001
                    errors.append(error)

            threads = [threading.Thread(target=submit_via_command) for _ in range(3)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

            # Every "start" must be immediately followed by its own "end" before
            # any other call's "start" -- proves command_lock fully serializes
            # concurrent submission attempts (no interleaved/duplicate sends).
            for index in range(0, len(broker.calls), 2):
                self.assertEqual(broker.calls[index][0], "start")
                self.assertEqual(broker.calls[index + 1][0], "end")
                self.assertEqual(broker.calls[index][1], broker.calls[index + 1][1])


if __name__ == "__main__":
    unittest.main()
