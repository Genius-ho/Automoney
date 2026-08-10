import unittest
from decimal import Decimal
from unittest.mock import MagicMock

from kiwoom.kiwoom_api import BASE_URL_LIVE, BASE_URL_MOCK, KiwoomApiError, KiwoomBroker


def _broker(**overrides) -> KiwoomBroker:
    broker = KiwoomBroker.__new__(KiwoomBroker)
    broker.app_key = overrides.get("app_key", "test-key")
    broker.app_secret = overrides.get("app_secret", "test-secret")
    broker.account_no = overrides.get("account_no", "1234")
    broker.mode = overrides.get("mode", "MOCK")
    broker.live_ack = overrides.get("live_ack", False)
    broker._access_token = None
    broker._token_expires_at = 0.0
    return broker


class BaseUrlTests(unittest.TestCase):
    def test_defaults_to_mock_endpoint(self):
        broker = _broker(mode="MOCK")
        self.assertEqual(broker.base_url, BASE_URL_MOCK)

    def test_live_mode_uses_live_endpoint(self):
        broker = _broker(mode="LIVE")
        self.assertEqual(broker.base_url, BASE_URL_LIVE)


class TokenTests(unittest.TestCase):
    def test_requests_a_client_credentials_token_without_auth_header(self):
        broker = _broker()
        broker._call = MagicMock(return_value={"token": "abc123", "expires_dt": "20990101000000"})

        token = broker._token()

        self.assertEqual(token, "abc123")
        call = broker._call.call_args
        self.assertEqual(call.args[:2], ("POST", "/oauth2/token"))
        self.assertFalse(call.kwargs["include_auth"])
        import json
        payload = json.loads(call.kwargs["data"])
        self.assertEqual(payload, {"grant_type": "client_credentials", "appkey": "test-key", "secretkey": "test-secret"})

    def test_caches_the_token_until_near_expiry(self):
        broker = _broker()
        broker._call = MagicMock(return_value={"token": "abc123", "expires_dt": "20990101000000"})

        broker._token()
        broker._token()

        self.assertEqual(broker._call.call_count, 1)

    def test_missing_credentials_raises_before_any_request(self):
        broker = _broker(app_key="", app_secret="")
        broker._call = MagicMock()

        with self.assertRaises(KiwoomApiError):
            broker._token()
        broker._call.assert_not_called()

    def test_missing_token_in_response_raises(self):
        broker = _broker()
        broker._call = MagicMock(return_value={})

        with self.assertRaises(KiwoomApiError):
            broker._token()


class LiveSafetyGuardTests(unittest.TestCase):
    def test_mock_mode_submit_order_never_touches_the_network(self):
        broker = _broker(mode="MOCK")
        broker._call = MagicMock()

        result = broker.submit_us_order("TQQQ", "buy", 1, Decimal("60.00"))

        self.assertEqual(result["status"], "MOCK")
        broker._call.assert_not_called()

    def test_live_mode_without_ack_is_blocked(self):
        broker = _broker(mode="LIVE", live_ack=False)

        with self.assertRaises(PermissionError):
            broker.submit_us_order("TQQQ", "buy", 1, Decimal("60.00"))

    def test_live_mode_with_ack_hits_the_unimplemented_guard_not_a_silent_no_op(self):
        broker = _broker(mode="LIVE", live_ack=True)

        with self.assertRaises(NotImplementedError):
            broker.submit_us_order("TQQQ", "buy", 1, Decimal("60.00"))

    def test_cancel_order_follows_the_same_guard_order(self):
        broker = _broker(mode="LIVE", live_ack=False)

        with self.assertRaises(PermissionError):
            broker.cancel_order("some-id")


class UnimplementedEndpointTests(unittest.TestCase):
    def test_getters_raise_not_implemented_rather_than_guessing_a_response(self):
        broker = _broker()
        for method, args in (
            (broker.get_us_prices_raw, (["TQQQ"],)),
            (broker.get_us_daily_candles_raw, ("TQQQ",)),
            (broker.get_us_holdings_raw, ()),
            (broker.get_us_buying_power_raw, ()),
        ):
            with self.assertRaises(NotImplementedError):
                method(*args)


if __name__ == "__main__":
    unittest.main()
