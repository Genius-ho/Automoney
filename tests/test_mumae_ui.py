import unittest
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from mumae_core import OrderIntent, OrderKind, StrategyState
from runtime_store import RuntimeStatus
from toss_api import TossApiError

try:
    from mumae_ui import MumaeApp
except ImportError as error:
    # mumae_ui.py is the Windows-only Tkinter desktop GUI. It intentionally
    # ships only on the Windows machine, not in this Linux/web deployment
    # checkout (see web_gui/README.md: "기존 Windows Tkinter 프로그램을
    # 변경하지 않고 별도 웹 화면으로 분리"). Skip rather than error so the
    # web repo's official test command can still exit 0 on Linux CI.
    raise unittest.SkipTest(f"mumae_ui.py not present in this checkout (Windows-only GUI): {error}")


class SubmitAllPlannedOrdersTests(unittest.TestCase):
    @patch("mumae_ui.time.sleep")
    def test_stale_local_order_id_is_resubmitted_when_broker_has_no_order(self, _sleep):
        order = OrderIntent(
            client_order_id="default-SOXL-20260715-star-buy",
            side="buy",
            quantity=2,
            limit_price=Decimal("20.00"),
            kind=OrderKind.CLOSE_AUCTION,
            reason="First-half star LOC buy (50%)",
        )
        app = MumaeApp.__new__(MumaeApp)
        app.broker = SimpleNamespace(mode="LIVE", live_ack=True, submit_order=MagicMock())
        app.state = SimpleNamespace(symbol="SOXL")
        app.display_orders = {order.client_order_id: order}
        app.runtime = RuntimeStatus(active_order_ids=[order.client_order_id], broker_client_order_ids={order.client_order_id: "stable-request-id"})
        app.runtime_store = MagicMock()
        app.broker_order_statuses = {}
        app.broker_plan_statuses = {}
        app.broker_unmatched_orders = {}
        app.broker_orders_synced = True
        app.corporate_action_blocked_symbols = set()
        app.status_var = MagicMock()
        app._open_order_progress = MagicMock()
        app._update_order_progress = MagicMock()
        app._close_order_progress = MagicMock()
        app.refresh_plan = MagicMock()

        def confirm_submission(_symbol):
            app.broker_plan_statuses[order.client_order_id] = "PENDING"

        app._sync_order_statuses = MagicMock(side_effect=confirm_submission)

        result = app._submit_all_planned_orders("수동 시작")

        self.assertTrue(result)
        app.broker.submit_order.assert_called_once()
        submitted_order, stable_id = app.broker.submit_order.call_args.args
        self.assertEqual(submitted_order, order)
        self.assertEqual(stable_id, "stable-request-id")
        self.assertEqual(app.runtime.active_order_ids, [order.client_order_id])

    @patch("mumae_ui.messagebox.showerror")
    @patch("mumae_ui.time.sleep")
    def test_unconfirmed_submission_removes_local_active_order_id(self, _sleep, _showerror):
        order = OrderIntent(
            client_order_id="default-SOXL-20260715-star-buy",
            side="buy",
            quantity=2,
            limit_price=Decimal("20.00"),
            kind=OrderKind.CLOSE_AUCTION,
            reason="First-half star LOC buy (50%)",
        )
        app = MumaeApp.__new__(MumaeApp)
        app.broker = SimpleNamespace(mode="LIVE", live_ack=True, submit_order=MagicMock())
        app.state = SimpleNamespace(symbol="SOXL")
        app.display_orders = {order.client_order_id: order}
        app.runtime = RuntimeStatus(active_symbols=["SOXL"])
        app.runtime_store = MagicMock()
        app.broker_order_statuses = {}
        app.broker_plan_statuses = {}
        app.broker_unmatched_orders = {}
        app.broker_orders_synced = True
        app.corporate_action_blocked_symbols = set()
        app.status_var = MagicMock()
        app._open_order_progress = MagicMock()
        app._update_order_progress = MagicMock()
        app._close_order_progress = MagicMock()
        app._update_auto_status = MagicMock()
        app.refresh_plan = MagicMock()
        app._sync_order_statuses = MagicMock(side_effect=lambda _symbol: app.broker_plan_statuses.clear())

        result = app._submit_all_planned_orders("수동 시작")

        self.assertFalse(result)
        self.assertEqual(app.runtime.active_order_ids, [])
        self.assertIn(order.client_order_id, app.runtime.broker_client_order_ids)

class ApplyUpdateTests(unittest.TestCase):
    @patch("mumae_ui.messagebox.askyesno", return_value=True)
    def test_apply_update_saves_state_and_schedules_process_reload(self, _askyesno):
        app = MumaeApp.__new__(MumaeApp)
        app.store = MagicMock()
        app.runtime_store = MagicMock()
        app.state = SimpleNamespace()
        app.runtime = SimpleNamespace()
        app.status_var = MagicMock()
        app.after = MagicMock()

        MumaeApp.apply_update(app)

        app.store.save.assert_called_once_with(app.state)
        app.runtime_store.save.assert_called_once_with(app.runtime)
        app.after.assert_called_once_with(100, app._reload_current_process)


class BrokerOnlyOpenOrderTests(unittest.TestCase):
    @patch("mumae_ui.messagebox.showinfo")
    @patch("mumae_ui.messagebox.askyesno", return_value=True)
    def test_unmatched_real_open_order_can_be_canceled(self, _askyesno, _showinfo):
        app = MumaeApp.__new__(MumaeApp)
        app.tree = SimpleNamespace(selection=MagicMock(return_value=("toss-open-order-1",)))
        app.display_orders = {}
        app.broker_unmatched_orders = {
            "toss-open-order-1": {
                "orderId": "order-1",
                "status": "PENDING",
                "side": "BUY",
                "quantity": "10",
                "price": "12.34",
            }
        }
        app.broker = SimpleNamespace(cancel_order=MagicMock())
        app.broker_order_statuses = {}
        app.status_var = MagicMock()
        app.broker_plan_statuses = {}
        app.broker_plan_records = {}
        app.refresh_plan = MagicMock()

        app.cancel_selected_orders()

        app.broker.cancel_order.assert_called_once_with("order-1")
        self.assertEqual(app.broker_unmatched_orders["toss-open-order-1"]["status"], "PENDING_CANCEL")


class ApiHealthCheckTests(unittest.TestCase):
    def test_periodic_health_check_marks_api_connected_and_reschedules(self):
        app = MumaeApp.__new__(MumaeApp)
        app.broker = SimpleNamespace(list_accounts=MagicMock(return_value={"result": []}))
        app._set_api_connected = MagicMock()
        app.status_var = MagicMock()
        app.after = MagicMock()

        app._api_health_tick()

        app._set_api_connected.assert_called_once_with(True)
        app.after.assert_called_once_with(60000, app._api_health_tick)

    def test_periodic_health_check_marks_reconnect_needed_without_popup(self):
        app = MumaeApp.__new__(MumaeApp)
        app.broker = SimpleNamespace(list_accounts=MagicMock(side_effect=TossApiError("invalid-token")))
        app.api_disconnected_since = None
        app._set_api_connected = MagicMock()
        app.status_var = MagicMock()
        app.after = MagicMock()

        app._api_health_tick()

        app._set_api_connected.assert_called_once_with(False)
        self.assertIn("5분 후 자동 인증 갱신", app.status_var.set.call_args.args[0])
        app.after.assert_called_once_with(60000, app._api_health_tick)

    @patch("mumae_ui.TossBroker")
    @patch("mumae_ui.time.time", return_value=1300.0)
    def test_automatically_reconnects_after_five_minutes(self, _time, broker_class):
        candidate = SimpleNamespace(list_accounts=MagicMock(return_value={"result": []}))
        broker_class.return_value = candidate
        app = MumaeApp.__new__(MumaeApp)
        app.api_disconnected_since = 1000.0
        app.broker = SimpleNamespace()
        app._set_api_connected = MagicMock()
        app.status_var = MagicMock()

        result = MumaeApp._auto_reconnect_if_due(app)

        self.assertTrue(result)
        self.assertIs(app.broker, candidate)
        self.assertIsNone(app.api_disconnected_since)
        app._set_api_connected.assert_called_once_with(True)
        app.status_var.set.assert_called_once_with("토스 API 인증이 5분 후 자동으로 갱신되었습니다.")


class AccountMarketRefreshTests(unittest.TestCase):
    def test_premarket_counts_as_open_for_quote_refresh(self):
        app = MumaeApp.__new__(MumaeApp)
        app.broker = SimpleNamespace(get_us_market_calendar_raw=MagicMock(return_value={
            "result": {"today": {"preMarket": {
                "startTime": "2026-07-16T17:00:00+09:00",
                "endTime": "2026-07-16T22:30:00+09:00",
            }}}
        }))
        with patch("mumae_ui.datetime") as mocked_datetime:
            mocked_datetime.now.return_value = datetime(2026, 7, 16, 9, 0, tzinfo=timezone.utc)
            mocked_datetime.fromisoformat.side_effect = datetime.fromisoformat
            self.assertTrue(app._is_us_market_session_open())
    def test_refreshes_account_during_any_us_market_session(self):
        app = MumaeApp.__new__(MumaeApp)
        app._is_us_market_session_open = MagicMock(return_value=True)
        app.fetch_toss_data = MagicMock(return_value=True)
        app.after = MagicMock()

        app._account_refresh_tick()

        app.fetch_toss_data.assert_called_once_with(show_error=False)
        app.after.assert_called_once_with(900000, app._account_refresh_tick)

    def test_skips_account_refresh_outside_us_market_sessions(self):
        app = MumaeApp.__new__(MumaeApp)
        app._is_us_market_session_open = MagicMock(return_value=False)
        app.fetch_toss_data = MagicMock()
        app.after = MagicMock()

        app._account_refresh_tick()

        app.fetch_toss_data.assert_not_called()
        app.after.assert_called_once_with(900000, app._account_refresh_tick)

    def test_market_check_failure_is_silent_and_reschedules(self):
        app = MumaeApp.__new__(MumaeApp)
        app._is_us_market_session_open = MagicMock(side_effect=TossApiError("calendar unavailable"))
        app.fetch_toss_data = MagicMock()
        app.status_var = MagicMock()
        app.after = MagicMock()

        app._account_refresh_tick()

        app.fetch_toss_data.assert_not_called()
        self.assertIn("미국장 15분 자동 새로고침 실패", app.status_var.set.call_args.args[0])
        app.after.assert_called_once_with(900000, app._account_refresh_tick)



class OrderSafetyRegressionTests(unittest.TestCase):
    @patch("mumae_ui.messagebox.showerror")
    def test_submit_aborts_when_broker_orders_are_not_synced(self, _showerror):
        order = OrderIntent("default-SOXL-safe", "buy", 2, Decimal("20"), OrderKind.CLOSE_AUCTION, "test")
        app = MumaeApp.__new__(MumaeApp)
        app.state = SimpleNamespace(symbol="SOXL")
        app.broker = SimpleNamespace(mode="LIVE", live_ack=True, submit_order=MagicMock())
        app.display_orders = {order.client_order_id: order}
        app.broker_orders_synced = False
        app.corporate_action_blocked_symbols = set()

        self.assertFalse(app._submit_all_planned_orders("test"))
        app.broker.submit_order.assert_not_called()

    def test_identical_extra_open_order_remains_visible_as_unmatched(self):
        order = OrderIntent("default-SOXL-safe", "buy", 2, Decimal("20"), OrderKind.CLOSE_AUCTION, "test")
        first = {"orderId": "one", "clientOrderId": "stable", "side": "BUY", "quantity": 2, "price": "20", "status": "PENDING"}
        duplicate = {"orderId": "two", "clientOrderId": "different", "side": "BUY", "quantity": 2, "price": "20", "status": "PENDING"}
        app = MumaeApp.__new__(MumaeApp)
        app.runtime = RuntimeStatus(broker_client_order_ids={order.client_order_id: "stable"}, broker_order_ids={order.client_order_id: "one"})
        app.broker_orders_synced = True
        app.broker_all_order_rows = [first, duplicate]
        app.broker_open_orders = {"toss-open-one": first, "toss-open-two": duplicate}

        app._match_broker_orders([order])

        self.assertIs(app.broker_plan_records[order.client_order_id], first)
        self.assertEqual(list(app.broker_unmatched_orders), ["toss-open-two"])

    def test_auto_tick_skips_submission_when_symbol_refresh_fails(self):
        app = MumaeApp.__new__(MumaeApp)
        app.runtime = RuntimeStatus(auto_enabled=True, active_symbols=["SOXL"])
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="SOXL"))
        app._due_session_key = MagicMock(return_value="2026-07-15")
        app._select_symbol = MagicMock(return_value=False)
        app._submit_all_planned_orders = MagicMock()
        app.runtime_store = MagicMock()
        app._update_auto_status = MagicMock()
        app.after = MagicMock()
        app.status_var = MagicMock()

        app._auto_tick()
        app._auto_tick()

        app._submit_all_planned_orders.assert_not_called()
        app._select_symbol.assert_called_once_with("SOXL", show_error=False)
        self.assertEqual(app.runtime.auto_attempt_keys, {"SOXL": "2026-07-15"})
        self.assertEqual(app.runtime.last_auto_key, "2026-07-15")
        self.assertEqual(app.after.call_count, 2)
    def test_sync_reads_every_page_through_broker_helper(self):
        closed = {"orderId": "closed", "status": "FILLED", "side": "BUY", "quantity": 2, "price": "20"}
        opened = {"orderId": "open", "status": "PENDING", "side": "BUY", "quantity": 2, "price": "19"}
        app = MumaeApp.__new__(MumaeApp)
        app.broker = SimpleNamespace(get_all_orders_raw=MagicMock(side_effect=[[closed], [opened]]))
        app.runtime = RuntimeStatus()
        app.runtime_store = MagicMock()
        app.state = StrategyState(symbol="SOXL")
        app.store = MagicMock()
        app.t_var = MagicMock()

        app._sync_order_statuses("SOXL")

        self.assertEqual(app.broker.get_all_orders_raw.call_count, 2)
        self.assertEqual(app.broker_all_order_rows, [closed, opened])
        self.assertEqual(app.broker_open_orders, {"toss-open-open": opened})
        self.assertTrue(app.broker_orders_synced)
        self.assertFalse(app.runtime.auto_enabled)

    def test_sync_applies_two_half_buys_to_t_once(self):
        star_client_id = "default-SOXL-20260715-star-buy"
        avg_client_id = "default-SOXL-20260715-avg-buy"
        closed = [
            {"orderId": "star-order", "status": "FILLED", "side": "BUY", "quantity": 1, "execution": {"filledQuantity": "1", "filledAt": "2026-07-16T01:00:00Z"}},
            {"orderId": "avg-order", "status": "FILLED", "side": "BUY", "quantity": 1, "execution": {"filledQuantity": "1", "filledAt": "2026-07-16T01:01:00Z"}},
        ]
        app = MumaeApp.__new__(MumaeApp)
        app.broker = SimpleNamespace(get_all_orders_raw=MagicMock(side_effect=[closed, [], closed, []]))
        app.runtime = RuntimeStatus(broker_order_ids={star_client_id: "star-order", avg_client_id: "avg-order"})
        app.state = StrategyState(symbol="SOXL", t_value=Decimal("1"))
        app.store = MagicMock()
        app.t_var = MagicMock()

        app._sync_order_statuses("SOXL")
        app._sync_order_statuses("SOXL")

        self.assertEqual(app.state.t_value, Decimal("2.0"))
        self.assertEqual(app.state.applied_fill_order_ids, [star_client_id, avg_client_id])
        self.assertEqual(app.store.save.call_count, 1)
        app.t_var.set.assert_called_once_with("2.0")
    def test_invalidating_sync_clears_stale_plan_and_real_orders(self):
        app = MumaeApp.__new__(MumaeApp)
        app.broker_orders_synced = True
        app.broker_order_statuses = {("BUY", 1, Decimal("1")): "PENDING"}
        app.broker_order_records = {("BUY", 1, Decimal("1")): {}}
        app.broker_open_orders = {"old": {}}
        app.broker_unmatched_orders = {"old": {}}
        app.broker_all_order_rows = [{}]
        app.broker_plan_records = {"old": {}}
        app.broker_plan_statuses = {"old": "PENDING"}
        app.display_orders = {"old": MagicMock()}

        app._invalidate_order_sync()

        self.assertFalse(app.broker_orders_synced)
        self.assertEqual(app.display_orders, {})
        self.assertEqual(app.broker_open_orders, {})
        self.assertEqual(app.broker_plan_statuses, {})



class BrokerOrderIdentityTests(unittest.TestCase):
    def test_records_real_toss_order_id_from_submission_response(self):
        order = OrderIntent("default-SOXL-safe", "buy", 2, Decimal("20"), OrderKind.CLOSE_AUCTION, "test")
        app = MumaeApp.__new__(MumaeApp)
        app.runtime = RuntimeStatus()

        app._record_broker_order_response(order, {"result": {"orderId": "actual-order-123"}})

        self.assertEqual(app.runtime.broker_order_ids[order.client_order_id], "actual-order-123")

    @patch("mumae_ui.messagebox.showerror")
    def test_unmatched_real_open_order_blocks_additional_submission(self, _showerror):
        order = OrderIntent("default-SOXL-safe", "buy", 2, Decimal("20"), OrderKind.CLOSE_AUCTION, "test")
        app = MumaeApp.__new__(MumaeApp)
        app.state = SimpleNamespace(symbol="SOXL")
        app.broker = SimpleNamespace(mode="LIVE", live_ack=True, submit_order=MagicMock())
        app.display_orders = {order.client_order_id: order}
        app.broker_orders_synced = True
        app.broker_unmatched_orders = {"toss-open-other": {}}
        app.corporate_action_blocked_symbols = set()

        self.assertFalse(app._submit_all_planned_orders("test"))
        app.broker.submit_order.assert_not_called()


class FailedOrderPriceTests(unittest.TestCase):
    def test_post_rejection_guard_uses_latest_price(self):
        order = OrderIntent('default-SOXL-safe', 'buy', 2, Decimal('25.15'), OrderKind.CLOSE_AUCTION, 'test')
        app = MumaeApp.__new__(MumaeApp)
        app.state = SimpleNamespace(symbol='SOXL')

        guarded = app._guard_volatile_order_price(order, Decimal('20.00'))

        self.assertEqual(guarded.limit_price, Decimal('20.00'))

    def test_successful_koru_order_keeps_original_formula_price(self):
        order = OrderIntent('default-KORU-safe', 'buy', 2, Decimal('25.15'), OrderKind.CLOSE_AUCTION, 'New cycle LOC')
        app = MumaeApp.__new__(MumaeApp)
        app.state = SimpleNamespace(symbol='KORU')
        app.runtime = RuntimeStatus()
        app.runtime_store = MagicMock()
        app.display_orders = {order.client_order_id: order}
        app.broker = SimpleNamespace(submit_order=MagicMock(return_value={'result': {'orderId': 'original-order'}}))

        submitted, _response = app._submit_order_with_price_retry(order)

        self.assertEqual(submitted, order)
        self.assertEqual(app.broker.submit_order.call_args.args[0].limit_price, Decimal('25.15'))
        self.assertEqual(app.broker.submit_order.call_count, 1)

    def test_price_rejection_retries_once_at_latest_with_new_id(self):
        order = OrderIntent('default-KORU-safe', 'buy', 2, Decimal('25.15'), OrderKind.CLOSE_AUCTION, 'test')
        app = MumaeApp.__new__(MumaeApp)
        app.state = SimpleNamespace(symbol='KORU')
        app.runtime = RuntimeStatus()
        app.runtime_store = MagicMock()
        app.display_orders = {order.client_order_id: order}
        app.broker = SimpleNamespace(
            submit_order=MagicMock(side_effect=[
                TossApiError('outside', status=422, code='price-out-of-range'),
                {'result': {'orderId': 'retry-order'}},
            ]),
            get_prices_raw=MagicMock(return_value={'result': [{'symbol': 'KORU', 'lastPrice': '20.00'}]}),
        )

        retried, response = app._submit_order_with_price_retry(order)

        self.assertEqual(retried.limit_price, Decimal('20.00'))
        self.assertEqual(response['result']['orderId'], 'retry-order')
        self.assertEqual(app.broker.submit_order.call_count, 2)
        first_id = app.broker.submit_order.call_args_list[0].args[1]
        second_id = app.broker.submit_order.call_args_list[1].args[1]
        self.assertNotEqual(first_id, second_id)
        self.assertEqual(app.runtime.order_price_overrides[order.client_order_id], '20.00')

    def test_persisted_override_changes_displayed_and_submitted_price(self):
        order = OrderIntent("default-SOXL-20260715-star-buy", "buy", 2, Decimal("207.36"), OrderKind.CLOSE_AUCTION, "test")
        app = MumaeApp.__new__(MumaeApp)
        app.runtime = RuntimeStatus(order_price_overrides={order.client_order_id: "190.00"})
        app.runtime_store = MagicMock()

        changed = app._apply_order_price_overrides([order])

        self.assertEqual(changed[0].limit_price, Decimal("190.00"))
        self.assertIn("수동 지정가", changed[0].reason)

    @patch("mumae_ui.simpledialog.askstring", return_value="190.00")
    def test_editing_rejected_order_clears_old_idempotency_and_retry_block(self, _askstring):
        order = OrderIntent("default-SOXL-20260715-star-buy", "buy", 2, Decimal("207.36"), OrderKind.CLOSE_AUCTION, "test")
        app = MumaeApp.__new__(MumaeApp)
        app.tree = SimpleNamespace(selection=MagicMock(return_value=(order.client_order_id,)), selection_set=MagicMock())
        app.display_orders = {order.client_order_id: order}
        app.broker_plan_statuses = {order.client_order_id: "REJECTED"}
        app.broker_plan_records = {order.client_order_id: {}}
        app.runtime = RuntimeStatus(
            active_order_ids=[order.client_order_id],
            skipped_order_ids=[order.client_order_id],
            broker_client_order_ids={order.client_order_id: "old-request"},
            broker_order_ids={order.client_order_id: "old-order"},
        )
        app.runtime_store = MagicMock()
        app.state = SimpleNamespace(symbol="SOXL")
        app.refresh_plan = MagicMock()
        app.status_var = MagicMock()

        app.edit_failed_order_price()

        self.assertEqual(app.runtime.order_price_overrides[order.client_order_id], "190.00")
        self.assertNotIn(order.client_order_id, app.runtime.active_order_ids)
        self.assertNotIn(order.client_order_id, app.runtime.skipped_order_ids)
        self.assertNotIn(order.client_order_id, app.runtime.broker_client_order_ids)
        self.assertNotIn(order.client_order_id, app.runtime.broker_order_ids)
        app.runtime_store.save.assert_called_once_with(app.runtime)


class BigLocRegressionTests(unittest.TestCase):
    def test_big_loc_at_cycle_boundary_is_silently_disabled(self):
        app = MumaeApp.__new__(MumaeApp)
        app.state = StrategyState(symbol="SOXL", t_value=Decimal("0"), big_number_enabled=True)
        app.big_trigger_var = MagicMock()
        app.big_star_var = MagicMock()
        app.status_var = MagicMock()

        result = app._big_number_details(tuple())

        self.assertFalse(result.triggered)
        self.assertFalse(app.state.big_number_enabled)
        app.big_trigger_var.set.assert_called_once_with(False)

    def test_filled_big_loc_advances_t_once(self):
        client_id = "default-SOXL-20260715-big-loc"
        closed = [{"orderId": "big-order", "status": "FILLED", "side": "BUY", "quantity": 2, "execution": {"filledQuantity": "2", "filledAt": "2026-07-16T01:00:00Z"}}]
        app = MumaeApp.__new__(MumaeApp)
        app.runtime = RuntimeStatus(broker_order_ids={client_id: "big-order"})
        app.state = StrategyState(symbol="SOXL", t_value=Decimal("2"))
        app.store = MagicMock()
        app.t_var = MagicMock()

        app._apply_new_fills("SOXL", closed)
        app._apply_new_fills("SOXL", closed)

        self.assertEqual(app.state.t_value, Decimal("3"))
        self.assertEqual(app.state.applied_fill_order_ids, [client_id])


class BackgroundAlertTests(unittest.TestCase):
    @patch("mumae_ui.messagebox.showerror")
    def test_automatic_unmatched_order_check_does_not_open_modal(self, showerror):
        app = MumaeApp.__new__(MumaeApp)
        app.state = SimpleNamespace(symbol="SOXL")
        app.broker = SimpleNamespace(mode="LIVE", live_ack=True)
        app.broker_orders_synced = True
        app.broker_unmatched_orders = {"toss-open-other": {}}
        app.corporate_action_blocked_symbols = set()
        app.status_var = MagicMock()

        self.assertFalse(app._submit_all_planned_orders("정기 자동 실행"))
        showerror.assert_not_called()
        self.assertIn("토스 실제 주문 확인 필요", app.status_var.set.call_args.args[0])

class RemoteEngineGuiTests(unittest.TestCase):
    @patch("mumae_ui.messagebox.askyesno", return_value=True)
    def test_selected_orders_route_through_management_client(self, _confirm):
        app = MumaeApp.__new__(MumaeApp)
        app.management_client = MagicMock()
        app.management_client.execute.return_value = {
            "confirmed": 2,
            "errors": [],
        }
        app.tree = MagicMock()
        app.tree.selection.return_value = ("order-1", "order-2")
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="SOXL"))
        app.status_var = MagicMock()
        app._refresh_remote_snapshot = MagicMock()

        app.submit_selected_order()

        app.management_client.execute.assert_called_once_with(
            "order.submit",
            {
                "symbol": "SOXL",
                "ids": ["order-1", "order-2"],
                "confirmation": "SUBMIT SOXL 2",
            },
        )
        app._refresh_remote_snapshot.assert_called_once_with("SOXL")

    def test_auto_stop_routes_through_management_client(self):
        app = MumaeApp.__new__(MumaeApp)
        app.management_client = MagicMock()
        app.management_client.execute.return_value = {
            "auto_enabled": False,
            "active_symbols": [],
        }
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="KORU"))
        app.status_var = MagicMock()
        app.auto_status_var = MagicMock()

        app.stop_auto()

        app.management_client.execute.assert_called_once_with(
            "auto.stop",
            {"symbol": "KORU"},
        )
        app.auto_status_var.set.assert_called_once_with("자동 운용 STOPPED")

    @patch("mumae_ui.messagebox.askyesno", return_value=True)
    def test_cancel_routes_through_management_client(self, _confirm):
        app = MumaeApp.__new__(MumaeApp)
        app.management_client = MagicMock()
        app.management_client.execute.return_value = {"canceled": ["order-1"], "errors": []}
        app.tree = MagicMock()
        app.tree.selection.return_value = ("order-1",)
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="TQQQ"))
        app.status_var = MagicMock()
        app._refresh_remote_snapshot = MagicMock()

        app.cancel_selected_orders()

        app.management_client.execute.assert_called_once_with(
            "order.cancel",
            {
                "symbol": "TQQQ",
                "ids": ["order-1"],
                "confirmation": "CANCEL TQQQ 1",
            },
        )

    @patch("mumae_ui.simpledialog.askstring", return_value="21.25")
    def test_price_edit_routes_through_management_client(self, _prompt):
        app = MumaeApp.__new__(MumaeApp)
        app.management_client = MagicMock()
        app.management_client.execute.return_value = {"message": "changed"}
        app.tree = MagicMock()
        app.tree.selection.return_value = ("order-1",)
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="SOXL"))
        app.status_var = MagicMock()
        app._refresh_remote_snapshot = MagicMock()

        app.edit_failed_order_price()

        app.management_client.execute.assert_called_once_with(
            "order.edit_price",
            {"symbol": "SOXL", "id": "order-1", "price": "21.25"},
        )

    @patch("mumae_ui.messagebox.askyesno", return_value=True)
    def test_auto_start_routes_through_management_client(self, _confirm):
        app = MumaeApp.__new__(MumaeApp)
        app.management_client = MagicMock()
        app.management_client.execute.return_value = {
            "auto_enabled": True,
            "active_symbols": ["KORU"],
        }
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="KORU"))
        app.display_orders = {"one": MagicMock(), "two": MagicMock()}
        app.status_var = MagicMock()
        app.auto_status_var = MagicMock()

        app.start_auto()

        app.management_client.execute.assert_called_once_with(
            "auto.start",
            {"symbol": "KORU", "confirmation": "SUBMIT KORU 2"},
        )

    def test_account_refresh_routes_through_management_client(self):
        app = MumaeApp.__new__(MumaeApp)
        app.management_client = MagicMock()
        account = {"state": {"symbol": "TQQQ"}}
        orders = {"orders": [], "synced": True}
        app.management_client.execute.side_effect = [account, orders]
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="TQQQ"))
        app._apply_remote_snapshot = MagicMock()
        app.status_var = MagicMock()

        result = app.fetch_toss_data()

        self.assertTrue(result)
        self.assertEqual(
            [call.args[0] for call in app.management_client.execute.call_args_list],
            ["account.refresh", "orders.sync"],
        )
        app._apply_remote_snapshot.assert_called_once()

    def test_plan_refresh_routes_inputs_through_management_client(self):
        app = MumaeApp.__new__(MumaeApp)
        app.management_client = MagicMock()
        app.management_client.execute.return_value = {"state": {"symbol": "SOXL"}}
        app.symbol_var = SimpleNamespace(get=MagicMock(return_value="SOXL"))
        app.current_price_var = SimpleNamespace(get=MagicMock(return_value="21.50"))
        app.previous_close_var = SimpleNamespace(get=MagicMock(return_value="20.00"))
        app.cash_var = SimpleNamespace(get=MagicMock(return_value="1000"))
        app.qty_var = SimpleNamespace(get=MagicMock(return_value="4"))
        app.avg_var = SimpleNamespace(get=MagicMock(return_value="19.00"))
        app.t_var = SimpleNamespace(get=MagicMock(return_value="2"))
        app.base_qty_var = SimpleNamespace(get=MagicMock(return_value="2"))
        app.big_pct_var = SimpleNamespace(get=MagicMock(return_value="15"))
        app.big_trigger_var = SimpleNamespace(get=MagicMock(return_value=False))
        app.state = StrategyState(symbol="SOXL")
        app._apply_remote_snapshot = MagicMock()

        app.refresh_plan()

        command, payload = app.management_client.execute.call_args.args
        self.assertEqual(command, "plan.calculate")
        self.assertEqual(payload["symbol"], "SOXL")
        self.assertEqual(payload["t_value"], "2")


if __name__ == "__main__":
    unittest.main()
