"""Phase 14 helper: read-only watcher that waits for the US market to become
genuinely CLOSED (per the live Toss market calendar), then sends a single
Telegram notification so a human can come run smoke_conditional_order.py
interactively -- CREATE/DELETE approval stays exactly as designed there
(typed at a terminal), this script only automates the waiting/notifying.

Makes zero mutating API calls: only get_us_market_calendar_raw() (read-only)
and Telegram sendMessage. Never touches mumae.service, never creates or
cancels any order itself.

Run:
    python smoke_window_watcher.py --symbol TQQQ --env-file deploy/mumae.env
"""
from __future__ import annotations

import argparse
import time
from datetime import datetime, timezone
from typing import Any, Callable

from local_env import load_env
from smoke_conditional_order import classify_market_session
from telegram_bot import TelegramNotifier
from toss_api import TossBroker


def wait_for_closed_session(
    broker: Any,
    *,
    poll_interval: float = 300.0,
    sleeper: Callable[[float], None] = time.sleep,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> str:
    """Blocks (polling), read-only, until classify_market_session() reports
    CLOSED, then returns "CLOSED". The caller must still re-check
    immediately before any mutating action -- this is only the coarse wait."""
    while True:
        session = classify_market_session(broker, clock())
        if session == "CLOSED":
            return session
        sleeper(poll_interval)


def run(symbol: str, env_file: str, *, broker: Any = None, notifier: TelegramNotifier | None = None, wait: bool = True) -> None:
    symbol = symbol.upper()
    load_env(env_file)
    broker = broker or TossBroker()
    notifier = notifier or TelegramNotifier()
    if not notifier.enabled:
        raise SystemExit("Telegram notifier is not configured (bot token / chat id missing).")

    notifier.send_message(
        f"\U0001f514 {symbol} conditional-order smoke test 대기 시작.\n"
        "미국 시장이 완전히 CLOSED 상태가 되면 다시 알려드립니다. "
        "(이 알림은 감시만 하며, 어떤 주문도 자동으로 생성/취소하지 않습니다.)"
    )

    if wait:
        wait_for_closed_session(broker)

    session = classify_market_session(broker)
    if session != "CLOSED":
        # Should not normally happen right after wait_for_closed_session()
        # returns, but never claim CLOSED without a fresh check.
        return

    notifier.send_message(
        f"✅ 지금 미국 시장이 CLOSED 상태입니다 ({symbol}).\n"
        "터미널에서 아래 명령을 실행해 스모크 테스트를 진행하세요 "
        "(CREATE/DELETE는 직접 타이핑해서 승인해야 합니다):\n\n"
        f"python smoke_conditional_order.py --symbol {symbol} --env-file deploy/mumae.env"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--env-file", default="deploy/mumae.env")
    parser.add_argument("--no-wait", action="store_true", help="Send the notification immediately without polling for CLOSED")
    args = parser.parse_args()
    run(args.symbol, args.env_file, wait=not args.no_wait)


if __name__ == "__main__":
    main()
