import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from state_store import StateStore

class StateStoreTests(unittest.TestCase):
    def test_keeps_independent_state_per_symbol(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(Path(directory) / "state.json")
            soxl = store.load("SOXL")
            soxl.position_qty = 10; soxl.avg_cost = Decimal("182"); soxl.t_value = Decimal("4"); soxl.big_number_enabled = True; soxl.big_number_pct = Decimal("18")
            store.save(soxl)
            tqqq = store.load("TQQQ")
            self.assertEqual((tqqq.position_qty, tqqq.avg_cost, tqqq.t_value), (0, Decimal("0"), Decimal("0")))
            loaded = store.load("SOXL")
            self.assertEqual(loaded.position_qty, 10)
            self.assertTrue(loaded.big_number_enabled)
            self.assertEqual(loaded.big_number_pct, Decimal("18"))


class DownLadderLevelsPersistenceTests(unittest.TestCase):
    def test_new_symbol_defaults_to_one_and_two(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(Path(directory) / "state.json")
            self.assertEqual(store.load("TQQQ").down_ladder_enabled_levels, [1, 2])

    def test_levels_are_independent_per_symbol(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(Path(directory) / "state.json")
            koru = store.load("KORU")
            koru.down_ladder_enabled_levels = [1, 2]
            store.save(koru)
            soxl = store.load("SOXL")
            soxl.down_ladder_enabled_levels = [1, 2, 3]
            store.save(soxl)

            self.assertEqual(store.load("KORU").down_ladder_enabled_levels, [1, 2])
            self.assertEqual(store.load("SOXL").down_ladder_enabled_levels, [1, 2, 3])

    def test_legacy_file_without_the_field_loads_with_default(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text(json.dumps({
                "version": 2,
                "last_symbol": "TQQQ",
                "portfolios": {"TQQQ": {"symbol": "TQQQ", "position_qty": 5, "avg_cost": "80", "t_value": "2"}},
            }), encoding="utf-8")
            store = StateStore(path)

            state = store.load("TQQQ")

            self.assertEqual(state.down_ladder_enabled_levels, [1, 2])
            self.assertEqual(state.position_qty, 5)

    def test_legacy_file_with_corrupted_levels_is_normalized_not_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text(json.dumps({
                "version": 2,
                "last_symbol": "SOXL",
                "portfolios": {"SOXL": {"symbol": "SOXL", "down_ladder_enabled_levels": [3, 3, 9, "x"]}},
            }), encoding="utf-8")
            store = StateStore(path)

            state = store.load("SOXL")

            self.assertEqual(state.down_ladder_enabled_levels, [1, 2, 3])


class SavedSymbolsTests(unittest.TestCase):
    def test_returns_symbols_that_have_been_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            store = StateStore(Path(directory) / "state.json")
            self.assertEqual(store.saved_symbols(), [])
            store.save(store.load("KORU"))
            store.save(store.load("TQQQ"))

            self.assertEqual(store.saved_symbols(), ["KORU", "TQQQ"])
