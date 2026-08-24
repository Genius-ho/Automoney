"""Render relocation-safe systemd unit templates for the current checkout."""
from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TextIO


PROJECT_ROOT_TOKEN = "@MUMAE_PROJECT_ROOT@"
UNIT_NAMES = (
    "mumae.service",
    "mumae-candle-logger.service",
    "mumae-backtest-notify.service",
)
REQUIRED_PROJECT_PATHS = (
    "mumae_cli.py",
    "candle_logger.py",
    "backtest_indicator_sweep.py",
    ".venv/bin/python",
    "deploy/mumae.env",
)
CommandRunner = Callable[[Sequence[str]], object]
DEFAULT_UNIT_DIR = Path("/etc/systemd/system")


def systemd_escape_path(path: Path) -> str:
    value = str(path)
    if any(ord(character) < 32 for character in value):
        raise ValueError("Project path contains an unsupported control character.")
    replacements = {
        " ": r"\x20",
        "\\": r"\x5c",
        '"': r"\x22",
        "'": r"\x27",
        "%": "%%",
    }
    return "".join(replacements.get(character, character) for character in value)


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
        name: render_unit(
            (template_dir / f"{name}.in").read_text(encoding="utf-8"),
            resolved,
        )
        for name in UNIT_NAMES
    }


def validate_project(project_root: Path) -> Path:
    root = project_root.expanduser().resolve(strict=True)
    for relative in REQUIRED_PROJECT_PATHS:
        candidate = root / relative
        if not candidate.is_file() or not os.access(candidate, os.R_OK):
            raise FileNotFoundError(
                f"Required project file is missing or unreadable: {relative}"
            )
    return root


def install_units(
    project_root: Path,
    unit_dir: Path,
    *,
    check_only: bool,
    restart: bool,
    command_runner: CommandRunner,
) -> None:
    root = validate_project(project_root)
    rendered = render_units(root, root / "deploy" / "systemd")
    with TemporaryDirectory(prefix="mumae-systemd-") as raw:
        temporary_dir = Path(raw)
        rendered_paths: list[Path] = []
        for name, content in rendered.items():
            path = temporary_dir / name
            path.write_text(content, encoding="utf-8")
            rendered_paths.append(path)
        if shutil.which("systemd-analyze") is not None:
            command_runner(["systemd-analyze", "verify", *(str(path) for path in rendered_paths)])
        if check_only:
            return

    (root / "data").mkdir(parents=True, exist_ok=True)
    unit_dir.mkdir(parents=True, exist_ok=True)
    snapshots: dict[str, tuple[bytes, int] | None] = {}
    for name in UNIT_NAMES:
        destination = unit_dir / name
        if destination.exists():
            snapshots[name] = (
                destination.read_bytes(),
                stat.S_IMODE(destination.stat().st_mode),
            )
            shutil.copy2(destination, unit_dir / f"{name}.previous")
        else:
            snapshots[name] = None

    try:
        for name, content in rendered.items():
            destination = unit_dir / name
            temporary = unit_dir / f".{name}.{os.getpid()}.tmp"
            temporary.write_text(content, encoding="utf-8")
            temporary.chmod(0o644)
            os.replace(temporary, destination)
        command_runner(["systemctl", "daemon-reload"])
        if restart:
            command_runner(["systemctl", "restart", "mumae.service"])
            command_runner(["systemctl", "is-active", "--quiet", "mumae.service"])
    except Exception:
        for name, snapshot in snapshots.items():
            destination = unit_dir / name
            if snapshot is None:
                destination.unlink(missing_ok=True)
                continue
            content, mode = snapshot
            temporary = unit_dir / f".{name}.{os.getpid()}.rollback"
            temporary.write_bytes(content)
            temporary.chmod(mode)
            os.replace(temporary, destination)
        try:
            command_runner(["systemctl", "daemon-reload"])
        except Exception:
            pass
        raise


def default_command_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        check=True,
        text=True,
        capture_output=True,
    )


def main(
    argv: Sequence[str] | None = None,
    *,
    unit_dir: Path = DEFAULT_UNIT_DIR,
    command_runner: CommandRunner = default_command_runner,
    geteuid: Callable[[], int] = os.geteuid,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    parser = argparse.ArgumentParser(
        description="Install Mumae systemd units for the current checkout."
    )
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--no-restart", action="store_true")
    args = parser.parse_args(argv)

    try:
        if not args.check and geteuid() != 0:
            raise PermissionError("Installation requires root privileges; run with sudo.")
        root = validate_project(args.project_root)
        install_units(
            root,
            unit_dir,
            check_only=args.check,
            restart=not args.no_restart,
            command_runner=command_runner,
        )
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Mumae systemd installation failed: {error}", file=stderr)
        return 1

    action = "validated" if args.check else "installed"
    print(f"Project root: {root}", file=stdout)
    print(f"Units {action}: {', '.join(UNIT_NAMES)}", file=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
