"""Atomic local persistence for independent ETF strategy states."""
from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, fields
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from mumae_core import Mode, StrategyState, normalize_down_ladder_levels, symbol_profile


class StateStore:
    def __init__(self, path: str | Path = "state.json") -> None:
        self.path = Path(path)

    @staticmethod
    def _decode(raw: dict) -> StrategyState:
        raw = dict(raw)
        raw["t_value"] = Decimal(str(raw.get("t_value", "0")))
        raw["avg_cost"] = Decimal(str(raw.get("avg_cost", "0")))
        raw["cash_usd"] = Decimal(str(raw.get("cash_usd", "0")))
        raw["big_number_pct"] = Decimal(str(raw.get("big_number_pct", "15")))
        raw["mode"] = Mode(raw.get("mode", Mode.GENERAL.value))
        # strict=False: a legacy or hand-edited file must never block server startup.
        # NB: use dict.get's default (not `or`) so an explicit, user-chosen []
        # (all levels off) isn't silently coerced back to [1, 2].
        raw["down_ladder_enabled_levels"] = normalize_down_ladder_levels(
            raw.get("down_ladder_enabled_levels", [1, 2]), strict=False
        )
        symbol = str(raw.get("symbol", "TQQQ")).upper()
        raw["final_tp_pct"] = (
            Decimal(str(raw["final_tp_pct"]))
            if raw.get("final_tp_pct") not in (None, "")
            else symbol_profile(symbol)[1]
        )
        known = {field.name for field in fields(StrategyState)}
        state = StrategyState(**{key: value for key, value in raw.items() if key in known})
        state.validate()
        return state

    def saved_symbols(self) -> list[str]:
        raw = self._read()
        if "portfolios" in raw:
            return sorted(raw.get("portfolios", {}).keys())
        symbol = raw.get("symbol")
        return [str(symbol).upper()] if symbol else []

    def _read(self) -> dict:
        if not self.path.exists():
            return {"version": 2, "last_symbol": "TQQQ", "portfolios": {}}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def load(self, symbol: str | None = None) -> StrategyState:
        raw = self._read()
        if "portfolios" not in raw:
            legacy = self._decode(raw)
            target = symbol or legacy.symbol
            return legacy if target == legacy.symbol else StrategyState(symbol=target, final_tp_pct=symbol_profile(target)[1])
        target = symbol or raw.get("last_symbol", "TQQQ")
        portfolio = raw.get("portfolios", {}).get(target)
        return self._decode(portfolio) if portfolio else StrategyState(symbol=target, final_tp_pct=symbol_profile(target)[1])

    def save(self, state: StrategyState) -> None:
        state.validate()
        raw = self._read()
        if "portfolios" not in raw:
            legacy = self._decode(raw)
            raw = {"version": 2, "last_symbol": legacy.symbol, "portfolios": {legacy.symbol: self._serialize(legacy)}}
        raw.setdefault("portfolios", {})[state.symbol] = self._serialize(state)
        raw["version"] = 2
        raw["last_symbol"] = state.symbol
        temp = self.path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        temp.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, self.path)

    @staticmethod
    def _serialize(state: StrategyState) -> dict:
        raw = asdict(state)
        raw.update({"t_value": str(state.t_value), "avg_cost": str(state.avg_cost), "cash_usd": str(state.cash_usd), "big_number_pct": str(state.big_number_pct), "final_tp_pct": str(state.final_tp_pct), "mode": state.mode.value, "updated_at": datetime.now(timezone.utc).isoformat()})
        return raw
