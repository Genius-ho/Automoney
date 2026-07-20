"""Recent six-month volatility calculator using Toss daily candle data."""
from __future__ import annotations

import json
import math
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

from mumae_core import ETF_UNIVERSE
from toss_api import TossBroker

CACHE_PATH = Path("volatility_cache.json")


def _annualized_volatility(closes: list[float]) -> float:
    returns = [math.log(closes[index] / closes[index + 1]) for index in range(len(closes) - 1) if closes[index] > 0 and closes[index + 1] > 0]
    if len(returns) < 20:
        raise ValueError("Not enough daily candles for volatility calculation.")
    return statistics.stdev(returns) * math.sqrt(252) * 100


def refresh_volatility_cache(broker: TossBroker) -> dict[str, dict[str, float | str]]:
    values: dict[str, float] = {}
    for index, symbol in enumerate(ETF_UNIVERSE):
        payload = broker.get_daily_candles_raw(symbol, 130)
        candles = payload.get("result", {}).get("candles", [])
        closes = [float(candle["closePrice"]) for candle in candles]
        values[symbol] = _annualized_volatility(closes)
        if index < len(ETF_UNIVERSE) - 1:
            time.sleep(0.25)  # Stay below the market-chart rate limit.
    base = values["TQQQ"]
    result = {
        symbol: {
            "label": ETF_UNIVERSE[symbol],
            "volatility_6m": round(value, 2),
            "relative_to_tqqq_pct": round(value / base * 100, 1),
        }
        for symbol, value in values.items()
    }
    CACHE_PATH.write_text(json.dumps({"updated_at": datetime.now(timezone.utc).isoformat(), "items": result}, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def load_volatility_cache() -> tuple[str | None, dict[str, dict[str, float | str]]]:
    if not CACHE_PATH.exists():
        return None, {}
    payload = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    return payload.get("updated_at"), payload.get("items", {})
