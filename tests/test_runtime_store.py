import json
import tempfile
import unittest
from pathlib import Path

from runtime_store import RuntimeStatus, RuntimeStore, normalize_delay_minutes


class RuntimeStoreTests(unittest.TestCase):
    def test_persists_active_status(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RuntimeStore(Path(directory) / "runtime.json")
            status = RuntimeStatus(auto_enabled=True, phase="ACTIVE", last_auto_key="2026-07-15-SOXL", active_order_ids=["order-1"], order_price_overrides={"order-1": "19.25"}, auto_attempt_keys={"SOXL": "2026-07-15"})
            store.save(status)
            self.assertEqual(store.load(), status)


class NewOrderControlFieldsTests(unittest.TestCase):
    def test_defaults_are_backward_compatible(self):
        status = RuntimeStatus()
        self.assertEqual(status.known_symbols, [])
        self.assertEqual(status.last_auto_attempt_at, {})
        self.assertEqual(status.last_auto_error, {})
        self.assertEqual(status.auto_order_delay_minutes, 15)

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
