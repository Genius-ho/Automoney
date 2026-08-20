import unittest
from decimal import Decimal

from vr_engine import (
    apply_pool_adjustment,
    cancel_pending_config,
    initialize_cycle,
    promote_pending_config,
    schedule_config,
)
from vr_state_store import VRPendingConfig


def _active_state(G="10", band_pct="15"):
    state = initialize_cycle(
        symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
        initial_pool=Decimal("500"), G=Decimal(G), band_pct=Decimal(band_pct),
        cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
    )
    return state


class ScheduleConfigTests(unittest.TestCase):
    def test_scheduling_g_change_leaves_current_cycle_g_untouched(self):
        state = schedule_config(_active_state(), G=Decimal("20"))
        self.assertEqual(state.current_cycle.G, Decimal("10"))
        self.assertEqual(state.pending_config.G, Decimal("20"))

    def test_scheduling_band_change_leaves_current_cycle_band_untouched(self):
        state = schedule_config(_active_state(), band_pct=Decimal("10"))
        self.assertEqual(state.current_cycle.band_pct, Decimal("15"))
        self.assertEqual(state.pending_config.band_pct, Decimal("10"))

    def test_scheduling_pool_adjustment_leaves_current_pool_untouched(self):
        state = schedule_config(_active_state(), pool_adjustment=Decimal("300"))
        self.assertEqual(state.current_cycle.pool_current, Decimal("500"))
        self.assertEqual(state.pending_config.pool_adjustment, Decimal("300"))

    def test_unspecified_fields_keep_whatever_was_already_pending(self):
        state = schedule_config(_active_state(), G=Decimal("20"))
        state = schedule_config(state, band_pct=Decimal("10"))
        self.assertEqual(state.pending_config.G, Decimal("20"))
        self.assertEqual(state.pending_config.band_pct, Decimal("10"))

    def test_rejects_non_positive_pending_g(self):
        with self.assertRaises(ValueError):
            schedule_config(_active_state(), G=Decimal("0"))

    def test_rejects_non_positive_pending_band(self):
        with self.assertRaises(ValueError):
            schedule_config(_active_state(), band_pct=Decimal("-5"))


class CancelPendingConfigTests(unittest.TestCase):
    def test_cancel_single_field(self):
        state = schedule_config(_active_state(), G=Decimal("20"), band_pct=Decimal("10"))
        state = cancel_pending_config(state, G=True)
        self.assertIsNone(state.pending_config.G)
        self.assertEqual(state.pending_config.band_pct, Decimal("10"))

    def test_cancel_all_fields(self):
        state = schedule_config(_active_state(), G=Decimal("20"), band_pct=Decimal("10"), pool_adjustment=Decimal("300"))
        state = cancel_pending_config(state, all=True)
        self.assertEqual(state.pending_config, VRPendingConfig())


class PromotePendingConfigTests(unittest.TestCase):
    def test_promote_uses_pending_g_when_set(self):
        state = schedule_config(_active_state(), G=Decimal("20"))
        new_g, new_band, pool_adj = promote_pending_config(state)
        self.assertEqual(new_g, Decimal("20"))

    def test_promote_falls_back_to_current_g_when_nothing_pending(self):
        state = _active_state(G="10")
        new_g, new_band, pool_adj = promote_pending_config(state)
        self.assertEqual(new_g, Decimal("10"))

    def test_g_stays_the_same_across_many_cycles_unless_changed(self):
        state = _active_state(G="10")
        for _ in range(5):
            new_g, _, _ = promote_pending_config(state)
            self.assertEqual(new_g, Decimal("10"))

    def test_promote_falls_back_to_current_band_when_nothing_pending(self):
        state = _active_state(band_pct="15")
        _, new_band, _ = promote_pending_config(state)
        self.assertEqual(new_band, Decimal("15"))

    def test_promote_pool_adjustment_defaults_to_zero_when_unset(self):
        state = _active_state()
        _, _, pool_adj = promote_pending_config(state)
        self.assertEqual(pool_adj, Decimal("0"))

    def test_promote_returns_pending_pool_adjustment_when_set(self):
        state = schedule_config(_active_state(), pool_adjustment=Decimal("300"))
        _, _, pool_adj = promote_pending_config(state)
        self.assertEqual(pool_adj, Decimal("300"))


class ApplyPoolAdjustmentTests(unittest.TestCase):
    def test_positive_adjustment_increases_pool(self):
        self.assertEqual(apply_pool_adjustment(Decimal("500"), Decimal("300")), Decimal("800"))

    def test_negative_adjustment_withdraws_from_pool(self):
        self.assertEqual(apply_pool_adjustment(Decimal("500"), Decimal("-200")), Decimal("300"))

    def test_rejects_adjustment_that_would_go_negative(self):
        with self.assertRaises(ValueError):
            apply_pool_adjustment(Decimal("500"), Decimal("-600"))


if __name__ == "__main__":
    unittest.main()
