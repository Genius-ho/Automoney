"""Append-only, credential-redacted audit trail for engine commands."""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

KST = timezone(timedelta(hours=9))
SECRET_KEYS = {
    "clientsecret",
    "password",
    "webpassword",
    "csrf",
    "session",
    "sessiontoken",
    "accesstoken",
}


def _normalize_key(key: str) -> str:
    return key.lower().replace("_", "")


def _redact(value: Any, key: str = "") -> Any:
    if _normalize_key(key) in SECRET_KEYS:
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(name): _redact(item, str(name)) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact(item) for item in value]
    return value


class AuditLog:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def record(
        self,
        source: str,
        actor: str,
        command: str,
        payload: dict[str, Any],
        success: bool,
        error: str,
    ) -> None:
        row = {
            "timestamp_kst": datetime.now(KST).isoformat(),
            "source": source.upper(),
            "actor": actor,
            "command": command,
            "symbol": str(payload.get("symbol", "")).upper(),
            "payload": _redact(payload),
            "success": bool(success),
            "error": str(error),
        }
        encoded = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            with self.path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())

    def entries(self, limit: int = 100) -> list[dict[str, Any]]:
        if limit <= 0 or not self.path.exists():
            return []
        with self._lock:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        rows: list[dict[str, Any]] = []
        for line in lines[-limit:]:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows


__all__ = ["AuditLog"]
