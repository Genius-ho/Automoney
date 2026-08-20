import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from mumae_core import StrategyState
from vr_engine import apply_fill_to_pool
from vr_funds_ledger import (
    FundsReservationLedger,
    available_vr_buying_power,
    mumae_projected_reserve,
)
from vr_state_store import VRCycle


def _cycle(pool_current="500", V="1100"):
    return VRCycle(
        cycle_id="c1", start_session="2026-08-07", end_session="2026-08-21",
        V=Decimal(V), G=Decimal("10"), band_pct=Decimal("15"),
        pool_start=Decimal(pool_current), pool_current=Decimal(pool_current),
        lower_band=Decimal("935"), upper_band=Decimal("1265"),
    )


class ReservationLedgerTests(unittest.TestCase):
    def test_reserve_and_release_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = FundsReservationLedger(Path(directory) / "ledger.json")
            reservation_id = ledger.reserve("VR_SKILL", "TQQQ", Decimal("200"))
            self.assertEqual(ledger.total_reserved(symbol="TQQQ"), Decimal("200"))
            ledger.release(reservation_id)
            self.assertEqual(ledger.total_reserved(symbol="TQQQ"), Decimal("0"))

    def test_tqqq_and_soxl_reservations_are_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = FundsReservationLedger(Path(directory) / "ledger.json")
            ledger.reserve("VR_SKILL", "TQQQ", Decimal("200"))
            ledger.reserve("VR_SKILL", "SOXL", Decimal("50"))
            self.assertEqual(ledger.total_reserved(symbol="TQQQ"), Decimal("200"))
            self.assertEqual(ledger.total_reserved(symbol="SOXL"), Decimal("50"))
            self.assertEqual(ledger.total_reserved(strategy_type="VR_SKILL"), Decimal("250"))

    def test_rejects_negative_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = FundsReservationLedger(Path(directory) / "ledger.json")
            with self.assertRaises(ValueError):
                ledger.reserve("VR_SKILL", "TQQQ", Decimal("-1"))


class MumaeProjectedReserveTests(unittest.TestCase):
    def test_matches_mumaes_own_attempt_amount(self):
        state = StrategyState(symbol="TQQQ", cash_usd=Decimal("4000"), t_value=Decimal("10"))
        self.assertEqual(mumae_projected_reserve(state), Decimal("133.33"))


class AvailableVrBuyingPowerTests(unittest.TestCase):
    def test_capped_by_symbols_own_pool(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = FundsReservationLedger(Path(directory) / "ledger.json")
            available = available_vr_buying_power(
                account_buying_power=Decimal("10000"), ledger=ledger,
                symbol="TQQQ", vr_pool=Decimal("500"),
            )
            self.assertEqual(available, Decimal("500"))

    def test_capped_by_remaining_account_buying_power(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = FundsReservationLedger(Path(directory) / "ledger.json")
            ledger.reserve("VR_SKILL", "SOXL", Decimal("800"))
            available = available_vr_buying_power(
                account_buying_power=Decimal("1000"), ledger=ledger,
                symbol="TQQQ", vr_pool=Decimal("500"),
            )
            self.assertEqual(available, Decimal("200"))

    def test_mumae_projected_need_reduces_available_vr_buying_power(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = FundsReservationLedger(Path(directory) / "ledger.json")
            mumae_state = StrategyState(symbol="SOXL", cash_usd=Decimal("4000"), t_value=Decimal("10"))
            available = available_vr_buying_power(
                account_buying_power=Decimal("1000"), ledger=ledger,
                symbol="TQQQ", vr_pool=Decimal("500"), mumae_states=[mumae_state],
            )
            # 1000 - attempt_amount(133.33) = 866.67, still capped by pool 500
            self.assertEqual(available, Decimal("500"))

            mumae_state2 = StrategyState(symbol="KORU", cash_usd=Decimal("4000"), t_value=Decimal("39"))
            available2 = available_vr_buying_power(
                account_buying_power=Decimal("1000"), ledger=ledger,
                symbol="TQQQ", vr_pool=Decimal("5000"), mumae_states=[mumae_state2],
            )
            # attempt_amount at t=39/40 => cash/(40-39) = 4000 -> remaining account = -3000, clamp to 0
            self.assertEqual(available2, Decimal("0"))

    def test_never_negative(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = FundsReservationLedger(Path(directory) / "ledger.json")
            ledger.reserve("VR_SKILL", "SOXL", Decimal("5000"))
            available = available_vr_buying_power(
                account_buying_power=Decimal("100"), ledger=ledger,
                symbol="TQQQ", vr_pool=Decimal("500"),
            )
            self.assertEqual(available, Decimal("0"))


class PoolFillBookkeepingTests(unittest.TestCase):
    def test_buy_fill_decreases_pool(self):
        cycle = apply_fill_to_pool(_cycle(pool_current="1000"), "buy", Decimal("200"))
        self.assertEqual(cycle.pool_current, Decimal("800"))

    def test_sell_fill_increases_pool(self):
        cycle = apply_fill_to_pool(_cycle(pool_current="800"), "sell", Decimal("300"))
        self.assertEqual(cycle.pool_current, Decimal("1100"))

    def test_buy_fill_cannot_drive_pool_negative(self):
        with self.assertRaises(ValueError):
            apply_fill_to_pool(_cycle(pool_current="100"), "buy", Decimal("200"))

    def test_a_symbols_fill_never_touches_a_different_cycle_object(self):
        tqqq_cycle = _cycle(pool_current="1000")
        soxl_cycle = _cycle(pool_current="500")
        apply_fill_to_pool(tqqq_cycle, "buy", Decimal("200"))
        # soxl_cycle is an independent object; untouched regardless of what
        # happens to tqqq_cycle's pool.
        self.assertEqual(soxl_cycle.pool_current, Decimal("500"))


if __name__ == "__main__":
    unittest.main()
