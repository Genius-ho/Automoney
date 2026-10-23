"""Telegram HTML message layouts for order notifications (formatting only, no I/O)."""
from __future__ import annotations

from dataclasses import dataclass
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


@dataclass(frozen=True)
class OrderLine:
    order_id: str
    side: str
    quantity: object
    price: object
    order_kind: str
    status: str
    confirmed: bool


def _text(value: object) -> str:
    return escape(str(value), quote=False)


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
) -> str:
    """Summary of one auto-order batch: one block per order, then totals and retry hints."""
    parts = [f"🤖 <b>{_text(symbol)}</b> 자동주문", ""]
    for line in lines:
        parts.extend(_order_block(line))
        parts.append("")
    ok = sum(1 for line in lines if line.confirmed)
    failed = len(lines) - ok + len(errors)
    summary = []
    if ok:
        summary.append(f"✅ 접수 성공 {ok}건")
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
    return "\n".join(parts).rstrip()


def auto_failure_message(symbol: str, error: object, item_ids: list[str]) -> str:
    parts = [f"🚨 <b>{_text(symbol)}</b> 자동주문 실패", "", f"<blockquote>{_text(error)}</blockquote>"]
    for item_id in item_ids:
        parts.append(f"↻ /retry {_text(item_id)}")
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
