# Relocatable Deployment Design

## Purpose

Make the Mumae repository safe to rename or move without committing host-specific paths. Windows and direct Linux launchers must continue to derive the project root from their own location. A Linux systemd installation must be repairable from the repository's new location with one command.

The strategy state, runtime state, audit history, credentials, and `deploy/mumae.env` remain inside the repository. Moving the complete repository therefore moves the application and its data together.

## Constraints

- The project may be renamed or moved to another normal POSIX path readable by the `ho` service account.
- Paths containing spaces must work. Newlines and other control characters in the project path are unsupported.
- The Linux services continue to run as user and group `ho`.
- The main web service remains `mumae.service` on port 8765 unless `deploy/mumae.env` overrides the port.
- Existing timer enablement is preserved; the installer does not enable or disable timers.
- Secrets remain in the ignored `deploy/mumae.env` file and must never be printed by the installer or tests.
- Runtime data remains under the repository's `data/` directory.
- The deployment must not search the home directory for a matching checkout. A machine may contain production, development, or backup copies, and selecting one heuristically is unsafe for live trading.

## Architecture

The repository will contain systemd templates rather than host-specific installed units. A relocation-aware installer derives `PROJECT_ROOT` from its own file location, renders all absolute paths for the current checkout, validates the result, installs the generated units into `/etc/systemd/system`, reloads systemd, and restarts only the main web service by default.

The generated systemd files still contain absolute paths because systemd requires stable paths for `WorkingDirectory`, `EnvironmentFile`, executable locations, and `ReadWritePaths`. Those paths are generated installation artifacts, not committed source. Moving the repository requires rerunning the installer from the new location:

```bash
sudo ./deploy/install-systemd.sh
```

This is the only required relocation step on Linux. Windows launchers need no reinstallation when launched from their new location; an operating-system shortcut that points to the old location is outside the repository and must be recreated by the user.

## Components

### Unit templates

Create templates for:

- `mumae.service`
- `mumae-candle-logger.service`
- `mumae-backtest-notify.service`

Each template uses a single explicit project-root placeholder. The renderer replaces that placeholder with a systemd-safe absolute path. Committed templates contain no host-specific checkout path such as `/home/<user>/apps/...`.

Timer units remain path-independent and unchanged.

### Renderer and installer

`deploy/systemd_installer.py` owns path normalization, template rendering, validation, backup, installation, rollback, and systemctl execution. Its rendering and validation functions are side-effect-free so they can be tested using temporary directories without root privileges.

`deploy/install-systemd.sh` is a small POSIX entry point. It determines its own directory without depending on the caller's working directory and executes `systemd_installer.py` with the current repository root. It forwards `--check` and `--no-restart` options.

The installer performs these steps in order:

1. Resolve the repository root from the installer's real location.
2. Verify that `mumae_cli.py`, `candle_logger.py`, `backtest_indicator_sweep.py`, `.venv/bin/python`, and `deploy/mumae.env` exist and are readable.
3. Render all three service units into a private temporary directory.
4. Verify that rendered units contain the resolved project root, contain no unresolved placeholder, and pass `systemd-analyze verify` when that command is available.
5. Exit successfully here when `--check` is supplied.
6. Ensure the repository's `data/` directory exists.
7. Back up existing installed units before replacing them.
8. Install the new units atomically with mode `0644`.
9. Run `systemctl daemon-reload`.
10. Restart `mumae.service`, unless `--no-restart` was supplied.
11. Confirm that `mumae.service` is active after a requested restart. If installation or restart fails, restore the previous units, reload systemd, and report the failure without exposing environment values.

`--check` performs steps 1 through 5 and prints the resolved project root and unit names. It does not create `data/`, write `/etc`, call `daemon-reload`, or restart any service.

### Relative runtime data

`deploy/mumae.env.example` and the local ignored `deploy/mumae.env` use:

```text
MUMAE_DATA_DIR=data
```

Because each generated service sets `WorkingDirectory` to the current repository root, the application resolves this to the repository's own `data/` directory after every reinstall. No data migration is performed.

### Existing launchers

`web_gui/run_web.sh`, `web_gui/run_web.ps1`, and `web_gui/run_web.bat` continue to derive paths from their own location. Tests will lock in this behavior. Documentation will avoid fixed checkout names and use `<project-root>` notation.

## Error Handling and Safety

- Preflight failure occurs before any installed unit is changed.
- Ambiguous project discovery is impossible because the installer uses only its own location.
- Unit rendering quotes and escapes spaces and systemd percent specifiers in paths.
- The installer never reads or prints the contents of `deploy/mumae.env`; it checks only file existence and readability.
- Existing installed units are backed up before replacement and restored if a later installation step fails.
- Restart failure returns a nonzero exit status and includes the service status command the operator should run.
- The installer does not enable, disable, start, or stop the candle logger or backtest timers.
- `--no-restart` allows unit regeneration without resuming the live-order process automatically.

## Testing

Automated tests will cover:

- Rendering from two unrelated temporary roots produces units containing only the selected root.
- A renamed path and a path containing spaces render correctly.
- No committed deployment template, example, launcher, test, or operational documentation file contains the production checkout prefix.
- An unresolved placeholder is rejected.
- Missing required files fail preflight before installation callbacks run.
- `--check` performs no writes and no systemctl calls.
- Backup restoration occurs when a simulated daemon-reload or restart fails.
- `MUMAE_DATA_DIR=data` resolves under the generated `WorkingDirectory`.
- Windows and POSIX launchers derive their project root from their own file location.
- Existing Linux deployment tests continue to verify headless startup, restart policy, localhost-safe example defaults, and no browser launch under systemd.

The test suite will not invoke real `sudo`, mutate `/etc/systemd/system`, restart services, contact Toss, or submit orders.

After automated tests pass, the production migration check is:

```bash
sudo ./deploy/install-systemd.sh --check
sudo ./deploy/install-systemd.sh
systemctl status mumae.service --no-pager -l
curl -fsS http://127.0.0.1:8765/api/health
```

## Migration

The first installer run from the current checkout replaces the manually edited `/etc/systemd/system` units with generated units pointing at the same checkout. The repository's existing state and credentials are untouched.

For a later move:

1. Stop `mumae.service` before moving the repository so live automation cannot run from a partially moved tree.
2. Move the complete repository, including ignored `data/` and `deploy/mumae.env` files.
3. Run `sudo ./deploy/install-systemd.sh` from the new location.
4. Verify the health endpoint.

## Non-goals and Limitations

- The service will not magically follow a move while it is running. Linux systemd stores absolute paths, so the installer must be rerun after a move.
- Moving only tracked source files without `data/` or `deploy/mumae.env` is not supported.
- Automatic scanning for repositories is not supported because selecting the wrong checkout could affect live trading.
- Packaging the application into a global Python installation or moving state into `/var/lib` is outside this change.
- Repairing external Windows shortcuts after a move is outside this change.
