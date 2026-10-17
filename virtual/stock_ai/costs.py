"""Integer shares and net account returns; costs are configurable examples."""
from decimal import Decimal, ROUND_FLOOR, ROUND_CEILING
from .config import Settings


def dec(value):
    return Decimal(str(value))


def kr_tick(price):
    p = dec(price)
    for upper, tick in [(2000, 1), (5000, 5), (20000, 10), (50000, 50),
                        (200000, 100), (500000, 500)]:
        if p < upper:
            return Decimal(tick)
    return Decimal(1000)


def buy_position(cash, price, costs: Settings, market="KR"):
    cash, price = dec(cash), dec(price)
    if not cash.is_finite() or not price.is_finite() or min(cash, price) <= 0:
        raise ValueError("매수 금액과 가격은 양수여야 합니다.")
    entry = price * (1 + dec(costs.slippage_pct) / 100)
    quantity = int((cash / (entry * (1 + dec(costs.buy_fee_pct) / 100))).to_integral_value(rounding=ROUND_FLOOR))
    if quantity < 1:
        raise ValueError("자금으로 주식 1주를 매수할 수 없습니다.")
    gross = entry * quantity
    fee = gross * dec(costs.buy_fee_pct) / 100
    return {"quantity": quantity, "entry_price": float(entry), "capital": float(cash),
            "buy_fee": float(fee), "cash_left": float(cash - gross - fee),
            "costs": costs.model_dump(), "market": market}


def target_price(position):
    costs = Settings(**position["costs"])
    net_goal = dec(position["capital"]) * (1 + dec(costs.target_pct) / 100)
    rate = 1 - (dec(costs.sell_fee_pct) + dec(costs.sell_tax_pct)) / 100
    raw = (net_goal - dec(position["cash_left"])) / (position["quantity"] * rate)
    tick = kr_tick(raw) if position.get("market", "KR") == "KR" else Decimal(".01")
    rounded = (raw / tick).to_integral_value(rounding=ROUND_CEILING) * tick
    tick = kr_tick(rounded) if position.get("market", "KR") == "KR" else tick
    return float((rounded / tick).to_integral_value(rounding=ROUND_CEILING) * tick)


def settle(position, price):
    costs = Settings(**position["costs"])
    gross = dec(price) * position["quantity"]
    fee = gross * dec(costs.sell_fee_pct) / 100
    tax = gross * dec(costs.sell_tax_pct) / 100
    cash = dec(position["cash_left"]) + gross - fee - tax
    return {"cash": float(cash), "sell_fee": float(fee), "sell_tax": float(tax),
            "profit": float(cash - dec(position["capital"])),
            "net_return_pct": float((cash / dec(position["capital"]) - 1) * 100)}
