"""Single process owner for Mumae state, broker access, and trading commands."""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from dataclasses import asdict
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from audit_log import AuditLog
from market_quote import (
    KOREA, US_EASTERN, DayQuote, fetch_krx_regular_close, fetch_unadjusted_daily_candles,
    resolve_day_quote, with_previous_close,
)
from mumae_core import ETF_UNIVERSE, normalize_down_ladder_levels
from runtime_store import get_strategy_type, normalize_delay_minutes
from secure_credentials import SecureCredentialStore, TossCredentials
from toss_api import TossBroker
from web_gui.web_service import _collect_symbol_rows, _find_decimal, _json_value, is_domestic_kr_code
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
_QUANTITY_KEYS = ("quantity", "holdingQuantity", "holdingQty", "availableQuantity", "sellableQuantity")
_NAME_KEYS = ("name", "stockName", "symbolName", "koreanName", "productName")

REAL_INDEX_SYMBOLS: tuple[tuple[str, str], ...] = (
    ("KOSPI", "코스피"),
)
INDEX_PROXIES: tuple[tuple[str, str], ...] = (
    ("QQQ", "나스닥 100"),
    ("SPY", "S&P 500"),
    ("SOXX", "필라델피아 반도체"),
)


def fetch_btc_quote_from_binance() -> dict[str, str] | None:
    """Best-effort live BTC/USDT quote. Toss's API has no crypto price feed
    at all (see REAL_INDEX_SYMBOLS above), so this is the one index-strip
    entry that reaches an external source instead of Toss. Returns None on
    any network/parse failure so a flaky external call never breaks the
    rest of the dashboard."""
    try:
        with urllib.request.urlopen(
            "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT", timeout=5
        ) as response:
            payload = json.loads(response.read())
        return {"price": payload["lastPrice"], "day_change_pct": payload["priceChangePercent"]}
    except (OSError, ValueError, KeyError):
        return None


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
        btc_quote_fetcher: Callable[[], dict[str, str] | None] = fetch_btc_quote_from_binance,
    ) -> None:
        self.command_lock = threading.RLock()
        super().__init__(data_dir, broker_factory=broker_factory)
        self.audit = AuditLog(self.data_dir / "audit.jsonl")
        self.btc_quote_fetcher = btc_quote_fetcher
        # (symbol, session date) -> KRX regular-session close. A finished
        # session's close never changes, so each is fetched at most once.
        self._krx_close_cache: dict[tuple[str, date], Decimal] = {}

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
        """Return the latest engine-owned state without contacting the
        broker. Deliberately does not call resolve_plan_date (that needs a
        market-calendar broker call) -- instead just rolls a weekend
        calendar date forward to the following Monday (weekday()>=5), a
        local, broker-free approximation that fixes the common weekend case
        without covering US market holidays. Good enough for a preview that
        never itself submits anything (only account.refresh/auto_tick do,
        both correctly session-gated already)."""
        symbol = symbol.upper()
        state = self.load_state(symbol)
        current: Decimal | None = None
        previous: Decimal | None = None
        if symbol in self.quote_cache:
            current, previous = self.quote_cache[symbol]
        plan_date = date.today()
        if plan_date.weekday() >= 5:  # Saturday=5, Sunday=6
            plan_date += timedelta(days=7 - plan_date.weekday())
        return self.dashboard(state, current, previous, plan_date=plan_date)

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
        is_proxy=True -- see REAL_INDEX_SYMBOLS/INDEX_PROXIES. 비트코인 is a
        live external quote (Binance; Toss has no crypto feed) shown last,
        rightmost in the strip. Read-only; never touches strategy state."""
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
                "currency": "USD",
                "price": str(resolved.current_price),
                "day_change_pct": str(resolved.day_change_pct) if resolved.day_change_pct is not None else None,
            })

        btc_quote = self.btc_quote_fetcher()
        if btc_quote is not None:
            results.append({
                "symbol": "BTC",
                "label": "비트코인",
                "is_proxy": False,
                "currency": "USD",
                "price": btc_quote["price"],
                "day_change_pct": btc_quote["day_change_pct"],
            })
        return results

    def overseas_holdings(self) -> list[dict[str, Any]]:
        """Every overseas Toss holding, not just the bot-managed ETF_UNIVERSE
        tickers -- lets the dashboard show the account's other overseas
        securities (bought manually, outside the bot) with the same columns
        as the main holdings table, minus the bot-only T/strategy fields.
        Read-only; never touches strategy state."""
        return self._account_holdings(domestic=False)

    def domestic_holdings(self) -> list[dict[str, Any]]:
        """Same as overseas_holdings() but for KRX-listed holdings (KRW
        prices). Display only -- the bot never trades these."""
        return self._account_holdings(domestic=True)

    def _rebase_on_krx_regular_close(self, broker: Any, ticker: str, resolved: DayQuote) -> DayQuote:
        """Naver/HTS measure the day change against the 15:30 regular-session
        close, but Toss's daily candle close includes the Nextrade after-market
        (until 20:00). Swap in the regular close; keep the daily-candle value
        if it can't be fetched."""
        if resolved.previous_session_date is None:
            return resolved
        key = (ticker, resolved.previous_session_date)
        regular = self._krx_close_cache.get(key)
        if regular is None:
            regular = fetch_krx_regular_close(broker, ticker, resolved.previous_session_date)
            if regular is None:
                return resolved
            self._krx_close_cache[key] = regular
        return with_previous_close(resolved, regular)

    def _account_holdings(self, *, domestic: bool) -> list[dict[str, Any]]:
        broker = self.broker()
        holding_rows = _collect_symbol_rows(broker.get_holdings_raw())
        symbols = sorted(
            ticker
            for ticker, row in holding_rows.items()
            if is_domestic_kr_code(ticker) == domestic
            and _find_decimal(row, _QUANTITY_KEYS) > 0
        )
        if not symbols:
            return []
        price_rows = _collect_symbol_rows(broker.get_prices_raw(symbols))
        results: list[dict[str, Any]] = []
        for ticker in symbols:
            row = holding_rows[ticker]
            quote = price_rows.get(ticker, {})
            quantity = _find_decimal(row, _QUANTITY_KEYS)
            average = _find_decimal(row, ("averagePrice", "avgPrice", "averagePurchasePrice", "purchaseAveragePrice", "averageCost"))
            candles = fetch_unadjusted_daily_candles(broker, ticker)
            # Defensive pacing between per-symbol candle calls -- kept short
            # rather than removed since Toss's exact rate limit isn't
            # documented; _request()'s own 429 backoff is the real safety net.
            time.sleep(0.1)
            resolved = resolve_day_quote(quote, candles, KOREA if domestic else US_EASTERN)
            if domestic:
                resolved = self._rebase_on_krx_regular_close(broker, ticker, resolved)
            price = resolved.current_price
            value = quantity * price
            cost = quantity * average
            pnl = value - cost
            item: dict[str, Any] = {
                "symbol": ticker,
                "quantity": quantity,
                "average_price": average,
                "current_price": price,
                "day_change_pct": resolved.day_change_pct,
                "total_value": value,
                "pnl": pnl,
                "pnl_pct": pnl / cost * 100 if cost else Decimal("0"),
            }
            if domestic:
                # Alphanumeric KRX codes (0126Z0) are unreadable on their own,
                # so pass the product name along when Toss supplies one.
                name = next((str(row[key]) for key in _NAME_KEYS if row.get(key)), "")
                if name:
                    item["name"] = name
            results.append(_json_value(item))
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

    def _vr_reset(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_settings_gate("vr.reset")
        symbol = str(payload.get("symbol", "")).upper()
        return self.vr_reset(symbol)

    def _vr_cancel_all_orders(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_settings_gate("vr.cancel_all_orders")
        symbol = str(payload.get("symbol", "")).upper()
        return self.vr_cancel_all_orders(symbol)

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
        if command == "vr.reset":
            return self._vr_reset(payload)
        if command == "vr.cancel_all_orders":
            return self._vr_cancel_all_orders(payload)
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
        if command == "account.overseas_holdings":
            return {"holdings": self.overseas_holdings()}
        if command == "account.domestic_holdings":
            return {"holdings": self.domestic_holdings()}
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
