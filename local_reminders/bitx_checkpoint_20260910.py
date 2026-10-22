"""One-off Telegram reminder for the 2026-09-10 BITX sell-decision checkpoint.
Run by a self-removing cron entry; not part of the app."""
from __future__ import annotations

import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from local_env import load_env  # noqa: E402

MESSAGE = (
    "BITX 결정 체크포인트: 9/15 클래리티 법안 상원 표결 전, 매도 계획을 다시 점검하세요.\n"
    "목표: -30%(BITX $21.95, 대략 BTC $87,000) 근처에서 일부 매도 고려."
)
CRON_MARKER = "REMINDER_BITX_20260910"


def send_telegram_message(token: str, chat_id: str, text: str) -> None:
    import json

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        response.read()


def remove_self_from_crontab() -> None:
    listing = subprocess.run(["crontab", "-l"], capture_output=True, text=True, check=False)
    if listing.returncode != 0:
        return
    remaining = "\n".join(line for line in listing.stdout.splitlines() if CRON_MARKER not in line)
    subprocess.run(["crontab", "-"], input=remaining + "\n", text=True, check=False)


def main() -> None:
    import os

    load_env(str(Path(__file__).resolve().parent.parent / "deploy" / "mumae.env"))
    token = os.environ["MUMAE_TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["MUMAE_TELEGRAM_CHAT_ID"]
    send_telegram_message(token, chat_id, MESSAGE)
    remove_self_from_crontab()


if __name__ == "__main__":
    main()
