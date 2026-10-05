"""AI study board: one page following the AI boom since 2017 -- the Nasdaq and the stocks
that led each phase (GPU → packaging/HBM → power/network → memory/storage for inference),
a curated event timeline, and a "what is the next bottleneck" map.

Served under /ai/ on the dashboard server. The page embeds the hand-written seed timeline;
the "AI 업데이트" button asks Claude (via board_update.run_claude, Sonnet 5.5 medium + web
search) for events and news since then, stored in data/aistudy/update/latest.json and
overlaid by the page.
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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from web_gui.dashboard import board_update

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PAGE = PROJECT_ROOT / "ai-studyboard" / "standalone.html"
DATA = PROJECT_ROOT / "data" / "aistudy"
CLAUDE_BIN = Path.home() / ".npm-global" / "bin" / "claude"

UA = "Mozilla/5.0"
START = "2017-01-01"
SERIES_TTL = 6 * 3600
QUOTE_TTL = 120
NEWS_TTL = 30 * 60

# Yahoo symbol -> Korean name. The page may only ask for these.
SYMBOLS = {
    "^IXIC": "나스닥 종합", "^SOX": "필라델피아 반도체", "^KS11": "코스피",
    "NVDA": "엔비디아", "AMD": "AMD", "AVGO": "브로드컴", "TSM": "TSMC", "ASML": "ASML",
    "MSFT": "마이크로소프트", "GOOGL": "알파벳", "META": "메타", "AMZN": "아마존", "ORCL": "오라클",
    "SMCI": "슈퍼마이크로", "PLTR": "팔란티어", "CRWV": "코어위브",
    "MU": "마이크론", "000660.KS": "SK하이닉스", "005930.KS": "삼성전자", "042700.KS": "한미반도체",
    "SNDK": "샌디스크", "WDC": "웨스턴디지털", "STX": "씨게이트",
    "ANET": "아리스타", "LITE": "루멘텀", "COHR": "코히런트",
    "VRT": "버티브", "CEG": "컨스텔레이션", "VST": "비스트라", "GEV": "GE 버노바", "BE": "블룸에너지",
    "OKLO": "오클로", "267260.KS": "HD현대일렉트릭", "034020.KS": "두산에너빌리티",
    "ETN": "이튼", "010120.KS": "LS ELECTRIC", "298040.KS": "효성중공업", "MRVL": "마벨", "INTC": "인텔", "ARM": "Arm", "RMBS": "램버스", "688825.SS": "창신메모리(CXMT)", "ALAB": "아스테라랩스", "AMAT": "어플라이드 머티어리얼즈",
    "009150.KS": "삼성전기", "007660.KS": "이수페타시스", "3110.T": "닛토보", "4062.T": "이비덴",
}
TYPES = ("model", "chip", "earnings", "capex", "bottleneck", "policy", "rally", "crash", "macro")
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


def _chart(symbol: str, query: str) -> dict:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{query}"
    return json.loads(_get(url))["chart"]["result"][0]


# ---------------------------------------------------------------- weekly series / live quotes
def _weekly(symbol: str) -> dict | None:
    start = int(time.mktime(time.strptime(START, "%Y-%m-%d")))
    try:
        res = _chart(symbol, f"period1={start}&period2={int(time.time())}&interval=1wk")
    except Exception:  # noqa: BLE001 - one symbol failing must not blank the board
        return None
    pairs = [(t, c) for t, c in zip(res.get("timestamp") or [], res["indicators"]["quote"][0].get("close") or []) if c]
    if not pairs:
        return None
    return {"t": [t for t, _ in pairs], "c": [round(c, 2) for _, c in pairs], "cur": res["meta"].get("currency", "USD")}


def series() -> dict[str, object]:
    """Weekly closes since 2017 for every board symbol, as compact parallel arrays."""
    def build() -> dict:
        with ThreadPoolExecutor(max_workers=8) as pool:
            got = dict(zip(SYMBOLS, pool.map(_weekly, SYMBOLS)))
        out = {sym: {**data, "name": SYMBOLS[sym]} for sym, data in got.items() if data}
        if not out:
            return {"ok": False, "error": "가격 데이터를 가져오지 못했어요."}
        return {"ok": True, "series": out, "generatedAt": time.strftime("%Y-%m-%d %H:%M")}

    return _cached("series", SERIES_TTL, build)


def _quote(symbol: str) -> dict | None:
    try:
        meta = _chart(symbol, "range=1d&interval=1d")["meta"]
    except Exception:  # noqa: BLE001
        return None
    price, prev = float(meta.get("regularMarketPrice") or 0), float(meta.get("chartPreviousClose") or 0)
    if not price:
        return None
    return {"price": price, "change": round((price / prev - 1) * 100, 2) if prev else 0.0, "cur": meta.get("currency", "USD")}


def quotes() -> dict[str, object]:
    """Last price and day change for every board symbol."""
    def build() -> dict:
        with ThreadPoolExecutor(max_workers=8) as pool:
            got = dict(zip(SYMBOLS, pool.map(_quote, SYMBOLS)))
        items = {sym: q for sym, q in got.items() if q}
        if not items:
            return {"ok": False, "error": "시세를 가져오지 못했어요."}
        return {"ok": True, "items": items, "asOf": time.strftime("%Y-%m-%d %H:%M KST")}

    return _cached("quotes", QUOTE_TTL, build)


# ---------------------------------------------------------------- live headlines (Google News RSS)
NEWS_QUERIES = [("kr", "AI 반도체"), ("kr", "HBM 메모리"), ("kr", "AI 데이터센터 전력"),
                ("gl", "Nvidia AI"), ("gl", "AI data center"), ("gl", "AI memory shortage")]


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
    """Resolve /ai/update/... to a file inside DATA, refusing traversal."""
    if not relative.startswith("update/"):
        return None
    root = DATA.resolve()
    path = (root / relative).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return path


# ---------------------------------------------------------------- AI refresh (timeline + news)
UPDATE_BOARD = board_update.Board(
    label="ai", topic="AI 산업·주식", page=PAGE, data_dir=DATA, claude_bin=CLAUDE_BIN,
    news_cats={}, macro_hint="", calendar_hint="",
)
TYPE_LABEL = {"model": "AI 모델 출시", "chip": "칩·하드웨어", "earnings": "실적 서프라이즈", "capex": "투자·계약(capex)",
              "bottleneck": "병목·공급 부족", "policy": "규제·수출통제", "rally": "급등·신고가", "crash": "급락", "macro": "거시경제"}


def embedded_events(text: str) -> list[dict]:
    match = re.search(r"var EVENTS = (\[.*?\]);\n\s*/\*EVENTS:END\*/", text, re.S)
    try:
        return json.loads(match.group(1)) if match else []
    except ValueError:
        return []


def _schema() -> dict:
    event = {"type": "object", "properties": {
        "date": {"type": "string", "description": "YYYY-MM-DD (확인된 날짜)"},
        "type": {"type": "string", "enum": list(TYPES)},
        "impact": {"type": "string", "enum": list(IMPACTS), "description": "AI 관련주에 미친 방향"},
        "title": {"type": "string", "description": "짧은 제목"},
        "desc": {"type": "string", "description": "무슨 일이었고 주가가 어떻게 움직였는지 2~3문장, 해요체"},
        "stocks": {"type": "array", "items": {"type": "string", "enum": list(SYMBOLS)}, "maxItems": 4,
                   "description": "이 사건의 특징주(목록에 있는 심볼만)"},
        "sources": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "url": {"type": "string"}}, "required": ["title", "url"]}}},
        "required": ["date", "type", "impact", "title", "desc", "stocks", "sources"]}
    item = {"type": "object", "properties": {
        "date": {"type": "string", "description": "YYYY-MM-DD"},
        "title": {"type": "string"}, "summary": {"type": "string", "description": "2~3문장 해요체 요약"},
        "why": {"type": "string", "description": "AI 투자 흐름(다음 병목) 관점에서 왜 중요한지 1문장"},
        "impact": {"type": "string", "enum": ["positive", "negative", "mixed"]},
        "source": {"type": "string"}, "url": {"type": "string"}},
        "required": ["date", "title", "summary", "why", "impact", "source", "url"]}
    return {"type": "object", "properties": {
        "events": {"type": "array", "maxItems": 20, "items": event},
        "news": {"type": "array", "maxItems": 20, "items": item},
        "summary": {"type": "string"}}, "required": ["events", "news", "summary"]}


def _prompt(events: list[dict], since: str, news_since: str) -> str:
    listed = "\n".join(f"- {e['date']} [{e['type']}] {e['title']}" for e in events)
    types = ", ".join(f"{k}({v})" for k, v in TYPE_LABEL.items())
    symbols = ", ".join(f"{k}({v})" for k, v in SYMBOLS.items())
    return f"""오늘은 {time.strftime("%Y-%m-%d")}입니다. AI 산업과 관련 주식(나스닥·특징주) 학습용 대시보드의 '히스토리' 타임라인과 뉴스를 갱신해 주세요.
이 보드는 AI 붐이 연산(GPU) → 패키징·HBM → 전력·네트워크 → 추론용 메모리·SSD 순으로 병목을 옮겨 온 흐름과 '다음 병목'을 공부하는 곳이에요.

[현재 타임라인] ({since}까지 반영)
{listed}

[1] events — 웹 검색으로 찾아서 아래를 채우세요.
- {since} 이후 오늘까지 AI 관련 주가에 큰 영향을 준 사건(주요 모델 출시, 칩 발표, 실적 서프라이즈, 빅테크 capex·대형 계약, 공급 부족·가격 급등 같은 병목 신호, 수출통제·규제, 나스닥 급등락).
- 2017년 이후 사건 중 위 목록에 빠진 정말 중요한 사건이 있으면 최대 5건까지 함께 추가하세요(이미 있는 사건은 다시 쓰지 마세요).
- type: {types}
- stocks: 이 목록의 심볼만 → {symbols}
- date 는 실제로 확인한 날짜(YYYY-MM-DD). 주가·실적 수치는 '약'을 붙여 대략적으로, sources 에는 실제 방문한 URL만.

[2] news — {news_since} 이후 AI 산업·관련주 주요 뉴스 최대 15건(최신순, 국내·해외 모두). why 에는 '다음 병목' 관점의 의미를 적으세요.

작성 규칙:
- 모든 설명은 한국어 해요체(~예요/~해요), '제가' 같은 1인칭이나 조사 과정 메모는 쓰지 마세요. 그런 메모는 summary 에만.
- 확인하지 못한 내용은 지어내지 마세요. 투자 권유 표현은 쓰지 마세요.
"""


def load_update() -> dict | None:
    return board_update.load_update(UPDATE_BOARD)


def _clean_event(e: dict) -> dict | None:
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(e.get("date", ""))) or not e.get("title") or e.get("type") not in TYPES:
        return None
    return {"date": e["date"], "type": e["type"],
            "impact": e.get("impact") if e.get("impact") in IMPACTS else "neutral",
            "title": str(e["title"])[:120], "desc": board_update.tidy(e.get("desc", ""))[:600],
            "stocks": [s for s in e.get("stocks", []) if s in SYMBOLS][:4],
            "sources": [{"title": str(s.get("title", ""))[:80], "url": s["url"]} for s in e.get("sources", [])
                        if re.match(r"^https?://", str(s.get("url", "")))][:3]}


def _clean_news(n: dict) -> dict | None:
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(n.get("date", ""))) or not n.get("title"):
        return None
    return {"date": n["date"], "title": str(n["title"])[:200], "summary": board_update.tidy(n.get("summary", ""))[:600],
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
        known = {(e["date"], e["type"]) for e in events}
        for raw in data.get("events", []):
            event = _clean_event(raw)
            if event and (event["date"], event["type"]) not in known:
                known.add((event["date"], event["type"]))
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
    threading.Thread(target=_run_update, name="ai-update", daemon=True).start()
    return {"ok": True, "status": "running"}


def start() -> None:
    board_update.reset_stale(UPDATE_BOARD)
