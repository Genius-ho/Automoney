"""Virtual investment board: the stock_ai paper-trading app, run and served under /virtual/.

The app (virtual/) is a FastAPI program with its own scheduler (08:00 reserve, 18:xx settle) and
needs numpy/xgboost, so it runs as a child process of the dashboard instead of being imported.
The dashboard keeps it alive and relays /virtual/* to it; records live in data/virtualstudy/.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
VIRTUAL_SRC = PROJECT_ROOT / "virtual"
VIRTUAL_DATA = PROJECT_ROOT / "data" / "virtualstudy"
VENV_PYTHON = PROJECT_ROOT / ".venv" / "bin" / "python"
PREFIX = "/virtual"
HOST = "127.0.0.1"
PORT = int(os.getenv("MUMAE_VIRTUAL_PORT", "8100"))
PROXY_TIMEOUT = 180  # xlsx exports and first-load indexes can take a while
RESTART_MIN, RESTART_MAX = 10, 300

# The page uses root-absolute URLs ("/api/...", "/static/..."); move them under the board's prefix.
_ABSOLUTE_URL = re.compile(r"""(["'`])/(api|static)/""")
_BRAND_HOME = re.compile(r'href="/"')
REWRITE_TYPES = ("text/html", "text/javascript", "application/javascript")
HOP_BY_HOP = {"connection", "keep-alive", "cache-control", "transfer-encoding", "content-length", "server", "date"}

_lock = threading.Lock()
_stop = threading.Event()
_child: subprocess.Popen | None = None
_state: dict[str, object] = {"running": False, "restarts": 0, "last_error": ""}


def _python() -> str:
    return str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable


def _healthy(timeout: float = 1.5) -> bool:
    try:
        conn = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
        conn.request("GET", "/api/health")
        ok = conn.getresponse().status == 200
        conn.close()
        return ok
    except OSError:
        return False


def status() -> dict[str, object]:
    return {**_state, "port": PORT, "healthy": _healthy(), "data_dir": str(VIRTUAL_DATA)}


def _run_child() -> int:
    global _child
    VIRTUAL_DATA.mkdir(parents=True, exist_ok=True)
    log = (VIRTUAL_DATA / "virtual.log").open("ab")
    env = {**os.environ, "TZ": "Asia/Seoul", "PYTHONUNBUFFERED": "1"}
    command = [_python(), str(VIRTUAL_SRC / "stock_ai_analyzer.py"),
               "--host", HOST, "--port", str(PORT), "--data-dir", str(VIRTUAL_DATA)]
    with _lock:
        if _stop.is_set():
            return 0
        _child = subprocess.Popen(command, cwd=VIRTUAL_SRC, env=env, stdout=log, stderr=subprocess.STDOUT)
    _state["running"] = True
    try:
        return _child.wait()
    finally:
        _state["running"] = False
        log.close()


def _supervise() -> None:
    delay = RESTART_MIN
    while not _stop.is_set():
        if _healthy():
            # Someone already runs it on this port (e.g. started by hand); just relay to it.
            _stop.wait(30)
            continue
        started = time.monotonic()
        code = _run_child()
        if _stop.is_set():
            return
        _state["restarts"] = int(_state["restarts"]) + 1
        _state["last_error"] = f"가상 투자 서버가 종료됐습니다 (코드 {code}). virtual.log를 확인하세요."
        # A run that stayed up for a while was healthy: restart quickly. Crash loops back off.
        delay = RESTART_MIN if time.monotonic() - started > 120 else min(delay * 2, RESTART_MAX)
        _stop.wait(delay)


def start() -> None:
    if not (VIRTUAL_SRC / "stock_ai_analyzer.py").exists():
        _state["last_error"] = "virtual/stock_ai_analyzer.py 가 없습니다."
        return
    _stop.clear()
    threading.Thread(target=_supervise, name="virtual-board", daemon=True).start()


def stop() -> None:
    _stop.set()
    with _lock:
        child = _child
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()


def _rewrite(body: bytes) -> bytes:
    text = body.decode("utf-8")
    text = _ABSOLUTE_URL.sub(lambda m: f"{m.group(1)}{PREFIX}/{m.group(2)}/", text)
    return _BRAND_HOME.sub(f'href="{PREFIX}/"', text).encode("utf-8")


def relay(method: str, path: str, query: str, body: bytes | None, content_type: str | None) -> tuple[int, dict[str, str], bytes]:
    """Forward one request to the child app. `path` is the part after /virtual (starts with /)."""
    target = path + ("?" + query if query else "")
    headers = {"Content-Type": content_type} if content_type else {}
    try:
        conn = http.client.HTTPConnection(HOST, PORT, timeout=PROXY_TIMEOUT)
        conn.request(method, target, body=body, headers=headers)
        response = conn.getresponse()
        data = response.read()
        status_code = response.status
        out = {k: v for k, v in response.getheaders() if k.lower() not in HOP_BY_HOP}
        conn.close()
    except OSError:
        message = str(_state["last_error"]) or "가상 투자 서버를 시작하는 중입니다. 잠시 후 새로고침하세요."
        payload = json.dumps({"ok": False, "detail": message}, ensure_ascii=False).encode("utf-8")
        return 503, {"Content-Type": "application/json; charset=utf-8", "Retry-After": "5"}, payload
    kind = next((v for k, v in out.items() if k.lower() == "content-type"), "")
    if status_code == 200 and kind.split(";")[0].strip() in REWRITE_TYPES:
        data = _rewrite(data)
    return status_code, out, data
