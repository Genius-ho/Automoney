"""Pure, side-effect-free V4.0 calculations for the local 40-split planner."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from enum import StrEnum
from typing import Any, Iterable, Literal, Sequence

DOWN_LADDER_LEVELS = (1, 2, 3, 4, 5)


def normalize_down_ladder_levels(raw: Iterable[Any], *, strict: bool = True) -> list[int]:
    """Normalize a Down Ladder level selection: dedupe and sort. Any subset of
    1-5 is allowed, including empty (all levels off).

    strict=True (API entry points) rejects out-of-range/non-integer values so
    client bugs surface immediately. strict=False (loading persisted files)
    silently drops bad values so a corrupted/legacy file never blocks startup.
    """
    values: set[int] = set()
    for item in raw:
        try:
            level = int(item)
        except (TypeError, ValueError):
            if strict:
                raise ValueError(f"Down ladder 단계 값이 올바르지 않습니다: {item!r}")
            continue
        if level not in DOWN_LADDER_LEVELS:
            if strict:
                raise ValueError(f"Down ladder 단계는 1~5 사이여야 합니다: {level}")
            continue
        values.add(level)
    return sorted(values)

Money = Decimal
CENT = Decimal("0.01")
ETF_UNIVERSE = {
    "TQQQ": "나스닥100 3배",
    "SOXL": "반도체 3배",
    "KORU": "한국 3배",
    "UPRO": "S&P 500 3배",
    "SPXL": "S&P 500 3배",
    "TECL": "기술주 3배",
    "FNGU": "FANG+ 3배 ETN",
    "LABU": "바이오텍 3배",
    "TNA": "러셀2000 3배",
    "FAS": "금융 3배",
    "UDOW": "다우30 3배",
}
# KORU intentionally uses the SOXL profile at the user's direction.
SYMBOL_PROFILES: dict[str, tuple[Decimal, Decimal]] = {
    "TQQQ": (Decimal("15"), Decimal("15")),
    "SOXL": (Decimal("20"), Decimal("20")),
    "KORU": (Decimal("20"), Decimal("20")),
    # The following defaults are user-configurable strategy baselines, not original V4 verified values.
    "UPRO": (Decimal("15"), Decimal("15")),
    "SPXL": (Decimal("15"), Decimal("15")),
    "TECL": (Decimal("15"), Decimal("15")),
    "FNGU": (Decimal("15"), Decimal("15")),
    "LABU": (Decimal("15"), Decimal("15")),
    "TNA": (Decimal("15"), Decimal("15")),
    "FAS": (Decimal("15"), Decimal("15")),
    "UDOW": (Decimal("15"), Decimal("15")),
}
if set(ETF_UNIVERSE) != set(SYMBOL_PROFILES):
    raise RuntimeError("ETF universe and strategy profiles must contain the same symbols.")


class Mode(StrEnum):
    GENERAL = "GENERAL"
    REVERSE_FIRST_DAY = "REVERSE_FIRST_DAY"
    REVERSE = "REVERSE"


class OrderKind(StrEnum):
    LIMIT = "LIMIT"
    CLOSE_AUCTION = "CLOSE_AUCTION"


@dataclass
class StrategyState:
    symbol: str = "TQQQ"
    split_count: int = 40
    t_value: Decimal = Decimal("0")
    avg_cost: Money = Decimal("0")
    cash_usd: Money = Decimal("0")
    position_qty: int = 0
    mode: Mode = Mode.GENERAL
    cycle_id: str = "default"
    big_number_pct: Decimal = Decimal("15")
    big_number_enabled: bool = False
    base_buy_qty: int = 2
    applied_fill_order_ids: list[str] = field(default_factory=list)
    down_ladder_enabled_levels: list[int] = field(default_factory=lambda: [1, 2])
    # Final take-profit percentage above average cost. Defaults to the
    # symbol's SYMBOL_PROFILES value (see state_store._decode / load), but is
    # user-editable per symbol from here on.
    final_tp_pct: Decimal = Decimal("15")
    # Share of the post-quarter-sell remainder sold at final_tp_pct; the rest
    # (100 - this) is sold at second_tp_pct instead. Defaults to 100 so an
    # unconfigured second tier reproduces the old single-tier behavior exactly.
    final_tp_qty_pct: Decimal = Decimal("100")
    # Second take-profit percentage above average cost, for whatever quantity
    # final_tp_qty_pct leaves unsold. Must exceed final_tp_pct.
    second_tp_pct: Decimal = Decimal("25")
    updated_at: str = ""

    def validate(self) -> None:
        if self.symbol not in SYMBOL_PROFILES or self.split_count != 40:
            raise ValueError("선택한 ETF는 현재 무한매수 40분할 전략에서 지원되지 않습니다.")
        if not Decimal("0") <= self.t_value <= Decimal("40"):
            raise ValueError("T must be between 0 and 40.")
        if self.position_qty < 0 or self.cash_usd < 0 or self.avg_cost < 0:
            raise ValueError("Balances, quantity, and average cost cannot be negative.")
        if self.base_buy_qty < 2 or self.base_buy_qty % 2:
            raise ValueError("Base buy quantity must be an even number of at least 2.")
        if not Decimal("5") <= self.big_number_pct <= Decimal("30"):
            raise ValueError("Big-number buffer must be between 5% and 30%.")
        if not Decimal("1") <= self.final_tp_pct <= Decimal("100"):
            raise ValueError("최종 익절 %는 1~100 사이여야 합니다.")
        if not Decimal("0") <= self.final_tp_qty_pct <= Decimal("100"):
            raise ValueError("1단계 익절 수량 비율은 0~100 사이여야 합니다.")
        if not Decimal("1") <= self.second_tp_pct <= Decimal("100"):
            raise ValueError("2단계 익절 %는 1~100 사이여야 합니다.")
        # Only enforced when the second tier is actually in effect
        # (final_tp_qty_pct < 100): at 100 the whole remainder sells at
        # final_tp_pct and second_tp_pct is unused, so an unrelated/legacy
        # second_tp_pct value (e.g. the migration default) must never block
        # loading or saving a symbol that never opted into the second tier.
        if self.final_tp_qty_pct < 100 and self.second_tp_pct <= self.final_tp_pct:
            raise ValueError("2단계 익절 %는 1단계 익절 %보다 커야 합니다.")
        levels = self.down_ladder_enabled_levels
        if sorted(set(levels)) != list(levels):
            raise ValueError("Down ladder 단계는 중복 없이 오름차순이어야 합니다.")
        if not set(levels) <= set(DOWN_LADDER_LEVELS):
            raise ValueError("Down ladder 단계는 1~5 사이여야 합니다.")


@dataclass(frozen=True)
class OrderIntent:
    client_order_id: str
    side: Literal["buy", "sell"]
    quantity: int
    limit_price: Money | None
    kind: OrderKind
    reason: str


@dataclass(frozen=True)
class Plan:
    orders: tuple[OrderIntent, ...] = field(default_factory=tuple)
    warnings: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class BigNumberPlan:
    triggered: bool
    gap_pct: Decimal | None
    buffer_pct: Decimal | None
    replacement_price: Money | None
    replacement_qty: int
    explanation: str


def money(value: Money) -> Money:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def floor_qty(value: Money) -> int:
    return int(value.to_integral_value(rounding=ROUND_DOWN))


def symbol_profile(symbol: str) -> tuple[Decimal, Decimal]:
    try:
        return SYMBOL_PROFILES[symbol]
    except KeyError as error:
        raise ValueError(f"Unsupported symbol: {symbol}") from error


def star_price(state: StrategyState) -> Money:
    """V4 star point: avg * (1 + base * (1 - 2T/N) / 100)."""
    state.validate()
    star_base_pct, _ = symbol_profile(state.symbol)
    star_pct = star_base_pct * (Decimal("1") - Decimal("2") * state.t_value / Decimal(state.split_count))
    return money(state.avg_cost * (Decimal("1") + star_pct / 100))


def attempt_amount(state: StrategyState) -> Money:
    state.validate()
    remaining = Decimal(state.split_count) - state.t_value
    return Decimal("0") if remaining <= 0 else money(state.cash_usd / remaining)


def final_take_profit_price(state: StrategyState) -> Money:
    state.validate()
    return money(state.avg_cost * (Decimal("1") + state.final_tp_pct / 100))


def second_take_profit_price(state: StrategyState) -> Money:
    state.validate()
    return money(state.avg_cost * (Decimal("1") + state.second_tp_pct / 100))


def down_ladder_prices(attempt: Money, anchor_price: Money, steps: int = 5) -> tuple[Money, ...]:
    if attempt <= 0 or anchor_price <= 0:
        return ()
    if steps < 1:
        raise ValueError("Ladder steps must be at least one.")
    base_qty = floor_qty(attempt / anchor_price)
    if base_qty < 1:
        return ()
    return tuple(money(attempt / Decimal(base_qty + k)) for k in range(1, steps + 1))


def _order_id(state: StrategyState, today: date, leg: str) -> str:
    return f"{state.cycle_id}-{state.symbol}-{today:%Y%m%d}-{leg}"


def _limit_buy(state: StrategyState, today: date, leg: str, amount: Money, price: Money, reason: str) -> OrderIntent | None:
    if price <= 0:
        return None
    quantity = floor_qty(amount / price)
    return None if quantity < 1 else OrderIntent(_order_id(state, today, leg), "buy", quantity, money(price), OrderKind.LIMIT, reason)


def build_plan(state: StrategyState, current_price: Money, today: date | None = None, previous_close: Money | None = None, ladder_steps: int = 5) -> Plan:
    state.validate()
    if current_price <= 0:
        raise ValueError("Current price must be positive.")
    today = today or date.today()
    orders: list[OrderIntent] = []
    warnings: list[str] = []
    divisor = state.split_count // 2

    if state.mode is Mode.REVERSE_FIRST_DAY:
        qty = state.position_qty // divisor
        if qty:
            orders.append(OrderIntent(_order_id(state, today, "reverse-first"), "sell", qty, money(current_price * Decimal("0.50")), OrderKind.CLOSE_AUCTION, f"Reverse first-day reduction (1/{divisor})"))
        return Plan(tuple(orders), tuple(warnings))

    if state.mode is Mode.REVERSE:
        qty = state.position_qty // divisor
        if qty:
            orders.append(OrderIntent(_order_id(state, today, "reverse-sell"), "sell", qty, money(current_price * Decimal("0.50")), OrderKind.CLOSE_AUCTION, f"Reverse daily reduction (1/{divisor})"))
        warnings.append("리버스 매수는 검증된 최근 5거래일 종가 평균이 필요하므로 실시간 시세만으로 계산하지 않습니다.")
        return Plan(tuple(orders), tuple(warnings))

    base_qty = state.base_buy_qty
    if state.position_qty == 0:
        close = previous_close if previous_close is not None else current_price
        orders.append(OrderIntent(_order_id(state, today, "entry"), "buy", base_qty, money(close * Decimal("1.10")), OrderKind.LIMIT, "New-cycle LOC buy (previous close +10%)"))
        return Plan(tuple(orders), tuple(warnings))

    star = star_price(state)
    if state.t_value < Decimal(state.split_count) / 2:
        half_qty = base_qty // 2
        orders.extend((
            OrderIntent(_order_id(state, today, "star-buy"), "buy", half_qty, star, OrderKind.LIMIT, "First-half star LOC buy (50%)"),
            OrderIntent(_order_id(state, today, "avg-buy"), "buy", half_qty, money(state.avg_cost), OrderKind.LIMIT, "First-half average LOC buy (50%)"),
        ))
        ladder_anchor = state.avg_cost
    else:
        orders.append(OrderIntent(_order_id(state, today, "star-buy"), "buy", base_qty, star, OrderKind.LIMIT, "Second-half star LOC buy"))
        ladder_anchor = star

    amount = money(ladder_anchor * base_qty)
    enabled_levels = set(state.down_ladder_enabled_levels)
    for index, price in enumerate(down_ladder_prices(amount, ladder_anchor, ladder_steps), start=1):
        if index not in enabled_levels:
            continue
        orders.append(OrderIntent(_order_id(state, today, f"ladder-{index}"), "buy", base_qty, price, OrderKind.LIMIT, f"Down ladder {index}/{ladder_steps}"))

    quarter_qty = state.position_qty // 4
    if quarter_qty:
        orders.append(OrderIntent(_order_id(state, today, "quarter-sell"), "sell", quarter_qty, star, OrderKind.LIMIT, "Star-price quarter LOC sell"))
    remaining_qty = state.position_qty - quarter_qty
    first_tp_qty = int(remaining_qty * state.final_tp_qty_pct / 100)
    if first_tp_qty:
        orders.append(OrderIntent(_order_id(state, today, "take-profit"), "sell", first_tp_qty, final_take_profit_price(state), OrderKind.LIMIT, f"Final take-profit limit sell (+{state.final_tp_pct}% from average)"))
    second_tp_qty = remaining_qty - first_tp_qty
    if second_tp_qty:
        orders.append(OrderIntent(_order_id(state, today, "second-take-profit"), "sell", second_tp_qty, second_take_profit_price(state), OrderKind.LIMIT, f"Second take-profit sell (+{state.second_tp_pct}% from average)"))

    buy_notional = sum((order.limit_price or Decimal("0")) * order.quantity for order in orders if order.side == "buy")
    if buy_notional > amount:
        warnings.append("급락 시 하단 사다리 주문이 동시에 체결되어 1회 매수 기준액을 초과할 수 있습니다. 전송 전에 주문 가능 금액을 확인하세요.")
    return Plan(tuple(orders), tuple(warnings))


def build_big_number_plan(
    previous_close: Money,
    selected_pct: Decimal,
    buy_orders: Sequence[OrderIntent],
    trigger: bool,
    star_ceiling: Money | None = None,
) -> BigNumberPlan:
    """Create the V4 manual big-number LOC replacement.

    V4 does not prescribe a formula for the percentage. The operator chooses a
    price relative to the prior close. Its purpose is to ensure a LOC buy can
    execute whenever the closing price is below the star point.
    """
    if previous_close <= 0:
        raise ValueError("Previous close must be positive.")
    if not trigger:
        return BigNumberPlan(False, None, None, None, 0, "Today uses the normal star/average LOC ladder.")
    if selected_pct <= 0:
        raise ValueError("Big-number LOC percentage must be positive.")

    price = money(previous_close * (Decimal("1") + selected_pct / 100))

    qty = sum(order.quantity for order in buy_orders if order.side == "buy" and order.limit_price is not None and order.limit_price > price)
    star_qty = sum(order.quantity for order in buy_orders if order.side == "buy" and "star LOC buy" in order.reason)
    qty = max(qty, star_qty)
    return BigNumberPlan(
        True,
        None,
        money(selected_pct),
        price,
        qty,
        f"Manual big-number LOC: {selected_pct:.2f}% above the previous close; the percentage is an operator-selected guide.",
    )

def apply_fill(state: StrategyState, side: str, quantity: int, event: str = "full_buy") -> StrategyState:
    state.validate()
    if quantity <= 0:
        raise ValueError("Filled quantity must be positive.")
    if state.mode is Mode.REVERSE:
        if side == "sell":
            state.t_value *= Decimal("0.95")
        elif side == "buy":
            state.t_value += (Decimal(state.split_count) - state.t_value) * Decimal("0.25")
        else:
            raise ValueError("side must be buy or sell")
    elif side == "buy":
        state.t_value += Decimal("0.5") if event == "half_buy" else Decimal("1")
    elif side == "sell":
        if event == "limit_sell_then_half_buy":
            state.t_value = state.t_value * Decimal("0.25") + Decimal("0.5")
        elif event == "limit_sell_then_full_buy":
            state.t_value = state.t_value * Decimal("0.25") + Decimal("1")
        else:
            state.t_value *= Decimal("0.75")
    else:
        raise ValueError("side must be buy or sell")
    if state.t_value > Decimal(state.split_count - 1) and state.mode is Mode.GENERAL:
        state.mode = Mode.REVERSE_FIRST_DAY
    return state
