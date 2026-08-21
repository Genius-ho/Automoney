"""Toss Conditional Order (SINGLE) adapter for VR_SKILL.

Schema verified against the live official OpenAPI spec fetched read-only
from https://openapi.tossinvest.com/openapi-docs/latest/openapi.json on
2026-08-20 (see Phase 13 report) -- NOT guessed. An earlier version of this
module used an invented flat schema; it has been corrected to match the
real, nested request/response shape below.

Real endpoints (confirmed from components.schemas /
ConditionalOrderCreateRequest, ConditionalOrderDetailResponse,
ConditionalOrderCondition):

    POST   /api/v1/conditional-orders                          create
    GET    /api/v1/conditional-orders?status=OPEN|CLOSED&...    list (status required)
    GET    /api/v1/conditional-orders/{conditionalOrderId}      detail
    DELETE /api/v1/conditional-orders/{conditionalOrderId}      cancel -> 204 No Content

Toss groups up to two "legs" (first/second) under one SINGLE/OCO/OTO `type`.
VR_SKILL only ever creates SINGLE orders (a lone `first` leg); OCO/OTO and
`second` are real API features this module never exercises.

Field-name traps the real schema has that a naive flat model would get
wrong (see components.schemas.ConditionalOrderCreateRequest /
ConditionalOrderCondition):
  - `type` (top level) is SINGLE/OCO/OTO -- the conditional-order grouping.
  - `orderType` (top level, unrelated name collision) is LIMIT/MARKET -- the
    underlying order's own order type, shared by all legs.
  - `orderSide`/`triggerPrice`/`orderPrice` live *inside* `first` (and
    `second` for OCO/OTO), never at the top level.
  - Create's response has no `status` field, only `conditionalOrderId` and
    an echoed `clientOrderId`.
  - Cancel (DELETE) returns 204 No Content -- no body, no `status` field to
    inspect; success is "the call didn't raise" (TossBroker._request()
    tolerates the empty body; see toss_api.py).
  - `status` enums differ by level: the top-level (group) status is
    {WATCHING, PAUSED, ORDERING, ORDERED, COMPLETED, EXPIRED}; each leg's
    own `status` additionally allows HOLDING (OTO's second, waiting on
    first) and CANCELED (the losing side of a completed OCO) -- values that
    never appear at the top level.
  - `triggeredOrderId` lives on the *leg* (`first.triggeredOrderId`), not at
    the top level.

Confirmed empirically (not just from the spec) by the Phase 14 real-account
smoke test, 2026-08-21, TQQQ, conditionalOrderId
1gLL0XyY_g3qIoUPuK6BRAcyxV78P-U5zJBl-CRVZ6s (see smoke_artifacts/, redacted):
  - GET detail's `first` object does NOT include `orderSide` at all -- only
    `type` ("STOP" for our SINGLE stop-condition legs), `status`,
    `triggerPrice`, `orderPrice`, `targetProfitRate` (null, unused here),
    `triggeredOrderId`. This module never reads `orderSide` back from a GET/
    list response (only sends it on CREATE), so this has no code impact --
    documented here so nobody adds a read of a field that isn't there.
  - Immediately after a confirmed 204 DELETE: the detail GET 404s
    (`conditional-order-not-found`), and the cancelled order appears in
    NEITHER the OPEN nor the CLOSED list -- it simply stops existing rather
    than transitioning into a terminal CLOSED entry. cancel_and_confirm()
    already only relies on the DELETE call itself (204 or a 404 on retry),
    never on any later GET/list state, so this is consistent with existing
    code, not a fix.
  - Top-level `status` and `first.status` were both `WATCHING` immediately
    after CREATE, with `first.triggeredOrderId: null` -- exactly the single
    documented-safe outcome evaluate_post_create_detail() already required.
  - The real trigger-comparator direction for a BUY STOP still was NOT
    exercised (the order was cancelled before any price movement could
    trigger it) -- still unverified, still must not be assumed.

create_conditional_order/cancel_conditional_order reuse the exact same
LIVE/DRY_RUN/live_ack gate that TossBroker.submit_order/cancel_order already
enforce (toss_api.py), and in LIVE mode call the same private
broker._request() primitive those methods use. LIVE conditional orders are
out of scope for this project phase -- every call exercised by this
codebase's tests runs in DRY_RUN/fake and never reaches a real socket.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from urllib.parse import urlencode

CLIENT_ORDER_ID_MAX_LENGTH = 36

# Group-level (top of a conditional order): the "representative" status of
# whichever leg is live. Excludes leg-only HOLDING/CANCELED.
GROUP_STATUSES = frozenset({"WATCHING", "PAUSED", "ORDERING", "ORDERED", "COMPLETED", "EXPIRED"})
# Leg-level (first/second condition): adds HOLDING and CANCELED.
LEG_STATUSES = GROUP_STATUSES | {"HOLDING", "CANCELED"}


def build_client_order_id(symbol: str, cycle_id: str, side: str, sequence: int) -> str:
    """Deterministic, idempotent clientOrderId so a network retry can never
    create a duplicate conditional order for the same logical VR leg.

    Format: vr-{symbol}-{cycle_id}-{side}-{sequence:02d}-{stable suffix}.
    The suffix is a hash of the identifying fields (not random), so retrying
    with the same symbol/cycle/side/sequence always reproduces the same id.
    Must satisfy the real API's clientOrderId pattern
    ^[a-zA-Z0-9\\-_]+$ and maxLength 36 (ConditionalOrderCreateRequest).
    """
    prefix = f"vr-{symbol}-{cycle_id}-{side}-{sequence:02d}"
    stable_suffix = hashlib.sha1(prefix.encode("utf-8")).hexdigest()[:8]
    client_order_id = f"{prefix}-{stable_suffix}"
    if len(client_order_id) > CLIENT_ORDER_ID_MAX_LENGTH:
        # Trim the human-readable prefix, never the hash, so truncated ids
        # stay just as deterministic/collision-resistant as untruncated ones.
        keep = CLIENT_ORDER_ID_MAX_LENGTH - len(stable_suffix) - 1
        client_order_id = f"{prefix[:keep]}-{stable_suffix}"
    return client_order_id


@dataclass(frozen=True)
class ConditionalOrderRequest:
    symbol: str
    side: str  # "buy" | "sell" -> ConditionRequest.orderSide (BUY/SELL)
    trigger_price: Decimal
    order_price: Decimal
    quantity: int
    expire_date: str  # ISO date; the cycle's last trading day, per spec
    client_order_id: str


def build_conditional_order_payload(request: ConditionalOrderRequest) -> dict:
    """Build a SINGLE POST /api/v1/conditional-orders payload matching
    ConditionalOrderCreateRequest: quantity/orderType/expireDate are
    group-level; orderSide/triggerPrice/orderPrice live under `first`. No
    `second` is sent (SINGLE omits it entirely, per the real schema)."""
    if request.quantity <= 0:
        raise ValueError("Quantity must be positive.")
    if request.trigger_price <= 0 or request.order_price <= 0:
        raise ValueError("Prices must be positive.")
    return {
        "symbol": request.symbol,
        "type": "SINGLE",
        "quantity": str(request.quantity),
        "orderType": "LIMIT",
        "clientOrderId": request.client_order_id,
        "expireDate": request.expire_date,
        "first": {
            "orderSide": request.side.upper(),
            "triggerPrice": str(request.trigger_price),
            "orderPrice": str(request.order_price),
        },
    }


def create_conditional_order(broker, request: ConditionalOrderRequest) -> dict:
    """POST /api/v1/conditional-orders. Mirrors
    TossBroker.submit_order's own LIVE/DRY_RUN gate exactly (see module
    docstring for why this isn't a TossBroker method)."""
    payload = build_conditional_order_payload(request)
    if broker.mode != "LIVE":
        return {"status": "DRY_RUN", "clientOrderId": request.client_order_id}
    if not broker.live_ack:
        raise PermissionError("Set MUMAE_LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_TRADING in .env before live trading.")
    return broker._request(
        "POST", "/api/v1/conditional-orders",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **broker._account_headers()},
    )


def cancel_conditional_order(broker, conditional_order_id: str) -> dict:
    """DELETE /api/v1/conditional-orders/{id}, mirroring
    TossBroker.cancel_order's gate. The real endpoint returns 204 No
    Content on success (TossBroker._request() tolerates the empty body) and
    raises TossApiError on failure (400/404) -- callers must treat "this
    call returned without raising" as the only confirmation signal; there
    is no status field to inspect."""
    if broker.mode != "LIVE":
        return {"status": "DRY_RUN", "conditionalOrderId": conditional_order_id}
    if not broker.live_ack:
        raise PermissionError("Set MUMAE_LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_TRADING in .env before live trading.")
    return broker._request(
        "DELETE", f"/api/v1/conditional-orders/{conditional_order_id}",
        headers=broker._account_headers(),
    )


def get_conditional_orders(broker, status: str = "OPEN", symbol: str | None = None) -> dict:
    """GET /api/v1/conditional-orders?status=OPEN|CLOSED&symbol=...

    `status` is a REQUIRED query parameter on the real API (no default
    "return everything" mode). Read-only, so -- like
    TossBroker.get_orders_raw -- never gated behind LIVE/live_ack."""
    if status not in ("OPEN", "CLOSED"):
        raise ValueError("status must be OPEN or CLOSED.")
    params = {"status": status}
    if symbol:
        params["symbol"] = symbol
    return broker._request("GET", "/api/v1/conditional-orders?" + urlencode(params), headers=broker._account_headers())


def get_all_conditional_orders(broker, status: str = "OPEN", symbol: str | None = None) -> list[dict]:
    """Page through GET /api/v1/conditional-orders (cursor/nextCursor/
    hasNext, per PaginatedConditionalOrderResponse), mirroring
    TossBroker.get_all_orders_raw's own pagination loop for regular orders."""
    if status not in ("OPEN", "CLOSED"):
        raise ValueError("status must be OPEN or CLOSED.")
    orders: list[dict] = []
    cursor: str | None = None
    while True:
        params = {"status": status}
        if symbol:
            params["symbol"] = symbol
        if cursor:
            params["cursor"] = cursor
        payload = broker._request(
            "GET", "/api/v1/conditional-orders?" + urlencode(params), headers=broker._account_headers()
        )
        result = payload.get("result", {})
        orders.extend(result.get("conditionalOrders", []))
        cursor = result.get("nextCursor")
        if not result.get("hasNext") or not cursor:
            return orders


def get_conditional_order(broker, conditional_order_id: str) -> dict:
    """GET /api/v1/conditional-orders/{id} -- single detail lookup."""
    return broker._request(
        "GET", f"/api/v1/conditional-orders/{conditional_order_id}", headers=broker._account_headers()
    )


class UnknownConditionalOrderStatusError(RuntimeError):
    """A conditional order (or one of its legs) reported a status value, or
    a related field, outside the documented schema. Per spec section 13-2,
    an unrecognized value must never be guessed at (e.g. assumed FILLED or
    CANCELED) -- callers must treat this as UNKNOWN_CONDITIONAL_STATUS and
    block new VR orders (rearm/cycle transition) for the affected symbol
    until a human resolves it."""


def validate_group_status(status: object) -> str:
    """Validate a conditional order's top-level (group) status. Raises
    UnknownConditionalOrderStatusError for anything outside GROUP_STATUSES
    -- including None/missing, which is never valid for a real response."""
    value = str(status).upper() if status is not None else None
    if value not in GROUP_STATUSES:
        raise UnknownConditionalOrderStatusError(f"Unexpected conditional order status: {status!r}")
    return value


def validate_leg_status(status: object) -> str:
    """Validate one leg's (first/second) status. Leg statuses additionally
    allow HOLDING/CANCELED, which are invalid at the group level."""
    value = str(status).upper() if status is not None else None
    if value not in LEG_STATUSES:
        raise UnknownConditionalOrderStatusError(f"Unexpected conditional order leg status: {status!r}")
    return value


def parse_triggered_order_id(leg: dict) -> str | None:
    """A leg's triggeredOrderId is None both when the key is entirely
    missing and when it is explicitly null -- both mean "not yet
    triggered" and are valid, not an error."""
    value = leg.get("triggeredOrderId")
    return None if value is None else str(value)
