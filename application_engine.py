"""Single process owner for Mumae state, broker access, and trading commands."""
from __future__ import annotations

import os
import threading
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from audit_log import AuditLog
from mumae_core import ETF_UNIVERSE, normalize_down_ladder_levels
from runtime_store import normalize_delay_minutes
from secure_credentials import SecureCredentialStore, TossCredentials
from toss_api import TossBroker
from web_gui.web_service import _json_value
from web_gui.trading_service import TradingWebService


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
        if not isinstance(raw_levels, list) or not raw_levels:
            raise ValueError("levels는 1개 이상의 정수 배열이어야 합니다.")
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
        if command == "auto.start":
            return self.start_auto(symbol, str(payload.get("confirmation") or ""))
        if command == "auto.stop":
            return self.stop_auto(symbol)
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
