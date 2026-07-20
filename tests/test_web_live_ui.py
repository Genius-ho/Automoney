import unittest
from pathlib import Path


class WebLiveUiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1] / "web_gui" / "static"
        cls.html = (root / "index.html").read_text(encoding="utf-8")
        cls.javascript = (root / "app.js").read_text(encoding="utf-8")
        cls.css = (root / "styles.css").read_text(encoding="utf-8")

    def test_live_buttons_are_runtime_controlled_not_permanently_disabled(self):
        self.assertNotIn('id="submitOrders" disabled', self.html)
        self.assertNotIn('id="cancelOrders" disabled', self.html)
        self.assertNotIn('id="startAuto" disabled', self.html)

    def test_live_requests_send_csrf_to_every_live_endpoint(self):
        self.assertIn('"X-Mumae-CSRF":csrfToken', self.javascript)
        for endpoint in ("/api/orders/submit", "/api/orders/cancel", "/api/auto/start", "/api/auto/stop"):
            self.assertIn(endpoint, self.javascript)

    def test_windows_launcher_requires_password_login(self):
        script_path = Path(__file__).resolve().parents[1] / "web_gui" / "run_web.ps1"
        self.assertTrue(script_path.exists(), "secure Windows launcher is missing")
        script = script_path.read_text(encoding="utf-8")
        self.assertNotIn("MUMAE_LOCAL_AUTO_LOGIN", script)
        self.assertNotIn("MUMAE_WEB_LIVE_ACTIONS", script)
        self.assertIn("Read-Host", script)
        self.assertIn("-AsSecureString", script)
        self.assertIn("$env:MUMAE_WEB_PASSWORD", script)
        self.assertNotIn("MUMAE_WEB_PASSWORD=", script)

    def test_windows_launcher_rejects_an_occupied_port(self):
        script_path = Path(__file__).resolve().parents[1] / "web_gui" / "run_web.ps1"
        script = script_path.read_text(encoding="utf-8")
        self.assertIn("Get-NetTCPConnection", script)
        self.assertIn("OwningProcess", script)
        self.assertIn("MUMAE_WEB_PORT", script)

    def test_windows_launcher_confirms_each_new_password(self):
        script_path = Path(__file__).resolve().parents[1] / "web_gui" / "run_web.ps1"
        script = script_path.read_text(encoding="utf-8")
        self.assertGreaterEqual(script.count("Read-Host"), 2)
        self.assertGreaterEqual(script.count("-AsSecureString"), 2)
        self.assertIn("Compare-SecureBytes", script)
        self.assertIn("do not match", script)
        self.assertNotIn("$ownsWebPassword", script)
        self.assertIn("$env:MUMAE_WEB_PASSWORD = $webPassword", script)
        self.assertIn("Remove-Item Env:MUMAE_WEB_PASSWORD", script)

    def test_windows_launcher_is_safe_for_windows_powershell_5_encoding(self):
        script_path = Path(__file__).resolve().parents[1] / "web_gui" / "run_web.ps1"
        raw = script_path.read_bytes()
        self.assertTrue(
            raw.startswith(b"\xef\xbb\xbf") or raw.isascii(),
            "PowerShell 5 misreads non-ASCII UTF-8 scripts that do not have a BOM",
        )

    def test_header_action_rows_and_footer_wrap_in_narrow_windows(self):
        self.assertRegex(self.css, r".app-header{[^}]*flex-wrap:wrap")
        self.assertRegex(self.css, r".action-row{[^}]*flex-wrap:wrap")
        self.assertRegex(self.css, r"footer{[^}]*flex-wrap:wrap")

    def test_page_chrome_uses_flexible_minimum_height(self):
        self.assertNotIn(".app-header{height:58px", self.css)
        self.assertNotIn("footer{height:48px", self.css)
        self.assertNotIn(".account-alias{position:absolute", self.css)

    def test_emergency_edits_require_admin_login_and_csrf(self):
        self.assertIn("function setAdminControls(enabled)", self.javascript)
        self.assertIn("function adminRequest(path,payload)", self.javascript)
        self.assertIn('"X-Mumae-CSRF":csrfToken', self.javascript)
        self.assertIn("setAdminControls(false)", self.javascript)

    def test_windows_launcher_reuses_existing_project_data(self):
        script_path = Path(__file__).resolve().parents[1] / 'web_gui' / 'run_web.ps1'
        script = script_path.read_text(encoding='utf-8')
        self.assertIn('$env:MUMAE_DATA_DIR = $projectRoot', script)

    def test_desktop_layout_keeps_footer_in_viewport(self):
        self.assertIn('height:100dvh', self.css)
        self.assertIn('grid-template-rows:auto auto minmax(0,1fr) auto', self.css)
        self.assertIn('overflow:hidden', self.css)

    def test_web_api_settings_are_editable_after_login(self):
        self.assertIn('apiDialog', self.html)
        self.assertIn('api.update', self.javascript)
        self.assertIn('reconnectApi', self.javascript)
        self.assertNotIn('Windows판 API 설정을 사용합니다', self.javascript)

    def test_authenticated_page_reload_restores_csrf_and_controls(self):
        self.assertIn('csrfToken=data.csrf', self.javascript)
        self.assertIn('completeLogin(data)', self.javascript)

    def test_unauthenticated_page_opens_password_dialog(self):
        for identifier in ('loginDialog', 'loginForm', 'webPassword', 'loginError'):
            self.assertIn(identifier, self.html)
        self.assertIn('showLoginDialog()', self.javascript)
        self.assertNotIn('prompt("웹 관리 비밀번호를 입력하세요.")', self.javascript)

    def test_authenticated_session_auto_connects_saved_toss_api(self):
        self.assertIn('async function completeLogin(data)', self.javascript)
        self.assertIn('await loadApiSettings()', self.javascript)
        self.assertIn('await refreshAccount()', self.javascript)
        self.assertIn('loginDialog.close()', self.javascript)

    def test_every_request_explicitly_includes_session_credentials(self):
        self.assertIn('credentials:"include"', self.javascript)

    def test_expired_session_reopens_login_instead_of_silently_failing(self):
        self.assertIn('response.status===403', self.javascript)
        self.assertIn('csrfToken=""', self.javascript)
        self.assertIn('showLoginDialog(payload.error', self.javascript)

    def test_web_launchers_start_the_single_cli_engine(self):
        root = Path(__file__).resolve().parents[1] / "web_gui"
        powershell = (root / "run_web.ps1").read_text(encoding="utf-8")
        shell = (root / "run_web.sh").read_text(encoding="utf-8")
        self.assertIn("mumae_cli.py", powershell)
        self.assertIn("mumae_cli.py", shell)
        self.assertIn("serve", powershell)
        self.assertIn("serve", shell)
        self.assertNotIn("dashboard\\server.py", powershell)
        self.assertNotIn("dashboard/server.py", shell)


    def test_web_api_settings_load_saved_non_secret_fields(self):
        self.assertIn("command:'api.settings'", self.javascript)
        self.assertIn("fillApiSettings(settings)", self.javascript)
        self.assertIn("settings.client_id", self.javascript)
        self.assertIn("settings.account_seq", self.javascript)
        self.assertIn("settings.live_trading", self.javascript)
        self.assertIn("settings.secret_configured", self.javascript)
        self.assertNotIn("settings.client_secret", self.javascript)

    def test_direct_web_server_defaults_to_the_shared_data_directory(self):
        server_path = Path(__file__).resolve().parents[1] / "web_gui" / "server.py"
        server = server_path.read_text(encoding="utf-8")
        self.assertIn('os.getenv("MUMAE_DATA_DIR"', server)
        self.assertIn("PROJECT_ROOT", server)

if __name__ == "__main__":
    unittest.main()
