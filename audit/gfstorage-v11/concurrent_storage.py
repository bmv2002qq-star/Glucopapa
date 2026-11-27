"""Two connections compete on synthetic CGM identity with the actual migrations."""
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

schema = Path("android-app/app/src/main/assets/db")
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp)/"race.db"
    with sqlite3.connect(path) as init:
        for version in range(1,11):
            init.executescript((schema/f"schema_v{version}.sql").read_text())
        assert init.execute("PRAGMA journal_mode=WAL").fetchone()==("wal",)
    barrier = Barrier(2)
    def insert(worker):
        db = sqlite3.connect(path, timeout=10)
        try:
            outcomes = []
            for i in range(40):
                barrier.wait(10)
                try:
                    with db:
                        db.execute("INSERT INTO v3_cgm VALUES(?,?,?,?,?,?,?,?,?)",
                                   (f"{worker}_{i}","test",f"2026-10-25T01:{i:02d}:00Z",
                                    6.0,"sensor","synthetic","ok","{}",i+1))
                    outcomes.append("commit")
                except sqlite3.IntegrityError:
                    outcomes.append("duplicate")
            return outcomes
        finally:
            db.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        left,right=pool.map(insert,("a","b"))
    assert all(sorted(pair)==["commit","duplicate"] for pair in zip(left,right))
    with sqlite3.connect(path) as check:
        assert check.execute("SELECT COUNT(*) FROM v3_cgm").fetchone()==(40,)
        assert check.execute("PRAGMA integrity_check").fetchone()==("ok",)
    print("40/40 concurrent key conflicts: one commit and one rejection, 40 durable rows")
