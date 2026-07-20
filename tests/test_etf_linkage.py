import unittest

from etf_linkage import analyze_etf_pairs


class EtfLinkageTests(unittest.TestCase):
    def test_prefers_high_volatility_pair_with_opposite_returns(self):
        dates = [f"2026-01-{day:02d}" for day in range(1, 9)]
        series = {
            "A": dict(zip(dates, [100, 120, 90, 125, 85, 130, 80, 135])),
            "B": dict(zip(dates, [100, 80, 115, 75, 120, 70, 125, 65])),
            "C": dict(zip(dates, [100, 119, 91, 124, 86, 129, 81, 134])),
            "E": dict(zip(dates, [100, 100.5, 99.8, 100.4, 99.7, 100.3, 99.6, 100.2])),
            "F": dict(zip(dates, [100, 99.5, 100.2, 99.6, 100.3, 99.7, 100.4, 99.8])),
        }

        ranked = analyze_etf_pairs(series, trading_days=7, minimum_days=5)

        self.assertEqual((ranked[0].first, ranked[0].second), ("A", "B"))
        self.assertLess(ranked[0].correlation, 0)
        self.assertNotEqual(ranked[0].recommendation, "강력 추천")
        self.assertGreater(ranked[0].spread_volatility, ranked[0].portfolio_volatility)
        self.assertGreater(ranked[0].opportunity_risk_ratio, 1)
        low_score_inverse = next(item for item in ranked if (item.first, item.second) == ("E", "F"))
        self.assertLess(low_score_inverse.correlation, 0)
        self.assertNotEqual(low_score_inverse.recommendation, "강력 추천")

    def test_uses_only_the_requested_three_month_window(self):
        dates = [f"2026-{1 + index // 28:02d}-{1 + index % 28:02d}" for index in range(70)]
        first = {day: 100 + index + (-1) ** index * 3 for index, day in enumerate(dates)}
        second = {day: 100 + index - (-1) ** index * 3 for index, day in enumerate(dates)}

        ranked = analyze_etf_pairs({"A": first, "B": second}, trading_days=63, minimum_days=40)

        self.assertEqual(ranked[0].sample_days, 63)


if __name__ == "__main__":
    unittest.main()