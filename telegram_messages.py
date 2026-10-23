"""Telegram HTML message layouts for order notifications (formatting only, no I/O)."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from html import escape

REJECT_NOTE = "상세 거절 사유는 토스 주문 목록 API에서 제공되지 않습니다. 토스 앱의 주문 내역을 확인하세요."

_SIDE = {"buy": ("🔴", "매수"), "sell": ("🔵", "매도")}
_ORDER_KIND = {"LIMIT": "지정가", "CLOSE_AUCTION": "종가(LOC)"}
_STATUS = {
    "PENDING": "접수 완료",
    "PARTIAL_FILLED": "부분 체결",
    "FILLED": "체결 완료",
    "PENDING_CANCEL": "취소 대기",
    "PENDING_REPLACE": "정정 대기",
    "UNCONFIRMED": "접수 확인 대기",
    "REJECTED": "거절됨",
    "CANCELED": "취소됨",
    "UNSENT": "미전송",
    "SKIPPED": "건너뜀",
}
_RULE = "──────────"
_MODE = {"GENERAL": "일반", "REVERSE_FIRST_DAY": "리버스 첫날", "REVERSE": "리버스"}
_BAR_WIDTH = 10


@dataclass(frozen=True)
class OrderLine:
    order_id: str
    side: str
    quantity: object
    price: object
    order_kind: str
    status: str
    confirmed: bool


@dataclass(frozen=True)
class Standing:
    """Where the symbol's 무한매수 cycle stands, as of the last quote the service fetched."""

    current_price: Decimal | None
    previous_close: Decimal | None
    avg_cost: Decimal
    position_qty: int
    t_value: Decimal
    split_count: int
    mode: str
    cash_usd: Decimal
    star_price: Decimal | None = None
    take_profit_price: Decimal | None = None
    take_profit_pct: Decimal | None = None


def _text(value: object) -> str:
    return escape(str(value), quote=False)


def _usd(value: Decimal) -> str:
    return f"${value:,.2f}"


def _signed_usd(value: Decimal) -> str:
    return f"{'+' if value >= 0 else '-'}${abs(value):,.2f}"


def _change(now: Decimal, base: Decimal) -> str | None:
    """Percent change with a direction arrow, or None when there is no base to compare to."""
    if base <= 0:
        return None
    pct = (now - base) / base * 100
    arrow = "▲" if pct > 0 else ("▼" if pct < 0 else "–")
    return f"{arrow}{abs(pct):.1f}%"


def _plain(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    return text


def price_line(standing: Standing | None) -> str | None:
    if standing is None or standing.current_price is None or standing.current_price <= 0:
        return None
    line = f"💵 현재가 <b>{_usd(standing.current_price)}</b>"
    day = _change(standing.current_price, standing.previous_close or Decimal("0"))
    return f"{line}  (전일 대비 {day})" if day else line


def standing_block(standing: Standing | None) -> list[str]:
    """Position / average-cost / cycle-progress summary shown at the bottom of an alert."""
    if standing is None:
        return []
    lines = ["📊 <b>현재 상태</b>"]
    if standing.position_qty > 0 and standing.avg_cost > 0:
        avg = f"평단가 <b>{_usd(standing.avg_cost)}</b>"
        if standing.current_price and standing.current_price > 0:
            versus = _change(standing.current_price, standing.avg_cost)
            avg += f"  ·  평단 대비 {versus}" if versus else ""
        lines.append(avg)
        held = f"보유 {standing.position_qty:,}주"
        if standing.current_price and standing.current_price > 0:
            pnl = (standing.current_price - standing.avg_cost) * standing.position_qty
            held += f"  ·  평가손익 {_signed_usd(pnl)}"
        lines.append(held)
    else:
        lines.append("보유 없음 · 첫 매수 대기")
    ratio = standing.t_value / standing.split_count if standing.split_count else Decimal("0")
    filled = max(0, min(_BAR_WIDTH, int((ratio * _BAR_WIDTH).to_integral_value())))
    bar = "▰" * filled + "▱" * (_BAR_WIDTH - filled)
    mode = _MODE.get(standing.mode, _text(standing.mode))
    lines.append(
        f"진행 T <b>{_plain(standing.t_value)}</b> / {standing.split_count}회  {bar} "
        f"{ratio * 100:.1f}%  ·  {mode} 모드"
    )
    targets = []
    if standing.star_price is not None and standing.position_qty > 0:
        targets.append(f"별가격 {_usd(standing.star_price)}")
    if standing.take_profit_price is not None and standing.position_qty > 0:
        pct = f" (+{_plain(standing.take_profit_pct)}%)" if standing.take_profit_pct is not None else ""
        targets.append(f"익절 목표 {_usd(standing.take_profit_price)}{pct}")
    if targets:
        lines.append("  ·  ".join(targets))
    lines.append(f"잔여 현금 {_usd(standing.cash_usd)}")
    return lines


def _order_block(line: OrderLine) -> list[str]:
    emoji, side_label = _SIDE.get(line.side, ("▫️", _text(line.side or "주문")))
    status_label = _STATUS.get(line.status, _text(line.status or "상태 불명"))
    kind_label = _ORDER_KIND.get(line.order_kind, _text(line.order_kind))
    state_icon = "✅" if line.confirmed else ("⏳" if line.status == "UNCONFIRMED" else "❌")
    detail = f"{kind_label} · " if kind_label else ""
    return [
        f"{emoji} <b>{side_label}</b>  {_text(line.quantity)}주 × ${_text(line.price)}",
        f"{state_icon} {detail}{status_label}",
        f"<code>{_text(line.order_id)}</code>",
    ]


def auto_result_message(
    symbol: str,
    lines: list[OrderLine],
    errors: list[str],
    retry_ids: list[str],
    *,
    rejected_seen: bool = False,
    standing: Standing | None = None,
) -> str:
    """Summary of one auto-order batch: one block per order, then totals, retry hints and status."""
    parts = [f"🤖 <b>{_text(symbol)}</b> 자동주문"]
    quote = price_line(standing)
    if quote:
        parts.append(quote)
    parts.append("")
    for line in lines:
        parts.extend(_order_block(line))
        parts.append("")
    ok = sum(1 for line in lines if line.confirmed)
    # 접수 확인 대기(UNCONFIRMED)는 실패가 아니다: 실패로 세면 이미 들어간 주문을 다시 넣게 만들 수 있다.
    waiting = sum(1 for line in lines if not line.confirmed and line.status == "UNCONFIRMED")
    failed = len(lines) - ok - waiting + len(errors)
    summary = []
    if ok:
        summary.append(f"✅ 접수 성공 {ok}건")
    if waiting:
        summary.append(f"⏳ 확인 대기 {waiting}건")
    if failed:
        summary.append(f"❌ 실패 {failed}건")
    if lines or errors:
        parts.append(_RULE)
        parts.append("  ·  ".join(summary))
    for error in errors:
        parts.append(f"⚠️ {_text(error)}")
    if rejected_seen:
        parts.append(f"<i>{_text(REJECT_NOTE)}</i>")
    for order_id in retry_ids:
        parts.append(f"↻ /retry {_text(order_id)}")
    status = standing_block(standing)
    if status:
        parts.extend(["", *status])
    return "\n".join(parts).rstrip()


def auto_failure_message(
    symbol: str, error: object, item_ids: list[str], *, standing: Standing | None = None,
) -> str:
    parts = [f"🚨 <b>{_text(symbol)}</b> 자동주문 실패"]
    quote = price_line(standing)
    if quote:
        parts.append(quote)
    parts.extend(["", f"<blockquote>{_text(error)}</blockquote>"])
    for item_id in item_ids:
        parts.append(f"↻ /retry {_text(item_id)}")
    status = standing_block(standing)
    if status:
        parts.extend(["", *status])
    return "\n".join(parts)


def retry_success_message(order_id: str, *, price: object = None, quantity: object = None) -> str:
    if quantity is not None:
        title, detail = "수량 수정 후 재시도 접수 성공", f"새 수량  <b>{_text(quantity)}주</b>"
    elif price is not None:
        title, detail = "가격 수정 후 재시도 접수 성공", f"새 지정가  <b>${_text(price)}</b>"
    else:
        title, detail = "재시도 접수 성공", "토스 상태  확인됨"
    return f"✅ <b>{title}</b>\n\n<code>{_text(order_id)}</code>\n{detail}"


def retry_failure_message(order_id: str, reason: object) -> str:
    return f"❌ <b>재시도 실패</b>\n\n<code>{_text(order_id)}</code>\n<blockquote>{_text(reason)}</blockquote>"
