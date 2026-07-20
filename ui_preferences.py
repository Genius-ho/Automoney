"""Atomic persistence for user-adjusted table column widths."""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path


class UiPreferencesStore:
    def __init__(self, path: str | Path = "ui_preferences.json") -> None:
        self.path = Path(path)

    def load_column_widths(self) -> dict[str, dict[str, int]]:
        if not self.path.exists():
            return {}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        result: dict[str, dict[str, int]] = {}
        for table, columns in payload.get("column_widths", {}).items():
            if not isinstance(columns, dict):
                continue
            result[str(table)] = {
                str(column): int(width)
                for column, width in columns.items()
                if isinstance(width, int) and 30 <= width <= 2000
            }
        return result

    def save_column_widths(self, widths: dict[str, dict[str, int]]) -> None:
        payload = {"version": 1, "column_widths": widths}
        temp = self.path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, self.path)