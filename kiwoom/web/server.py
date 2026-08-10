"""Standalone HTTP server for the Kiwoom VR web dashboard.

Entirely separate program from web_gui/server.py (the Toss/무한매수 web
GUI): own auth module, own cookie, own port default, no shared engine.
Only reads/writes kiwoom/vr_state.py's per-profile JSON files -- no
broker calls, since kiwoom_api.py's order/quote endpoints aren't
implemented yet (see kiwoom/README.md).
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

WEB_ROOT = Path(__file__).resolve().parent
REPO_ROOT = WEB_ROOT.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from local_env import load_env  # noqa: E402
from kiwoom.web.service import VrWebService  # noqa: E402
from kiwoom.web.web_auth import COOKIE_NAME, WebAuth  # noqa: E402

STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
}


class KiwoomWebHandler(BaseHTTPRequestHandler):
    service: VrWebService
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
            self._json(HTTPStatus.OK, {"ok": True, "service": "kiwoom-vr-web", "version": "0.1"})
            return
        if parsed.path == "/api/auth/status":
            self._json(HTTPStatus.OK, {"ok": True, **self.auth.status(self.headers.get("Cookie"))})
            return
        if parsed.path == "/api/profiles":
            self._json(HTTPStatus.OK, {"ok": True, "profiles": self.service.list_profiles()})
            return
        if parsed.path == "/api/status":
            profile = parse_qs(parsed.query).get("profile", [""])[0]
            try:
                self._json(HTTPStatus.OK, {"ok": True, **self.service.status(profile)})
            except ValueError as error:
                self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": str(error)})
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
                    {"Set-Cookie": f"{COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{self._cookie_flags()}"},
                )
                return
            if parsed.path == "/api/auth/logout":
                self.auth.logout(self.headers.get("Cookie"))
                self._json(
                    HTTPStatus.OK,
                    {"ok": True},
                    {"Set-Cookie": f"{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{self._cookie_flags()}"},
                )
                return
            # Every other POST mutates a profile's financial state, so all of
            # them require a logged-in session (same caution as the Toss web
            # GUI's live-order paths), even though nothing here reaches a
            # broker yet.
            self.auth.validate(self.headers.get("Cookie"), self.headers.get("X-Kiwoom-CSRF"))
            if parsed.path == "/api/profiles":
                body = self._read_json()
                result = self.service.create_profile(
                    str(body.get("profile") or ""),
                    str(body.get("symbol") or ""),
                    float(body.get("price") or 0),
                    float(body.get("cash") or 0),
                    g=float(body.get("g", 10.0)),
                    band_pct=float(body.get("band_pct", 0.15)),
                    contribution=float(body.get("contribution", 20.0)),
                    cycle_length_days=int(body.get("cycle_length_days", 14)),
                    pool_seed_pct=float(body.get("pool_seed_pct", 0.10)),
                    pool_usage_cap_pct=float(body.get("pool_usage_cap_pct", 0.75)),
                )
            elif parsed.path == "/api/plan":
                body = self._read_json()
                result = self.service.plan(
                    str(body.get("profile") or ""),
                    float(body.get("price") or 0),
                    apply=bool(body.get("apply", False)),
                )
            else:
                self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "API를 찾을 수 없습니다."})
                return
        except (ValueError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        except PermissionError as error:
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": str(error)})
            return
        except Exception:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "서버 내부 오류가 발생했습니다."})
            return
        self._json(HTTPStatus.OK, {"ok": True, **result})

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


def run(host: str, port: int, data_dir: Path, open_browser: bool = False) -> None:
    load_env()
    KiwoomWebHandler.service = VrWebService(data_dir)
    KiwoomWebHandler.auth = WebAuth()
    server = ThreadingHTTPServer((host, port), KiwoomWebHandler)
    url = f"http://127.0.0.1:{port}/"
    print(f"Kiwoom VR Web GUI: {url}")
    print("Live order submission: DISABLED (kiwoom_api.py 미완성 -- 상태 시뮬레이션만 가능)")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("KIWOOM_WEB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("KIWOOM_WEB_PORT", "8766")))
    parser.add_argument("--data-dir", type=Path, default=Path(os.getenv("KIWOOM_DATA_DIR", "data")))
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    run(args.host, args.port, args.data_dir, args.open)


if __name__ == "__main__":
    main()
