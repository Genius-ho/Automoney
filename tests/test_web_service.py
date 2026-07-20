import tempfile
import unittest
from pathlib import Path

from web_gui.web_service import WebService


class FakeBroker:
    mode = "DRY_RUN"

    def get_holdings_raw(self):
        return {"result": {"holdings": [{"symbol": "TQQQ", "quantity": "8", "averagePrice": "75"}]}}

    def get_prices_raw(self, symbols):
        return {"result": [{"symbol": symbol, "lastPrice": "84.5"} for symbol in symbols]}

    def get_buying_power_raw(self):
        return {"result": {"cashBuyingPower": "1200"}}

    def get_daily_candles_raw(self, symbol, count):
        return {"result": {"candles": [{"closePrice": "84.5"}, {"closePrice": "82"}]}}


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
            result = service.refresh_account("TQQQ")

            self.assertTrue(result["api_connected"])
            self.assertEqual(result["holdings"][0]["total_value"], "676.0")
            self.assertEqual(result["state"]["t_value"], "1")
            self.assertFalse(result["live_order_enabled"])

    def test_refresh_filters_non_strategy_account_holdings(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(Path(temp), broker_factory=FakeMixedBroker)

            result = service.refresh_account("TQQQ")

            self.assertEqual(
                [row["symbol"] for row in result["holdings"]],
                ["SOXL", "TQQQ"],
            )


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
