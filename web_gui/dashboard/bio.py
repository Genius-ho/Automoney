"""Bio study board: static page, collected reports/news, and a live price feed.

Served under /bio/ on the dashboard server. Collected data lives in data/biostudy/
and is refreshed by background threads that run the bio-studyboard fetch scripts.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BIO_SRC = PROJECT_ROOT / "bio-studyboard"
BIO_PAGE = BIO_SRC / "standalone.html"
BIO_DATA = PROJECT_ROOT / "data" / "biostudy"
VENV_PYTHON = PROJECT_ROOT / ".venv" / "bin" / "python"

PRICE_TTL = 60
NEWS_INTERVAL = 3 * 3600
REPORTS_INTERVAL = 12 * 3600
UA = "Mozilla/5.0"  # Yahoo 429s full browser UA strings from scripts
# Page companies whose ticker field is not a symbol
SYMBOL_OVERRIDES = {"xbi": "XBI"}

_price_lock = threading.Lock()
_price_cache: tuple[float, dict[str, object]] | None = None


def _get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def page_symbols() -> dict[str, str]:
    """Map price key (as the page's tickerKeyOf gives it) to region, read from the page itself."""
    html = BIO_PAGE.read_text(encoding="utf-8")
    symbols: dict[str, str] = {}
    for company_id, ticker, region in re.findall(r'id:"([\w-]+)",[^\n]*?ticker:"([^"]*)",\s*region:"(kr|gl)"', html):
        key = SYMBOL_OVERRIDES.get(company_id) or ticker.split("·")[0].strip()
        if key:
            symbols[key] = region
    return symbols


def _kr_quote(code: str) -> dict[str, object]:
    data = _get_json(f"https://m.stock.naver.com/api/stock/{code}/basic")
    return {
        "price": data["closePrice"],
        "change": float(data.get("fluctuationsRatio") or 0),
        "currency": "₩",
        "asOf": str(data.get("localTradedAt") or "")[:16].replace("T", " "),
        "status": data.get("marketStatus"),
    }


def _gl_quote(symbol: str) -> dict[str, object]:
    data = _get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=1d")
    meta = data["chart"]["result"][0]["meta"]
    price = float(meta["regularMarketPrice"])
    previous = float(meta.get("chartPreviousClose") or meta.get("previousClose") or 0)
    change = (price / previous - 1) * 100 if previous else 0.0
    as_of = time.strftime("%Y-%m-%d %H:%M", time.localtime(int(meta.get("regularMarketTime") or time.time())))
    return {"price": f"{price:,.2f}", "change": round(change, 2), "currency": "$", "asOf": as_of + " KST"}


def prices() -> dict[str, object]:
    global _price_cache
    with _price_lock:
        if _price_cache and time.time() - _price_cache[0] < PRICE_TTL:
            return _price_cache[1]
        symbols = page_symbols()

        def one(item: tuple[str, str]) -> tuple[str, dict[str, object] | None]:
            key, region = item
            try:
                return key, (_kr_quote(key) if region == "kr" else _gl_quote(key))
            except Exception:  # noqa: BLE001 - one bad symbol must not break the feed
                return key, None

        with ThreadPoolExecutor(max_workers=8) as pool:
            items = {key: quote for key, quote in pool.map(one, symbols.items()) if quote}
        payload = {"ok": True, "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "items": items}
        _price_cache = (time.time(), payload)
        return payload


def data_file(relative: str) -> Path | None:
    """Resolve /bio/reports/... or /bio/news/... to a file inside BIO_DATA, refusing traversal."""
    if not (relative.startswith("reports/") or relative.startswith("news/")):
        return None
    root = BIO_DATA.resolve()
    path = (root / relative).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return path


def _run_fetcher(script: str) -> None:
    python = str(VENV_PYTHON if VENV_PYTHON.exists() else sys.executable)
    BIO_DATA.mkdir(parents=True, exist_ok=True)
    log = BIO_DATA / f"{Path(script).stem}.log"
    with log.open("a", encoding="utf-8") as handle:
        handle.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        handle.flush()
        subprocess.run(
            [python, str(BIO_SRC / script), "--html", str(BIO_PAGE), "--out", str(BIO_DATA)],
            stdout=handle, stderr=subprocess.STDOUT, timeout=1800, check=False,
        )


def _loop(script: str, interval: int) -> None:
    while True:
        try:
            _run_fetcher(script)
        except Exception:  # noqa: BLE001 - keep the refresher alive
            pass
        time.sleep(interval)


def start_refreshers() -> None:
    for script, interval in (("fetch_news.py", NEWS_INTERVAL), ("fetch_reports.py", REPORTS_INTERVAL)):
        threading.Thread(target=_loop, args=(script, interval), name=f"bio-{script}", daemon=True).start()
