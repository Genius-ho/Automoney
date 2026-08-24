import unittest
import subprocess
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from deploy.systemd_installer import (
    PROJECT_ROOT_TOKEN,
    UNIT_NAMES,
    install_units,
    main,
    render_unit,
    render_units,
    validate_service_access,
    validate_project,
)


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = ROOT / "deploy" / "systemd"


def make_complete_project_fixture(testcase: unittest.TestCase) -> Path:
    temporary = TemporaryDirectory()
    testcase.addCleanup(temporary.cleanup)
    root = Path(temporary.name) / "renamed project"
    (root / "deploy" / "systemd").mkdir(parents=True)
    (root / ".venv" / "bin").mkdir(parents=True)
    for relative in (
        "mumae_cli.py",
        "candle_logger.py",
        "backtest_indicator_sweep.py",
        ".venv/bin/python",
    ):
        path = root / relative
        path.write_text("# fixture\n", encoding="utf-8")
        if relative == ".venv/bin/python":
            path.chmod(0o755)
    (root / "deploy" / "mumae.env").write_text("MUMAE_MODE=DRY_RUN\n", encoding="utf-8")
    for name in UNIT_NAMES:
        source = TEMPLATE_DIR / f"{name}.in"
        destination = root / "deploy" / "systemd" / f"{name}.in"
        destination.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
    for name in ("mumae-candle-logger.timer", "mumae-backtest-notify.timer"):
        destination = root / "deploy" / name
        destination.write_text(
            (ROOT / "deploy" / name).read_text(encoding="utf-8"),
            encoding="utf-8",
        )
    return root


def make_existing_unit_fixture(testcase: unittest.TestCase, root: Path) -> Path:
    unit_dir = root / "installed"
    unit_dir.mkdir()
    for name in UNIT_NAMES:
        (unit_dir / name).write_text(f"old {name}\n", encoding="utf-8")
    return unit_dir


class SystemdRenderingTests(unittest.TestCase):
    def test_render_unit_supports_renamed_path_with_spaces_and_percent(self):
        root = Path("/srv/Mumae Live 100%")

        rendered = render_unit(
            "WorkingDirectory=@MUMAE_PROJECT_ROOT@\n"
            "ExecStart=/usr/bin/python3 @MUMAE_PROJECT_ROOT@/mumae_cli.py serve\n",
            root,
        )

        self.assertIn(r"WorkingDirectory=/srv/Mumae\x20Live\x20100%%", rendered)
        self.assertIn(r"/srv/Mumae\x20Live\x20100%%/mumae_cli.py", rendered)
        self.assertNotIn(PROJECT_ROOT_TOKEN, rendered)

    def test_render_unit_rejects_a_template_without_the_project_root_token(self):
        with self.assertRaisesRegex(ValueError, "project-root token"):
            render_unit("[Service]\nType=simple\n", Path("/srv/mumae"))

    def test_render_unit_rejects_control_characters_in_the_project_path(self):
        for control_character in ("\n", "\x7f", "\x85"):
            with self.subTest(codepoint=ord(control_character)):
                with self.assertRaisesRegex(ValueError, "control character"):
                    render_unit(
                        PROJECT_ROOT_TOKEN,
                        Path(f"/srv/mumae{control_character}other"),
                    )

    def test_all_templates_render_for_unrelated_roots(self):
        with TemporaryDirectory() as raw:
            parent = Path(raw)
            first_root = parent / "first checkout"
            second_root = parent / "renamed checkout"
            first_root.mkdir()
            second_root.mkdir()

            first = render_units(first_root, TEMPLATE_DIR)
            second = render_units(second_root, TEMPLATE_DIR)

        self.assertEqual(set(first), set(UNIT_NAMES))
        first_rendered_root = f"{parent}/first\\x20checkout"
        second_rendered_root = f"{parent}/renamed\\x20checkout"
        for name in UNIT_NAMES:
            self.assertIn(first_rendered_root, first[name])
            self.assertNotIn(first_rendered_root, second[name])
            self.assertIn(second_rendered_root, second[name])


class InstallerPreflightTests(unittest.TestCase):
    def test_missing_required_file_fails_before_commands_or_writes(self):
        with TemporaryDirectory() as raw:
            root = Path(raw)
            unit_dir = root / "units"
            calls: list[list[str]] = []

            with self.assertRaisesRegex(FileNotFoundError, "mumae_cli.py"):
                install_units(
                    root,
                    unit_dir,
                    check_only=False,
                    restart=True,
                    command_runner=lambda args: calls.append(list(args)),
                )

            self.assertEqual(calls, [])
            self.assertFalse(unit_dir.exists())

    def test_validate_project_returns_the_resolved_checkout(self):
        root = make_complete_project_fixture(self)

        self.assertEqual(validate_project(root / "deploy" / ".."), root.resolve())

    def test_root_preflight_checks_access_as_the_service_user(self):
        root = make_complete_project_fixture(self)
        calls: list[list[str]] = []

        def deny_environment_file(args):
            command = list(args)
            calls.append(command)
            if command[-2:] == ["-r", str(root / "deploy" / "mumae.env")]:
                raise subprocess.CalledProcessError(1, command)

        with self.assertRaisesRegex(PermissionError, "service user ho"):
            validate_service_access(
                root,
                include_data=False,
                geteuid=lambda: 0,
                command_runner=deny_environment_file,
            )

        self.assertTrue(all(call[:3] == ["runuser", "--user", "ho"] for call in calls))

    def test_check_mode_verifies_units_without_persistent_writes_or_systemctl(self):
        root = make_complete_project_fixture(self)
        unit_dir = root / "not-created"
        calls: list[list[str]] = []

        with patch("deploy.systemd_installer.shutil.which", return_value="/usr/bin/systemd-analyze"):
            install_units(
                root,
                unit_dir,
                check_only=True,
                restart=True,
                command_runner=lambda args: calls.append(list(args)),
            )

        self.assertTrue(any(call[:2] == ["systemd-analyze", "verify"] for call in calls))
        self.assertFalse(any(call[0] == "systemctl" for call in calls))
        self.assertFalse(unit_dir.exists())
        self.assertFalse((root / "data").exists())


class InstallerTransactionTests(unittest.TestCase):
    def test_install_also_updates_static_timers_without_enabling_them(self):
        root = make_complete_project_fixture(self)
        unit_dir = root / "installed"
        calls: list[list[str]] = []

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            install_units(
                root,
                unit_dir,
                check_only=False,
                restart=False,
                command_runner=lambda args: calls.append(list(args)),
            )

        self.assertEqual(
            (unit_dir / "mumae-backtest-notify.timer").read_text(encoding="utf-8"),
            (root / "deploy" / "mumae-backtest-notify.timer").read_text(encoding="utf-8"),
        )
        self.assertEqual(calls, [["systemctl", "daemon-reload"]])

    def test_fresh_data_directory_is_assigned_to_the_service_user(self):
        root = make_complete_project_fixture(self)
        ownership: list[tuple[Path, str, str]] = []

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            install_units(
                root,
                root / "installed",
                check_only=False,
                restart=False,
                command_runner=lambda args: None,
                owner_setter=lambda path, user, group: ownership.append((path, user, group)),
            )

        self.assertEqual(ownership, [(root / "data", "ho", "ho")])
        self.assertTrue((root / "data").is_dir())

    def test_success_backs_up_units_reloads_and_restarts(self):
        root = make_complete_project_fixture(self)
        unit_dir = root / "installed"
        unit_dir.mkdir()
        (unit_dir / "mumae.service").write_text("old-main", encoding="utf-8")
        calls: list[list[str]] = []

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            install_units(
                root,
                unit_dir,
                check_only=False,
                restart=True,
                command_runner=lambda args: calls.append(list(args)),
            )

        self.assertEqual(
            (unit_dir / "mumae.service.previous").read_text(encoding="utf-8"),
            "old-main",
        )
        rendered_root = f"{root.parent}/renamed\\x20project"
        for name in UNIT_NAMES:
            installed = unit_dir / name
            self.assertIn(rendered_root, installed.read_text(encoding="utf-8"))
            self.assertEqual(installed.stat().st_mode & 0o777, 0o644)
        self.assertTrue((root / "data").is_dir())
        self.assertEqual(
            calls,
            [
                ["systemctl", "is-active", "--quiet", "mumae.service"],
                ["systemctl", "daemon-reload"],
                ["systemctl", "restart", "mumae.service"],
                ["systemctl", "is-active", "--quiet", "mumae.service"],
            ],
        )

    def test_no_restart_only_reloads_systemd(self):
        root = make_complete_project_fixture(self)
        unit_dir = root / "installed"
        calls: list[list[str]] = []

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            install_units(
                root,
                unit_dir,
                check_only=False,
                restart=False,
                command_runner=lambda args: calls.append(list(args)),
            )

        self.assertEqual(calls, [["systemctl", "daemon-reload"]])

    def test_restart_failure_restores_every_previous_unit(self):
        root = make_complete_project_fixture(self)
        unit_dir = make_existing_unit_fixture(self, root)
        before = {name: (unit_dir / name).read_bytes() for name in UNIT_NAMES}
        calls: list[list[str]] = []
        restart_count = 0

        def fail_restart(args):
            nonlocal restart_count
            command = list(args)
            calls.append(command)
            if command == ["systemctl", "restart", "mumae.service"]:
                restart_count += 1
                if restart_count == 1:
                    raise subprocess.CalledProcessError(1, command)

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            with self.assertRaises(subprocess.CalledProcessError):
                install_units(
                    root,
                    unit_dir,
                    check_only=False,
                    restart=True,
                    command_runner=fail_restart,
                )

        after = {name: (unit_dir / name).read_bytes() for name in UNIT_NAMES}
        self.assertEqual(before, after)
        self.assertEqual(calls[-1], ["systemctl", "restart", "mumae.service"])

    def test_restart_failure_restores_a_previously_active_service(self):
        root = make_complete_project_fixture(self)
        unit_dir = make_existing_unit_fixture(self, root)
        calls: list[list[str]] = []
        restart_count = 0

        def fail_first_restart(args):
            nonlocal restart_count
            command = list(args)
            calls.append(command)
            if command == ["systemctl", "restart", "mumae.service"]:
                restart_count += 1
                if restart_count == 1:
                    raise subprocess.CalledProcessError(1, command)

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            with self.assertRaises(subprocess.CalledProcessError):
                install_units(
                    root,
                    unit_dir,
                    check_only=False,
                    restart=True,
                    command_runner=fail_first_restart,
                )

        self.assertEqual(restart_count, 2)
        self.assertEqual(calls[-1], ["systemctl", "restart", "mumae.service"])

    def test_is_active_transport_failure_aborts_before_replacing_units(self):
        root = make_complete_project_fixture(self)
        unit_dir = make_existing_unit_fixture(self, root)
        before = {name: (unit_dir / name).read_bytes() for name in UNIT_NAMES}
        calls: list[list[str]] = []

        def fail_activity_check(args):
            command = list(args)
            calls.append(command)
            if command == ["systemctl", "is-active", "--quiet", "mumae.service"]:
                raise subprocess.CalledProcessError(1, command, stderr="systemd unavailable")

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            with self.assertRaisesRegex(subprocess.CalledProcessError, "is-active"):
                install_units(
                    root,
                    unit_dir,
                    check_only=False,
                    restart=True,
                    command_runner=fail_activity_check,
                )

        self.assertEqual(
            before,
            {name: (unit_dir / name).read_bytes() for name in UNIT_NAMES},
        )
        self.assertEqual(calls, [["systemctl", "is-active", "--quiet", "mumae.service"]])

    def test_partial_unit_restore_never_restarts_the_service(self):
        root = make_complete_project_fixture(self)
        unit_dir = make_existing_unit_fixture(self, root)
        before = {name: (unit_dir / name).read_bytes() for name in UNIT_NAMES}
        calls: list[list[str]] = []
        restart_count = 0
        real_replace = __import__("os").replace

        def fail_restart(args):
            nonlocal restart_count
            command = list(args)
            calls.append(command)
            if command == ["systemctl", "restart", "mumae.service"]:
                restart_count += 1
                raise subprocess.CalledProcessError(1, command, stderr="restart failed")

        def fail_one_rollback(source, destination):
            if Path(destination).name == "mumae.service" and str(source).endswith(".rollback"):
                raise OSError("main unit restore failed")
            return real_replace(source, destination)

        with patch("deploy.systemd_installer.shutil.which", return_value=None), patch(
            "deploy.systemd_installer.os.replace", side_effect=fail_one_rollback
        ):
            with self.assertRaisesRegex(RuntimeError, "main unit restore failed"):
                install_units(
                    root,
                    unit_dir,
                    check_only=False,
                    restart=True,
                    command_runner=fail_restart,
                )

        self.assertEqual(restart_count, 1)
        self.assertEqual(
            (unit_dir / "mumae-candle-logger.service").read_bytes(),
            before["mumae-candle-logger.service"],
        )
        self.assertEqual(
            (unit_dir / "mumae-backtest-notify.service").read_bytes(),
            before["mumae-backtest-notify.service"],
        )

    def test_rollback_reload_failure_reports_the_original_and_rollback_errors(self):
        root = make_complete_project_fixture(self)
        unit_dir = make_existing_unit_fixture(self, root)
        reload_count = 0

        def fail_install_and_rollback(args):
            nonlocal reload_count
            command = list(args)
            if command == ["systemctl", "daemon-reload"]:
                reload_count += 1
                if reload_count == 2:
                    raise subprocess.CalledProcessError(2, command, stderr="rollback reload failed")
            if command == ["systemctl", "restart", "mumae.service"]:
                raise subprocess.CalledProcessError(1, command, stderr="restart failed")

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "restart failed.*rollback reload failed"):
                install_units(
                    root,
                    unit_dir,
                    check_only=False,
                    restart=True,
                    command_runner=fail_install_and_rollback,
                )

    def test_failure_removes_units_that_did_not_exist_before_install(self):
        root = make_complete_project_fixture(self)
        unit_dir = root / "installed"
        unit_dir.mkdir()
        (unit_dir / "mumae.service").write_text("old-main", encoding="utf-8")

        def fail_reload(args):
            command = list(args)
            if command == ["systemctl", "is-active", "--quiet", "mumae.service"]:
                raise subprocess.CalledProcessError(3, command)
            raise subprocess.CalledProcessError(1, command)

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            with self.assertRaises(RuntimeError):
                install_units(
                    root,
                    unit_dir,
                    check_only=False,
                    restart=True,
                    command_runner=fail_reload,
                )

        self.assertEqual((unit_dir / "mumae.service").read_text(), "old-main")
        self.assertFalse((unit_dir / "mumae-candle-logger.service").exists())
        self.assertFalse((unit_dir / "mumae-backtest-notify.service").exists())


class InstallerCliTests(unittest.TestCase):
    def test_command_failure_prints_diagnostics_and_status_hint(self):
        root = make_complete_project_fixture(self)
        stderr = StringIO()

        def fail_restart(args):
            command = list(args)
            if command == ["systemctl", "restart", "mumae.service"]:
                raise subprocess.CalledProcessError(1, command, stderr="unit start failed")

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            exit_code = main(
                ["--project-root", str(root)],
                unit_dir=root / "installed",
                command_runner=fail_restart,
                geteuid=lambda: 0,
                stdout=StringIO(),
                stderr=stderr,
                owner_setter=lambda path, user, group: None,
            )

        self.assertEqual(exit_code, 1)
        self.assertIn("unit start failed", stderr.getvalue())
        self.assertIn("systemctl status mumae.service --no-pager -l", stderr.getvalue())

    def test_check_mode_succeeds_without_root_and_never_prints_env_contents(self):
        root = make_complete_project_fixture(self)
        secret_marker = "SECRET-MUST-NOT-BE-PRINTED"
        (root / "deploy" / "mumae.env").write_text(
            f"TOSS_CLIENT_SECRET={secret_marker}\n",
            encoding="utf-8",
        )
        stdout = StringIO()
        stderr = StringIO()

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            exit_code = main(
                ["--project-root", str(root), "--check"],
                unit_dir=root / "not-created",
                command_runner=lambda args: self.fail(f"unexpected command: {args}"),
                geteuid=lambda: 1000,
                stdout=stdout,
                stderr=stderr,
            )

        self.assertEqual(exit_code, 0)
        self.assertIn(str(root.resolve()), stdout.getvalue())
        for name in UNIT_NAMES:
            self.assertIn(name, stdout.getvalue())
        self.assertNotIn(secret_marker, stdout.getvalue() + stderr.getvalue())
        self.assertFalse((root / "not-created").exists())

    def test_install_mode_requires_root_before_writing_or_running_commands(self):
        root = make_complete_project_fixture(self)
        unit_dir = root / "not-created"
        calls: list[list[str]] = []
        stderr = StringIO()

        exit_code = main(
            ["--project-root", str(root)],
            unit_dir=unit_dir,
            command_runner=lambda args: calls.append(list(args)),
            geteuid=lambda: 1000,
            stdout=StringIO(),
            stderr=stderr,
        )

        self.assertEqual(exit_code, 1)
        self.assertIn("root", stderr.getvalue().lower())
        self.assertEqual(calls, [])
        self.assertFalse(unit_dir.exists())

    def test_no_restart_flag_installs_units_without_restarting_service(self):
        root = make_complete_project_fixture(self)
        calls: list[list[str]] = []

        with patch("deploy.systemd_installer.shutil.which", return_value=None):
            exit_code = main(
                ["--project-root", str(root), "--no-restart"],
                unit_dir=root / "installed",
                command_runner=lambda args: calls.append(list(args)),
                geteuid=lambda: 0,
                stdout=StringIO(),
                stderr=StringIO(),
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(calls, [["systemctl", "daemon-reload"]])


if __name__ == "__main__":
    unittest.main()
