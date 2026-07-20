"""Long-term normalized investment analysis for individual leveraged products."""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, replace
from datetime import date


@dataclass(frozen=True)
class EtfLongTermAnalysis:
    symbol: str
    start_date: str
    end_date: str
    start_value: float
    end_value: float
    total_return_pct: float
    cagr_pct: float
    max_drawdown_pct: float
    positive_month_ratio_pct: float
    monthly_volatility_pct: float
    below_principal_ratio_pct: float
    score: float = 0.0
    recommendation: str = "관찰"
    eligible: bool = True


def _normalize(values: list[float], value: float, *, lower_is_better: bool = False) -> float:
    low, high = min(values), max(values)
    if math.isclose(low, high):
        return 50.0
    score = (value - low) / (high - low) * 100
    return 100 - score if lower_is_better else score


def _single_result(symbol: str, closes: dict[str, float], principal: float, start_date: str) -> EtfLongTermAnalysis:
    rows = sorted((day, float(close)) for day, close in closes.items() if day >= start_date and float(close) > 0)
    if len(rows) < 252:
        raise ValueError(f"{symbol}: 2021년 이후 일봉이 252거래일보다 적습니다.")
    first_day, first_close = rows[0]
    if (date.fromisoformat(first_day) - date.fromisoformat(start_date)).days > 31:
        raise ValueError(f"{symbol}: 요청 시작일 근처의 가격 자료가 없습니다.")
    last_day, last_close = rows[-1]
    values = [principal * close / first_close for _, close in rows]
    end_value = values[-1]
    total_return = end_value / principal - 1
    elapsed_years = max((date.fromisoformat(last_day) - date.fromisoformat(first_day)).days / 365.2425, 1 / 365.2425)
    cagr = (end_value / principal) ** (1 / elapsed_years) - 1

    peak = values[0]
    max_drawdown = 0.0
    for value in values:
        peak = max(peak, value)
        max_drawdown = max(max_drawdown, 1 - value / peak)

    month_ends: dict[str, float] = {}
    for day, close in rows:
        month_ends[day[:7]] = close
    monthly_closes = list(month_ends.values())
    monthly_returns = [monthly_closes[index] / monthly_closes[index - 1] - 1 for index in range(1, len(monthly_closes))]
    positive_month_ratio = sum(value > 0 for value in monthly_returns) / len(monthly_returns) if monthly_returns else 0.0
    monthly_volatility = statistics.stdev(monthly_returns) if len(monthly_returns) >= 2 else 0.0
    below_principal_ratio = sum(value < principal for value in values) / len(values)

    return EtfLongTermAnalysis(
        symbol=symbol,
        start_date=first_day,
        end_date=last_day,
        start_value=principal,
        end_value=end_value,
        total_return_pct=total_return * 100,
        cagr_pct=cagr * 100,
        max_drawdown_pct=max_drawdown * 100,
        positive_month_ratio_pct=positive_month_ratio * 100,
        monthly_volatility_pct=monthly_volatility * 100,
        below_principal_ratio_pct=below_principal_ratio * 100,
        eligible=symbol != "FNGU",
    )


def analyze_individual_etfs(
    closes_by_symbol: dict[str, dict[str, float]],
    *,
    principal: float = 10_000_000,
    start_date: str = "2021-01-01",
) -> list[EtfLongTermAnalysis]:
    """Rank products by consistency (35%), downside (35%), and return (30%)."""
    if principal <= 0:
        raise ValueError("시작 원금은 0보다 커야 합니다.")
    raw = [_single_result(symbol, closes, principal, start_date) for symbol, closes in sorted(closes_by_symbol.items())]
    if not raw:
        return []

    cagr_values = [item.cagr_pct for item in raw]
    positive_values = [item.positive_month_ratio_pct for item in raw]
    monthly_vol_values = [item.monthly_volatility_pct for item in raw]
    drawdown_values = [item.max_drawdown_pct for item in raw]
    below_values = [item.below_principal_ratio_pct for item in raw]

    assessed: list[EtfLongTermAnalysis] = []
    for item in raw:
        return_score = _normalize(cagr_values, item.cagr_pct)
        consistency_score = (
            0.65 * _normalize(positive_values, item.positive_month_ratio_pct)
            + 0.35 * _normalize(monthly_vol_values, item.monthly_volatility_pct, lower_is_better=True)
        )
        downside_score = (
            0.65 * _normalize(drawdown_values, item.max_drawdown_pct, lower_is_better=True)
            + 0.35 * _normalize(below_values, item.below_principal_ratio_pct, lower_is_better=True)
        )
        score = 0.35 * consistency_score + 0.35 * downside_score + 0.30 * return_score
        if not item.eligible:
            recommendation = "제외(ETN)"
        elif item.cagr_pct <= 0 or item.max_drawdown_pct >= 80:
            recommendation = "고위험"
        elif score >= 70 and item.positive_month_ratio_pct >= 55 and item.max_drawdown_pct <= 65:
            recommendation = "장기 균형 우수"
        elif score >= 50:
            recommendation = "우선 검토"
        else:
            recommendation = "관찰"
        assessed.append(replace(item, score=score, recommendation=recommendation))

    return sorted(assessed, key=lambda item: (item.eligible, item.score), reverse=True)