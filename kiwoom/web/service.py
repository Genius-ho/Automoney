"""Web-facing service layer for the Kiwoom VR dashboard.

Thin wrapper around vr_state.py / vr_engine.py -- no broker calls here,
since kiwoom_api.py's order/quote endpoints aren't implemented yet (see
kiwoom/README.md). "적용" from the web UI updates local state the same
way `vr_cli.py plan --apply` does; it does not place a real order.
"""
from __future__ import annotations

from dataclasses import asdict
from datetime import date
from pathlib import Path
from typing import Any

from kiwoom.vr_engine import apply_trade, band, initialize_state, maybe_roll_cycle, plan_rebalance
from kiwoom.vr_state import VrRuntimeState, VrStateStore


class VrWebService:
    def __init__(self, data_dir: str | Path = "data") -> None:
        self.data_dir = Path(data_dir)

    def list_profiles(self) -> list[str]:
        if not self.data_dir.exists():
            return []
        return sorted(path.stem.removeprefix("vr_") for path in self.data_dir.glob("vr_*.json"))

    def status(self, profile: str) -> dict[str, Any]:
        return self._snapshot(self._load(profile))

    def create_profile(
        self,
        profile: str,
        symbol: str,
        price: float,
        cash: float,
        *,
        g: float = 10.0,
        band_pct: float = 0.15,
        contribution: float = 20.0,
        cycle_length_days: int = 14,
        pool_seed_pct: float = 0.10,
        pool_usage_cap_pct: float = 0.75,
    ) -> dict[str, Any]:
        store = VrStateStore(profile, data_dir=self.data_dir)
        if store.exists():
            raise ValueError(f"이미 존재하는 프로필입니다: {profile}")
        if price <= 0 or cash <= 0:
            raise ValueError("가격과 투자금은 0보다 커야 합니다.")
        state = initialize_state(
            profile, symbol, price, cash,
            g=g, band_pct=band_pct, contribution=contribution,
            cycle_length_days=cycle_length_days, pool_seed_pct=pool_seed_pct,
            pool_usage_cap_pct=pool_usage_cap_pct,
        )
        store.save(state)
        return self._snapshot(state)

    def plan(self, profile: str, price: float, *, apply: bool = False) -> dict[str, Any]:
        if price <= 0:
            raise ValueError("가격은 0보다 커야 합니다.")
        store = VrStateStore(profile, data_dir=self.data_dir)
        state = self._load(profile, store=store)
        today = date.today()
        rolled = maybe_roll_cycle(state, today)

        result = plan_rebalance(state, price)
        plan_payload = None
        if result is not None:
            plan_payload = {
                "side": result.side,
                "shares": result.shares,
                "price": result.price,
                "resulting_shares": result.resulting_shares,
                "resulting_pool": result.resulting_pool,
            }
            if apply:
                apply_trade(state, result, today)

        if apply or rolled:
            store.save(state)

        return {"rolled": rolled, "plan": plan_payload, "status": self._snapshot(state)}

    def _load(self, profile: str, *, store: VrStateStore | None = None) -> VrRuntimeState:
        store = store or VrStateStore(profile, data_dir=self.data_dir)
        if not store.exists():
            raise ValueError(f"프로필이 없습니다: {profile}")
        return store.load()

    def _snapshot(self, state: VrRuntimeState) -> dict[str, Any]:
        low, high = band(state.v, state.band_pct)
        return {
            "profile": state.profile,
            "symbol": state.symbol,
            "v": state.v,
            "band_low": low,
            "band_high": high,
            "band_pct": state.band_pct,
            "shares": state.shares,
            "pool": state.pool,
            "g": state.g,
            "contribution": state.contribution,
            "cycle_length_days": state.cycle_length_days,
            "cycle_start_date": state.cycle_start_date,
            "cycles_completed": state.cycles_completed,
            "pool_usage_cap_pct": state.pool_usage_cap_pct,
            "cycle_pool_budget": state.cycle_pool_budget,
            "cycle_buy_spent": state.cycle_buy_spent,
            "trades": [asdict(trade) for trade in state.trades[-20:]],
            "updated_at": state.updated_at,
        }
