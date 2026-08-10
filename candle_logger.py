"""Append newly available 1-minute candles to a local JSONL history file.

Toss only keeps roughly a day of intraday candle history (see
fetch_minute_candles in backtest_vwap_rsi.py -- pulling more pages than
that returns nothing new), so this has to run periodically to build up
enough history for a meaningful multi-day backtest. Safe to run as often
as every few hours: it merges by timestamp, so re-fetching the same
recent window is a no-op.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from backtest_vwap_rsi import Bar, TossBroker, fetch_minute_candles

DATA_DIR = Path("data/candles_1m")


def candle_path(symbol: str) -> Path:
    return DATA_DIR / f"{symbol.upper()}.jsonl"


def load_existing(symbol: str) -> dict[str, Bar]:
    path = candle_path(symbol)
    if not path.exists():
        return {}
    bars: dict[str, Bar] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        bars[row["timestamp"]] = Bar(
            timestamp=datetime.fromisoformat(row["timestamp"]),
            open=row["open"],
            high=row["high"],
            low=row["low"],
            close=row["close"],
            volume=row["volume"],
        )
    return bars


def save(symbol: str, bars_by_timestamp: dict[str, Bar]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ordered = sorted(bars_by_timestamp.values(), key=lambda bar: bar.timestamp)
    lines = [
        json.dumps({
            "timestamp": bar.timestamp.isoformat(),
            "open": bar.open,
            "high": bar.high,
            "low": bar.low,
            "close": bar.close,
            "volume": bar.volume,
        }, ensure_ascii=False)
        for bar in ordered
    ]
    candle_path(symbol).write_text("\n".join(lines) + "\n" if lines else "", encoding="utf-8")


def update_symbol(broker: TossBroker, symbol: str, *, max_pages: int = 15) -> tuple[int, int]:
    """Merge freshly fetched candles into the on-disk history.

    Returns (added_count, total_count).
    """
    existing = load_existing(symbol)
    before_count = len(existing)
    fetched = fetch_minute_candles(broker, symbol, max_pages=max_pages)
    for bar in fetched:
        existing[bar.timestamp.isoformat()] = bar
    save(symbol, existing)
    return len(existing) - before_count, len(existing)


def main() -> None:
    parser = argparse.ArgumentParser(description="Toss 1분봉을 로컬 JSONL로 누적 저장 (API 보관기간 한계 우회용)")
    parser.add_argument("symbols", nargs="*", default=["KORU"])
    parser.add_argument("--pages", type=int, default=15, help="1분봉 페이지 수 (실제 남아있는 만큼만 조회됨)")
    args = parser.parse_args()

    broker = TossBroker()
    for symbol in args.symbols:
        added, total = update_symbol(broker, symbol, max_pages=args.pages)
        print(f"{symbol}: 신규 {added}개 추가, 누적 {total}개 -> {candle_path(symbol)}")


if __name__ == "__main__":
    main()
