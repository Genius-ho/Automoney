"""Standalone VR5.0 CLI for Kiwoom accounts -- entirely separate program
from mumae_cli.py (the Toss-based 무한매수 engine).

--profile selects both the state file (data/vr_<profile>.json) and the
Kiwoom credentials file (deploy/kiwoom_<profile>.env), so the exact same
program can run independently for each child:

    python3 kiwoom/vr_cli.py init  --profile child1 --symbol TQQQ --cash 10000 --price 65.40
    python3 kiwoom/vr_cli.py init  --profile child2 --symbol SOXL --cash 10000 --price 22.10
    python3 kiwoom/vr_cli.py status --profile child1
    python3 kiwoom/vr_cli.py plan   --profile child1 --price 60.00
    python3 kiwoom/vr_cli.py tick   --profile child1   # needs kiwoom_api.py's
                                                         # broker methods finished first

No state or credentials are ever shared between profiles.
"""
from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

# Runs as a plain script (python3 kiwoom/vr_cli.py ...) from any working
# directory, e.g. a systemd ExecStart -- so the repo root (parent of this
# file's kiwoom/ package) has to be on sys.path before the package imports
# below will resolve.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kiwoom.kiwoom_api import KiwoomApiError, KiwoomBroker
from kiwoom.vr_engine import apply_trade, band, initialize_state, maybe_roll_cycle, plan_rebalance
from kiwoom.vr_state import VrStateStore


def _env_path(profile: str) -> str:
    return f"deploy/kiwoom_{profile}.env"


def cmd_init(args: argparse.Namespace) -> None:
    store = VrStateStore(args.profile, data_dir=args.data_dir)
    if store.exists() and not args.force:
        print(f"이미 존재하는 프로필입니다: {store.path} (다시 만들려면 --force)")
        return
    state = initialize_state(
        args.profile,
        args.symbol,
        args.price,
        args.cash,
        g=args.g,
        band_pct=args.band,
        contribution=args.contribution,
        cycle_length_days=args.cycle_days,
        pool_seed_pct=args.pool_seed_pct,
        pool_usage_cap_pct=args.pool_cap_pct,
    )
    store.save(state)
    print(f"프로필 '{args.profile}' 생성 완료 -> {store.path}")
    _print_status(state)


def cmd_status(args: argparse.Namespace) -> None:
    store = VrStateStore(args.profile, data_dir=args.data_dir)
    if not store.exists():
        print(f"프로필이 없습니다: {store.path} (먼저 init 하세요)")
        return
    _print_status(store.load())


def cmd_plan(args: argparse.Namespace) -> None:
    store = VrStateStore(args.profile, data_dir=args.data_dir)
    if not store.exists():
        print(f"프로필이 없습니다: {store.path} (먼저 init 하세요)")
        return
    state = store.load()
    today = date.today()
    rolled = maybe_roll_cycle(state, today)
    if rolled:
        print(f"사이클 갱신됨 -> 새 V: ${state.v:,.2f}")

    plan = plan_rebalance(state, args.price)
    if plan is None:
        low, high = band(state.v, state.band_pct)
        print(f"현재가 ${args.price:,.2f}는 밴드(${low:,.2f} ~ ${high:,.2f}) 안입니다. 거래 없음.")
    else:
        print(f"{plan.side} {plan.shares}주 @ ${plan.price:,.2f}")
        print(f"  거래 후 보유수량: {plan.resulting_shares}주, Pool: ${plan.resulting_pool:,.2f}")
        if args.apply:
            apply_trade(state, plan, today)

    if args.apply or rolled:
        store.save(state)
        print("상태 저장됨.")


def cmd_tick(args: argparse.Namespace) -> None:
    """The real automated path: fetch a live price and, if LIVE mode, submit
    the order through Kiwoom. Currently blocked on kiwoom_api.py's
    NotImplementedError getters/setters until the real endpoints are filled
    in -- see kiwoom/README.md."""
    store = VrStateStore(args.profile, data_dir=args.data_dir)
    if not store.exists():
        print(f"프로필이 없습니다: {store.path} (먼저 init 하세요)")
        return
    state = store.load()
    broker = KiwoomBroker(env_path=_env_path(args.profile))

    try:
        today = date.today()
        rolled = maybe_roll_cycle(state, today)
        quote = broker.get_us_prices_raw([state.symbol])
        price = float(quote["result"][0]["lastPrice"])
        plan = plan_rebalance(state, price)
        if plan is None:
            print(f"{state.symbol} ${price:,.2f} -- 밴드 안, 거래 없음.")
        else:
            broker.submit_us_order(state.symbol, plan.side.lower(), plan.shares, price)
            apply_trade(state, plan, today)
            print(f"{plan.side} {plan.shares}주 @ ${price:,.2f} 접수됨.")
        if rolled or plan is not None:
            store.save(state)
    except NotImplementedError as error:
        print(f"아직 구현 안 된 Kiwoom API 호출이 필요합니다: {error}", file=sys.stderr)
        print("kiwoom/README.md의 '다음에 할 일'을 먼저 완료하세요.", file=sys.stderr)
        sys.exit(1)
    except KiwoomApiError as error:
        print(f"Kiwoom API 오류: {error}", file=sys.stderr)
        sys.exit(1)


def _print_status(state) -> None:
    low, high = band(state.v, state.band_pct)
    print(f"프로필: {state.profile} ({state.symbol})")
    print(f"V: ${state.v:,.2f}  밴드: ${low:,.2f} ~ ${high:,.2f} (±{state.band_pct*100:.0f}%)")
    print(f"보유수량: {state.shares}주   Pool: ${state.pool:,.2f}")
    print(f"G={state.g}  적립금=${state.contribution}  사이클={state.cycle_length_days}일  Pool한도={state.pool_usage_cap_pct*100:.0f}%")
    print(f"사이클 시작일: {state.cycle_start_date}  완료된 사이클: {state.cycles_completed}  누적 거래: {len(state.trades)}건")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vr_cli", description="키움 VR5.0 자녀계좌 엔진 (독립 프로그램)")
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="새 프로필 생성")
    init.add_argument("--profile", required=True, help="예: child1, child2")
    init.add_argument("--symbol", required=True)
    init.add_argument("--cash", type=float, required=True)
    init.add_argument("--price", type=float, required=True, help="초기 매수 기준가")
    init.add_argument("--g", type=float, default=10.0)
    init.add_argument("--band", type=float, default=0.15)
    init.add_argument("--contribution", type=float, default=20.0)
    init.add_argument("--cycle-days", type=int, default=14)
    init.add_argument("--pool-seed-pct", type=float, default=0.10)
    init.add_argument("--pool-cap-pct", type=float, default=0.75)
    init.add_argument("--force", action="store_true", help="기존 프로필 덮어쓰기")
    init.add_argument("--data-dir", default="data")
    init.set_defaults(func=cmd_init)

    status = commands.add_parser("status", help="프로필 현재 상태 조회")
    status.add_argument("--profile", required=True)
    status.add_argument("--data-dir", default="data")
    status.set_defaults(func=cmd_status)

    plan = commands.add_parser("plan", help="주어진 가격으로 리밸런싱 계획만 계산 (기본: 저장 안 함)")
    plan.add_argument("--profile", required=True)
    plan.add_argument("--price", type=float, required=True)
    plan.add_argument("--apply", action="store_true", help="계획을 실제로 상태에 반영하고 저장")
    plan.add_argument("--data-dir", default="data")
    plan.set_defaults(func=cmd_plan)

    tick = commands.add_parser("tick", help="실시간 시세 조회 + 리밸런싱 실행 (Kiwoom API 완성 후 사용 가능)")
    tick.add_argument("--profile", required=True)
    tick.add_argument("--data-dir", default="data")
    tick.set_defaults(func=cmd_tick)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
