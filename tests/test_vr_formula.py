import math
import unittest
from decimal import Decimal

from vr_formula import band, next_v


class SkillFormulaBookExampleTests(unittest.TestCase):
    """V_next = V + Pool/G + (E - V) / (2 * sqrt(G)).

    Expected values are cross-checked against an independent float
    computation (math.sqrt) within a cent-level tolerance, per the
    "허용 오차 내 일치" requirement -- this is the '실력공식' only, never the
    plain/base VR formula.
    """

    def _expected_float(self, V, E, Pool, G):
        return V + Pool / G + (E - V) / (2 * math.sqrt(G))

    def test_down_example_matches_the_spec_walkthrough(self):
        # This is the exact worked example from the spec's UI breakdown:
        # Pool/G +$123.15, 시장보정 -$335.20, 다음 V $18,287.95
        result = next_v(Decimal("18500"), Decimal("16380"), Decimal("1231.51"), Decimal("10"))
        self.assertEqual(result.new_V, Decimal("18287.95"))
        self.assertAlmostEqual(float(result.pool_term), 123.151, places=2)
        self.assertAlmostEqual(float(result.market_adjustment_term), -335.20, places=1)

    def test_up_example_within_tolerance_of_independent_float_calc(self):
        V, E, Pool, G = Decimal("18500"), Decimal("20650"), Decimal("2356.97"), Decimal("10")
        expected = self._expected_float(float(V), float(E), float(Pool), float(G))
        result = next_v(V, E, Pool, G)
        self.assertAlmostEqual(float(result.new_V), expected, delta=0.01)

    def test_market_adjustment_negative_when_e_below_v(self):
        result = next_v(Decimal("18500"), Decimal("16380"), Decimal("1231.51"), Decimal("10"))
        self.assertLess(result.market_adjustment_term, Decimal("0"))

    def test_market_adjustment_positive_when_e_above_v(self):
        result = next_v(Decimal("18500"), Decimal("20650"), Decimal("2356.97"), Decimal("10"))
        self.assertGreater(result.market_adjustment_term, Decimal("0"))

    def test_market_adjustment_zero_when_e_equals_v(self):
        result = next_v(Decimal("18500"), Decimal("18500"), Decimal("1000"), Decimal("10"))
        self.assertEqual(result.market_adjustment_term, Decimal("0"))
        # With E == V the whole delta collapses to V + Pool/G.
        self.assertEqual(result.new_V, Decimal("18500") + Decimal("100"))

    def test_breakdown_carries_all_audit_fields(self):
        result = next_v(Decimal("18500"), Decimal("16380"), Decimal("1231.51"), Decimal("10"))
        self.assertEqual(result.old_V, Decimal("18500"))
        self.assertEqual(result.E, Decimal("16380"))
        self.assertEqual(result.Pool, Decimal("1231.51"))
        self.assertEqual(result.G, Decimal("10"))

    def test_rejects_non_positive_g(self):
        with self.assertRaises(ValueError):
            next_v(Decimal("18500"), Decimal("16380"), Decimal("1000"), Decimal("0"))
        with self.assertRaises(ValueError):
            next_v(Decimal("18500"), Decimal("16380"), Decimal("1000"), Decimal("-5"))


class BandTests(unittest.TestCase):
    def test_plus_minus_15_percent(self):
        lower, upper = band(Decimal("18500"), Decimal("15"))
        self.assertEqual(lower, Decimal("15725.00"))
        self.assertEqual(upper, Decimal("21275.00"))

    def test_plus_minus_20_percent(self):
        lower, upper = band(Decimal("10000"), Decimal("20"))
        self.assertEqual(lower, Decimal("8000.00"))
        self.assertEqual(upper, Decimal("12000.00"))

    def test_rejects_non_positive_band_pct(self):
        with self.assertRaises(ValueError):
            band(Decimal("18500"), Decimal("0"))


if __name__ == "__main__":
    unittest.main()
