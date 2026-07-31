"""Daily trade-history aggregation and realized P/L calculation."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from corporate_actions import KNOWN_SHARE_SPLITS


@dataclass(frozen=True)
class DailyTrade:
    trade_date: str
    symbol: str
    side: str
    quantity: Decimal
    average_price: Decimal
    commission: Decimal
    realized_pnl: Decimal | None


def summarize_realized_pnl(trades: list[DailyTrade]) -> tuple[Decimal, int]:
    """Return known realized P/L and the count of sell groups lacking cost basis."""
    sells = [trade for trade in trades if trade.side == "SELL"]
    total = sum((trade.realized_pnl for trade in sells if trade.realized_pnl is not None), Decimal("0"))
    unknown_sales = sum(1 for trade in sells if trade.realized_pnl is None)
    return total, unknown_sales


def aggregate_daily_trades(rows: list[dict[str, Any]]) -> list[DailyTrade]:
    fills = []
    for row in rows:
        execution = row.get("execution") or {}
        quantity = Decimal(str(execution.get("filledQuantity") or "0"))
        filled_at = execution.get("filledAt")
        if quantity <= 0 or not filled_at:
            continue
        price = Decimal(str(execution.get("averageFilledPrice") or "0"))
        amount_value = execution.get("filledAmount")
        amount = Decimal(str(amount_value)) if amount_value not in (None, "") else quantity * price
        timestamp = datetime.fromisoformat(str(filled_at).replace("Z", "+00:00"))
        # A pre-split fill's quantity/price are still denominated in
        # pre-split share terms; every fill afterwards is post-split. Without
        # restating the old fills, the running inventory below silently
        # under-counts shares held across the split, so every sell after it
        # looks like it exceeds what was ever bought -- permanently marking
        # real gains as "unknown cost basis" and dropping them from the
        # total. amount/commission/tax are dollar figures and unaffected.
        split = KNOWN_SHARE_SPLITS.get(str(row.get("symbol") or ""))
        if split and timestamp.date() <= split.ex_date:
            quantity *= split.quantity_multiplier
            price /= split.quantity_multiplier
        fills.append((timestamp, row, execution, quantity, price, amount))
    fills.sort(key=lambda item: item[0])

    inventory: dict[str, tuple[Decimal, Decimal]] = {}
    groups: dict[tuple[str, str, str], dict[str, Decimal | None]] = {}
    for timestamp, row, execution, quantity, price, amount in fills:
        symbol = str(row.get("symbol") or "")
        side = str(row.get("side") or "").upper()
        commission = Decimal(str(execution.get("commission") or "0"))
        tax = Decimal(str(execution.get("tax") or "0"))
        owned_qty, owned_cost = inventory.get(symbol, (Decimal("0"), Decimal("0")))
        realized: Decimal | None = None
        if side == "BUY":
            inventory[symbol] = (owned_qty + quantity, owned_cost + amount + commission + tax)
        elif side == "SELL":
            if owned_qty >= quantity and owned_qty > 0:
                sold_cost = owned_cost / owned_qty * quantity
                realized = amount - commission - tax - sold_cost
                inventory[symbol] = (owned_qty - quantity, owned_cost - sold_cost)
            else:
                inventory[symbol] = (Decimal("0"), Decimal("0"))
        else:
            continue

        key = (timestamp.date().isoformat(), symbol, side)
        group = groups.setdefault(key, {"quantity": Decimal("0"), "amount": Decimal("0"), "commission": Decimal("0"), "realized": Decimal("0") if side == "SELL" else None})
        group["quantity"] += quantity
        group["amount"] += amount
        group["commission"] += commission + tax
        if side == "SELL":
            if realized is None:
                group["realized"] = None
            elif group["realized"] is not None:
                group["realized"] += realized

    result = []
    for (trade_date, symbol, side), group in groups.items():
        quantity = group["quantity"]
        result.append(DailyTrade(trade_date, symbol, side, quantity, group["amount"] / quantity, group["commission"], group["realized"]))
    return sorted(result, key=lambda item: (item.trade_date, item.symbol, item.side), reverse=True)
