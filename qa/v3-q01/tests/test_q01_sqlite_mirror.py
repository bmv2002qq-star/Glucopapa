"""Q01 SQLite host mirror of GFStorage V3 schema v1-v7 + staged owner-intent semantics.
This is NOT execution of Android Kotlin or an Android device test.
"""
import copy
import os
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

BASE=Path(os.environ['GFV3_APPROVED_ROOT'])/'android-app/app/src/main/assets/db' if 'GFV3_APPROVED_ROOT' in os.environ else Path(__file__).resolve().parents[2]/'m03/android-app/app/src/main/assets/db'
SCHEMAS=[BASE/f'schema_v{i}.sql' for i in range(1,8)]
SLOTS=['00-06','06-12','12-18','18-00']
KINDS=['carb_g_per_u','isf_mmol_per_u']

def control():
    return {'schema':1,'modes':{k:{slot:'manual' for slot in SLOTS} for k in KINDS},'autoEngineStatus':'NOT_CONNECTED_Q16'}

def validate(v):
    assert isinstance(v,dict) and set(v)=={'schema','modes','autoEngineStatus'}
    assert v['schema']==1 and v['autoEngineStatus']=='NOT_CONNECTED_Q16'
    assert set(v['modes'])==set(KINDS)
    for kind in KINDS:
        assert set(v['modes'][kind])==set(SLOTS)
        assert set(v['modes'][kind].values())<=set(['manual','auto'])

class GFStorageSqliteMirror:
    def __init__(self, filename):
        self.db=sqlite3.connect(filename)
        self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        for path in SCHEMAS: self.db.executescript(path.read_text())
        self.db.execute("UPDATE v3_meta SET profile_id=?,timezone=?,revision=1,input_revision=1 WHERE id=1",('PROFILE_QA','Europe/Minsk'))
        self.db.execute("INSERT OR REPLACE INTO v3_module_registry(module_id,system_id,version,status,feature_enabled,read_roles_json,write_roles_json) VALUES(?,?,?,?,?,?,?)",('GFSettings','SYS-10','Q01_CANDIDATE','NOT_CONNECTED',0,'["settings"]','["settingsWriter","coefficientWriter"]'))
        for role in ['settingsWriter','coefficientWriter']:
            self.db.execute('INSERT OR REPLACE INTO v3_write_grants(module_id,role,grant_status,implementation_status,granted_by) VALUES(?,?,?,?,?)',('GFSettings',role,'OWNER_GRANTED_EXPERIMENTAL','PREPARED_NATIVE','OWNER_EXPLICIT_REQUEST_20261121'))
        self.db.commit()
    def accept_qa(self):
        # Only a local host fixture. Never install as real OWNER_INTEGRATION_ACCEPTED.
        self.db.execute("UPDATE v3_module_registry SET status='OWNER_INTEGRATION_ACCEPTED',feature_enabled=1 WHERE module_id='GFSettings'")
        self.db.commit()
    def meta(self): return dict(self.db.execute('SELECT revision,input_revision,profile_id,timezone FROM v3_meta WHERE id=1').fetchone())
    def setting(self,k):
        r=self.db.execute('SELECT value_json FROM v3_profile_settings WHERE setting_key=? AND profile_id=?',(k,'PROFILE_QA')).fetchone()
        return json.loads(r['value_json']) if r else None
    def rows(self,k): return self.db.execute(f'SELECT * FROM {k}').fetchall()
    def apply(self, intent):
        assert intent['profileId']=='PROFILE_QA'
        assert intent['ownerConfirmed'] is True
        role=intent['role']; payload=intent['payload']; idempotency=intent['idempotencyKey']; rev=intent['expectedRevision']
        cur=self.db.cursor()
        try:
            cur.execute('BEGIN IMMEDIATE')
            permit=cur.execute("SELECT 1 FROM v3_module_registry WHERE module_id='GFSettings' AND status='OWNER_INTEGRATION_ACCEPTED' AND feature_enabled=1 AND write_roles_json LIKE ?",('%'+role+'%',)).fetchone()
            grant=cur.execute("SELECT 1 FROM v3_write_grants WHERE module_id='GFSettings' AND role=? AND grant_status='OWNER_GRANTED_EXPERIMENTAL' AND implementation_status='PREPARED_NATIVE'",(role,)).fetchone()
            if not permit or not grant: raise PermissionError('NATIVE_WRITER_PERMISSION_DENIED')
            meta=self.meta()
            if meta['revision']!=rev:raise ValueError('V3_REVISION_CONFLICT')
            if cur.execute('SELECT 1 FROM v3_extended_receipts WHERE idempotency_key=?',(idempotency,)).fetchone():raise ValueError('REPLAY_RECEIPT')
            if cur.execute('SELECT 1 FROM v3_write_receipts WHERE idempotency_key=?',(idempotency,)).fetchone():raise ValueError('REPLAY_RECEIPT')
            next_rev=rev+1
            if role=='settingsWriter':
                k=payload['settingKey'];v=payload['value'];rid=payload['settingChangeId']
                if k=='coefficientModeControls':validate(v)
                elif k=='nutritionReference':
                    assert set(v['daily'])=={'protein','fat','carbs','kcal'}
                    assert all(v['daily'][key]>0 for key in ['protein','fat','carbs','kcal'])
                elif k=='childProfile':
                    zone=v.get('timeZone');assert zone and ZoneInfo(zone)
                    cur.execute('UPDATE v3_meta SET timezone=? WHERE id=1 AND profile_id=?',(zone,'PROFILE_QA'))
                old=self.setting(k)
                cur.execute('INSERT OR REPLACE INTO v3_profile_settings VALUES (?,?,?,?)',('PROFILE_QA',k,json.dumps(v,ensure_ascii=False),next_rev))
                cur.execute('INSERT INTO v3_setting_history(entry_id,profile_id,setting_key,old_value_json,new_value_json,source_module,changed_at_utc,created_revision,effective_at_utc) VALUES (?,?,?,?,?,?,?,?,?)',(rid,'PROFILE_QA',k,json.dumps(old,ensure_ascii=False) if old is not None else None,json.dumps(v,ensure_ascii=False),'GFSettings','2026-11-22T15:00:00Z',next_rev,payload['effectiveAtUtc']))
                cur.execute('INSERT INTO v3_extended_receipts VALUES (?,?,?,?,?,?,?)',(idempotency,'PROFILE_QA','settings',rid,'sha-qa-mirror',next_rev,'GFSettings'))
                cur.execute('INSERT INTO v3_extended_change_feed VALUES (?,?,?,?,?)',(next_rev,'settings',rid,'2026-11-22T15:00:00Z','GFSettings'))
            elif role=='coefficientWriter':
                rid=payload['coefficientId'];kind=payload['kind'];slot=payload['slotId'];value=payload['value']
                if kind in KINDS:assert slot in SLOTS
                else: assert kind in ['illness_factor','activity_factor'] and slot is None
                assert value>0 and payload['mode']=='manual' and payload['ownerApproved'] is True
                cur.execute('INSERT INTO v3_coefficients(coefficient_id,profile_id,kind,slot_id,value,mode,source,effective_from_utc,created_revision) VALUES (?,?,?,?,?,?,?,?,?)',(rid,'PROFILE_QA',kind,slot,value,'manual','OWNER_MANUAL',payload['effectiveFromUtc'],next_rev))
                cur.execute('INSERT INTO v3_coefficient_history(history_id,profile_id,coefficient_id,kind,slot_id,old_value,new_value,old_mode,new_mode,applied_at_utc,source,created_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',('HISTORY_'+rid,'PROFILE_QA',rid,kind,slot,None,value,None,'manual','2026-11-22T15:00:00Z','GFSettings',next_rev))
                cur.execute('INSERT INTO v3_write_receipts VALUES (?,?,?,?,?,?,?)',(idempotency,'PROFILE_QA','settings',rid,'sha-qa-mirror',next_rev,'GFSettings'))
                cur.execute('INSERT INTO v3_audit VALUES (?,?,?,?,?,?)',(next_rev,'settings',rid,'coefficientWriter','GFSettings','2026-11-22T15:00:00Z'))
                cur.execute('INSERT INTO v3_change_feed VALUES (?,?,?,?,?)',(next_rev,'settings',rid,'GFSettings','2026-11-22T15:00:00Z'))
            else:raise PermissionError('WRITER_ROLE_UNSUPPORTED')
            cur.execute('UPDATE v3_meta SET revision=?,input_revision=? WHERE id=1 AND revision=?',(next_rev,next_rev,rev))
            if cur.rowcount!=1:raise ValueError('REVISION_MISMATCH')
            self.db.commit();return next_rev
        except Exception:
            self.db.rollback();raise
    def close(self):self.db.close()

def intent(role,key,payload,rev=1):return {'type':'GFSETTINGS_V3_OWNER_INTENT','role':role,'command':'setting' if role=='settingsWriter' else 'coefficient','profileId':'PROFILE_QA','expectedRevision':rev,'idempotencyKey':key,'ownerConfirmed':True,'payload':payload}

class Q01StorageIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'s.db';self.m=GFStorageSqliteMirror(self.path)
    def tearDown(self):self.m.close();self.tmp.cleanup()
    def test_all_schema_files_apply(self):self.assertEqual(self.m.db.execute('PRAGMA user_version').fetchone()[0],0)
    def test_unapproved_module_denied_atomic(self):
        old=self.m.meta();v=control();v['modes']['carb_g_per_u']['00-06']='auto'
        with self.assertRaises(PermissionError):self.m.apply(intent('settingsWriter','ID_DENIED_123',{'settingChangeId':'SETTING_001','settingKey':'coefficientModeControls','value':v,'effectiveAtUtc':'2026-11-22T15:00:00Z'}))
        self.assertEqual(self.m.meta(),old);self.assertEqual(len(self.m.rows('v3_setting_history')),0)
    def test_authorized_mode_persists_after_restart(self):
        self.m.accept_qa();v=control();v['modes']['isf_mmol_per_u']['18-00']='auto';self.assertEqual(self.m.apply(intent('settingsWriter','ID_MODE_0001',{'settingChangeId':'SETTING_MODE1','settingKey':'coefficientModeControls','value':v,'effectiveAtUtc':'2026-11-22T15:00:00Z'})),2)
        self.m.close();self.m=GFStorageSqliteMirrorRestart(self.path)
        self.assertEqual(self.m.setting('coefficientModeControls')['modes']['isf_mmol_per_u']['18-00'],'auto')
        self.assertEqual(len(self.m.rows('v3_coefficients')),0)
        self.assertEqual(len(self.m.rows('v3_setting_history')),1)
    def test_bad_modes_rollback(self):
        self.m.accept_qa();v=control();v['modes']['carb_g_per_u']['12-18']='research'
        with self.assertRaises(AssertionError):self.m.apply(intent('settingsWriter','ID_BADMODE_01',{'settingChangeId':'SETTING_BAD','settingKey':'coefficientModeControls','value':v,'effectiveAtUtc':'2026-11-22T15:00:00Z'}))
        self.assertEqual(self.m.meta()['revision'],1);self.assertEqual(len(self.m.rows('v3_setting_history')),0)
    def test_nutrition_m02_contract(self):
        self.m.accept_qa();v={'daily':{'protein':40,'fat':55,'carbs':190,'kcal':1400},'source':'OWNER_MANUAL'}
        self.m.apply(intent('settingsWriter','ID_NUTR_0001',{'settingChangeId':'SETTING_NUTR','settingKey':'nutritionReference','value':v,'effectiveAtUtc':'2026-11-22T15:00:00Z'}))
        self.assertEqual(self.m.setting('nutritionReference')['daily']['carbs'],190)
    def test_stale_revision_is_atomic(self):
        self.m.accept_qa();v=control();p={'settingChangeId':'SETTING_0001','settingKey':'coefficientModeControls','value':v,'effectiveAtUtc':'2026-11-22T15:00:00Z'}
        self.m.apply(intent('settingsWriter','ID_ONCE_0001',p))
        with self.assertRaisesRegex(ValueError,'V3_REVISION_CONFLICT'):self.m.apply(intent('settingsWriter','ID_BADREV_02',p,rev=1))
        self.assertEqual(self.m.meta()['revision'],2);self.assertEqual(len(self.m.rows('v3_setting_history')),1)
    def test_manual_coefficient_commit_and_history(self):
        self.m.accept_qa();p={'coefficientId':'COEFF_00001','kind':'carb_g_per_u','slotId':'06-12','value':10,'mode':'manual','source':'OWNER_MANUAL','effectiveFromUtc':'2026-11-22T15:00:00Z','ownerApproved':True}
        self.m.apply(intent('coefficientWriter','ID_COEFF_0001',p));self.assertEqual(len(self.m.rows('v3_coefficients')),1);self.assertEqual(len(self.m.rows('v3_coefficient_history')),1);self.assertEqual(self.m.meta()['revision'],2)
    def test_wrong_slot_and_daily_slot_rollback(self):
        self.m.accept_qa()
        for kind,slot in [('carb_g_per_u','08-14'),('isf_mmol_per_u',None),('illness_factor','06-12')]:
            p={'coefficientId':'COEFF_BAD01','kind':kind,'slotId':slot,'value':10,'mode':'manual','source':'OWNER_MANUAL','effectiveFromUtc':'2026-11-22T15:00:00Z','ownerApproved':True}
            with self.assertRaises(AssertionError):self.m.apply(intent('coefficientWriter','ID_COEFF_BAD1',p))
        self.assertEqual(self.m.meta()['revision'],1)
    def test_timezone_one_atomic_change(self):
        self.m.accept_qa();p={'settingChangeId':'SETTING_TZ01','settingKey':'childProfile','value':{'displayName':'Тест','birthDate':'2019-02-02','timeZone':'Europe/Warsaw'},'effectiveAtUtc':'2026-11-22T15:00:00Z'}
        self.m.apply(intent('settingsWriter','ID_ZONE_0001',p));self.assertEqual(self.m.meta()['timezone'],'Europe/Warsaw');self.assertEqual(self.m.setting('childProfile')['timeZone'],'Europe/Warsaw');self.assertEqual(len(self.m.rows('v3_setting_history')),1)
    def test_bad_timezone_rollback(self):
        self.m.accept_qa();p={'settingChangeId':'SETTING_TZ02','settingKey':'childProfile','value':{'displayName':'Тест','birthDate':'2019-02-02','timeZone':'Mars/Olympus'},'effectiveAtUtc':'2026-11-22T15:00:00Z'}
        with self.assertRaises(Exception):self.m.apply(intent('settingsWriter','ID_ZONE_0002',p))
        self.assertEqual(self.m.meta()['timezone'],'Europe/Minsk');self.assertEqual(self.m.meta()['revision'],1)
    def test_no_other_medical_domain_created(self):
        self.m.accept_qa();v=control();self.m.apply(intent('settingsWriter','ID_SETP_0001',{'settingChangeId':'SETTING_3001','settingKey':'coefficientModeControls','value':v,'effectiveAtUtc':'2026-11-22T15:00:00Z'}))
        self.assertEqual(sum(len(self.m.rows(t)) for t in ['v3_events','v3_cgm','v3_forecasts','v3_meal_sessions','v3_condition_periods']),0)

class GFStorageSqliteMirrorRestart(GFStorageSqliteMirror):
    def __init__(self,path):self.db=sqlite3.connect(path);self.db.row_factory=sqlite3.Row

if __name__=='__main__':unittest.main(verbosity=2)
