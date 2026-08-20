import inspect
import unittest
from decimal import Decimal

from vr_engine import initial_v, initialize_cycle


class InitialVTests(unittest.TestCase):
    def test_v1_equals_quantity_times_current_price(self):
        self.assertEqual(initial_v(10, Decimal("110")), Decimal("1100.00"))

    def test_v1_does_not_accept_avg_cost(self):
        # Average cost must never influence V1 -- enforced structurally by
        # not even accepting it as a parameter, so it can never leak in.
        params = inspect.signature(initial_v).parameters
        self.assertNotIn("avg_cost", params)

    def test_rejects_negative_quantity(self):
        with self.assertRaises(ValueError):
            initial_v(-1, Decimal("110"))

    def test_rejects_non_positive_price(self):
        with self.assertRaises(ValueError):
            initial_v(10, Decimal("0"))


class InitializeCycleTests(unittest.TestCase):
    def test_entire_holding_becomes_the_vr_v1(self):
        state = initialize_cycle(
            symbol="TQQQ",
            position_qty=10,
            current_price=Decimal("110"),
            initial_pool=Decimal("500"),
            G=Decimal("10"),
            band_pct=Decimal("15"),
            cycle_id="c1",
            start_session="2026-08-07",
            end_session="2026-08-21",
        )
        self.assertEqual(state.current_cycle.V, Decimal("1100.00"))

    def test_status_becomes_active_with_initialized_at_timestamp(self):
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
        )
        self.assertEqual(state.status, "ACTIVE")
        self.assertIsNotNone(state.initialized_at)

    def test_initial_pool_is_stored_as_pool_start_and_pool_current(self):
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
        )
        self.assertEqual(state.current_cycle.pool_start, Decimal("500"))
        self.assertEqual(state.current_cycle.pool_current, Decimal("500"))

    def test_soxl_and_tqqq_pools_are_independent(self):
        tqqq = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
        )
        soxl = initialize_cycle(
            symbol="SOXL", position_qty=20, current_price=Decimal("25"),
            initial_pool=Decimal("200"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
        )
        self.assertEqual(tqqq.current_cycle.pool_start, Decimal("500"))
        self.assertEqual(soxl.current_cycle.pool_start, Decimal("200"))
        self.assertEqual(soxl.current_cycle.V, Decimal("500.00"))

    def test_lower_and_upper_band_derived_from_v1(self):
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
        )
        self.assertEqual(state.current_cycle.lower_band, Decimal("935.00"))
        self.assertEqual(state.current_cycle.upper_band, Decimal("1265.00"))

    def test_defaults_anchor_friday_to_start_session_and_cycle_number_to_1(self):
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
        )
        self.assertEqual(state.anchor_friday, "2026-08-07")
        self.assertEqual(state.cycle_number, 1)

    def test_accepts_an_explicit_anchor_friday(self):
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-05", end_session="2026-08-07",
            anchor_friday="2026-08-07",
        )
        self.assertEqual(state.anchor_friday, "2026-08-07")

    def test_rejects_negative_initial_pool(self):
        with self.assertRaises(ValueError):
            initialize_cycle(
                symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
                initial_pool=Decimal("-1"), G=Decimal("10"), band_pct=Decimal("15"),
                cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
            )


if __name__ == "__main__":
    unittest.main()
