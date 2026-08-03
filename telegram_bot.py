"""Small dependency-free Telegram notifier and retry command poller."""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from local_env import load_env


class TelegramApiError(RuntimeError):
    """The Telegram Bot API rejected or could not complete a request."""


class TelegramNotifier:
    def __init__(
        self,
        bot_token: str | None = None,
        chat_id: str | None = None,
        *,
        opener: Callable[..., Any] = urlopen,
    ) -> None:
        load_env()
        self.bot_token = str(bot_token or os.getenv("MUMAE_TELEGRAM_BOT_TOKEN", "")).strip()
        self.chat_id = str(chat_id or os.getenv("MUMAE_TELEGRAM_CHAT_ID", "")).strip()
        self._opener = opener

    @property
    def enabled(self) -> bool:
        return bool(self.bot_token and self.chat_id)

    def _call(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            return {}
        request = Request(
            f"https://api.telegram.org/bot{self.bot_token}/{method}",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self._opener(request, timeout=30) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as error:
            # Do not include error.geturl(): it contains the bot token.
            raise TelegramApiError(f"Telegram HTTP 요청 실패({error.code})") from error
        except URLError as error:
            raise TelegramApiError(f"Telegram 연결 실패: {error.reason}") from error
        except OSError as error:
            raise TelegramApiError(f"Telegram 요청 실패: {error}") from error
        try:
            result = json.loads(raw)
        except json.JSONDecodeError as error:
            raise TelegramApiError("Telegram 응답을 해석하지 못했습니다.") from error
        if not result.get("ok"):
            description = str(result.get("description") or "알 수 없는 Telegram 오류")
            raise TelegramApiError(description)
        return result

    def send_message(
        self,
        text: str,
        *,
        reply_markup: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"chat_id": self.chat_id, "text": str(text)}
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        return self._call("sendMessage", payload)

    def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"callback_query_id": str(callback_query_id)}
        if text:
            payload["text"] = str(text)
        return self._call("answerCallbackQuery", payload)

    def get_updates(self, offset: int | None = None, timeout: int = 20) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {
            "timeout": int(timeout),
            "allowed_updates": ["message", "callback_query"],
        }
        if offset is not None:
            payload["offset"] = int(offset)
        result = self._call("getUpdates", payload)
        updates = result.get("result", [])
        return updates if isinstance(updates, list) else []


class TelegramCommandLoop:
    """Long-poll Telegram messages and dispatch the narrow /retry command."""

    def __init__(
        self,
        engine: Any,
        notifier: TelegramNotifier,
        *,
        poll_timeout: int = 20,
        clock: Callable[[], float] = time.monotonic,
        price_prompt_ttl: float = 300.0,
    ) -> None:
        self.engine = engine
        self.notifier = notifier
        self.poll_timeout = poll_timeout
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None
        self._offset = int(getattr(engine.runtime, "telegram_update_offset", 0) or 0)
        self._clock = clock
        self._price_prompt_ttl = float(price_prompt_ttl)
        self._pending_price_order_id: str | None = None
        self._pending_price_prompt_id: int | None = None
        self._pending_price_expires_at = 0.0

    def _clear_pending_price(self) -> None:
        self._pending_price_order_id = None
        self._pending_price_prompt_id = None
        self._pending_price_expires_at = 0.0

    def start(self) -> threading.Thread | None:
        if not self.notifier.enabled:
            return None
        if self._thread and self._thread.is_alive():
            return self._thread
        if self._offset == 0:
            # Do not execute a stale /retry message that was sent before the
            # bot was enabled or while the service was stopped. Commands must
            # be sent after the current process has started.
            try:
                backlog = self.notifier.get_updates(offset=None, timeout=0)
                update_ids = [item.get("update_id") for item in backlog if isinstance(item.get("update_id"), int)]
                if update_ids:
                    self._offset = max(update_ids) + 1
                    self.engine.runtime.telegram_update_offset = self._offset
                    self.engine.runtime_store.save(self.engine.runtime)
            except TelegramApiError as error:
                print(f"Telegram 초기화 실패: {error}", file=sys.stderr)
        self._stopped.clear()
        self._thread = threading.Thread(target=self.run, name="mumae-telegram", daemon=True)
        self._thread.start()
        return self._thread

    def stop(self) -> None:
        self._stopped.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

    def _send(self, text: str, reply_markup: dict[str, Any] | None = None) -> dict[str, Any] | None:
        try:
            if reply_markup is None:
                # Keep compatibility with lightweight test/dry-run notifiers.
                return self.notifier.send_message(text)
            return self.notifier.send_message(text, reply_markup=reply_markup)
        except TelegramApiError as error:
            print(f"Telegram 알림 실패: {error}", file=sys.stderr)
            return None

    def _answer_callback(self, callback_query_id: str, text: str | None = None) -> None:
        try:
            self.notifier.answer_callback_query(callback_query_id, text)
        except (AttributeError, TelegramApiError) as error:
            print(f"Telegram 버튼 응답 실패: {error}", file=sys.stderr)

    @staticmethod
    def retry_keyboard(client_order_ids: list[str]) -> dict[str, Any]:
        rows = []
        for client_order_id in client_order_ids:
            client_order_id = str(client_order_id)
            rows.append([
                {
                    "text": "🔁 그대로 재시도",
                    "callback_data": f"retry:{client_order_id}",
                },
                {
                    "text": "💲 가격 수정 후 재시도",
                    "callback_data": f"price_retry:{client_order_id}",
                },
            ])
        return {"inline_keyboard": rows}

    def _dispatch_retry(self, client_order_id: str, price: str | None = None) -> bool:
        command = "order.retry_failed_price" if price is not None else "order.retry_failed"
        payload: dict[str, Any] = {"client_order_id": client_order_id}
        if price is not None:
            payload["price"] = price
        try:
            result = self.engine.execute(
                command,
                payload,
                source="TELEGRAM",
                actor=f"telegram-{self.notifier.chat_id}",
            )
            confirmed = int(result.get("confirmed") or 0)
            if confirmed:
                if price is None:
                    self._send(f"✅ 재시도 접수 성공\n{client_order_id}\n토스 상태: 확인됨")
                else:
                    self._send(
                        f"✅ 가격 수정 후 재시도 접수 성공\n{client_order_id}\n새 지정가: ${price}"
                    )
                return True
            errors = "; ".join(str(item) for item in result.get("errors") or [])
            self._send(
                f"❌ 재시도 실패\n{client_order_id}\n"
                f"{errors or '토스에서 접수 상태를 확인하지 못했습니다.'}",
                self.retry_keyboard([client_order_id]),
            )
        except Exception as error:
            self._send(
                f"❌ 재시도 실패\n{client_order_id}\n{error}",
                self.retry_keyboard([client_order_id]),
            )
        return False

    def _handle_callback_query(self, callback_query: dict[str, Any]) -> None:
        callback_message = callback_query.get("message") or {}
        chat = callback_message.get("chat") or {}
        if str(chat.get("id") or "") != self.notifier.chat_id:
            return
        callback_id = str(callback_query.get("id") or "")
        data = str(callback_query.get("data") or "")
        if callback_id:
            self._answer_callback(callback_id)
        if data.startswith("retry:"):
            self._clear_pending_price()
            self._dispatch_retry(data.removeprefix("retry:"))
            return
        if data.startswith("price_retry:"):
            self._pending_price_order_id = data.removeprefix("price_retry:")
            response = self._send(
                "새 지정가를 숫자로 보내주세요. 예: 65.25\n취소하려면 /cancel 을 보내세요.",
                {"force_reply": True, "input_field_placeholder": "예: 65.25"},
            )
            result = response.get("result", {}) if isinstance(response, dict) else {}
            prompt_id = result.get("message_id")
            if not isinstance(prompt_id, int):
                self._clear_pending_price()
                return
            self._pending_price_prompt_id = prompt_id
            self._pending_price_expires_at = self._clock() + self._price_prompt_ttl

    def handle_update(self, update: dict[str, Any]) -> None:
        callback_query = update.get("callback_query") or {}
        if callback_query:
            self._handle_callback_query(callback_query)
            return
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        if str(chat.get("id") or "") != self.notifier.chat_id:
            return
        text = str(message.get("text") or "").strip()
        if not text:
            return
        if self._pending_price_order_id and text.lower() in {"/cancel", "취소"}:
            self._clear_pending_price()
            self._send("가격 수정 재시도를 취소했습니다.")
            return
        if self._pending_price_order_id and not text.startswith("/"):
            if self._clock() > self._pending_price_expires_at:
                self._clear_pending_price()
                self._send("가격 수정 요청이 만료됐습니다. 실패 알림의 버튼을 다시 눌러주세요.")
                return
            reply = message.get("reply_to_message") or {}
            if reply.get("message_id") != self._pending_price_prompt_id:
                self._send("가격은 방금 보낸 가격 요청 메시지에 답장으로 보내주세요.")
                return
            client_order_id = self._pending_price_order_id
            if self._dispatch_retry(client_order_id, text):
                self._clear_pending_price()
            return
        parts = text.split()
        command = parts[0].split("@", 1)[0].lower()
        if command in {"/start", "/help"}:
            self._send("사용법: /retry 주문ID 또는 실패 알림의 버튼을 누르세요.")
            return
        if command != "/retry":
            return
        if len(parts) != 2:
            self._send("사용법: /retry 주문ID")
            return
        client_order_id = parts[1]
        self._dispatch_retry(client_order_id)

    def _process_updates(self, updates: list[dict[str, Any]]) -> None:
        for update in updates:
            try:
                self.handle_update(update)
            except Exception as error:
                # A malformed update or an unexpected handler bug must not kill
                # the daemon thread and silently disable all future alerts.
                print(f"Telegram 업데이트 처리 실패: {error}", file=sys.stderr)
            finally:
                update_id = update.get("update_id")
                if isinstance(update_id, int):
                    self._offset = max(self._offset, update_id + 1)
                    self.engine.runtime.telegram_update_offset = self._offset
                    try:
                        self.engine.runtime_store.save(self.engine.runtime)
                    except Exception as error:
                        print(f"Telegram 업데이트 위치 저장 실패: {error}", file=sys.stderr)

    def run(self) -> None:
        while not self._stopped.is_set():
            try:
                updates = self.notifier.get_updates(self._offset, timeout=self.poll_timeout)
            except TelegramApiError as error:
                print(f"Telegram 수신 실패: {error}", file=sys.stderr)
                self._stopped.wait(5)
                continue
            self._process_updates(updates)


__all__ = ["TelegramApiError", "TelegramCommandLoop", "TelegramNotifier"]
