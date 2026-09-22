"""Display broker-provided net P&L without subtracting costs twice."""
from decimal import Decimal, InvalidOperation
from typing import Any


def holding_pnl(row: dict[str, Any], value: Decimal, cost: Decimal) -> dict[str, Any]:
    # Toss /holdings: item.profitLoss amounts use the item's currency;
    # rateAfterCost is a ratio (0.10 means 10%), not percentage points.
    profit_loss = row.get("profitLoss")
    if not isinstance(profit_loss, dict):
        profit_loss = {}
    net = {}
    for key in ("amountAfterCost", "rateAfterCost"):
        try:
            number = Decimal(str(profit_loss.get(key)))
        except InvalidOperation:
            continue
        if number.is_finite():
            net[key] = number
    gross = value - cost
    return {
        "pnl": net.get("amountAfterCost", gross),
        "pnl_pct": (net["rateAfterCost"] * 100 if "rateAfterCost" in net
                    else gross / cost * 100 if cost else Decimal("0")),
        "pnl_cost_included": "amountAfterCost" in net,
        "pnl_pct_cost_included": "rateAfterCost" in net,
    }
