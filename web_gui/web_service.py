"""Cross-platform application service used by the browser GUI."""
from __future__ import annotations

import time
from dataclasses import asdict, replace
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable

from etf_info import ETF_INFO
from mumae_core import ETF_UNIVERSE, Mode, OrderIntent, StrategyState, attempt_amount, build_big_number_plan, build_plan, normalize_down_ladder_levels, star_price, symbol_profile
from runtime_store import RuntimeStore, prune_order_tracking
from state_store import StateStore
from toss_api import TossBroker


def _text_decimal(value: Any, default: str = "0") -> Decimal:
    if value in (None, ""):
        return Decimal(default)
    return Decimal(str(value))


def _json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mode):
        return value.value
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def _find_decimal(row: dict[str, Any], names: tuple[str, ...]) -> Decimal:
    for name in names:
        if row.get(name) not in (None, ""):
            return _text_decimal(row[name])
    return Decimal("0")


def _collect_symbol_rows(value: Any) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    if isinstance(value, dict):
        symbol = value.get("symbol") or value.get("ticker")
        if symbol:
            found[str(symbol).upper()] = value
        for item in value.values():
            found.update(_collect_symbol_rows(item))
    elif isinstance(value, list):
        for item in value:
            found.update(_collect_symbol_rows(item))
    return found


class WebService:
    """Owns state and read-only broker access; live order endpoints are excluded."""

    def __init__(
        self,
        data_dir: str | Path,
        broker_factory: Callable[[], TossBroker] = TossBroker,
    ) -> None:
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.store = StateStore(self.data_dir / "state.json")
        self.runtime_store = RuntimeStore(self.data_dir / "runtime.json")
        self.runtime = self.runtime_store.load()
        if prune_order_tracking(self.runtime):
            self.runtime_store.save(self.runtime)
        self._reconcile_known_symbols()
        self.broker_factory = broker_factory
        self._broker: TossBroker | None = None
        self.plan_cache: dict[str, list[OrderIntent]] = {}
        self.quote_cache: dict[str, tuple[Decimal, Decimal]] = {}
        # Previous close never changes intraday, so it's fetched via a broker
        # call at most once per symbol per calendar day (not on every
        # refresh/auto-tick) -- keyed by ticker, value is (date, close).
        self._previous_close_cache: dict[str, tuple[str, Decimal]] = {}

    def _previous_close(self, broker: TossBroker, ticker: str) -> Decimal | None:
        today = date.today()
        today_key = today.isoformat()
        cached = self._previous_close_cache.get(ticker)
        if cached and cached[0] == today_key:
            return cached[1]
        # Find the most recent candle strictly before today by its own
        # timestamp rather than assuming index 1 is "yesterday" -- if
        # today's candle isn't in the response yet (or is missing for any
        # other reason), a fixed index silently grabs the wrong day and
        # caches it wrong for the rest of the day.
        candles = broker.get_daily_candles_raw(ticker, 5).get("result", {}).get("candles", [])
        time.sleep(0.25)
        for candle in candles:
            candle_date = datetime.fromisoformat(candle["timestamp"]).date()
            if candle_date < today:
                previous = _text_decimal(candle.get("closePrice"))
                self._previous_close_cache[ticker] = (today_key, previous)
                return previous
        return None

    def _reconcile_known_symbols(self) -> None:
        """known_symbols must include every ETF that has ever been saved, not
        just ones started in the current runtime.json (e.g. after migrating
        from a version without this field). Additive only, never removes."""
        known = set(self.runtime.known_symbols) | set(self.runtime.active_symbols) | set(self.store.saved_symbols())
        if known != set(self.runtime.known_symbols):
            self.runtime.known_symbols = sorted(known)
            self.runtime_store.save(self.runtime)

    def broker(self) -> TossBroker:
        if self._broker is None:
            self._broker = self.broker_factory()
        return self._broker

    def reconnect_broker(self) -> TossBroker:
        self._broker = self.broker_factory()
        return self._broker

    @staticmethod
    def _state_dict(state: StrategyState) -> dict[str, Any]:
        return _json_value(asdict(state))

    def load_state(self, symbol: str) -> StrategyState:
        return self.store.load(symbol.upper())

    def update_state(self, payload: dict[str, Any]) -> StrategyState:
        symbol = str(payload.get("symbol", "TQQQ")).upper()
        current = self.store.load(symbol)
        levels = (
            normalize_down_ladder_levels(payload["down_ladder_enabled_levels"], strict=True)
            if "down_ladder_enabled_levels" in payload
            else current.down_ladder_enabled_levels
        )
        state = replace(
            current,
            symbol=symbol,
            cash_usd=_text_decimal(payload.get("cash_usd"), str(current.cash_usd)),
            position_qty=int(payload.get("position_qty", current.position_qty)),
            avg_cost=_text_decimal(payload.get("avg_cost"), str(current.avg_cost)),
            t_value=_text_decimal(payload.get("t_value"), str(current.t_value)),
            base_buy_qty=int(payload.get("base_buy_qty", current.base_buy_qty)),
            big_number_pct=_text_decimal(payload.get("big_number_pct"), str(current.big_number_pct)),
            big_number_enabled=bool(payload.get("big_number_enabled", current.big_number_enabled)),
            final_tp_pct=_text_decimal(payload.get("final_tp_pct"), str(current.final_tp_pct)),
            mode=Mode(str(payload.get("mode", current.mode.value))),
            down_ladder_enabled_levels=levels,
        )
        state.validate()
        self.store.save(state)
        return state

    def dashboard(
        self,
        state: StrategyState,
        current_price: Decimal | None = None,
        previous_close: Decimal | None = None,
        holdings: list[dict[str, Any]] | None = None,
        plan_date: date | None = None,
    ) -> dict[str, Any]:
        orders: list[dict[str, Any]] = []
        warnings: list[str] = []
        star: Decimal | None = None
        if state.position_qty > 0:
            star = star_price(state)
        if current_price is not None and current_price > 0:
            plan = build_plan(
                state,
                current_price,
                today=plan_date,
                previous_close=previous_close or current_price,
            )
            warnings = list(plan.warnings)
            display_orders = list(plan.orders)
            big_plan = build_big_number_plan(
                previous_close or current_price,
                state.big_number_pct,
                plan.orders,
                state.big_number_enabled,
            )
            if big_plan.triggered and big_plan.replacement_price is not None:
                display_orders = [
                    order for order in display_orders
                    if not (
                        order.side == "buy"
                        and (
                            (order.limit_price is not None and order.limit_price > big_plan.replacement_price)
                            or "star LOC buy" in order.reason
                        )
                    )
                ]
                if big_plan.replacement_qty:
                    source = next((order for order in plan.orders if "star LOC buy" in order.reason), plan.orders[0])
                    display_orders.insert(0, OrderIntent(
                        source.client_order_id.replace("-star-buy", "-big-loc"),
                        "buy",
                        big_plan.replacement_qty,
                        big_plan.replacement_price,
                        source.kind,
                        "특수매수 대체 LOC",
                    ))
            overridden: list[OrderIntent] = []
            for order in display_orders:
                raw_price = self.runtime.order_price_overrides.get(order.client_order_id)
                raw_qty = self.runtime.order_quantity_overrides.get(order.client_order_id)
                if raw_price is None and raw_qty is None:
                    overridden.append(order)
                    continue
                updates: dict[str, Any] = {}
                notes: list[str] = []
                if raw_price is not None:
                    updates["limit_price"] = _text_decimal(raw_price).quantize(Decimal("0.01"))
                    notes.append("수동 지정가")
                if raw_qty is not None:
                    updates["quantity"] = int(raw_qty)
                    notes.append("수동 수량")
                overridden.append(replace(order, reason=order.reason + " · " + "·".join(notes), **updates))
            display_orders = overridden
            orders = [
                {
                    "id": order.client_order_id,
                    "side": order.side,
                    "quantity": order.quantity,
                    "price": str(order.limit_price or Decimal("0")),
                    "kind": order.kind.value,
                    "reason": order.reason,
                }
                for order in display_orders
            ]
            self.plan_cache[state.symbol] = display_orders
            self.quote_cache[state.symbol] = (current_price, previous_close or current_price)
        invested = state.avg_cost * state.position_qty
        total_seed = invested + state.cash_usd
        progress = invested / total_seed * 100 if total_seed else Decimal("0")
        position_value = (current_price or Decimal("0")) * state.position_qty
        unrealized_pnl = position_value - invested if current_price is not None else Decimal("0")
        base_pct, _ = symbol_profile(state.symbol)
        star_pct = base_pct * (Decimal("1") - Decimal("2") * state.t_value / state.split_count)
        return {
            "state": self._state_dict(state),
            "quote": {
                "current_price": str(current_price) if current_price is not None else None,
                "previous_close": str(previous_close) if previous_close is not None else None,
            },
            "metrics": {
                "star_price": str(star) if star is not None else None,
                "star_pct": str(star_pct),
                "attempt_amount": str(attempt_amount(state)),
                "invested": str(invested),
                "total_seed": str(total_seed),
                "cash": str(state.cash_usd),
                "position_value": str(position_value),
                "total_asset": str(state.cash_usd + position_value),
                "unrealized_pnl": str(unrealized_pnl),
                "progress_pct": str(progress.quantize(Decimal("0.1"))),
            },
            "holdings": holdings or [],
            "orders": orders,
            "warnings": warnings,
            "loc_summary": (
                f"특수매수 기준: 전일 종가 대비 {state.big_number_pct}%"
                if state.big_number_enabled else
                f"정상 사다리: {state.symbol} 전략 공식 적용"
            ),
            "live_order_enabled": False,
        }

    @staticmethod
    def etf_info(symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        if symbol not in ETF_INFO:
            raise ValueError("지원하지 않는 ETF입니다.")
        name, product_type, description, holdings = ETF_INFO[symbol]
        return {
            "symbol": symbol,
            "name": name,
            "type": product_type,
            "description": description,
            "holdings": [{"ticker": ticker, "name": name} for ticker, name in holdings],
        }

    def plan(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = self.update_state(payload)
        current = _text_decimal(payload.get("current_price"))
        previous = _text_decimal(payload.get("previous_close"), str(current))
        if current <= 0:
            raise ValueError("현재가는 0보다 커야 합니다.")
        return self.dashboard(state, current, previous)

    def refresh_account(self, symbol: str, plan_date: date | None = None) -> dict[str, Any]:
        symbol = symbol.upper()
        broker = self.broker()
        holding_rows = {
            ticker: row
            for ticker, row in _collect_symbol_rows(broker.get_holdings_raw()).items()
            if ticker in ETF_UNIVERSE
        }
        symbols = sorted(set(holding_rows) | {symbol})
        price_rows = _collect_symbol_rows(broker.get_prices_raw(symbols))
        buying_power = broker.get_buying_power_raw()
        cash = _text_decimal(buying_power.get("result", {}).get("cashBuyingPower"))

        holdings: list[dict[str, Any]] = []
        selected = self.store.load(symbol)
        selected_previous_close: Decimal | None = None
        for ticker in symbols:
            row = holding_rows.get(ticker, {})
            quote = price_rows.get(ticker, {})
            quantity = _find_decimal(row, ("quantity", "holdingQuantity", "holdingQty", "availableQuantity", "sellableQuantity"))
            average = _find_decimal(row, ("averagePrice", "avgPrice", "averagePurchasePrice", "purchaseAveragePrice", "averageCost"))
            price = _find_decimal(quote, ("lastPrice", "price", "currentPrice"))
            value = quantity * price
            cost = quantity * average
            pnl = value - cost
            rate = pnl / cost * 100 if cost else Decimal("0")
            ticker_state = selected if ticker == symbol else self.store.load(ticker)
            previous_close = self._previous_close(broker, ticker)
            if ticker == symbol:
                selected_previous_close = previous_close
            day_change_pct = (price - previous_close) / previous_close * 100 if previous_close and price > 0 else None
            holdings.append(_json_value({
                "symbol": ticker,
                "quantity": quantity,
                "average_price": average,
                "current_price": price,
                "day_change_pct": day_change_pct,
                "total_value": value,
                "pnl": pnl,
                "pnl_pct": rate,
                "t_value": ticker_state.t_value,
            }))
            if ticker == symbol:
                selected.position_qty = int(quantity)
                selected.avg_cost = average

        selected.cash_usd = cash
        if selected.position_qty > 0 and selected.t_value == 0:
            selected.t_value = Decimal("1")
        elif selected.position_qty == 0 and selected.t_value != 0:
            # Full exit (take-profit/quarter-sell emptied the position) ends
            # the cycle; the next build_plan() call starts a brand-new entry
            # LOC buy regardless of t_value, but t_value itself must go back
            # to 0 here or it keeps showing the old cycle's progress forever.
            selected.t_value = Decimal("0")
        self.store.save(selected)

        selected_price = _find_decimal(price_rows.get(symbol, {}), ("lastPrice", "price", "currentPrice"))
        previous = selected_previous_close if selected_previous_close is not None else selected_price
        result = self.dashboard(selected, selected_price, previous, holdings, plan_date=plan_date)
        result["api_connected"] = True
        result["broker_mode"] = broker.mode
        return result


__all__ = ["WebService", "InvalidOperation"]
