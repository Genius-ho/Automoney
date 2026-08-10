"""Kiwoom Securities REST API connector (overseas/US stock trading).

Separate from toss_api.py on purpose: different broker, different
credentials, different account holders (children's Kiwoom accounts vs.
the main Toss account), different request/response contract.

STATUS: auth (OAuth2 client_credentials token issuance) is implemented
and confirmed against Kiwoom's published docs. The actual 미국주식
(quote/order/balance) endpoint paths and payload schemas are NOT yet
filled in -- Kiwoom's public docs only showed the menu structure
(계좌/시세/주문/실시간시세/조건검색), not the concrete paths, so those
methods raise NotImplementedError with a pointer to what's needed rather
than guessing at endpoint shapes for something that will eventually
place real orders.

To finish this: apply for Kiwoom Open API access, download the actual
API specification ("API 명세서") from https://openapi.kiwoom.com/, and
fill in KiwoomBroker's get_us_prices_raw / get_us_daily_candles_raw /
get_us_holdings_raw / submit_us_order / cancel_us_order to match.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime
from decimal import Decimal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from local_env import load_env

BASE_URL_LIVE = "https://api.kiwoom.com"
BASE_URL_MOCK = "https://mockapi.kiwoom.com"
LIVE_ACKNOWLEDGEMENT = "I_UNDERSTAND_KIWOOM_LIVE_TRADING"


class KiwoomApiError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, data: object | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.data = data


class KiwoomBroker:
    def __init__(self, env_path: str = ".env") -> None:
        # env_path lets each child's profile load its own credentials file
        # (e.g. deploy/kiwoom_child1.env) instead of a single shared .env --
        # see vr_cli.py, which resolves this from --profile.
        load_env(env_path)
        self.app_key = os.getenv("KIWOOM_APP_KEY", "").strip()
        self.app_secret = os.getenv("KIWOOM_APP_SECRET", "").strip()
        self.account_no = os.getenv("KIWOOM_ACCOUNT_NO", "").strip()
        # Default to the mock/paper trading endpoint -- same safety-first
        # convention as toss_api.py's DRY_RUN default: live trading must be
        # opted into explicitly, not the accidental default.
        self.mode = os.getenv("KIWOOM_MODE", "MOCK").upper()
        self.live_ack = os.getenv("KIWOOM_LIVE_TRADING_ACK") == LIVE_ACKNOWLEDGEMENT
        self._access_token: str | None = None
        self._token_expires_at = 0.0

    @property
    def base_url(self) -> str:
        return BASE_URL_LIVE if self.mode == "LIVE" else BASE_URL_MOCK

    def _require_credentials(self) -> None:
        if not self.app_key or not self.app_secret:
            raise KiwoomApiError("KIWOOM_APP_KEY / KIWOOM_APP_SECRET 환경변수를 설정하세요.")

    def _token(self) -> str:
        if self._access_token and time.time() < self._token_expires_at - 30:
            return self._access_token
        self._require_credentials()
        payload = json.dumps({
            "grant_type": "client_credentials",
            "appkey": self.app_key,
            "secretkey": self.app_secret,
        }).encode("utf-8")
        result = self._call("POST", "/oauth2/token", data=payload, include_auth=False)
        token = result.get("token") or result.get("access_token")
        if not token:
            raise KiwoomApiError("Kiwoom 토큰 응답에 access token이 없습니다.")
        self._access_token = token
        expires_dt = result.get("expires_dt")
        if expires_dt:
            # Documented format: "20241107083713" (local KST datetime, no separators).
            self._token_expires_at = datetime.strptime(expires_dt, "%Y%m%d%H%M%S").timestamp()
        else:
            self._token_expires_at = time.time() + 3600
        return token

    def _call(
        self,
        method: str,
        path: str,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        include_auth: bool = True,
    ) -> dict:
        request_headers = {"Content-Type": "application/json;charset=UTF-8", **(headers or {})}
        if include_auth:
            request_headers["Authorization"] = f"Bearer {self._token()}"
        request = Request(f"{self.base_url}{path}", data=data, method=method, headers=request_headers)
        for attempt in range(4):
            try:
                with urlopen(request, timeout=15) as response:
                    return json.loads(response.read().decode("utf-8"))
            except HTTPError as error:
                body = error.read().decode("utf-8", errors="replace")
                error.close()
                if error.code == 429 and attempt < 3:
                    time.sleep(2**attempt)
                    continue
                raise KiwoomApiError(f"Kiwoom API HTTP {error.code}: {body}", status=error.code) from error
            except URLError as error:
                raise KiwoomApiError(f"Kiwoom API 연결 실패: {error.reason}") from error
        raise KiwoomApiError("Kiwoom API 요청 재시도 한도를 초과했습니다.")

    # -- Implemented: account/auth plumbing only. --------------------------

    def cancel_order(self, order_id: str) -> dict:
        if self.mode != "LIVE":
            return {"status": "MOCK", "orderId": order_id}
        if not self.live_ack:
            raise PermissionError("KIWOOM_LIVE_TRADING_ACK 환경변수를 설정해야 실거래 주문을 낼 수 있습니다.")
        raise NotImplementedError(
            "취소 주문 엔드포인트 경로/파라미터가 아직 확정되지 않았습니다. "
            "Kiwoom Open API 포털에서 미국주식 주문취소 API 명세서를 확인한 뒤 구현하세요."
        )

    def submit_us_order(self, symbol: str, side: str, quantity: int, price: Decimal) -> dict:
        if self.mode != "LIVE":
            return {"status": "MOCK", "symbol": symbol, "side": side, "quantity": quantity, "price": str(price)}
        if not self.live_ack:
            raise PermissionError("KIWOOM_LIVE_TRADING_ACK 환경변수를 설정해야 실거래 주문을 낼 수 있습니다.")
        raise NotImplementedError(
            "미국주식 주문 엔드포인트 경로/파라미터가 아직 확정되지 않았습니다. "
            "Kiwoom Open API 포털에서 미국주식 주문 API 명세서를 확인한 뒤 구현하세요."
        )

    # -- Not implemented: exact endpoint paths not yet confirmed. ----------

    def get_us_prices_raw(self, symbols: list[str]) -> dict:
        raise NotImplementedError("미국주식 시세조회 API 명세서 확인 후 구현 필요.")

    def get_us_daily_candles_raw(self, symbol: str, count: int = 200) -> dict:
        raise NotImplementedError("미국주식 차트(일봉) API 명세서 확인 후 구현 필요.")

    def get_us_holdings_raw(self) -> dict:
        raise NotImplementedError("해외주식 잔고조회 API 명세서 확인 후 구현 필요.")

    def get_us_buying_power_raw(self) -> dict:
        raise NotImplementedError("해외주식 매수가능금액 조회 API 명세서 확인 후 구현 필요.")


__all__ = ["KiwoomApiError", "KiwoomBroker"]
