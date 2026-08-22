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


class InitializeCyclePoolUsageLimitPctTests(unittest.TestCase):
    def test_defaults_to_75_pct(self):
        state = _active_state()
        self.assertEqual(state.current_cycle.pool_usage_limit_pct, Decimal("0.75"))

    def test_accepts_50_pct(self):
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
            pool_usage_limit_pct=Decimal("0.50"),
        )
        self.assertEqual(state.current_cycle.pool_usage_limit_pct, Decimal("0.50"))

    def test_rejects_value_outside_the_allowed_set(self):
        with self.assertRaises(ValueError):
            initialize_cycle(
                symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
                initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
                cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
                pool_usage_limit_pct=Decimal("0.63"),
            )

    def test_rejects_zero(self):
        with self.assertRaises(ValueError):
            initialize_cycle(
                symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
                initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
                cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
                pool_usage_limit_pct=Decimal("0"),
            )


class InitializeCycleRecurringContributionTests(unittest.TestCase):
    def test_defaults_to_zero(self):
        state = _active_state()
        self.assertEqual(state.current_cycle.recurring_contribution, Decimal("0"))

    def test_accepts_a_positive_recurring_contribution(self):
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
            recurring_contribution=Decimal("500"),
        )
        self.assertEqual(state.current_cycle.recurring_contribution, Decimal("500"))

    def test_accepts_a_negative_recurring_contribution(self):
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
            recurring_contribution=Decimal("-200"),
        )
        self.assertEqual(state.current_cycle.recurring_contribution, Decimal("-200"))

    def test_does_not_affect_pool_start_of_the_first_cycle(self):
        # recurring_contribution only ever takes effect at a FUTURE
        # transition (see transition_cycle) -- cycle 1's own pool_start is
        # exactly initial_pool, regardless of what recurring_contribution
        # is set to.
        state = initialize_cycle(
            symbol="TQQQ", position_qty=10, current_price=Decimal("110"),
            initial_pool=Decimal("500"), G=Decimal("10"), band_pct=Decimal("15"),
            cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
            recurring_contribution=Decimal("500"),
        )
        self.assertEqual(state.current_cycle.pool_start, Decimal("500"))
        self.assertEqual(state.current_cycle.pool_current, Decimal("500"))


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

    def test_scheduling_pool_usage_limit_pct_leaves_current_cycle_untouched(self):
        state = schedule_config(_active_state(), pool_usage_limit_pct=Decimal("0.50"))
        self.assertEqual(state.current_cycle.pool_usage_limit_pct, Decimal("0.75"))
        self.assertEqual(state.pending_config.pool_usage_limit_pct, Decimal("0.50"))

    def test_rejects_non_positive_pending_pool_usage_limit_pct(self):
        with self.assertRaises(ValueError):
            schedule_config(_active_state(), pool_usage_limit_pct=Decimal("0"))

    def test_rejects_pending_pool_usage_limit_pct_outside_allowed_set(self):
        with self.assertRaises(ValueError):
            schedule_config(_active_state(), pool_usage_limit_pct=Decimal("0.40"))

    def test_reselecting_the_current_cycles_value_clears_any_stale_pending(self):
        # current cycle defaults to 0.75; scheduling 0.50 then re-selecting
        # 0.75 (the value already active) must clear pending, not store a
        # redundant "pending 0.75" that would show a spurious "Next Cycle"
        # line the UI has no real change to display.
        state = _active_state()
        state = schedule_config(state, pool_usage_limit_pct=Decimal("0.50"))
        self.assertEqual(state.pending_config.pool_usage_limit_pct, Decimal("0.50"))
        state = schedule_config(state, pool_usage_limit_pct=Decimal("0.75"))
        self.assertIsNone(state.pending_config.pool_usage_limit_pct)

    def test_selecting_a_different_value_than_current_stores_it(self):
        state = schedule_config(_active_state(), pool_usage_limit_pct=Decimal("0.25"))
        self.assertEqual(state.pending_config.pool_usage_limit_pct, Decimal("0.25"))

    def test_scheduling_recurring_contribution_leaves_current_cycle_untouched(self):
        state = schedule_config(_active_state(), recurring_contribution=Decimal("500"))
        self.assertEqual(state.current_cycle.recurring_contribution, Decimal("0"))
        self.assertEqual(state.pending_config.recurring_contribution, Decimal("500"))

    def test_scheduling_a_negative_recurring_contribution(self):
        state = schedule_config(_active_state(), recurring_contribution=Decimal("-200"))
        self.assertEqual(state.pending_config.recurring_contribution, Decimal("-200"))

    def test_reselecting_the_current_cycles_recurring_contribution_clears_any_stale_pending(self):
        # Same "no redundant pending" behavior as pool_usage_limit_pct: the
        # default active value is 0, so scheduling 500 then re-selecting 0
        # (back to what's already active) clears pending instead of storing
        # a no-op "pending 0".
        state = _active_state()
        state = schedule_config(state, recurring_contribution=Decimal("500"))
        self.assertEqual(state.pending_config.recurring_contribution, Decimal("500"))
        state = schedule_config(state, recurring_contribution=Decimal("0"))
        self.assertIsNone(state.pending_config.recurring_contribution)


class CancelPendingConfigTests(unittest.TestCase):
    def test_cancel_single_field(self):
        state = schedule_config(_active_state(), G=Decimal("20"), band_pct=Decimal("10"))
        state = cancel_pending_config(state, G=True)
        self.assertIsNone(state.pending_config.G)
        self.assertEqual(state.pending_config.band_pct, Decimal("10"))

    def test_cancel_pool_usage_limit_pct(self):
        state = schedule_config(_active_state(), pool_usage_limit_pct=Decimal("0.25"))
        state = cancel_pending_config(state, pool_usage_limit_pct=True)
        self.assertIsNone(state.pending_config.pool_usage_limit_pct)

    def test_cancel_recurring_contribution(self):
        state = schedule_config(_active_state(), recurring_contribution=Decimal("500"))
        state = cancel_pending_config(state, recurring_contribution=True)
        self.assertIsNone(state.pending_config.recurring_contribution)

    def test_cancel_all_fields(self):
        state = schedule_config(
            _active_state(), G=Decimal("20"), band_pct=Decimal("10"),
            pool_adjustment=Decimal("300"), pool_usage_limit_pct=Decimal("0.50"),
            recurring_contribution=Decimal("500"),
        )
        state = cancel_pending_config(state, all=True)
        self.assertEqual(state.pending_config, VRPendingConfig())


class PromotePendingConfigTests(unittest.TestCase):
    def test_promote_uses_pending_g_when_set(self):
        state = schedule_config(_active_state(), G=Decimal("20"))
        new_g, new_band, pool_adj, new_pool_usage, new_recurring = promote_pending_config(state)
        self.assertEqual(new_g, Decimal("20"))

    def test_promote_falls_back_to_current_g_when_nothing_pending(self):
        state = _active_state(G="10")
        new_g, new_band, pool_adj, new_pool_usage, new_recurring = promote_pending_config(state)
        self.assertEqual(new_g, Decimal("10"))

    def test_g_stays_the_same_across_many_cycles_unless_changed(self):
        state = _active_state(G="10")
        for _ in range(5):
            new_g, _, _, _, _ = promote_pending_config(state)
            self.assertEqual(new_g, Decimal("10"))

    def test_promote_falls_back_to_current_band_when_nothing_pending(self):
        state = _active_state(band_pct="15")
        _, new_band, _, _, _ = promote_pending_config(state)
        self.assertEqual(new_band, Decimal("15"))

    def test_promote_pool_adjustment_defaults_to_zero_when_unset(self):
        state = _active_state()
        _, _, pool_adj, _, _ = promote_pending_config(state)
        self.assertEqual(pool_adj, Decimal("0"))

    def test_promote_returns_pending_pool_adjustment_when_set(self):
        state = schedule_config(_active_state(), pool_adjustment=Decimal("300"))
        _, _, pool_adj, _, _ = promote_pending_config(state)
        self.assertEqual(pool_adj, Decimal("300"))

    def test_promote_falls_back_to_current_pool_usage_limit_pct_when_nothing_pending(self):
        state = _active_state()
        self.assertEqual(state.current_cycle.pool_usage_limit_pct, Decimal("0.75"))
        _, _, _, new_pool_usage, _ = promote_pending_config(state)
        self.assertEqual(new_pool_usage, Decimal("0.75"))

    def test_promote_uses_pending_pool_usage_limit_pct_when_set(self):
        state = schedule_config(_active_state(), pool_usage_limit_pct=Decimal("0.50"))
        _, _, _, new_pool_usage, _ = promote_pending_config(state)
        self.assertEqual(new_pool_usage, Decimal("0.50"))

    def test_promote_falls_back_to_current_recurring_contribution_when_nothing_pending(self):
        state = _active_state()
        self.assertEqual(state.current_cycle.recurring_contribution, Decimal("0"))
        _, _, _, _, new_recurring = promote_pending_config(state)
        self.assertEqual(new_recurring, Decimal("0"))

    def test_promote_uses_pending_recurring_contribution_when_set(self):
        state = schedule_config(_active_state(), recurring_contribution=Decimal("500"))
        _, _, _, _, new_recurring = promote_pending_config(state)
        self.assertEqual(new_recurring, Decimal("500"))

    def test_recurring_contribution_stays_the_same_across_many_cycles_unless_changed(self):
        state = schedule_config(_active_state(), recurring_contribution=Decimal("500"))
        for _ in range(5):
            _, _, _, _, new_recurring = promote_pending_config(state)
            self.assertEqual(new_recurring, Decimal("500"))


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
