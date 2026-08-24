import unittest
from datetime import date, datetime, timedelta
from io import StringIO
from contextlib import redirect_stdout
from zoneinfo import ZoneInfo

from backtest_indicator_sweep import (
    Bar,
    DropSignal,
    detect_drop_entries,
    SweepSignal,
    edge_trigger,
    evaluate,
    evaluate_recovery_target,
    print_report,
    sample_status,
    sweep_report,
)


NY = ZoneInfo("America/New_York")


def _bar(timestamp: datetime, price: float, session: date = date(2026, 8, 25), phase: str = "REGULAR") -> Bar:
    return Bar(timestamp, price, price, price, price, 1.0, session, phase)


class ExactElapsedEvaluationTests(unittest.TestCase):
    def test_missing_intermediate_bar_is_not_treated_as_a_forward_result(self):
        start = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        bars = [_bar(start, 100), _bar(start + timedelta(minutes=3), 101), _bar(start + timedelta(minutes=9), 110)]
        signal = SweepSignal(0, start, "BUY", 100)

        result = evaluate(bars, [signal], horizon_minutes=9)

        self.assertEqual(result["BUY"]["count"], 0)
        self.assertEqual(result["incomplete_outcomes"], 1)

    def test_forward_window_cannot_cross_a_market_phase(self):
        regular_end = datetime(2026, 8, 25, 15, 57, tzinfo=NY)
        bars = [
            _bar(regular_end, 100, phase="REGULAR"),
            _bar(regular_end + timedelta(minutes=3), 101, phase="AFTER"),
        ]
        signal = SweepSignal(0, regular_end, "BUY", 100)

        result = evaluate(bars, [signal], horizon_minutes=3)

        self.assertEqual(result["BUY"]["count"], 0)
        self.assertEqual(result["incomplete_outcomes"], 1)

    def test_cost_assumption_reduces_directional_return(self):
        start = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        bars = [_bar(start, 100), _bar(start + timedelta(minutes=3), 110)]
        signal = SweepSignal(0, start, "BUY", 100)

        result = evaluate(bars, [signal], horizon_minutes=3, round_trip_cost_bps=10)

        self.assertAlmostEqual(result["BUY"]["avg_return_pct"], 10.0)
        self.assertAlmostEqual(result["BUY"]["avg_net_return_pct"], 9.9)


class DropRecoveryEvaluationTests(unittest.TestCase):
    def test_three_percent_drop_enters_on_the_next_bar_open(self):
        start = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        bars = [_bar(start + timedelta(minutes=3 * index), 100) for index in range(5)]
        bars.extend([
            Bar(start + timedelta(minutes=15), 96, 96, 95, 96, 1),
            Bar(start + timedelta(minutes=18), 97, 98, 96, 97, 1),
        ])

        signals = detect_drop_entries(bars, lookback_minutes=15, drop_threshold_pct=3.0)

        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].index, 6)
        self.assertEqual(signals[0].price, 97)
        self.assertAlmostEqual(signals[0].drop_pct, -4.0)

    def test_recovery_targets_two_three_and_four_percent_are_measured(self):
        start = datetime(2026, 8, 25, 9, 30, tzinfo=NY)
        bars = [
            Bar(start, 100, 100, 99, 100, 1),
            Bar(start + timedelta(minutes=3), 100, 102.5, 99, 102, 1),
            Bar(start + timedelta(minutes=6), 102, 103.5, 101, 103, 1),
            Bar(start + timedelta(minutes=9), 103, 104.5, 102, 104, 1),
            Bar(start + timedelta(minutes=12), 104, 104, 103, 104, 1),
        ]
        signal = DropSignal(0, start, "BUY", 100, -3.0, 103.1)

        results = [
            evaluate_recovery_target(bars, [signal], target_pct=target, horizon_minutes=12)
            for target in (2.0, 3.0, 4.0)
        ]

        self.assertEqual([item["target_hit_count"] for item in results], [1, 1, 1])
        self.assertEqual([item["median_hit_minutes"] for item in results], [3, 6, 9])

    def test_recovery_target_excludes_a_signal_without_a_complete_horizon(self):
        start = datetime(2026, 8, 25, 15, 57, tzinfo=NY)
        bars = [
            Bar(start, 100, 100, 99, 100, 1),
            Bar(start + timedelta(minutes=3), 100, 101, 99, 101, 1),
        ]
        signal = DropSignal(0, start, "BUY", 100, -3.0, 103.1)

        result = evaluate_recovery_target(bars, [signal], target_pct=4.0, horizon_minutes=6)

        self.assertEqual(result["complete_count"], 0)
        self.assertEqual(result["incomplete_outcomes"], 1)


class SignalBoundaryTests(unittest.TestCase):
    def test_edge_trigger_rearms_at_a_new_market_phase(self):
        first = datetime(2026, 8, 25, 15, 30, tzinfo=NY)
        bars = [
            _bar(first, 100, phase="REGULAR"),
            _bar(first + timedelta(minutes=3), 90, phase="REGULAR"),
            _bar(first + timedelta(minutes=30), 90, phase="AFTER"),
        ]

        signals = edge_trigger(bars, [False, True, True], [False, False, False])

        self.assertEqual([signal.index for signal in signals], [1, 2])


class ResearchStatusTests(unittest.TestCase):
    def test_sample_status_has_explicit_low_sample_boundary(self):
        self.assertEqual(sample_status(9), "INSUFFICIENT")
        self.assertEqual(sample_status(10), "LOW_SAMPLE")
        self.assertEqual(sample_status(29), "LOW_SAMPLE")
        self.assertEqual(sample_status(30), "SUPPORTED")

    def test_report_is_exploratory_before_thirty_sessions(self):
        bars = [_bar(datetime(2026, 8, 25, 9, 30, tzinfo=NY), 100)]

        report = sweep_report(bars, "TQQQ")

        self.assertEqual(report["research_status"], "EXPLORATORY")
        self.assertEqual(report["session_count"], 1)

    def test_report_splits_thirty_sessions_in_chronological_order(self):
        bars = []
        for offset in range(30):
            session = date(2026, 1, 1) + timedelta(days=offset)
            timestamp = datetime(2026, 1, 1, 9, 30, tzinfo=NY) + timedelta(days=offset)
            bars.append(_bar(timestamp, 100, session=session))

        report = sweep_report(bars, "TQQQ")

        self.assertEqual(report["research_status"], "VALIDATED")
        self.assertEqual(report["discovery_session_count"], 21)
        self.assertEqual(report["validation_session_count"], 9)

    def test_validated_report_labels_full_history_grid_as_reference_only(self):
        bars = [
            _bar(
                datetime(2026, 1, 1, 9, 30, tzinfo=NY) + timedelta(days=offset),
                100,
                session=date(2026, 1, 1) + timedelta(days=offset),
            )
            for offset in range(30)
        ]
        report = sweep_report(bars, "TQQQ")
        output = StringIO()

        with redirect_stdout(output):
            print_report(report)

        self.assertEqual(report["grid_scope"], "FULL_HISTORY_EXPLORATORY")
        self.assertIn("검증 아님", output.getvalue())

    def test_report_exposes_two_three_and_four_percent_recovery_targets(self):
        bars = [_bar(datetime(2026, 8, 25, 9, 30, tzinfo=NY), 100)]

        report = sweep_report(bars, "TQQQ")

        self.assertEqual(
            sorted({row["target_pct"] for row in report["target_grid"]}),
            [2.0, 3.0, 4.0],
        )


if __name__ == "__main__":
    unittest.main()
