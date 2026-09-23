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
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BIO_SRC = PROJECT_ROOT / "bio-studyboard"
BIO_PAGE = BIO_SRC / "standalone.html"
BIO_DATA = PROJECT_ROOT / "data" / "biostudy"
VENV_PYTHON = PROJECT_ROOT / ".venv" / "bin" / "python"
ANALYSIS_DIR = BIO_DATA / "analysis"
CLAUDE_BIN = Path.home() / ".npm-global" / "bin" / "claude"
ANALYSIS_TIMEOUT = 20 * 60
ANALYSIS_COOLDOWN = 10 * 60
KEY_RE = re.compile(r"^[0-9A-Z][0-9A-Z.]{0,11}$")

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
        symbols = {**analyzed_symbols(), **page_symbols()}

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
    if not relative.startswith(("reports/", "news/", "analysis/")):
        return None
    root = BIO_DATA.resolve()
    path = (root / relative).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return path


def _run_fetcher(script: str, extra: list[str] | None = None) -> None:
    python = str(VENV_PYTHON if VENV_PYTHON.exists() else sys.executable)
    BIO_DATA.mkdir(parents=True, exist_ok=True)
    log = BIO_DATA / f"{Path(script).stem}.log"
    with log.open("a", encoding="utf-8") as handle:
        handle.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
        handle.flush()
        subprocess.run(
            [python, str(BIO_SRC / script), *(extra or ["--html", str(BIO_PAGE)]), "--out", str(BIO_DATA)],
            stdout=handle, stderr=subprocess.STDOUT, timeout=1800, check=False,
        )


def _loop(script: str, interval: int) -> None:
    while True:
        try:
            _run_fetcher(script)
            added = [key for key, region in analyzed_symbols().items() if region == "kr" and key.isdigit()]
            if script == "fetch_reports.py" and added:
                _run_fetcher(script, ["--codes", ",".join(added)])
        except Exception:  # noqa: BLE001 - keep the refresher alive
            pass
        time.sleep(interval)


def start_refreshers() -> None:
    for script, interval in (("fetch_news.py", NEWS_INTERVAL), ("fetch_reports.py", REPORTS_INTERVAL)):
        threading.Thread(target=_loop, args=(script, interval), name=f"bio-{script}", daemon=True).start()


# ---------------------------------------------------------------- search
_toss = None


def _toss_lookup(symbols: list[str]) -> dict[str, dict]:
    """Confirm candidates against Toss (it only looks up by symbol, it has no name search)."""
    global _toss
    if not symbols:
        return {}
    try:
        if _toss is None:
            from toss_api import TossBroker
            _toss = TossBroker()
        result = _toss._request("GET", "/api/v1/stocks?symbols=" + ",".join(symbols)).get("result") or []
    except Exception:  # noqa: BLE001 - search still works from Naver alone
        return {}
    return {str(x.get("symbol")): x for x in result if isinstance(x, dict)}


def search(query: str) -> dict[str, object]:
    query = query.strip()[:40]
    if not query:
        return {"ok": True, "items": []}
    url = "https://ac.stock.naver.com/ac?" + urllib.parse.urlencode({"q": query, "target": "stock,worldstock"})
    try:
        raw = _get_json(url).get("items") or []
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "error": f"검색 실패: {error}", "items": []}
    candidates = []
    for x in raw:
        nation = x.get("nationCode")
        if nation not in {"KOR", "USA"} or x.get("category") != "stock":
            continue
        candidates.append({
            "code": str(x.get("code") or ""), "name": x.get("name") or "",
            "market": x.get("typeCode") or "", "region": "kr" if nation == "KOR" else "gl",
        })
    candidates = [c for c in candidates if KEY_RE.match(c["code"])][:10]
    toss = _toss_lookup([c["code"] for c in candidates])
    for c in candidates:
        t = toss.get(c["code"])
        c["toss"] = bool(t)
        if t:
            c["name"] = t.get("name") or c["name"]
            c["englishName"] = t.get("englishName")
            c["market"] = t.get("market") or c["market"]
            c["securityType"] = t.get("securityType")
    return {"ok": True, "items": candidates}


# ---------------------------------------------------------------- AI analysis
_SRC = {"type": "array", "items": {"type": "object", "properties": {"title": {"type": "string"}, "url": {"type": "string"}}, "required": ["title", "url"]}}
ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "platform": {"type": "string", "description": "핵심 기술/플랫폼 한 줄 요약"},
        "summary": {"type": "string", "description": "투자 관점 3~5문장 요약"},
        "clinical": {"type": "object", "properties": {
            "status": {"type": "string", "enum": ["good", "neutral", "warn", "crit"]},
            "statusLabel": {"type": "string"}, "note": {"type": "string"}},
            "required": ["status", "statusLabel", "note"]},
        "pipeline": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "ind": {"type": "string", "description": "적응증·모달리티"},
            "phase": {"type": "integer", "minimum": 0, "maximum": 4},
            "phaseLabel": {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4},
            "whatItIs": {"type": "string"}, "efficacy": {"type": "string"},
            "note": {"type": "string"}, "next": {"type": "string"}, "sources": _SRC},
            "required": ["name", "ind", "phase", "phaseLabel", "note"]}},
        "stock": {"type": "object", "properties": {
            "target": {"type": "string", "description": "증권사 평균/범위 목표주가, 통화기호 없이. 없으면 —"},
            "targetDate": {"type": "string"}, "note": {"type": "string"}},
            "required": ["target", "note"]},
        "funding": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "amt": {"type": "string"}, "date": {"type": "string"}, "desc": {"type": "string"}},
            "required": ["title", "amt", "date", "desc"]}},
        "reports": {"type": "array", "items": {"type": "object", "properties": {
            "date": {"type": "string"}, "broker": {"type": "string"}, "title": {"type": "string"},
            "opinion": {"type": "string"}, "target": {"type": "string"}, "url": {"type": "string"}},
            "required": ["date", "broker", "title"]}},
        "events": {"type": "array", "items": {"type": "object", "properties": {
            "date": {"type": "string"}, "label": {"type": "string"}}, "required": ["date", "label"]}},
        "patents": {"type": "object", "properties": {
            "overview": {"type": "string", "description": "특허 절벽 위험 1~2문장"},
            "drugs": {"type": "array", "maxItems": 4, "items": {"type": "object", "properties": {
                "name": {"type": "string"}, "status": {"type": "string"},
                "expiryUS": {"type": "string"}, "expiryOther": {"type": "string"},
                "yearsLeft": {"type": "string", "description": "오늘 기준 남은 기간"},
                "note": {"type": "string"}, "sources": _SRC},
                "required": ["name", "status", "expiryUS", "expiryOther", "yearsLeft", "note"]}}},
            "required": ["overview", "drugs"]},
        "competitors": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "ticker": {"type": "string", "description": "예: 128940·KOSPI, LLY·NYSE, 비상장"},
            "field": {"type": "string", "description": "겹치는 사업/기술 영역"},
            "why": {"type": "string"}, "compare": {"type": "string", "description": "대상 기업 대비 강점·약점"},
            "sources": _SRC}, "required": ["name", "ticker", "field", "why", "compare"]}},
        "sources": _SRC,
    },
    "required": ["platform", "summary", "clinical", "pipeline", "stock", "funding", "patents", "competitors", "sources"],
}

_jobs_lock = threading.Lock()
_running: set[str] = set()


def _analysis_path(key: str) -> Path:
    return ANALYSIS_DIR / f"{key}.json"


def _write_status(key: str, payload: dict) -> None:
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _analysis_path(key).with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(_analysis_path(key))


def analyzed_symbols() -> dict[str, str]:
    symbols = {}
    for path in ANALYSIS_DIR.glob("*.json") if ANALYSIS_DIR.exists() else []:
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
            symbols[meta["key"]] = meta["region"]
        except (OSError, ValueError, KeyError):
            continue
    return symbols


def _prompt(name: str, key: str, market: str, region: str) -> str:
    today = time.strftime("%Y-%m-%d")
    where = "국내(한국) 상장" if region == "kr" else "해외(미국) 상장"
    return f"""오늘은 {today}입니다. 바이오 투자 학습용 대시보드에 넣을 기업 분석을 해주세요.

대상: {name} (종목코드 {key}, {market}, {where})

웹 검색으로 최신 자료를 충분히 찾아서 조사하세요:
- 핵심 기술/플랫폼, 주요 파이프라인(단계·적응증·효과 데이터·다음 이벤트), 최근 임상 결과
- 기술수출·파트너십·유상증자 등 자금 현황, 현금 소진 리스크
- 증권사/애널리스트 목표주가와 의견 (국내는 최근 증권사 리포트, 해외는 컨센서스)
- 향후 주요 일정(톱라인, 학회 발표, PDUFA 등)
- 주요 제품/신약/플랫폼(최대 4개)의 핵심 특허·독점권 만료 연도와 남은 기간
- 업계 주요 경쟁사 Top 3 (핵심 사업·기술과 직접 경쟁하는 곳, 중요도 순, 상장사 우선)

작성 규칙:
- 모든 설명은 한국어, 초보 투자자도 이해할 수 있게 짧고 명확하게.
- 확인한 사실만 쓰고, 추정은 '추정'이라고 표시. 날짜는 YY.MM.DD 또는 YY.MM 형식.
- pipeline 은 중요한 순서로 최대 6개. phase 는 phaseLabel 4단계 중 현재 도달한 단계 번호(0~4).
- 각 주장에 근거가 된 기사/공시 URL 을 sources 에 넣으세요 (실제 방문한 URL만).
- clinical.status: good(긍정 모멘텀) / neutral / warn(불확실성) / crit(심각한 악재).
"""


def _run_analysis(key: str, name: str, market: str, region: str) -> None:
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    base = {"key": key, "name": name, "market": market, "region": region, "startedAt": started}
    try:
        workdir = ANALYSIS_DIR / "work"
        workdir.mkdir(parents=True, exist_ok=True)
        claude = str(CLAUDE_BIN if CLAUDE_BIN.exists() else "claude")
        proc = subprocess.run(
            [claude, "-p", _prompt(name, key, market, region),
             "--output-format", "json", "--json-schema", json.dumps(ANALYSIS_SCHEMA),
             "--allowedTools", "WebSearch,WebFetch", "--no-session-persistence",
             "--setting-sources", "", "--strict-mcp-config"],
            cwd=workdir, capture_output=True, text=True, timeout=ANALYSIS_TIMEOUT, check=False,
        )
        result = json.loads(proc.stdout or "{}")
        data = result.get("structured_output")
        if proc.returncode != 0 or result.get("is_error") or not isinstance(data, dict):
            raise RuntimeError((result.get("result") or proc.stderr or "분석 결과가 비어 있습니다.")[:500])
        _write_status(key, {**base, "status": "done", "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "data": data})
    except Exception as error:  # noqa: BLE001 - surface any failure to the page
        _write_status(key, {**base, "status": "error", "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "error": str(error)[:500]})
    finally:
        with _jobs_lock:
            _running.discard(key)
    if region == "kr" and key.isdigit():
        try:
            _run_fetcher("fetch_reports.py", ["--codes", key])
        except Exception:  # noqa: BLE001
            pass


def start_analysis(body: dict) -> dict[str, object]:
    key = str(body.get("key") or "").strip().upper()
    name = str(body.get("name") or "").strip()[:60]
    market = str(body.get("market") or "").strip()[:20]
    region = "kr" if body.get("region") == "kr" else "gl"
    if not KEY_RE.match(key) or not name:
        raise ValueError("종목코드와 기업명이 필요합니다.")
    with _jobs_lock:
        if key in _running:
            return {"ok": True, "status": "running"}
        path = _analysis_path(key)
        if path.exists() and not body.get("force"):
            try:
                previous = json.loads(path.read_text(encoding="utf-8"))
                if previous.get("status") == "done" and time.time() - path.stat().st_mtime < ANALYSIS_COOLDOWN:
                    return {"ok": True, "status": "done"}
            except (OSError, ValueError):
                pass
        if len(_running) >= 2:
            raise ValueError("이미 분석이 2건 진행 중입니다. 잠시 후 다시 시도하세요.")
        _running.add(key)
    _write_status(key, {"key": key, "name": name, "market": market, "region": region,
                        "startedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "status": "running"})
    threading.Thread(target=_run_analysis, args=(key, name, market, region), name=f"bio-ai-{key}", daemon=True).start()
    return {"ok": True, "status": "running"}
