import unittest
from decimal import Decimal

from trade_history import aggregate_daily_trades, summarize_realized_pnl


class TradeHistoryTest(unittest.TestCase):
    def test_groups_daily_buys_and_calculates_weighted_average(self):
        rows = [
            self._row("2026-07-14T14:00:00+00:00", "BUY", 2, "10", "0.10"),
            self._row("2026-07-14T15:00:00+00:00", "BUY", 3, "12", "0.15"),
        ]

        result = aggregate_daily_trades(rows)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].quantity, Decimal("5"))
        self.assertEqual(result[0].average_price, Decimal("11.2"))
        self.assertEqual(result[0].commission, Decimal("0.25"))
        self.assertIsNone(result[0].realized_pnl)

    def test_groups_daily_sells_and_reports_net_realized_profit(self):
        rows = [
            self._row("2026-07-13T14:00:00+00:00", "BUY", 10, "10", "1"),
            self._row("2026-07-14T14:00:00+00:00", "SELL", 4, "12", "0.40"),
            self._row("2026-07-14T15:00:00+00:00", "SELL", 1, "14", "0.10"),
        ]

        result = aggregate_daily_trades(rows)
        sell = next(item for item in result if item.side == "SELL")

        self.assertEqual(sell.quantity, Decimal("5"))
        self.assertEqual(sell.average_price, Decimal("12.4"))
        self.assertEqual(sell.commission, Decimal("0.50"))
        self.assertEqual(sell.realized_pnl, Decimal("11.00"))

    def test_summarizes_realized_profit_and_unknown_cost_sales(self):
        rows = [
            self._row("2026-07-13T14:00:00+00:00", "BUY", 10, "10", "1"),
            self._row("2026-07-14T14:00:00+00:00", "SELL", 5, "12", "0.5"),
            self._row("2026-07-15T14:00:00+00:00", "SELL", 10, "13", "1"),
        ]

        total, unknown_sales = summarize_realized_pnl(aggregate_daily_trades(rows))

        self.assertEqual(total, Decimal("9.00"))
        self.assertEqual(unknown_sales, 1)

    def test_pre_split_fills_are_restated_so_a_post_split_sell_finds_its_cost_basis(self):
        """KORU did a real 20:1 split effective 2026-07-15 (see
        corporate_actions.KNOWN_SHARE_SPLITS). Without restating the older,
        pre-split fills, a post-split sell of the same underlying shares
        looks like it exceeds every recorded buy -- production data showed
        exactly this: real gains being reported as "unknown cost basis" and
        dropped from the realized-P/L total."""
        rows = [
            self._row("2026-07-14T14:00:00+00:00", "BUY", "3", "429.9733333333333333333333333", "0", symbol="KORU"),
            self._row("2026-07-16T14:00:00+00:00", "BUY", "10", "21.87", "0", symbol="KORU"),
            self._row("2026-07-23T14:00:00+00:00", "SELL", "50", "22.43086", "0", symbol="KORU"),
        ]

        result = aggregate_daily_trades(rows)
        sell = next(item for item in result if item.side == "SELL")

        # 3 pre-split shares restate to 60 post-split shares; +10 post-split
        # buy = 70 available, comfortably covering the 50-share sell.
        self.assertIsNotNone(sell.realized_pnl)
        total, unknown_sales = summarize_realized_pnl(result)
        self.assertEqual(unknown_sales, 0)
        self.assertGreater(total, Decimal("0"))

    @staticmethod
    def _row(filled_at, side, quantity, price, commission, symbol="SOXL"):
        quantity = Decimal(str(quantity))
        price = Decimal(price)
        return {
            "symbol": symbol,
            "side": side,
            "status": "FILLED",
            "execution": {
                "filledAt": filled_at,
                "filledQuantity": str(quantity),
                "averageFilledPrice": str(price),
                "filledAmount": str(quantity * price),
                "commission": commission,
                "tax": "0",
            },
        }


if __name__ == "__main__":
    unittest.main()
