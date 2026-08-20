"""Cross-strategy cash reservation ledger for VR_SKILL.

Prevents VR and MUMAE from double-spending the same Toss buying power on the
same account. VR conditional orders reserve cash the moment they're planned
(not just when they trigger); MUMAE's likely near-term cash need is
estimated read-only via mumae_core's existing attempt_amount() rather than
requiring MUMAE to actively register/release reservations on every order --
mumae_core.py itself stays untouched.

Kept as its own module (not inside TossBroker or application_engine) so it
stays broker-agnostic and trivially testable without fakes.
"""
from __future__ import annotations

import json
import os
import uuid
from decimal import Decimal
from pathlib import Path

from mumae_core import StrategyState, attempt_amount


class FundsReservationLedger:
    def __init__(self, path: str | Path = "vr_funds_reservations.json") -> None:
        self.path = Path(path)

    def _read(self) -> dict:
        if not self.path.exists():
            return {"reservations": {}}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _write(self, raw: dict) -> None:
        temp = self.path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        temp.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, self.path)

    def reserve(self, strategy_type: str, symbol: str, amount: Decimal) -> str:
        if amount < 0:
            raise ValueError("Reservation amount cannot be negative.")
        raw = self._read()
        reservation_id = uuid.uuid4().hex
        raw.setdefault("reservations", {})[reservation_id] = {
            "strategy_type": strategy_type,
            "symbol": symbol,
            "amount": str(amount),
        }
        self._write(raw)
        return reservation_id

    def release(self, reservation_id: str) -> None:
        raw = self._read()
        raw.get("reservations", {}).pop(reservation_id, None)
        self._write(raw)

    def total_reserved(self, symbol: str | None = None, strategy_type: str | None = None) -> Decimal:
        raw = self._read()
        total = Decimal("0")
        for row in raw.get("reservations", {}).values():
            if symbol is not None and row["symbol"] != symbol:
                continue
            if strategy_type is not None and row["strategy_type"] != strategy_type:
                continue
            total += Decimal(row["amount"])
        return total


def mumae_projected_reserve(state: StrategyState) -> Decimal:
    """Conservative estimate of MUMAE's next-buy cash need for a symbol.

    Read-only: reuses mumae_core.attempt_amount(), MUMAE's own existing pure
    per-rung cash calculation, so this never duplicates or drifts from
    MUMAE's real math and never requires MUMAE to call into this ledger.
    """
    return attempt_amount(state)


def available_vr_buying_power(
    account_buying_power: Decimal,
    ledger: FundsReservationLedger,
    symbol: str,
    vr_pool: Decimal,
    mumae_states: list[StrategyState] | None = None,
) -> Decimal:
    """The maximum a VR symbol may actually spend right now.

    min(
        that symbol's own VR Pool,
        real buying power - all VR reservations (this symbol's own included,
            since a past reservation already reduced real cash) - MUMAE's
            projected need across all MUMAE symbols,
    ), never negative.
    """
    total_vr_reserved = ledger.total_reserved(strategy_type="VR_SKILL")
    mumae_reserved = sum((mumae_projected_reserve(s) for s in (mumae_states or [])), Decimal("0"))
    remaining_account = account_buying_power - total_vr_reserved - mumae_reserved
    return max(Decimal("0"), min(vr_pool, remaining_account))
