"""Run from reconstructed q07-ci with Python 3. Uses temporary synthetic databases."""
import json
import sqlite3
import statistics
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import perf_counter_ns

schema = Path("android-app/app/src/main/assets/db")
insert = "INSERT INTO v3_cgm VALUES(?,?,?,?,?,?,?,?,?)"
page = "SELECT rowid,* FROM v3_cgm NOT INDEXED WHERE profile_id=? AND rowid>? ORDER BY rowid ASC LIMIT 501"

def sample(i, profile="audit", device="sensor"):
    timestamp = datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=5*i)
    return (f"{profile}/{device}/{i}", profile, timestamp.isoformat(), 6.0, device,
            "synthetic", "ok", "{}", i+1)

def timed(action):
    start = perf_counter_ns()
    action()
    return (perf_counter_ns()-start)/1000000

def summary(values):
    cuts = statistics.quantiles(values, n=100, method="inclusive")
    return dict(zip(("p50_ms","p95_ms","p99_ms"),(cuts[49],cuts[94],cuts[98])))

def run(path, days):
    db = sqlite3.connect(path)
    for version in range(1,11):
        db.executescript((schema/f"schema_v{version}.sql").read_text())
    count = days*288
    with db:
        db.executemany(insert,(sample(i) for i in range(count)))
        db.execute(insert,sample(0,"other"))
        db.execute(insert,sample(0,device="second"))
    try:
        with db:
            db.execute(insert,sample(count))
            db.execute(insert,sample(0))
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("duplicate accepted")
    assert db.execute("SELECT COUNT(*) FROM v3_cgm").fetchone()[0]==count+2
    before = db.total_changes
    reads = []
    for i in range(120):
        rows = []
        reads.append(timed(lambda: rows.extend(db.execute(page,("audit",i*max(0,count-501)//119)))))
        assert all(row[2]=="audit" for row in rows)
    assert db.total_changes==before
    writes = []
    def write(i):
        with db:
            db.execute(insert,sample(i))
    for i in range(count,count+120):
        writes.append(timed(lambda:write(i)))
    db.close()
    with sqlite3.connect(path) as reopened:
        assert reopened.execute("PRAGMA integrity_check").fetchone()==("ok",)
        assert reopened.execute("SELECT COUNT(*) FROM v3_cgm").fetchone()[0]==count+122
        plan=reopened.execute("EXPLAIN QUERY PLAN "+page,("audit",0)).fetchall()
    return dict(days=days,initial_rows=count+2,bytes=path.stat().st_size,read=summary(reads),write=summary(writes),plan=plan)

with tempfile.TemporaryDirectory() as tmp:
    print(json.dumps([run(Path(tmp)/f"{days}.db",days) for days in (1,30,365)],indent=2))
