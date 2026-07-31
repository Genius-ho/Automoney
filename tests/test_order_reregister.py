"""Tests for '수정 후 재등록' (edit-and-resubmit a cancelled/rejected custom
order). No real Toss API is ever contacted here: every broker used below is
a plain in-memory fake with no networking code, and none of them are ever
configured with real credentials. "LIVE" on these fakes is only the local
readiness flag TradingWebService checks (broker.mode/live_ack) -- it never
causes an actual HTTP call.
"""
import tempfile
import threading
import time
import unittest
from decimal import Decimal
from pathlib import Path

from application_engine import ApplicationEngine
from toss_api import TossApiError
from web_gui.trading_service import TradingWebService


class LiveTradingBroker:
    """Fake broker: mode/live_ack look "LIVE" to satisfy TradingWebService's
    internal readiness checks, but submit_order/cancel_order/get_all_orders_raw
    are pure in-memory state changes -- no sockets, no requests library."""

    mode = "LIVE"
    live_ack = True

    def __init__(self):
        self.open_orders: list[dict] = []
        self.closed_orders: list[dict] = []
        self.submitted: list[str] = []
        self.submit_delay = 0.0
        self.fail_next = False

    def get_all_orders_raw(self, status, symbol, from_date, to_date):
        rows = self.open_orders if status == "OPEN" else self.closed_orders
        return [row for row in rows if row.get("symbol", symbol) == symbol]

    def submit_order(self, order, client_order_id):
        if self.submit_delay:
            time.sleep(self.submit_delay)
        if self.fail_next:
            self.fail_next = False
            raise TossApiError("simulated rejection", code="rejected")
        self.submitted.append(order.client_order_id)
        broker_order_id = f"broker-{len(self.submitted)}-{client_order_id[:6]}"
        self.open_orders.append({
            "orderId": broker_order_id,
            "symbol": order.client_order_id.split("-")[1],
            "side": order.side.upper(),
            "quantity": str(order.quantity),
            "price": str(order.limit_price),
            "status": "PENDING",
        })
        return {"result": {"orderId": broker_order_id}}

    def cancel_order(self, order_id):
        return {"status": "CANCELED"}


def _service(temp, broker, **overrides) -> TradingWebService:
    service = TradingWebService(Path(temp), broker_factory=lambda: broker)
    payload = {
        "symbol": "TQQQ",
        "current_price": "84.5",
        "previous_close": "82",
        # Deliberately generous cash so the first strategy leg's computed
        # quantity is comfortably > 1 (needed for the partial-fill tests).
        "cash_usd": "50000",
        "position_qty": 40,
        "avg_cost": "75",
        "t_value": "3",
        "base_buy_qty": 2,
        "mode": "GENERAL",
    }
    payload.update(overrides)
    service.plan(payload)
    return service


def _activate(service: TradingWebService, symbol: str = "TQQQ") -> None:
    symbol = symbol.upper()
    if symbol not in service.runtime.active_symbols:
        service.runtime.active_symbols.append(symbol)
    if symbol not in service.runtime.known_symbols:
        service.runtime.known_symbols.append(symbol)
    service.runtime_store.save(service.runtime)


def _make_canceled_custom_order(
    service: TradingWebService,
    broker: LiveTradingBroker,
    symbol: str = "TQQQ",
    edited_price: str = "63.00",
    filled_quantity: int = 0,
    side: str | None = None,
    min_quantity: int = 1,
):
    """Drives the *real* code path (edit_failed_price -> submit_orders ->
    broker cancels -> sync_orders) so tests exercise the same mechanics a
    real user session would, rather than poking internal dicts directly.

    side/min_quantity pick which of the fixture's several strategy legs to
    use as the "original" order (the default fixture's first leg only has
    quantity=1, which is too small for the partial-fill/quantity tests)."""
    symbol = symbol.upper()
    order = next(
        item for item in service.plan_cache[symbol]
        if item.quantity >= min_quantity and (side is None or item.side == side)
    )
    cid = order.client_order_id
    service.runtime.skipped_order_ids.append(cid)
    service.runtime_store.save(service.runtime)
    service.edit_failed_price(symbol, cid, edited_price)
    service.sync_orders(symbol)
    service.submit_orders(symbol, [cid], f"SUBMIT {symbol} 1")
    broker_order_id = service.runtime.broker_order_ids[cid]
    broker.open_orders = [row for row in broker.open_orders if row["orderId"] != broker_order_id]
    broker.closed_orders.append({
        "orderId": broker_order_id,
        "symbol": symbol,
        "side": order.side.upper(),
        "quantity": str(order.quantity),
        "price": edited_price,
        "status": "CANCELED",
        "execution": {"filledQuantity": str(filled_quantity)},
    })
    service.sync_orders(symbol)
    return cid, order


class EligibilityTests(unittest.TestCase):
    def test_canceled_custom_order_is_flagged_reregisterable(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)

            synced = service.sync_orders("TQQQ")
            row = next(item for item in synced["orders"] if item["id"] == cid)

            self.assertTrue(row["is_custom"])
            self.assertEqual(row["status"], "CANCELED")
            self.assertIsNone(row["replaced_by"])

    def test_pending_order_is_not_flagged_reregisterable_status(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            order = service.plan_cache["TQQQ"][0]
            service.sync_orders("TQQQ")
            service.submit_orders("TQQQ", [order.client_order_id], "SUBMIT TQQQ 1")

            synced = service.sync_orders("TQQQ")
            row = next(item for item in synced["orders"] if item["id"] == order.client_order_id)

            self.assertEqual(row["status"], "PENDING")
            with self.assertRaises(ValueError):
                service.reregister_order(
                    "TQQQ", order.client_order_id, order.quantity, "80.00", "", f"REREGISTER TQQQ {order.client_order_id}",
                )

    def test_pure_strategy_order_without_any_edit_is_not_custom(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            order = service.plan_cache["TQQQ"][0]
            # Never edited -> no custom_order_ledger entry -> not eligible,
            # even though its client_order_id happens to exist.
            self.assertNotIn(order.client_order_id, service.runtime.custom_order_ledger)

            with self.assertRaises(ValueError) as ctx:
                service.reregister_order(
                    "TQQQ", order.client_order_id, order.quantity, "80.00", "", f"REREGISTER TQQQ {order.client_order_id}",
                )
            self.assertIn("사용자 지정 주문", str(ctx.exception))
            self.assertEqual(service.runtime.custom_order_history, {})


class ReregisterPayloadTests(unittest.TestCase):
    def test_reregister_creates_a_new_order_with_edited_quantity_and_price(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker, edited_price="63.00", min_quantity=2)
            new_quantity = order.quantity - 1  # a real edit, but still within the unfilled remaining amount

            result = service.reregister_order(
                "TQQQ", cid, new_quantity, "65.00", "재시도", f"REREGISTER TQQQ {cid}",
            )

            self.assertNotEqual(result["replacement_order_id"], cid)
            self.assertEqual(result["original_order_id"], cid)
            self.assertEqual(result["quantity_after"], new_quantity)
            self.assertEqual(result["price_after"], "65.00")
            new_id = result["replacement_order_id"]
            ledger = service.runtime.custom_order_ledger[new_id]
            self.assertEqual(ledger["quantity"], new_quantity)
            self.assertEqual(ledger["price"], "65.00")
            self.assertEqual(ledger["original_order_id"], cid)
            self.assertIn(new_id, broker.submitted)

    def test_original_order_is_never_deleted_or_modified(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)
            original_ledger_before = dict(service.runtime.custom_order_ledger[cid])

            result = service.reregister_order(
                "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
            )

            self.assertEqual(service.runtime.custom_order_ledger[cid], original_ledger_before)
            self.assertEqual(service.order_statuses["TQQQ"][cid], "CANCELED")
            self.assertEqual(
                service.runtime.custom_order_history[cid]["replacement_order_id"],
                result["replacement_order_id"],
            )
            new_row = next(row for row in service.sync_orders("TQQQ")["orders"] if row["id"] == result["replacement_order_id"])
            self.assertTrue(new_row["is_custom"])
            self.assertEqual(new_row["original_order_id"], cid)


class EtfPauseGateTests(unittest.TestCase):
    def test_paused_etf_blocks_final_submission_but_lookup_still_works(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)
            service.runtime.active_symbols.remove("TQQQ")
            service.runtime_store.save(service.runtime)

            with self.assertRaises(PermissionError):
                service.reregister_order(
                    "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
                )

            self.assertEqual(service.runtime.custom_order_history, {})
            self.assertNotIn(cid + "-reg", "".join(broker.submitted))


class FundsAndQuantityValidationTests(unittest.TestCase):
    def test_insufficient_buying_power_fails_clearly_and_creates_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker, cash_usd="100")
            _activate(service)
            # edited_price kept cheap (2 * 40 <= cash=100) so *setup* succeeds;
            # the reregister call below uses a much higher price to trigger
            # the insufficient-funds path being tested here.
            cid, order = _make_canceled_custom_order(service, broker, edited_price="40.00", side="buy", min_quantity=2)
            submitted_before = list(broker.submitted)

            with self.assertRaises(ValueError) as ctx:
                service.reregister_order(
                    "TQQQ", cid, order.quantity, "1000.00", "", f"REREGISTER TQQQ {cid}",
                )

            self.assertIn("주문 가능 금액", str(ctx.exception))
            self.assertEqual(broker.submitted, submitted_before)
            self.assertEqual(service.runtime.custom_order_history, {})
            self.assertFalse(any(key.startswith(cid + "-reg") for key in service.runtime.custom_order_ledger))

    def test_insufficient_sellable_quantity_blocks_sell_reregister(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker, side="sell", min_quantity=5, edited_price="90.00")
            # Simulate: some shares were sold elsewhere between the cancel and
            # the reregister attempt, so fewer are actually available now than
            # the original sell order needed.
            state = service.store.load("TQQQ")
            state.position_qty = order.quantity - 1
            service.store.save(state)

            with self.assertRaises(ValueError) as ctx:
                service.reregister_order(
                    "TQQQ", cid, order.quantity, "90.00", "", f"REREGISTER TQQQ {cid}",
                )
            self.assertIn("매도 가능 수량", str(ctx.exception))
            self.assertEqual(service.runtime.custom_order_history, {})


class RestartSurvivabilityTests(unittest.TestCase):
    def test_canceled_custom_order_is_visible_and_reregisterable_after_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker, edited_price="63.00")

            # Simulate a process restart: brand-new TradingWebService instance
            # pointed at the same data directory, with empty in-memory caches
            # (plan_cache, order_records, ... all reset). No plan()/build_plan()
            # call happens before we look the order up.
            restarted = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self.assertEqual(restarted.plan_cache, {})

            synced = restarted.sync_orders("TQQQ")
            row = next(item for item in synced["orders"] if item["id"] == cid)
            self.assertTrue(row["is_custom"])
            self.assertEqual(row["status"], "CANCELED")

            result = restarted.reregister_order(
                "TQQQ", cid, order.quantity, "70.00", "재시도", f"REREGISTER TQQQ {cid}",
            )
            self.assertEqual(result["original_order_id"], cid)
            self.assertIn(result["replacement_order_id"], broker.submitted)


class PartialFillTests(unittest.TestCase):
    def test_default_quantity_basis_is_remaining_not_original(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            order_quantity_probe = next(o.quantity for o in service.plan_cache["TQQQ"] if o.quantity >= 2)
            filled = order_quantity_probe - 1
            cid, order = _make_canceled_custom_order(service, broker, filled_quantity=filled, min_quantity=2)

            synced = service.sync_orders("TQQQ")
            row = next(item for item in synced["orders"] if item["id"] == cid)

            self.assertEqual(row["quantity"], order.quantity)
            self.assertEqual(row["filled_quantity"], filled)
            self.assertEqual(row["remaining_quantity"], order.quantity - filled)

    def test_requesting_more_than_remaining_is_blocked_without_explicit_ack(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            order_quantity_probe = next(o.quantity for o in service.plan_cache["TQQQ"] if o.quantity >= 2)
            filled = order_quantity_probe - 1
            cid, order = _make_canceled_custom_order(service, broker, filled_quantity=filled, min_quantity=2)

            with self.assertRaises(ValueError) as ctx:
                service.reregister_order(
                    "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
                )
            self.assertIn("잔여 수량", str(ctx.exception))
            self.assertEqual(service.runtime.custom_order_history, {})

    def test_requesting_more_than_remaining_succeeds_with_explicit_ack(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            order_quantity_probe = next(o.quantity for o in service.plan_cache["TQQQ"] if o.quantity >= 2)
            filled = order_quantity_probe - 1
            cid, order = _make_canceled_custom_order(service, broker, filled_quantity=filled, min_quantity=2)

            result = service.reregister_order(
                "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
                confirm_over_remaining=True,
            )
            self.assertEqual(result["quantity_after"], order.quantity)
            self.assertEqual(result["remaining_before"], 1)


class ResyncBeforeSubmitTests(unittest.TestCase):
    def test_status_recheck_blocks_if_order_is_no_longer_canceled(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)
            broker_order_id = service.runtime.broker_order_ids[cid]
            # Something else (e.g. the Windows GUI) resurrected the order at
            # the broker between the user opening the dialog and confirming.
            broker.closed_orders = [row for row in broker.closed_orders if row["orderId"] != broker_order_id]
            broker.open_orders.append({
                "orderId": broker_order_id, "symbol": "TQQQ", "side": order.side.upper(),
                "quantity": str(order.quantity), "price": "63.00", "status": "PENDING",
            })

            with self.assertRaises(ValueError) as ctx:
                service.reregister_order(
                    "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
                )
            self.assertIn("현재 상태", str(ctx.exception))
            self.assertEqual(service.runtime.custom_order_history, {})


class ConcurrencyTests(unittest.TestCase):
    def test_concurrent_reregister_creates_exactly_one_new_order(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)
            broker.submit_delay = 0.15
            submitted_before = len(broker.submitted)

            results: list[dict] = []
            errors: list[Exception] = []
            start_barrier = threading.Barrier(2)

            def attempt():
                start_barrier.wait(timeout=5)
                try:
                    results.append(service.reregister_order(
                        "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
                    ))
                except Exception as error:  # noqa: BLE001
                    errors.append(error)

            threads = [threading.Thread(target=attempt) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

            self.assertEqual(len(results), 1, f"expected exactly one success, got {len(results)}; errors={errors}")
            self.assertEqual(len(errors), 1)
            self.assertEqual(len(broker.submitted) - submitted_before, 1)
            self.assertEqual(
                service.runtime.custom_order_history[cid]["replacement_order_id"],
                results[0]["replacement_order_id"],
            )


class DecimalPrecisionTests(unittest.TestCase):
    def test_price_must_be_cent_aligned(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)

            with self.assertRaises(ValueError) as ctx:
                service.reregister_order(
                    "TQQQ", cid, order.quantity, "61.555", "", f"REREGISTER TQQQ {cid}",
                )
            self.assertIn("호가 단위", str(ctx.exception))

    def test_notional_comparison_uses_exact_decimal_not_float(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            # 3 * 33.33 == 99.99 exactly in Decimal; float(33.33)*3 == 99.99000000000001,
            # which would wrongly exceed a cash_usd of exactly "99.99".
            service = _service(temp, broker, cash_usd="99.99")
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker, edited_price="10.00", side="buy", min_quantity=2)

            result = service.reregister_order(
                "TQQQ", cid, 3, "33.33", "", f"REREGISTER TQQQ {cid}",
                confirm_over_remaining=True,
            )

            self.assertEqual(Decimal(result["price_after"]) * 3, Decimal("99.99"))
            self.assertEqual(result["quantity_after"], 3)


class FailedSubmissionDoesNotLockTests(unittest.TestCase):
    def test_broker_rejection_does_not_record_replacement_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)

            broker.fail_next = True
            with self.assertRaises(ValueError) as ctx:
                service.reregister_order(
                    "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
                )
            self.assertIn("접수에 실패", str(ctx.exception))
            self.assertEqual(service.runtime.custom_order_history, {})
            self.assertFalse(any(key.startswith(cid + "-reg") for key in service.runtime.custom_order_ledger))

            # Retry (broker no longer failing) must succeed normally.
            result = service.reregister_order(
                "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
            )
            self.assertEqual(
                service.runtime.custom_order_history[cid]["replacement_order_id"],
                result["replacement_order_id"],
            )


class IdempotencyTests(unittest.TestCase):
    def test_second_reregister_attempt_is_blocked_with_a_clear_message(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)

            first = service.reregister_order(
                "TQQQ", cid, order.quantity, "66.00", "", f"REREGISTER TQQQ {cid}",
            )

            with self.assertRaises(ValueError) as ctx:
                service.reregister_order(
                    "TQQQ", cid, order.quantity, "67.00", "", f"REREGISTER TQQQ {cid}",
                )
            self.assertIn(first["replacement_order_id"], str(ctx.exception))
            self.assertIn("이미 재등록된", str(ctx.exception))


class InputValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.broker = LiveTradingBroker()
        self.service = _service(self.temp.name, self.broker)
        _activate(self.service)
        self.cid, self.order = _make_canceled_custom_order(self.service, self.broker)

    def tearDown(self):
        self.temp.cleanup()

    def test_zero_quantity_rejected(self):
        with self.assertRaises(ValueError):
            self.service.reregister_order("TQQQ", self.cid, 0, "66.00", "", f"REREGISTER TQQQ {self.cid}")

    def test_negative_quantity_rejected(self):
        with self.assertRaises(ValueError):
            self.service.reregister_order("TQQQ", self.cid, -3, "66.00", "", f"REREGISTER TQQQ {self.cid}")

    def test_non_integer_quantity_rejected(self):
        with self.assertRaises(ValueError):
            self.service.reregister_order("TQQQ", self.cid, "abc", "66.00", "", f"REREGISTER TQQQ {self.cid}")

    def test_zero_price_rejected(self):
        with self.assertRaises(ValueError):
            self.service.reregister_order("TQQQ", self.cid, self.order.quantity, "0", "", f"REREGISTER TQQQ {self.cid}")

    def test_negative_price_rejected(self):
        with self.assertRaises(ValueError):
            self.service.reregister_order("TQQQ", self.cid, self.order.quantity, "-1", "", f"REREGISTER TQQQ {self.cid}")

    def test_unsupported_etf_rejected(self):
        with self.assertRaises(ValueError):
            self.service.reregister_order("ZZZZ", self.cid, self.order.quantity, "66.00", "", "REREGISTER ZZZZ x")

    def test_unknown_order_id_rejected(self):
        with self.assertRaises(ValueError):
            self.service.reregister_order("TQQQ", "does-not-exist", 1, "66.00", "", "REREGISTER TQQQ does-not-exist")

    def test_wrong_confirmation_phrase_rejected(self):
        with self.assertRaises(PermissionError):
            self.service.reregister_order("TQQQ", self.cid, self.order.quantity, "66.00", "", "WRONG PHRASE")


class AuditLogTests(unittest.TestCase):
    def test_successful_reregister_is_recorded_in_the_audit_log(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute("plan.calculate", {
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "50000", "position_qty": 40, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            }, source="WEB", actor="tester")
            _activate(engine)
            cid, order = _make_canceled_custom_order(engine, broker)

            engine.execute("order.reregister", {
                "symbol": "TQQQ", "original_id": cid, "quantity": order.quantity,
                "price": "66.00", "memo": "audit-test", "confirmation": f"REREGISTER TQQQ {cid}",
            }, source="WEB", actor="tester")

            entries = [row for row in engine.audit_entries() if row["command"] == "order.reregister"]
            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0]["success"])
            self.assertEqual(entries[0]["error"], "")

    def test_failed_reregister_records_the_error_and_stays_retryable(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            engine = ApplicationEngine(Path(temp), broker_factory=lambda: broker)
            engine.execute("plan.calculate", {
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "100", "position_qty": 40, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            }, source="WEB", actor="tester")
            _activate(engine)
            cid, order = _make_canceled_custom_order(engine, broker, edited_price="40.00", side="buy", min_quantity=2)

            with self.assertRaises(ValueError):
                engine.execute("order.reregister", {
                    "symbol": "TQQQ", "original_id": cid, "quantity": order.quantity,
                    "price": "1000.00", "memo": "", "confirmation": f"REREGISTER TQQQ {cid}",
                }, source="WEB", actor="tester")

            entries = [row for row in engine.audit_entries() if row["command"] == "order.reregister"]
            self.assertEqual(len(entries), 1)
            self.assertFalse(entries[0]["success"])
            self.assertIn("주문 가능 금액", entries[0]["error"])
            self.assertEqual(engine.runtime.custom_order_history, {})


class StaleUnsentCustomOrderPruningTests(unittest.TestCase):
    def test_never_sent_edit_is_pruned_once_its_leg_falls_out_of_the_plan(self):
        """Reproduces a live incident: a star-buy order was price-edited
        (edit_failed_price) but never resubmitted, then the position fully
        exited before the leg was sent, so the next plan rebuild (position
        back to 0) drops that leg entirely. The edited order can never be
        matched to a broker row and offers no reregister/edit button (already
        is_custom), so without pruning it would linger in custom_order_ledger
        forever, permanently inflating the SUBMIT-confirmation order count
        and blocking every future order for the symbol."""
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            order = next(item for item in service.plan_cache["TQQQ"] if item.quantity >= 2)
            cid = order.client_order_id
            service.runtime.skipped_order_ids.append(cid)
            service.runtime_store.save(service.runtime)
            service.edit_failed_price("TQQQ", cid, "63.00")
            self.assertIn(cid, service.runtime.custom_order_ledger)
            self.assertNotIn(cid, service.runtime.broker_order_ids)

            # Position fully exits -> the next rebuild's plan is just a fresh
            # entry buy; the edited leg is no longer part of it.
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "position_qty": 0, "avg_cost": "0", "t_value": "0",
            })
            synced = service.sync_orders("TQQQ")

            self.assertNotIn(cid, service.runtime.custom_order_ledger)
            self.assertNotIn(cid, service.runtime.order_price_overrides)
            self.assertFalse(any(row["id"] == cid for row in synced["orders"]))

    def test_already_sent_custom_order_survives_falling_out_of_the_plan(self):
        """Contrast case: once an edited order was actually submitted (it has
        a broker_order_id), it must keep showing up -- e.g. so a CANCELED one
        stays reregisterable -- even after the plan moves on without it."""
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = _service(temp, broker)
            _activate(service)
            cid, order = _make_canceled_custom_order(service, broker)
            self.assertIn(cid, service.runtime.broker_order_ids)

            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "position_qty": 0, "avg_cost": "0", "t_value": "0",
            })
            synced = service.sync_orders("TQQQ")

            self.assertIn(cid, service.runtime.custom_order_ledger)
            self.assertTrue(any(row["id"] == cid for row in synced["orders"]))


if __name__ == "__main__":
    unittest.main()
