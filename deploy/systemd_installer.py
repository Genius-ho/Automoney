"""Render relocation-safe systemd unit templates for the current checkout."""
from __future__ import annotations

from pathlib import Path


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
        name: render_unit(
            (template_dir / f"{name}.in").read_text(encoding="utf-8"),
            resolved,
        )
        for name in UNIT_NAMES
    }
