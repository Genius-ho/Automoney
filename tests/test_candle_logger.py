import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import candle_logger
from backtest_vwap_rsi import Bar


def _bar(minute: int, price: float) -> Bar:
    ts = datetime(2026, 8, 7, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=minute)
    return Bar(timestamp=ts, open=price, high=price, low=price, close=price, volume=1.0)


class SaveLoadRoundTripTests(unittest.TestCase):
    def test_round_trips_bars_through_disk(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(candle_logger, "DATA_DIR", Path(temp) / "candles_1m"):
                bar = _bar(0, 12.34)
                candle_logger.save("KORU", {bar.timestamp.isoformat(): bar})

                loaded = candle_logger.load_existing("KORU")

                self.assertEqual(len(loaded), 1)
                restored = loaded[bar.timestamp.isoformat()]
                self.assertEqual(restored.close, 12.34)
                self.assertEqual(restored.timestamp, bar.timestamp)

    def test_missing_file_loads_as_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(candle_logger, "DATA_DIR", Path(temp) / "candles_1m"):
                self.assertEqual(candle_logger.load_existing("KORU"), {})


class UpdateSymbolTests(unittest.TestCase):
    def test_merges_new_candles_without_duplicating_existing_ones(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(candle_logger, "DATA_DIR", Path(temp) / "candles_1m"):
                old_bar = _bar(0, 10.0)
                candle_logger.save("KORU", {old_bar.timestamp.isoformat(): old_bar})

                new_bar = _bar(3, 11.0)
                with patch("candle_logger.fetch_minute_candles", return_value=[old_bar, new_bar]):
                    added, total = candle_logger.update_symbol(MagicMock(), "KORU")

                self.assertEqual(added, 1)
                self.assertEqual(total, 2)
                on_disk = candle_logger.load_existing("KORU")
                self.assertEqual(len(on_disk), 2)

    def test_refetching_the_same_window_adds_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(candle_logger, "DATA_DIR", Path(temp) / "candles_1m"):
                bar = _bar(0, 10.0)
                with patch("candle_logger.fetch_minute_candles", return_value=[bar]):
                    candle_logger.update_symbol(MagicMock(), "KORU")
                    added, total = candle_logger.update_symbol(MagicMock(), "KORU")

                self.assertEqual(added, 0)
                self.assertEqual(total, 1)


if __name__ == "__main__":
    unittest.main()
