import tempfile
import unittest
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from web_gui.web_service import WebService

_TODAY = date.today().isoformat()
_YESTERDAY = (date.today() - timedelta(days=1)).isoformat()


class FakeBroker:
    mode = "DRY_RUN"

    def get_holdings_raw(self):
        return {"result": {"holdings": [{"symbol": "TQQQ", "quantity": "8", "averagePrice": "75"}]}}

    def get_prices_raw(self, symbols):
        return {"result": [{"symbol": symbol, "lastPrice": "84.5", "timestamp": _TODAY + "T13:00:00+09:00"} for symbol in symbols]}

    def get_buying_power_raw(self):
        return {"result": {"cashBuyingPower": "1200"}}

    def get_daily_candles_raw(self, symbol, count):
        return {"result": {"candles": [
            {"timestamp": _TODAY + "T13:00:00+09:00", "closePrice": "84.5"},
            {"timestamp": _YESTERDAY + "T13:00:00+09:00", "closePrice": "82"},
        ]}}


class FakeEmptyBroker(FakeBroker):
    """Reports no TQQQ holding at all -- simulates a position that was just
    fully sold out (take-profit/quarter-sell emptied it to zero)."""

    def get_holdings_raw(self):
        return {"result": {"holdings": []}}


class FakeMixedBroker(FakeBroker):
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


class WebServiceTests(unittest.TestCase):
    def test_calculates_and_persists_a_web_plan(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))
            result = service.plan({
                "symbol": "TQQQ",
                "current_price": "84.5",
                "previous_close": "82",
                "cash_usd": "1200",
                "position_qty": 8,
                "avg_cost": "75",
                "t_value": "3",
                "base_buy_qty": 2,
                "mode": "GENERAL",
            })

            self.assertEqual(result["state"]["t_value"], "3")
            self.assertTrue(result["orders"])
            self.assertFalse(result["live_order_enabled"])
            self.assertEqual(service.load_state("TQQQ").position_qty, 8)

    def test_refreshes_holdings_without_exposing_live_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp), broker_factory=FakeBroker)
            with patch("web_gui.web_service.time.sleep"):
                result = service.refresh_account("TQQQ")

            self.assertTrue(result["api_connected"])
            self.assertEqual(result["holdings"][0]["total_value"], "676.0")
            self.assertEqual(result["holdings"][0]["average_price"], "75")
            self.assertEqual(result["state"]["t_value"], "1")
            self.assertFalse(result["live_order_enabled"])

    def test_refresh_filters_non_strategy_account_holdings(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp), broker_factory=FakeMixedBroker)

            with patch("web_gui.web_service.time.sleep"):
                result = service.refresh_account("TQQQ")

            self.assertEqual(
                [row["symbol"] for row in result["holdings"]],
                ["SOXL", "TQQQ"],
            )

    def test_day_change_pct_is_computed_for_every_held_symbol(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp), broker_factory=FakeMixedBroker)

            with patch("web_gui.web_service.time.sleep"):
                result = service.refresh_account("TQQQ")
            by_symbol = {row["symbol"]: row for row in result["holdings"]}

            self.assertAlmostEqual(Decimal(by_symbol["TQQQ"]["day_change_pct"]), Decimal("2.5") / Decimal("82") * 100)
            self.assertAlmostEqual(Decimal(by_symbol["SOXL"]["day_change_pct"]), Decimal("2.5") / Decimal("82") * 100)

    def test_previous_close_is_found_by_date_not_by_position(self):
        """Regression test: the previous code assumed the second candle in
        the response was always "yesterday" (candles[1]), which silently
        breaks -- including flipping the sign of day_change_pct -- if the
        API ever returns candles in a different order or without today's
        entry. It must find "yesterday" by its own timestamp."""
        class OldestFirstBroker(FakeMixedBroker):
            def get_daily_candles_raw(self, symbol, count):
                return {"result": {"candles": [
                    {"timestamp": _YESTERDAY + "T13:00:00+09:00", "closePrice": "82"},
                    {"timestamp": _TODAY + "T13:00:00+09:00", "closePrice": "84.5"},
                ]}}

        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp), broker_factory=OldestFirstBroker)
            with patch("web_gui.web_service.time.sleep"):
                result = service.refresh_account("TQQQ")
            by_symbol = {row["symbol"]: row for row in result["holdings"]}

            self.assertAlmostEqual(Decimal(by_symbol["TQQQ"]["day_change_pct"]), Decimal("2.5") / Decimal("82") * 100)

    def test_previous_close_ignores_our_own_clock_across_the_kst_us_timezone_gap(self):
        """Regression test: comparing candle dates against date.today() (KST)
        broke as soon as it was deployed -- KST is far enough ahead of US
        market hours that the most recent US session is still labeled
        "yesterday" by KST clock time for most of the US trading day, so
        every symbol's "previous close" resolved to today's own
        in-progress session and day_change_pct came out as 0%. Using dates
        entirely in the past (unrelated to whatever date.today() is when
        this test runs) proves the selection no longer depends on the
        local clock at all -- only on the candle data's own relative dates."""
        class PastDatesBroker(FakeMixedBroker):
            def get_prices_raw(self, symbols):
                return {"result": [
                    {"symbol": symbol, "lastPrice": "84.5", "timestamp": "2020-01-02T23:30:00+09:00"}
                    for symbol in symbols
                ]}

            def get_daily_candles_raw(self, symbol, count):
                return {"result": {"candles": [
                    {"timestamp": "2020-01-02T13:00:00+09:00", "closePrice": "84.5"},
                    {"timestamp": "2020-01-01T13:00:00+09:00", "closePrice": "82"},
                ]}}

        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp), broker_factory=PastDatesBroker)
            with patch("web_gui.web_service.time.sleep"):
                result = service.refresh_account("TQQQ")
            by_symbol = {row["symbol"]: row for row in result["holdings"]}

            self.assertAlmostEqual(Decimal(by_symbol["TQQQ"]["day_change_pct"]), Decimal("2.5") / Decimal("82") * 100)

    def test_previous_close_is_none_when_only_one_session_is_available(self):
        class OneCandleBroker(FakeMixedBroker):
            def get_daily_candles_raw(self, symbol, count):
                return {"result": {"candles": [{"timestamp": _TODAY + "T13:00:00+09:00", "closePrice": "84.5"}]}}

        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp), broker_factory=OneCandleBroker)
            with patch("web_gui.web_service.time.sleep"):
                result = service.refresh_account("TQQQ")
            by_symbol = {row["symbol"]: row for row in result["holdings"]}

            self.assertIsNone(by_symbol["TQQQ"]["day_change_pct"])

    def test_previous_close_is_refetched_so_a_session_change_cannot_stay_cached(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeMixedBroker()
            broker.candle_calls = []
            original = broker.get_daily_candles_raw
            broker.get_daily_candles_raw = lambda ticker, count: (broker.candle_calls.append(ticker), original(ticker, count))[1]
            service = WebService(Path(temp), broker_factory=lambda: broker)

            with patch("web_gui.web_service.time.sleep"):
                service.refresh_account("TQQQ")
                first_call_count = len(broker.candle_calls)
                service.refresh_account("TQQQ")

            self.assertGreater(first_call_count, 0)
            self.assertEqual(len(broker.candle_calls), first_call_count * 2)

    def test_t_value_resets_to_zero_once_the_position_fully_exits(self):
        """A take-profit/quarter-sell pair that empties the position ends the
        cycle; t_value must go back to 0 so the next entry starts a fresh
        cycle instead of showing stale progress from the closed one."""
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp), broker_factory=FakeEmptyBroker)
            service.update_state({
                "symbol": "TQQQ", "position_qty": 10, "avg_cost": "75", "t_value": "11",
            })

            with patch("web_gui.web_service.time.sleep"):
                result = service.refresh_account("TQQQ")

            self.assertEqual(result["state"]["t_value"], "0")
            self.assertEqual(service.load_state("TQQQ").t_value, Decimal("0"))


class DownLadderLevelsUpdateTests(unittest.TestCase):
    def test_update_state_normalizes_and_persists_levels(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            state = service.update_state({"symbol": "SOXL", "down_ladder_enabled_levels": [3, 1, 2, 3]})

            self.assertEqual(state.down_ladder_enabled_levels, [1, 2, 3])
            self.assertEqual(service.load_state("SOXL").down_ladder_enabled_levels, [1, 2, 3])

    def test_update_state_rejects_out_of_range_levels(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            with self.assertRaises(ValueError):
                service.update_state({"symbol": "SOXL", "down_ladder_enabled_levels": [1, 2, 9]})

    def test_update_state_without_the_field_leaves_existing_levels_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))
            service.update_state({"symbol": "SOXL", "down_ladder_enabled_levels": [1, 2, 3]})

            service.update_state({"symbol": "SOXL", "t_value": "2"})

            self.assertEqual(service.load_state("SOXL").down_ladder_enabled_levels, [1, 2, 3])

    def test_levels_are_independent_across_symbols(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            service.update_state({"symbol": "KORU", "down_ladder_enabled_levels": [1, 2]})
            service.update_state({"symbol": "SOXL", "down_ladder_enabled_levels": [1, 2, 3]})

            self.assertEqual(service.load_state("KORU").down_ladder_enabled_levels, [1, 2])
            self.assertEqual(service.load_state("SOXL").down_ladder_enabled_levels, [1, 2, 3])

    def test_can_disable_every_ladder_level(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            state = service.update_state({"symbol": "TQQQ", "down_ladder_enabled_levels": []})

            self.assertEqual(state.down_ladder_enabled_levels, [])
            self.assertEqual(service.load_state("TQQQ").down_ladder_enabled_levels, [])


class FinalTakeProfitPctUpdateTests(unittest.TestCase):
    def test_update_state_persists_an_edited_final_tp_pct(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            state = service.update_state({"symbol": "TQQQ", "final_tp_pct": "18.5"})

            self.assertEqual(state.final_tp_pct, Decimal("18.5"))
            self.assertEqual(service.load_state("TQQQ").final_tp_pct, Decimal("18.5"))

    def test_update_state_without_the_field_leaves_existing_value_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))
            service.update_state({"symbol": "TQQQ", "final_tp_pct": "18.5"})

            service.update_state({"symbol": "TQQQ", "t_value": "2"})

            self.assertEqual(service.load_state("TQQQ").final_tp_pct, Decimal("18.5"))

    def test_update_state_rejects_out_of_range_final_tp_pct(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            with self.assertRaises(ValueError):
                service.update_state({"symbol": "TQQQ", "final_tp_pct": "0"})

    def test_update_state_persists_the_second_tier_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            state = service.update_state({
                "symbol": "TQQQ", "final_tp_pct": "15", "final_tp_qty_pct": "60", "second_tp_pct": "25",
            })

            self.assertEqual(state.final_tp_qty_pct, Decimal("60"))
            self.assertEqual(state.second_tp_pct, Decimal("25"))
            reloaded = service.load_state("TQQQ")
            self.assertEqual(reloaded.final_tp_qty_pct, Decimal("60"))
            self.assertEqual(reloaded.second_tp_pct, Decimal("25"))

    def test_update_state_rejects_second_tp_pct_not_above_first_tier_when_second_tier_is_active(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            with self.assertRaises(ValueError):
                service.update_state({"symbol": "TQQQ", "final_tp_pct": "20", "final_tp_qty_pct": "60", "second_tp_pct": "20"})

    def test_update_state_accepts_a_final_tp_pct_above_the_second_tier_default_when_unconfigured(self):
        """Regression: a symbol with an existing final_tp_pct above the
        second_tp_pct migration default (25) must not fail to save just
        because it never opted into the second tier."""
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp))

            state = service.update_state({"symbol": "TQQQ", "final_tp_pct": "50"})

            self.assertEqual(state.final_tp_pct, Decimal("50"))
            self.assertEqual(state.final_tp_qty_pct, Decimal("100"))


class KnownSymbolsReconciliationTests(unittest.TestCase):
    def test_startup_adds_previously_saved_symbols_to_known_symbols(self):
        with tempfile.TemporaryDirectory() as temp:
            bootstrap = WebService(Path(temp))
            bootstrap.update_state({"symbol": "KORU", "t_value": "1"})
            bootstrap.update_state({"symbol": "TQQQ", "t_value": "1"})

            restarted = WebService(Path(temp))

            self.assertEqual(sorted(restarted.runtime.known_symbols), ["KORU", "TQQQ"])

    def test_startup_reconciliation_does_not_touch_active_symbols(self):
        with tempfile.TemporaryDirectory() as temp:
            bootstrap = WebService(Path(temp))
            bootstrap.update_state({"symbol": "KORU", "t_value": "1"})

            restarted = WebService(Path(temp))

            self.assertEqual(restarted.runtime.active_symbols, [])

    def test_reconciliation_is_a_no_op_when_nothing_changed(self):
        with tempfile.TemporaryDirectory() as temp:
            WebService(Path(temp))  # first boot: nothing saved yet, nothing to reconcile
            path = Path(temp) / "runtime.json"
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
