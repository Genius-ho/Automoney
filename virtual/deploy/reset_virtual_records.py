"""Reset every virtual-trading record (user request 2026-10-13). Run with the app server stopped.

Keeps: analysis results, portfolio results, settings, price caches, job history, the fixed
351-stock B universe and B's holding configuration. Removes: all paper/comparison/strategy
ledgers, their scan archives and revision archives. A full backup is written first.

    python deploy/reset_virtual_records.py [--data-dir stock_ai_data]
"""
import argparse
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from stock_ai.strategy_two import METHOD
from stock_ai.universe_paper import UniverseSettings

PREFIXES = ('comparison_paper_a', 'comparison_paper_b', 'paper_comparison:revision:', 'strategy_',
            'universe_paper', 'universe_scan:', 'reserve:')
EXACT = ('paper',)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--data-dir', default=str(ROOT / 'stock_ai_data'))
    args = parser.parse_args()
    db = Path(args.data_dir) / 'stock-ai.sqlite'
    backups = Path(args.data_dir) / 'backups'; backups.mkdir(exist_ok=True)
    backup = backups / f"before-reset-{datetime.now().strftime('%Y%m%d-%H%M%S')}.sqlite"
    with sqlite3.connect(db) as src, sqlite3.connect(backup) as dst:
        src.backup(dst)
    with sqlite3.connect(db) as con:
        running = [k for k, v in con.execute("select key,value from kv where key like 'job:%'")
                   if json.loads(v).get('status') in ('queued', 'running')]
        if running: raise SystemExit('An app job is active; stop the server first.')
        keys = [k for (k,) in con.execute('select key from kv')]
        doomed = [k for k in keys if k in EXACT or (k.startswith(PREFIXES) and not k.startswith('strategy_') or
                                                     (k.startswith('strategy_') and k.endswith('_paper')))]
        old = con.execute("select value from kv where key='paper_comparison'").fetchone()
        meta = {'enabled': False, 'revision': 'initial', 'started_day': None, 'last_settled_day': None,
                'config': UniverseSettings(criterion='precision').model_dump(),
                'baseline_method': 'original-close-60-v1', 'improved_method': METHOD}
        if old:
            prev = json.loads(old[0])
            for k in ('b_universe', 'b_config'):
                if prev.get(k): meta[k] = prev[k]
        con.execute('BEGIN')
        for k in doomed: con.execute('delete from kv where key=?', (k,))
        con.execute('insert or replace into kv values (?,?)', ('paper_comparison', json.dumps(meta, ensure_ascii=False)))
        con.commit()
    print(json.dumps({'backup': str(backup), 'removed': len(doomed), 'removed_keys': doomed,
                      'kept_b_universe': len(meta.get('b_universe', {}).get('rows', []))}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
