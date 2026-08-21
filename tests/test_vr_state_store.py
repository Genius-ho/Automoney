import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from vr_state_store import (
    VRConditionalOrder,
    VRCycle,
    VRPendingConfig,
    VRState,
    VRStateStore,
)


class VRStateStoreDefaultsTests(unittest.TestCase):
    def test_new_symbol_defaults_to_uninitialized(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            self.assertEqual(state.symbol, "TQQQ")
            self.assertEqual(state.strategy_type, "VR_SKILL")
            self.assertEqual(state.status, "UNINITIALIZED")
            self.assertIsNone(state.current_cycle)
            self.assertIsNone(state.pending_config.G)
            self.assertIsNone(state.pending_config.band_pct)
            self.assertIsNone(state.pending_config.pool_adjustment)
            self.assertEqual(state.conditional_orders, [])
            self.assertEqual(state.history, [])

    def test_saved_symbols_empty_for_fresh_store(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            self.assertEqual(store.saved_symbols(), [])


class VRStateStoreRoundTripTests(unittest.TestCase):
    def _sample_cycle(self) -> VRCycle:
        return VRCycle(
            cycle_id="c1",
            start_session="2026-08-07",
            end_session="2026-08-21",
            V=Decimal("18500.00"),
            G=Decimal("10"),
            band_pct=Decimal("15"),
            pool_start=Decimal("1231.51"),
            pool_current=Decimal("1000.00"),
            lower_band=Decimal("15725.00"),
            upper_band=Decimal("21275.00"),
            E_at_close=None,
        )

    def test_round_trip_preserves_decimal_precision(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            state.status = "ACTIVE"
            state.initialized_at = "2026-08-07T21:00:00+00:00"
            state.current_cycle = self._sample_cycle()
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertEqual(loaded.status, "ACTIVE")
            self.assertEqual(loaded.current_cycle.V, Decimal("18500.00"))
            self.assertEqual(loaded.current_cycle.pool_start, Decimal("1231.51"))
            self.assertIsInstance(loaded.current_cycle.pool_start, Decimal)
            self.assertIsNone(loaded.current_cycle.E_at_close)
            self.assertIsNone(loaded.current_cycle.planned_buy_spend)

    def test_planned_buy_spend_round_trips_when_set(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            cycle = self._sample_cycle()
            cycle.planned_buy_spend = Decimal("370.93")
            state.current_cycle = cycle
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertEqual(loaded.current_cycle.planned_buy_spend, Decimal("370.93"))
            self.assertIsInstance(loaded.current_cycle.planned_buy_spend, Decimal)

    def test_capacity_blocker_round_trips_when_set(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            state.status = "BROKER_CONDITIONAL_CAPACITY_EXCEEDED"
            state.capacity_blocker = {"buy_count": 18, "sell_count": 100, "total_count": 118, "verified_capacity": 50}
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertEqual(loaded.capacity_blocker, {"buy_count": 18, "sell_count": 100, "total_count": 118, "verified_capacity": 50})

    def test_capacity_blocker_defaults_to_none(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertIsNone(loaded.capacity_blocker)

    def test_e_at_close_round_trips_when_set(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            cycle = self._sample_cycle()
            cycle.E_at_close = Decimal("16380.00")
            state.current_cycle = cycle
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertEqual(loaded.current_cycle.E_at_close, Decimal("16380.00"))

    def test_independent_per_symbol(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            tqqq = store.load("TQQQ")
            tqqq.current_cycle = self._sample_cycle()
            store.save(tqqq)

            soxl = store.load("SOXL")
            self.assertIsNone(soxl.current_cycle)

            self.assertEqual(store.saved_symbols(), ["TQQQ"])
            soxl.status = "ACTIVE"
            store.save(soxl)
            self.assertEqual(store.saved_symbols(), ["SOXL", "TQQQ"])
            self.assertIsNotNone(store.load("TQQQ").current_cycle)

    def test_pending_config_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            state.pending_config = VRPendingConfig(
                G=Decimal("20"), band_pct=Decimal("10"), pool_adjustment=Decimal("300")
            )
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertEqual(loaded.pending_config.G, Decimal("20"))
            self.assertEqual(loaded.pending_config.band_pct, Decimal("10"))
            self.assertEqual(loaded.pending_config.pool_adjustment, Decimal("300"))

    def test_pending_config_partial_fields_stay_none(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            state.pending_config = VRPendingConfig(G=Decimal("20"))
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertEqual(loaded.pending_config.G, Decimal("20"))
            self.assertIsNone(loaded.pending_config.band_pct)
            self.assertIsNone(loaded.pending_config.pool_adjustment)

    def test_conditional_orders_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            state.conditional_orders = [
                VRConditionalOrder(
                    symbol="TQQQ",
                    cycle_id="c1",
                    conditional_order_id="co-123",
                    client_order_id="vr-TQQQ-c1-buy-01-abcd",
                    side="buy",
                    trigger_price=Decimal("100.50"),
                    order_price=Decimal("100.50"),
                    quantity=5,
                    expire_date="2026-08-21",
                    status="OPEN",
                    triggered_order_id=None,
                )
            ]
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertEqual(len(loaded.conditional_orders), 1)
            order = loaded.conditional_orders[0]
            self.assertEqual(order.client_order_id, "vr-TQQQ-c1-buy-01-abcd")
            self.assertEqual(order.trigger_price, Decimal("100.50"))
            self.assertEqual(order.quantity, 5)
            self.assertIsNone(order.triggered_order_id)

    def test_history_round_trips_as_plain_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            store = VRStateStore(Path(directory) / "vr_state.json")
            state = store.load("TQQQ")
            state.history = [
                {"cycle_id": "c1", "V": "18500.00", "E_at_close": "16380.00", "pool_end": "2231.51"}
            ]
            store.save(state)

            loaded = store.load("TQQQ")
            self.assertEqual(loaded.history, [
                {"cycle_id": "c1", "V": "18500.00", "E_at_close": "16380.00", "pool_end": "2231.51"}
            ])


if __name__ == "__main__":
    unittest.main()
