"""Crypto study board (BTC · ETH): one page with weekly prices since 2018, a curated
event timeline (halvings, ETFs, network upgrades, crashes, rallies, regulation) and news.

Served under /crypto/ on the dashboard server. The page embeds the hand-written seed
timeline; the "AI 업데이트" button asks Claude (via board_update.run_claude, Sonnet 5.5
medium + web search) for events and news since then, stored in
data/cryptostudy/update/latest.json and overlaid by the page.
"""
from __future__ import annotations

import html
import json
import re
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from web_gui.dashboard import board_update

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PAGE = PROJECT_ROOT / "crypto-studyboard" / "standalone.html"
DATA = PROJECT_ROOT / "data" / "cryptostudy"
CLAUDE_BIN = Path.home() / ".npm-global" / "bin" / "claude"

UA = "Mozilla/5.0"
SYMBOLS = {"BTC": "BTC-USD", "ETH": "ETH-USD"}
START = "2018-01-01"
HISTORY_TTL = 6 * 3600
PRICE_TTL = 60
NEWS_TTL = 30 * 60
ASSETS = ("btc", "eth", "both")
TYPES = ("halving", "etf", "upgrade", "rally", "crash", "regulation", "collapse", "adoption", "macro")
IMPACTS = ("up", "down", "neutral")

_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}


def _get(url: str, timeout: int = 10):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _cached(key: str, ttl: int, build):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
    payload = build()
    if payload.get("ok"):
        with _lock:
            _cache[key] = (time.time(), payload)
    return payload


# ---------------------------------------------------------------- prices / history
def _chart(symbol: str, interval: str) -> dict:
    start = int(time.mktime(time.strptime(START, "%Y-%m-%d")))
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?period1={start}&period2={int(time.time())}&interval={interval}")
    return json.loads(_get(url))["chart"]["result"][0]


def history(sym: str) -> dict[str, object]:
    """Weekly closes since 2018 plus the all-time-high daily close in that span."""
    sym = sym.upper()
    if sym not in SYMBOLS:
        return {"ok": False, "error": "BTC 또는 ETH만 지원해요."}

    def build() -> dict:
        try:
            weekly, daily = _chart(SYMBOLS[sym], "1wk"), _chart(SYMBOLS[sym], "1d")
        except Exception as error:  # noqa: BLE001 - surface to the page
            return {"ok": False, "error": str(error)[:200]}
        closes = weekly["indicators"]["quote"][0]["close"]
        points = [{"t": t, "c": round(c, 2)} for t, c in zip(weekly["timestamp"], closes) if c]
        days = [(t, c) for t, c in zip(daily["timestamp"], daily["indicators"]["quote"][0]["close"]) if c]
        ath_t, ath_c = max(days, key=lambda x: x[1])
        return {"ok": True, "symbol": sym, "points": points,
                "ath": {"price": round(ath_c, 2), "date": time.strftime("%Y-%m-%d", time.gmtime(ath_t))}}

    return _cached(f"history:{sym}", HISTORY_TTL, build)


def prices() -> dict[str, object]:
    """USD price and 24h change (Yahoo), KRW price on Upbit, and the kimchi premium."""
    def build() -> dict:
        try:
            usdkrw = float(json.loads(_get("https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?range=1d&interval=1d"))
                           ["chart"]["result"][0]["meta"]["regularMarketPrice"])
            upbit = {x["market"]: x for x in json.loads(_get("https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH"))}
            items = {}
            for sym, ysym in SYMBOLS.items():
                meta = json.loads(_get(f"https://query1.finance.yahoo.com/v8/finance/chart/{ysym}?range=1d&interval=1d"))["chart"]["result"][0]["meta"]
                usd, prev = float(meta["regularMarketPrice"]), float(meta.get("chartPreviousClose") or 0)
                krw = upbit[f"KRW-{sym}"]
                items[sym] = {
                    "usd": usd, "change": round((usd / prev - 1) * 100, 2) if prev else 0.0,
                    "krw": krw["trade_price"], "krwChange": round(krw["signed_change_rate"] * 100, 2),
                    "premium": round((krw["trade_price"] / (usd * usdkrw) - 1) * 100, 2),
                }
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "error": str(error)[:200]}
        return {"ok": True, "usdkrw": usdkrw, "items": items, "asOf": time.strftime("%Y-%m-%d %H:%M KST")}

    return _cached("prices", PRICE_TTL, build)


# ---------------------------------------------------------------- live headlines (Google News RSS)
NEWS_QUERIES = [("kr", "비트코인"), ("kr", "이더리움"), ("gl", "bitcoin"), ("gl", "ethereum")]


def _rss(region: str, query: str) -> list[dict]:
    lang = "hl=ko&gl=KR&ceid=KR:ko" if region == "kr" else "hl=en-US&gl=US&ceid=US:en"
    root = ET.fromstring(_get(f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}+when:7d&{lang}", 15))
    out = []
    for item in root.iter("item"):
        title = html.unescape(item.findtext("title") or "")
        source = item.findtext("source") or ""
        if source and title.endswith(" - " + source):
            title = title[: -len(source) - 3]
        try:
            date = time.strftime("%Y-%m-%d", time.strptime((item.findtext("pubDate") or "")[5:16], "%d %b %Y"))
        except ValueError:
            continue
        out.append({"date": date, "region": region, "title": title, "source": source, "url": item.findtext("link") or ""})
    return out


def news() -> dict[str, object]:
    def build() -> dict:
        items, seen = [], set()
        for region, query in NEWS_QUERIES:
            try:
                found = _rss(region, query)
            except Exception:  # noqa: BLE001 - one feed failing must not blank the rest
                continue
            for item in found:
                key = re.sub(r"\W+", "", item["title"].lower())[:60]
                if key not in seen:
                    seen.add(key)
                    items.append(item)
        items.sort(key=lambda x: x["date"], reverse=True)
        return {"ok": bool(items), "generatedAt": time.strftime("%Y-%m-%d %H:%M"), "items": items[:40]}

    return _cached("news", NEWS_TTL, build)


def data_file(relative: str) -> Path | None:
    """Resolve /crypto/update/... to a file inside DATA, refusing traversal."""
    if not relative.startswith("update/"):
        return None
    root = DATA.resolve()
    path = (root / relative).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return path


# ---------------------------------------------------------------- AI refresh (timeline + news)
UPDATE_BOARD = board_update.Board(
    label="crypto", topic="가상자산(비트코인·이더리움)", page=PAGE, data_dir=DATA, claude_bin=CLAUDE_BIN,
    news_cats={}, macro_hint="", calendar_hint="",
)
TYPE_LABEL = {"halving": "반감기", "etf": "ETF", "upgrade": "네트워크 업그레이드", "rally": "급등·신고가", "crash": "급락",
              "regulation": "규제·정책", "collapse": "파산·해킹", "adoption": "기관·채택", "macro": "거시경제"}


def embedded_events(text: str) -> list[dict]:
    match = re.search(r"var EVENTS = (\[.*?\]);\n\s*/\*EVENTS:END\*/", text, re.S)
    try:
        return json.loads(match.group(1)) if match else []
    except ValueError:
        return []


def _schema() -> dict:
    event = {"type": "object", "properties": {
        "date": {"type": "string", "description": "YYYY-MM-DD (확인된 날짜)"},
        "asset": {"type": "string", "enum": list(ASSETS), "description": "btc / eth / both(시장 전체)"},
        "type": {"type": "string", "enum": list(TYPES)},
        "impact": {"type": "string", "enum": list(IMPACTS), "description": "가격에 미친 방향"},
        "title": {"type": "string", "description": "짧은 제목"},
        "desc": {"type": "string", "description": "무슨 일이었고 가격이 어떻게 움직였는지 2~3문장, 해요체"},
        "sources": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "url": {"type": "string"}}, "required": ["title", "url"]}}},
        "required": ["date", "asset", "type", "impact", "title", "desc", "sources"]}
    item = {"type": "object", "properties": {
        "date": {"type": "string", "description": "YYYY-MM-DD"},
        "asset": {"type": "string", "enum": list(ASSETS)},
        "title": {"type": "string"}, "summary": {"type": "string", "description": "2~3문장 해요체 요약"},
        "why": {"type": "string", "description": "초보 투자자에게 왜 중요한지 1문장"},
        "impact": {"type": "string", "enum": ["positive", "negative", "mixed"]},
        "source": {"type": "string"}, "url": {"type": "string"}},
        "required": ["date", "asset", "title", "summary", "why", "impact", "source", "url"]}
    return {"type": "object", "properties": {
        "events": {"type": "array", "maxItems": 20, "items": event},
        "news": {"type": "array", "maxItems": 20, "items": item},
        "summary": {"type": "string"}}, "required": ["events", "news", "summary"]}


def _prompt(events: list[dict], since: str, news_since: str) -> str:
    listed = "\n".join(f"- {e['date']} [{e['asset']}/{e['type']}] {e['title']}" for e in events)
    types = ", ".join(f"{k}({v})" for k, v in TYPE_LABEL.items())
    return f"""오늘은 {time.strftime("%Y-%m-%d")}입니다. 비트코인·이더리움 투자 학습용 대시보드의 '가격 히스토리' 타임라인과 뉴스를 갱신해 주세요.

[현재 타임라인] ({since}까지 반영)
{listed}

[1] events — 웹 검색으로 찾아서 아래를 채우세요.
- {since} 이후 오늘까지 비트코인·이더리움 가격에 영향을 준 주요 사건(신고가·급락, ETF 자금 흐름, 네트워크 업그레이드, 규제·정책, 거래소 파산·해킹, 거시경제 충격 등).
- 2018년 이후 사건 중 위 목록에 빠진 정말 중요한 사건이 있으면 최대 5건까지 함께 추가하세요(이미 있는 사건은 다시 쓰지 마세요).
- type: {types}
- date 는 실제로 확인한 날짜(YYYY-MM-DD). 가격 수치는 '약'을 붙여 대략적으로, sources 에는 실제 방문한 URL만.

[2] news — {news_since} 이후 비트코인·이더리움 관련 주요 뉴스 최대 15건(최신순, 국내·해외 모두).

작성 규칙:
- 모든 설명은 한국어 해요체(~예요/~해요), '제가' 같은 1인칭이나 조사 과정 메모는 쓰지 마세요. 그런 메모는 summary 에만.
- 확인하지 못한 내용은 지어내지 마세요.
"""


def load_update() -> dict | None:
    return board_update.load_update(UPDATE_BOARD)


def _clean_event(e: dict) -> dict | None:
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(e.get("date", ""))) or not e.get("title"):
        return None
    if e.get("asset") not in ASSETS or e.get("type") not in TYPES:
        return None
    return {"date": e["date"], "asset": e["asset"], "type": e["type"],
            "impact": e.get("impact") if e.get("impact") in IMPACTS else "neutral",
            "title": str(e["title"])[:120], "desc": board_update.tidy(e.get("desc", ""))[:600],
            "sources": [{"title": str(s.get("title", ""))[:80], "url": s["url"]} for s in e.get("sources", [])
                        if re.match(r"^https?://", str(s.get("url", "")))][:3]}


def _clean_news(n: dict) -> dict | None:
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(n.get("date", ""))) or not n.get("title"):
        return None
    return {"date": n["date"], "asset": n.get("asset") if n.get("asset") in ASSETS else "both",
            "title": str(n["title"])[:200], "summary": board_update.tidy(n.get("summary", ""))[:600],
            "why": board_update.tidy(n.get("why", ""))[:300],
            "impact": n.get("impact") if n.get("impact") in ("positive", "negative", "mixed") else "mixed",
            "source": str(n.get("source", ""))[:40],
            "url": n["url"] if re.match(r"^https?://", str(n.get("url", ""))) else ""}


def _run_update() -> None:
    board = UPDATE_BOARD
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    previous = load_update()
    try:
        old = (previous or {}).get("data") or {}
        added, old_news = list(old.get("events") or []), list(old.get("news") or [])
        events = sorted(embedded_events(PAGE.read_text(encoding="utf-8")) + added, key=lambda e: e["date"])
        since = events[-1]["date"] if events else START
        news_since = max((n["date"] for n in old_news), default=since)
        data = board_update.run_claude(board, _prompt(events, since, news_since), _schema(), web=True)
        known = {(e["date"], e["asset"], e["type"]) for e in events}
        for raw in data.get("events", []):
            event = _clean_event(raw)
            if event and (event["date"], event["asset"], event["type"]) not in known:
                known.add((event["date"], event["asset"], event["type"]))
                added.append(event)
        fresh = [n for n in (_clean_news(x) for x in data.get("news", [])) if n]
        seen = {n["url"] or n["title"] for n in fresh}
        cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - 45 * 86400))
        merged = [n for n in fresh + [o for o in old_news if (o.get("url") or o.get("title")) not in seen] if n["date"] >= cutoff]
        merged.sort(key=lambda n: n["date"], reverse=True)
        finished = time.strftime("%Y-%m-%d %H:%M:%S")
        board_update.write_update(board, {"status": "done", "startedAt": started, "finishedAt": finished,
                                    "model": f"{board_update.MODEL} · {board_update.EFFORT}",
                                    "data": {"asOf": time.strftime("%Y.%m.%d"), "events": sorted(added, key=lambda e: e["date"]),
                                             "news": merged[:60], "summary": str(data.get("summary", ""))[:800]}})
    except Exception as error:  # noqa: BLE001 - keep the last good data, show the error
        board_update.write_update(board, {**(previous or {}), "status": "error", "startedAt": started,
                                    "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "error": str(error)[:500]})
    finally:
        with board.lock:
            board.running = False


def start_update() -> dict[str, object]:
    board = UPDATE_BOARD
    with board.lock:
        if board.running:
            return {"ok": True, "status": "running"}
        board.running = True
    previous = load_update() or {}
    board_update.write_update(board, {**previous, "status": "running", "startedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "error": ""})
    threading.Thread(target=_run_update, name="crypto-update", daemon=True).start()
    return {"ok": True, "status": "running"}


def start() -> None:
    board_update.reset_stale(UPDATE_BOARD)
