"""Single process owner for Mumae state, broker access, and trading commands."""
from __future__ import annotations

import os
import threading
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from audit_log import AuditLog
from market_quote import fetch_unadjusted_daily_candles, resolve_day_quote
from mumae_core import ETF_UNIVERSE, normalize_down_ladder_levels
from runtime_store import get_strategy_type, normalize_delay_minutes
from secure_credentials import SecureCredentialStore, TossCredentials
from toss_api import TossBroker
from web_gui.web_service import _collect_symbol_rows, _json_value
from web_gui.trading_service import TradingWebService

# Real index-level data exists only for domestic (KR) indices, via Toss's
# separate "Market Indicators" endpoint group (/api/v1/market-indicators/...,
# verified against the live official OpenAPI spec). Its symbol catalog is
# exactly {KOSPI, KOSDAQ, KR_BOND_2Y..30Y} -- no US indices are in it, and
# there is no other official raw index-level feed anywhere in this API for
# NASDAQ/S&P 500/semiconductor indices, only tradable US stock/ETF quotes.
# Those three are therefore shown via their most common tracking ETF and
# explicitly flagged is_proxy=True rather than presented as the literal
# index value.
REAL_INDEX_SYMBOLS: tuple[tuple[str, str], ...] = (
    ("KOSPI", "코스피"),
)
INDEX_PROXIES: tuple[tuple[str, str], ...] = (
    ("QQQ", "나스닥 100"),
    ("SPY", "S&P 500"),
    ("SOXX", "필라델피아 반도체"),
)


class LiveActionsRequiredError(PermissionError):
    """A settings-changing command needs the live-actions gate but it is off.

    Distinct from PermissionError's other uses (login/CSRF/DRY_RUN broker
    checks) so the HTTP layer can map it to 403 instead of 401.
    """


class ApplicationEngine(TradingWebService):
    """Headless application boundary shared by CLI and emergency GUIs."""

    def __init__(
        self,
        data_dir: str | Path,
        broker_factory: Callable[[], TossBroker] = TossBroker,
    ) -> None:
        self.command_lock = threading.RLock()
        super().__init__(data_dir, broker_factory=broker_factory)
        self.audit = AuditLog(self.data_dir / "audit.jsonl")

    def _stored_credentials(self) -> TossCredentials | None:
        if os.name == "nt":
            try:
                return SecureCredentialStore(
                    self.data_dir / "secure_credentials.dat"
                ).load()
            except (AttributeError, OSError, ValueError):
                return None
        required = ("TOSS_CLIENT_ID", "TOSS_CLIENT_SECRET", "TOSS_ACCOUNT_SEQ")
        if all(os.environ.get(name) for name in required):
            return TossCredentials(
                os.environ["TOSS_CLIENT_ID"],
                os.environ["TOSS_CLIENT_SECRET"],
                os.environ["TOSS_ACCOUNT_SEQ"],
                os.environ.get("MUMAE_MODE", "DRY_RUN").upper() == "LIVE",
            )
        path = self.data_dir / "toss.env"
        if not path.exists():
            return None
        values: dict[str, str] = {}
        for raw in path.read_text(encoding="utf-8").splitlines():
            if "=" in raw and not raw.lstrip().startswith("#"):
                name, value = raw.split("=", 1)
                values[name.strip()] = value.strip()
        if not all(values.get(name) for name in required):
            return None
        return TossCredentials(
            values["TOSS_CLIENT_ID"],
            values["TOSS_CLIENT_SECRET"],
            values["TOSS_ACCOUNT_SEQ"],
            values.get("MUMAE_MODE", "DRY_RUN").upper() == "LIVE",
        )

    @staticmethod
    def _configure_broker(
        broker: TossBroker,
        credentials: TossCredentials,
    ) -> TossBroker:
        broker.client_id = credentials.client_id
        broker.client_secret = credentials.client_secret
        broker.account_seq = credentials.account_seq
        broker.mode = "LIVE" if credentials.live_trading else "DRY_RUN"
        broker.live_ack = credentials.live_trading
        return broker

    def broker(self) -> TossBroker:
        if self._broker is None:
            candidate = self.broker_factory()
            credentials = self._stored_credentials()
            self._broker = (
                self._configure_broker(candidate, credentials)
                if credentials is not None
                else candidate
            )
        return self._broker

    def reconnect_broker(self) -> TossBroker:
        self._broker = None
        return self.broker()

    def auto_tick(self) -> None:
        with self.command_lock:
            super().auto_tick()

    def _save_credentials(self, credentials: TossCredentials) -> None:
        if os.name == "nt":
            SecureCredentialStore(
                self.data_dir / "secure_credentials.dat"
            ).save(credentials)
            return
        target = self.data_dir / "toss.env"
        temporary = self.data_dir / "toss.env.tmp"
        text = (
            f"TOSS_CLIENT_ID={credentials.client_id}\n"
            f"TOSS_CLIENT_SECRET={credentials.client_secret}\n"
            f"TOSS_ACCOUNT_SEQ={credentials.account_seq}\n"
            f"MUMAE_MODE={'LIVE' if credentials.live_trading else 'DRY_RUN'}\n"
        )
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.replace(temporary, target)

    def _api_settings(self) -> dict[str, Any]:
        credentials = self._stored_credentials()
        if credentials is None:
            return {
                "configured": False,
                "client_id": "",
                "account_seq": "",
                "live_trading": False,
                "secret_configured": False,
            }
        return {
            "configured": True,
            "client_id": credentials.client_id,
            "account_seq": credentials.account_seq,
            "live_trading": credentials.live_trading,
            "secret_configured": bool(credentials.client_secret),
        }

    def _api_update(self, payload: dict[str, Any]) -> dict[str, Any]:
        stored = self._stored_credentials()
        supplied_secret = str(payload.get("client_secret") or "").strip()
        credentials = TossCredentials(
            str(payload.get("client_id") or "").strip(),
            supplied_secret or (stored.client_secret if stored is not None else ""),
            str(payload.get("account_seq") or "").strip(),
            bool(payload.get("live_trading", False)),
        )
        if not credentials.client_id or not credentials.client_secret or not credentials.account_seq:
            raise ValueError("Client ID, Secret Key, 계좌 순번을 모두 입력하세요.")
        candidate = self._configure_broker(self.broker_factory(), credentials)
        candidate.list_accounts()
        self._save_credentials(credentials)
        self._broker = candidate
        return {
            "api_connected": True,
            "broker_mode": candidate.mode,
            "account_seq": credentials.account_seq,
            "settings": self._api_settings(),
        }

    def snapshot(self, symbol: str) -> dict[str, Any]:
        """Return the latest engine-owned state without contacting the broker."""
        symbol = symbol.upper()
        state = self.load_state(symbol)
        current: Decimal | None = None
        previous: Decimal | None = None
        if symbol in self.quote_cache:
            current, previous = self.quote_cache[symbol]
        return self.dashboard(state, current, previous)

    def audit_entries(self) -> list[dict[str, Any]]:
        return self.audit.entries()

    def _require_settings_gate(self, command: str) -> None:
        """DRY_RUN: settings changes are always allowed (nothing can reach a
        real broker). LIVE: also requires the same MUMAE_WEB_LIVE_ACTIONS
        gate used for order submission, so a stray settings edit cannot be
        made against a live account without the operator's explicit ack."""
        if self.broker().mode != "LIVE":
            return
        if os.environ.get("MUMAE_WEB_LIVE_ACTIONS", "") != "I_UNDERSTAND_WEB_LIVE_TRADING":
            raise LiveActionsRequiredError(
                f"{command}: LIVE 모드에서는 MUMAE_WEB_LIVE_ACTIONS 실주문 허용값이 필요합니다."
            )

    def _set_ladder_levels(self, payload: dict[str, Any]) -> dict[str, Any]:
        symbol = str(payload.get("symbol", "")).upper()
        self._require_settings_gate("strategy.set_ladder_levels")
        raw_levels = payload.get("levels")
        if not isinstance(raw_levels, list):
            raise ValueError("levels는 정수 배열이어야 합니다.")
        state = self.load_state(symbol)
        before = list(state.down_ladder_enabled_levels)
        after = normalize_down_ladder_levels(raw_levels, strict=True)
        state.down_ladder_enabled_levels = after
        state.validate()
        self.store.save(state)
        # Enrich the caller's payload so execute()'s audit.record() below
        # captures before/after alongside the existing symbol/timestamp fields.
        payload["before"] = before
        payload["after"] = after
        current, previous = self.quote_cache.get(symbol, (None, None))
        return self.dashboard(state, current, previous)

    def _update_schedule(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_settings_gate("schedule.update")
        before = self.runtime.auto_order_delay_minutes
        after = normalize_delay_minutes(payload.get("delay_minutes"))
        self.runtime.auto_order_delay_minutes = after
        self.runtime_store.save(self.runtime)
        payload["before"] = before
        payload["after"] = after
        return {"auto_order_delay_minutes": after}

    def market_indices(self) -> list[dict[str, Any]]:
        """Top-of-dashboard index strip. 코스피 is a real index value (Toss's
        Market Indicators endpoint); 나스닥100/S&P500/반도체 have no official
        raw index feed and are shown via their tracking ETF, flagged
        is_proxy=True -- see REAL_INDEX_SYMBOLS/INDEX_PROXIES. Read-only;
        never touches strategy state."""
        broker = self.broker()
        results: list[dict[str, Any]] = []

        real_symbols = [symbol for symbol, _ in REAL_INDEX_SYMBOLS]
        if real_symbols:
            price_rows = {
                row.get("symbol"): row
                for row in broker.get_market_indicator_prices_raw(real_symbols).get("result", [])
            }
            for symbol, label in REAL_INDEX_SYMBOLS:
                quote = price_rows.get(symbol, {})
                candles = broker.get_market_indicator_candles_raw(symbol, interval="1d", count=5).get("result", {}).get("candles", [])
                resolved = resolve_day_quote(quote, candles)
                results.append({
                    "symbol": symbol,
                    "label": label,
                    "is_proxy": False,
                    "price": str(resolved.current_price),
                    "day_change_pct": str(resolved.day_change_pct) if resolved.day_change_pct is not None else None,
                })

        proxy_symbols = [symbol for symbol, _ in INDEX_PROXIES]
        proxy_price_rows = _collect_symbol_rows(broker.get_prices_raw(proxy_symbols))
        for symbol, label in INDEX_PROXIES:
            quote = proxy_price_rows.get(symbol, {})
            candles = fetch_unadjusted_daily_candles(broker, symbol)
            resolved = resolve_day_quote(quote, candles)
            results.append({
                "symbol": symbol,
                "label": label,
                "is_proxy": True,
                "price": str(resolved.current_price),
                "day_change_pct": str(resolved.day_change_pct) if resolved.day_change_pct is not None else None,
            })
        return results

    def etf_overview(self) -> list[dict[str, Any]]:
        """Per-ETF status row for the web GUI table: run state, last new-order
        attempt/error, open order count, and Down Ladder level selection."""
        return [
            {
                "symbol": symbol,
                "running": symbol in self.runtime.active_symbols,
                "last_order_at": self.runtime.last_auto_attempt_at.get(symbol, ""),
                "last_error": self.runtime.last_auto_error.get(symbol, ""),
                "pending_orders": self.pending_order_count(symbol),
                "down_ladder_enabled_levels": self.load_state(symbol).down_ladder_enabled_levels,
                "strategy_type": get_strategy_type(self.runtime, symbol),
            }
            for symbol in ETF_UNIVERSE
        ]

    def _strategy_update(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = self.update_state(payload)
        current: Decimal | None = None
        previous: Decimal | None = None
        if state.symbol in self.quote_cache:
            current, previous = self.quote_cache[state.symbol]
        return self.dashboard(state, current, previous)

    @staticmethod
    def _optional_decimal(payload: dict[str, Any], key: str) -> Decimal | None:
        value = payload.get(key)
        return None if value in (None, "") else Decimal(str(value))

    def _vr_initialize(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_settings_gate("vr.initialize")
        symbol = str(payload.get("symbol", "")).upper()
        initial_pool = Decimal(str(payload.get("initial_pool", "0")))
        G = Decimal(str(payload.get("G", "10")))
        band_pct = Decimal(str(payload.get("band_pct", "15")))
        pool_usage_limit_pct = self._optional_decimal(payload, "pool_usage_limit_pct")
        recurring_contribution = self._optional_decimal(payload, "recurring_contribution")
        kwargs = {}
        if pool_usage_limit_pct is not None:
            kwargs["pool_usage_limit_pct"] = pool_usage_limit_pct
        if recurring_contribution is not None:
            kwargs["recurring_contribution"] = recurring_contribution
        return self.vr_initialize(symbol, initial_pool, G, band_pct, **kwargs)

    def _vr_schedule_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_settings_gate("vr.schedule_config")
        symbol = str(payload.get("symbol", "")).upper()
        return self.vr_schedule_config(
            symbol,
            G=self._optional_decimal(payload, "G"),
            band_pct=self._optional_decimal(payload, "band_pct"),
            pool_adjustment=self._optional_decimal(payload, "pool_adjustment"),
            pool_usage_limit_pct=self._optional_decimal(payload, "pool_usage_limit_pct"),
            recurring_contribution=self._optional_decimal(payload, "recurring_contribution"),
        )

    def _vr_cancel_pending_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_settings_gate("vr.cancel_pending_config")
        symbol = str(payload.get("symbol", "")).upper()
        return self.vr_cancel_pending_config(
            symbol,
            G=bool(payload.get("G", False)),
            band_pct=bool(payload.get("band_pct", False)),
            pool_adjustment=bool(payload.get("pool_adjustment", False)),
            pool_usage_limit_pct=bool(payload.get("pool_usage_limit_pct", False)),
            recurring_contribution=bool(payload.get("recurring_contribution", False)),
            all=bool(payload.get("all", False)),
        )

    def _strategy_set_type(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_settings_gate("strategy.set_type")
        symbol = str(payload.get("symbol", "")).upper()
        strategy_type = str(payload.get("strategy_type", "")).upper()
        return self.vr_set_strategy_type(symbol, strategy_type)

    def _dispatch(self, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        symbol = str(payload.get("symbol", "")).upper()
        if symbol and symbol not in ETF_UNIVERSE:
            raise ValueError("지원하지 않는 ETF입니다.")
        if command == "strategy.update":
            return self._strategy_update(payload)
        if command == "account.refresh":
            return self.refresh_account(symbol or "TQQQ")
        if command == "plan.calculate":
            return self.plan(payload)
        if command == "orders.sync":
            return self.sync_orders(symbol or "TQQQ")
        if command == "history.refresh":
            return self.trade_history(symbol or "TQQQ", str(payload.get("start_date")))
        if command == "history.cumulative_realized_pnl":
            return self.cumulative_realized_pnl(payload.get("start_date") or None)
        if command == "analysis.long_term":
            return self.analyze_long_term()
        if command == "analysis.pairs":
            return self.analyze_pairs()
        if command == "order.edit_price":
            return self.edit_failed_price(symbol, str(payload.get("id")), payload.get("price"))
        if command == "order.submit":
            return self.submit_orders(
                symbol,
                list(payload.get("ids") or []),
                str(payload.get("confirmation") or ""),
            )
        if command == "order.cancel":
            return self.cancel_orders(
                symbol,
                list(payload.get("ids") or []),
                str(payload.get("confirmation") or ""),
            )
        if command == "order.reregister":
            return self.reregister_order(
                symbol,
                str(payload.get("original_id") or ""),
                payload.get("quantity"),
                payload.get("price"),
                str(payload.get("memo") or ""),
                str(payload.get("confirmation") or ""),
                confirm_over_remaining=bool(payload.get("confirm_over_remaining")),
            )
        if command == "order.retry_failed":
            return self.retry_failed_order(str(payload.get("client_order_id") or ""))
        if command == "order.retry_failed_price":
            return self.retry_failed_order_with_price(
                str(payload.get("client_order_id") or ""),
                payload.get("price"),
            )
        if command == "order.retry_failed_quantity":
            return self.retry_failed_order_with_quantity(
                str(payload.get("client_order_id") or ""),
                payload.get("quantity"),
            )
        if command == "auto.start":
            return self.start_auto(symbol, str(payload.get("confirmation") or ""))
        if command == "auto.stop":
            return self.stop_auto(symbol)
        if command == "runtime.clear_error":
            return self.clear_last_error(symbol)
        if command == "strategy.set_ladder_levels":
            return self._set_ladder_levels(payload)
        if command == "schedule.update":
            return self._update_schedule(payload)
        if command == "api.reconnect":
            broker = self.reconnect_broker()
            broker.list_accounts()
            return {"api_connected": True, "broker_mode": broker.mode}
        if command == "api.update":
            return self._api_update(payload)
        if command == "api.settings":
            return self._api_settings()
        if command == "vr.initialize":
            return self._vr_initialize(payload)
        if command == "vr.start":
            return self.vr_start(symbol)
        if command == "vr.stop":
            return self.vr_stop(symbol)
        if command == "vr.schedule_config":
            return self._vr_schedule_config(payload)
        if command == "vr.cancel_pending_config":
            return self._vr_cancel_pending_config(payload)
        if command == "vr.refresh":
            return self.vr_refresh_account(symbol)
        if command == "vr.sync":
            return self.vr_sync_orders(symbol)
        if command == "vr.snapshot":
            return self.vr_snapshot(symbol)
        if command == "market.indices":
            return {"indices": self.market_indices()}
        if command == "strategy.set_type":
            return self._strategy_set_type(payload)
        raise ValueError(f"지원하지 않는 엔진 명령입니다: {command}")

    def execute(
        self,
        command: str,
        payload: dict[str, Any],
        *,
        source: str,
        actor: str,
    ) -> dict[str, Any]:
        with self.command_lock:
            try:
                result = self._dispatch(command, payload)
            except Exception as error:
                self.audit.record(source, actor, command, payload, False, str(error))
                raise
            self.audit.record(source, actor, command, payload, True, "")
            return _json_value(result if isinstance(result, dict) else asdict(result))


__all__ = ["ApplicationEngine"]
