"""Small dependency-free HTTP server for the Mumae browser GUI."""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import threading
import webbrowser
from decimal import InvalidOperation
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

WEB_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = WEB_ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from local_env import load_env  # noqa: E402
from application_engine import ApplicationEngine  # noqa: E402
from telegram_bot import TelegramCommandLoop  # noqa: E402
from toss_api import TossApiError  # noqa: E402
from web_gui.web_auth import WebAuth  # noqa: E402

STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
}


class WebHandler(BaseHTTPRequestHandler):
    service: ApplicationEngine
    auth: WebAuth
    static_dir = WEB_ROOT / "static"

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status: int, payload: dict, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._security_headers()
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _cookie_flags(self) -> str:
        return "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1_000_000:
            raise ValueError("요청 데이터 크기가 올바르지 않습니다.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._json(HTTPStatus.OK, {
                "ok": True,
                "service": "mumae-web",
                "version": "WEB.0.2",
                "live_order_enabled": False,
            })
            return
        if parsed.path == "/api/auth/status":
            status = self.auth.status(self.headers.get("Cookie"))
            self._json(HTTPStatus.OK, {"ok": True, **status})
            return
        if parsed.path == "/api/etf-info":
            symbol = parse_qs(parsed.query).get("symbol", ["TQQQ"])[0]
            try:
                payload = self.service.etf_info(symbol)
            except ValueError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
                return
            self._json(HTTPStatus.OK, payload)
            return
        if parsed.path == "/api/state":
            symbol = parse_qs(parsed.query).get("symbol", ["TQQQ"])[0]
            self._json(HTTPStatus.OK, self.service.snapshot(symbol))
            return
        filename = STATIC_FILES.get(parsed.path)
        if filename is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        path = self.static_dir / filename
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(body)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/auth/login":
                token, csrf = self.auth.login(str(self._read_json().get("password") or ""))
                self._json(
                    HTTPStatus.OK,
                    {"ok": True, "csrf": csrf, "live_enabled": self.auth.live_enabled},
                    {"Set-Cookie": f"mumae_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{self._cookie_flags()}"},
                )
                return
            if parsed.path == "/api/auth/logout":
                self.auth.logout(self.headers.get("Cookie"))
                self._json(
                    HTTPStatus.OK,
                    {"ok": True},
                    {"Set-Cookie": f"mumae_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{self._cookie_flags()}"},
                )
                return
            live_paths = {
                "/api/orders/submit",
                "/api/orders/cancel",
                "/api/auto/start",
                "/api/auto/stop",
            }
            self.auth.validate(
                self.headers.get("Cookie"),
                self.headers.get("X-Mumae-CSRF"),
                live=parsed.path in live_paths,
            )
            if parsed.path == "/api/command":
                body = self._read_json()
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
                }:
                    self.auth.validate(
                        self.headers.get("Cookie"),
                        self.headers.get("X-Mumae-CSRF"),
                        live=True,
                    )
                source = str(self.headers.get("X-Mumae-Client") or "WEB").upper()
                if source not in {"WEB", "WINDOWS"}:
                    source = "WEB"
                result = self.service.execute(
                    command,
                    payload,
                    source=source,
                    actor="authenticated-" + source.lower(),
                )
            elif parsed.path == "/api/plan":
                payload = self._read_json()
                result = self.service.execute("plan.calculate", payload, source="WEB", actor="web-session")
            elif parsed.path == "/api/account/refresh":
                payload = self._read_json()
                result = self.service.execute("account.refresh", payload, source="WEB", actor="web-session")
            elif parsed.path == "/api/orders/sync":
                payload = self._read_json()
                result = self.service.execute("orders.sync", payload, source="WEB", actor="web-session")
            elif parsed.path == "/api/history":
                payload = self._read_json()
                result = self.service.execute("history.refresh", payload, source="WEB", actor="web-session")
            elif parsed.path == "/api/analysis/long-term":
                payload = self._read_json()
                result = self.service.execute("analysis.long_term", payload, source="WEB", actor="web-session")
            elif parsed.path == "/api/analysis/pairs":
                payload = self._read_json()
                result = self.service.execute("analysis.pairs", payload, source="WEB", actor="web-session")
            elif parsed.path == "/api/orders/edit-price":
                payload = self._read_json()
                result = self.service.execute("order.edit_price", payload, source="WEB", actor="web-session")
            elif parsed.path == "/api/orders/submit":
                payload = self._read_json()
                result = self.service.execute("order.submit", payload, source="WEB", actor="authenticated-web")
            elif parsed.path == "/api/orders/cancel":
                payload = self._read_json()
                result = self.service.execute("order.cancel", payload, source="WEB", actor="authenticated-web")
            elif parsed.path == "/api/auto/start":
                payload = self._read_json()
                result = self.service.execute("auto.start", payload, source="WEB", actor="authenticated-web")
            elif parsed.path == "/api/auto/stop":
                payload = self._read_json()
                result = self.service.execute("auto.stop", payload, source="WEB", actor="authenticated-web")
            elif parsed.path == "/api/reconnect":
                payload = self._read_json()
                result = self.service.execute("api.reconnect", payload, source="WEB", actor="web-session")
            else:
                self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "API를 찾을 수 없습니다."})
                return
        except (ValueError, InvalidOperation, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        except PermissionError as error:
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": str(error)})
            return
        except TossApiError as error:
            print("Toss API error:", repr(error), file=sys.stderr)
            message = str(error)
            self._json(HTTPStatus.BAD_GATEWAY, {
                "ok": False,
                "error": message[:300] + "..." if len(message) > 300 else message,
            })
            return
        except Exception:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "서버 내부 오류가 발생했습니다."})
            return
        self._json(HTTPStatus.OK, {"ok": True, **result})

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


def _auto_loop(service: ApplicationEngine, stopped: threading.Event, interval: float = 60.0) -> None:
    while not stopped.wait(interval):
        try:
            service.auto_tick()
        except Exception as error:
            print("Automatic order tick failed:", error, file=sys.stderr)


def _create_auth() -> WebAuth:
    load_env()
    return WebAuth()


def _live_status_message(auth: WebAuth) -> str:
    state = "ENABLED" if auth.live_enabled else "DISABLED"
    return f"Live order submission: {state}"


def run(
    host: str,
    port: int,
    data_dir: Path,
    open_browser: bool = False,
    engine: ApplicationEngine | None = None,
) -> None:
    WebHandler.service = engine or ApplicationEngine(data_dir)
    WebHandler.auth = _create_auth()
    server = ThreadingHTTPServer((host, port), WebHandler)
    stopped = threading.Event()
    scheduler = None
    telegram_loop = None
    if WebHandler.auth.configured and WebHandler.auth.live_enabled:
        scheduler = threading.Thread(
            target=_auto_loop,
            args=(WebHandler.service, stopped),
            name="mumae-auto",
            daemon=True,
        )
        scheduler.start()
        telegram_loop = TelegramCommandLoop(WebHandler.service, WebHandler.service.telegram)
        telegram_loop.start()
    url = f"http://127.0.0.1:{port}/"
    print(f"Mumae Web GUI: {url}")
    print(_live_status_message(WebHandler.auth))
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
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(os.getenv("MUMAE_DATA_DIR", os.getenv("MUMAE_WEB_DATA_DIR", PROJECT_ROOT))),
    )
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    run(args.host, args.port, args.data_dir, args.open)


if __name__ == "__main__":
    main()
