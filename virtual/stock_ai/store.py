from contextlib import contextmanager
from pathlib import Path
import json
import sqlite3
import threading


class Store:
    def __init__(self, path):
        self.path=Path(path)
        self.path.parent.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock()
        with sqlite3.connect(self.path) as connection:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

    @contextmanager
    def transaction(self):
        with self.lock:
            connection=sqlite3.connect(self.path,timeout=30)
            try:
                connection.execute('BEGIN IMMEDIATE')
                yield connection
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    def get(self,key,default=None,connection=None):
        if connection is None:
            with sqlite3.connect(self.path,timeout=30) as con:
                row=con.execute('SELECT value FROM kv WHERE key=?',(key,)).fetchone()
        else:
            row=connection.execute('SELECT value FROM kv WHERE key=?',(key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self,key,value,connection=None):
        encoded=json.dumps(value,ensure_ascii=False,allow_nan=False)
        if connection is None:
            with self.transaction() as con:
                con.execute('INSERT OR REPLACE INTO kv VALUES (?,?)',(key,encoded))
        else:
            connection.execute('INSERT OR REPLACE INTO kv VALUES (?,?)',(key,encoded))

    def keys(self,prefix):
        with sqlite3.connect(self.path) as con:
            return [r[0] for r in con.execute('SELECT key FROM kv WHERE key LIKE ? ORDER BY rowid DESC',(prefix+'%',))]
