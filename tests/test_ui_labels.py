import unittest
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

try:
    from mumae_ui import MumaeApp
except ImportError as error:
    # mumae_ui.py is the Windows-only Tkinter desktop GUI, not shipped in this
    # Linux/web deployment checkout. See tests/test_mumae_ui.py for the same note.
    raise unittest.SkipTest(f"mumae_ui.py not present in this checkout (Windows-only GUI): {error}")


class OrderReasonLabelTests(unittest.TestCase):
    def test_down_ladder_is_explained_as_crash_buy_condition(self):
        self.assertEqual(
            MumaeApp._reason_label("Down ladder 3/5"),
            "급락 시 낮은 가격에서 추가 매수하기 위한 조건 · 3/5단계",
        )

    def test_core_strategy_reasons_are_korean(self):
        samples = {
            "New-cycle LOC buy (previous close +10%)": "새 사이클 첫 매수 · 전일 종가 +10% 이하에서 매수",
            "First-half star LOC buy (50%)": "전반부 STAR 가격 도달 시 기본수량의 50% 매수",
            "First-half average LOC buy (50%)": "전반부 평단 가격 도달 시 기본수량의 50% 매수",
            "Second-half star LOC buy": "후반부 STAR 가격 도달 시 기본수량 전부 매수",
            "Star-price quarter LOC sell": "STAR 가격 도달 시 보유수량의 25% 매도",
            "Final take-profit limit sell (+15% from average)": "평단 대비 +15% 도달 시 남은 수량 전부 익절",
        }
        for reason, expected in samples.items():
            self.assertEqual(MumaeApp._reason_label(reason), expected)


class HoldingsAndChartTests(unittest.TestCase):
    def test_holding_row_includes_current_price(self):
        app = MumaeApp.__new__(MumaeApp)

        values = app._holding_row_values(
            "SOXL", Decimal("12"), Decimal("41.25"), Decimal("30.50"), Decimal("6.5"), Decimal("2")
        )

        self.assertEqual(values, ("SOXL", "12", "41.25", "495.00", "2", "30.50", "+6.50"))

    def test_yahoo_chart_url_uses_selected_etf(self):
        self.assertEqual(
            MumaeApp._yahoo_chart_url(" soxl "),
            "https://finance.yahoo.com/chart/SOXL",
        )

    @patch("mumae_ui.webbrowser.open")
    def test_chart_button_opens_selected_etf_in_default_browser(self, open_browser):
        app = MumaeApp.__new__(MumaeApp)
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="TQQQ"))
        app.status_var = MagicMock()

        app.open_yahoo_chart()

        open_browser.assert_called_once_with("https://finance.yahoo.com/chart/TQQQ", new=2)
        app.status_var.set.assert_called_once_with("TQQQ Yahoo Finance 차트를 열었습니다.")


if __name__ == "__main__":
    unittest.main()
