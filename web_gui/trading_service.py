"""Windows-GUI feature parity services for orders, history, and ETF analysis."""
from __future__ import annotations

import sys
import threading
import time
import uuid
from dataclasses import asdict, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_UP, InvalidOperation
from typing import Any

from etf_linkage import analyze_etf_pairs
from etf_long_term import analyze_individual_etfs
from mumae_core import CENT, OrderIntent, OrderKind, apply_fill, money
from toss_api import TossApiError
from trade_history import aggregate_daily_trades, summarize_realized_pnl
from volatility import ETF_UNIVERSE
from web_gui.web_service import WebService, _json_value

OPEN_STATUSES = {"PENDING", "PARTIAL_FILLED", "PENDING_CANCEL", "PENDING_REPLACE"}
FAILED_STATUSES = {"REJECTED", "CANCELED", "REPLACE_REJECTED", "CANCEL_REJECTED"}
CONFIRMED_STATUSES = OPEN_STATUSES | {"FILLED"}
AUTO_REPRICE_SYMBOLS = {"KORU", "SOXL"}
# Statuses a custom order must be in before "reregister" is offered. Narrower
# than FAILED_STATUSES: REPLACE_REJECTED/CANCEL_REJECTED mean the *original*
# order may still be open at the broker, so reregistering it would risk a
# duplicate live order.
REREGISTERABLE_STATUSES = {"CANCELED", "REJECTED"}
# Realized-P/L FIFO cost-basis reconstruction needs every prior fill, not just
# ones inside the reporting window -- a share bought manually (outside this
# app, e.g. directly in the Toss app) before the reporting start date would
# otherwise leave a later sell's cost basis "unknown" and silently drop it
# from the total. So the broker query for building the ledger always reaches
# back to this fixed early anchor; the caller's start date only filters which
# already-cost-basis-resolved sells get reported/summed.
LEDGER_ANCHOR_DATE = "2020-01-01"


class TradingWebService(WebService):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.order_rows: dict[str, list[dict[str, Any]]] = {}
        self.order_statuses: dict[str, dict[str, str]] = {}
        self.order_records: dict[str, dict[str, dict[str, Any]]] = {}
        self.unmatched_orders: dict[str, dict[str, dict[str, Any]]] = {}
        self.orders_synced: set[str] = set()
        # Per-original-order-id locks so two near-simultaneous "reregister"
        # requests for the same cancelled order can never both create a new
        # live order (see reregister_order).
        self._reregister_locks: dict[str, threading.Lock] = {}
        self._reregister_locks_guard = threading.Lock()

    @staticmethod
    def _match_key(side: str, quantity: Any, price: Any) -> tuple[str, int, Decimal]:
        return str(side).upper(), int(Decimal(str(quantity or "0"))), Decimal(str(price or "0")).quantize(Decimal("0.01"))

    def _apply_new_fills(self, symbol: str, rows: list[dict[str, Any]]) -> None:
        state = self.store.load(symbol)
        broker_to_client = {broker_id: client_id for client_id, broker_id in self.runtime.broker_order_ids.items()}
        known_ids = set(self.runtime.broker_order_ids)
        changed = False
        for row in sorted(rows, key=lambda item: str((item.get("execution") or {}).get("filledAt") or "")):
            if str(row.get("status", "")).upper() != "FILLED":
                continue
            client_id = broker_to_client.get(str(row.get("orderId") or ""))
            if not client_id or client_id in state.applied_fill_order_ids:
                continue
            execution = row.get("execution") or {}
            quantity = int(Decimal(str(execution.get("filledQuantity") or row.get("quantity") or "0")))
            side = str(row.get("side") or "").lower()
            event = None
            if side == "buy":
                if client_id.endswith("-avg-buy"):
                    event = "half_buy"
                elif client_id.endswith(("-star-buy", "-big-loc")):
                    stem = client_id.removesuffix("-star-buy").removesuffix("-big-loc")
                    event = "half_buy" if stem + "-avg-buy" in known_ids else "full_buy"
                elif client_id.endswith("-entry") or "-ladder-" in client_id:
                    event = "full_buy"
            elif side == "sell" and client_id.endswith("-quarter-sell"):
                event = "quarter_sell"
            if event and quantity > 0:
                apply_fill(state, side, quantity, event)
                state.applied_fill_order_ids.append(client_id)
                changed = True
        if changed:
            self.store.save(state)

    def sync_orders(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        today_value = date.today()
        rows: list[dict[str, Any]] = []
        open_rows: dict[str, dict[str, Any]] = {}
        for group in ("CLOSED", "OPEN"):
            fetched = self.broker().get_all_orders_raw(
                group, symbol, (today_value - timedelta(days=7)).isoformat(), today_value.isoformat()
            )
            rows.extend(fetched)
            if group == "OPEN":
                for row in fetched:
                    order_id = str(row.get("orderId") or "")
                    if order_id and str(row.get("status", "")).upper() in OPEN_STATUSES:
                        open_rows["toss-open-" + order_id] = row
        self._apply_new_fills(symbol, rows)
        self.order_rows[symbol] = rows
        self.orders_synced.add(symbol)

        # plan_cache only ever holds *today's* strategy plan and is rebuilt
        # (and lost) on every process restart. custom_order_ledger is the
        # persisted, restart-surviving record of every order a human has
        # hand-edited, so a cancelled custom order from an earlier day/process
        # can still be found and matched against fresh broker rows here.
        planned = list(self.plan_cache.get(symbol, []))
        planned_ids = {order.client_order_id for order in planned}
        stale_ledger_ids: list[str] = []
        for client_order_id, info in self.runtime.custom_order_ledger.items():
            if info.get("symbol") != symbol or client_order_id in planned_ids:
                continue
            if client_order_id not in self.runtime.broker_order_ids:
                # Hand-edited (order_price_overrides/custom_order_ledger) but
                # never actually sent, and the leg it was edited for has since
                # fallen out of today's plan (e.g. the position fully exited
                # before the user resubmitted it) -- it can never be matched
                # to a broker row or re-shown with an actionable button, so it
                # would otherwise linger forever, inflating the "unsent order"
                # count the SUBMIT confirmation text is checked against and
                # permanently blocking new orders for this symbol.
                stale_ledger_ids.append(client_order_id)
                continue
            planned.append(OrderIntent(
                client_order_id,
                info["side"],
                int(info["quantity"]),
                Decimal(str(info["price"])),
                OrderKind.LIMIT,
                str(info.get("reason", "")),
            ))
        if stale_ledger_ids:
            for client_order_id in stale_ledger_ids:
                self.runtime.custom_order_ledger.pop(client_order_id, None)
                self.runtime.order_price_overrides.pop(client_order_id, None)
            self.runtime_store.save(self.runtime)
        unused = set(range(len(rows)))
        statuses: dict[str, str] = {}
        records: dict[str, dict[str, Any]] = {}
        unmatched = dict(open_rows)
        result: list[dict[str, Any]] = []
        for order in planned:
            actual_id = self.runtime.broker_order_ids.get(order.client_order_id)
            match = next((index for index in reversed(range(len(rows))) if index in unused and actual_id and str(rows[index].get("orderId") or "") == actual_id), None)
            if match is None:
                expected = self._match_key(order.side, order.quantity, order.limit_price)
                match = next((index for index in reversed(range(len(rows))) if index in unused and self._match_key(rows[index].get("side"), rows[index].get("quantity"), rows[index].get("price")) == expected), None)
            status = "UNSENT"
            if match is not None:
                unused.remove(match)
                record = rows[match]
                status = str(record.get("status", "UNKNOWN")).upper()
                records[order.client_order_id] = record
                statuses[order.client_order_id] = status
                actual_order_id = str(record.get("orderId") or "")
                unmatched.pop("toss-open-" + actual_order_id, None)
            elif order.client_order_id in self.runtime.skipped_order_ids:
                status = "SKIPPED"
            elif order.client_order_id in self.runtime.active_order_ids:
                status = "UNCONFIRMED"
            result.append(self._order_payload(symbol, order, status))
        for item_id, row in unmatched.items():
            result.append({
                "id": item_id,
                "side": str(row.get("side", "")).lower(),
                "quantity": int(Decimal(str(row.get("quantity") or "0"))),
                "price": str(row.get("price") or "0"),
                "kind": str(row.get("orderType") or "TOSS"),
                "reason": "토스 실제 대기주문 · 현재 계획과 다름",
                "status": str(row.get("status", "UNKNOWN")).upper(),
                "broker_only": True,
            })
        self.order_statuses[symbol] = statuses
        self.order_records[symbol] = records
        self.unmatched_orders[symbol] = unmatched
        return {"symbol": symbol, "orders": result, "synced": True, "unmatched_count": len(unmatched)}

    def _fill_progress(self, symbol: str, client_order_id: str, original_quantity: int) -> tuple[int, int]:
        """(filled_quantity, remaining_quantity) from the last sync_orders() broker
        record for this order. Used both for display and for reregister_order's
        default/validated quantity, so both stay consistent with each other."""
        record = self.order_records.get(symbol, {}).get(client_order_id) or {}
        execution = record.get("execution") or {}
        filled = int(Decimal(str(execution.get("filledQuantity") or "0")))
        return filled, max(original_quantity - filled, 0)

    def _order_payload(self, symbol: str, order: OrderIntent, status: str) -> dict[str, Any]:
        ledger_entry = self.runtime.custom_order_ledger.get(order.client_order_id)
        history_entry = self.runtime.custom_order_history.get(order.client_order_id)
        filled, remaining = self._fill_progress(symbol, order.client_order_id, order.quantity)
        return {
            "id": order.client_order_id,
            "side": order.side,
            "quantity": order.quantity,
            "price": str(order.limit_price or "0"),
            "kind": order.kind.value,
            "reason": order.reason,
            "status": status,
            "broker_only": False,
            # "사용자 지정 주문" = has been hand-edited at least once (via
            # edit_failed_price or reregister_order); auto strategy orders
            # never appear in custom_order_ledger.
            "is_custom": ledger_entry is not None,
            "original_order_id": (ledger_entry or {}).get("original_order_id"),
            "replaced_by": (history_entry or {}).get("replacement_order_id"),
            "filled_quantity": filled,
            "remaining_quantity": remaining,
        }

    def trade_history(self, symbol: str, start_date: str) -> dict[str, Any]:
        symbol = symbol.upper()
        start = date.fromisoformat(start_date)
        if start > date.today():
            raise ValueError("집계 시작일은 오늘보다 늦을 수 없습니다.")
        self.runtime.history_start_dates[symbol] = start.isoformat()
        self.runtime_store.save(self.runtime)
        rows = self.broker().get_all_orders_raw("CLOSED", symbol, LEDGER_ANCHOR_DATE, date.today().isoformat())
        daily = [trade for trade in aggregate_daily_trades(rows) if trade.trade_date >= start.isoformat()]
        total, unknown_sales = summarize_realized_pnl(daily)
        return {
            "symbol": symbol,
            "start_date": start.isoformat(),
            "realized_pnl": str(total),
            "unknown_sales": unknown_sales,
            "trades": [_json_value(asdict(item)) for item in daily],
        }

    def cumulative_realized_pnl(self, start_date: str | None = None) -> dict[str, Any]:
        """Total already-realized profit (closed sells only, not open-position
        unrealized P&L) across every ETF this account has ever auto-traded."""
        symbols = sorted(self.runtime.known_symbols) or list(ETF_UNIVERSE)
        start = date.fromisoformat(start_date) if start_date else date.today() - timedelta(days=90)
        if start > date.today():
            raise ValueError("집계 시작일은 오늘보다 늦을 수 없습니다.")
        total = Decimal("0")
        unknown_sales = 0
        by_symbol: list[dict[str, Any]] = []
        for index, symbol in enumerate(symbols):
            rows = self.broker().get_all_orders_raw("CLOSED", symbol, LEDGER_ANCHOR_DATE, date.today().isoformat())
            daily = [trade for trade in aggregate_daily_trades(rows) if trade.trade_date >= start.isoformat()]
            symbol_total, symbol_unknown = summarize_realized_pnl(daily)
            sell_count = sum(1 for trade in daily if trade.side == "SELL")
            if sell_count:
                by_symbol.append({
                    "symbol": symbol,
                    "realized_pnl": str(symbol_total),
                    "unknown_sales": symbol_unknown,
                    "sell_count": sell_count,
                })
            total += symbol_total
            unknown_sales += symbol_unknown
            if index < len(symbols) - 1:
                time.sleep(0.25)
        return {
            "start_date": start.isoformat(),
            "realized_pnl": str(total),
            "unknown_sales": unknown_sales,
            "by_symbol": by_symbol,
        }

    def analyze_pairs(self) -> dict[str, Any]:
        closes_by_symbol: dict[str, dict[str, float]] = {}
        for index, symbol in enumerate(ETF_UNIVERSE):
            candles = self.broker().get_daily_candles_raw(symbol, 70).get("result", {}).get("candles", [])
            closes_by_symbol[symbol] = {
                str(item.get("timestamp") or item.get("date"))[:10]: float(item["closePrice"])
                for item in candles if (item.get("timestamp") or item.get("date")) and item.get("closePrice") is not None
            }
            if index < len(ETF_UNIVERSE) - 1:
                time.sleep(0.25)
        ranked = analyze_etf_pairs(closes_by_symbol, trading_days=63, minimum_days=40)
        return {"pairs": [_json_value(asdict(item)) for item in ranked]}

    def _long_closes(self, symbol: str, start_date: str = "2021-01-01") -> dict[str, float]:
        closes: dict[str, float] = {}
        before = previous = None
        for _ in range(12):
            candles = self.broker().get_daily_candles_raw(symbol, 200, before=before).get("result", {}).get("candles", [])
            timestamps = []
            for item in candles:
                timestamp = str(item.get("timestamp") or item.get("date") or "")
                if timestamp and item.get("closePrice") is not None:
                    timestamps.append(timestamp)
                    closes[timestamp[:10]] = float(item["closePrice"])
            if not timestamps:
                break
            oldest = min(timestamps)
            if oldest[:10] <= start_date:
                break
            before = oldest if "T" in oldest else oldest + "T00:00:00Z"
            if before == previous:
                break
            previous = before
            time.sleep(0.25)
        if not closes or min(closes) > start_date:
            raise ValueError(symbol + ": 2021년까지 일봉을 가져오지 못했습니다.")
        return closes

    def analyze_long_term(self) -> dict[str, Any]:
        closes = {symbol: self._long_closes(symbol) for symbol in ETF_UNIVERSE if symbol != "FNGU"}
        ranked = analyze_individual_etfs(closes, principal=10_000_000, start_date="2021-01-01")
        return {"results": [_json_value(asdict(item)) for item in ranked]}

    def edit_failed_price(self, symbol: str, client_order_id: str, value: Any) -> dict[str, Any]:
        symbol = symbol.upper()
        order = next((item for item in self.plan_cache.get(symbol, []) if item.client_order_id == client_order_id), None)
        if order is None:
            raise ValueError("현재 주문계획에 없는 주문입니다.")
        status = self.order_statuses.get(symbol, {}).get(client_order_id)
        if status not in FAILED_STATUSES and client_order_id not in self.runtime.skipped_order_ids:
            raise ValueError("거부 또는 취소된 주문만 가격을 수정할 수 있습니다.")
        price = Decimal(str(value)).quantize(Decimal("0.01"))
        if price <= 0:
            raise ValueError("지정가는 0보다 커야 합니다.")
        self.runtime.order_price_overrides[client_order_id] = str(price)
        # Marks this order as "사용자 지정 주문" (custom order) for the
        # "수정 후 재등록" feature: a persisted, restart-surviving fact
        # independent of plan_cache. See sync_orders()/reregister_order().
        self.runtime.custom_order_ledger[client_order_id] = {
            "symbol": symbol,
            "side": order.side,
            "quantity": order.quantity,
            "price": str(price),
            "reason": order.reason,
            "source": "price_override",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self.runtime.active_order_ids = [item for item in self.runtime.active_order_ids if item != client_order_id]
        self.runtime.skipped_order_ids = [item for item in self.runtime.skipped_order_ids if item != client_order_id]
        self.runtime.broker_client_order_ids.pop(client_order_id, None)
        self.runtime.broker_order_ids.pop(client_order_id, None)
        self.runtime_store.save(self.runtime)
        current, previous = self.quote_cache[symbol]
        dashboard = self.dashboard(self.store.load(symbol), current, previous)
        return {"message": f"{symbol} 지정가를 {price}로 변경했습니다.", **dashboard}

    def cancel_orders(self, symbol: str, item_ids: list[str], confirmation: str) -> dict[str, Any]:
        symbol = symbol.upper()
        if confirmation != f"CANCEL {symbol} {len(item_ids)}":
            raise PermissionError("취소 확인 문구가 일치하지 않습니다.")
        if symbol not in self.orders_synced:
            raise ValueError("토스 실제 주문현황을 먼저 동기화해야 합니다.")
        records = self.order_records.get(symbol, {})
        unmatched = self.unmatched_orders.get(symbol, {})
        cancelable: list[tuple[str, dict[str, Any]]] = []
        for item_id in item_ids:
            record = records.get(item_id) or unmatched.get(item_id)
            if record and record.get("orderId") and str(record.get("status", "")).upper() in {"PENDING", "PARTIAL_FILLED", "PENDING_REPLACE"}:
                cancelable.append((item_id, record))
        if not cancelable:
            raise ValueError("선택한 주문 중 취소 가능한 실제 주문이 없습니다.")
        canceled, errors = [], []
        for item_id, record in cancelable:
            try:
                self.broker().cancel_order(str(record["orderId"]))
                canceled.append(item_id)
            except (TossApiError, PermissionError, ValueError) as error:
                errors.append(f"{item_id}: {error}")
        return {"canceled": canceled, "errors": errors, **self.sync_orders(symbol)}

    def _broker_client_id(self, order: OrderIntent) -> str:
        value = self.runtime.broker_client_order_ids.get(order.client_order_id)
        if not value:
            value = uuid.uuid4().hex
            self.runtime.broker_client_order_ids[order.client_order_id] = value
            self.runtime_store.save(self.runtime)
        return value

    @staticmethod
    def _guard_price(symbol: str, order: OrderIntent, latest: Decimal) -> OrderIntent:
        if symbol not in AUTO_REPRICE_SYMBOLS or order.limit_price is None or latest <= 0:
            return order
        if order.side == "buy":
            guarded = latest.quantize(Decimal("0.01"), rounding=ROUND_DOWN)
            if order.limit_price <= guarded:
                return order
        elif order.side == "sell":
            guarded = latest.quantize(Decimal("0.01"), rounding=ROUND_UP)
            if order.limit_price >= guarded:
                return order
        else:
            return order
        return replace(order, limit_price=guarded, reason=order.reason + " · automatic volatility guard")

    def _submit_one(self, symbol: str, order: OrderIntent) -> tuple[OrderIntent, dict[str, Any]]:
        client_id = self._broker_client_id(order)
        try:
            return order, self.broker().submit_order(order, client_id)
        except TossApiError as error:
            if error.code != "price-out-of-range" or symbol not in AUTO_REPRICE_SYMBOLS or order.reason.startswith("Final take-profit"):
                raise
            quotes = self.broker().get_prices_raw([symbol]).get("result", [])
            if not quotes or quotes[0].get("lastPrice") is None:
                raise
            retried = self._guard_price(symbol, order, Decimal(str(quotes[0]["lastPrice"])))
            if retried.limit_price == order.limit_price:
                raise
            retry_id = uuid.uuid4().hex
            self.runtime.broker_client_order_ids[order.client_order_id] = retry_id
            self.runtime.order_price_overrides[order.client_order_id] = str(retried.limit_price)
            self.runtime_store.save(self.runtime)
            return retried, self.broker().submit_order(retried, retry_id)

    def reregister_order(
        self,
        symbol: str,
        original_id: str,
        quantity: Any,
        price: Any,
        memo: str,
        confirmation: str,
        *,
        confirm_over_remaining: bool = False,
    ) -> dict[str, Any]:
        """'수정 후 재등록': submit a brand-new order derived from a cancelled/
        rejected custom order, with a possibly-edited quantity/price/memo.
        The original order is never modified or deleted; the new order gets
        its own client_order_id, linked back via custom_order_history.

        Guarded by a per-original-id lock so two near-simultaneous calls for
        the same original_id can never both create a live order."""
        symbol = symbol.upper()
        if symbol not in ETF_UNIVERSE:
            raise ValueError("지원하지 않는 ETF입니다.")
        if not original_id:
            raise ValueError("존재하지 않는 주문입니다.")

        with self._reregister_locks_guard:
            lock = self._reregister_locks.setdefault(original_id, threading.Lock())
        if not lock.acquire(blocking=False):
            raise PermissionError("이미 재등록 처리 중인 주문입니다. 잠시 후 다시 시도하세요.")
        try:
            return self._reregister_order_locked(
                symbol, original_id, quantity, price, memo, confirmation,
                confirm_over_remaining=confirm_over_remaining,
            )
        finally:
            lock.release()

    def _reregister_order_locked(
        self,
        symbol: str,
        original_id: str,
        quantity: Any,
        price: Any,
        memo: str,
        confirmation: str,
        *,
        confirm_over_remaining: bool,
    ) -> dict[str, Any]:
        ledger_entry = self.runtime.custom_order_ledger.get(original_id)
        if ledger_entry is None or ledger_entry.get("symbol") != symbol:
            raise ValueError("사용자 지정 주문만 재등록할 수 있습니다. (자동 전략 주문이거나 존재하지 않는 주문)")

        def _already_replaced() -> str | None:
            history = self.runtime.custom_order_history.get(original_id)
            return (history or {}).get("replacement_order_id")

        existing = _already_replaced()
        if existing:
            raise ValueError(f"이미 재등록된 주문입니다. (신규 주문 ID: {existing})")

        # --- input validation (cheap, before any broker round-trip) ---
        if isinstance(quantity, bool):
            raise ValueError("수량은 1 이상의 정수여야 합니다.")
        try:
            qty = int(quantity)
        except (TypeError, ValueError):
            raise ValueError("수량은 1 이상의 정수여야 합니다.")
        if qty < 1:
            raise ValueError("수량은 1 이상의 정수여야 합니다.")
        try:
            requested_price = Decimal(str(price))
        except InvalidOperation:
            raise ValueError("지정가는 0보다 큰 유효한 소수여야 합니다.")
        if requested_price <= 0:
            raise ValueError("지정가는 0보다 커야 합니다.")
        # Reuse the same Toss order-price normalization used for every
        # strategy-computed order (mumae_core.money(), cent rounding) instead
        # of a bespoke quantize() so tick-size handling stays in one place.
        normalized_price = money(requested_price)
        if normalized_price != requested_price:
            raise ValueError(f"지정가는 {CENT} 단위(호가 단위)여야 합니다.")

        expected_confirmation = f"REREGISTER {symbol} {original_id}"
        if confirmation != expected_confirmation:
            raise PermissionError("재등록 확인 문구가 일치하지 않습니다: " + expected_confirmation)

        # --- re-sync immediately before final validation/submission: the
        # original order's status, fill quantity, ETF pause state, and cash/
        # position may all have changed since the "수정 후 재등록" dialog
        # was opened. ---
        self.sync_orders(symbol)

        existing = _already_replaced()
        if existing:
            raise ValueError(f"이미 재등록된 주문입니다. (신규 주문 ID: {existing})")

        status = self.order_statuses.get(symbol, {}).get(original_id)
        if status not in REREGISTERABLE_STATUSES:
            raise ValueError(f"취소 또는 거부된 주문만 재등록할 수 있습니다. (현재 상태: {status or '알 수 없음'})")

        original_quantity = int(ledger_entry["quantity"])
        filled_quantity, remaining_quantity = self._fill_progress(symbol, original_id, original_quantity)
        if qty > remaining_quantity and not confirm_over_remaining:
            raise ValueError(
                f"요청 수량({qty}주)이 미체결 잔여 수량({remaining_quantity}주)을 초과합니다. "
                f"(원래 수량 {original_quantity}주 · 체결 수량 {filled_quantity}주) "
                "잔여 수량을 초과해 접수하려면 다시 한번 확인해주세요."
            )

        if symbol not in self.runtime.active_symbols:
            raise PermissionError(f"{symbol}: 신규 주문이 중지된 ETF입니다. 먼저 '시작'을 눌러 재개하세요.")

        side = ledger_entry["side"]
        state = self.store.load(symbol)
        if side == "buy":
            notional = normalized_price * qty
            if notional > state.cash_usd:
                raise ValueError(
                    f"주문 가능 금액을 초과했습니다. (필요 금액: {notional}, 주문 가능 금액: {state.cash_usd})"
                )
        elif side == "sell":
            if qty > state.position_qty:
                raise ValueError(f"매도 가능 수량({state.position_qty}주)을 초과했습니다. (요청 수량: {qty}주)")

        new_id = f"{original_id}-reg-{uuid.uuid4().hex[:8]}"
        memo_text = memo.strip() if memo and memo.strip() else str(ledger_entry.get("reason", ""))
        reason = f"{memo_text} · 수정 후 재등록"
        replacement = OrderIntent(new_id, side, qty, normalized_price, OrderKind.LIMIT, reason)

        try:
            actual, response = self._submit_one(symbol, replacement)
        except (TossApiError, PermissionError, ValueError) as error:
            # Submission failed: the original order stays untouched and
            # un-replaced, so the caller can fix the input and try again.
            raise ValueError(f"재등록 주문 접수에 실패했습니다: {error}") from error

        result = response.get("result") if isinstance(response, dict) else {}
        broker_order_id = str((result or {}).get("orderId") or "")

        # Only now (broker confirmed it accepted the new order) do we record
        # the replacement -- this is the idempotency lock for future calls.
        self.runtime.broker_order_ids[new_id] = broker_order_id
        if new_id not in self.runtime.active_order_ids:
            self.runtime.active_order_ids.append(new_id)
        self.runtime.custom_order_ledger[new_id] = {
            "symbol": symbol,
            "side": side,
            "quantity": qty,
            "price": str(normalized_price),
            "reason": reason,
            "source": "reregister",
            "original_order_id": original_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self.runtime.custom_order_history[original_id] = {
            "replacement_order_id": new_id,
            "price_before": str(ledger_entry["price"]),
            "price_after": str(normalized_price),
            "quantity_before": original_quantity,
            "quantity_after": qty,
            "filled_before": filled_quantity,
            "remaining_before": remaining_quantity,
            "reregistered_at": datetime.now(timezone.utc).isoformat(),
            "is_custom_order": True,
        }
        self.runtime_store.save(self.runtime)

        synced = self.sync_orders(symbol)
        return {
            "original_order_id": original_id,
            "replacement_order_id": new_id,
            "broker_order_id": broker_order_id,
            "quantity_before": original_quantity,
            "quantity_after": qty,
            "price_before": str(ledger_entry["price"]),
            "price_after": str(normalized_price),
            "filled_before": filled_quantity,
            "remaining_before": remaining_quantity,
            **synced,
        }

    def pending_order_count(self, symbol: str) -> int:
        """Open (unfilled) broker orders for symbol, from the last sync_orders() snapshot."""
        symbol = symbol.upper()
        count = sum(1 for status in self.order_statuses.get(symbol, {}).values() if status in OPEN_STATUSES)
        count += sum(
            1 for row in self.unmatched_orders.get(symbol, {}).values()
            if str(row.get("status", "")).upper() in OPEN_STATUSES
        )
        return count

    def _record_new_order_attempt(self, symbol: str, *, error: str | None = None) -> None:
        self.runtime.last_auto_attempt_at[symbol] = datetime.now(timezone.utc).isoformat()
        if error:
            self.runtime.last_auto_error[symbol] = error
        else:
            self.runtime.last_auto_error.pop(symbol, None)
        self.runtime_store.save(self.runtime)

    def clear_last_error(self, symbol: str) -> dict[str, Any]:
        """Dismiss a symbol's last new-order error from the dashboard (e.g. a
        stale message left over from a since-fixed decoding bug)."""
        symbol = symbol.upper()
        self.runtime.last_auto_error.pop(symbol, None)
        self.runtime_store.save(self.runtime)
        return {"symbol": symbol, "last_error": ""}

    def submit_orders(self, symbol: str, item_ids: list[str], confirmation: str, *, all_pending: bool = False) -> dict[str, Any]:
        """The single entry point for all new-order submission (manual, auto-tick,
        start_auto's initial batch, and the rejected-order/price-guard replacement
        retries inside _submit_one). A symbol with new orders paused (not in
        runtime.active_symbols) is rejected here before any broker call is made."""
        symbol = symbol.upper()
        if symbol not in self.runtime.active_symbols:
            raise PermissionError(f"{symbol}: 신규 주문이 중지된 ETF입니다. 먼저 '시작'을 눌러 재개하세요.")
        try:
            result = self._submit_orders_unguarded(symbol, item_ids, confirmation, all_pending=all_pending)
        except Exception as error:
            self._record_new_order_attempt(symbol, error=str(error))
            raise
        errors = result.get("errors") or []
        self._record_new_order_attempt(symbol, error="; ".join(errors) if errors else None)
        return result

    def _submit_orders_unguarded(self, symbol: str, item_ids: list[str], confirmation: str, *, all_pending: bool = False) -> dict[str, Any]:
        symbol = symbol.upper()
        broker = self.broker()
        if broker.mode != "LIVE" or not broker.live_ack:
            raise PermissionError("Windows판과 동일하게 LIVE 모드와 실주문 확인값이 모두 필요합니다.")
        if symbol not in self.orders_synced:
            raise ValueError("토스 실제 주문현황을 먼저 동기화해야 합니다.")
        if self.unmatched_orders.get(symbol):
            raise ValueError("현재 계획과 다른 토스 OPEN 주문이 있어 추가 주문을 차단했습니다.")
        planned = self.plan_cache.get(symbol, [])
        selected = planned if all_pending else [item for item in planned if item.client_order_id in item_ids]
        expected = f"SUBMIT {symbol} {len(selected)}"
        if confirmation != expected:
            raise PermissionError("실주문 확인 문구가 일치하지 않습니다: " + expected)
        statuses = self.order_statuses.get(symbol, {})
        pending = [
            order for order in selected
            if order.client_order_id not in self.runtime.active_order_ids
            and order.client_order_id not in self.runtime.skipped_order_ids
            and statuses.get(order.client_order_id) not in CONFIRMED_STATUSES
        ]
        if not pending:
            raise ValueError("전송할 미접수 주문이 없습니다.")
        cash_available = self.store.load(symbol).cash_usd
        affordable: list[OrderIntent] = []
        running_buy_notional = Decimal("0")
        trimmed_ids: list[str] = []
        for order in pending:
            if order.side == "buy":
                running_buy_notional += (order.limit_price or Decimal("0")) * order.quantity
                if running_buy_notional > cash_available:
                    trimmed_ids.append(order.client_order_id)
                    continue
            affordable.append(order)
        if trimmed_ids:
            self.runtime.skipped_order_ids.extend(
                cid for cid in trimmed_ids if cid not in self.runtime.skipped_order_ids
            )
            self.runtime_store.save(self.runtime)
        pending = affordable
        if not pending:
            raise ValueError("현재 매수 가능 금액을 초과하여 전송할 주문이 없습니다.")
        submitted, errors = [], []
        if trimmed_ids:
            errors.append(f"매수 가능 금액 초과로 {len(trimmed_ids)}건 주문을 건너뛰었습니다: {', '.join(trimmed_ids)}")
        for order in pending:
            try:
                actual, response = self._submit_one(symbol, order)
                result = response.get("result") if isinstance(response, dict) else {}
                broker_order_id = str((result or {}).get("orderId") or "")
                if broker_order_id:
                    self.runtime.broker_order_ids[order.client_order_id] = broker_order_id
                if order.client_order_id not in self.runtime.active_order_ids:
                    self.runtime.active_order_ids.append(order.client_order_id)
                self.runtime_store.save(self.runtime)
                submitted.append({"id": actual.client_order_id, "price": str(actual.limit_price), "broker_order_id": broker_order_id})
            except (TossApiError, PermissionError, ValueError) as error:
                errors.append(f"{order.client_order_id}: {error}")
        if submitted:
            time.sleep(1)
        synced = self.sync_orders(symbol)
        confirmed = sum(1 for item in submitted if self.order_statuses.get(symbol, {}).get(item["id"]) in CONFIRMED_STATUSES)
        if submitted and confirmed == 0:
            submitted_ids = {item["id"] for item in submitted}
            self.runtime.active_order_ids = [item for item in self.runtime.active_order_ids if item not in submitted_ids]
            self.runtime_store.save(self.runtime)
            errors.append("토스 실제 OPEN/체결 주문이 확인되지 않아 자동매수를 시작하지 않았습니다.")
        return {"submitted": submitted, "confirmed": confirmed, "errors": errors, **synced}

    def start_auto(self, symbol: str, confirmation: str) -> dict[str, Any]:
        """Transition a symbol from STOPPED to RUNNING and send its initial batch.

        active_symbols is flipped on *before* calling submit_orders() so the
        single guard inside submit_orders() sees the symbol as running; if
        nothing ends up confirmed, a symbol that was not already running is
        rolled back to STOPPED so a failed start never leaves it half-active.
        """
        symbol = symbol.upper()
        was_active = symbol in self.runtime.active_symbols
        if not was_active:
            self.runtime.active_symbols.append(symbol)
        if symbol not in self.runtime.known_symbols:
            self.runtime.known_symbols.append(symbol)
        self.runtime.auto_enabled = True
        self.runtime.phase = "ACTIVE"
        self.runtime_store.save(self.runtime)
        try:
            planned = self.plan_cache.get(symbol, [])
            result = self.submit_orders(symbol, [item.client_order_id for item in planned], confirmation, all_pending=True)
            if result["confirmed"] <= 0:
                raise ValueError("토스에서 확인된 주문이 없어 자동매수를 시작하지 않았습니다.")
        except Exception:
            if not was_active:
                self.runtime.active_symbols = [item for item in self.runtime.active_symbols if item != symbol]
                self.runtime.auto_enabled = bool(self.runtime.active_symbols)
                self.runtime.phase = "ACTIVE" if self.runtime.auto_enabled else "STOPPED"
                self.runtime_store.save(self.runtime)
            raise
        return {**result, "auto_enabled": True, "active_symbols": self.runtime.active_symbols}

    def stop_auto(self, symbol: str) -> dict[str, Any]:
        """Pause new-order submission for symbol only. Never touches broker
        orders (no cancel call), and keeps the symbol in known_symbols so
        account/position/order-status polling and fill sync keep running."""
        symbol = symbol.upper()
        self.runtime.active_symbols = [item for item in self.runtime.active_symbols if item != symbol]
        self.runtime.auto_enabled = bool(self.runtime.active_symbols)
        self.runtime.phase = "ACTIVE" if self.runtime.auto_enabled else "STOPPED"
        self.runtime_store.save(self.runtime)
        return {
            "auto_enabled": self.runtime.auto_enabled,
            "active_symbols": self.runtime.active_symbols,
            "known_symbols": self.runtime.known_symbols,
        }

    def auto_tick(self) -> None:
        """Background tick: sync (account/position/order-status/fills) keeps
        running every tick for every known symbol regardless of run state.
        New-order submission runs once per market session for active
        (RUNNING) symbols, split by side: sell orders are immediate-sell
        limit orders, so they go out as soon as pre-market opens (a
        pre-market pop that fades by the regular open would otherwise be
        missed); buy orders are LOC and unaffected by timing within the day,
        so they keep waiting for auto_order_delay_minutes after the regular
        session opens."""
        if not self.runtime.known_symbols and not self.runtime.active_symbols:
            return
        now = datetime.now(timezone.utc)
        session_key = None
        regular_start = regular_end = None
        for offset in (0, 1):
            target = (now - timedelta(days=offset)).date().isoformat()
            today = self.broker().get_us_market_calendar_raw(target).get("result", {}).get("today", {})
            regular = today.get("regularMarket") or {}
            if not regular.get("startTime") or not regular.get("endTime"):
                continue
            start = datetime.fromisoformat(regular["startTime"]).astimezone(timezone.utc)
            end = datetime.fromisoformat(regular["endTime"]).astimezone(timezone.utc)
            pre_market = today.get("preMarket") or {}
            session_start = (
                datetime.fromisoformat(pre_market["startTime"]).astimezone(timezone.utc)
                if pre_market.get("startTime") else start
            )
            if session_start <= now <= end:
                regular_start, regular_end = start, end
                session_key = start.date().isoformat()
                break
        if not session_key:
            return
        known_symbols = sorted(set(self.runtime.known_symbols) | set(self.runtime.active_symbols))
        for symbol in known_symbols:
            try:
                self.refresh_account(symbol)
                self.sync_orders(symbol)
            except (TossApiError, PermissionError, ValueError) as error:
                print(f"Auto-tick sync skipped {symbol}: {error}", file=sys.stderr)
        buy_ready = regular_start + timedelta(minutes=self.runtime.auto_order_delay_minutes) <= now
        for symbol in tuple(self.runtime.active_symbols):
            planned = self.plan_cache.get(symbol, [])
            sell_ids = [item.client_order_id for item in planned if item.side == "sell"]
            buy_ids = [item.client_order_id for item in planned if item.side == "buy"]

            if self.runtime.auto_sell_attempt_keys.get(symbol) != session_key:
                self.runtime.auto_sell_attempt_keys[symbol] = session_key
                self.runtime_store.save(self.runtime)
                try:
                    self.submit_orders(symbol, sell_ids, f"SUBMIT {symbol} {len(sell_ids)}")
                except (TossApiError, PermissionError, ValueError) as error:
                    print(f"Auto-tick sell skipped {symbol}: {error}", file=sys.stderr)

            if buy_ready and self.runtime.auto_attempt_keys.get(symbol) != session_key:
                self.runtime.auto_attempt_keys[symbol] = session_key
                self.runtime_store.save(self.runtime)
                try:
                    self.submit_orders(symbol, buy_ids, f"SUBMIT {symbol} {len(buy_ids)}")
                except (TossApiError, PermissionError, ValueError) as error:
                    print(f"Auto-tick skipped {symbol}: {error}", file=sys.stderr)
                    continue
        self.runtime.last_auto_key = session_key
        self.runtime_store.save(self.runtime)
