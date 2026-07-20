import unittest
from datetime import date, timedelta

from etf_long_term import analyze_individual_etfs


class EtfLongTermAnalysisTests(unittest.TestCase):
    @staticmethod
    def _series(values):
        start = date(2021, 1, 4)
        return {(start + timedelta(days=index)).isoformat(): value for index, value in enumerate(values)}

    def test_balances_consistency_downside_and_return(self):
        stable = [100 * (1.0025 ** index) for index in range(800)]
        volatile = [100 * (1.0035 ** index) * (1.65 if index % 40 < 20 else 0.55) for index in range(800)]
        declining = [100 * (0.999 ** index) for index in range(800)]

        ranked = analyze_individual_etfs({
            "STABLE": self._series(stable),
            "VOLATILE": self._series(volatile),
            "DECLINE": self._series(declining),
        })

        self.assertEqual(ranked[0].symbol, "STABLE")
        self.assertGreater(ranked[0].positive_month_ratio_pct, 90)
        self.assertLess(ranked[0].max_drawdown_pct, 1)
        self.assertEqual(next(item for item in ranked if item.symbol == "DECLINE").recommendation, "고위험")

    def test_uses_ten_million_as_normalized_starting_value(self):
        values = [100 + index for index in range(300)]
        result = analyze_individual_etfs({"A": self._series(values)})[0]

        self.assertEqual(result.start_value, 10_000_000)
        self.assertAlmostEqual(result.end_value, 10_000_000 * values[-1] / values[0])

    def test_rejects_history_that_does_not_reach_requested_start(self):
        late_start = date(2025, 1, 1)
        values = {(late_start + timedelta(days=index)).isoformat(): 100 + index for index in range(300)}

        with self.assertRaisesRegex(ValueError, "시작일"):
            analyze_individual_etfs({"A": values}, start_date="2021-01-01")

    def test_fngu_is_displayed_but_excluded_from_recommendation(self):
        values = [100 * (1.003 ** index) for index in range(300)]
        ranked = analyze_individual_etfs({"FNGU": self._series(values), "TQQQ": self._series(values)})

        fngu = next(item for item in ranked if item.symbol == "FNGU")
        self.assertFalse(fngu.eligible)
        self.assertEqual(fngu.recommendation, "제외(ETN)")


if __name__ == "__main__":
    unittest.main()