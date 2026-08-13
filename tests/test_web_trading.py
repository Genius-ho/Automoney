import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from web_gui.trading_service import TradingWebService
from web_gui.web_auth import WebAuth


class FakeTradingBroker:
    mode = "DRY_RUN"
    live_ack = False

    def __init__(self):
        self.open_orders = []
        self.closed_orders = []

    def get_all_orders_raw(self, status, symbol, from_date, to_date):
        rows = self.open_orders if status == "OPEN" else self.closed_orders
        # Rows without an explicit "symbol" tag are treated as belonging to
        # whichever symbol is being queried (keeps older single-symbol fixtures working).
        return [row for row in rows if row.get("symbol", symbol) == symbol]


class LiveTradingBroker(FakeTradingBroker):
    mode = "LIVE"
    live_ack = True

    def __init__(self):
        super().__init__()
        self.submitted = []
        self.cancel_calls = []

    def submit_order(self, order, client_order_id):
        self.submitted.append(order.client_order_id)
        broker_order_id = f"broker-{len(self.submitted)}"
        # Reflect the order back as an OPEN broker record so a follow-up
        # sync_orders() call (which submit_orders() always performs) confirms it.
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
        self.cancel_calls.append(order_id)
        return {"status": "CANCELED"}


class DelayedVisibilityBroker(LiveTradingBroker):
    """Accept an order but do not expose it in list queries immediately."""

    def submit_order(self, order, client_order_id):
        self.submitted.append(order.client_order_id)
        return {"result": {"orderId": "accepted-but-not-listed"}}


class FirstRequestFailsBroker(LiveTradingBroker):
    def __init__(self):
        super().__init__()
        self.client_ids = []

    def submit_order(self, order, client_order_id):
        from toss_api import TossApiError
        self.client_ids.append(client_order_id)
        if len(self.client_ids) == 1:
            raise TossApiError("temporary transport failure")
        return super().submit_order(order, client_order_id)


class RejectedAfterAcceptanceBroker(LiveTradingBroker):
    def submit_order(self, order, client_order_id):
        self.submitted.append(order.client_order_id)
        broker_order_id = "rejected-order"
        self.closed_orders.append({
            "orderId": broker_order_id,
            "symbol": order.client_order_id.split("-")[1],
            "side": order.side.upper(),
            "quantity": str(order.quantity),
            "price": str(order.limit_price),
            "status": "REJECTED",
        })
        return {"result": {"orderId": broker_order_id}}


class AutoTickBroker(LiveTradingBroker):
    """Full-featured fake for auto_tick: market calendar + account + orders."""

    def __init__(self):
        super().__init__()
        self.market_open_offset_minutes = 30
        self.reject_symbols: set[str] = set()

    def get_us_market_calendar_raw(self, date_str):
        now = datetime.now(timezone.utc)
        start = now - timedelta(minutes=self.market_open_offset_minutes)
        end = now + timedelta(minutes=self.market_open_offset_minutes)
        return {"result": {"today": {"regularMarket": {"startTime": start.isoformat(), "endTime": end.isoformat()}}}}

    def get_holdings_raw(self):
        return {"result": {"holdings": []}}

    def get_prices_raw(self, symbols):
        return {"result": [{"symbol": symbol, "lastPrice": "84.5", "timestamp": date.today().isoformat() + "T13:00:00+09:00"} for symbol in symbols]}

    def get_buying_power_raw(self):
        return {"result": {"cashBuyingPower": "100000"}}

    def get_daily_candles_raw(self, symbol, count, before=None):
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        return {"result": {"candles": [
            {"timestamp": today + "T13:00:00+09:00", "closePrice": "84.5"},
            {"timestamp": yesterday + "T13:00:00+09:00", "closePrice": "82"},
        ]}}

    def submit_order(self, order, client_order_id):
        if order.reason.startswith("New-cycle") and any(order.client_order_id.startswith(symbol) for symbol in self.reject_symbols):
            from toss_api import TossApiError
            raise TossApiError("price-out-of-range", code="price-out-of-range")
        return super().submit_order(order, client_order_id)


class SplitSessionAutoTickBroker(AutoTickBroker):
    """Expose separate day-market and pre-market windows for auto_tick tests."""

    def __init__(self):
        super().__init__()
        self.phase = "day"
        self._regular_start = None

    def get_us_market_calendar_raw(self, date_str):
        now = datetime.now(timezone.utc)
        if self._regular_start is None:
            self._regular_start = now + timedelta(minutes=30)
        regular_start = self._regular_start
        day_start = regular_start - timedelta(hours=12)
        pre_start = now + timedelta(minutes=20) if self.phase == "day" else now - timedelta(minutes=10)
        return {"result": {"today": {
            "dayMarket": {"startTime": day_start.isoformat(), "endTime": pre_start.isoformat()},
            "preMarket": {"startTime": pre_start.isoformat(), "endTime": regular_start.isoformat()},
            "regularMarket": {"startTime": regular_start.isoformat(), "endTime": (regular_start + timedelta(hours=5)).isoformat()},
        }}}


class OvernightSessionBroker(AutoTickBroker):
    """The US 2026-08-03 session is still open after Korea reaches Aug 4."""

    def get_us_market_calendar_raw(self, date_str):
        now = datetime.now(timezone.utc)
        return {"result": {"today": {
            "date": "2026-08-03",
            "dayMarket": {"startTime": (now - timedelta(hours=12)).isoformat(), "endTime": (now - timedelta(hours=6)).isoformat()},
            "preMarket": {"startTime": (now - timedelta(hours=6)).isoformat(), "endTime": (now - timedelta(hours=1)).isoformat()},
            "regularMarket": {"startTime": (now - timedelta(hours=1)).isoformat(), "endTime": (now + timedelta(hours=5)).isoformat()},
        }}}


class TradingWebServiceTests(unittest.TestCase):
    def _service(self, temp, broker):
        service = TradingWebService(Path(temp), broker_factory=lambda: broker)
        service.plan({
            "symbol": "TQQQ",
            "current_price": "84.5",
            "previous_close": "82",
            "cash_usd": "1200",
            "position_qty": 8,
            "avg_cost": "75",
            "t_value": "3",
            "base_buy_qty": 2,
            "mode": "GENERAL",
        })
        return service

    @staticmethod
    def _activate(service, symbol):
        symbol = symbol.upper()
        if symbol not in service.runtime.active_symbols:
            service.runtime.active_symbols.append(symbol)
        if symbol not in service.runtime.known_symbols:
            service.runtime.known_symbols.append(symbol)
        service.runtime_store.save(service.runtime)

    def test_syncs_a_matching_real_open_order(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeTradingBroker()
            service = self._service(temp, broker)
            order = service.plan_cache["TQQQ"][0]
            broker.open_orders = [{
                "orderId": "real-1",
                "symbol": "TQQQ",
                "side": order.side.upper(),
                "quantity": str(order.quantity),
                "price": str(order.limit_price),
                "status": "PENDING",
            }]
            service.runtime.broker_order_ids[order.client_order_id] = "real-1"
            service.runtime_store.save(service.runtime)

            result = service.sync_orders("TQQQ")

            self.assertEqual(result["orders"][0]["status"], "PENDING")
            self.assertEqual(result["unmatched_count"], 0)

    def test_historical_same_price_order_is_not_matched_to_todays_plan_without_broker_id(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeTradingBroker()
            service = self._service(temp, broker)
            order = service.plan_cache["TQQQ"][0]
            broker.closed_orders = [{
                "orderId": "old-order",
                "symbol": "TQQQ",
                "side": order.side.upper(),
                "quantity": str(order.quantity),
                "price": str(order.limit_price),
                "status": "FILLED",
                "orderedAt": "2026-07-20T22:30:00+09:00",
            }]

            result = service.sync_orders("TQQQ")

            self.assertEqual(result["orders"][0]["status"], "UNSENT")

    def test_broker_accepted_but_not_listed_order_stays_unconfirmed_and_cannot_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = DelayedVisibilityBroker()
            service = self._service(temp, broker)
            order = service.plan_cache["TQQQ"][0]
            service.sync_orders("TQQQ")
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            service.runtime_store.save(service.runtime)

            result = service.submit_orders("TQQQ", [order.client_order_id], "SUBMIT TQQQ 1")

            self.assertEqual(result["confirmed"], 0)
            self.assertEqual(service.order_statuses["TQQQ"][order.client_order_id], "UNCONFIRMED")
            self.assertIn(order.client_order_id, service.runtime.active_order_ids)
            with self.assertRaisesRegex(ValueError, "UNCONFIRMED"):
                service.retry_failed_order(order.client_order_id)

    def test_unsent_retry_reuses_the_same_broker_client_id(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = FirstRequestFailsBroker()
            service = self._service(temp, broker)
            order = service.plan_cache["TQQQ"][0]
            service.sync_orders("TQQQ")
            self._activate(service, "TQQQ")

            first = service.submit_orders("TQQQ", [order.client_order_id], "SUBMIT TQQQ 1")
            retried = service.retry_failed_order(order.client_order_id)

            self.assertEqual(first["confirmed"], 0)
            self.assertEqual(retried["confirmed"], 1)
            self.assertEqual(len(broker.client_ids), 2)
            self.assertEqual(broker.client_ids[0], broker.client_ids[1])

    def test_auto_tick_keeps_order_ids_on_the_us_session_date_after_korea_midnight(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = OvernightSessionBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 8, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            })
            self._activate(service, "TQQQ")

            service.auto_tick()

            self.assertTrue(service.plan_cache["TQQQ"])
            self.assertTrue(all("-20260803-" in order.client_order_id for order in service.plan_cache["TQQQ"]))

    def test_dashboard_refresh_keeps_the_same_us_session_date_after_korea_midnight(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = OvernightSessionBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)

            service.refresh_account("TQQQ")

            self.assertTrue(service.plan_cache["TQQQ"])
            self.assertTrue(all("-20260803-" in order.client_order_id for order in service.plan_cache["TQQQ"]))

    def test_trade_history_uses_the_shared_aggregation(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeTradingBroker()
            broker.closed_orders = [{
                "symbol": "TQQQ",
                "side": "BUY",
                "status": "FILLED",
                "execution": {
                    "filledQuantity": "2",
                    "averageFilledPrice": "80",
                    "filledAmount": "160",
                    "commission": "0.2",
                    "filledAt": datetime.now(timezone.utc).isoformat(),
                },
            }]
            service = self._service(temp, broker)

            result = service.trade_history("TQQQ", "2026-01-01")

            self.assertEqual(len(result["trades"]), 1)
            self.assertEqual(result["trades"][0]["side"], "BUY")

    def test_cumulative_realized_pnl_sums_only_known_symbols_closed_sells(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeTradingBroker()
            now = datetime.now(timezone.utc).isoformat()
            broker.closed_orders = [
                {"symbol": "TQQQ", "side": "BUY", "status": "FILLED", "execution": {
                    "filledQuantity": "10", "averageFilledPrice": "80", "filledAmount": "800",
                    "commission": "0", "filledAt": now,
                }},
                {"symbol": "TQQQ", "side": "SELL", "status": "FILLED", "execution": {
                    "filledQuantity": "10", "averageFilledPrice": "90", "filledAmount": "900",
                    "commission": "0", "filledAt": now,
                }},
                # SOXL never auto-traded (not in known_symbols) -- must be excluded even
                # though it has a closed sell in the broker's raw order feed.
                {"symbol": "SOXL", "side": "BUY", "status": "FILLED", "execution": {
                    "filledQuantity": "5", "averageFilledPrice": "20", "filledAmount": "100",
                    "commission": "0", "filledAt": now,
                }},
                {"symbol": "SOXL", "side": "SELL", "status": "FILLED", "execution": {
                    "filledQuantity": "5", "averageFilledPrice": "10", "filledAmount": "50",
                    "commission": "0", "filledAt": now,
                }},
            ]
            service = self._service(temp, broker)
            self._activate(service, "TQQQ")

            result = service.cumulative_realized_pnl("2026-01-01")

            self.assertEqual(result["realized_pnl"], "100")
            self.assertEqual(result["unknown_sales"], 0)
            self.assertEqual(result["by_symbol"], [
                {"symbol": "TQQQ", "realized_pnl": "100", "unknown_sales": 0, "sell_count": 1},
            ])

    def test_realized_pnl_finds_cost_basis_for_a_buy_before_the_reporting_window(self):
        """A share bought (e.g. manually, outside this app) before the
        reporting start date must still be found as cost basis for a sell
        that happens to fall inside the window -- otherwise that sell's P/L
        is silently dropped as "unknown", undercounting the total."""
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeTradingBroker()
            broker.closed_orders = [
                {"symbol": "TQQQ", "side": "BUY", "status": "FILLED", "execution": {
                    "filledQuantity": "10", "averageFilledPrice": "80", "filledAmount": "800",
                    "commission": "0", "filledAt": "2024-01-05T00:00:00+00:00",
                }},
                {"symbol": "TQQQ", "side": "SELL", "status": "FILLED", "execution": {
                    "filledQuantity": "10", "averageFilledPrice": "90", "filledAmount": "900",
                    "commission": "0", "filledAt": datetime.now(timezone.utc).isoformat(),
                }},
            ]
            service = self._service(temp, broker)
            self._activate(service, "TQQQ")

            history = service.trade_history("TQQQ", (date.today() - timedelta(days=7)).isoformat())
            cumulative = service.cumulative_realized_pnl((date.today() - timedelta(days=7)).isoformat())

            self.assertEqual(history["realized_pnl"], "100")
            self.assertEqual(history["unknown_sales"], 0)
            self.assertEqual(len(history["trades"]), 1)  # the old 2024 buy is outside the window and not reported
            self.assertEqual(cumulative["realized_pnl"], "100")
            self.assertEqual(cumulative["unknown_sales"], 0)

    def test_cumulative_realized_pnl_rejects_a_future_start_date(self):
        with tempfile.TemporaryDirectory() as temp:
            service = self._service(temp, FakeTradingBroker())
            future = (date.today() + timedelta(days=2)).isoformat()

            with self.assertRaises(ValueError):
                service.cumulative_realized_pnl(future)

    def test_dry_run_broker_cannot_submit_web_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeTradingBroker()
            service = self._service(temp, broker)
            self._activate(service, "TQQQ")
            service.sync_orders("TQQQ")
            order_id = service.plan_cache["TQQQ"][0].client_order_id

            with self.assertRaises(PermissionError):
                service.submit_orders("TQQQ", [order_id], "SUBMIT TQQQ 1")

    def test_submit_orders_skips_ladder_legs_that_exceed_available_cash(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._activate(service, "TQQQ")
            available_cash = Decimal("300")
            service.plan({
                "symbol": "TQQQ",
                "current_price": "84.5",
                "previous_close": "82",
                "cash_usd": str(available_cash),
                "position_qty": 8,
                "avg_cost": "75",
                "t_value": "3",
                "base_buy_qty": 2,
                "mode": "GENERAL",
            })
            service.sync_orders("TQQQ")
            planned = service.plan_cache["TQQQ"]
            buy_orders = [order for order in planned if order.side == "buy"]
            total_buy_notional = sum(order.limit_price * order.quantity for order in buy_orders)
            self.assertGreater(total_buy_notional, available_cash)

            ids = [order.client_order_id for order in planned]
            result = service.submit_orders("TQQQ", ids, f"SUBMIT TQQQ {len(ids)}", all_pending=True)

            submitted_ids = {item["id"] for item in result["submitted"]}
            submitted_buy_notional = sum(
                order.limit_price * order.quantity for order in buy_orders if order.client_order_id in submitted_ids
            )
            self.assertLessEqual(submitted_buy_notional, available_cash)
            self.assertTrue(any("초과" in error for error in result["errors"]))

    def test_disabled_ladder_levels_are_excluded_from_cash_reservation(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._activate(service, "TQQQ")
            payload = {
                "symbol": "TQQQ",
                "current_price": "51",
                "previous_close": "51",
                "cash_usd": "400",
                "position_qty": 100,
                "avg_cost": "50",
                "t_value": "10",
                "base_buy_qty": 2,
                "mode": "GENERAL",
            }

            # down_ladder_enabled_levels is set directly on the persisted state here
            # (the payload wiring for it is added in a later step); this test only
            # proves submit_orders' cash reservation reflects whatever build_plan()
            # already filtered out.
            state = service.store.load("TQQQ")
            state.down_ladder_enabled_levels = [1, 2]
            service.store.save(state)
            service.plan(payload)
            minimal_planned = service.plan_cache["TQQQ"]
            minimal_notional = sum(o.limit_price * o.quantity for o in minimal_planned if o.side == "buy")

            state = service.store.load("TQQQ")
            state.down_ladder_enabled_levels = [1, 2, 3, 4, 5]
            service.store.save(state)
            service.plan(payload)
            full_planned = service.plan_cache["TQQQ"]
            full_notional = sum(o.limit_price * o.quantity for o in full_planned if o.side == "buy")

            self.assertLess(minimal_notional, full_notional)


class NewOrderGuardTests(unittest.TestCase):
    """Requirement 5/10: a stopped ETF must never send a new order, including
    manual submits, auto-tick submits, and rejected-order replacement retries."""

    def _plan(self, service, **overrides):
        payload = {
            "symbol": "TQQQ",
            "current_price": "84.5",
            "previous_close": "82",
            "cash_usd": "5000",
            "position_qty": 8,
            "avg_cost": "75",
            "t_value": "3",
            "base_buy_qty": 2,
            "mode": "GENERAL",
        }
        payload.update(overrides)
        service.plan(payload)

    def test_stopped_symbol_blocks_submit_orders_before_any_broker_call(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._plan(service)
            service.sync_orders("TQQQ")
            ids = [order.client_order_id for order in service.plan_cache["TQQQ"]]

            with self.assertRaises(PermissionError):
                service.submit_orders("TQQQ", ids, f"SUBMIT TQQQ {len(ids)}", all_pending=True)

            self.assertEqual(broker.submitted, [])

    def test_start_auto_activates_symbol_and_submits_initial_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._plan(service)
            service.sync_orders("TQQQ")
            planned = service.plan_cache["TQQQ"]

            result = service.start_auto("TQQQ", f"SUBMIT TQQQ {len(planned)}")

            self.assertIn("TQQQ", service.runtime.active_symbols)
            self.assertIn("TQQQ", service.runtime.known_symbols)
            self.assertTrue(result["auto_enabled"])
            self.assertGreater(len(broker.submitted), 0)
            self.assertIn("TQQQ", service.runtime.last_auto_attempt_at)

    def test_start_auto_rolls_back_active_symbols_when_nothing_confirmed(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            # Fresh (never-held) position -> build_plan produces a single buy-only
            # entry order; zero cash means it gets trimmed and nothing is affordable.
            self._plan(service, cash_usd="0", position_qty=0, avg_cost="0", t_value="0")
            service.sync_orders("TQQQ")
            planned = service.plan_cache["TQQQ"]

            with self.assertRaises(ValueError):
                service.start_auto("TQQQ", f"SUBMIT TQQQ {len(planned)}")

            self.assertNotIn("TQQQ", service.runtime.active_symbols)

    def test_stop_auto_blocks_further_new_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._plan(service)
            service.sync_orders("TQQQ")
            planned = service.plan_cache["TQQQ"]
            service.start_auto("TQQQ", f"SUBMIT TQQQ {len(planned)}")
            broker.submitted.clear()

            service.stop_auto("TQQQ")

            with self.assertRaises(PermissionError):
                service.submit_orders("TQQQ", [item.client_order_id for item in planned], f"SUBMIT TQQQ {len(planned)}", all_pending=True)
            self.assertEqual(broker.submitted, [])

    def test_stop_auto_does_not_cancel_open_broker_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._plan(service)
            service.sync_orders("TQQQ")
            planned = service.plan_cache["TQQQ"]
            service.start_auto("TQQQ", f"SUBMIT TQQQ {len(planned)}")

            service.stop_auto("TQQQ")

            self.assertEqual(broker.cancel_calls, [])

    def test_stop_auto_keeps_symbol_known_for_continued_sync(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._plan(service)
            service.sync_orders("TQQQ")
            planned = service.plan_cache["TQQQ"]
            service.start_auto("TQQQ", f"SUBMIT TQQQ {len(planned)}")

            service.stop_auto("TQQQ")

            self.assertNotIn("TQQQ", service.runtime.active_symbols)
            self.assertIn("TQQQ", service.runtime.known_symbols)
            # sync_orders/refresh_account must still work with no exception raised.
            result = service.sync_orders("TQQQ")
            self.assertTrue(result["synced"])

    def test_other_etf_start_stop_is_unaffected_by_a_stopped_symbol(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._plan(service, symbol="TQQQ")
            service.sync_orders("TQQQ")
            service.start_auto("TQQQ", f"SUBMIT TQQQ {len(service.plan_cache['TQQQ'])}")
            service.stop_auto("TQQQ")

            # SOXL was never started; starting it now must succeed even though
            # TQQQ is currently stopped.
            self._plan(service, symbol="SOXL")
            service.sync_orders("SOXL")
            planned_soxl = service.plan_cache["SOXL"]
            result = service.start_auto("SOXL", f"SUBMIT SOXL {len(planned_soxl)}")

            self.assertGreater(len(result["submitted"]), 0)
            self.assertIn("SOXL", service.runtime.active_symbols)
            self.assertNotIn("TQQQ", service.runtime.active_symbols)


class AutoTickTests(unittest.TestCase):
    def _start(self, service, broker, symbol):
        payload = {
            "symbol": symbol,
            "current_price": "84.5",
            "previous_close": "82",
            "cash_usd": "5000",
            "position_qty": 0,
            "avg_cost": "0",
            "t_value": "0",
            "base_buy_qty": 2,
            "mode": "GENERAL",
        }
        service.plan(payload)
        service.sync_orders(symbol)
        planned = service.plan_cache[symbol]
        service.start_auto(symbol, f"SUBMIT {symbol} {len(planned)}")

    def test_auto_tick_syncs_a_stopped_symbol_but_does_not_submit_new_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = AutoTickBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._start(service, broker, "TQQQ")
            service.stop_auto("TQQQ")
            broker.submitted.clear()

            service.auto_tick()

            self.assertEqual(broker.submitted, [])
            self.assertIn("TQQQ", service.orders_synced)

    def test_auto_tick_continues_other_active_symbols_when_one_is_stopped(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = AutoTickBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._start(service, broker, "TQQQ")
            service.stop_auto("TQQQ")
            # SOXL is marked RUNNING but has not been given an initial batch yet,
            # so auto_tick's own submit-stage is what sends its first orders.
            service.plan({
                "symbol": "SOXL", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 0, "avg_cost": "0",
                "t_value": "0", "base_buy_qty": 2, "mode": "GENERAL",
            })
            service.sync_orders("SOXL")
            service.runtime.active_symbols.append("SOXL")
            service.runtime.known_symbols.append("SOXL")
            service.runtime_store.save(service.runtime)
            broker.submitted.clear()

            service.auto_tick()

            self.assertTrue(any(cid.startswith("default-SOXL") for cid in broker.submitted))
            self.assertFalse(any(cid.startswith("default-TQQQ") for cid in broker.submitted))

    def test_rejected_order_replacement_is_not_generated_while_stopped(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = AutoTickBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._start(service, broker, "KORU")
            service.stop_auto("KORU")
            # Only reject *after* KORU is stopped: proves that even a rejected
            # order that would normally trigger a price-guard replacement retry
            # is never attempted at all while new orders are paused.
            broker.reject_symbols = {"default-KORU"}
            broker.submitted.clear()
            service.runtime.auto_attempt_keys.clear()
            service.runtime_store.save(service.runtime)

            service.auto_tick()

            self.assertEqual(broker.submitted, [])

    def test_auto_tick_uses_the_configurable_delay_minutes(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = AutoTickBroker()
            broker.market_open_offset_minutes = 10
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            self._start(service, broker, "TQQQ")
            service.runtime.auto_order_delay_minutes = 60  # session start (-10m) + 60m is still in the future
            service.runtime.auto_attempt_keys.clear()
            service.runtime_store.save(service.runtime)
            broker.submitted.clear()

            service.auto_tick()

            self.assertEqual(broker.submitted, [])

    def test_auto_tick_submits_sells_before_the_buy_delay_elapses(self):
        """Sell legs are immediate-sell limit orders, so they must not wait
        for auto_order_delay_minutes the way LOC buy legs do -- a pre-market
        pop that fades by the regular open would otherwise be missed."""
        with tempfile.TemporaryDirectory() as temp:
            broker = AutoTickBroker()
            broker.market_open_offset_minutes = 10
            # auto_tick's own refresh_account call re-derives position_qty from
            # broker holdings, so the held position must come from the broker
            # (not just the initial plan()/state.json seed) or it gets reset to 0.
            broker.get_holdings_raw = lambda: {"result": {"holdings": [
                {"symbol": "TQQQ", "quantity": "8", "averagePrice": "75"},
            ]}}
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 8, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            })
            service.sync_orders("TQQQ")
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            # session start (-10m) + 60m is still in the future -> buy leg not ready yet
            service.runtime.auto_order_delay_minutes = 60
            service.runtime_store.save(service.runtime)
            broker.submitted.clear()

            service.auto_tick()

            sell_ids = [cid for cid in broker.submitted if "sell" in cid]
            buy_ids = [cid for cid in broker.submitted if "buy" in cid]
            self.assertTrue(sell_ids, "sell legs should submit immediately, unblocked by the buy delay")
            self.assertEqual(buy_ids, [])

    def test_auto_tick_splits_day_limit_sell_from_late_cls_sell(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = SplitSessionAutoTickBroker()
            broker.get_holdings_raw = lambda: {"result": {"holdings": [
                {"symbol": "TQQQ", "quantity": "8", "averagePrice": "75"},
            ]}}
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 8, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            })
            service.sync_orders("TQQQ")
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            service.runtime.auto_order_delay_minutes = 60
            service.runtime_store.save(service.runtime)

            service.auto_tick()

            today_prefix = f"default-TQQQ-{broker._regular_start.date():%Y%m%d}"
            self.assertIn(today_prefix + "-take-profit", broker.submitted)
            self.assertNotIn(today_prefix + "-quarter-sell", broker.submitted)

            broker.phase = "late"
            service.auto_tick()

            self.assertIn(today_prefix + "-quarter-sell", broker.submitted)
            self.assertEqual(broker.submitted.count(today_prefix + "-take-profit"), 1)

    def test_retry_failed_order_submits_the_same_strategy_leg(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 8, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            })
            order = next(item for item in service.plan_cache["TQQQ"] if item.client_order_id.endswith("-take-profit"))
            broker.closed_orders = [{
                "orderId": "old-canceled", "symbol": "TQQQ", "side": "SELL",
                "quantity": str(order.quantity), "price": str(order.limit_price), "status": "CANCELED",
            }]
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            service.runtime.broker_order_ids[order.client_order_id] = "old-canceled"
            service.runtime_store.save(service.runtime)
            service.sync_orders("TQQQ")

            result = service.retry_failed_order(order.client_order_id)

            self.assertEqual(result["retried"], order.client_order_id)
            self.assertEqual(broker.submitted, [order.client_order_id])
            self.assertEqual(result["confirmed"], 1)

    def test_retry_failed_order_with_price_submits_the_changed_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 8, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            })
            order = next(item for item in service.plan_cache["TQQQ"] if item.client_order_id.endswith("-take-profit"))
            broker.closed_orders = [{
                "orderId": "old-canceled", "symbol": "TQQQ", "side": "SELL",
                "quantity": str(order.quantity), "price": str(order.limit_price), "status": "CANCELED",
            }]
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            service.runtime.broker_order_ids[order.client_order_id] = "old-canceled"
            service.runtime_store.save(service.runtime)
            service.sync_orders("TQQQ")

            result = service.retry_failed_order_with_price(order.client_order_id, "65.25")

            self.assertEqual(result["retried"], order.client_order_id)
            self.assertEqual(result["price"], "65.25")
            self.assertEqual(result["confirmed"], 1)
            self.assertEqual(broker.open_orders[-1]["price"], "65.25")

    def test_retry_failed_order_with_quantity_submits_the_changed_quantity(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 8, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            })
            order = next(item for item in service.plan_cache["TQQQ"] if item.client_order_id.endswith("-take-profit"))
            broker.closed_orders = [{
                "orderId": "old-canceled", "symbol": "TQQQ", "side": "SELL",
                "quantity": str(order.quantity), "price": str(order.limit_price), "status": "CANCELED",
            }]
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            service.runtime.broker_order_ids[order.client_order_id] = "old-canceled"
            service.runtime_store.save(service.runtime)
            service.sync_orders("TQQQ")

            result = service.retry_failed_order_with_quantity(order.client_order_id, 3)

            self.assertEqual(result["retried"], order.client_order_id)
            self.assertEqual(result["quantity"], 3)
            self.assertEqual(result["confirmed"], 1)
            self.assertEqual(broker.open_orders[-1]["quantity"], "3")

    def test_notify_flag_reports_confirmed_auto_submission(self):
        class Telegram:
            enabled = True

            def __init__(self):
                self.messages = []

            def send_message(self, text):
                self.messages.append(text)

        with tempfile.TemporaryDirectory() as temp:
            broker = LiveTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.telegram = Telegram()
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 0, "avg_cost": "0",
                "t_value": "0", "base_buy_qty": 2, "mode": "GENERAL",
            })
            service.sync_orders("TQQQ")
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            service.runtime_store.save(service.runtime)
            order = service.plan_cache["TQQQ"][0]

            service.submit_orders("TQQQ", [order.client_order_id], "SUBMIT TQQQ 1", notify=True)

            self.assertEqual(len(service.telegram.messages), 1)
            self.assertIn("접수 성공", service.telegram.messages[0])

    def test_rejected_status_notification_explains_that_toss_list_has_no_reason(self):
        class Telegram:
            enabled = True

            def __init__(self):
                self.messages = []

            def send_message(self, text, **kwargs):
                self.messages.append(text)

        with tempfile.TemporaryDirectory() as temp:
            broker = RejectedAfterAcceptanceBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.telegram = Telegram()
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "5000", "position_qty": 0, "avg_cost": "0",
                "t_value": "0", "base_buy_qty": 2, "mode": "GENERAL",
            })
            service.sync_orders("TQQQ")
            service.runtime.active_symbols.append("TQQQ")
            service.runtime.known_symbols.append("TQQQ")
            service.runtime_store.save(service.runtime)
            order = service.plan_cache["TQQQ"][0]

            service.submit_orders("TQQQ", [order.client_order_id], "SUBMIT TQQQ 1", notify=True)

            self.assertIn("상세 거절 사유", service.telegram.messages[-1])
            self.assertIn("토스 앱", service.telegram.messages[-1])

    def test_pending_order_count_reflects_open_statuses(self):
        with tempfile.TemporaryDirectory() as temp:
            broker = FakeTradingBroker()
            service = TradingWebService(Path(temp), broker_factory=lambda: broker)
            service.plan({
                "symbol": "TQQQ", "current_price": "84.5", "previous_close": "82",
                "cash_usd": "1200", "position_qty": 8, "avg_cost": "75",
                "t_value": "3", "base_buy_qty": 2, "mode": "GENERAL",
            })
            order = service.plan_cache["TQQQ"][0]
            broker.open_orders = [{
                "orderId": "real-1", "symbol": "TQQQ", "side": order.side.upper(),
                "quantity": str(order.quantity), "price": str(order.limit_price), "status": "PENDING",
            }]

            service.sync_orders("TQQQ")

            self.assertEqual(service.pending_order_count("TQQQ"), 1)


class WebAuthTests(unittest.TestCase):
    def test_status_only_reports_password_sessions(self):
        with patch.dict(os.environ, {"MUMAE_WEB_PASSWORD": "secret"}, clear=True):
            auth = WebAuth()
            status = auth.status(None)
            self.assertFalse(status["authenticated"])
            self.assertNotIn("local_auto_login", status)

    def test_status_restores_csrf_for_authenticated_session(self):
        with patch.dict(os.environ, {"MUMAE_WEB_PASSWORD": "secret"}, clear=True):
            auth = WebAuth()
            token, csrf = auth.login("secret")
            status = auth.status("mumae_session=" + token)
            self.assertTrue(status["authenticated"])
            self.assertEqual(status["csrf"], csrf)

    def test_requires_password_csrf_and_explicit_live_flag(self):
        with patch.dict(os.environ, {"MUMAE_WEB_PASSWORD": "secret"}, clear=True):
            auth = WebAuth()
            token, csrf = auth.login("secret")
            with self.assertRaises(PermissionError):
                auth.validate("mumae_session=" + token, csrf, live=True)


if __name__ == "__main__":
    unittest.main()
