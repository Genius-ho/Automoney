"""Dependency-free HTTP server for the rebuilt Mumae web dashboard."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

WEB_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = WEB_ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from application_engine import ApplicationEngine, LiveActionsRequiredError  # noqa: E402
from local_env import load_env  # noqa: E402
from telegram_bot import TelegramCommandLoop  # noqa: E402
from toss_api import TossApiError  # noqa: E402
from web_gui.dashboard.service import DashboardService, EngineDashboardService  # noqa: E402

STATIC_FILES = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css"}


@dataclass
class Session:
    csrf: str
    expires_at: float


class Auth:
    def __init__(self, password: str) -> None:
        self.password = password
        self.sessions: dict[str, Session] = {}
        self.lock = threading.Lock()

    def login(self, supplied: str) -> tuple[str, str]:
        if not self.password:
            raise PermissionError("MUMAE_WEB_PASSWORD가 설정되지 않았습니다.")
        actual = hashlib.sha256(supplied.encode("utf-8")).digest()
        expected = hashlib.sha256(self.password.encode("utf-8")).digest()
        if not hmac.compare_digest(actual, expected):
            raise PermissionError("웹 비밀번호가 올바르지 않습니다.")
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        with self.lock:
            self.sessions[token] = Session(csrf, time.time() + 12 * 60 * 60)
        return token, csrf

    @staticmethod
    def _token(cookie_header: str | None) -> str:
        cookie = SimpleCookie()
        cookie.load(cookie_header or "")
        value = cookie.get("mumae_v2_session")
        return value.value if value else ""

    def validate(
        self,
        cookie_header: str | None,
        csrf: str | None,
        session_token: str | None = None,
    ) -> None:
        token = session_token or self._token(cookie_header)
        with self.lock:
            session = self.sessions.get(token)
            if session is None or session.expires_at <= time.time():
                self.sessions.pop(token, None)
                raise PermissionError("웹 로그인이 필요합니다.")
        if not csrf or not hmac.compare_digest(session.csrf, csrf):
            raise PermissionError("로그인 세션이 만료되었습니다. 다시 로그인하세요.")

    def logout(self, cookie_header: str | None, session_token: str | None = None) -> None:
        with self.lock:
            self.sessions.pop(session_token or self._token(cookie_header), None)


class Handler(BaseHTTPRequestHandler):
    service: DashboardService | EngineDashboardService
    auth: Auth
    static_dir = WEB_ROOT / "static"

    def _headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status: int, payload: dict[str, object], extra: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._headers()
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1_000_000:
            raise ValueError("요청 본문이 비어 있거나 너무 큽니다.")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("JSON 객체가 필요합니다.")
        return value

    def _cookie_flags(self) -> str:
        return "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""

    def _validate(self) -> None:
        self.auth.validate(
            self.headers.get("Cookie"),
            self.headers.get("X-Mumae-CSRF"),
            self.headers.get("X-Mumae-Session"),
        )

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                self._json(HTTPStatus.OK, {"ok": True, "service": "mumae-web-v2", "version": 2})
                return
            if parsed.path == "/api/bootstrap":
                self._validate()
                symbol = parse_qs(parsed.query).get("symbol", ["TQQQ"])[0]
                self._json(HTTPStatus.OK, {"ok": True, **self.service.bootstrap(symbol)})
                return
            if parsed.path == "/api/state":
                symbol = parse_qs(parsed.query).get("symbol", ["TQQQ"])[0]
                self._json(HTTPStatus.OK, self.service.snapshot(symbol))
                return
            if parsed.path == "/api/etf-status":
                self._validate()
                self._json(HTTPStatus.OK, {"ok": True, "etf_overview": self.service.etf_overview()})
                return
            filename = STATIC_FILES.get(parsed.path)
            if filename is None:
                self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "경로를 찾을 수 없습니다."})
                return
            path = self.static_dir / filename
            body = path.read_bytes()
            self.send_response(HTTPStatus.OK)
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
            self.send_header("Content-Length", str(len(body)))
            self._headers()
            self.end_headers()
            self.wfile.write(body)
        except LiveActionsRequiredError as error:
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": str(error)})
        except PermissionError as error:
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": str(error)})
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path in {"/api/login", "/api/auth/login"}:
                token, csrf = self.auth.login(str(self._body().get("password") or ""))
                self._json(
                    HTTPStatus.OK,
                    {"ok": True, "csrf": csrf, "session": token, "expires_in": 43200},
                    {"Set-Cookie": f"mumae_v2_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{self._cookie_flags()}"},
                )
                return
            if parsed.path in {"/api/logout", "/api/auth/logout"}:
                self.auth.logout(
                    self.headers.get("Cookie"),
                    self.headers.get("X-Mumae-Session"),
                )
                self._json(
                    HTTPStatus.OK,
                    {"ok": True},
                    {"Set-Cookie": f"mumae_v2_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{self._cookie_flags()}"},
                )
                return
            self._validate()
            if parsed.path == "/api/command":
                body = self._body()
                command = str(body.get("command") or "")
                payload = body.get("payload")
                if not isinstance(payload, dict):
                    raise ValueError("엔진 명령 payload는 객체여야 합니다.")
                if command in {
                    "order.submit",
                    "order.cancel",
                    "order.reregister",
                    "order.retry_failed",
                    "order.retry_failed_price",
                    "auto.start",
                    "auto.stop",
                    "api.update",
                } and os.getenv(
                    "MUMAE_WEB_LIVE_ACTIONS", ""
                ) != "I_UNDERSTAND_WEB_LIVE_TRADING":
                    raise PermissionError("MUMAE_WEB_LIVE_ACTIONS 실주문 허용값이 필요합니다.")
                source = str(self.headers.get("X-Mumae-Client") or "WEB").upper()
                if source not in {"WEB", "WINDOWS"}:
                    source = "WEB"
                self._json(HTTPStatus.OK, {"ok": True, **self.service.execute(
                    command, payload, source=source, actor="authenticated-" + source.lower()
                )})
                return
            if parsed.path == "/api/account/refresh":
                symbol = str(self._body().get("symbol") or "TQQQ")
                self._json(HTTPStatus.OK, {"ok": True, **self.service.refresh_account(symbol)})
                return
            if parsed.path == "/api/strategy/update":
                self._json(HTTPStatus.OK, {"ok": True, **self.service.update_strategy(self._body())})
                return
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "API를 찾을 수 없습니다."})
        except LiveActionsRequiredError as error:
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": str(error)})
        except PermissionError as error:
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": str(error)})
        except (ValueError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
        except TossApiError as error:
            print("Toss API error:", repr(error), file=sys.stderr)
            message = str(error)
            self._json(HTTPStatus.BAD_GATEWAY, {
                "ok": False,
                "error": message[:300] + "..." if len(message) > 300 else message,
                "code": error.code,
            })
        except Exception as error:
            print("Unhandled request error:", repr(error), file=sys.stderr)
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "서버 내부 오류가 발생했습니다."})

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


def _auto_loop(engine: ApplicationEngine, stopped: threading.Event, interval: float = 60.0) -> None:
    while not stopped.wait(interval):
        try:
            engine.auto_tick()
        except Exception as error:
            print("Automatic order tick failed:", error, file=sys.stderr)


def run(
    host: str,
    port: int,
    data_dir: Path,
    open_browser: bool = False,
    engine: ApplicationEngine | None = None,
) -> None:
    load_env()
    active_engine = engine
    Handler.service = EngineDashboardService(active_engine) if active_engine is not None else DashboardService(data_dir)
    Handler.auth = Auth(os.getenv("MUMAE_WEB_PASSWORD", ""))
    server = ThreadingHTTPServer((host, port), Handler)
    stopped = threading.Event()
    scheduler = None
    telegram_loop = None
    live_enabled = os.getenv("MUMAE_WEB_LIVE_ACTIONS", "") == "I_UNDERSTAND_WEB_LIVE_TRADING"
    if active_engine is not None and Handler.auth.password and live_enabled:
        scheduler = threading.Thread(
            target=_auto_loop,
            args=(active_engine, stopped),
            name="mumae-auto",
            daemon=True,
        )
        scheduler.start()
        telegram_loop = TelegramCommandLoop(active_engine, active_engine.telegram)
        telegram_loop.start()
    url = f"http://127.0.0.1:{port}/"
    print(f"Mumae CLI Engine + Emergency Dashboard: {url}")
    print(f"Shared data: {Handler.service.data_dir}")
    print(f"Automatic live orders: {'ENABLED' if scheduler else 'DISABLED'}")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stopped.set()
        if telegram_loop is not None:
            telegram_loop.stop()
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("MUMAE_WEB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("MUMAE_WEB_PORT", "8765")))
    parser.add_argument("--data-dir", type=Path, default=Path(os.getenv("MUMAE_DATA_DIR", PROJECT_ROOT)))
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    run(args.host, args.port, args.data_dir, args.open)


if __name__ == "__main__":
    main()
