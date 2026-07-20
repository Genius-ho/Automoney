"""Dependency-free client for the headless Mumae management engine."""
from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_ENGINE_URL = "http://127.0.0.1:8765"


class ManagementClient:
    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.cookie = ""
        self.csrf = ""
        self.connected = False

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        authenticated: bool = False,
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json", "X-Mumae-Client": "WINDOWS"}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if authenticated:
            if not self.cookie or not self.csrf:
                raise PermissionError("CLI 엔진 비상 관리 로그인이 필요합니다.")
            headers["Cookie"] = self.cookie
            headers["X-Mumae-CSRF"] = self.csrf
        request = Request(
            self.base_url + path,
            data=data,
            method=method,
            headers=headers,
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
                self.connected = True
                return result
        except HTTPError as error:
            try:
                body = json.loads(error.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                body = {}
            finally:
                error.close()
            raise PermissionError(body.get("error") or f"CLI 엔진 HTTP {error.code}") from error
        except URLError as error:
            self.connected = False
            raise ConnectionError(f"CLI 엔진에 연결할 수 없습니다: {error.reason}") from error

    def login(self, password: str) -> dict[str, Any]:
        request = Request(
            self.base_url + "/api/auth/login",
            data=json.dumps({"password": password}).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Mumae-Client": "WINDOWS",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
                self.cookie = response.headers["Set-Cookie"].split(";", 1)[0]
        except HTTPError as error:
            try:
                body = json.loads(error.read().decode("utf-8"))
            finally:
                error.close()
            raise PermissionError(body.get("error") or "CLI 엔진 로그인 실패") from error
        self.csrf = str(result["csrf"])
        self.connected = True
        return result

    def get_snapshot(self, symbol: str) -> dict[str, Any]:
        return self._request("/api/state?symbol=" + quote(symbol.upper()))

    def execute(self, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        result = self._request(
            "/api/command",
            method="POST",
            payload={"command": command, "payload": payload},
            authenticated=True,
        )
        result.pop("ok", None)
        return result


__all__ = ["DEFAULT_ENGINE_URL", "ManagementClient"]
