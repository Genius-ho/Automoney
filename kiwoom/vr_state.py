"""Per-profile persisted state for the VR5.0 engine.

Each child gets their own state file (data/vr_<profile>.json) so running
this program twice with different --profile values never shares or
collides state. See vr_cli.py for how profile selects both this and the
Kiwoom credentials file.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class Trade:
    day: str  # ISO date
    side: str  # "BUY" or "SELL"
    shares: int
    price: str


@dataclass
class VrRuntimeState:
    profile: str
    symbol: str
    shares: int
    pool: float
    v: float
    g: float
    band_pct: float
    contribution: float
    cycle_length_days: int
    pool_usage_cap_pct: float
    cycle_start_date: str  # ISO date
    cycle_buy_spent: float = 0.0
    cycle_pool_budget: float = 0.0
    cycles_completed: int = 0
    trades: list[Trade] = field(default_factory=list)
    updated_at: str = ""

    def cycle_start(self) -> date:
        return date.fromisoformat(self.cycle_start_date)


class VrStateStore:
    def __init__(self, profile: str, data_dir: str | Path = "data") -> None:
        self.profile = profile
        self.path = Path(data_dir) / f"vr_{profile}.json"

    def exists(self) -> bool:
        return self.path.exists()

    def load(self) -> VrRuntimeState:
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        trades = [Trade(**item) for item in raw.pop("trades", [])]
        return VrRuntimeState(trades=trades, **raw)

    def save(self, state: VrRuntimeState) -> None:
        state.updated_at = datetime.now(timezone.utc).isoformat()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = asdict(state)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.path)
