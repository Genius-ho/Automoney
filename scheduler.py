"""Daily local dry-run scheduler. Uses only the Python standard library."""
from __future__ import annotations

import argparse
import time
from datetime import datetime
from decimal import Decimal

from application_engine import ApplicationEngine
from mumae_core import build_plan


def run_once(current_price: Decimal) -> None:
    engine = ApplicationEngine(".")
    state = engine.store.load()
    plan = build_plan(state, current_price)
    broker = engine.broker()
    if broker.mode == "LIVE":
        raise RuntimeError("Scheduler never sends live orders. Use the UI and its final confirmation dialog.")
    for order in plan.orders:
        print(broker.submit_order(order))
    for warning in plan.warnings:
        print(f"WARNING: {warning}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--time", default="23:00", help="local HH:MM")
    parser.add_argument("--price", default="100.00", help="reviewed current TQQQ price")
    args = parser.parse_args()
    price = Decimal(args.price)
    if args.once:
        run_once(price)
        return
    while True:
        if datetime.now().strftime("%H:%M") == args.time:
            run_once(price)
            time.sleep(61)
        time.sleep(1)


if __name__ == "__main__":
    main()
