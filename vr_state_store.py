"""Atomic local persistence for Value Rebalancing (VR_SKILL) per-symbol state.

Kept separate from state_store.py/mumae_core.py on purpose: VR's nested
current_cycle/pending_config/conditional_orders/history schema is deeper and
more Decimal-dense than MUMAE's StrategyState, and this file's schema will
keep evolving through the VR phases. A shared encode/decode with MUMAE would
force MUMAE's hot path to branch on strategy_type; instead this store mirrors
state_store.py's atomic-write + explicit Decimal (de)serialization pattern
independently, so VR schema changes never touch MUMAE's tests or code path.
"""
from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any


def _dec(value: Any, default: str = "0") -> Decimal:
    return Decimal(str(default if value is None else value))


def _opt_dec(value: Any) -> Decimal | None:
    return None if value is None else Decimal(str(value))


@dataclass
class VRCycle:
    cycle_id: str
    start_session: str
    end_session: str
    V: Decimal
    G: Decimal
    band_pct: Decimal
    pool_start: Decimal
    pool_current: Decimal
    lower_band: Decimal
    upper_band: Decimal
    E_at_close: Decimal | None = None
    # Projected total BUY-ladder spend if every armed rung eventually fills
    # (vr_execution_policy.select_buy_ladder_length's chosen cumulative
    # spend), fixed at arm time. Distinct from pool_current, which only
    # moves on real Toss fills -- the "Projected Pool" the book's order
    # table shows is pool_start - planned_buy_spend. None for cycles armed
    # before this field existed.
    planned_buy_spend: Decimal | None = None
    # Fraction of cycle_start_pool the BUY ladder targets spending (book:
    # 적립식/accumulation=0.75, 거치식/lump-sum=0.50, 인출식/withdrawal=0.25 --
    # same formula throughout, only this target differs). Defaults to 0.75
    # for backward compatibility with cycles persisted before this field
    # existed (matches the previously-hardcoded DEFAULT_POOL_USAGE_LIMIT_PCT).
    pool_usage_limit_pct: Decimal = field(default_factory=lambda: Decimal("0.75"))


@dataclass
class VRPendingConfig:
    G: Decimal | None = None
    band_pct: Decimal | None = None
    pool_adjustment: Decimal | None = None
    pool_usage_limit_pct: Decimal | None = None


@dataclass
class VRConditionalOrder:
    symbol: str
    cycle_id: str
    conditional_order_id: str | None
    client_order_id: str
    side: str
    trigger_price: Decimal
    order_price: Decimal
    quantity: int
    expire_date: str
    status: str
    triggered_order_id: str | None = None
    # 1-indexed, inclusive: which contiguous span of the uncompressed Book
    # Ladder this one broker order covers (equal to each other when the
    # ladder wasn't compressed). None for orders persisted before
    # compression existed.
    logical_start_rung: int | None = None
    logical_end_rung: int | None = None


@dataclass
class VRState:
    symbol: str = "TQQQ"
    strategy_type: str = "VR_SKILL"
    status: str = "UNINITIALIZED"
    initialized_at: str | None = None
    current_cycle: VRCycle | None = None
    pending_config: VRPendingConfig = field(default_factory=VRPendingConfig)
    conditional_orders: list[VRConditionalOrder] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    # Set only when status == "CYCLE_TRANSITION_BLOCKED", so the UI can show
    # why; cleared the moment a transition (or manual resolution) succeeds.
    blocked_reason: str | None = None
    # Regular (triggered) order ids whose fill has already been applied to
    # pool_current -- mirrors mumae_core.StrategyState.applied_fill_order_ids
    # so a duplicate fill notification (retry, restart replay) can never
    # move the Pool twice for the same fill.
    applied_fill_order_ids: list[str] = field(default_factory=list)
    # The fixed Friday chosen at VR initialization (vr_engine.
    # anchor_friday_on_or_after); every later cycle's scheduled end Friday is
    # anchor_friday + 14*(cycle_number-1) days, so a holiday adjustment in
    # one cycle never drifts later cycles' schedules.
    anchor_friday: str | None = None
    cycle_number: int = 0
    # Set only when status is BROKER_CONDITIONAL_CAPACITY_UNKNOWN/_EXCEEDED,
    # so the UI can show the planned ladder's logical BUY/SELL/total counts
    # alongside the verified capacity (None for the UNKNOWN case) without
    # parsing blocked_reason's free text. Cleared the moment a ladder is
    # next successfully armed.
    capacity_blocker: dict[str, Any] | None = None
    # Set only when status is SELL_RESERVATION_UNKNOWN: {"sell_count": int}.
    # Separate from capacity_blocker since it's a distinct, independently-
    # confirmable fact about the broker (see vr_execution_policy's
    # CONDITIONAL_SELL_RESERVATION_BEHAVIOR). Cleared the moment a ladder is
    # next successfully armed.
    sell_reservation_blocker: dict[str, Any] | None = None


_CYCLE_DECIMAL_FIELDS = ("V", "G", "band_pct", "pool_start", "pool_current", "lower_band", "upper_band")
_ORDER_DECIMAL_FIELDS = ("trigger_price", "order_price")


class VRStateStore:
    def __init__(self, path: str | Path = "vr_state.json") -> None:
        self.path = Path(path)

    def _read(self) -> dict:
        if not self.path.exists():
            return {"version": 1, "portfolios": {}}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def saved_symbols(self) -> list[str]:
        raw = self._read()
        return sorted(raw.get("portfolios", {}).keys())

    def load(self, symbol: str) -> VRState:
        raw = self._read()
        portfolio = raw.get("portfolios", {}).get(symbol)
        return self._decode(portfolio) if portfolio else VRState(symbol=symbol)

    def save(self, state: VRState) -> None:
        raw = self._read()
        raw.setdefault("portfolios", {})[state.symbol] = self._serialize(state)
        raw["version"] = 1
        temp = self.path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        temp.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, self.path)

    @staticmethod
    def _serialize(state: VRState) -> dict:
        cycle = None
        if state.current_cycle is not None:
            cycle = asdict(state.current_cycle)
            for key in _CYCLE_DECIMAL_FIELDS:
                cycle[key] = str(cycle[key])
            cycle["E_at_close"] = None if cycle["E_at_close"] is None else str(cycle["E_at_close"])
            cycle["planned_buy_spend"] = None if cycle["planned_buy_spend"] is None else str(cycle["planned_buy_spend"])
            cycle["pool_usage_limit_pct"] = str(cycle["pool_usage_limit_pct"])
        pending = asdict(state.pending_config)
        for key in ("G", "band_pct", "pool_adjustment", "pool_usage_limit_pct"):
            pending[key] = None if pending[key] is None else str(pending[key])
        orders = []
        for order in state.conditional_orders:
            row = asdict(order)
            for key in _ORDER_DECIMAL_FIELDS:
                row[key] = str(row[key])
            orders.append(row)
        return {
            "symbol": state.symbol,
            "strategy_type": state.strategy_type,
            "status": state.status,
            "initialized_at": state.initialized_at,
            "current_cycle": cycle,
            "pending_config": pending,
            "conditional_orders": orders,
            "history": state.history,
            "blocked_reason": state.blocked_reason,
            "applied_fill_order_ids": state.applied_fill_order_ids,
            "anchor_friday": state.anchor_friday,
            "cycle_number": state.cycle_number,
            "capacity_blocker": state.capacity_blocker,
            "sell_reservation_blocker": state.sell_reservation_blocker,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    def _decode(raw: dict) -> VRState:
        raw = dict(raw)

        cycle = None
        cycle_raw = raw.get("current_cycle")
        if cycle_raw:
            cycle_raw = dict(cycle_raw)
            for key in _CYCLE_DECIMAL_FIELDS:
                cycle_raw[key] = _dec(cycle_raw.get(key))
            cycle_raw["E_at_close"] = _opt_dec(cycle_raw.get("E_at_close"))
            cycle_raw["planned_buy_spend"] = _opt_dec(cycle_raw.get("planned_buy_spend"))
            # Legacy cycles (persisted before this field existed) never had
            # pool_usage_limit_pct -- default to the old hardcoded 0.75 so
            # they keep behaving exactly as before.
            cycle_raw["pool_usage_limit_pct"] = _dec(cycle_raw.get("pool_usage_limit_pct"), default="0.75")
            cycle = VRCycle(**cycle_raw)

        pending_raw = dict(raw.get("pending_config") or {})
        pending = VRPendingConfig(
            G=_opt_dec(pending_raw.get("G")),
            band_pct=_opt_dec(pending_raw.get("band_pct")),
            pool_adjustment=_opt_dec(pending_raw.get("pool_adjustment")),
            pool_usage_limit_pct=_opt_dec(pending_raw.get("pool_usage_limit_pct")),
        )

        orders = []
        for order_raw in raw.get("conditional_orders") or []:
            order_raw = dict(order_raw)
            for key in _ORDER_DECIMAL_FIELDS:
                order_raw[key] = _dec(order_raw.get(key))
            orders.append(VRConditionalOrder(**order_raw))

        return VRState(
            symbol=str(raw.get("symbol", "TQQQ")).upper(),
            strategy_type=raw.get("strategy_type", "VR_SKILL"),
            status=raw.get("status", "UNINITIALIZED"),
            initialized_at=raw.get("initialized_at"),
            current_cycle=cycle,
            pending_config=pending,
            conditional_orders=orders,
            history=list(raw.get("history") or []),
            blocked_reason=raw.get("blocked_reason"),
            applied_fill_order_ids=list(raw.get("applied_fill_order_ids") or []),
            anchor_friday=raw.get("anchor_friday"),
            cycle_number=int(raw.get("cycle_number") or 0),
            capacity_blocker=raw.get("capacity_blocker"),
            sell_reservation_blocker=raw.get("sell_reservation_blocker"),
        )
