"""Persistent runtime state for local automated order submission."""
from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def normalize_delay_minutes(value: Any) -> int:
    """Validate the auto-order start delay: whole minutes, 0-180 inclusive."""
    if isinstance(value, bool):
        raise ValueError("지연시간은 정수(분)만 허용합니다.")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError("지연시간은 정수(분)만 허용합니다.")
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        raise ValueError("지연시간은 정수(분)만 허용합니다.")
    if not 0 <= minutes <= 180:
        raise ValueError("지연시간은 0~180분 사이여야 합니다.")
    return minutes


STRATEGY_MUMAE = "MUMAE"
STRATEGY_VR_SKILL = "VR_SKILL"
STRATEGY_TYPES = (STRATEGY_MUMAE, STRATEGY_VR_SKILL)


@dataclass
class RuntimeStatus:
    auto_enabled: bool = False
    phase: str = "STOPPED"
    last_auto_key: str = ""
    active_order_ids: list[str] = field(default_factory=list)
    # "active_symbols" is kept for on-disk backward compatibility; it means
    # "symbols with new-order submission currently enabled" (RUNNING/not paused).
    active_symbols: list[str] = field(default_factory=list)
    # Symbols that have ever been started. Never shrinks on stop_auto(), so
    # fill-sync/account refresh keeps running for a paused symbol.
    known_symbols: list[str] = field(default_factory=list)
    # Per-symbol bookkeeping for the web GUI status table.
    last_auto_attempt_at: dict[str, str] = field(default_factory=dict)
    last_auto_error: dict[str, str] = field(default_factory=dict)
    # Minutes after the US regular market open before the auto-tick loop is
    # allowed to submit new orders for the day. Default matches the previous
    # hardcoded 15-minute delay.
    auto_order_delay_minutes: int = 15
    skipped_order_ids: list[str] = field(default_factory=list)
    applied_corporate_actions: list[str] = field(default_factory=list)
    history_start_date: str = ""
    history_start_dates: dict[str, str] = field(default_factory=dict)
    broker_client_order_ids: dict[str, str] = field(default_factory=dict)
    broker_order_ids: dict[str, str] = field(default_factory=dict)
    order_price_overrides: dict[str, str] = field(default_factory=dict)
    order_quantity_overrides: dict[str, str] = field(default_factory=dict)
    # Per-symbol dedup key (a trading-session date) for the once-per-day
    # auto-tick buy submission, gated by auto_order_delay_minutes after the
    # regular session opens.
    auto_attempt_keys: dict[str, str] = field(default_factory=dict)
    # Per-symbol dedup key for the early day-market DAY sell submission.
    # This is separate from auto_sell_attempt_keys, which tracks the later
    # close (CLS) sell submission.
    auto_day_sell_attempt_keys: dict[str, str] = field(default_factory=dict)
    # Same idea but for sell-side orders, which submit as soon as pre-market
    # opens (the CLS sell is intentionally held for the close).
    auto_sell_attempt_keys: dict[str, str] = field(default_factory=dict)
    # Telegram long-polling state. The offset prevents a process restart from
    # executing the same /retry command twice.
    telegram_update_offset: int = 0
    # Persisted, restart-surviving record of every order a human has hand-
    # edited (via edit_failed_price or reregister_order): the fixed facts
    # (symbol/side/quantity/price/reason) needed to identify it as a "custom
    # order" and to know its baseline values, independent of plan_cache
    # (which is in-memory and only covers the current day's strategy plan).
    # Keyed by client_order_id.
    custom_order_ledger: dict[str, dict] = field(default_factory=dict)
    # Cancel/reject -> reregister linkage. Keyed by the *original* order's
    # client_order_id. Presence of "replacement_order_id" is the idempotency
    # lock: a given original order may only ever be reregistered once.
    custom_order_history: dict[str, dict] = field(default_factory=dict)
    # Single authoritative source of "which strategy owns this symbol"
    # (MUMAE | VR_SKILL). Missing entries default to MUMAE (see
    # get_strategy_type), so every pre-VR runtime.json keeps behaving
    # exactly as before. VR's own state file stores a strategy_type copy
    # too, but only for display/validation -- this dict is the only place
    # routing decisions (auto_tick, dispatch) may read from.
    strategy_types: dict[str, str] = field(default_factory=dict)
    updated_at: str = ""


def get_strategy_type(status: RuntimeStatus, symbol: str) -> str:
    """The authoritative strategy_type for symbol. Defaults to MUMAE so
    every symbol that existed before VR_SKILL was introduced is unaffected."""
    return status.strategy_types.get(symbol.upper(), STRATEGY_MUMAE)


def set_strategy_type(status: RuntimeStatus, symbol: str, strategy_type: str) -> None:
    if strategy_type not in STRATEGY_TYPES:
        raise ValueError(f"지원하지 않는 전략입니다: {strategy_type!r}")
    status.strategy_types[symbol.upper()] = strategy_type


_ORDER_DATE_PATTERN = re.compile(r"-(\d{8})-")


def _tracked_order_date(client_order_id: str) -> date | None:
    match = _ORDER_DATE_PATTERN.search(str(client_order_id))
    if match is None:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y%m%d").date()
    except ValueError:
        return None


def prune_order_tracking(
    status: RuntimeStatus,
    *,
    today: date | None = None,
    active_days: int = 14,
    history_days: int = 30,
) -> bool:
    """Bound strategy-order bookkeeping without touching custom/unresolved data.

    Strategy orders are DAY/CLS orders and cannot still be live weeks later.
    Custom orders are retained because their edit/reregister history is a user
    record rather than disposable scheduler bookkeeping.
    """
    today = today or date.today()
    active_cutoff = today - timedelta(days=active_days)
    history_cutoff = today - timedelta(days=history_days)
    protected = set(status.custom_order_ledger) | set(status.custom_order_history)

    def stale(client_order_id: str, cutoff: date) -> bool:
        order_date = _tracked_order_date(client_order_id)
        return client_order_id not in protected and order_date is not None and order_date < cutoff

    before = (
        len(status.active_order_ids),
        len(status.skipped_order_ids),
        len(status.broker_client_order_ids),
        len(status.broker_order_ids),
        len(status.order_price_overrides),
        len(status.order_quantity_overrides),
    )
    status.active_order_ids = [item for item in status.active_order_ids if not stale(item, active_cutoff)]
    status.skipped_order_ids = [item for item in status.skipped_order_ids if not stale(item, active_cutoff)]
    for mapping in (
        status.broker_client_order_ids,
        status.broker_order_ids,
        status.order_price_overrides,
        status.order_quantity_overrides,
    ):
        for client_order_id in list(mapping):
            if stale(client_order_id, history_cutoff):
                mapping.pop(client_order_id, None)
    after = (
        len(status.active_order_ids),
        len(status.skipped_order_ids),
        len(status.broker_client_order_ids),
        len(status.broker_order_ids),
        len(status.order_price_overrides),
        len(status.order_quantity_overrides),
    )
    return before != after


class RuntimeStore:
    def __init__(self, path: str | Path = "runtime.json") -> None:
        self.path = Path(path)

    def load(self) -> RuntimeStatus:
        if not self.path.exists():
            return RuntimeStatus()
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        known = {field.name for field in fields(RuntimeStatus)}
        return RuntimeStatus(**{key: value for key, value in raw.items() if key in known})

    def save(self, status: RuntimeStatus) -> None:
        status.updated_at = datetime.now(timezone.utc).isoformat()
        temp = self.path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        temp.write_text(json.dumps(asdict(status), ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, self.path)
