"""Build dist/stock-ai-linux-<timestamp>.tar.gz to move this app to a Linux server.

Safe while the Windows server is running: the SQLite database is copied with SQLite's online
backup API, so the snapshot is consistent. Contents: code, static files, tests, deploy files,
and stock_ai_data (database snapshot, price caches, reports). Excluded: virtualenvs, caches,
logs, local backups, research folders under docs/.

    .venv-stock-ai\\Scripts\\python.exe deploy\\package_for_linux.py
"""
from datetime import datetime
import io
from pathlib import Path
import sqlite3
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CODE = ['stock_ai', 'static', 'tests', 'deploy', 'stock_ai_analyzer.py', 'requirements-stock-ai.txt',
        'start_stock_ai.sh', 'pytest.ini', 'STOCK_AI_README.md']
DATA_SKIP = {'backups', 'stock-ai.sqlite', 'stock-ai.sqlite-wal', 'stock-ai.sqlite-shm', 'server-output.log', 'server-error.log'}


def add(tar, path, arc):
    if path.is_dir():
        for child in sorted(path.iterdir()):
            if child.name in ('__pycache__', '.pytest_cache') or child.suffix == '.pyc': continue
            add(tar, child, f'{arc}/{child.name}')
        return
    info = tar.gettarinfo(str(path), arc)
    info.mode = 0o755 if path.suffix == '.sh' else 0o644
    with open(path, 'rb') as f: tar.addfile(info, f)


def main():
    dist = ROOT / 'dist'; dist.mkdir(exist_ok=True)
    out = dist / f"stock-ai-linux-{datetime.now().strftime('%Y%m%d-%H%M')}.tar.gz"
    with tempfile.TemporaryDirectory() as tmp, tarfile.open(out, 'w:gz') as tar:
        for name in CODE:
            p = ROOT / name
            if p.exists(): add(tar, p, f'stock-ai/{name}')
        data = ROOT / 'stock_ai_data'
        for child in sorted(data.iterdir()):
            if child.name not in DATA_SKIP: add(tar, child, f'stock-ai/stock_ai_data/{child.name}')
        snap = Path(tmp) / 'stock-ai.sqlite'
        src, dst = sqlite3.connect(data / 'stock-ai.sqlite'), sqlite3.connect(snap)
        try: src.backup(dst)
        finally: dst.close(); src.close()  # Windows keeps the file locked until closed
        add(tar, snap, 'stock-ai/stock_ai_data/stock-ai.sqlite')
    print(out, f'{out.stat().st_size / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
