"""Daily holdings snapshot (KR + US) sent to Telegram. Read-only: only lists holdings."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from decimal import Decimal, InvalidOperation
from html import escape
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

from local_env import load_env

KST = ZoneInfo("Asia/Seoul")
_WEEKDAYS = "월화수목금토일"
_RULE = "──────────"
ZERO = Decimal("0")


def _dec(value: object) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return ZERO


def _text(value: object) -> str:
    return escape(str(value), quote=False)


def _rate(fraction: Decimal) -> str:
    """Fraction (-0.0191) -> '▼1.9%'."""
    pct = fraction * 100
    if abs(pct) < Decimal("0.05"):
        return "0.0%"
    return f"{'▲' if pct > 0 else '▼'}{abs(pct):.1f}%"


def _krw(value: Decimal) -> str:
    return f"₩{value:,.0f}"


def _usd(value: Decimal) -> str:
    return f"${value:,.2f}"


def _signed(value: Decimal, fmt: Callable[[Decimal], str]) -> str:
    return f"{'+' if value >= 0 else '-'}{fmt(abs(value))}"


def _qty(value: Decimal) -> str:
    return f"{value:,.0f}" if value == value.to_integral_value() else f"{value:,.2f}".rstrip("0").rstrip(".")


def _items(raw: dict) -> list[dict]:
    result = raw.get("result") if isinstance(raw, dict) else None
    items = result.get("items") if isinstance(result, dict) else None
    return [item for item in items or [] if isinstance(item, dict)]


class _Bucket:
    """Holdings of one currency with their summed totals."""

    def __init__(self, country: str) -> None:
        self.country = country
        self.items: list[dict] = []
        self.value = self.cost = self.pnl = self.day = ZERO

    def add(self, item: dict) -> None:
        market = item.get("marketValue") or {}
        self.items.append(item)
        self.value += _dec(market.get("amount"))
        self.cost += _dec(market.get("purchaseAmount"))
        self.pnl += _dec((item.get("profitLoss") or {}).get("amount"))
        self.day += _dec((item.get("dailyProfitLoss") or {}).get("amount"))

    @property
    def pnl_rate(self) -> Decimal:
        return self.pnl / self.cost if self.cost else ZERO

    @property
    def day_rate(self) -> Decimal:
        base = self.value - self.day
        return self.day / base if base else ZERO


def _split(raw: dict) -> tuple[_Bucket, _Bucket]:
    kr, us = _Bucket("KR"), _Bucket("US")
    for item in _items(raw):
        if _dec(item.get("quantity")) <= 0:
            continue
        (kr if str(item.get("marketCountry")).upper() == "KR" else us).add(item)
    for bucket in (kr, us):
        bucket.items.sort(key=lambda row: _dec((row.get("marketValue") or {}).get("amount")), reverse=True)
    return kr, us


def _item_lines(item: dict, bucket: _Bucket, cycle: str | None) -> list[str]:
    domestic = bucket.country == "KR"
    money = _krw if domestic else _usd
    price = _krw if domestic else _usd
    name = item.get("name") if domestic else item.get("symbol")
    value = _dec((item.get("marketValue") or {}).get("amount"))
    pl = item.get("profitLoss") or {}
    day = item.get("dailyProfitLoss") or {}
    title = f"<b>{_text(name or item.get('symbol'))}</b>  {_qty(_dec(item.get('quantity')))}주 · {money(value)}"
    if cycle:
        title += f"  ♾️ {_text(cycle)}"
    return [
        title,
        f"평단 {price(_dec(item.get('averagePurchasePrice')))} → 현재 {price(_dec(item.get('lastPrice')))}"
        f"  {_rate(_dec(pl.get('rate')))}  ·  오늘 {_rate(_dec(day.get('rate')))}",
        "",
    ]


def _section(bucket: _Bucket, cycles: dict[str, str]) -> str | None:
    if not bucket.items:
        return None
    domestic = bucket.country == "KR"
    money = _krw if domestic else _usd
    head = "🇰🇷 <b>국내 주식</b>" if domestic else "🇺🇸 <b>미국 주식</b>"
    lines = [
        f"{head}  ·  {len(bucket.items)}종목  ·  평가 {money(bucket.value)}",
        f"손익 {_signed(bucket.pnl, money)} ({_rate(bucket.pnl_rate)})  ·  오늘 {_signed(bucket.day, money)} ({_rate(bucket.day_rate)})",
        _RULE,
    ]
    for item in bucket.items:
        lines.extend(_item_lines(item, bucket, cycles.get(str(item.get("symbol")))))
    return "\n".join(lines).rstrip()


def _overview(kr: _Bucket, us: _Bucket, now: datetime) -> str:
    """Header with one line per currency (no FX conversion: won stays won, dollars stay dollars)."""
    local = now.astimezone(KST)
    return "\n".join([
        f"📒 <b>보유 종목 현황</b>  ·  {local.month}/{local.day}({_WEEKDAYS[local.weekday()]}) {local.hour:02d}:{local.minute:02d}",
        "",
        f"🇰🇷 국내  <b>{_krw(kr.value)}</b>  ({_rate(kr.pnl_rate)})",
        f"🇺🇸 미국  <b>{_usd(us.value)}</b>  ({_rate(us.pnl_rate)})",
        "<i>괄호는 매입가 대비 손익률, 시세는 조회 시점 기준</i>",
    ])


def build_messages(
    raw: dict, *, now: datetime, cycles: dict[str, str] | None = None,
) -> list[str]:
    """Overview + KR section in the first message, US section in the second."""
    kr, us = _split(raw)
    if not kr.items and not us.items:
        return ["📒 <b>보유 종목 현황</b>\n\n보유 중인 종목이 없습니다."]
    cycles = cycles or {}
    first = [_overview(kr, us, now)]
    kr_section = _section(kr, cycles)
    us_section = _section(us, cycles)
    messages: list[str] = []
    if kr_section:
        first.append(kr_section)
    messages.append("\n\n".join(first))
    if us_section:
        messages.append(us_section)
    return messages


def load_cycle_labels(data_dir: Path) -> dict[str, str]:
    """'T 5.5/40' labels for symbols with an active 무한매수 cycle (best-effort)."""
    try:
        from state_store import StateStore

        runtime = json.loads((data_dir / "runtime.json").read_text(encoding="utf-8"))
        store = StateStore(data_dir / "state.json")
        labels: dict[str, str] = {}
        for symbol in runtime.get("active_symbols", []):
            if (runtime.get("strategy_types") or {}).get(symbol, "MUMAE") != "MUMAE":
                continue
            state = store.load(symbol)
            if state.position_qty > 0:
                t_value = format(state.t_value.normalize(), "f")
                labels[symbol] = f"T {t_value}/{state.split_count}"
        return labels
    except Exception:
        return {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print instead of sending to Telegram")
    parser.add_argument("--force", action="store_true", help="also run on weekends")
    parser.add_argument("--data-dir", default="data")
    args = parser.parse_args(argv)

    now = datetime.now(KST)
    if now.weekday() >= 5 and not args.force:
        print("주말이라 보내지 않습니다. (--force 로 강제 전송)")
        return 0

    load_env()
    from telegram_bot import TelegramNotifier
    from toss_api import TossBroker

    notifier = TelegramNotifier()
    try:
        raw = TossBroker().get_holdings_raw()
        messages = build_messages(raw, now=now, cycles=load_cycle_labels(Path(args.data_dir)))
    except Exception as error:
        print(f"보유 종목 조회 실패: {error}", file=sys.stderr)
        if notifier.enabled and not args.dry_run:
            notifier.send_message(f"⚠️ <b>보유 종목 현황 조회 실패</b>\n<blockquote>{_text(error)}</blockquote>", parse_mode="HTML")
        return 1

    if args.dry_run:
        print("\n\n=====\n\n".join(messages))
        return 0
    if not notifier.enabled:
        print("Telegram 미설정 (MUMAE_TELEGRAM_BOT_TOKEN/CHAT_ID 없음) -- 전송 건너뜀")
        return 1
    for message in messages:
        notifier.send_message(message, parse_mode="HTML")
    print(f"보유 종목 현황 {len(messages)}건 전송")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
