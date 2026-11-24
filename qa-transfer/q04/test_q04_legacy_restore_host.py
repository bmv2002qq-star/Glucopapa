"""Independent SQLite stage/restore mirror of Android Q02 v7->v8 migration.
Does not execute the Kotlin Android code or exercise Android Keystore/AES-GCM.
"""
from pathlib import Path
import sqlite3, tempfile, shutil, hashlib, json
DB=Path(__file__).resolve().parents[1]/'android-app/app/src/main/assets/db'

def build(path,v):
    db=sqlite3.connect(path,isolation_level=None)
    db.execute('PRAGMA foreign_keys=ON')
    for i in range(1,v+1): db.executescript((DB/f'schema_v{i}.sql').read_text())
    db.execute(f'PRAGMA user_version={v}')
    db.execute("UPDATE v3_meta SET profile_id='qa-q04',timezone='UTC' WHERE id=1")
    db.close()

def fingerprint(db):
    rows=db.execute("SELECT type,name,tbl_name,coalesce(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'android_metadata' ORDER BY type,name").fetchall()
    return hashlib.sha256('\n'.join('\0'.join(map(str,row)) for row in rows).encode()).hexdigest()

def tables(db):
    return [x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'android_metadata' ORDER BY name")]

def v(db):return db.execute('PRAGMA user_version').fetchone()[0]
def rev(db):return db.execute('SELECT revision FROM v3_meta WHERE id=1').fetchone()[0]

def stage_and_restore(source,target,manifest,simulate_failure=False):
    # The encrypted envelope and its authenticated manifest were checked before reaching this method.
    with tempfile.TemporaryDirectory() as td:
        stage=Path(td)/'migration-copy.db';shutil.copyfile(source,stage)
        src=sqlite3.connect(stage,isolation_level=None)
        original=v(src)
        assert original in (7,8) and manifest['sqliteUserVersion']==original
        assert fingerprint(src)==manifest['schemaFingerprint']
        assert rev(src)==manifest['revision']
        assert src.execute('PRAGMA quick_check').fetchone()[0]=='ok'
        if original==7:
            src.execute('BEGIN IMMEDIATE')
            try:
                # executescript manages its own transaction; apply statements individually like Android.
                script=(DB/'schema_v8.sql').read_text()
                for stmt in script.split(';'):
                    stmt='\n'.join(ln for ln in stmt.splitlines() if not ln.strip().startswith('--')).strip()
                    if stmt:src.execute(stmt)
                src.execute('PRAGMA user_version=8');src.execute('COMMIT')
            except Exception:src.execute('ROLLBACK');raise
        assert v(src)==8 and rev(src)==manifest['revision']
        live=sqlite3.connect(target,isolation_level=None)
        try:
            assert v(live)==8
            assert fingerprint(src)==fingerprint(live)
            assert tables(src)==tables(live)
            target_before=live.execute('SELECT revision FROM v3_meta').fetchone()[0]
            live.execute('PRAGMA foreign_keys=OFF')
            live.execute('ATTACH DATABASE ? AS q02source',(str(stage),))
            live.execute('BEGIN IMMEDIATE')
            try:
                assert rev(live)==target_before
                for name in tables(live):
                    live.execute(f'DELETE FROM "{name}"')
                    live.execute(f'INSERT INTO "{name}" SELECT * FROM q02source."{name}"')
                assert rev(live)==manifest['revision']
                assert not list(live.execute('PRAGMA foreign_key_check'))
                if simulate_failure: raise RuntimeError('Q02_INJECTED_FAILURE')
                live.execute('COMMIT')
            except Exception:
                live.execute('ROLLBACK');raise
            finally:
                live.execute('DETACH DATABASE q02source')
                live.execute('PRAGMA foreign_keys=ON')
        finally:live.close();src.close()

results=[]
with tempfile.TemporaryDirectory() as root:
    root=Path(root)
    old=root/'legacy-v7.db';live=root/'live-v8.db';build(old,7);build(live,8)
    b=old.read_bytes()
    s=sqlite3.connect(old);manifest=dict(sqliteUserVersion=v(s),schemaFingerprint=fingerprint(s),revision=rev(s));s.close()
    curr=sqlite3.connect(live,isolation_level=None)
    curr.execute("UPDATE v3_meta SET revision=8,input_revision=8 WHERE id=1")
    curr.close()
    stage_and_restore(old,live,manifest)
    now=sqlite3.connect(live)
    assert v(now)==8 and rev(now)==0
    assert 'v3_nutrition_drafts' in tables(now)
    assert now.execute('SELECT COUNT(*) FROM v3_nutrition_drafts').fetchone()==(0,)
    now.close();assert old.read_bytes()==b
    results.append('legacy_v7_roundtrip_to_live_v8_preserves_source')
    curr=sqlite3.connect(live,isolation_level=None)
    curr.execute("UPDATE v3_meta SET revision=7,input_revision=7 WHERE id=1")
    curr.close()
    try:stage_and_restore(old,live,dict(manifest,schemaFingerprint='forged'))
    except AssertionError:pass
    else:raise AssertionError('forged schema accepted')
    curr=sqlite3.connect(live)
    assert rev(curr)==7;curr.close();results.append('forged_manifest_rejected_without_current_change')
    try:stage_and_restore(old,live,manifest,simulate_failure=True)
    except RuntimeError as ex:assert str(ex)=='Q02_INJECTED_FAILURE'
    else:raise AssertionError('injected failure accepted')
    curr=sqlite3.connect(live)
    assert rev(curr)==7;curr.close();results.append('transaction_failure_rolls_back_current_db')
    try:stage_and_restore(old,live,dict(manifest,sqliteUserVersion=6))
    except AssertionError:pass
    else:raise AssertionError('v6 spoof accepted')
    results.append('schema_mismatch_rejected')
print(json.dumps({'status':'PASS','cases':results,'count':len(results),'scope':'host sqlite mirror, not native Android Kotlin'},ensure_ascii=False))