import json
import unittest
from decimal import Decimal

from toss_api import TossApiError
from vr_conditional_orders import (
    CLIENT_ORDER_ID_MAX_LENGTH,
    ConditionalOrderRequest,
    UnknownConditionalOrderStatusError,
    build_client_order_id,
    build_conditional_order_payload,
    cancel_conditional_order,
    create_conditional_order,
    get_all_conditional_orders,
    get_conditional_orders,
    parse_triggered_order_id,
    validate_group_status,
    validate_leg_status,
)


class RecordingBroker:
    """Fake broker: never opens a real socket. Simulates the REAL Toss
    conditional-order HTTP surface (POST create, DELETE cancel -> 204,
    GET list with required status= query), verified against the live
    official OpenAPI spec (Phase 13). Records every _request call so tests
    can assert exactly what would have been sent, and assert zero calls
    happen in DRY_RUN."""

    def __init__(self, mode="DRY_RUN", live_ack=False):
        self.mode = mode
        self.live_ack = live_ack
        self.requests: list[tuple] = []
        self.fail_cancel_with: TossApiError | None = None

    def _account_headers(self):
        return {"X-Tossinvest-Account": "acct-1"}

    def _request(self, method, path, data=None, headers=None):
        self.requests.append((method, path, data, headers))
        if method == "DELETE":
            if self.fail_cancel_with is not None:
                raise self.fail_cancel_with
            return {}  # 204 No Content
        if method == "GET":
            return {"result": {"conditionalOrders": [], "hasNext": False, "nextCursor": None}}
        return {"result": {"conditionalOrderId": "co-999", "clientOrderId": None}}


def _request_(sequence=1, symbol="TQQQ", cycle_id="c1", side="buy"):
    client_order_id = build_client_order_id(symbol, cycle_id, side, sequence)
    return ConditionalOrderRequest(
        symbol=symbol, side=side, trigger_price=Decimal("100.50"),
        order_price=Decimal("100.50"), quantity=5,
        expire_date="2026-08-21", client_order_id=client_order_id,
    )


class ClientOrderIdTests(unittest.TestCase):
    def test_identical_inputs_produce_identical_ids(self):
        first = build_client_order_id("TQQQ", "c1", "buy", 1)
        second = build_client_order_id("TQQQ", "c1", "buy", 1)
        self.assertEqual(first, second)

    def test_different_sequence_changes_the_id(self):
        first = build_client_order_id("TQQQ", "c1", "buy", 1)
        second = build_client_order_id("TQQQ", "c1", "buy", 2)
        self.assertNotEqual(first, second)

    def test_different_side_changes_the_id(self):
        buy_id = build_client_order_id("TQQQ", "c1", "buy", 1)
        sell_id = build_client_order_id("TQQQ", "c1", "sell", 1)
        self.assertNotEqual(buy_id, sell_id)

    def test_different_symbol_changes_the_id(self):
        tqqq_id = build_client_order_id("TQQQ", "c1", "buy", 1)
        soxl_id = build_client_order_id("SOXL", "c1", "buy", 1)
        self.assertNotEqual(tqqq_id, soxl_id)

    def test_stays_within_toss_length_limit(self):
        # Real API: clientOrderId maxLength 36, pattern ^[a-zA-Z0-9\-_]+$
        client_order_id = build_client_order_id("TQQQ", "cycle-with-a-very-long-identifier-string", "buy", 1)
        self.assertLessEqual(len(client_order_id), CLIENT_ORDER_ID_MAX_LENGTH)

    def test_long_id_truncation_still_preserves_determinism(self):
        first = build_client_order_id("TQQQ", "cycle-with-a-very-long-identifier-string", "buy", 1)
        second = build_client_order_id("TQQQ", "cycle-with-a-very-long-identifier-string", "buy", 1)
        self.assertEqual(first, second)


class PayloadBuilderTests(unittest.TestCase):
    def test_builds_single_conditional_order_payload_matching_the_real_schema(self):
        # Verified against ConditionalOrderCreateRequest in the live official
        # OpenAPI spec (Phase 13): type=SINGLE/OCO/OTO is the grouping,
        # orderType=LIMIT/MARKET is the underlying order type (a different
        # concept despite the similar name), and orderSide/triggerPrice/
        # orderPrice live nested under `first`, not at the top level.
        request = _request_()
        payload = build_conditional_order_payload(request)
        self.assertEqual(payload["type"], "SINGLE")
        self.assertEqual(payload["orderType"], "LIMIT")
        self.assertEqual(payload["symbol"], "TQQQ")
        self.assertEqual(payload["quantity"], "5")
        self.assertEqual(payload["expireDate"], "2026-08-21")
        self.assertEqual(payload["clientOrderId"], request.client_order_id)
        self.assertNotIn("side", payload)
        self.assertNotIn("triggerPrice", payload)
        self.assertNotIn("price", payload)
        self.assertEqual(payload["first"], {
            "orderSide": "BUY", "triggerPrice": "100.50", "orderPrice": "100.50",
        })
        self.assertNotIn("second", payload)

    def test_rejects_non_positive_quantity(self):
        request = ConditionalOrderRequest(
            symbol="TQQQ", side="buy", trigger_price=Decimal("100"),
            order_price=Decimal("100"), quantity=0,
            expire_date="2026-08-21", client_order_id="x",
        )
        with self.assertRaises(ValueError):
            build_conditional_order_payload(request)

    def test_rejects_non_positive_price(self):
        request = ConditionalOrderRequest(
            symbol="TQQQ", side="buy", trigger_price=Decimal("0"),
            order_price=Decimal("100"), quantity=5,
            expire_date="2026-08-21", client_order_id="x",
        )
        with self.assertRaises(ValueError):
            build_conditional_order_payload(request)


class DryRunNeverTouchesNetworkTests(unittest.TestCase):
    def test_create_in_dry_run_never_calls_request(self):
        broker = RecordingBroker(mode="DRY_RUN")
        result = create_conditional_order(broker, _request_())
        self.assertEqual(result["status"], "DRY_RUN")
        self.assertEqual(broker.requests, [])

    def test_cancel_in_dry_run_never_calls_request(self):
        broker = RecordingBroker(mode="DRY_RUN")
        result = cancel_conditional_order(broker, "co-123")
        self.assertEqual(result["status"], "DRY_RUN")
        self.assertEqual(broker.requests, [])


class LiveGateTests(unittest.TestCase):
    def test_live_without_ack_is_rejected(self):
        broker = RecordingBroker(mode="LIVE", live_ack=False)
        with self.assertRaises(PermissionError):
            create_conditional_order(broker, _request_())
        self.assertEqual(broker.requests, [])

    def test_live_with_ack_calls_request_with_built_payload(self):
        broker = RecordingBroker(mode="LIVE", live_ack=True)
        request = _request_()
        create_conditional_order(broker, request)
        self.assertEqual(len(broker.requests), 1)
        method, path, data, headers = broker.requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(path, "/api/v1/conditional-orders")

    def test_retry_sends_the_identical_client_order_id_both_times(self):
        broker = RecordingBroker(mode="LIVE", live_ack=True)
        request = _request_()
        create_conditional_order(broker, request)
        create_conditional_order(broker, request)  # simulated network retry
        self.assertEqual(len(broker.requests), 2)
        first_payload = json.loads(broker.requests[0][2])
        second_payload = json.loads(broker.requests[1][2])
        self.assertEqual(first_payload["clientOrderId"], second_payload["clientOrderId"])

    def test_cancel_uses_delete_method_and_the_id_in_the_path(self):
        broker = RecordingBroker(mode="LIVE", live_ack=True)
        cancel_conditional_order(broker, "co-42")
        self.assertEqual(len(broker.requests), 1)
        method, path, data, headers = broker.requests[0]
        self.assertEqual(method, "DELETE")
        self.assertEqual(path, "/api/v1/conditional-orders/co-42")

    def test_cancel_success_returns_the_204_empty_dict(self):
        # No `status` field exists on a real cancel response -- success is
        # "the call didn't raise" (see TossApiError test below).
        broker = RecordingBroker(mode="LIVE", live_ack=True)
        result = cancel_conditional_order(broker, "co-42")
        self.assertEqual(result, {})

    def test_cancel_failure_raises_toss_api_error(self):
        broker = RecordingBroker(mode="LIVE", live_ack=True)
        broker.fail_cancel_with = TossApiError("Toss API HTTP 404: not found")
        with self.assertRaises(TossApiError):
            cancel_conditional_order(broker, "co-42")


class GetConditionalOrdersTests(unittest.TestCase):
    def test_status_is_a_required_query_parameter(self):
        broker = RecordingBroker(mode="DRY_RUN")
        get_conditional_orders(broker, status="OPEN", symbol="TQQQ")
        self.assertEqual(len(broker.requests), 1)
        method, path, _, _ = broker.requests[0]
        self.assertEqual(method, "GET")
        self.assertIn("status=OPEN", path)
        self.assertIn("symbol=TQQQ", path)

    def test_rejects_invalid_status(self):
        broker = RecordingBroker(mode="DRY_RUN")
        with self.assertRaises(ValueError):
            get_conditional_orders(broker, status="BOGUS")

    def test_read_query_is_allowed_even_in_dry_run(self):
        # Reading conditional orders is never an order-placing action, so it
        # is not gated behind LIVE/live_ack the way create/cancel are.
        broker = RecordingBroker(mode="DRY_RUN")
        result = get_conditional_orders(broker, status="CLOSED")
        self.assertIn("result", result)

    def test_get_all_paginates_using_cursor_and_has_next(self):
        class PaginatingBroker(RecordingBroker):
            def __init__(self):
                super().__init__(mode="DRY_RUN")
                self._pages = [
                    {"result": {"conditionalOrders": [{"conditionalOrderId": "co-1"}], "hasNext": True, "nextCursor": "page2"}},
                    {"result": {"conditionalOrders": [{"conditionalOrderId": "co-2"}], "hasNext": False, "nextCursor": None}},
                ]

            def _request(self, method, path, data=None, headers=None):
                self.requests.append((method, path, data, headers))
                return self._pages.pop(0)

        broker = PaginatingBroker()
        orders = get_all_conditional_orders(broker, status="OPEN", symbol="TQQQ")
        self.assertEqual([o["conditionalOrderId"] for o in orders], ["co-1", "co-2"])
        self.assertEqual(len(broker.requests), 2)
        self.assertIn("cursor=page2", broker.requests[1][1])


class FailClosedParsingTests(unittest.TestCase):
    def test_rejects_unknown_group_status(self):
        with self.assertRaises(UnknownConditionalOrderStatusError):
            validate_group_status("SOMETHING_NEW")

    def test_rejects_missing_group_status(self):
        with self.assertRaises(UnknownConditionalOrderStatusError):
            validate_group_status(None)

    def test_accepts_every_documented_group_status(self):
        for status in ("WATCHING", "PAUSED", "ORDERING", "ORDERED", "COMPLETED", "EXPIRED"):
            self.assertEqual(validate_group_status(status), status)

    def test_group_status_rejects_leg_only_values(self):
        # HOLDING/CANCELED are valid for a leg but never at the group level.
        with self.assertRaises(UnknownConditionalOrderStatusError):
            validate_group_status("HOLDING")
        with self.assertRaises(UnknownConditionalOrderStatusError):
            validate_group_status("CANCELED")

    def test_accepts_every_documented_leg_status(self):
        for status in ("WATCHING", "PAUSED", "ORDERING", "ORDERED", "COMPLETED", "EXPIRED", "HOLDING", "CANCELED"):
            self.assertEqual(validate_leg_status(status), status)

    def test_rejects_unknown_leg_status(self):
        with self.assertRaises(UnknownConditionalOrderStatusError):
            validate_leg_status("MYSTERY")

    def test_missing_triggered_order_id_key_parses_to_none(self):
        self.assertIsNone(parse_triggered_order_id({}))

    def test_null_triggered_order_id_parses_to_none(self):
        self.assertIsNone(parse_triggered_order_id({"triggeredOrderId": None}))

    def test_present_triggered_order_id_parses_as_string(self):
        self.assertEqual(parse_triggered_order_id({"triggeredOrderId": "reg-1"}), "reg-1")


if __name__ == "__main__":
    unittest.main()
