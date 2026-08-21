"""Phase 14: one-shot, human-gated Toss Conditional Order LIVE smoke test.

Verifies the real account's actual behavior for CREATE -> GET -> DELETE ->
GET (OPEN/CLOSED lists) using exactly the same adapter functions
vr_conditional_orders.py already implements -- not a hand-rolled curl
script. Scope is deliberately minimal: this does NOT run any part of the VR
cycle/execution-policy engine, and does not touch mumae.service.

Safety design (see the Phase 13/14 report for the full research behind
each choice):
  - By default only runs when the US market session is CLOSED, verified
    against the live market calendar immediately before CREATE -- never
    assumed. --allow-open-market explicitly overrides this one gate (a
    deliberate, one-off operator decision -- never the default), for
    example when waiting for a CLOSED window is impractical; every other
    safeguard below is unchanged and still fully enforced.
  - BUY 1 share, triggerPrice = round(70% of current price, 2), orderType=
    LIMIT (never MARKET, which has no price ceiling once triggered). Price
    is fetched twice: once to compute triggerPrice/build the printed info
    block, and again immediately before the actual CREATE call (the human
    approval step can take any amount of time) -- CREATE is refused if the
    freshly re-fetched price is not still strictly above triggerPrice.
  - The -30% price margin is NOT treated as sufficient safety by itself,
    because the exact comparator direction for a SINGLE STOP condition is
    not explicitly documented (only inferred from OCO/OTO examples) -- the
    mandatory post-CREATE GET check is the real safety net: anything other
    than status=WATCHING with triggeredOrderId=null halts immediately with
    zero automatic follow-up action.
  - Every state-changing call (CREATE, DELETE) requires a separate,
    explicit human confirmation, with the full request context printed
    first. Nothing runs unattended (no --yes flag exists on purpose).
  - Every raw response is redacted (audit_log._redact) before being printed
    or saved to smoke_artifacts/.

Phase 14 was run for real on 2026-08-21 (TQQQ, market session PRE,
--allow-open-market), CREATE -> GET -> DELETE -> GET/OPEN/CLOSED, all as
designed: status=WATCHING with triggeredOrderId=null immediately after
CREATE, DELETE returned 204, the post-delete detail GET 404'd, and the
order appeared in neither the OPEN nor CLOSED list afterward. See
vr_conditional_orders.py's module docstring for the full confirmed-schema
notes (e.g. GET responses omit `orderSide` entirely) and
smoke_artifacts/TQQQ-manual-20260821.json (redacted) for the raw exchange.
The trigger-comparator direction itself is still unverified (the order was
cancelled before any price movement could trigger it).

Run (LIVE, real account -- only after the plan and this script are both
explicitly approved):
    python smoke_conditional_order.py --symbol TQQQ --env-file deploy/mumae.env
    python smoke_conditional_order.py --symbol TQQQ --env-file deploy/mumae.env --allow-open-market

This must only ever be run from the automoney-dev checkout, as its own
short-lived process -- never via mumae.service, never with --restart/
--reload of anything.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

from audit_log import _redact
from local_env import load_env
from mumae_core import ETF_UNIVERSE
from toss_api import TossApiError, TossBroker
from vr_conditional_orders import (
    ConditionalOrderRequest,
    cancel_conditional_order,
    create_conditional_order,
    get_all_conditional_orders,
    get_conditional_order,
)
from web_gui.web_service import _collect_symbol_rows, _find_decimal, _text_decimal

# -30% of current price. Chosen as a margin far beyond any realistic
# multi-minute price move (see module docstring) -- but see also
# trigger_already_satisfied() and evaluate_post_create_detail(), which are
# the actual safety net against the unverified comparator direction.
SAFETY_MARGIN = Decimal("0.70")

SESSION_LABELS = {
    "dayMarket": "DAY", "preMarket": "PRE", "regularMarket": "REGULAR", "afterMarket": "AFTER",
}


class UnexpectedConditionalOrderStateError(RuntimeError):
    """Raised when the post-CREATE (or post-DELETE) observed state is
    anything other than the single documented-safe outcome. Callers must
    not take any automatic follow-up action when this is raised -- halt
    and report to a human."""


def classify_market_session(broker: Any, now: datetime | None = None) -> str:
    """PRE/REGULAR/AFTER/DAY if `now` falls inside that session (checked
    against today's and yesterday's calendar, matching the two-day
    lookback trading_service.py already uses for overnight sessions), else
    CLOSED. Never assumes -- always queries the live market calendar."""
    now = now or datetime.now(timezone.utc)
    for offset in (0, 1):
        target = (now - timedelta(days=offset)).date().isoformat()
        result = broker.get_us_market_calendar_raw(target)
        today = (result or {}).get("result", {}).get("today", {}) or {}
        for key, label in SESSION_LABELS.items():
            session = today.get(key) or {}
            start_raw, end_raw = session.get("startTime"), session.get("endTime")
            if not start_raw or not end_raw:
                continue
            start = datetime.fromisoformat(start_raw).astimezone(timezone.utc)
            end = datetime.fromisoformat(end_raw).astimezone(timezone.utc)
            if start <= now <= end:
                return label
    return "CLOSED"


def fetch_current_price(broker: Any, symbol: str) -> Decimal:
    rows = _collect_symbol_rows(broker.get_prices_raw([symbol]))
    price = _find_decimal(rows.get(symbol, {}), ("lastPrice", "price", "currentPrice"))
    if price <= 0:
        raise RuntimeError(f"{symbol}: could not resolve a positive current price.")
    return price


def fetch_buying_power(broker: Any) -> Decimal:
    return _text_decimal(broker.get_buying_power_raw().get("result", {}).get("cashBuyingPower"))


def resolve_expire_date(broker: Any, now: datetime | None = None, buffer_days: int = 2, search_days: int = 10) -> str:
    """The real schema only documents expireDate as `format: date` with no
    stated constraint that it must itself be a trading day or any minimum
    window -- since this test cancels within minutes regardless, the exact
    value is inconsequential in practice. We still conservatively pick the
    next actual trading day (verified via the live market calendar, not
    assumed) plus a buffer, rather than a blind "+3 calendar days"."""
    now = now or datetime.now(timezone.utc)
    start = now.date() + timedelta(days=1)
    for offset in range(search_days):
        candidate = start + timedelta(days=offset)
        result = broker.get_us_market_calendar_raw(candidate.isoformat())
        today = (result or {}).get("result", {}).get("today", {}) or {}
        regular = today.get("regularMarket") or {}
        if regular.get("startTime") and regular.get("endTime"):
            return (candidate + timedelta(days=buffer_days)).isoformat()
    raise RuntimeError(f"No US trading day found within {search_days} days; cannot resolve a safe expireDate.")


def compute_smoke_order(symbol: str, current_price: Decimal, expire_date: str, now: datetime | None = None) -> ConditionalOrderRequest:
    now = now or datetime.now(timezone.utc)
    trigger = (current_price * SAFETY_MARGIN).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    client_order_id = f"smoke-{symbol}-{now.strftime('%Y%m%d%H%M%S')}"
    return ConditionalOrderRequest(
        symbol=symbol, side="buy", trigger_price=trigger, order_price=trigger,
        quantity=1, expire_date=expire_date, client_order_id=client_order_id,
    )


def trigger_already_satisfied(side: str, trigger_price: Decimal, current_price: Decimal) -> bool:
    """Heuristic pre-check only (see module docstring: the comparator
    direction is inferred from OCO/OTO examples, not explicitly documented).
    A BUY trigger below current price is assumed to require price to FALL
    to it; if current price is already at/below the trigger, refuse rather
    than guess. This is defense-in-depth, not the primary safety net --
    evaluate_post_create_detail() is."""
    if side == "buy":
        return current_price <= trigger_price
    return current_price >= trigger_price


def create_smoke_order(
    broker: Any, request: ConditionalOrderRequest, market_session: str, approved: bool,
    *, allow_open_market: bool = False,
) -> dict:
    """market_session must be CLOSED unless allow_open_market=True is passed
    explicitly (a deliberate, one-off override -- see main()'s
    --allow-open-market flag). Even then, the price-margin + WATCHING-only
    safety net below is unchanged; this only removes the CLOSED gate
    itself, never any other check."""
    if market_session != "CLOSED" and not allow_open_market:
        raise RuntimeError(
            f"Refusing to CREATE: market_session={market_session!r} (must be CLOSED, or pass allow_open_market=True)."
        )
    if not approved:
        raise RuntimeError("Refusing to CREATE: explicit human approval was not given.")
    return create_conditional_order(broker, request)


def evaluate_post_create_detail(detail: dict) -> str:
    """Returns "PROCEED" only when status == WATCHING and the leg's
    triggeredOrderId is null/missing -- the single documented-safe outcome.
    Anything else (ORDERING/ORDERED/COMPLETED/EXPIRED/PAUSED/an unrecognized
    value, or a populated triggeredOrderId) raises
    UnexpectedConditionalOrderStateError. Callers must not take any
    automatic follow-up action on that exception."""
    result = detail.get("result", detail)
    status = result.get("status")
    leg = result.get("first") or {}
    triggered_order_id = leg.get("triggeredOrderId")
    if status == "WATCHING" and triggered_order_id is None:
        return "PROCEED"
    raise UnexpectedConditionalOrderStateError(
        f"Unexpected post-CREATE state: status={status!r} triggeredOrderId={triggered_order_id!r}. "
        "Halting -- no automatic cancel/compensating order will be sent."
    )


def cancel_smoke_order(broker: Any, conditional_order_id: str, approved: bool) -> None:
    if not approved:
        raise RuntimeError("Refusing to DELETE: explicit human approval was not given.")
    cancel_conditional_order(broker, conditional_order_id)


def verify_after_cancel(broker: Any, conditional_order_id: str, symbol: str) -> dict[str, Any]:
    """Never creates any new order. A 404 (or any other error) on the
    detail lookup is recorded as an observation, not treated as a script
    failure -- the DELETE->GET behavior is exactly what this test exists to
    discover."""
    records: dict[str, Any] = {}
    try:
        records["detail_after_cancel"] = get_conditional_order(broker, conditional_order_id)
    except TossApiError as error:
        records["detail_after_cancel"] = {"observed_error": str(error)}
    try:
        records["open_list_after_cancel"] = {
            "conditionalOrders": get_all_conditional_orders(broker, status="OPEN", symbol=symbol)
        }
    except TossApiError as error:
        records["open_list_after_cancel"] = {"observed_error": str(error)}
    try:
        records["closed_list_after_cancel"] = {
            "conditionalOrders": get_all_conditional_orders(broker, status="CLOSED", symbol=symbol)
        }
    except TossApiError as error:
        records["closed_list_after_cancel"] = {"observed_error": str(error)}
    return records


def save_artifact(records: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_redact(records), ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _print_json(label: str, value: Any) -> None:
    print(f"--- {label} ---")
    print(json.dumps(_redact(value), ensure_ascii=False, indent=2, default=str))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True, help="US ETF symbol, e.g. TQQQ (must be in mumae_core.ETF_UNIVERSE)")
    parser.add_argument("--env-file", default="deploy/mumae.env", help="Credentials file to load read-only (never modified)")
    parser.add_argument("--artifact-dir", default="smoke_artifacts", help="Where the redacted response log is saved")
    parser.add_argument(
        "--allow-open-market", action="store_true",
        help="Explicitly permit CREATE while the market session is not CLOSED. A deliberate one-off override -- "
        "every other safeguard (price margin, fresh re-check before CREATE, WATCHING-only proceed) still applies.",
    )
    args = parser.parse_args()

    symbol = args.symbol.upper()
    if symbol not in ETF_UNIVERSE:
        raise SystemExit(f"{symbol}: not in this app's known ETF universe; refusing to smoke-test an unfamiliar symbol.")

    load_env(args.env_file)
    broker = TossBroker()
    if broker.mode != "LIVE" or not broker.live_ack:
        raise SystemExit(
            "This smoke test requires the same LIVE mode + live-trading acknowledgement as any other live order "
            "path in this app (MUMAE_MODE=LIVE, MUMAE_LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_TRADING in --env-file). "
            "Refusing to proceed -- current broker.mode={!r}.".format(broker.mode)
        )

    artifact_path = Path(args.artifact_dir) / f"{symbol}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    records: dict[str, Any] = {}

    market_session = classify_market_session(broker)
    print(f"현재 미국 시장 session: {market_session}")
    if market_session != "CLOSED" and not args.allow_open_market:
        raise SystemExit(
            f"시장 세션이 CLOSED가 아닙니다({market_session}). --allow-open-market 없이는 진행하지 않습니다."
        )
    if market_session != "CLOSED":
        print(
            f"\n주의: 시장이 {market_session} 세션으로 열려 있으며 --allow-open-market로 명시적으로 허용되었습니다.\n"
            "체결 가능성이 0이라고 가정하지 않습니다 -- 가격 마진, CREATE 직전 재조회, WATCHING 확인 등\n"
            "다른 모든 안전장치는 CLOSED일 때와 동일하게 그대로 적용됩니다."
        )

    current_price = fetch_current_price(broker, symbol)
    buying_power = fetch_buying_power(broker)
    expire_date = resolve_expire_date(broker)
    request = compute_smoke_order(symbol, current_price, expire_date)

    if trigger_already_satisfied("buy", request.trigger_price, current_price):
        raise SystemExit("안전장치 발동: trigger가 이미 충족된 것으로 추정되어 CREATE를 중단합니다 (추측 금지).")

    print("\n=== CREATE 직전 확인 ===")
    print(f"symbol: {symbol}")
    print(f"현재가 P: {current_price}")
    print(f"quantity: {request.quantity}")
    print(f"triggerPrice: {request.trigger_price}")
    print(f"orderPrice: {request.order_price}")
    print(f"expireDate: {request.expire_date}")
    print(f"현재 미국 시장 session: {market_session}")
    print(f"실제 buying power: {buying_power}")
    print(f"clientOrderId: {request.client_order_id}")
    print(
        "\n이 명령은 실제 Toss 계좌에 조건주문 1건을 생성합니다.\n"
        f"현재 미국 시장은 {market_session}이며, 생성 직후 조회 후 취소할 예정입니다."
    )
    if input("\nCREATE를 실행하려면 정확히 CREATE 를 입력하세요: ").strip() != "CREATE":
        raise SystemExit("사용자 승인이 없어 중단합니다. 실제 API 호출 없음.")

    # Re-verify immediately before the actual POST: the human approval step
    # above can take any amount of time, during which the price may have
    # moved. Uses the SAME triggerPrice already shown above -- only the
    # comparison price is refreshed.
    fresh_price = fetch_current_price(broker, symbol)
    print(f"CREATE 직전 재조회한 현재가: {fresh_price}")
    if trigger_already_satisfied("buy", request.trigger_price, fresh_price):
        raise SystemExit(
            f"안전장치 발동: CREATE 직전 재조회한 현재가({fresh_price})가 triggerPrice({request.trigger_price}) "
            "이하로 확인되어 중단합니다. 실제 API 호출 없음."
        )

    create_response = create_smoke_order(
        broker, request, market_session, approved=True, allow_open_market=args.allow_open_market,
    )
    records["create_response"] = create_response
    save_artifact(records, artifact_path)
    conditional_order_id = (create_response.get("result") or {}).get("conditionalOrderId")
    if not conditional_order_id:
        _print_json("CREATE response (no conditionalOrderId!)", create_response)
        raise SystemExit("CREATE 응답에 conditionalOrderId가 없습니다. 수동으로 계좌를 확인하세요.")

    detail = get_conditional_order(broker, conditional_order_id)
    records["detail_before_cancel"] = detail
    save_artifact(records, artifact_path)

    try:
        evaluate_post_create_detail(detail)
    except UnexpectedConditionalOrderStateError as error:
        _print_json("예상 밖 상태 -- 자동 후속 조치 없음", detail)
        raise SystemExit(str(error))

    result = detail.get("result", detail)
    leg = result.get("first") or {}
    print("\n=== DELETE 전 확인 (status=WATCHING, triggeredOrderId=null 확인됨) ===")
    print(f"conditionalOrderId: {conditional_order_id}")
    print(f"status: {result.get('status')}")
    print(f"first.orderSide: {leg.get('orderSide')}")
    print(f"first.triggerPrice: {leg.get('triggerPrice')}")
    print(f"first.orderPrice: {leg.get('orderPrice')}")
    print(f"first.triggeredOrderId: {leg.get('triggeredOrderId')}")
    if input("\nDELETE를 실행하려면 정확히 DELETE 를 입력하세요: ").strip() != "DELETE":
        save_artifact(records, artifact_path)
        raise SystemExit(
            f"사용자 승인이 없어 DELETE를 실행하지 않았습니다. "
            f"조건주문 {conditional_order_id}이 계좌에 남아 있으니 직접 취소하세요."
        )

    try:
        cancel_smoke_order(broker, conditional_order_id, approved=True)
        records["delete_status"] = "204 (No Content)"
    except TossApiError as error:
        records["delete_status"] = f"FAILED: {error}"
        save_artifact(records, artifact_path)
        raise SystemExit(f"DELETE 실패: {error}. 조건주문 {conditional_order_id}이 계좌에 남아있을 수 있습니다.")

    records.update(verify_after_cancel(broker, conditional_order_id, symbol))
    save_artifact(records, artifact_path)

    print(f"\n=== 완료: 결과가 {artifact_path} 에 저장되었습니다 ===")
    _print_json("summary", records)


if __name__ == "__main__":
    main()
