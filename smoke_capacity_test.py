"""Phase 15b: real-account OPEN conditional-order capacity smoke test.

Read-only Stage 0 (market session / current price / existing OPEN
conditional orders / existing smoke-capacity-prefixed orders / buying
power) plus the Stage 1 CREATE plan (10 BUY orders) are always safe to run
and require no special approval -- they touch only GET endpoints, exactly
like Phase 14's own pre-CREATE reconnaissance.

Actual CREATE calls (Stage 1/2/3) and the cleanup DELETE pass are each
gated behind a separate, explicit `--stage N --approved` invocation. There
is no --yes/--all flag: every stage must be re-invoked by a human after
reviewing the previous stage's printed result. BUY only (never SELL) --
SELL-side sellable-quantity reservation behavior is still unconfirmed
(vr_execution_policy.CONDITIONAL_SELL_RESERVATION_BEHAVIOR ==
SELL_RESERVATION_UNKNOWN) and this test must not conflate the two unknowns.

Test clientOrderId prefix: smoke-capacity-{symbol}-{stage_start:03d}
(e.g. smoke-capacity-TQQQ-001 .. -010 for Stage 1). Every CREATE re-fetches
the current price immediately before sending, exactly like
smoke_conditional_order.py, and refuses if current_price <= trigger_price
for any planned order (trigger_already_satisfied). Every raw response is
redacted before being printed or saved to smoke_artifacts/.

This must only ever be run from the automoney-dev checkout, as its own
short-lived process -- never via mumae.service, never with any
--restart/--reload of anything, and never in the same run as a Book Ladder
arm (VR engine code is not imported here at all).
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict
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
    fetch_buying_power,
    fetch_current_price,
    resolve_expire_date,
    trigger_already_satisfied,
)
from toss_api import TossApiError, TossBroker
from vr_conditional_orders import (
    ConditionalOrderRequest,
    create_conditional_order,
    get_all_conditional_orders,
    get_conditional_order,
)

# (start_sequence, count) per stage -- every stage only ever ADDS to the
# previous stage's orders; earlier sequence numbers/clientOrderIds are never
# regenerated, recreated, or touched. Stage 4 is the user-approved
# extension past the original 40-order target (Phase 15 addendum,
# 2026-08-22): 100 more, cumulative 140, using the exact same methodology
# (not literally random -- distinct deep-OTM prices, same safety checks).
STAGE_RANGES = {1: (1, 10), 2: (11, 10), 3: (21, 20), 4: (41, 100)}

CLIENT_ORDER_ID_PREFIX = "smoke-capacity"
# Each rung strictly below the last, all comfortably below 50% of current
# price (never close enough together to risk an accidental duplicate
# triggerPrice after cent rounding). Small enough that sequence 140 (Stage
# 4's last order) still lands at a positive, deeply-OTM fraction (~15% of
# current price) -- see plan_stage_orders' own guard against non-positive
# fractions, which would otherwise trip first.
FIRST_RUNG_FRACTION = Decimal("0.50")
RUNG_STEP_FRACTION = Decimal("0.0025")
# SELL side (Phase 15 addendum, 2026-08-22, run only while market_session ==
# CLOSED): mirrors BUY but comfortably ABOVE current price -- 150% down to
# ~125% of current price over 100 rungs -- so trigger_already_satisfied
# ("sell": current_price >= trigger_price) stays false throughout, matching
# the same deep-OTM safety margin philosophy as the BUY side.
SELL_FIRST_RUNG_FRACTION = Decimal("1.50")
SELL_RUNG_STEP_FRACTION = Decimal("0.0025")


def _client_order_id(symbol: str, sequence: int, side: str = "buy") -> str:
    # "buy" keeps the original (pre-2026-08-22) naming for backward
    # compatibility with the already-created/cleaned-up Stage 1-4 orders;
    # "sell" gets its own namespace so a SELL test can never collide with a
    # BUY clientOrderId that used the same sequence number.
    if side == "buy":
        return f"{CLIENT_ORDER_ID_PREFIX}-{symbol}-{sequence:03d}"
    return f"{CLIENT_ORDER_ID_PREFIX}-{symbol}-{side}-{sequence:03d}"


def plan_stage_orders(
    symbol: str, current_price: Decimal, expire_date: str, start_sequence: int, count: int, side: str = "buy",
) -> list[ConditionalOrderRequest]:
    """start_sequence/count=(1,10) for Stage 1, (11,10) for Stage 2's
    additional 10, (21,20) for Stage 3's additional 20 -- never regenerates
    or touches earlier sequence numbers, so earlier stages' orders are
    never redefined or duplicated. side="sell" uses the SELL_* constants
    (above current price) instead of the BUY ones (below)."""
    if side not in ("buy", "sell"):
        raise ValueError("side must be buy or sell.")
    first_fraction = FIRST_RUNG_FRACTION if side == "buy" else SELL_FIRST_RUNG_FRACTION
    step = RUNG_STEP_FRACTION if side == "buy" else SELL_RUNG_STEP_FRACTION
    requests = []
    for offset in range(count):
        sequence = start_sequence + offset
        # Fraction depends on `offset` (this call's own 0-indexed position),
        # not the absolute `sequence` used for naming -- so start_sequence
        # can be any fresh namespace (e.g. 201+ to avoid reusing an
        # already-cancelled clientOrderId) without the price schedule
        # itself running out of headroom / going non-positive.
        fraction = first_fraction - step * offset
        if fraction <= 0:
            raise RuntimeError(f"sequence {sequence}: computed price fraction is non-positive; refusing to plan.")
        trigger = (current_price * fraction).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        requests.append(ConditionalOrderRequest(
            symbol=symbol, side=side, trigger_price=trigger, order_price=trigger,
            quantity=1, expire_date=expire_date, client_order_id=_client_order_id(symbol, sequence, side),
        ))
    prices = [r.trigger_price for r in requests]
    if len(set(prices)) != len(prices):
        raise RuntimeError("Planned triggerPrices are not all distinct; refusing to plan.")
    return requests


def _tracking_path(artifact_dir: str, symbol: str) -> Path:
    return Path(artifact_dir) / f"{symbol}-capacity-created-ids.json"


def _load_tracked_ids(artifact_dir: str, symbol: str) -> list[dict]:
    path = _tracking_path(artifact_dir, symbol)
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def _record_tracked_ids(artifact_dir: str, symbol: str, created: list[dict]) -> None:
    """Discovered live (2026-08-22, TQQQ): GET /api/v1/conditional-orders
    (the OPEN/CLOSED list endpoint) returns clientOrderId=null on every row
    -- only the CREATE response and the single-order detail GET echo it
    back correctly. So identifying "our" test orders by clientOrderId
    prefix against the LIST endpoint is impossible; this file is the
    ground truth instead, built only from CREATE-response/detail-GET data
    (both confirmed to include clientOrderId), and is what cleanup/
    existing_smoke_capacity_orders actually rely on."""
    path = _tracking_path(artifact_dir, symbol)
    existing = _load_tracked_ids(artifact_dir, symbol)
    known_ids = {row["conditional_order_id"] for row in existing}
    for row in created:
        if row["conditional_order_id"] not in known_ids:
            existing.append({"client_order_id": row["client_order_id"], "conditional_order_id": row["conditional_order_id"]})
            known_ids.add(row["conditional_order_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")


def existing_smoke_capacity_orders(broker: Any, symbol: str, artifact_dir: str = "smoke_artifacts") -> list[dict]:
    """Tracked-conditionalOrderId set (see _record_tracked_ids) intersected
    with what's currently OPEN -- never clientOrderId-prefix-filtered
    against the list endpoint, which cannot carry that field (see above)."""
    tracked_ids = {row["conditional_order_id"] for row in _load_tracked_ids(artifact_dir, symbol)}
    if not tracked_ids:
        return []
    open_orders = get_all_conditional_orders(broker, status="OPEN", symbol=symbol)
    return [o for o in open_orders if o.get("conditionalOrderId") in tracked_ids]


def _print_json(label: str, value: Any) -> None:
    print(f"--- {label} ---")
    print(json.dumps(_redact(value), ensure_ascii=False, indent=2, default=str))


def save_artifact(records: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_redact(records), ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def run_stage(broker: Any, symbol: str, stage: int, approved: bool, artifact_dir: str) -> dict[str, Any]:
    """BUY-side numbered stages (1-4, the original Phase 15 plan)."""
    if stage not in STAGE_RANGES:
        raise ValueError(f"stage must be one of {sorted(STAGE_RANGES)}.")
    start_sequence, count = STAGE_RANGES[stage]
    return run_side_stage(broker, symbol, "buy", start_sequence, count, approved, artifact_dir, label=f"Stage {stage}")


def run_side_stage(
    broker: Any, symbol: str, side: str, start_sequence: int, count: int, approved: bool, artifact_dir: str,
    label: str | None = None,
) -> dict[str, Any]:
    """Creates exactly `count` new orders of `side`, starting at
    `start_sequence` in that side's own clientOrderId namespace (previous
    orders, on either side, are left untouched). Halts on the first
    anomaly -- no compensating cancel is sent automatically; a human
    decides cleanup after reviewing the failure. side="sell" is only ever
    intended to run while market_session == "CLOSED" (caller's
    responsibility to check; this function does not itself refuse an OPEN
    session the way smoke_conditional_order.py's BUY smoke test does,
    since Phase 15's own capacity questions are about order count/
    reservation, not trigger-comparator risk)."""
    if not approved:
        raise RuntimeError("Refusing to CREATE: explicit human approval was not given.")
    if side not in ("buy", "sell"):
        raise ValueError("side must be buy or sell.")
    label = label or f"{side.upper()} {start_sequence}-{start_sequence + count - 1}"

    records: dict[str, Any] = {
        "symbol": symbol, "side": side, "start_sequence": start_sequence, "count": count,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    market_session = classify_market_session(broker)
    current_price = fetch_current_price(broker, symbol)
    expire_date = resolve_expire_date(broker)
    records["market_session"] = market_session
    records["current_price_at_stage_start"] = str(current_price)

    requests = plan_stage_orders(symbol, current_price, expire_date, start_sequence=start_sequence, count=count, side=side)
    for request in requests:
        if trigger_already_satisfied(side, request.trigger_price, current_price):
            raise RuntimeError(
                f"안전장치 발동: {request.client_order_id} triggerPrice={request.trigger_price}가 현재가"
                f" {current_price} 대비 이미 충족된 것으로 추정됩니다. 어떤 CREATE도 보내지 않고 중단합니다."
            )

    print(f"\n=== {label}: {count}건 CREATE 시작 (side={side}, 현재가 재조회: {current_price}) ===")
    created: list[dict[str, Any]] = []
    failure: str | None = None
    try:
        for request in requests:
            # Fresh re-check immediately before each individual CREATE, not
            # just once at stage start -- matches smoke_conditional_order.py's
            # own "re-check right before the mutating call" rule.
            fresh_price = fetch_current_price(broker, symbol)
            if trigger_already_satisfied(side, request.trigger_price, fresh_price):
                raise RuntimeError(
                    f"안전장치 발동 (CREATE 직전 재조회): {request.client_order_id} triggerPrice="
                    f"{request.trigger_price} vs 현재가 {fresh_price}. 이후 CREATE를 중단합니다."
                )
            response = create_conditional_order(broker, request)
            conditional_order_id = (response.get("result") or response).get("conditionalOrderId")
            if not conditional_order_id:
                raise UnexpectedConditionalOrderStateError(
                    f"{request.client_order_id}: CREATE 응답에 conditionalOrderId가 없습니다: {response!r}"
                )
            detail = get_conditional_order(broker, conditional_order_id)
            evaluate_post_create_detail(detail)  # raises on anything but WATCHING/no triggeredOrderId
            created.append({
                "client_order_id": request.client_order_id, "conditional_order_id": conditional_order_id,
                "trigger_price": str(request.trigger_price), "detail": detail,
            })
            print(f"  OK  {request.client_order_id} -> {conditional_order_id} (WATCHING, triggeredOrderId=None)")
    except Exception as error:
        failure = f"{type(error).__name__}: {error}"
        print(f"  FAIL after {len(created)}/{len(requests)} succeeded: {failure}")
    finally:
        records["created"] = created
        records["created_count"] = len(created)
        records["planned_count"] = len(requests)
        records["failure"] = failure
        _record_tracked_ids(artifact_dir, symbol, created)
        open_smoke = existing_smoke_capacity_orders(broker, symbol, artifact_dir)
        records["open_smoke_capacity_orders_after_stage"] = open_smoke
        records["open_smoke_capacity_count_after_stage"] = len(open_smoke)
        safe_label = label.replace(" ", "_")
        artifact_path = Path(artifact_dir) / f"{symbol}-capacity-{safe_label}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        save_artifact(records, artifact_path)
        print(f"{label}: 이번에 {len(created)}/{len(requests)}건 생성, 누적 smoke-capacity OPEN {len(open_smoke)}건")
        print(f"(redacted) {label} 기록 저장: {artifact_path}")

    if failure:
        raise RuntimeError(f"{label} halted: {failure}")
    return records


def run_cleanup(broker: Any, symbol: str, approved: bool, artifact_dir: str) -> dict[str, Any]:
    """DELETEs only conditionalOrderIds this script itself created and
    tracked (see _record_tracked_ids) that are still OPEN. Never touches
    any other order -- in particular the pre-existing real VR conditional
    orders, which were never written to the tracking file in the first
    place, so they can never appear in `before` regardless of count or
    position."""
    if not approved:
        raise RuntimeError("Refusing to DELETE: explicit human approval was not given.")
    from vr_conditional_orders import cancel_conditional_order

    records: dict[str, Any] = {"symbol": symbol, "generated_at": datetime.now(timezone.utc).isoformat()}
    client_order_id_by_conditional_id = {row["conditional_order_id"]: row["client_order_id"] for row in _load_tracked_ids(artifact_dir, symbol)}
    before = existing_smoke_capacity_orders(broker, symbol, artifact_dir)
    records["before_count"] = len(before)
    print(f"=== Cleanup: 추적된 smoke-capacity-{symbol}- 주문 {len(before)}건 DELETE 시작 ===")
    results = []
    for order in before:
        conditional_order_id = order.get("conditionalOrderId")
        client_order_id = client_order_id_by_conditional_id.get(conditional_order_id, "?")
        try:
            cancel_conditional_order(broker, conditional_order_id)
            results.append({"client_order_id": client_order_id, "conditional_order_id": conditional_order_id, "outcome": "204"})
            print(f"  DELETE {client_order_id} -> 204")
        except TossApiError as error:
            results.append({"client_order_id": client_order_id, "conditional_order_id": conditional_order_id, "outcome": str(error)})
            print(f"  DELETE {client_order_id} -> {error}")
    after = existing_smoke_capacity_orders(broker, symbol, artifact_dir)
    records["results"] = results
    records["after_count"] = len(after)
    print(f"Cleanup 완료: 종료 후 추적된 smoke-capacity OPEN {len(after)}건 (0이어야 정상)")

    artifact_path = Path(artifact_dir) / f"{symbol}-capacity-cleanup-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    save_artifact(records, artifact_path)
    print(f"(redacted) Cleanup 기록 저장: {artifact_path}")
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--env-file", default="deploy/mumae.env")
    parser.add_argument("--artifact-dir", default="smoke_artifacts")
    parser.add_argument("--stage", type=int, choices=[1, 2, 3, 4], help="Run this BUY-side numbered stage (requires --approved).")
    parser.add_argument("--side", choices=["buy", "sell"], help="Generic side-aware run (use with --start-sequence/--count).")
    parser.add_argument("--start-sequence", type=int, help="First sequence number for --side.")
    parser.add_argument("--count", type=int, help="How many new orders to create for --side.")
    parser.add_argument("--cleanup", action="store_true", help="DELETE all tracked smoke-capacity OPEN orders (requires --approved).")
    parser.add_argument("--approved", action="store_true", help="Explicit human approval for this run's mutating calls.")
    args = parser.parse_args()

    symbol = args.symbol.upper()
    if symbol not in ETF_UNIVERSE:
        raise SystemExit(f"{symbol}: not in this app's known ETF universe; refusing.")

    load_env(args.env_file)
    broker = TossBroker()
    if broker.mode != "LIVE":
        raise SystemExit(f"Refusing: broker.mode={broker.mode!r}, expected LIVE.")

    if args.cleanup:
        run_cleanup(broker, symbol, args.approved, args.artifact_dir)
        return
    if args.side is not None:
        if args.start_sequence is None or args.count is None:
            raise SystemExit("--side requires both --start-sequence and --count.")
        if not broker.live_ack:
            raise SystemExit("Refusing: MUMAE_LIVE_TRADING_ACK not set in --env-file.")
        run_side_stage(broker, symbol, args.side, args.start_sequence, args.count, args.approved, args.artifact_dir)
        return
    if args.stage is not None:
        if not broker.live_ack:
            raise SystemExit("Refusing: MUMAE_LIVE_TRADING_ACK not set in --env-file.")
        run_stage(broker, symbol, args.stage, args.approved, args.artifact_dir)
        return

    records: dict[str, Any] = {"symbol": symbol, "generated_at": datetime.now(timezone.utc).isoformat()}

    market_session = classify_market_session(broker)
    current_price = fetch_current_price(broker, symbol)
    buying_power = fetch_buying_power(broker)
    expire_date = resolve_expire_date(broker)
    existing_open = get_all_conditional_orders(broker, status="OPEN", symbol=symbol)
    existing_smoke = existing_smoke_capacity_orders(broker, symbol, args.artifact_dir)

    records["market_session"] = market_session
    records["current_price"] = str(current_price)
    records["buying_power"] = str(buying_power)
    records["expire_date"] = expire_date
    records["existing_open_count"] = len(existing_open)
    records["existing_open_orders"] = existing_open
    records["existing_smoke_capacity_orders"] = existing_smoke

    print("=== Stage 0: 사전 상태 (READ-ONLY) ===")
    print(f"symbol: {symbol}")
    print(f"market_session: {market_session}")
    print(f"현재가 P: {current_price}")
    print(f"buying power: {buying_power}")
    print(f"expireDate (Stage 1 계획용): {expire_date}")
    print(f"기존 OPEN conditional order 총 개수: {len(existing_open)}")
    print(f"기존 smoke-capacity-{symbol}- prefix 주문 개수: {len(existing_smoke)}")
    if existing_smoke:
        _print_json("기존 smoke-capacity 주문 (주의: 이번 실행 전에 이미 존재함)", existing_smoke)

    stage1 = plan_stage_orders(symbol, current_price, expire_date, start_sequence=1, count=10)
    records["stage1_plan"] = [asdict(r) for r in stage1]
    print("\n=== Stage 1 CREATE 계획 (10건, 아직 생성하지 않음) ===")
    for request in stage1:
        print(f"  clientOrderId={request.client_order_id} triggerPrice={request.trigger_price} orderPrice={request.order_price}")
    print("\n이 스크립트는 Stage 1의 실제 CREATE를 수행하지 않습니다. 사용자 승인 후 별도 단계에서 진행합니다.")

    artifact_path = Path(args.artifact_dir) / f"{symbol}-capacity-stage0-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    save_artifact(records, artifact_path)
    print(f"\n(redacted) Stage 0 기록 저장: {artifact_path}")


if __name__ == "__main__":
    main()
