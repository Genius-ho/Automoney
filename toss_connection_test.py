"""Read-only Toss Open API connection test. It never creates, changes, or cancels orders."""
from __future__ import annotations

import json

from toss_api import TossApiError, TossBroker


def print_json(title: str, value: dict) -> None:
    print(f"\n--- {title} ---")
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main() -> None:
    broker = TossBroker()
    try:
        accounts = broker.list_accounts()
        print_json("Account list", accounts)
        if not broker.account_seq:
            print("\nNext: copy the desired account sequence into TOSS_ACCOUNT_SEQ in .env, then run this command again.")
            return
        print_json("Holdings (read-only)", broker.get_holdings_raw())
        print_json("Buying power (read-only)", broker.get_buying_power_raw())
        print("\nConnection test succeeded. No order was sent.")
    except TossApiError as error:
        print(f"Connection test failed: {error}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
