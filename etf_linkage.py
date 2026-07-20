"""Three-month ETF opportunity and portfolio-risk pair ranking."""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from itertools import combinations


@dataclass(frozen=True)
class EtfPairAnalysis:
    first: str
    second: str
    correlation: float
    average_volatility: float
    spread_volatility: float
    portfolio_volatility: float
    opportunity_risk_ratio: float
    score: float
    sample_days: int
    recommendation: str = "관찰"


def _returns(closes: list[float]) -> list[float]:
    return [closes[index] / closes[index - 1] - 1 for index in range(1, len(closes))]


def analyze_etf_pairs(
    closes_by_symbol: dict[str, dict[str, float]],
    trading_days: int = 63,
    minimum_days: int = 40,
) -> list[EtfPairAnalysis]:
    """Rank return-spread opportunity while penalizing 50:50 portfolio risk."""
    result: list[EtfPairAnalysis] = []
    for first, second in combinations(sorted(closes_by_symbol), 2):
        common_dates = sorted(set(closes_by_symbol[first]) & set(closes_by_symbol[second]))[-(trading_days + 1):]
        if len(common_dates) - 1 < minimum_days:
            continue
        first_returns = _returns([closes_by_symbol[first][day] for day in common_dates])
        second_returns = _returns([closes_by_symbol[second][day] for day in common_dates])
        if not first_returns or statistics.pstdev(first_returns) == 0 or statistics.pstdev(second_returns) == 0:
            continue
        correlation = max(-1.0, min(1.0, statistics.correlation(first_returns, second_returns)))
        first_volatility = statistics.stdev(first_returns) * math.sqrt(252) * 100
        second_volatility = statistics.stdev(second_returns) * math.sqrt(252) * 100
        average_volatility = (first_volatility + second_volatility) / 2
        spread_volatility = math.sqrt(max(0.0, first_volatility**2 + second_volatility**2 - 2 * correlation * first_volatility * second_volatility))
        portfolio_volatility = 0.5 * math.sqrt(max(0.0, first_volatility**2 + second_volatility**2 + 2 * correlation * first_volatility * second_volatility))
        opportunity_risk_ratio = spread_volatility / portfolio_volatility if portfolio_volatility else 0.0
        efficiency_score = spread_volatility**2 / (2 * portfolio_volatility) if portfolio_volatility else 0.0

        if spread_volatility < 30:
            efficiency_score = 0.0
            recommendation = "낮은 기회"
        elif "FNGU" in {first, second}:
            recommendation = "제외(ETN)"
        elif correlation >= 0.60:
            recommendation = "후순위(동조화 높음)"
        elif max(first_volatility, second_volatility) > 200 or portfolio_volatility > 100:
            recommendation = "초고위험"
        elif portfolio_volatility > 75 or max(first_volatility, second_volatility) > 150:
            recommendation = "공격형"
        elif opportunity_risk_ratio >= 2.0 and portfolio_volatility <= 60:
            recommendation = "우선 검증"
        else:
            recommendation = "관찰"
        result.append(EtfPairAnalysis(
            first, second, correlation, average_volatility, spread_volatility,
            portfolio_volatility, opportunity_risk_ratio, efficiency_score,
            len(first_returns), recommendation,
        ))
    return sorted(result, key=lambda item: item.score, reverse=True)