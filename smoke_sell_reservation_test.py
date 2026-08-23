"""Phase 16: real-account SELL conditional-order reservation-behavior smoke
test. Determines vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR
empirically -- whether Toss actually reserves/holds sellable quantity
against concurrent OPEN SELL conditional orders for the same symbol, or only
checks it at trigger time. arm_cycle_orders (vr_engine.py) refuses to
register ANY SELL leg on a LIVE broker while this is UNKNOWN
(SellReservationUnknownError) -- this script is the one-off, human-gated way
to replace that UNKNOWN with a real, observed answer.

Two independent stages. Each is its own separate `--stage N --approved`
invocation requiring fresh, explicitly-typed human confirmation at every
CREATE/DELETE -- no --yes/--all flag, exactly matching
smoke_conditional_order.py and smoke_capacity_test.py's own conventions.
Stage 2 must not be attempted until Stage 1 has completed successfully and
been reviewed.

  Stage 1 (comparator-direction check, quantity=1): this account has never
  had a real SELL conditional order before (unlike BUY, confirmed live in
  Phase 14) -- the trigger comparator direction assumed by
  trigger_already_satisfied("sell", ...) (price must RISE to the trigger,
  matching the book's own take-profit SELL ladder, never a stop-loss) is
  only inferred from the OpenAPI spec's OCO/OTO examples, never confirmed
  live. Creates ONE 1-share SELL conditional order at a deep-OTM trigger
  (SELL_SAFETY_MARGIN = 1.50, i.e. 50% above current price) and immediately
  verifies WATCHING/triggeredOrderId=None via the same
  evaluate_post_create_detail() Phase 14 used for BUY, then deletes it.

  Stage 2 (the actual reservation-behavior test): reads the account's real
  current holding quantity Q for `symbol` (same field-name fallback order
  vr_web_service.py itself uses, so this measures exactly what the live VR
  engine would rely on) and creates Order A for exactly Q shares (the
  account's entire current position) at the same deep-OTM SELL trigger
  family, confirms WATCHING, re-reads holdings, then attempts Order B for 1
  more share at a distinct deep-OTM trigger:
    - Toss REJECTS Order B (insufficient sellable quantity) -> direct
      evidence for SELL_RESERVATION_RESERVES_QUANTITY.
    - Toss ACCEPTS Order B -> direct evidence Toss does NOT enforce a
      reservation at CREATE time -> SELL_RESERVATION_DOES_NOT_RESERVE_UNTIL_
      TRIGGER (or SELL_RESERVATION_OTHER if the observed behavior does not
      cleanly match either constant -- never guessed).
  Both orders are deleted immediately after the result is observed,
  regardless of outcome.

Every state-changing call re-fetches the current price immediately before
CREATE and refuses if trigger_already_satisfied (side="sell"), and every raw
response is redacted (audit_log._redact) before being printed or saved to
smoke_artifacts/. This file must only ever be run from the automoney-dev
checkout, as its own short-lived process -- never via mumae.service, never
with any --restart/--reload of anything, and never in the same run as a Book
Ladder arm (VR engine code is not imported here at all).

After a human reviews the saved (redacted) artifact, update
vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR by hand to match
the observed outcome -- this script never writes to that module itself.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

from audit_log import _redact
from local_env import load_env
from mumae_core import ETF_UNIVERSE
from smoke_conditional_order import (
    UnexpectedConditionalOrderStateError,
    classify_market_session,
    evaluate_post_create_detail,
    fetch_current_price,
    resolve_expire_date,
    trigger_already_satisfied,
)
from toss_api import TossApiError, TossBroker
from vr_conditional_orders import (
    ConditionalOrderRequest,
    cancel_conditional_order,
    create_conditional_order,
    get_all_conditional_orders,
    get_conditional_order,
)
from web_gui.web_service import _collect_symbol_rows, _find_decimal

# 50% above current price -- deep enough OTM that a SELL trigger assumed to
# fire on a price RISE (book's take-profit SELL ladder direction, per
# trigger_already_satisfied) cannot plausibly be satisfied within the
# minutes this script takes to run. Order B uses a second, slightly higher
# margin so its triggerPrice is always distinct from Order A's.
SELL_SAFETY_MARGIN = Decimal("1.50")
SELL_SAFETY_MARGIN_B = Decimal("1.55")

HOLDING_QUANTITY_FIELDS = ("quantity", "holdingQuantity", "holdingQty", "availableQuantity", "sellableQuantity")


def fetch_holding_snapshot(broker: Any, symbol: str) -> tuple[Decimal, dict]:
    """(quantity, raw_row). quantity uses the exact same field-name fallback
    order vr_web_service.py's _vr_fetch_account already uses, so this
    measures precisely what the live VR engine treats as the position/
    available-sell-quantity. raw_row is the FULL untouched holdings row for
    `symbol` -- printed in full (redacted) so a human can see every
    quantity-like field Toss actually exposes, not just the one this script
    picks."""
    rows = _collect_symbol_rows(broker.get_holdings_raw())
    row = rows.get(symbol, {})
    return _find_decimal(row, HOLDING_QUANTITY_FIELDS), row


def compute_sell_smoke_order(
    symbol: str, current_price: Decimal, expire_date: str, quantity: int, client_order_id: str,
    margin: Decimal = SELL_SAFETY_MARGIN,
) -> ConditionalOrderRequest:
    trigger = (current_price * margin).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return ConditionalOrderRequest(
        symbol=symbol, side="sell", trigger_price=trigger, order_price=trigger,
        quantity=quantity, expire_date=expire_date, client_order_id=client_order_id,
    )


def _print_json(label: str, value: Any) -> None:
    print(f"--- {label} ---")
    print(json.dumps(_redact(value), ensure_ascii=False, indent=2, default=str))


def save_artifact(records: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_redact(records), ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _require_closed_session(broker: Any) -> str:
    market_session = classify_market_session(broker)
    print(f"현재 미국 시장 session: {market_session}")
    if market_session != "CLOSED":
        raise SystemExit(
            f"시장 세션이 CLOSED가 아닙니다({market_session}). 이 스크립트는 항상 CLOSED에서만 실행합니다"
            "(smoke_conditional_order.py의 --allow-open-market 같은 예외 없음 -- SELL 방향 확인 전이라 더 보수적으로 취급)."
        )
    return market_session


def _confirm(prompt_word: str) -> None:
    if input(f"\n{prompt_word}를 실행하려면 정확히 {prompt_word} 를 입력하세요: ").strip() != prompt_word:
        raise SystemExit("사용자 승인이 없어 중단합니다. 실제 API 호출 없음.")


def _create_and_verify(broker: Any, request: ConditionalOrderRequest, current_price: Decimal) -> tuple[str, dict]:
    """Fresh re-check immediately before CREATE (comparison price only, same
    triggerPrice already shown to the human), then CREATE, then the
    mandatory post-CREATE WATCHING/no-trigger check. Returns
    (conditional_order_id, create_response)."""
    fresh_price = fetch_current_price(broker, request.symbol)
    print(f"CREATE 직전 재조회한 현재가: {fresh_price}")
    if trigger_already_satisfied("sell", request.trigger_price, fresh_price):
        raise SystemExit(
            f"안전장치 발동: CREATE 직전 재조회한 현재가({fresh_price})가 triggerPrice({request.trigger_price}) "
            "이상으로 확인되어 중단합니다. 실제 API 호출 없음."
        )
    response = create_conditional_order(broker, request)
    conditional_order_id = (response.get("result") or {}).get("conditionalOrderId")
    if not conditional_order_id:
        raise UnexpectedConditionalOrderStateError(f"CREATE 응답에 conditionalOrderId가 없습니다: {response!r}")
    detail = get_conditional_order(broker, conditional_order_id)
    evaluate_post_create_detail(detail)  # raises on anything but WATCHING/no triggeredOrderId
    return conditional_order_id, response


def _abort_on_order_anomaly(
    error: Exception, request: ConditionalOrderRequest, records: dict[str, Any], artifact_path: Path,
    records_key: str, extra_note: str = "",
) -> None:
    """Records `error` into `records[records_key]`, saves the (redacted)
    artifact so nothing about the attempt is lost, and halts via SystemExit
    with an operator-facing message -- no automatic follow-up action,
    matching smoke_conditional_order.py's own established halt-on-anomaly
    pattern. `extra_note`, if given, is appended to that message (e.g. to
    warn that an earlier order in the same run may still be open). Always
    raises -- never returns."""
    records[records_key] = str(error)
    save_artifact(records, artifact_path)
    raise SystemExit(
        f"CREATE/확인 중 예상 밖 상황 발생: {error}\n"
        "자동 후속 조치 없음 -- 반드시 계좌를 직접 확인하고 필요하면 수동으로 정리하세요 "
        f"(clientOrderId={request.client_order_id}).{extra_note}"
    ) from error


def _create_and_verify_or_abort(
    broker: Any, request: ConditionalOrderRequest, current_price: Decimal,
    records: dict[str, Any], artifact_path: Path, records_key: str, extra_note: str = "",
) -> tuple[str, dict]:
    """_create_and_verify, but on the one documented-anomalous outcome
    (TossApiError or UnexpectedConditionalOrderStateError) aborts via
    _abort_on_order_anomaly instead of propagating a raw traceback."""
    try:
        return _create_and_verify(broker, request, current_price)
    except (TossApiError, UnexpectedConditionalOrderStateError) as error:
        _abort_on_order_anomaly(error, request, records, artifact_path, records_key, extra_note)
        raise AssertionError("unreachable") from error  # _abort_on_order_anomaly always raises


def _delete(broker: Any, conditional_order_id: str, label: str) -> str:
    try:
        cancel_conditional_order(broker, conditional_order_id)
        print(f"  DELETE {label} ({conditional_order_id}) -> 204")
        return "204"
    except TossApiError as error:
        print(f"  DELETE {label} ({conditional_order_id}) -> FAILED: {error}")
        return f"FAILED: {error}"


def run_stage1(broker: Any, symbol: str, artifact_dir: str) -> dict[str, Any]:
    records: dict[str, Any] = {"stage": 1, "symbol": symbol, "generated_at": datetime.now(timezone.utc).isoformat()}
    artifact_path = Path(artifact_dir) / f"{symbol}-sellres-stage1-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"

    market_session = _require_closed_session(broker)
    current_price = fetch_current_price(broker, symbol)
    expire_date = resolve_expire_date(broker)
    quantity, holding_row = fetch_holding_snapshot(broker, symbol)
    records["market_session"] = market_session
    records["current_price"] = str(current_price)
    records["holding_quantity_before"] = str(quantity)
    records["holding_row_before"] = holding_row

    now = datetime.now(timezone.utc)
    request = compute_sell_smoke_order(
        symbol, current_price, expire_date, quantity=1,
        client_order_id=f"smoke-sellres-{symbol}-s1-{now.strftime('%Y%m%d%H%M%S')}",
    )
    if trigger_already_satisfied("sell", request.trigger_price, current_price):
        raise SystemExit("안전장치 발동: trigger가 이미 충족된 것으로 추정되어 CREATE를 중단합니다 (추측 금지).")

    print("\n=== Stage 1: SELL 방향(comparator) 확인용 1주 CREATE ===")
    print(f"symbol: {symbol}")
    print(f"현재가 P: {current_price}")
    print(f"quantity: {request.quantity}")
    print(f"triggerPrice: {request.trigger_price} (현재가의 {SELL_SAFETY_MARGIN}배, deep OTM)")
    print(f"clientOrderId: {request.client_order_id}")
    print(f"현재 보유 수량 (quantity 필드 우선순위 {HOLDING_QUANTITY_FIELDS}): {quantity}")
    _confirm("CREATE")

    conditional_order_id, create_response = _create_and_verify_or_abort(
        broker, request, current_price, records, artifact_path, "order_failure",
    )
    records["create_response"] = create_response
    detail = get_conditional_order(broker, conditional_order_id)
    records["detail_before_cancel"] = detail
    save_artifact(records, artifact_path)

    result = detail.get("result", detail)
    leg = result.get("first") or {}
    print("\n=== DELETE 전 확인 (status=WATCHING, triggeredOrderId=null 확인됨) ===")
    print(f"conditionalOrderId: {conditional_order_id}")
    print(f"status: {result.get('status')}  first.triggeredOrderId: {leg.get('triggeredOrderId')}")
    _confirm("DELETE")

    records["delete_status"] = _delete(broker, conditional_order_id, "Stage1")
    quantity_after, holding_row_after = fetch_holding_snapshot(broker, symbol)
    records["holding_quantity_after"] = str(quantity_after)
    records["holding_row_after"] = holding_row_after
    save_artifact(records, artifact_path)

    print(f"\n=== Stage 1 완료: 결과가 {artifact_path} 에 저장되었습니다 ===")
    _print_json("summary", records)
    print(
        "\nStage 1은 SELL trigger comparator 방향만 확인합니다 (예약 여부는 아직 미확인). "
        "이 결과를 검토한 뒤에만 --stage 2를 실행하세요."
    )
    return records


def run_stage2(broker: Any, symbol: str, artifact_dir: str) -> dict[str, Any]:
    records: dict[str, Any] = {"stage": 2, "symbol": symbol, "generated_at": datetime.now(timezone.utc).isoformat()}
    artifact_path = Path(artifact_dir) / f"{symbol}-sellres-stage2-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"

    market_session = _require_closed_session(broker)
    current_price = fetch_current_price(broker, symbol)
    expire_date = resolve_expire_date(broker)
    quantity, holding_row = fetch_holding_snapshot(broker, symbol)
    records["market_session"] = market_session
    records["current_price"] = str(current_price)
    records["holding_quantity_before"] = str(quantity)
    records["holding_row_before"] = holding_row
    print(f"현재 보유 수량 Q (quantity 필드 우선순위 {HOLDING_QUANTITY_FIELDS}): {quantity}")
    if quantity <= 0:
        raise SystemExit(f"{symbol}: 현재 보유 수량이 0 이하입니다 ({quantity}). 예약 테스트를 진행할 수 없습니다.")
    q = int(quantity)

    now = datetime.now(timezone.utc)
    request_a = compute_sell_smoke_order(
        symbol, current_price, expire_date, quantity=q,
        client_order_id=f"smoke-sellres-{symbol}-a-{now.strftime('%Y%m%d%H%M%S')}",
        margin=SELL_SAFETY_MARGIN,
    )
    request_b = compute_sell_smoke_order(
        symbol, current_price, expire_date, quantity=1,
        client_order_id=f"smoke-sellres-{symbol}-b-{now.strftime('%Y%m%d%H%M%S')}",
        margin=SELL_SAFETY_MARGIN_B,
    )
    if request_a.trigger_price == request_b.trigger_price:
        raise RuntimeError("Order A/B triggerPrice가 동일합니다; 계획을 중단합니다.")
    for label, request in (("A", request_a), ("B", request_b)):
        if trigger_already_satisfied("sell", request.trigger_price, current_price):
            raise SystemExit(f"안전장치 발동: Order {label}의 trigger가 이미 충족된 것으로 추정되어 중단합니다.")

    print("\n=== Stage 2: 예약 동작 실측 -- Order A (보유 전량) ===")
    print(f"symbol: {symbol}  quantity: {request_a.quantity} (= 현재 보유 전량 Q)")
    print(f"triggerPrice: {request_a.trigger_price}  clientOrderId: {request_a.client_order_id}")
    print(
        f"\n이 명령은 {symbol} 보유 전량({q}주)에 대한 SELL 조건주문 1건을 실제 계좌에 생성합니다.\n"
        "Stage 1에서 SELL 방향(comparator)이 안전함을 이미 확인했다는 전제 하에 진행합니다."
    )
    _confirm("CREATE_A")

    conditional_order_id_a, create_response_a = _create_and_verify_or_abort(
        broker, request_a, current_price, records, artifact_path, "order_a_failure",
    )
    records["create_response_a"] = create_response_a
    detail_a = get_conditional_order(broker, conditional_order_id_a)
    records["detail_a_after_create"] = detail_a
    save_artifact(records, artifact_path)
    print(f"  OK  Order A -> {conditional_order_id_a} (WATCHING, triggeredOrderId=None)")

    quantity_after_a, holding_row_after_a = fetch_holding_snapshot(broker, symbol)
    records["holding_quantity_after_a"] = str(quantity_after_a)
    records["holding_row_after_a"] = holding_row_after_a
    print(f"Order A 생성 직후 보유/가능 수량: {quantity_after_a} (생성 전: {quantity})")
    save_artifact(records, artifact_path)

    print("\n=== Order B (+1주, Order A와 합치면 보유 전량을 초과) ===")
    print(f"symbol: {symbol}  quantity: {request_b.quantity}")
    print(f"triggerPrice: {request_b.trigger_price}  clientOrderId: {request_b.client_order_id}")
    print(
        "\n예약이 실제로 걸린다면 이 주문은 '판매 가능 수량 부족'으로 거부되어야 합니다.\n"
        "거부되지 않고 생성된다면 트리거 시점에만 체크한다는 뜻입니다 (추측이 아니라 이번 실측 결과)."
    )
    _confirm("CREATE_B")

    conditional_order_id_b: str | None = None
    order_b_outcome: str
    try:
        conditional_order_id_b, create_response_b = _create_and_verify(broker, request_b, current_price)
        records["create_response_b"] = create_response_b
        detail_b = get_conditional_order(broker, conditional_order_id_b)
        records["detail_b_after_create"] = detail_b
        order_b_outcome = "ACCEPTED"
        print(f"  ACCEPTED Order B -> {conditional_order_id_b} (WATCHING, triggeredOrderId=None)")
    except TossApiError as error:
        order_b_outcome = f"REJECTED: {error}"
        records["order_b_rejection"] = str(error)
        print(f"  REJECTED Order B: {error}")
    except UnexpectedConditionalOrderStateError as error:
        _abort_on_order_anomaly(
            error, request_b, records, artifact_path, "order_b_failure",
            f" Order A({conditional_order_id_a})가 아직 계좌에 남아 있을 수 있습니다.",
        )

    records["order_b_outcome"] = order_b_outcome
    save_artifact(records, artifact_path)

    if order_b_outcome == "ACCEPTED":
        print(
            "\n관찰 결과: Order B가 수락됨 -> Toss가 CREATE 시점에는 판매 가능 수량을 예약/차단하지 않는 것으로 "
            "관찰됨 (SELL_RESERVATION_DOES_NOT_RESERVE_UNTIL_TRIGGER, 또는 다른 이유라면 OTHER)."
        )
    else:
        print(
            "\n관찰 결과: Order B가 거부됨 -> Toss가 CREATE 시점에 판매 가능 수량을 실제로 예약/차단하는 것으로 "
            "관찰됨 (SELL_RESERVATION_RESERVES_QUANTITY)."
        )
    print("이 결과는 vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR에 사람이 직접 반영해야 합니다 (자동 반영 없음).")

    print("\n=== 정리: 생성된 테스트 주문 취소 ===")
    _confirm("DELETE_ALL")
    records["delete_status_a"] = _delete(broker, conditional_order_id_a, "Order A")
    if conditional_order_id_b:
        records["delete_status_b"] = _delete(broker, conditional_order_id_b, "Order B")

    quantity_after, holding_row_after = fetch_holding_snapshot(broker, symbol)
    records["holding_quantity_after_cleanup"] = str(quantity_after)
    records["holding_row_after_cleanup"] = holding_row_after
    open_orders_after = get_all_conditional_orders(broker, status="OPEN", symbol=symbol)
    records["open_conditional_orders_after_cleanup"] = open_orders_after
    save_artifact(records, artifact_path)

    print(f"\n=== Stage 2 완료: 결과가 {artifact_path} 에 저장되었습니다 ===")
    print(f"정리 후 보유 수량: {quantity_after} (테스트 시작 전: {quantity}) -- 반드시 일치해야 정상")
    _print_json("summary", records)
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True, help="US ETF symbol, e.g. TQQQ (must be in mumae_core.ETF_UNIVERSE)")
    parser.add_argument("--env-file", default="deploy/mumae.env", help="Credentials file to load read-only (never modified)")
    parser.add_argument("--artifact-dir", default="smoke_artifacts", help="Where the redacted response log is saved")
    parser.add_argument("--stage", type=int, required=True, choices=[1, 2], help="1 = comparator-direction check, 2 = reservation test")
    args = parser.parse_args()

    symbol = args.symbol.upper()
    if symbol not in ETF_UNIVERSE:
        raise SystemExit(f"{symbol}: not in this app's known ETF universe; refusing.")

    load_env(args.env_file)
    broker = TossBroker()
    if broker.mode != "LIVE" or not broker.live_ack:
        raise SystemExit(
            "이 스모크 테스트는 다른 실거래 경로와 동일하게 LIVE 모드 + 실거래 동의가 필요합니다 "
            "(MUMAE_MODE=LIVE, MUMAE_LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_TRADING in --env-file). "
            f"현재 broker.mode={broker.mode!r}."
        )

    if args.stage == 1:
        run_stage1(broker, symbol, args.artifact_dir)
    else:
        run_stage2(broker, symbol, args.artifact_dir)


if __name__ == "__main__":
    main()
