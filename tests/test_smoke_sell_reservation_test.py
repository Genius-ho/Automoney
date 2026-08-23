import unittest
from datetime import datetime, timezone
from decimal import Decimal

from smoke_sell_reservation_test import (
    SELL_SAFETY_MARGIN,
    SELL_SAFETY_MARGIN_B,
    compute_sell_smoke_order,
    fetch_holding_snapshot,
)
from tests.test_smoke_conditional_order import FakeSmokeBroker


class ComputeSellSmokeOrderTests(unittest.TestCase):
    def test_trigger_is_above_current_price_by_the_configured_margin(self):
        request = compute_sell_smoke_order("TQQQ", Decimal("100"), "2026-08-26", quantity=5, client_order_id="x")
        self.assertEqual(request.trigger_price, Decimal("150.00"))
        self.assertEqual(request.order_price, request.trigger_price)
        self.assertEqual(request.side, "sell")
        self.assertEqual(request.quantity, 5)

    def test_order_a_and_order_b_margins_produce_distinct_prices(self):
        current_price = Decimal("110.55")
        request_a = compute_sell_smoke_order(
            "TQQQ", current_price, "2026-08-26", quantity=100, client_order_id="a", margin=SELL_SAFETY_MARGIN,
        )
        request_b = compute_sell_smoke_order(
            "TQQQ", current_price, "2026-08-26", quantity=1, client_order_id="b", margin=SELL_SAFETY_MARGIN_B,
        )
        self.assertNotEqual(request_a.trigger_price, request_b.trigger_price)
        self.assertGreater(request_b.trigger_price, request_a.trigger_price)

    def test_rounds_to_the_cent_half_up(self):
        request = compute_sell_smoke_order("TQQQ", Decimal("110.555"), "2026-08-26", quantity=1, client_order_id="x")
        self.assertEqual(request.trigger_price, (Decimal("110.555") * SELL_SAFETY_MARGIN).quantize(Decimal("0.01")))


class FetchHoldingSnapshotTests(unittest.TestCase):
    def test_reads_quantity_field_and_returns_full_raw_row(self):
        broker = FakeSmokeBroker()
        broker.get_holdings_raw = lambda: {
            "result": [{"symbol": "TQQQ", "quantity": "150", "avgPrice": "42.10"}]
        }
        quantity, row = fetch_holding_snapshot(broker, "TQQQ")
        self.assertEqual(quantity, Decimal("150"))
        self.assertEqual(row["avgPrice"], "42.10")

    def test_falls_back_through_field_names_in_priority_order(self):
        broker = FakeSmokeBroker()
        broker.get_holdings_raw = lambda: {
            "result": [{"symbol": "TQQQ", "sellableQuantity": "80"}]
        }
        quantity, _ = fetch_holding_snapshot(broker, "TQQQ")
        self.assertEqual(quantity, Decimal("80"))

    def test_missing_symbol_returns_zero(self):
        broker = FakeSmokeBroker()
        broker.get_holdings_raw = lambda: {"result": []}
        quantity, row = fetch_holding_snapshot(broker, "TQQQ")
        self.assertEqual(quantity, Decimal("0"))
        self.assertEqual(row, {})


if __name__ == "__main__":
    unittest.main()
