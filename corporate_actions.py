"""Known corporate actions and conservative split reconciliation helpers."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal


@dataclass(frozen=True)
class ShareSplit:
    symbol: str
    ex_date: date
    quantity_multiplier: Decimal

    @property
    def key(self) -> str:
        return f"{self.symbol}-{self.ex_date.isoformat()}-x{self.quantity_multiplier:g}"


KNOWN_SHARE_SPLITS = {
    "KORU": ShareSplit("KORU", date(2026, 7, 15), Decimal("20")),
}


def split_is_reflected(
    split: ShareSplit,
    old_quantity: Decimal,
    old_average: Decimal,
    new_quantity: Decimal,
    new_average: Decimal,
) -> bool:
    """Return True only when quantity, average, and total cost all show the split."""
    if min(old_quantity, old_average, new_quantity, new_average) <= 0:
        return False
    expected_quantity = old_quantity * split.quantity_multiplier
    expected_average = old_average / split.quantity_multiplier
    quantity_tolerance = max(Decimal("1"), expected_quantity * Decimal("0.02"))
    average_tolerance = expected_average * Decimal("0.03")
    old_cost = old_quantity * old_average
    new_cost = new_quantity * new_average
    cost_tolerance = old_cost * Decimal("0.05")
    return (
        abs(new_quantity - expected_quantity) <= quantity_tolerance
        and abs(new_average - expected_average) <= average_tolerance
        and abs(new_cost - old_cost) <= cost_tolerance
    )
