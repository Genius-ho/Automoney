"""Toss Securities Open API connector for local planning and explicitly confirmed live orders."""
from __future__ import annotations

import gzip
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta
from dataclasses import dataclass
from decimal import Decimal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from local_env import load_env
from mumae_core import ETF_UNIVERSE, OrderIntent, OrderKind, StrategyState
from secure_credentials import SecureCredentialStore

BASE_URL = "https://openapi.tossinvest.com"
LIVE_ACKNOWLEDGEMENT = "I_UNDERSTAND_LIVE_TRADING"


def order_time_in_force(order: OrderIntent) -> str:
    """Return the broker time-in-force used for a strategy order.

    The final take-profit is a regular DAY limit sell; all other strategy
    orders, including buys and the quarter sell, remain LOC/CLS orders.
    Keeping this policy in one helper lets auto_tick schedule the two sell
    legs without drifting from the actual broker payload.
    """
    return "DAY" if order.reason.startswith("Final take-profit") else "CLS"


class TossApiError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        data: object | None = None,
        request_id: str | None = None,
    ) -> None:
        if status is None and message.startswith('Toss API HTTP '):
            prefix, separator, body = message.partition(': ')
            try:
                status = int(prefix.removeprefix('Toss API HTTP '))
            except ValueError:
                status = None
            if separator:
                try:
                    payload = json.loads(body).get('error', {})
                except json.JSONDecodeError:
                    payload = {}
                code = code or payload.get('code')
                data = data if data is not None else payload.get('data')
                request_id = request_id or payload.get('requestId')
                api_message = payload.get('message')
                if api_message:
                    message = f'Toss API HTTP {status} [{code}]: {api_message}'
                    if request_id:
                        message += f' (requestId: {request_id})'
        super().__init__(message)
        self.status = status
        self.code = code
        self.data = data
        self.request_id = request_id


@dataclass(frozen=True)
class AccountSnapshot:
    cash_usd: Decimal
    position_qty: int
    avg_cost: Decimal
    last_price: Decimal


class TossBroker:
    def __init__(self) -> None:
        load_env()
        self.client_id = os.getenv("TOSS_CLIENT_ID", "")
        self.client_secret = os.getenv("TOSS_CLIENT_SECRET", "")
        self.account_seq = os.getenv("TOSS_ACCOUNT_SEQ", "")
        secure = None
        if os.name == "nt":
            try:
                secure = SecureCredentialStore().load()
            except (AttributeError, OSError, ValueError, json.JSONDecodeError):
                secure = None
        if secure is not None:
            self.client_id = secure.client_id
            self.client_secret = secure.client_secret
            self.account_seq = secure.account_seq
        self.mode = ("LIVE" if secure.live_trading else "DRY_RUN") if secure is not None else os.getenv("MUMAE_MODE", "DRY_RUN").upper()
        self.live_ack = secure.live_trading if secure is not None else os.getenv("MUMAE_LIVE_TRADING_ACK") == LIVE_ACKNOWLEDGEMENT
        self._access_token: str | None = None
        self._token_expires_at = 0.0

    def _require_credentials(self) -> None:
        if not self.client_id or not self.client_secret:
            raise TossApiError("API 설정에서 Client ID와 Secret Key를 저장하세요.")

    def _token(self) -> str:
        if self._access_token and time.time() < self._token_expires_at - 30:
            return self._access_token
        self._require_credentials()
        data = urlencode({"grant_type": "client_credentials", "client_id": self.client_id, "client_secret": self.client_secret}).encode()
        payload = self._request("POST", "/oauth2/token", data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}, include_auth=False)
        token = payload.get("access_token")
        if not token:
            raise TossApiError("Token response did not contain access_token.")
        self._access_token = token
        self._token_expires_at = time.time() + int(payload.get("expires_in", 300))
        return token

    @staticmethod
    def _decode_body(raw: bytes, headers) -> str:
        """Undo gzip transport-encoding before decoding text.

        urllib (unlike requests) never auto-decompresses responses, so a
        gzip-compressed body decoded straight as UTF-8 turns into garbled
        text (and gets persisted that way into runtime.last_auto_error).
        """
        content_encoding = (headers.get("Content-Encoding") or "").lower() if headers else ""
        if content_encoding == "gzip":
            try:
                raw = gzip.decompress(raw)
            except OSError:
                pass
        return raw.decode("utf-8", errors="replace")

    def _request(self, method: str, path: str, data: bytes | None = None, headers: dict[str, str] | None = None, include_auth: bool = True) -> dict:
        request_headers = {"Accept": "application/json", **(headers or {})}
        if include_auth:
            request_headers["Authorization"] = f"Bearer {self._token()}"
        auth_retry_used = False
        for attempt in range(4):
            request = Request(f"{BASE_URL}{path}", data=data, method=method, headers=request_headers)
            try:
                with urlopen(request, timeout=15) as response:
                    return json.loads(self._decode_body(response.read(), response.headers))
            except HTTPError as error:
                try:
                    body = self._decode_body(error.read(), error.headers)
                finally:
                    error.close()
                if error.code == 401 and include_auth and not auth_retry_used:
                    try:
                        error_code = json.loads(body).get("error", {}).get("code")
                    except json.JSONDecodeError:
                        error_code = None
                    if error_code in {"invalid-token", "expired-token"}:
                        self._access_token = None
                        self._token_expires_at = 0.0
                        request_headers["Authorization"] = f"Bearer {self._token()}"
                        auth_retry_used = True
                        continue
                if error.code == 429 and attempt < 3:
                    retry_after = error.headers.get("Retry-After") if error.headers else None
                    delay = float(retry_after) if retry_after else float(2**attempt)
                    time.sleep(max(delay, 0.25))
                    continue
                raise TossApiError(f"Toss API HTTP {error.code}: {body}") from error
            except URLError as error:
                raise TossApiError(f"Cannot reach Toss API: {error.reason}") from error
        raise TossApiError("Toss API request retry limit exceeded.")
    def list_accounts(self) -> dict:
        return self._request("GET", "/api/v1/accounts")

    def _account_headers(self) -> dict[str, str]:
        if not self.account_seq:
            raise TossApiError("API 설정에서 계좌 순번을 저장하세요.")
        return {"X-Tossinvest-Account": self.account_seq}

    def get_holdings_raw(self) -> dict:
        return self._request("GET", "/api/v1/holdings", headers=self._account_headers())

    def get_buying_power_raw(self) -> dict:
        return self._request("GET", "/api/v1/buying-power?currency=USD", headers=self._account_headers())

    def get_orders_raw(self, status: str, symbol: str, from_date: str, to_date: str, cursor: str | None = None) -> dict:
        params = {"status": status, "symbol": symbol, "from": from_date, "to": to_date, "limit": 100}
        if cursor:
            params["cursor"] = cursor
        query = urlencode(params)
        return self._request("GET", "/api/v1/orders?" + query, headers=self._account_headers())

    def get_all_orders_raw(self, status: str, symbol: str, from_date: str, to_date: str) -> list[dict]:
        orders: list[dict] = []
        cursor = None
        while True:
            payload = self.get_orders_raw(status, symbol, from_date, to_date, cursor)
            result = payload.get("result", {})
            orders.extend(result.get("orders", []))
            cursor = result.get("nextCursor")
            if not result.get("hasNext") or not cursor:
                return orders

    def get_prices_raw(self, symbols: list[str]) -> dict:
        if not symbols:
            return {"result": []}
        return self._request("GET", "/api/v1/prices?symbols=" + ",".join(symbols))

    def get_price_limits_raw(self, symbol: str) -> dict:
        return self._request('GET', '/api/v1/price-limits?' + urlencode({'symbol': symbol}))

    def get_daily_candles_raw(self, symbol: str, count: int = 2, before: str | None = None) -> dict:
        params: dict[str, str | int] = {"symbol": symbol, "interval": "1d", "count": count, "adjusted": "true"}
        if before:
            params["before"] = before
        return self._request("GET", "/api/v1/candles?" + urlencode(params))

    def get_minute_candles_raw(self, symbol: str, count: int = 200, before: str | None = None) -> dict:
        params: dict[str, str | int] = {"symbol": symbol, "interval": "1m", "count": count, "adjusted": "true"}
        if before:
            params["before"] = before
        return self._request("GET", "/api/v1/candles?" + urlencode(params))

    def get_us_market_calendar_raw(self, date_value: str | None = None) -> dict:
        path = "/api/v1/market-calendar/US" if date_value is None else "/api/v1/market-calendar/US?date=" + date_value
        return self._request("GET", path)

    def get_open_15m_price(self, symbol: str) -> Decimal | None:
        quotes = self.get_prices_raw([symbol]).get("result", [])
        if not quotes or not quotes[0].get("timestamp"): 
            return None
        quote_time = datetime.fromisoformat(quotes[0]["timestamp"])
        regular = None
        for candidate in (quote_time.date(), (quote_time - timedelta(days=1)).date()):
            session = self.get_us_market_calendar_raw(candidate.isoformat()).get("result", {}).get("today", {})
            candidate_regular = session.get("regularMarket")
            after = session.get("afterMarket")
            if candidate_regular and candidate_regular.get("startTime"):
                start_time = datetime.fromisoformat(candidate_regular["startTime"])
                end_time = datetime.fromisoformat((after or candidate_regular)["endTime"])
                if start_time <= quote_time <= end_time:
                    regular = candidate_regular
                    break
        if regular is None:
            return None
        target = datetime.fromisoformat(regular["startTime"]) + timedelta(minutes=15)
        path = "/api/v1/candles?" + urlencode({"symbol": symbol, "interval": "1m", "count": 1, "before": target.isoformat()})
        candles = self._request("GET", path).get("result", {}).get("candles", [])
        if not candles:
            return None
        candle_time = datetime.fromisoformat(candles[0]["timestamp"])
        if candle_time.date() != target.date() or abs((candle_time - target).total_seconds()) > 120:
            return None
        return Decimal(str(candles[0]["closePrice"]))

    def reconcile(self) -> AccountSnapshot:
        raise NotImplementedError("Use the UI account sync first; holdings field names are broker response dependent.")


    def cancel_order(self, order_id: str) -> dict:
        """Cancel one existing order by the opaque Toss order ID."""
        if self.mode != "LIVE":
            return {"status": "DRY_RUN", "orderId": order_id}
        if not self.live_ack:
            raise PermissionError("Set MUMAE_LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_TRADING in .env before live trading.")
        time.sleep(1.0)
        return self._request(
            "POST",
            f"/api/v1/orders/{order_id}/cancel",
            data=b"{}",
            headers={"Content-Type": "application/json", **self._account_headers()},
        )
    def submit_order(self, order: OrderIntent, broker_client_order_id: str | None = None) -> dict:
        """Submit one verified US order only after explicit .env and UI confirmations."""
        if self.mode != "LIVE":
            return {"status": "DRY_RUN", "client_order_id": order.client_order_id, "reason": order.reason}
        if not self.live_ack:
            raise PermissionError("Set MUMAE_LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_TRADING in .env before live trading.")
        time_in_force = order_time_in_force(order)
        match = re.search(r"-(" + "|".join(ETF_UNIVERSE) + r")-\d{8}-", order.client_order_id)
        if match is None:
            raise ValueError("Cannot determine the ticker from the client order ID.")
        symbol = match.group(1)
        payload = {
            "clientOrderId": broker_client_order_id or uuid.uuid4().hex,
            "symbol": symbol,
            "side": order.side.upper(),
            "orderType": "LIMIT",
            "timeInForce": time_in_force,
            "quantity": str(order.quantity),
            "price": str(order.limit_price),
            "confirmHighValueOrder": False,
        }
        time.sleep(1.0)  # Space live order requests to reduce ORDER-group throttling.
        return self._request("POST", "/api/v1/orders", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", **self._account_headers()})


def apply_snapshot(state: StrategyState, snapshot: AccountSnapshot) -> StrategyState:
    state.cash_usd = snapshot.cash_usd
    state.position_qty = snapshot.position_qty
    state.avg_cost = snapshot.avg_cost
    state.validate()
    return state
