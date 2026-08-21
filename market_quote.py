"""Resolve a US quote's current price and prior regular-session close."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable
from zoneinfo import ZoneInfo

US_EASTERN = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class DayQuote:
    current_price: Decimal
    previous_close: Decimal | None
    day_change_pct: Decimal | None


def _positive_decimal(value: Any) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _market_date(value: Any):
    if not value:
        return None
    try:
        timestamp = datetime.fromisoformat(str(value))
        if timestamp.tzinfo is None:
            return None
        return timestamp.astimezone(US_EASTERN).date()
    except (TypeError, ValueError):
        return None


def _candle_session_date(value: Any):
    """Daily candle timestamps label a trading date; preserve that label."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)).date()
    except (TypeError, ValueError):
        return None


def resolve_day_quote(quote: dict[str, Any], candles: Iterable[dict[str, Any]]) -> DayQuote:
    """Select the newest completed candle relative to the quote's session date.

    Prefers the quote's own timestamp for the session date (US stock quotes
    always carry one). Toss's market-indicators price endpoint (KOSPI/KOSDAQ)
    returns timestamp: null, so when that's missing, the newest candle's own
    date is used as the session date instead -- still never trusts candle
    list *position/order*, only actual parsed dates, matching the 0c1cb8a
    fix this is built on."""
    current = None
    for name in ("lastPrice", "price", "currentPrice"):
        current = _positive_decimal(quote.get(name))
        if current is not None:
            break
    current = current or Decimal("0")
    if current <= 0:
        return DayQuote(current, None, None)

    dated_candles = []
    for candle in candles:
        candle_date = _candle_session_date(candle.get("timestamp") or candle.get("date"))
        close = _positive_decimal(candle.get("closePrice"))
        if candle_date is not None and close is not None:
            dated_candles.append((candle_date, close))

    session_date = _market_date(quote.get("timestamp"))
    if session_date is None and dated_candles:
        session_date = max(candle_date for candle_date, _ in dated_candles)
    if session_date is None:
        return DayQuote(current, None, None)

    completed = [(candle_date, close) for candle_date, close in dated_candles if candle_date < session_date]
    if not completed:
        return DayQuote(current, None, None)
    _, previous = max(completed, key=lambda item: item[0])
    return DayQuote(current, previous, (current - previous) / previous * 100)


def fetch_unadjusted_daily_candles(broker: Any, symbol: str, count: int = 5) -> list[dict[str, Any]]:
    """Fetch official closes while tolerating legacy broker test doubles."""
    try:
        payload = broker.get_daily_candles_raw(symbol, count, adjusted=False)
    except TypeError as error:
        if "adjusted" not in str(error):
            raise
        payload = broker.get_daily_candles_raw(symbol, count)
    return (payload.get("result") or {}).get("candles") or []


__all__ = ["DayQuote", "fetch_unadjusted_daily_candles", "resolve_day_quote"]
