import json
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal

from toss_api import TossApiError
from smoke_conditional_order import (
    UnexpectedConditionalOrderStateError,
    cancel_smoke_order,
    classify_market_session,
    compute_smoke_order,
    create_smoke_order,
    evaluate_post_create_detail,
    fetch_buying_power,
    fetch_current_price,
    resolve_expire_date,
    trigger_already_satisfied,
    verify_after_cancel,
)


def _session(date_str, start, end):
    return {"startTime": f"{date_str}T{start}", "endTime": f"{date_str}T{end}"}


class FakeSmokeBroker:
    """Fully in-memory fake matching the real, verified Toss schema (Phase
    13). Zero real network calls -- every method is a local dict lookup."""

    def __init__(self, mode="LIVE"):
        self.mode = mode
        self.live_ack = True
        self.calendar_by_date: dict[str, dict] = {}
        self.prices: dict[str, str] = {}
        self.buying_power = "1000"
        self.conditional_orders: dict[str, dict] = {}
        self.cancelled: set[str] = set()
        self.cancel_error: Exception | None = None
        self.detail_error: Exception | None = None
        self._next_id = 1

    def set_calendar_day(self, target_date, **sessions):
        """sessions: e.g. regularMarket=("09:30:00-04:00","16:00:00-04:00")"""
        entry = self.calendar_by_date.setdefault(target_date, {"date": target_date})
        for key, (start, end) in sessions.items():
            entry[key] = _session(target_date, start, end)

    def get_us_market_calendar_raw(self, date_value=None):
        target = date_value or date.today().isoformat()
        return {"result": {"today": self.calendar_by_date.get(target, {"date": target})}}

    def get_prices_raw(self, symbols):
        return {"result": [
            {"symbol": s, "lastPrice": self.prices.get(s, "0"), "timestamp": date.today().isoformat() + "T13:00:00+09:00"}
            for s in symbols
        ]}

    def get_buying_power_raw(self):
        return {"result": {"cashBuyingPower": self.buying_power}}

    def _account_headers(self):
        return {}

    def _request(self, method, path, data=None, headers=None):
        if method == "POST" and path == "/api/v1/conditional-orders":
            payload = json.loads(data)
            coid = f"co-{self._next_id}"
            self._next_id += 1
            self.conditional_orders[coid] = {
                "conditionalOrderId": coid, "clientOrderId": payload["clientOrderId"],
                "symbol": payload["symbol"], "status": "WATCHING",
                "first": {
                    "status": "WATCHING", "orderSide": payload["first"]["orderSide"],
                    "triggerPrice": payload["first"]["triggerPrice"], "orderPrice": payload["first"]["orderPrice"],
                    "triggeredOrderId": None,
                },
            }
            return {"result": {"conditionalOrderId": coid, "clientOrderId": payload["clientOrderId"]}}
        if method == "GET" and path.startswith("/api/v1/conditional-orders/") and not path.endswith("/modify"):
            coid = path.rsplit("/", 1)[-1]
            if self.detail_error:
                raise self.detail_error
            row = self.conditional_orders.get(coid)
            if row is None:
                raise TossApiError("Toss API HTTP 404: not found")
            return {"result": dict(row)}
        if method == "DELETE" and path.startswith("/api/v1/conditional-orders/"):
            coid = path.rsplit("/", 1)[-1]
            if self.cancel_error:
                raise self.cancel_error
            if coid not in self.conditional_orders:
                raise TossApiError("Toss API HTTP 404: not found")
            del self.conditional_orders[coid]
            self.cancelled.add(coid)
            return {}
        if method == "GET" and path.startswith("/api/v1/conditional-orders"):
            symbol = path.split("symbol=")[1].split("&")[0] if "symbol=" in path else None
            rows = [row for row in self.conditional_orders.values() if symbol is None or row["symbol"] == symbol]
            return {"result": {"conditionalOrders": rows, "hasNext": False, "nextCursor": None}}
        raise AssertionError(f"unexpected _request call: {method} {path}")

    def seed_watching_order(self, symbol="TQQQ", trigger="70.00"):
        coid = f"co-{self._next_id}"
        self._next_id += 1
        self.conditional_orders[coid] = {
            "conditionalOrderId": coid, "clientOrderId": "smoke-seed",
            "symbol": symbol, "status": "WATCHING",
            "first": {"status": "WATCHING", "orderSide": "BUY", "triggerPrice": trigger, "orderPrice": trigger, "triggeredOrderId": None},
        }
        return coid


class MarketSessionClassificationTests(unittest.TestCase):
    def test_closed_when_no_session_window_contains_now(self):
        broker = FakeSmokeBroker()
        now = datetime(2026, 8, 22, 3, 0, tzinfo=timezone.utc)  # deep KST early morning, no US session
        self.assertEqual(classify_market_session(broker, now), "CLOSED")

    def test_detects_regular_session(self):
        broker = FakeSmokeBroker()
        broker.set_calendar_day("2026-08-21", regularMarket=("09:30:00-04:00", "16:00:00-04:00"))
        now = datetime(2026, 8, 21, 15, 0, tzinfo=timezone.utc)  # 11:00 ET, inside regular hours
        self.assertEqual(classify_market_session(broker, now), "REGULAR")

    def test_detects_after_hours_session(self):
        broker = FakeSmokeBroker()
        broker.set_calendar_day("2026-08-21", afterMarket=("16:00:00-04:00", "20:00:00-04:00"))
        now = datetime(2026, 8, 21, 21, 0, tzinfo=timezone.utc)  # 17:00 ET
        self.assertEqual(classify_market_session(broker, now), "AFTER")

    def test_closed_between_sessions_even_if_a_session_exists_that_day(self):
        broker = FakeSmokeBroker()
        broker.set_calendar_day("2026-08-21", regularMarket=("09:30:00-04:00", "16:00:00-04:00"))
        now = datetime(2026, 8, 21, 3, 0, tzinfo=timezone.utc)  # well before regular open, no other session
        self.assertEqual(classify_market_session(broker, now), "CLOSED")


class CreateGateTests(unittest.TestCase):
    def _request(self):
        from vr_conditional_orders import ConditionalOrderRequest
        return ConditionalOrderRequest(
            symbol="TQQQ", side="buy", trigger_price=Decimal("70.00"), order_price=Decimal("70.00"),
            quantity=1, expire_date="2026-08-25", client_order_id="smoke-TQQQ-20260821000000",
        )

    def test_blocked_when_session_is_not_closed(self):
        broker = FakeSmokeBroker()
        with self.assertRaises(RuntimeError):
            create_smoke_order(broker, self._request(), market_session="REGULAR", approved=True)
        self.assertEqual(broker.conditional_orders, {})

    def test_blocked_without_explicit_approval(self):
        broker = FakeSmokeBroker()
        with self.assertRaises(RuntimeError):
            create_smoke_order(broker, self._request(), market_session="CLOSED", approved=False)
        self.assertEqual(broker.conditional_orders, {})

    def test_succeeds_when_closed_and_approved(self):
        broker = FakeSmokeBroker()
        response = create_smoke_order(broker, self._request(), market_session="CLOSED", approved=True)
        self.assertIn("conditionalOrderId", response["result"])
        self.assertEqual(len(broker.conditional_orders), 1)

    def test_still_blocked_when_open_market_without_the_explicit_override(self):
        broker = FakeSmokeBroker()
        with self.assertRaises(RuntimeError):
            create_smoke_order(broker, self._request(), market_session="REGULAR", approved=True)
        self.assertEqual(broker.conditional_orders, {})

    def test_succeeds_when_open_market_with_explicit_override(self):
        broker = FakeSmokeBroker()
        response = create_smoke_order(
            broker, self._request(), market_session="REGULAR", approved=True, allow_open_market=True,
        )
        self.assertIn("conditionalOrderId", response["result"])

    def test_open_market_override_never_bypasses_the_approval_check(self):
        broker = FakeSmokeBroker()
        with self.assertRaises(RuntimeError):
            create_smoke_order(
                broker, self._request(), market_session="REGULAR", approved=False, allow_open_market=True,
            )
        self.assertEqual(broker.conditional_orders, {})


class PostCreateEvaluationTests(unittest.TestCase):
    def _detail(self, status="WATCHING", triggered_order_id=None):
        return {"result": {"status": status, "first": {"status": status, "triggeredOrderId": triggered_order_id}}}

    def test_watching_with_no_trigger_proceeds(self):
        self.assertEqual(evaluate_post_create_detail(self._detail()), "PROCEED")

    def test_ordering_halts(self):
        with self.assertRaises(UnexpectedConditionalOrderStateError):
            evaluate_post_create_detail(self._detail(status="ORDERING"))

    def test_ordered_halts(self):
        with self.assertRaises(UnexpectedConditionalOrderStateError):
            evaluate_post_create_detail(self._detail(status="ORDERED"))

    def test_completed_halts(self):
        with self.assertRaises(UnexpectedConditionalOrderStateError):
            evaluate_post_create_detail(self._detail(status="COMPLETED"))

    def test_triggered_order_id_present_halts_even_if_status_looks_ok(self):
        with self.assertRaises(UnexpectedConditionalOrderStateError):
            evaluate_post_create_detail(self._detail(status="WATCHING", triggered_order_id="reg-1"))

    def test_unrecognized_status_halts_rather_than_being_guessed_at(self):
        with self.assertRaises(UnexpectedConditionalOrderStateError):
            evaluate_post_create_detail(self._detail(status="SOMETHING_NEW"))


class CancelGateAndVerificationTests(unittest.TestCase):
    def test_cancel_blocked_without_approval(self):
        broker = FakeSmokeBroker()
        coid = broker.seed_watching_order()
        with self.assertRaises(RuntimeError):
            cancel_smoke_order(broker, coid, approved=False)
        self.assertIn(coid, broker.conditional_orders, "unapproved cancel must not touch the order")

    def test_cancel_succeeds_when_approved_and_order_is_gone(self):
        broker = FakeSmokeBroker()
        coid = broker.seed_watching_order()
        cancel_smoke_order(broker, coid, approved=True)
        self.assertIn(coid, broker.cancelled)
        self.assertNotIn(coid, broker.conditional_orders)

    def test_verify_after_cancel_records_404_as_an_observation_not_an_exception(self):
        broker = FakeSmokeBroker()
        coid = broker.seed_watching_order(symbol="TQQQ")
        cancel_smoke_order(broker, coid, approved=True)  # now gone -> detail GET 404s

        records = verify_after_cancel(broker, coid, "TQQQ")

        self.assertIn("observed_error", records["detail_after_cancel"])
        self.assertEqual(records["open_list_after_cancel"]["conditionalOrders"], [])
        self.assertEqual(records["closed_list_after_cancel"]["conditionalOrders"], [])

    def test_verify_after_cancel_never_creates_a_new_order(self):
        broker = FakeSmokeBroker()
        coid = broker.seed_watching_order(symbol="TQQQ")
        cancel_smoke_order(broker, coid, approved=True)
        before = dict(broker.conditional_orders)
        verify_after_cancel(broker, coid, "TQQQ")
        self.assertEqual(broker.conditional_orders, before)


class TriggerAlreadySatisfiedTests(unittest.TestCase):
    def test_buy_trigger_at_or_above_current_price_is_flagged_satisfied(self):
        self.assertTrue(trigger_already_satisfied("buy", Decimal("100"), Decimal("100")))
        self.assertTrue(trigger_already_satisfied("buy", Decimal("100"), Decimal("90")))

    def test_buy_trigger_below_current_price_is_not_satisfied(self):
        self.assertFalse(trigger_already_satisfied("buy", Decimal("70"), Decimal("100")))


class ExpireDateResolutionTests(unittest.TestCase):
    def test_skips_a_holiday_and_lands_on_the_next_trading_day_plus_buffer(self):
        broker = FakeSmokeBroker()
        # 2026-08-22 (Sat) / 2026-08-23 (Sun) closed; 2026-08-24 (Mon) is the
        # next real trading day.
        broker.set_calendar_day("2026-08-24", regularMarket=("09:30:00-04:00", "16:00:00-04:00"))
        now = datetime(2026, 8, 21, 22, 0, tzinfo=timezone.utc)  # after Friday close
        result = resolve_expire_date(broker, now=now, buffer_days=2, search_days=10)
        self.assertEqual(result, "2026-08-26")  # 08-24 + 2 day buffer

    def test_raises_if_no_trading_day_found_within_the_search_window(self):
        broker = FakeSmokeBroker()
        now = datetime(2026, 8, 21, 22, 0, tzinfo=timezone.utc)
        with self.assertRaises(RuntimeError):
            resolve_expire_date(broker, now=now, search_days=3)


class ComputeSmokeOrderTests(unittest.TestCase):
    def test_trigger_is_70_percent_of_current_price_rounded_to_the_cent(self):
        now = datetime(2026, 8, 21, 22, 0, tzinfo=timezone.utc)
        request = compute_smoke_order("TQQQ", Decimal("110.55"), "2026-08-26", now=now)
        self.assertEqual(request.trigger_price, Decimal("77.39"))  # 110.55 * 0.70 = 77.385 -> HALF_UP -> 77.39
        self.assertEqual(request.order_price, request.trigger_price)
        self.assertEqual(request.quantity, 1)
        self.assertEqual(request.side, "buy")

    def test_client_order_id_is_smoke_prefixed_and_symbol_specific(self):
        now = datetime(2026, 8, 21, 22, 0, tzinfo=timezone.utc)
        request = compute_smoke_order("TQQQ", Decimal("100"), "2026-08-26", now=now)
        self.assertTrue(request.client_order_id.startswith("smoke-TQQQ-"))


class AccountReadTests(unittest.TestCase):
    def test_fetch_current_price(self):
        broker = FakeSmokeBroker()
        broker.prices["TQQQ"] = "110.55"
        self.assertEqual(fetch_current_price(broker, "TQQQ"), Decimal("110.55"))

    def test_fetch_current_price_rejects_non_positive(self):
        broker = FakeSmokeBroker()
        with self.assertRaises(RuntimeError):
            fetch_current_price(broker, "TQQQ")

    def test_fetch_buying_power(self):
        broker = FakeSmokeBroker()
        broker.buying_power = "543.21"
        self.assertEqual(fetch_buying_power(broker), Decimal("543.21"))


if __name__ == "__main__":
    unittest.main()
