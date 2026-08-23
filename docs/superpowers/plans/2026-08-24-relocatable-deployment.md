# Relocatable Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every committed launcher path-independent and provide one safe command that regenerates Linux systemd units after the repository is renamed or moved.

**Architecture:** Commit systemd templates containing one project-root token, render them with a tested Python installer that derives the checkout root from its own location, and keep a thin POSIX shell entry point for operators. Runtime data and `deploy/mumae.env` remain inside the repository; installed units receive absolute paths generated for the current checkout.

**Tech Stack:** Python 3.13 standard library, POSIX shell, systemd unit templates, `unittest`

**Spec:** `docs/superpowers/specs/2026-08-24-relocatable-deployment-design.md`

## Global Constraints

- The project may be renamed or moved to another normal POSIX path readable by the `ho` service account.
- Paths containing spaces must work; paths containing newlines or control characters are unsupported.
- Runtime data remains in the repository's `data/` directory and secrets remain in ignored `deploy/mumae.env`.
- The installer must never read or print secret values.
- The installer must never scan for another checkout.
- No test may use `sudo`, mutate `/etc/systemd/system`, restart a real service, contact Toss, or submit an order.
- `--check` must perform no persistent writes and no `systemctl` calls.
- Existing timer enablement must remain untouched.

---

### Task 1: Pure systemd template rendering

**Files:**
- Create: `deploy/systemd/mumae.service.in`
- Create: `deploy/systemd/mumae-candle-logger.service.in`
- Create: `deploy/systemd/mumae-backtest-notify.service.in`
- Create: `deploy/systemd_installer.py`
- Create: `tests/test_systemd_installer.py`
- Delete: `deploy/mumae.service`
- Delete: `deploy/mumae-candle-logger.service`
- Delete: `deploy/mumae-backtest-notify.service`

**Interfaces:**
- Produces: `PROJECT_ROOT_TOKEN: str`
- Produces: `UNIT_NAMES: tuple[str, ...]`
- Produces: `systemd_escape_path(path: Path) -> str`
- Produces: `render_unit(template: str, project_root: Path) -> str`
- Produces: `render_units(project_root: Path, template_dir: Path) -> dict[str, str]`

- [ ] **Step 1: Write failing rendering tests**

```python
class SystemdRenderingTests(unittest.TestCase):
    def test_render_unit_supports_renamed_path_with_spaces_and_percent(self):
        root = Path("/srv/Mumae Live 100%")
        rendered = render_unit(
            'WorkingDirectory="@MUMAE_PROJECT_ROOT@"\n'
            'ExecStart=/usr/bin/python3 "@MUMAE_PROJECT_ROOT@/mumae_cli.py" serve\n',
            root,
        )
        self.assertIn('WorkingDirectory="/srv/Mumae Live 100%%"', rendered)
        self.assertIn('"/srv/Mumae Live 100%%/mumae_cli.py"', rendered)
        self.assertNotIn(PROJECT_ROOT_TOKEN, rendered)

    def test_render_unit_rejects_missing_or_unresolved_token(self):
        with self.assertRaisesRegex(ValueError, "project-root token"):
            render_unit("[Service]\nType=simple\n", Path("/srv/mumae"))

    def test_all_templates_render_for_unrelated_roots(self):
        first = render_units(Path("/opt/trading/mumae"), TEMPLATE_DIR)
        second = render_units(Path("/srv/renamed project"), TEMPLATE_DIR)
        self.assertEqual(set(first), set(UNIT_NAMES))
        for name in UNIT_NAMES:
            self.assertIn("/opt/trading/mumae", first[name])
            self.assertNotIn("/opt/trading/mumae", second[name])
            self.assertIn("/srv/renamed project", second[name])
```

- [ ] **Step 2: Run the new tests and confirm RED**

Run: `.venv/bin/python -m unittest tests.test_systemd_installer.SystemdRenderingTests -v`

Expected: import failure because `deploy/systemd_installer.py` does not exist.

- [ ] **Step 3: Add tokenized unit templates**

Use quoted token occurrences in every path-bearing directive. The main template must contain:

```ini
[Service]
Type=simple
User=ho
Group=ho
WorkingDirectory="@MUMAE_PROJECT_ROOT@"
EnvironmentFile="@MUMAE_PROJECT_ROOT@/deploy/mumae.env"
ExecStart=/usr/bin/python3 "@MUMAE_PROJECT_ROOT@/mumae_cli.py" serve
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="@MUMAE_PROJECT_ROOT@/data"
```

The candle and backtest templates retain their current command arguments and security directives, replacing every checkout path with the same token. The backtest template uses `"@MUMAE_PROJECT_ROOT@/.venv/bin/python"`.

- [ ] **Step 4: Implement minimal pure rendering functions**

```python
PROJECT_ROOT_TOKEN = "@MUMAE_PROJECT_ROOT@"
UNIT_NAMES = (
    "mumae.service",
    "mumae-candle-logger.service",
    "mumae-backtest-notify.service",
)

def systemd_escape_path(path: Path) -> str:
    value = str(path)
    if any(ord(character) < 32 for character in value):
        raise ValueError("Project path contains an unsupported control character.")
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")

def render_unit(template: str, project_root: Path) -> str:
    if PROJECT_ROOT_TOKEN not in template:
        raise ValueError("Systemd template is missing the project-root token.")
    rendered = template.replace(PROJECT_ROOT_TOKEN, systemd_escape_path(project_root))
    if PROJECT_ROOT_TOKEN in rendered:
        raise ValueError("Systemd template contains an unresolved project-root token.")
    return rendered

def render_units(project_root: Path, template_dir: Path) -> dict[str, str]:
    resolved = project_root.expanduser().resolve(strict=True)
    return {
        name: render_unit((template_dir / f"{name}.in").read_text(encoding="utf-8"), resolved)
        for name in UNIT_NAMES
    }
```

- [ ] **Step 5: Run rendering tests and confirm GREEN**

Run: `.venv/bin/python -m unittest tests.test_systemd_installer.SystemdRenderingTests -v`

Expected: all rendering tests pass.

- [ ] **Step 6: Commit the rendering layer**

```bash
git add deploy/systemd deploy/systemd_installer.py tests/test_systemd_installer.py
git rm deploy/mumae.service deploy/mumae-candle-logger.service deploy/mumae-backtest-notify.service
git commit -m "feat: render relocatable systemd units"
```

### Task 2: Preflight, installation transaction, and rollback

**Files:**
- Modify: `deploy/systemd_installer.py`
- Modify: `tests/test_systemd_installer.py`

**Interfaces:**
- Consumes: `UNIT_NAMES`, `render_units(...)`
- Produces: `REQUIRED_PROJECT_PATHS: tuple[str, ...]`
- Produces: `validate_project(project_root: Path) -> Path`
- Produces: `install_units(project_root: Path, unit_dir: Path, *, check_only: bool, restart: bool, command_runner: CommandRunner) -> None`
- Produces: `main(argv: Sequence[str] | None = None) -> int`

- [ ] **Step 1: Write failing preflight and check-mode tests**

```python
class InstallerPreflightTests(unittest.TestCase):
    def test_missing_required_file_fails_before_commands_or_writes(self):
        with TemporaryDirectory() as raw:
            root = Path(raw)
            unit_dir = root / "units"
            calls: list[list[str]] = []
            with self.assertRaisesRegex(FileNotFoundError, "mumae_cli.py"):
                install_units(root, unit_dir, check_only=False, restart=True,
                              command_runner=lambda args: calls.append(list(args)))
            self.assertEqual(calls, [])
            self.assertFalse(unit_dir.exists())

    def test_check_mode_runs_verification_but_no_systemctl_and_writes_nothing(self):
        root = make_complete_project_fixture()
        calls: list[list[str]] = []
        install_units(root, root / "not-created", check_only=True, restart=True,
                      command_runner=lambda args: calls.append(list(args)))
        self.assertTrue(any(call[:2] == ["systemd-analyze", "verify"] for call in calls))
        self.assertFalse(any(call[0] == "systemctl" for call in calls))
        self.assertFalse((root / "not-created").exists())
        self.assertFalse((root / "data").exists())
```

- [ ] **Step 2: Run preflight tests and confirm RED**

Run: `.venv/bin/python -m unittest tests.test_systemd_installer.InstallerPreflightTests -v`

Expected: import failure for `install_units` and `validate_project`.

- [ ] **Step 3: Implement validation, temporary rendering, and check mode**

```python
REQUIRED_PROJECT_PATHS = (
    "mumae_cli.py",
    "candle_logger.py",
    "backtest_indicator_sweep.py",
    ".venv/bin/python",
    "deploy/mumae.env",
)

def validate_project(project_root: Path) -> Path:
    root = project_root.expanduser().resolve(strict=True)
    for relative in REQUIRED_PROJECT_PATHS:
        candidate = root / relative
        if not candidate.is_file() or not os.access(candidate, os.R_OK):
            raise FileNotFoundError(f"Required project file is missing or unreadable: {relative}")
    return root
```

Render into `tempfile.TemporaryDirectory`, write only temporary unit files, and call `systemd-analyze verify` through the injected runner when `shutil.which("systemd-analyze")` is not `None`. Return immediately after verification in check mode.

- [ ] **Step 4: Run preflight tests and confirm GREEN**

Run: `.venv/bin/python -m unittest tests.test_systemd_installer.InstallerPreflightTests -v`

Expected: all preflight and check-mode tests pass.

- [ ] **Step 5: Write failing atomic-install and rollback tests**

```python
class InstallerTransactionTests(unittest.TestCase):
    def test_success_backs_up_units_reloads_and_restarts(self):
        root = make_complete_project_fixture()
        unit_dir = root / "installed"
        unit_dir.mkdir()
        (unit_dir / "mumae.service").write_text("old-main", encoding="utf-8")
        calls: list[list[str]] = []
        install_units(root, unit_dir, check_only=False, restart=True,
                      command_runner=lambda args: calls.append(list(args)))
        self.assertEqual((unit_dir / "mumae.service.previous").read_text(), "old-main")
        self.assertIn(str(root), (unit_dir / "mumae.service").read_text())
        self.assertIn(["systemctl", "daemon-reload"], calls)
        self.assertIn(["systemctl", "restart", "mumae.service"], calls)
        self.assertIn(["systemctl", "is-active", "--quiet", "mumae.service"], calls)

    def test_restart_failure_restores_every_previous_unit(self):
        root = make_complete_project_fixture()
        unit_dir = make_existing_unit_fixture(root)
        before = {name: (unit_dir / name).read_bytes() for name in UNIT_NAMES}
        def fail_restart(args):
            if list(args) == ["systemctl", "restart", "mumae.service"]:
                raise subprocess.CalledProcessError(1, args)
        with self.assertRaises(subprocess.CalledProcessError):
            install_units(root, unit_dir, check_only=False, restart=True,
                          command_runner=fail_restart)
        self.assertEqual(before, {name: (unit_dir / name).read_bytes() for name in UNIT_NAMES})
```

- [ ] **Step 6: Run transaction tests and confirm RED**

Run: `.venv/bin/python -m unittest tests.test_systemd_installer.InstallerTransactionTests -v`

Expected: failures because installation, backup, command sequencing, and rollback are not implemented.

- [ ] **Step 7: Implement atomic installation and rollback**

Before replacement, snapshot every destination as `bytes | None` and copy existing files to `<unit>.previous`. Write each generated unit to a sibling temporary file, `chmod(0o644)`, then use `os.replace`. On any exception after replacement begins, restore every snapshot, call `systemctl daemon-reload`, and re-raise. Normal command order is:

```python
command_runner(["systemctl", "daemon-reload"])
if restart:
    command_runner(["systemctl", "restart", "mumae.service"])
    command_runner(["systemctl", "is-active", "--quiet", "mumae.service"])
```

Create `data/` only after check mode has returned and before replacing units. Do not start or enable the timer-backed services.

- [ ] **Step 8: Add and test CLI argument handling**

```python
parser.add_argument("--project-root", type=Path, required=True)
parser.add_argument("--check", action="store_true")
parser.add_argument("--no-restart", action="store_true")
```

`main()` requires root privileges only when not in check mode, uses `/etc/systemd/system`, maps `--no-restart` to `restart=False`, catches expected `OSError`, `ValueError`, and `CalledProcessError`, prints only sanitized error text to stderr, and returns 1 on failure.

Run: `.venv/bin/python -m unittest tests.test_systemd_installer -v`

Expected: all installer tests pass.

- [ ] **Step 9: Commit the transactional installer**

```bash
git add deploy/systemd_installer.py tests/test_systemd_installer.py
git commit -m "feat: safely reinstall moved systemd services"
```

### Task 3: Self-locating operator entry point and relative configuration

**Files:**
- Create: `deploy/install-systemd.sh`
- Modify: `deploy/mumae.env.example`
- Modify locally without staging: `deploy/mumae.env`
- Modify: `web_gui/README.md`
- Modify: `tests/test_linux_deployment.py`
- Modify: `tests/test_web_live_ui.py`

**Interfaces:**
- Consumes: `deploy/systemd_installer.py --project-root PATH [--check] [--no-restart]`
- Produces: `sudo ./deploy/install-systemd.sh [--check] [--no-restart]`

- [ ] **Step 1: Write failing launcher and path-independence tests**

```python
def test_installer_launcher_derives_root_from_its_own_location(self):
    script = (ROOT / "deploy" / "install-systemd.sh").read_text(encoding="utf-8")
    self.assertIn('SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)', script)
    self.assertIn('--project-root "$SCRIPT_DIR/.."', script)
    self.assertNotIn("/home/ho/apps/", script)

def test_deployment_sources_have_no_production_checkout_prefix(self):
    paths = [
        *sorted((ROOT / "deploy" / "systemd").glob("*.in")),
        ROOT / "deploy" / "mumae.env.example",
        ROOT / "web_gui" / "README.md",
        ROOT / "web_gui" / "run_web.sh",
        ROOT / "web_gui" / "run_web.ps1",
    ]
    for path in paths:
        self.assertNotIn("/home/ho/apps/", path.read_text(encoding="utf-8"), str(path))

def test_environment_uses_project_relative_data_directory(self):
    settings = (ROOT / "deploy" / "mumae.env.example").read_text(encoding="utf-8")
    self.assertIn("MUMAE_DATA_DIR=data", settings)
```

- [ ] **Step 2: Run deployment tests and confirm RED**

Run: `.venv/bin/python -m unittest tests.test_linux_deployment tests.test_web_live_ui -v`

Expected: failures because the installer shell is absent and committed deployment files still contain a checkout path.

- [ ] **Step 3: Add the self-locating shell entry point**

```sh
#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec /usr/bin/python3 "$SCRIPT_DIR/systemd_installer.py" \
  --project-root "$SCRIPT_DIR/.." "$@"
```

Run `chmod +x deploy/install-systemd.sh` and verify its mode is `0755`.

- [ ] **Step 4: Make data and documentation paths relocation-safe**

Set `MUMAE_DATA_DIR=data` in both the tracked example and the ignored production `deploy/mumae.env` without displaying other environment values. Replace fixed checkout commands in `web_gui/README.md` with:

```sh
cd <project-root>/web_gui
./run_web.sh
```

Document the relocation sequence:

```sh
sudo systemctl stop mumae.service
# move the complete repository, including data/ and deploy/mumae.env
cd <new-project-root>
sudo ./deploy/install-systemd.sh --check
sudo ./deploy/install-systemd.sh
curl -fsS http://127.0.0.1:8765/api/health
```

- [ ] **Step 5: Update Linux deployment assertions**

Read `deploy/systemd/mumae.service.in` instead of the deleted concrete unit. Assert that it contains `@MUMAE_PROJECT_ROOT@`, `mumae_cli.py`, no `--open`, and `Restart=on-failure`. Keep the existing localhost-safe environment example test.

- [ ] **Step 6: Run deployment and installer tests and confirm GREEN**

Run: `.venv/bin/python -m unittest tests.test_systemd_installer tests.test_linux_deployment tests.test_web_live_ui -v`

Expected: all targeted tests pass.

- [ ] **Step 7: Commit launchers, configuration example, tests, and docs**

```bash
git add deploy/install-systemd.sh deploy/mumae.env.example web_gui/README.md tests/test_linux_deployment.py tests/test_web_live_ui.py
git commit -m "docs: make deployment relocation workflow explicit"
```

Do not stage ignored `deploy/mumae.env`.

### Task 4: Full verification and production handoff

**Files:**
- Modify only if verification exposes a defect: files introduced or changed in Tasks 1-3

**Interfaces:**
- Consumes: completed installer, templates, launchers, tests, and documentation
- Produces: verified relocation workflow and exact production activation command

- [ ] **Step 1: Run whitespace and absolute-path checks**

```bash
git diff --check
grep -RIn --exclude='mumae.env' --exclude-dir=.git --exclude-dir=.venv \
  '/home/ho/apps/' deploy web_gui/README.md tests/test_linux_deployment.py tests/test_systemd_installer.py
```

Expected: both commands produce no errors or matches.

- [ ] **Step 2: Run the complete Python test suite**

Run: `.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v`

Expected: zero failures and zero errors.

- [ ] **Step 3: Run installer check mode from a different working directory**

Run: `(cd /tmp && /home/ho/apps/moohan/deploy/install-systemd.sh --check)`

Expected: exit 0, output names the resolved checkout and three units, no service is restarted, and no environment value is printed.

- [ ] **Step 4: Inspect final changes and request code review**

Run: `git status --short` and `git diff --stat HEAD~3..HEAD`.

Use `superpowers:requesting-code-review` to verify the implementation against the design and this plan. Address any findings, then rerun Steps 1-3.

- [ ] **Step 5: Production activation requiring operator sudo authentication**

The agent must not request or handle the sudo password. Ask the operator to run:

```bash
cd /home/ho/apps/moohan
sudo ./deploy/install-systemd.sh
sudo systemctl status mumae.service --no-pager -l
curl -fsS http://127.0.0.1:8765/api/health
```

Expected: `mumae.service` is active and the health endpoint returns JSON containing `"ok": true`.
