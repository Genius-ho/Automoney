import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from runtime_store import (
    RuntimeStatus,
    RuntimeStore,
    get_strategy_type,
    normalize_delay_minutes,
    prune_order_tracking,
    set_strategy_type,
)


class RuntimeStoreTests(unittest.TestCase):
    def test_persists_active_status(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RuntimeStore(Path(directory) / "runtime.json")
            status = RuntimeStatus(auto_enabled=True, phase="ACTIVE", last_auto_key="2026-07-15-SOXL", active_order_ids=["order-1"], order_price_overrides={"order-1": "19.25"}, auto_attempt_keys={"SOXL": "2026-07-15"})
            store.save(status)
            self.assertEqual(store.load(), status)

    def test_prunes_old_strategy_tracking_but_preserves_recent_and_custom_orders(self):
        old = "default-SOXL-20260601-star-buy"
        recent = "default-SOXL-20260803-star-buy"
        custom = "default-SOXL-20260601-custom-1"
        status = RuntimeStatus(
            active_order_ids=[old, recent, custom],
            skipped_order_ids=[old, recent],
            broker_client_order_ids={old: "old-client", recent: "recent-client", custom: "custom-client"},
            broker_order_ids={old: "old-order", recent: "recent-order", custom: "custom-order"},
            order_price_overrides={old: "10.00", recent: "20.00", custom: "30.00"},
            custom_order_ledger={custom: {"symbol": "SOXL"}},
        )

        changed = prune_order_tracking(status, today=date(2026, 8, 4))

        self.assertTrue(changed)
        self.assertEqual(status.active_order_ids, [recent, custom])
        self.assertEqual(status.skipped_order_ids, [recent])
        self.assertNotIn(old, status.broker_client_order_ids)
        self.assertNotIn(old, status.broker_order_ids)
        self.assertNotIn(old, status.order_price_overrides)
        self.assertIn(recent, status.broker_order_ids)
        self.assertIn(custom, status.broker_order_ids)


class NewOrderControlFieldsTests(unittest.TestCase):
    def test_defaults_are_backward_compatible(self):
        status = RuntimeStatus()
        self.assertEqual(status.known_symbols, [])
        self.assertEqual(status.last_auto_attempt_at, {})
        self.assertEqual(status.last_auto_error, {})
        self.assertEqual(status.auto_order_delay_minutes, 15)
        self.assertEqual(status.auto_day_sell_attempt_keys, {})
        self.assertEqual(status.telegram_update_offset, 0)

    def test_new_fields_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RuntimeStore(Path(directory) / "runtime.json")
            status = RuntimeStatus(
                active_symbols=["TQQQ"],
                known_symbols=["TQQQ", "KORU"],
                last_auto_attempt_at={"TQQQ": "2026-07-20T09:45:03+00:00"},
                last_auto_error={"KORU": "가격 범위를 벗어난 주문입니다."},
                auto_order_delay_minutes=20,
            )
            store.save(status)

            loaded = store.load()

            self.assertEqual(loaded.known_symbols, ["TQQQ", "KORU"])
            self.assertEqual(loaded.last_auto_attempt_at, {"TQQQ": "2026-07-20T09:45:03+00:00"})
            self.assertEqual(loaded.last_auto_error, {"KORU": "가격 범위를 벗어난 주문입니다."})
            self.assertEqual(loaded.auto_order_delay_minutes, 20)

    def test_legacy_file_without_new_fields_loads_with_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            path.write_text(json.dumps({
                "auto_enabled": True,
                "phase": "ACTIVE",
                "active_symbols": ["TQQQ"],
            }), encoding="utf-8")
            store = RuntimeStore(path)

            loaded = store.load()

            self.assertEqual(loaded.active_symbols, ["TQQQ"])
            self.assertEqual(loaded.known_symbols, [])
            self.assertEqual(loaded.auto_order_delay_minutes, 15)


class StrategyTypeRoutingTests(unittest.TestCase):
    def test_defaults_to_mumae_for_unknown_symbols(self):
        status = RuntimeStatus()
        self.assertEqual(get_strategy_type(status, "TQQQ"), "MUMAE")

    def test_set_and_get_round_trip_in_memory(self):
        status = RuntimeStatus()
        set_strategy_type(status, "TQQQ", "VR_SKILL")
        self.assertEqual(get_strategy_type(status, "TQQQ"), "VR_SKILL")
        self.assertEqual(get_strategy_type(status, "SOXL"), "MUMAE")

    def test_rejects_unknown_strategy_type(self):
        status = RuntimeStatus()
        with self.assertRaises(ValueError):
            set_strategy_type(status, "TQQQ", "SOMETHING_ELSE")

    def test_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RuntimeStore(Path(directory) / "runtime.json")
            status = store.load()
            set_strategy_type(status, "TQQQ", "VR_SKILL")
            set_strategy_type(status, "SOXL", "MUMAE")
            set_strategy_type(status, "KORU", "MUMAE")
            store.save(status)

            reloaded = store.load()
            self.assertEqual(get_strategy_type(reloaded, "TQQQ"), "VR_SKILL")
            self.assertEqual(get_strategy_type(reloaded, "SOXL"), "MUMAE")
            self.assertEqual(get_strategy_type(reloaded, "KORU"), "MUMAE")

    def test_legacy_runtime_file_without_strategy_types_defaults_everything_to_mumae(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.json"
            path.write_text(json.dumps({"active_symbols": ["TQQQ"]}), encoding="utf-8")
            store = RuntimeStore(path)
            loaded = store.load()
            self.assertEqual(get_strategy_type(loaded, "TQQQ"), "MUMAE")


class NormalizeDelayMinutesTests(unittest.TestCase):
    def test_accepts_integers_in_range(self):
        self.assertEqual(normalize_delay_minutes(0), 0)
        self.assertEqual(normalize_delay_minutes(180), 180)
        self.assertEqual(normalize_delay_minutes(20), 20)

    def test_rejects_out_of_range_values(self):
        with self.assertRaises(ValueError):
            normalize_delay_minutes(-1)
        with self.assertRaises(ValueError):
            normalize_delay_minutes(181)

    def test_rejects_non_integer_values(self):
        with self.assertRaises(ValueError):
            normalize_delay_minutes(10.5)
        with self.assertRaises(ValueError):
            normalize_delay_minutes("abc")
        with self.assertRaises(ValueError):
            normalize_delay_minutes(True)

    def test_accepts_whole_number_floats_and_numeric_strings(self):
        self.assertEqual(normalize_delay_minutes(20.0), 20)
        self.assertEqual(normalize_delay_minutes("20"), 20)
