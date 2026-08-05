import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from telegram_bot import TelegramCommandLoop, TelegramNotifier


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class _RecordingOpener:
    def __init__(self):
        self.request = None

    def __call__(self, request, timeout):
        self.request = request
        return _FakeResponse({"ok": True, "result": {"message_id": 1}})


class TelegramNotifierTests(unittest.TestCase):
    def test_send_message_posts_to_configured_chat(self):
        opener = _RecordingOpener()
        notifier = TelegramNotifier("bot-token", "12345", opener=opener)

        notifier.send_message("주문 접수 성공")

        self.assertIn("/botbot-token/sendMessage", opener.request.full_url)
        payload = json.loads(opener.request.data.decode("utf-8"))
        self.assertEqual(payload, {"chat_id": "12345", "text": "주문 접수 성공"})

    def test_send_message_supports_inline_keyboard(self):
        opener = _RecordingOpener()
        notifier = TelegramNotifier("bot-token", "12345", opener=opener)
        markup = {"inline_keyboard": [[{"text": "가격 수정", "callback_data": "price_retry:order-1"}]]}

        notifier.send_message("주문 실패", reply_markup=markup)

        payload = json.loads(opener.request.data.decode("utf-8"))
        self.assertEqual(payload["reply_markup"], markup)

    def test_command_loop_dispatches_retry_only_for_allowed_chat(self):
        class Engine:
            runtime = SimpleNamespace(telegram_update_offset=0)

            def __init__(self):
                self.calls = []

            def execute(self, command, payload, *, source, actor):
                self.calls.append((command, payload, source, actor))
                return {"retried": payload["client_order_id"], "confirmed": 1}

        class Notifier:
            chat_id = "12345"
            enabled = True

            def __init__(self):
                self.messages = []
                self.markups = []
                self.answered = []

            def send_message(self, text, **kwargs):
                self.messages.append(text)

            def answer_callback_query(self, callback_query_id, text=None):
                self.answered.append((callback_query_id, text))

        engine = Engine()
        notifier = Notifier()
        loop = TelegramCommandLoop(engine, notifier)

        loop.handle_update({
            "update_id": 10,
            "message": {
                "chat": {"id": 12345},
                "text": "/retry default-SOXL-20260804-star-buy",
            },
        })
        loop.handle_update({
            "update_id": 11,
            "message": {
                "chat": {"id": 99999},
                "text": "/retry default-SOXL-20260804-avg-buy",
            },
        })

        self.assertEqual(len(engine.calls), 1)
        self.assertEqual(engine.calls[0][0], "order.retry_failed")
        self.assertEqual(engine.calls[0][1]["client_order_id"], "default-SOXL-20260804-star-buy")
        self.assertTrue(any("재시도" in message for message in notifier.messages))

    def test_price_button_prompts_for_price_and_submits_changed_price(self):
        class Engine:
            runtime = SimpleNamespace(telegram_update_offset=0)

            def __init__(self):
                self.calls = []

            def execute(self, command, payload, *, source, actor):
                self.calls.append((command, payload, source, actor))
                return {"retried": payload["client_order_id"], "confirmed": 1, "price": payload.get("price")}

        class Notifier:
            chat_id = "12345"
            enabled = True

            def __init__(self):
                self.messages = []
                self.markups = []
                self.answered = []

            def send_message(self, text, **kwargs):
                self.messages.append(text)
                self.markups.append(kwargs.get("reply_markup"))
                return {"result": {"message_id": 900}}

            def answer_callback_query(self, callback_query_id, text=None):
                self.answered.append((callback_query_id, text))

        engine = Engine()
        notifier = Notifier()
        loop = TelegramCommandLoop(engine, notifier)
        client_order_id = "default-SOXL-20260804-star-buy"

        loop.handle_update({
            "update_id": 20,
            "callback_query": {
                "id": "callback-1",
                "message": {"chat": {"id": 12345}},
                "data": f"price_retry:{client_order_id}",
            },
        })
        loop.handle_update({
            "update_id": 21,
            "message": {
                "chat": {"id": 12345},
                "text": "65.25",
                "reply_to_message": {"message_id": 900},
            },
        })

        self.assertEqual(notifier.answered, [("callback-1", None)])
        self.assertIn("새 지정가", notifier.messages[0])
        self.assertEqual(engine.calls[0][0], "order.retry_failed_price")
        self.assertEqual(engine.calls[0][1], {"client_order_id": client_order_id, "price": "65.25"})
        self.assertIn("가격 수정 후 재시도 접수 성공", notifier.messages[-1])

    def test_qty_button_prompts_for_quantity_and_submits_changed_quantity(self):
        class Engine:
            runtime = SimpleNamespace(telegram_update_offset=0)

            def __init__(self):
                self.calls = []

            def execute(self, command, payload, *, source, actor):
                self.calls.append((command, payload, source, actor))
                return {"retried": payload["client_order_id"], "confirmed": 1, "quantity": payload.get("quantity")}

        class Notifier:
            chat_id = "12345"
            enabled = True

            def __init__(self):
                self.messages = []
                self.markups = []
                self.answered = []

            def send_message(self, text, **kwargs):
                self.messages.append(text)
                self.markups.append(kwargs.get("reply_markup"))
                return {"result": {"message_id": 900}}

            def answer_callback_query(self, callback_query_id, text=None):
                self.answered.append((callback_query_id, text))

        engine = Engine()
        notifier = Notifier()
        loop = TelegramCommandLoop(engine, notifier)
        client_order_id = "default-SOXL-20260804-star-buy"

        loop.handle_update({
            "update_id": 20,
            "callback_query": {
                "id": "callback-1",
                "message": {"chat": {"id": 12345}},
                "data": f"qty_retry:{client_order_id}",
            },
        })
        loop.handle_update({
            "update_id": 21,
            "message": {
                "chat": {"id": 12345},
                "text": "3",
                "reply_to_message": {"message_id": 900},
            },
        })

        self.assertEqual(notifier.answered, [("callback-1", None)])
        self.assertIn("새 수량", notifier.messages[0])
        self.assertEqual(engine.calls[0][0], "order.retry_failed_quantity")
        self.assertEqual(engine.calls[0][1], {"client_order_id": client_order_id, "quantity": "3"})
        self.assertIn("수량 수정 후 재시도 접수 성공", notifier.messages[-1])

    def test_price_retry_ignores_text_that_is_not_a_reply_to_its_prompt(self):
        class Engine:
            runtime = SimpleNamespace(telegram_update_offset=0)

            def __init__(self):
                self.calls = []

            def execute(self, command, payload, *, source, actor):
                self.calls.append((command, payload))
                return {"confirmed": 1}

        class Notifier:
            chat_id = "12345"
            enabled = True

            def __init__(self):
                self.messages = []

            def send_message(self, text, **kwargs):
                self.messages.append(text)
                return {"result": {"message_id": 900}}

            def answer_callback_query(self, callback_query_id, text=None):
                return None

        engine = Engine()
        notifier = Notifier()
        loop = TelegramCommandLoop(engine, notifier)
        loop.handle_update({
            "callback_query": {
                "id": "callback-2",
                "message": {"chat": {"id": 12345}},
                "data": "price_retry:default-SOXL-20260803-star-buy",
            },
        })

        loop.handle_update({"message": {"chat": {"id": 12345}, "text": "65.25"}})

        self.assertEqual(engine.calls, [])
        self.assertIn("답장", notifier.messages[-1])

    def test_price_retry_prompt_expires_before_a_late_numeric_reply(self):
        class Engine:
            runtime = SimpleNamespace(telegram_update_offset=0)

            def __init__(self):
                self.calls = []

            def execute(self, command, payload, *, source, actor):
                self.calls.append((command, payload))
                return {"confirmed": 1}

        class Notifier:
            chat_id = "12345"
            enabled = True

            def __init__(self):
                self.messages = []

            def send_message(self, text, **kwargs):
                self.messages.append(text)
                return {"result": {"message_id": 901}}

            def answer_callback_query(self, callback_query_id, text=None):
                return None

        now = [100.0]
        engine = Engine()
        notifier = Notifier()
        loop = TelegramCommandLoop(engine, notifier, clock=lambda: now[0], price_prompt_ttl=300)
        loop.handle_update({
            "callback_query": {
                "id": "callback-3",
                "message": {"chat": {"id": 12345}},
                "data": "price_retry:default-SOXL-20260803-star-buy",
            },
        })
        now[0] = 401.0

        loop.handle_update({
            "message": {
                "chat": {"id": 12345},
                "text": "65.25",
                "reply_to_message": {"message_id": 901},
            },
        })

        self.assertEqual(engine.calls, [])
        self.assertIn("만료", notifier.messages[-1])

    def test_one_bad_update_does_not_stop_later_updates_or_offset_progress(self):
        class Store:
            def __init__(self):
                self.saved_offsets = []

            def save(self, runtime):
                self.saved_offsets.append(runtime.telegram_update_offset)

        engine = SimpleNamespace(
            runtime=SimpleNamespace(telegram_update_offset=0),
            runtime_store=Store(),
        )
        notifier = SimpleNamespace(chat_id="12345", enabled=True)
        loop = TelegramCommandLoop(engine, notifier)
        loop.handle_update = Mock(side_effect=[RuntimeError("bad update"), None])

        loop._process_updates([{"update_id": 10}, {"update_id": 11}])

        self.assertEqual(loop.handle_update.call_count, 2)
        self.assertEqual(engine.runtime.telegram_update_offset, 12)
        self.assertEqual(engine.runtime_store.saved_offsets, [11, 12])


if __name__ == "__main__":
    unittest.main()
