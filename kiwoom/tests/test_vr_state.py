import tempfile
import unittest
from pathlib import Path

from kiwoom.vr_state import Trade, VrRuntimeState, VrStateStore


def _state(profile: str = "child1") -> VrRuntimeState:
    return VrRuntimeState(
        profile=profile,
        symbol="TQQQ",
        shares=100,
        pool=1040.0,
        v=5707.88,
        g=10.0,
        band_pct=0.15,
        contribution=20.0,
        cycle_length_days=14,
        pool_usage_cap_pct=0.75,
        cycle_start_date="2026-08-10",
    )


class VrStateStoreTests(unittest.TestCase):
    def test_two_profiles_never_collide(self):
        with tempfile.TemporaryDirectory() as temp:
            store1 = VrStateStore("child1", data_dir=temp)
            store2 = VrStateStore("child2", data_dir=temp)
            store1.save(_state("child1"))
            store2.save(_state("child2"))

            self.assertNotEqual(store1.path, store2.path)
            self.assertEqual(store1.load().profile, "child1")
            self.assertEqual(store2.load().profile, "child2")

    def test_round_trips_trades(self):
        with tempfile.TemporaryDirectory() as temp:
            store = VrStateStore("child1", data_dir=temp)
            state = _state()
            state.trades.append(Trade(day="2026-08-11", side="BUY", shares=3, price="60.00"))
            store.save(state)

            loaded = store.load()

            self.assertEqual(len(loaded.trades), 1)
            self.assertEqual(loaded.trades[0].side, "BUY")

    def test_exists_reflects_whether_the_file_is_there(self):
        with tempfile.TemporaryDirectory() as temp:
            store = VrStateStore("child1", data_dir=temp)
            self.assertFalse(store.exists())
            store.save(_state())
            self.assertTrue(store.exists())


if __name__ == "__main__":
    unittest.main()
