import tempfile
import unittest
from pathlib import Path

from ui_preferences import UiPreferencesStore


class UiPreferencesStoreTests(unittest.TestCase):
    def test_persists_table_column_widths(self):
        with tempfile.TemporaryDirectory() as directory:
            store = UiPreferencesStore(Path(directory) / "ui_preferences.json")
            widths = {"holdings": {"symbol": 88, "market_value": 140}}

            store.save_column_widths(widths)

            self.assertEqual(store.load_column_widths(), widths)

    def test_invalid_preferences_fall_back_to_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ui_preferences.json"
            path.write_text("not json", encoding="utf-8")
            self.assertEqual(UiPreferencesStore(path).load_column_widths(), {})


if __name__ == "__main__":
    unittest.main()