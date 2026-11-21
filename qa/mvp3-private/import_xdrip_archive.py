"""Convert private xDrip exports into a validated-input candidate. Outputs contain health data."""
import argparse
import csv
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
from zipfile import ZipFile
from zoneinfo import ZoneInfo

COLUMNS = ['DAY', 'TIME', 'UDT_CGMS', 'BG_LEVEL', 'CH_GR', 'BOLUS', 'REMARK']
MONTHS = {'октября': 10, 'ноября': 11}


def read_export(path, zone):
    with ZipFile(path) as archive:
        entries = [name for name in archive.namelist() if name.lower().endswith('.csv')]
        if len(entries) != 1:
            raise ValueError('CSV_ARCHIVE_CONTRACT')
        raw = archive.read(entries[0])
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')), delimiter=';')
    if reader.fieldnames != COLUMNS:
        raise ValueError('CSV_COLUMNS')
    sensor, meter = {}, set()
    for line, row in enumerate(reader, 2):
        if None in row or any(value is None for value in row.values()):
            raise ValueError(f'CSV_FIELDS_AT_LINE_{line}')
        if row['CH_GR'].strip() or row['BOLUS'].strip():
            raise ValueError(f'UNEXPECTED_TREATMENT_AT_LINE_{line}')
        local = datetime.strptime(row['DAY']+' '+row['TIME'], '%d.%m.%Y %H:%M').replace(tzinfo=zone)
        ts = int(local.timestamp()) * 1000
        for field in ('UDT_CGMS', 'BG_LEVEL'):
            value = row[field].strip()
            if not value:
                continue
            if not re.fullmatch(r'[0-9]{1,4}', value):
                raise ValueError(f'CSV_VALUE_AT_LINE_{line}')
            value = int(value)
            if field == 'BG_LEVEL':
                meter.add((ts,value))
                continue
            if ts in sensor and value != sensor[ts]:
                raise ValueError(f'CSV_TIMESTAMP_CONFLICT_AT_LINE_{line}')
            sensor[ts] = value
    return dict(sorted(sensor.items())), sorted(meter), hashlib.sha256(raw).hexdigest()


def report_notes(spec, year):
    text = spec.read_text(encoding='utf-8')
    section = re.split(r'^### 5\.',text,flags=re.M)[1]
    section = re.split(r'^### 6\.',section,flags=re.M)[0]
    records = []
    for line in section.splitlines():
        item = re.match(r'^\*\*(\d{1,2}) (октября|ноября):\*\*\s*(.+)$',line)
        if item:
            day = datetime(year, MONTHS[item[2]], int(item[1])).date().isoformat()
            records.append(dict(id='reported-'+day,day=day,time=None,text=item[3].replace('**',''),
                provenance='user_reported'))
    return sorted(records,key=lambda row:row['day'])


def compare_sqlite(path, rows, meter):
    with sqlite3.connect(path.resolve().as_uri()+'?mode=ro&immutable=1',uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('XDRIP_SQLITE_CORRUPT')
        start = min(rows)
        end = max(rows)+59999
        counts = {}
        for name, query, exported in [
            ('cgm','SELECT timestamp, calculated_value FROM BgReadings WHERE timestamp BETWEEN ? AND ?',rows.items()),
            ('meter','SELECT timestamp, mgdl FROM BloodTest WHERE timestamp BETWEEN ? AND ?',meter),
        ]:
            minutes = {}
            for ts, val in db.execute(query,(start,end)):
                if val is not None:
                    values = minutes.setdefault(int(ts)//60000*60000,set())
                    values.add(round(val))
            exported = list(exported)
            shared = [(time,value) for time,value in exported if time in minutes]
            counts[name] = dict(sqlite_minutes=len(minutes), overlap=len(shared),
                same_mgdl=sum(value in minutes[time] for time,value in shared),
                export_only=len(exported)-len(shared))
        counts['sqlite_treatments_total']=db.execute('SELECT count(*) FROM Treatments').fetchone()[0]
        return counts


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--primary',type=Path,required=True)
    cli.add_argument('--control',type=Path,required=True)
    cli.add_argument('--previous',type=Path)
    cli.add_argument('--sqlite',type=Path,required=True)
    cli.add_argument('--notes',type=Path,required=True)
    cli.add_argument('--zone',required=True)
    cli.add_argument('--start',required=True)
    cli.add_argument('--out',type=Path,required=True)
    args=cli.parse_args()
    os.umask(0o077)
    zone=ZoneInfo(args.zone)
    cutoff=int(datetime.fromisoformat(args.start).replace(tzinfo=zone).timestamp()*1000)
    def selected(path):
        cgm,meter,sha=read_export(path,zone)
        return ({k:v for k,v in cgm.items() if k>=cutoff},[(k,v) for k,v in meter if k>=cutoff],sha)
    cgm,meter,sha=selected(args.primary)
    control_cgm,control_meter,_=selected(args.control)
    if not cgm or cgm!=control_cgm or meter!=control_meter:
        raise ValueError('CONTROL_EXPORT_MISMATCH')
    if args.previous:
        previous,previous_meter,_=selected(args.previous)
        if any(cgm.get(ts)!=val for ts,val in previous.items()) or previous_meter!=meter:
            raise ValueError('PREVIOUS_EXPORT_MISMATCH')
    notes=report_notes(args.notes,int(args.start[:4]))
    args.out.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    args.out.write_text(json.dumps(dict(version=1,timeZone=args.zone,sourceDigest=sha,
        points=list(cgm.items()),meter=meter,notes=notes),ensure_ascii=False,separators=(',',':')))
    local=lambda ts: datetime.fromtimestamp(ts/1000,zone).isoformat()
    summary=dict(cgm_count=len(cgm),meter_count=len(meter),reported_days=len(notes),
        first=local(min(cgm)),last=local(max(cgm)),source_units='mg/dL',crosscheck=compare_sqlite(args.sqlite,cgm,meter),
        source_digest=sha, gaps_over_20_minutes=sum(b-a>1200000 for a,b in zip(list(cgm),list(cgm)[1:])))
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
