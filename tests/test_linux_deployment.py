import json
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from deploy.systemd_installer import render_unit


ROOT = Path(__file__).resolve().parents[1]


class LinuxDeploymentTests(unittest.TestCase):
    def test_systemd_runs_cli_engine_without_a_browser(self):
        path = ROOT / "deploy" / "systemd" / "mumae.service.in"
        self.assertTrue(path.exists())
        service = render_unit(
            path.read_text(encoding="utf-8"),
            Path("/srv/renamed Mumae"),
        )
        self.assertIn("ExecStart=/usr/bin/python3", service)
        self.assertIn('"/srv/renamed Mumae/mumae_cli.py" serve', service)
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

    def test_environment_data_path_follows_the_generated_working_directory(self):
        settings = {}
        for line in (ROOT / "deploy" / "mumae.env.example").read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                settings[key] = value

        relocated_root = Path("/srv/renamed Mumae")
        resolved_data = relocated_root / settings["MUMAE_DATA_DIR"]

        self.assertEqual(resolved_data, Path("/srv/renamed Mumae/data"))

    def test_installer_launcher_passes_its_own_checkout_root_from_any_cwd(self):
        with TemporaryDirectory() as raw:
            temporary = Path(raw)
            checkout = temporary / "renamed Mumae checkout"
            deploy = checkout / "deploy"
            deploy.mkdir(parents=True)
            launcher = deploy / "install-systemd.sh"
            shutil.copy2(ROOT / "deploy" / "install-systemd.sh", launcher)
            (deploy / "systemd_installer.py").write_text(
                "import json, sys\nprint(json.dumps(sys.argv[1:]))\n",
                encoding="utf-8",
            )

            completed = subprocess.run(
                [str(launcher), "--check"],
                cwd=temporary,
                check=True,
                text=True,
                capture_output=True,
            )

        arguments = json.loads(completed.stdout)
        root_index = arguments.index("--project-root") + 1
        self.assertEqual(Path(arguments[root_index]).resolve(), checkout.resolve())
        self.assertIn("--check", arguments)


if __name__ == "__main__":
    unittest.main()
