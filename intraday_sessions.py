"""Exchange-local session and market-phase identity for intraday research."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo


NEW_YORK = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class CandleContext:
    session_date: date
    phase: str
    local_timestamp: datetime

    @property
    def segment_key(self) -> tuple[date, str]:
        return self.session_date, self.phase


def classify_timestamp(timestamp: datetime) -> CandleContext:
    """Classify an aware candle timestamp in standard extended US hours.

    The session runs from 20:00 ET through 20:00 ET on the following local
    date. The explicit timezone conversion keeps DST changes out of the
    session logic and avoids relying on the host's timezone.
    """
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ValueError("intraday candle timestamps must be timezone-aware")
    local = timestamp.astimezone(NEW_YORK)
    local_time = local.timetz().replace(tzinfo=None)
    if local_time >= time(20, 0):
        session_date = local.date() + timedelta(days=1)
        phase = "DAY"
    elif local_time < time(4, 0):
        session_date = local.date()
        phase = "DAY"
    elif local_time < time(9, 30):
        session_date = local.date()
        phase = "PREMARKET"
    elif local_time < time(16, 0):
        session_date = local.date()
        phase = "REGULAR"
    else:
        session_date = local.date()
        phase = "AFTER"
    return CandleContext(session_date, phase, local)


def session_phase_key(timestamp: datetime) -> tuple[date, str]:
    return classify_timestamp(timestamp).segment_key


__all__ = ["CandleContext", "NEW_YORK", "classify_timestamp", "session_phase_key"]
