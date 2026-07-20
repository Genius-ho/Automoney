"""Headless command-line entry point for the Mumae application engine."""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path
from typing import Any, Sequence, TextIO

from application_engine import ApplicationEngine

SECRET_FIELDS = {"clientsecret", "password", "webpassword", "csrf", "accesstoken"}


def _public(value: Any, key: str = "") -> Any:
    if key.lower().replace("_", "") in SECRET_FIELDS:
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(name): _public(item, str(name)) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_public(item) for item in value]
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mumae", description="무한매수 CLI 엔진")
    parser.add_argument(
        "--data-dir",
        default=os.getenv("MUMAE_DATA_DIR", "data"),
        help="상태·감사 로그 저장 경로",
    )
    parser.add_argument("--json", action="store_true", help="JSON 형식으로 출력")
    commands = parser.add_subparsers(dest="command", required=True)

    status = commands.add_parser("status", help="엔진 상태 조회")
    status.add_argument("symbol")

    refresh = commands.add_parser("refresh", help="계좌·시세 동기화")
    refresh.add_argument("symbol")

    strategy = commands.add_parser("strategy-set", help="전략 상태 변경")
    strategy.add_argument("symbol")
    strategy.add_argument("--t", dest="t_value")
    strategy.add_argument("--cash", dest="cash_usd")
    strategy.add_argument("--quantity", dest="position_qty", type=int)
    strategy.add_argument("--average", dest="avg_cost")
    strategy.add_argument("--base-buy-qty", dest="base_buy_qty", type=int)
    strategy.add_argument("--mode")
    strategy.add_argument("--big-pct", dest="big_number_pct")
    strategy.add_argument("--big-enabled", dest="big_number_enabled", action="store_true")

    plan = commands.add_parser("plan", help="전략값 저장 및 주문계획 계산")
    plan.add_argument("symbol")
    plan.add_argument("--current", dest="current_price", required=True)
    plan.add_argument("--previous", dest="previous_close")
    plan.add_argument("--t", dest="t_value")
    plan.add_argument("--cash", dest="cash_usd")
    plan.add_argument("--quantity", dest="position_qty", type=int)
    plan.add_argument("--average", dest="avg_cost")
    plan.add_argument("--base-buy-qty", dest="base_buy_qty", type=int)
    plan.add_argument("--mode")

    edit = commands.add_parser("edit-price", help="실패 주문 지정가 변경")
    edit.add_argument("symbol")
    edit.add_argument("id")
    edit.add_argument("price")

    submit = commands.add_parser("submit", help="선택 주문 제출")
    submit.add_argument("symbol")
    submit.add_argument("ids", nargs="+")
    submit.add_argument("--confirm", required=True)

    cancel = commands.add_parser("cancel", help="선택 주문 취소")
    cancel.add_argument("symbol")
    cancel.add_argument("ids", nargs="+")
    cancel.add_argument("--confirm", required=True)

    auto_start = commands.add_parser("auto-start", help="자동매매 시작")
    auto_start.add_argument("symbol")
    auto_start.add_argument("--confirm", required=True)

    auto_stop = commands.add_parser("auto-stop", help="자동매매 중지")
    auto_stop.add_argument("symbol")

    api_set = commands.add_parser("api-set", help="토스 API 설정")
    api_set.add_argument("--client-id", required=True)
    api_set.add_argument("--client-secret", required=True)
    api_set.add_argument("--account-seq", required=True)
    api_set.add_argument("--live", action="store_true")

    commands.add_parser("api-reconnect", help="토스 API 연결 재생성")
    errors = commands.add_parser("errors", help="최근 엔진 변경·오류 기록")
    errors.add_argument("--limit", type=int, default=30)

    serve = commands.add_parser("serve", help="CLI 엔진과 관리 API 실행")
    serve.add_argument("--host", default=os.getenv("MUMAE_WEB_HOST", "127.0.0.1"))
    serve.add_argument("--port", type=int, default=int(os.getenv("MUMAE_WEB_PORT", "8765")))
    serve.add_argument("--open", action="store_true", help="관리 화면을 브라우저로 열기")
    return parser


def _payload(args: argparse.Namespace, *names: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in names:
        value = getattr(args, name, None)
        if value is not None:
            result[name] = value
    return result


def dispatch(args: argparse.Namespace, engine: ApplicationEngine) -> Any:
    symbol = str(getattr(args, "symbol", "")).upper()
    actor = getpass.getuser()
    if args.command == "status":
        return engine.snapshot(symbol)
    if args.command == "refresh":
        return engine.execute("account.refresh", {"symbol": symbol}, source="CLI", actor=actor)
    if args.command == "strategy-set":
        payload = {"symbol": symbol, **_payload(
            args,
            "t_value",
            "cash_usd",
            "position_qty",
            "avg_cost",
            "base_buy_qty",
            "mode",
            "big_number_pct",
            "big_number_enabled",
        )}
        return engine.execute("strategy.update", payload, source="CLI", actor=actor)
    if args.command == "plan":
        payload = {"symbol": symbol, **_payload(
            args,
            "current_price",
            "previous_close",
            "t_value",
            "cash_usd",
            "position_qty",
            "avg_cost",
            "base_buy_qty",
            "mode",
        )}
        return engine.execute("plan.calculate", payload, source="CLI", actor=actor)
    if args.command == "edit-price":
        return engine.execute(
            "order.edit_price",
            {"symbol": symbol, "id": args.id, "price": args.price},
            source="CLI",
            actor=actor,
        )
    if args.command in {"submit", "cancel"}:
        command = "order.submit" if args.command == "submit" else "order.cancel"
        return engine.execute(
            command,
            {"symbol": symbol, "ids": args.ids, "confirmation": args.confirm},
            source="CLI",
            actor=actor,
        )
    if args.command == "auto-start":
        return engine.execute(
            "auto.start",
            {"symbol": symbol, "confirmation": args.confirm},
            source="CLI",
            actor=actor,
        )
    if args.command == "auto-stop":
        return engine.execute("auto.stop", {"symbol": symbol}, source="CLI", actor=actor)
    if args.command == "api-set":
        return engine.execute(
            "api.update",
            {
                "client_id": args.client_id,
                "client_secret": args.client_secret,
                "account_seq": args.account_seq,
                "live_trading": args.live,
            },
            source="CLI",
            actor=actor,
        )
    if args.command == "api-reconnect":
        return engine.execute("api.reconnect", {}, source="CLI", actor=actor)
    if args.command == "errors":
        return {"entries": engine.audit_entries()[-args.limit:]}
    if args.command == "serve":
        from web_gui.dashboard.server import run

        return run(
            host=args.host,
            port=args.port,
            data_dir=Path(args.data_dir),
            open_browser=args.open,
            engine=engine,
        )
    raise ValueError("지원하지 않는 CLI 명령입니다.")


def render(value: Any, *, json_mode: bool, stream: TextIO) -> None:
    public = _public(value)
    if json_mode:
        json.dump(public, stream, ensure_ascii=False, separators=(",", ":"))
    else:
        json.dump(public, stream, ensure_ascii=False, indent=2)
    stream.write("\n")


def main(
    argv: Sequence[str] | None = None,
    *,
    engine: ApplicationEngine | None = None,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    app = engine or ApplicationEngine(Path(args.data_dir))
    try:
        result = dispatch(args, app)
    except Exception as error:
        print(str(error), file=stderr)
        return 1
    if args.command != "serve":
        render(result, json_mode=args.json, stream=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
