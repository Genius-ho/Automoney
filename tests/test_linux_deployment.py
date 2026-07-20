import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class LinuxDeploymentTests(unittest.TestCase):
    def test_systemd_runs_cli_engine_without_a_browser(self):
        path = ROOT / "deploy" / "mumae.service"
        self.assertTrue(path.exists())
        service = path.read_text(encoding="utf-8")
        self.assertIn("ExecStart=/usr/bin/python3", service)
        self.assertIn("mumae_cli.py serve", service)
        self.assertNotIn("--open", service)
        self.assertIn("Restart=on-failure", service)

    def test_cli_serve_uses_the_emergency_dashboard_in_the_same_process(self):
        cli = (ROOT / "mumae_cli.py").read_text(encoding="utf-8")
        launcher = (ROOT / "web_gui" / "run_web.sh").read_text(encoding="utf-8")
        dashboard_server = (ROOT / "web_gui" / "dashboard" / "server.py").read_text(encoding="utf-8")
        self.assertIn("from web_gui.dashboard.server import run", cli)
        self.assertIn("mumae_cli.py", launcher)
        self.assertIn("EngineDashboardService(active_engine)", dashboard_server)
        self.assertIn("target=_auto_loop", dashboard_server)

    def test_environment_template_binds_to_localhost_by_default(self):
        path = ROOT / "deploy" / "mumae.env.example"
        self.assertTrue(path.exists())
        settings = path.read_text(encoding="utf-8")
        self.assertIn("MUMAE_WEB_HOST=127.0.0.1", settings)
        self.assertIn("MUMAE_MODE=DRY_RUN", settings)
        self.assertNotIn("TOSS_CLIENT_SECRET=change-me", settings)


if __name__ == "__main__":
    unittest.main()
