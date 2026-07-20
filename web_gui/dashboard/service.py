"""Account dashboard service backed by the Windows application's data files."""
from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from application_engine import ApplicationEngine
from mumae_core import ETF_UNIVERSE, Mode, StrategyState, build_plan
from runtime_store import RuntimeStore
from secure_credentials import SecureCredentialStore, TossCredentials
from state_store import StateStore
from toss_api import TossApiError, TossBroker


def _decimal(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value))


def _json(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mode):
        return value.value
    if isinstance(value, dict):
        return {str(key): _json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json(item) for item in value]
    return value


def _rows(value: Any) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    if isinstance(value, dict):
        symbol = value.get("symbol") or value.get("ticker")
        if symbol:
            found[str(symbol).upper()] = value
        for item in value.values():
            found.update(_rows(item))
    elif isinstance(value, list):
        for item in value:
            found.update(_rows(item))
    return found


def _number(row: dict[str, Any], *names: str) -> Decimal:
    for name in names:
        if row.get(name) not in (None, ""):
            return _decimal(row[name])
    return Decimal("0")


def _masked(value: str) -> str:
    if len(value) <= 4:
        return "*" * len(value)
    return "*" * max(4, len(value) - 4) + value[-4:]


class DashboardService:
    """Reads and updates the exact data directory used by the Windows GUI."""

    def __init__(
        self,
        data_dir: str | Path,
        broker_factory: Callable[[], TossBroker] = TossBroker,
        credentials_loader: Callable[[], TossCredentials | None] | None = None,
    ) -> None:
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.state_store = StateStore(self.data_dir / "state.json")
        self.runtime_store = RuntimeStore(self.data_dir / "runtime.json")
        self.broker_factory = broker_factory
        self.credentials_loader = credentials_loader or self._load_credentials
        self.lock = threading.RLock()

    def _load_credentials(self) -> TossCredentials | None:
        if os.name == "nt":
            try:
                return SecureCredentialStore(self.data_dir / "secure_credentials.dat").load()
            except (AttributeError, OSError, ValueError, json.JSONDecodeError):
                return None
        path = self.data_dir / "toss.env"
        if not path.exists():
            return None
        values: dict[str, str] = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip()
        required = ("TOSS_CLIENT_ID", "TOSS_CLIENT_SECRET", "TOSS_ACCOUNT_SEQ")
        if not all(values.get(key) for key in required):
            return None
        return TossCredentials(
            values["TOSS_CLIENT_ID"],
            values["TOSS_CLIENT_SECRET"],
            values["TOSS_ACCOUNT_SEQ"],
            values.get("MUMAE_MODE", "DRY_RUN").upper() == "LIVE",
        )

    def _credentials(self) -> TossCredentials:
        credentials = self.credentials_loader()
        if credentials is None:
            raise TossApiError(
                f"Windows 데이터 폴더에서 토스 API 설정을 찾지 못했습니다: {self.data_dir}"
            )
        return credentials

    def _broker(self) -> TossBroker:
        credentials = self._credentials()
        broker = self.broker_factory()
        broker.client_id = credentials.client_id
        broker.client_secret = credentials.client_secret
        broker.account_seq = credentials.account_seq
        broker.mode = "LIVE" if credentials.live_trading else "DRY_RUN"
        broker.live_ack = credentials.live_trading
        return broker

    def settings(self) -> dict[str, Any]:
        credentials = self.credentials_loader()
        return {
            "configured": credentials is not None,
            "client_id": _masked(credentials.client_id) if credentials else "",
            "account_seq": credentials.account_seq if credentials else "",
            "mode": "LIVE" if credentials and credentials.live_trading else "DRY_RUN",
            "data_dir": str(self.data_dir),
        }

    def _state(self, symbol: str) -> dict[str, Any]:
        return _json(asdict(self.state_store.load(symbol)))

    @staticmethod
    def _daily_plan(state: StrategyState, current_price: Decimal, previous_close: Decimal) -> tuple[list[dict[str, Any]], list[str]]:
        if current_price <= 0:
            return [], []
        plan = build_plan(state, current_price, previous_close=previous_close or current_price)
        orders = [
            {
                "id": order.client_order_id,
                "side": order.side,
                "quantity": order.quantity,
                "price": str(order.limit_price) if order.limit_price is not None else None,
                "kind": order.kind.value,
                "reason": order.reason,
                "status": "PLANNED",
                "broker_only": False,
            }
            for order in plan.orders
        ]
        return orders, list(plan.warnings)
    @staticmethod
    def _order_match_key(side: Any, quantity: Any, price: Any) -> tuple[str, int, Decimal]:
        return (
            str(side or "").upper(),
            int(_decimal(quantity)),
            _decimal(price).quantize(Decimal("0.01")),
        )

    def _sync_order_statuses(
        self,
        broker: TossBroker,
        symbol: str,
        planned: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], bool, str]:
        today = date.today()
        rows: list[dict[str, Any]] = []
        open_rows: dict[str, dict[str, Any]] = {}
        try:
            for group in ("CLOSED", "OPEN"):
                fetched = broker.get_all_orders_raw(
                    group, symbol, (today - timedelta(days=7)).isoformat(), today.isoformat()
                )
                rows.extend(fetched)
                if group == "OPEN":
                    for row in fetched:
                        order_id = str(row.get("orderId") or "")
                        if order_id:
                            open_rows[order_id] = row
        except (TossApiError, ValueError, OSError) as error:
            return planned, False, str(error)

        runtime = self.runtime_store.load()
        unused = set(range(len(rows)))
        synced: list[dict[str, Any]] = []
        for order in planned:
            actual_id = runtime.broker_order_ids.get(str(order["id"]))
            match = next(
                (index for index in reversed(range(len(rows)))
                 if index in unused and actual_id and str(rows[index].get("orderId") or "") == actual_id),
                None,
            )
            if match is None:
                expected = self._order_match_key(order["side"], order["quantity"], order["price"])
                match = next(
                    (index for index in reversed(range(len(rows)))
                     if index in unused and self._order_match_key(
                         rows[index].get("side"), rows[index].get("quantity"), rows[index].get("price")
                     ) == expected),
                    None,
                )
            status = "PLANNED"
            if match is not None:
                unused.remove(match)
                record = rows[match]
                status = str(record.get("status") or "UNKNOWN").upper()
                open_rows.pop(str(record.get("orderId") or ""), None)
            elif order["id"] in runtime.skipped_order_ids:
                status = "SKIPPED"
            elif order["id"] in runtime.active_order_ids:
                status = "UNCONFIRMED"
            synced.append({**order, "status": status})

        for order_id, row in open_rows.items():
            synced.append({
                "id": "toss-open-" + order_id,
                "side": str(row.get("side") or "").lower(),
                "quantity": int(_decimal(row.get("quantity"))),
                "price": str(row.get("price") or "0"),
                "kind": str(row.get("orderType") or "TOSS"),
                "reason": "토스 실제 대기주문 · 현재 계획과 다름",
                "status": str(row.get("status") or "UNKNOWN").upper(),
                "broker_only": True,
            })
        return synced, True, ""
    def bootstrap(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        if symbol not in ETF_UNIVERSE:
            raise ValueError("지원하지 않는 ETF입니다.")
        alias_path = self.data_dir / "account_alias.txt"
        alias = alias_path.read_text(encoding="utf-8").strip() if alias_path.exists() else ""
        runtime = self.runtime_store.load()
        return {
            "settings": self.settings(),
            "account_alias": alias,
            "state": self._state(symbol),
            "runtime": {
                "auto_enabled": runtime.auto_enabled,
                "phase": runtime.phase,
                "active_symbols": runtime.active_symbols,
                "known_symbols": runtime.known_symbols,
                "auto_order_delay_minutes": runtime.auto_order_delay_minutes,
                "updated_at": runtime.updated_at,
            },
            "holdings": [],
            "quote": {"current_price": None, "previous_close": None},
            "metrics": {},
            "orders": [],
            "plan_warnings": [],
            "orders_synced": False,
            "order_status_error": "",
            "plan_status": {
                "auto_enabled": runtime.auto_enabled,
                "selected_active": runtime.auto_enabled and symbol in runtime.active_symbols,
                "active_symbols": runtime.active_symbols,
            },
            "api_connected": False,
        }

    def update_strategy(self, payload: dict[str, Any]) -> dict[str, Any]:
        symbol = str(payload.get("symbol") or "").upper()
        if symbol not in ETF_UNIVERSE:
            raise ValueError("지원하지 않는 ETF입니다.")
        with self.lock:
            state = self.state_store.load(symbol)
            quantity = _decimal(payload.get("position_qty", state.position_qty))
            if quantity != quantity.to_integral_value():
                raise ValueError("보유 수량은 정수여야 합니다.")
            state.position_qty = int(quantity)
            state.avg_cost = _decimal(payload.get("avg_cost", state.avg_cost))
            state.t_value = _decimal(payload.get("t_value", state.t_value))
            state.cash_usd = _decimal(payload.get("cash_usd", state.cash_usd))
            state.base_buy_qty = int(_decimal(payload.get("base_buy_qty", state.base_buy_qty)))
            state.big_number_pct = _decimal(payload.get("big_number_pct", state.big_number_pct))
            state.big_number_enabled = bool(payload.get("big_number_enabled", state.big_number_enabled))
            state.validate()
            self.state_store.save(state)
            result = self.bootstrap(symbol)
            result["state"] = _json(asdict(state))
            has_quote = payload.get("current_price") not in (None, "")
            current = _decimal(payload.get("current_price")) if has_quote else Decimal("0")
            previous = _decimal(payload.get("previous_close")) if payload.get("previous_close") not in (None, "") else current
            orders, warnings = self._daily_plan(state, current, previous)
            selected_value = current * state.position_qty
            result["quote"] = _json({"current_price": current if has_quote else None, "previous_close": previous if has_quote else None})
            result["metrics"] = _json({
                "cash": state.cash_usd,
                "selected_value": selected_value if has_quote else None,
                "selected_pnl": selected_value - state.avg_cost * state.position_qty if has_quote else None,
            })
            result["orders"] = orders
            result["plan_warnings"] = warnings
            result["updated"] = True
            return result

    def etf_overview(self) -> list[dict[str, Any]]:
        """No engine/broker access in this legacy read-only path, so pending
        order counts are not available here (always 0); run state and Down
        Ladder levels still reflect the shared data files."""
        runtime = self.runtime_store.load()
        return [
            {
                "symbol": symbol,
                "running": symbol in runtime.active_symbols,
                "last_order_at": runtime.last_auto_attempt_at.get(symbol, ""),
                "last_error": runtime.last_auto_error.get(symbol, ""),
                "pending_orders": 0,
                "down_ladder_enabled_levels": self.state_store.load(symbol).down_ladder_enabled_levels,
            }
            for symbol in ETF_UNIVERSE
        ]

    def refresh_account(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        if symbol not in ETF_UNIVERSE:
            raise ValueError("지원하지 않는 ETF입니다.")
        with self.lock:
            broker = self._broker()
            holding_rows = {
                ticker: row
                for ticker, row in _rows(broker.get_holdings_raw()).items()
                if ticker in ETF_UNIVERSE
            }
            symbols = sorted(set(holding_rows) | {symbol})
            price_rows = _rows(broker.get_prices_raw(symbols))
            buying_power = broker.get_buying_power_raw()
            candles = broker.get_daily_candles_raw(symbol, 2)
            cash = _decimal((buying_power.get("result") or {}).get("cashBuyingPower"))

            selected = self.state_store.load(symbol)
            holdings: list[dict[str, Any]] = []
            holdings_value = Decimal("0")
            for ticker in symbols:
                row = holding_rows.get(ticker, {})
                quote = price_rows.get(ticker, {})
                quantity = _number(
                    row,
                    "quantity",
                    "holdingQuantity",
                    "holdingQty",
                    "availableQuantity",
                    "sellableQuantity",
                )
                average = _number(
                    row,
                    "averagePrice",
                    "avgPrice",
                    "averagePurchasePrice",
                    "purchaseAveragePrice",
                    "averageCost",
                )
                price = _number(quote, "lastPrice", "price", "currentPrice")
                value = quantity * price
                cost = quantity * average
                pnl = value - cost
                holdings_value += value
                ticker_state = selected if ticker == symbol else self.state_store.load(ticker)
                holdings.append(_json({
                    "symbol": ticker,
                    "quantity": quantity,
                    "average_price": average,
                    "current_price": price,
                    "total_value": value,
                    "pnl": pnl,
                    "pnl_pct": pnl / cost * 100 if cost else Decimal("0"),
                    "t_value": ticker_state.t_value,
                }))
                if ticker == symbol:
                    selected.position_qty = int(quantity)
                    selected.avg_cost = average

            selected.cash_usd = cash
            if selected.position_qty > 0 and selected.t_value == 0:
                selected.t_value = Decimal("1")
            self.state_store.save(selected)

            selected_price = _number(price_rows.get(symbol, {}), "lastPrice", "price", "currentPrice")
            daily = (candles.get("result") or {}).get("candles") or []
            previous = _decimal(daily[1].get("closePrice")) if len(daily) > 1 else selected_price
            invested = selected.avg_cost * selected.position_qty
            selected_value = selected_price * selected.position_qty
            metrics = _json({
                "cash": cash,
                "holdings_value": holdings_value,
                "total_asset": cash + holdings_value,
                "selected_value": selected_value,
                "selected_pnl": selected_value - invested,
            })
            orders, plan_warnings = self._daily_plan(selected, selected_price, previous)
            orders, orders_synced, order_status_error = self._sync_order_statuses(broker, symbol, orders)
            runtime = self.runtime_store.load()
            return {
                **self.bootstrap(symbol),
                "state": _json(asdict(selected)),
                "holdings": holdings,
                "quote": _json({"current_price": selected_price, "previous_close": previous}),
                "metrics": metrics,
                "orders": orders,
                "plan_warnings": plan_warnings,
                "orders_synced": orders_synced,
                "order_status_error": order_status_error,
                "plan_status": {
                    "auto_enabled": runtime.auto_enabled,
                    "selected_active": runtime.auto_enabled and symbol in runtime.active_symbols,
                    "active_symbols": runtime.active_symbols,
                },
                "api_connected": True,
                "refreshed": True,
            }

class EngineDashboardService:
    """Dashboard facade that routes every mutation through one ApplicationEngine."""

    def __init__(self, engine: ApplicationEngine) -> None:
        self.engine = engine
        self.data_dir = engine.data_dir

    def _settings(self) -> dict[str, Any]:
        raw = self.engine._api_settings()
        return {
            "configured": bool(raw.get("configured")),
            "client_id": _masked(str(raw.get("client_id") or "")),
            "account_seq": str(raw.get("account_seq") or ""),
            "mode": "LIVE" if raw.get("live_trading") else "DRY_RUN",
            "data_dir": str(self.data_dir),
        }

    def _adapt(
        self,
        symbol: str,
        snapshot: dict[str, Any],
        *,
        orders: list[dict[str, Any]] | None = None,
        orders_synced: bool = False,
        order_status_error: str = "",
        api_connected: bool = False,
        updated: bool = False,
    ) -> dict[str, Any]:
        symbol = symbol.upper()
        runtime = self.engine.runtime_store.load()
        alias_path = self.data_dir / "account_alias.txt"
        alias = alias_path.read_text(encoding="utf-8").strip() if alias_path.exists() else ""
        source_metrics = snapshot.get("metrics") or {}
        state = snapshot.get("state") or {}
        planned = orders if orders is not None else [
            {**order, "status": order.get("status") or "PLANNED", "broker_only": bool(order.get("broker_only"))}
            for order in (snapshot.get("orders") or [])
        ]
        return {
            "settings": self._settings(),
            "account_alias": alias,
            "state": state,
            "runtime": {
                "auto_enabled": runtime.auto_enabled,
                "phase": runtime.phase,
                "active_symbols": runtime.active_symbols,
                "known_symbols": runtime.known_symbols,
                "auto_order_delay_minutes": runtime.auto_order_delay_minutes,
                "updated_at": runtime.updated_at,
            },
            "holdings": snapshot.get("holdings") or [],
            "quote": snapshot.get("quote") or {"current_price": None, "previous_close": None},
            "metrics": {
                **source_metrics,
                "cash": source_metrics.get("cash", state.get("cash_usd")),
                "selected_value": source_metrics.get("position_value"),
                "selected_pnl": source_metrics.get("unrealized_pnl"),
            },
            "orders": planned,
            "plan_warnings": snapshot.get("warnings") or [],
            "orders_synced": orders_synced,
            "order_status_error": order_status_error,
            "plan_status": {
                "auto_enabled": runtime.auto_enabled,
                "selected_active": runtime.auto_enabled and symbol in runtime.active_symbols,
                "active_symbols": runtime.active_symbols,
            },
            "api_connected": api_connected,
            "updated": updated,
        }

    def bootstrap(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        return self._adapt(symbol, self.engine.snapshot(symbol))

    def refresh_account(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        snapshot = self.engine.execute(
            "account.refresh", {"symbol": symbol}, source="WEB", actor="dashboard-session"
        )
        try:
            synced = self.engine.execute(
                "orders.sync", {"symbol": symbol}, source="WEB", actor="dashboard-session"
            )
            orders = list(synced.get("orders") or [])
            return self._adapt(
                symbol, snapshot, orders=orders, orders_synced=True, api_connected=True
            )
        except (TossApiError, ValueError, OSError) as error:
            return self._adapt(
                symbol, snapshot, order_status_error=str(error), api_connected=True
            )

    def update_strategy(self, payload: dict[str, Any]) -> dict[str, Any]:
        symbol = str(payload.get("symbol") or "").upper()
        snapshot = self.engine.execute(
            "strategy.update", payload, source="WEB", actor="dashboard-session"
        )
        if payload.get("current_price") not in (None, ""):
            snapshot = self.engine.execute(
                "plan.calculate", payload, source="WEB", actor="dashboard-session"
            )
        return self._adapt(symbol, snapshot, updated=True)

    def snapshot(self, symbol: str) -> dict[str, Any]:
        return self.engine.snapshot(symbol.upper())

    def etf_overview(self) -> list[dict[str, Any]]:
        return self.engine.etf_overview()

    def execute(self, command: str, payload: dict[str, Any], *, source: str, actor: str) -> dict[str, Any]:
        return self.engine.execute(command, payload, source=source, actor=actor)


__all__ = ["DashboardService", "EngineDashboardService"]
