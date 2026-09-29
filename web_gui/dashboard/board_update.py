"""One-click AI refresh of a study board's curated content (bio / semi).

The boards embed a hand-curated catalyst calendar, summarized news and a macro
strip in their static HTML. This module lets the page's "AI 업데이트" button ask
Claude (Sonnet 5.5, medium effort, web search) to refresh those, and stores the
result as data/<board>/update/latest.json. The page overlays that file on top of
the embedded data, so the HTML source stays untouched and the refresh survives
restarts.
"""
from __future__ import annotations

import json
import re
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

MODEL = "claude-sonnet-5-5"
EFFORT = "medium"
UPDATE_TIMEOUT = 25 * 60
NEWS_KEEP_DAYS = 35
NEWS_KEEP_MAX = 100
STATUSES = ("good", "neutral", "warn", "crit")
IMPACTS = ("positive", "negative", "mixed")
REGIONS = ("kr", "gl")
PARTS = ("all", "calendar", "news")   # calendar = catalyst calendar + macro strip


@dataclass
class Board:
    label: str              # e.g. "바이오"
    topic: str              # e.g. "바이오·제약", used in prompts
    page: Path
    data_dir: Path
    claude_bin: Path
    news_cats: dict[str, str]     # category key -> Korean label
    macro_hint: str               # what the 4 macro cells should track
    calendar_hint: str            # what belongs on the catalyst calendar
    after: list[Callable[[], None]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    running: bool = False

    @property
    def path(self) -> Path:
        return self.data_dir / "update" / "latest.json"


def run_claude(board: Board, prompt: str, schema: dict, *, web: bool, timeout: int = UPDATE_TIMEOUT) -> dict:
    """Run one headless Claude call with structured output and return the parsed object."""
    workdir = board.data_dir / "update" / "work"
    workdir.mkdir(parents=True, exist_ok=True)
    claude = str(board.claude_bin if board.claude_bin.exists() else "claude")
    tools = ["--allowedTools", "WebSearch,WebFetch"] if web else ["--tools", ""]
    proc = subprocess.run(
        [claude, "-p", prompt, "--model", MODEL, "--effort", EFFORT,
         "--output-format", "json", "--json-schema", json.dumps(schema),
         *tools, "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"],
        cwd=workdir, capture_output=True, text=True, timeout=timeout, check=False,
    )
    result = json.loads(proc.stdout or "{}")
    data = result.get("structured_output")
    if proc.returncode != 0 or result.get("is_error") or not isinstance(data, dict):
        raise RuntimeError((result.get("result") or proc.stderr or "결과가 비어 있습니다.")[:500])
    return data


# ---------------------------------------------------------------- reading the page
def _page_text(board: Board) -> str:
    return board.page.read_text(encoding="utf-8")


def embedded_events(text: str) -> str:
    match = re.search(r"var events = \[\n(.*?)\n  \];", text, re.S)
    return match.group(1) if match else ""


def embedded_macro(text: str) -> str:
    match = re.search(r'<div class="macro"[^>]*>(.*?)\n    </div>\n  </div>\n</header>', text, re.S)
    if not match:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"</?(?:div)[^>]*>", "\n", match.group(1))).strip()


def embedded_news(text: str) -> list[dict]:
    match = re.search(r"var NEWS = (\[.*\]);\n", text)
    try:
        return json.loads(match.group(1)) if match else []
    except ValueError:
        return []


def company_ids(text: str) -> dict[str, str]:
    return dict(re.findall(r'\bid:"([a-z0-9]+)", name:"([^"]+)"', text))


def load_update(board: Board) -> dict | None:
    try:
        return json.loads(board.path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write(board: Board, payload: dict) -> None:
    board.path.parent.mkdir(parents=True, exist_ok=True)
    tmp = board.path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(board.path)


# ---------------------------------------------------------------- schema / prompt
def schema(board: Board, ids: list[str], part: str) -> dict:
    src = {"type": "string", "description": "실제 방문한 기사/공시 URL"}
    full = {
        "type": "object",
        "properties": {
            "macro": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "object", "properties": {
                "label": {"type": "string"},
                "value": {"type": "string", "description": "핵심 수치 (예: +36%, 3.75–4.00%)"},
                "unit": {"type": "string", "description": "value 옆 작은 글씨 (예: YTD). 없으면 빈 문자열"},
                "sub": {"type": "string", "description": "기준일·맥락 한 줄"},
                "tone": {"type": "string", "enum": ["up", "down", "flat"]}},
                "required": ["label", "value", "unit", "sub", "tone"]}},
            "events": {"type": "array", "minItems": 6, "maxItems": 24, "items": {"type": "object", "properties": {
                "date": {"type": "string", "description": "MM.DD, MM.DD~DD, '10월', '10월 초' 같은 형식"},
                "label": {"type": "string"},
                "desc": {"type": "string", "description": "1~2문장, 왜 중요한지 포함"},
                "status": {"type": "string", "enum": list(STATUSES)},
                "past": {"type": "boolean", "description": "오늘 기준 이미 지난 일이면 true"}},
                "required": ["date", "label", "desc", "status", "past"]}},
            "news": {"type": "array", "maxItems": 30, "items": {"type": "object", "properties": {
                "date": {"type": "string", "description": "YYYY-MM-DD 기사 날짜"},
                "region": {"type": "string", "enum": list(REGIONS)},
                "category": {"type": "string", "enum": list(board.news_cats)},
                "companies": {"type": "array", "items": {"type": "string", "enum": ids}, "description": "관련 수록 기업 id (없으면 빈 배열)"},
                "companyLabel": {"type": "string", "description": "수록 기업이 아니면 기업명, 아니면 빈 문자열"},
                "title": {"type": "string"},
                "summary": {"type": "string", "description": "2~3문장 한국어 요약"},
                "why": {"type": "string", "description": "초보 투자자에게 왜 중요한지 1문장"},
                "impact": {"type": "string", "enum": list(IMPACTS)},
                "source": {"type": "string", "description": "매체명"},
                "url": src},
                "required": ["date", "region", "category", "companies", "companyLabel", "title", "summary", "why", "impact", "source", "url"]}},
            "summary": {"type": "string", "description": "이번 업데이트에서 바뀐 핵심을 2~3문장으로"},
        },
        "required": ["macro", "events", "news", "summary"],
    }
    keep = {"calendar": ("macro", "events"), "news": ("news",)}.get(part, ("macro", "events", "news"))
    return {**full, "properties": {k: v for k, v in full["properties"].items() if k in keep or k == "summary"},
            "required": [*keep, "summary"]}


def prompt(board: Board, text: str, ids: dict[str, str], part: str, since: dict[str, str], recent: list[dict]) -> str:
    today = time.strftime("%Y-%m-%d")
    cats = ", ".join(f"{k}({v})" for k, v in board.news_cats.items())
    names = ", ".join(f"{k}={v}" for k, v in ids.items())
    calendar = f"""[촉매 캘린더(events)] 현재 내용 ({since["calendar"]} 무렵까지 반영):
{embedded_events(text)}

- {board.calendar_hint}
- 위 목록을 바탕으로 최신 전체 목록을 다시 작성하세요. 이미 일어난 일은 past=true 로 바꾸고 결과를 반영해 설명을 고치세요.
- 예정 일정이 연기·취소·확정되었으면 반영하고, 새로 확인한 예정 일정은 추가하세요. 너무 오래된(약 2개월 전) 항목은 빼도 됩니다.
- 날짜순(오래된 것 → 먼 미래)으로 정렬하세요. 확인되지 않은 날짜는 '10월 하순'처럼 대략적으로 쓰고 desc 에 '추정'이라고 표시하세요.

[상단 지표 4칸(macro)] 현재 내용:
{embedded_macro(text)}

- {board.macro_hint}
- 같은 4개 지표를 최신 수치로 갱신하세요(지표 자체가 더 이상 의미 없으면 비슷한 성격의 다른 지표로 교체 가능). sub 에 기준일을 밝히세요."""
    have = "\n".join(f"- {n.get('date', '')} {n.get('title', '')}" for n in recent[:40])
    news = f"""[큐레이션 뉴스(news)] {since["news"]} 이후의 새로운 주요 뉴스 최대 25건
- 대시보드에 이미 있는 최근 기사(겹치지 않게):
{have}
- 카테고리: {cats}
- 수록 기업 id: {names}
- 최신순으로, 중요한 소식 위주로.
- summary·why 는 초보 투자자도 이해할 수 있는 한국어로. 확인한 사실만 쓰고 url 은 실제 방문한 기사만."""
    body = "\n\n".join({"calendar": [calendar], "news": [news]}.get(part, [calendar, news]))
    return f"""오늘은 {today}입니다. {board.topic} 투자 학습용 대시보드의 큐레이션 콘텐츠를 최신으로 갱신해 주세요.
웹 검색으로 대시보드 기준일 이후 소식을 충분히 찾아 반영하세요.

{body}

모든 설명은 한국어. 확인하지 못한 내용을 지어내지 마세요. summary 에는 이번에 바뀐 핵심과 확인하지 못한 부분을 밝혀 주세요.
"""


# ---------------------------------------------------------------- validation / merge
def _clean_url(url: str) -> str:
    return url if re.match(r"^https?://", url or "", re.I) else ""


def _clean_news(items: list[dict], ids: set[str], cats: set[str]) -> list[dict]:
    out = []
    for item in items:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(item.get("date", ""))) or not item.get("title"):
            continue
        out.append({
            "date": item["date"], "region": item.get("region") if item.get("region") in REGIONS else "gl",
            "category": item.get("category") if item.get("category") in cats else "finance",
            "companies": [c for c in item.get("companies", []) if c in ids],
            "companyLabel": str(item.get("companyLabel", ""))[:60],
            "title": str(item["title"])[:200], "summary": str(item.get("summary", ""))[:600],
            "why": str(item.get("why", ""))[:300],
            "impact": item.get("impact") if item.get("impact") in IMPACTS else "mixed",
            "source": str(item.get("source", ""))[:40], "url": _clean_url(str(item.get("url", ""))),
        })
    return out


def _merge_news(new: list[dict], old: list[dict]) -> list[dict]:
    seen = {n["url"] for n in new if n["url"]} | {n["title"] for n in new}
    kept = [o for o in old if o.get("url") not in seen and o.get("title") not in seen]
    cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - NEWS_KEEP_DAYS * 86400))
    merged = [n for n in new + kept if n["date"] >= cutoff]
    merged.sort(key=lambda n: n["date"], reverse=True)
    return merged[:NEWS_KEEP_MAX]


def _clean_events(items: list[dict]) -> list[dict]:
    return [{
        "date": str(e["date"])[:20], "label": str(e["label"])[:160], "desc": str(e.get("desc", ""))[:500],
        "status": e.get("status") if e.get("status") in STATUSES else "neutral", "past": bool(e.get("past")),
    } for e in items if e.get("date") and e.get("label")]


def _clean_macro(items: list[dict]) -> list[dict]:
    return [{
        "label": str(m["label"])[:60], "value": str(m["value"])[:30], "unit": str(m.get("unit", ""))[:12],
        "sub": str(m.get("sub", ""))[:120], "tone": m.get("tone") if m.get("tone") in ("up", "down", "flat") else "flat",
    } for m in items if m.get("label") and m.get("value")]


# ---------------------------------------------------------------- job
def _page_date(text: str) -> str:
    match = re.search(r"업데이트 (\d{4})\.(\d{2})\.(\d{2})", text)
    return "-".join(match.groups()) if match else "최근"


def _run(board: Board, part: str) -> None:
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    previous = load_update(board)
    try:
        text = _page_text(board)
        ids = company_ids(text)
        old = (previous or {}).get("data") or {}
        old_news = old.get("news") or embedded_news(text)
        parts = dict(old.get("parts") or {})
        since = {"calendar": str(parts.get("calendar", ""))[:10] or _page_date(text),
                 "news": max((n.get("date", "") for n in old_news), default="") or _page_date(text)}
        data = run_claude(board, prompt(board, text, ids, part, since, old_news), schema(board, list(ids), part), web=True)
        new = dict(old)
        finished = time.strftime("%Y-%m-%d %H:%M:%S")
        if part in ("all", "calendar"):
            events, macro = _clean_events(data.get("events", [])), _clean_macro(data.get("macro", []))
            if len(events) < 3 or len(macro) != 4:
                raise RuntimeError("캘린더 또는 지표 결과가 불완전합니다.")
            new.update(events=events, macro=macro)
            parts["calendar"] = finished
        if part in ("all", "news"):
            new["news"] = _merge_news(_clean_news(data.get("news", []), set(ids), set(board.news_cats)), old_news)
            parts["news"] = finished
        new.update(asOf=time.strftime("%Y.%m.%d"), parts=parts, summary=str(data.get("summary", ""))[:600])
        _write(board, {"status": "done", "part": part, "startedAt": started, "finishedAt": finished,
                       "model": f"{MODEL} · {EFFORT}", "data": new})
    except Exception as error:  # noqa: BLE001 - surface any failure to the page, keep the last good data
        _write(board, {**(previous or {}), "status": "error", "part": part, "startedAt": started,
                       "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "error": str(error)[:500]})
    finally:
        with board.lock:
            board.running = False
    if part == "all":
        for step in board.after:
            try:
                step()
            except Exception:  # noqa: BLE001 - optional follow-ups never fail the update
                pass


def reset_stale(board: Board) -> None:
    """A restart kills the worker thread; don't leave the page waiting on a dead job."""
    previous = load_update(board)
    if previous and previous.get("status") == "running":
        _write(board, {**previous, "status": "error", "error": "서버가 재시작되어 업데이트가 중단되었어요. 다시 눌러 주세요."})


def start_update(board: Board, part: str = "all") -> dict[str, object]:
    if part not in PARTS:
        raise ValueError("알 수 없는 업데이트 범위입니다.")
    with board.lock:
        if board.running:
            return {"ok": True, "status": "running"}
        board.running = True
    previous = load_update(board) or {}
    _write(board, {**previous, "status": "running", "part": part, "startedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "error": ""})
    threading.Thread(target=_run, args=(board, part), name=f"{board.label}-update", daemon=True).start()
    return {"ok": True, "status": "running"}
