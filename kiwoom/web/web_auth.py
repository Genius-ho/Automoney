"""In-memory password sessions and CSRF protection for the Kiwoom VR web GUI.

Deliberately a standalone copy of web_gui/web_auth.py's pattern, not a
shared import -- this program is meant to run fully independently of the
Toss/무한매수 web GUI (different cookie name, different env vars, no
cross-dependency to break if one program changes).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from dataclasses import dataclass
from http.cookies import SimpleCookie

COOKIE_NAME = "kiwoom_vr_session"


@dataclass
class Session:
    csrf: str
    expires_at: float


class WebAuth:
    def __init__(self) -> None:
        self.password = os.getenv("KIWOOM_WEB_PASSWORD", "")
        self.live_enabled = os.getenv("KIWOOM_WEB_LIVE_ACTIONS", "") == "I_UNDERSTAND_KIWOOM_WEB_LIVE_TRADING"
        self.sessions: dict[str, Session] = {}

    @property
    def configured(self) -> bool:
        return bool(self.password)

    def login(self, password: str) -> tuple[str, str]:
        if not self.configured:
            raise PermissionError("KIWOOM_WEB_PASSWORD가 설정되지 않았습니다.")
        supplied = hashlib.sha256(password.encode("utf-8")).digest()
        expected = hashlib.sha256(self.password.encode("utf-8")).digest()
        if not hmac.compare_digest(supplied, expected):
            raise PermissionError("웹 비밀번호가 올바르지 않습니다.")
        return self._create_session()

    def _create_session(self) -> tuple[str, str]:
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        self.sessions[token] = Session(csrf, time.time() + 12 * 60 * 60)
        return token, csrf

    @staticmethod
    def cookie_token(header: str | None) -> str:
        cookie = SimpleCookie()
        cookie.load(header or "")
        value = cookie.get(COOKIE_NAME)
        return value.value if value else ""

    def validate(self, cookie_header: str | None, csrf: str | None, *, live: bool = False) -> None:
        token = self.cookie_token(cookie_header)
        session = self.sessions.get(token)
        if session is None or session.expires_at <= time.time():
            self.sessions.pop(token, None)
            raise PermissionError("웹 로그인이 필요합니다.")
        if not csrf or not hmac.compare_digest(session.csrf, csrf):
            raise PermissionError("CSRF 확인값이 일치하지 않습니다.")
        if live and not self.live_enabled:
            raise PermissionError("KIWOOM_WEB_LIVE_ACTIONS 실행 허용값이 필요합니다.")

    def logout(self, cookie_header: str | None) -> None:
        self.sessions.pop(self.cookie_token(cookie_header), None)

    def status(self, cookie_header: str | None) -> dict[str, bool | str]:
        token = self.cookie_token(cookie_header)
        session = self.sessions.get(token)
        authenticated = bool(session and session.expires_at > time.time())
        return {
            "configured": self.configured,
            "authenticated": authenticated,
            "live_enabled": self.live_enabled and authenticated,
            "csrf": session.csrf if authenticated and session else "",
        }
