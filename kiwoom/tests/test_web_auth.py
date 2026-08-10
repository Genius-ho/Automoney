import os
import unittest
from unittest.mock import patch

from kiwoom.web.web_auth import COOKIE_NAME, WebAuth


class WebAuthTests(unittest.TestCase):
    def test_status_only_reports_password_sessions(self):
        with patch.dict(os.environ, {"KIWOOM_WEB_PASSWORD": "secret"}, clear=True):
            auth = WebAuth()
            status = auth.status(None)
            self.assertFalse(status["authenticated"])

    def test_login_rejects_wrong_password(self):
        with patch.dict(os.environ, {"KIWOOM_WEB_PASSWORD": "secret"}, clear=True):
            auth = WebAuth()
            with self.assertRaises(PermissionError):
                auth.login("wrong")

    def test_status_restores_csrf_for_authenticated_session(self):
        with patch.dict(os.environ, {"KIWOOM_WEB_PASSWORD": "secret"}, clear=True):
            auth = WebAuth()
            token, csrf = auth.login("secret")
            status = auth.status(f"{COOKIE_NAME}=" + token)
            self.assertTrue(status["authenticated"])
            self.assertEqual(status["csrf"], csrf)

    def test_validate_requires_explicit_live_flag(self):
        with patch.dict(os.environ, {"KIWOOM_WEB_PASSWORD": "secret"}, clear=True):
            auth = WebAuth()
            token, csrf = auth.login("secret")
            with self.assertRaises(PermissionError):
                auth.validate(f"{COOKIE_NAME}=" + token, csrf, live=True)

    def test_uses_a_distinct_cookie_name_from_the_main_toss_web_gui(self):
        self.assertNotEqual(COOKIE_NAME, "mumae_session")

    def test_logout_invalidates_the_session(self):
        with patch.dict(os.environ, {"KIWOOM_WEB_PASSWORD": "secret"}, clear=True):
            auth = WebAuth()
            token, csrf = auth.login("secret")
            auth.logout(f"{COOKIE_NAME}=" + token)
            with self.assertRaises(PermissionError):
                auth.validate(f"{COOKIE_NAME}=" + token, csrf)


if __name__ == "__main__":
    unittest.main()
