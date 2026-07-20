import io
import json
from decimal import Decimal
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

from mumae_core import OrderIntent, OrderKind
from toss_api import TossApiError, TossBroker


class TossRateLimitTests(unittest.TestCase):
    def test_price_limits_uses_documented_symbol_query(self):
        broker = TossBroker.__new__(TossBroker)
        broker._request = MagicMock(return_value={'result': {}})

        broker.get_price_limits_raw('SOXL')

        self.assertEqual(broker._request.call_args.args[1], '/api/v1/price-limits?symbol=SOXL')

    def test_error_string_exposes_structured_toss_error(self):
        error = TossApiError(
            'Toss API HTTP 422: '
            + json.dumps({
                'error': {
                    'requestId': 'req-1',
                    'code': 'price-out-of-range',
                    'message': 'outside',
                }
            })
        )

        self.assertEqual(error.status, 422)
        self.assertEqual(error.code, 'price-out-of-range')
        self.assertEqual(error.request_id, 'req-1')

    def test_daily_candles_support_before_cursor(self):
        broker = TossBroker.__new__(TossBroker)
        broker._request = MagicMock(return_value={"result": {"candles": []}})

        broker.get_daily_candles_raw("TQQQ", 200, before="2025-09-29T00:00:00Z")

        path = broker._request.call_args.args[1]
        self.assertIn("count=200", path)
        self.assertIn("before=2025-09-29T00%3A00%3A00Z", path)
    @patch("toss_api.time.sleep")
    def test_live_cancel_spaces_requests_by_one_second(self, mocked_sleep):
        broker = TossBroker()
        broker.mode = "LIVE"
        broker.live_ack = True
        broker.account_seq = "1"
        broker._request = MagicMock(return_value={"result": {"orderId": "order-1"}})

        broker.cancel_order("order-1")

        mocked_sleep.assert_called_once_with(1.0)
    @patch("toss_api.time.sleep")
    def test_submit_order_reuses_supplied_idempotency_id(self, mocked_sleep):
        broker = TossBroker()
        broker.mode = "LIVE"
        broker.live_ack = True
        broker.account_seq = "1"
        broker._request = MagicMock(return_value={"result": {"status": "PENDING"}})
        order = OrderIntent(
            client_order_id="default-TQQQ-20260715-first-buy",
            side="buy",
            quantity=2,
            limit_price=Decimal("79.90"),
            kind=OrderKind.CLOSE_AUCTION,
            reason="New cycle LOC",
        )

        broker.submit_order(order, "stable-request-id")
        broker.submit_order(order, "stable-request-id")

        first = json.loads(broker._request.call_args_list[0].kwargs["data"])
        second = json.loads(broker._request.call_args_list[1].kwargs["data"])
        self.assertEqual(first["clientOrderId"], "stable-request-id")
        self.assertEqual(second["clientOrderId"], "stable-request-id")
        self.assertEqual(first['timeInForce'], 'CLS')
        self.assertEqual(second['timeInForce'], 'CLS')
        self.assertEqual(mocked_sleep.call_count, 2)
    @patch("toss_api.time.sleep")
    @patch("toss_api.urlopen")
    def test_retries_429_using_retry_after(self, mocked_urlopen, mocked_sleep):
        limited = HTTPError(
            "https://example.test",
            429,
            "rate limited",
            {"Retry-After": "0.5"},
            io.BytesIO(b'{"error":{"code":"rate-limit-exceeded"}}'),
        )
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"result":"ok"}'
        mocked_urlopen.side_effect = [limited, response]

        result = TossBroker()._request("GET", "/test", include_auth=False)

        self.assertEqual(result, {"result": "ok"})
        mocked_sleep.assert_called_once_with(0.5)
        self.assertTrue(limited.closed, "handled HTTPError response must be closed")


    @patch("toss_api.urlopen")
    def test_refreshes_token_once_when_toss_rejects_cached_token(self, mocked_urlopen):
        rejected = HTTPError(
            "https://example.test",
            401,
            "unauthorized",
            {},
            io.BytesIO(b'{"error":{"code":"invalid-token"}}'),
        )
        self.addCleanup(rejected.close)
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"result":"ok"}'
        mocked_urlopen.side_effect = [rejected, response]
        broker = TossBroker()
        broker._token = MagicMock(side_effect=["cached-token", "refreshed-token"])

        result = broker._request("GET", "/test")

        self.assertEqual(result, {"result": "ok"})
        self.assertEqual(broker._token.call_count, 2)
        first_request = mocked_urlopen.call_args_list[0].args[0]
        second_request = mocked_urlopen.call_args_list[1].args[0]
        self.assertEqual(first_request.get_header("Authorization"), "Bearer cached-token")
        self.assertEqual(second_request.get_header("Authorization"), "Bearer refreshed-token")


if __name__ == "__main__":
    unittest.main()
