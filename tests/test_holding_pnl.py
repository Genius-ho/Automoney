"""Cost-adjusted broker values must survive every holdings display path."""
import tempfile
import unittest
from decimal import Decimal
from unittest.mock import patch

from application_engine import ApplicationEngine
from tests.test_web_dashboard import FakeBroker, credentials
from web_gui.dashboard.service import DashboardService, EngineDashboardService
from web_gui.web_service import WebService


class HoldingPnlTests(unittest.TestCase):
    def test_broker_net_values_and_fallback_reach_tables_and_summary(self):
        cases = [
            ({"amountAfterCost": "70", "rateAfterCost": "0.1167"}, "70", "11.67", True, True),
            ({"amountAfterCost": "0", "rateAfterCost": "0"}, "0", "0", True, True),
            ({"amountAfterCost": "-6", "rateAfterCost": "-0.01"}, "-6", "-1", True, True),
            ({}, "76", None, False, False),
            ({"amountAfterCost": None, "rateAfterCost": ""}, "76", None, False, False),
            ({"amountAfterCost": "NaN", "rateAfterCost": "Infinity"}, "76", None, False, False),
            ({"amountAfterCost": "bad", "rateAfterCost": "bad"}, "76", None, False, False),
            ({"amountAfterCost": "70"}, "70", None, True, False),
            ({"rateAfterCost": "0.10"}, "76", "10", False, True),
        ]
        for route in ("web", "dashboard", "engine_dashboard", "overseas", "domestic"):
            for profit_loss, amount, rate, net_amount, net_rate in cases:
                with self.subTest(route=route, profit_loss=profit_loss), tempfile.TemporaryDirectory() as temp, patch("time.sleep"):
                    ticker = "005930" if route == "domestic" else "TQQQ"

                    class Broker(FakeBroker):
                        def get_holdings_raw(self):
                            return {"result": {"items": [{
                                "symbol": ticker, "quantity": "8", "averagePurchasePrice": "75",
                                "currency": "KRW" if ticker == "005930" else "USD",
                                "profitLoss": profit_loss,
                                # Already included by Toss; never subtract these again.
                                "cost": {"commission": "4", "tax": "2"},
                            }]}}

                        def get_prices_raw(self, symbols):
                            result = super().get_prices_raw(symbols)
                            for row in result["result"]:
                                row["lastPrice"] = "84.5"
                            return result

                    summary = None
                    if route == "web":
                        result = WebService(temp, Broker).refresh_account(ticker)
                        holding = result["holdings"][0]
                        summary = result["metrics"]["unrealized_pnl"]
                        summary_net = result["metrics"].get("pnl_cost_included")
                    elif route in ("dashboard", "engine_dashboard"):
                        service = (DashboardService(temp, Broker, credentials_loader=credentials)
                                   if route == "dashboard" else EngineDashboardService(ApplicationEngine(temp, Broker)))
                        result = service.refresh_account(ticker)
                        holding = next(row for row in result["holdings"] if row["symbol"] == ticker)
                        summary = result["metrics"]["selected_pnl"]
                        summary_net = result["metrics"].get("pnl_cost_included")
                    else:
                        engine = ApplicationEngine(temp, Broker)
                        holding = (engine.domestic_holdings() if route == "domestic" else engine.overseas_holdings())[0]
                    self.assertEqual(Decimal(holding["pnl"]), Decimal(amount))
                    expected_rate = Decimal(rate) if rate is not None else Decimal("76") / Decimal("600") * 100
                    self.assertEqual(Decimal(holding["pnl_pct"]), expected_rate)
                    self.assertIs(holding.get("pnl_cost_included"), net_amount)
                    self.assertIs(holding.get("pnl_pct_cost_included"), net_rate)
                    if summary is not None:
                        self.assertEqual(Decimal(summary), Decimal(amount))
                        self.assertIs(summary_net, net_amount)

    def test_manual_plan_does_not_claim_costs_were_included(self):
        with tempfile.TemporaryDirectory() as temp:
            service = WebService(temp)
            result = service.dashboard(service.load_state("TQQQ"), Decimal("84.5"))
            self.assertIs(result["metrics"].get("pnl_cost_included"), False)
