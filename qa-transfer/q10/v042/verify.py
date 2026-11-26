import json, pathlib, hashlib, xml.etree.ElementTree as E, zipfile
base=pathlib.Path('qa-results/v042')
old=set(json.loads(pathlib.Path('qa-transfer/q10/v033/Q10_v033_cases.json').read_text()))
earlier=set(json.loads(pathlib.Path('qa-transfer/q10/v040/earlier_cases.json').read_text()))
assert len(old)==142 and len(earlier)==16 and not old&earlier
legacy='org.glukopapa.v3.m00.Q02AndroidBackupTest#autoJobScheduleRunsWithoutNetworkPermission'
new=legacy.replace('autoJobScheduleRunsWithoutNetworkPermission','autoJobScheduleIsNetworkIndependentInCgmBuild')
assert legacy in earlier
offline={x for x in earlier if 'Q02AndroidBackupTest#' in x}
assert len(offline)==8
def check(mode,expected):
    root=base/mode/'outputs/androidTest-results'
    seen=[]; failures=[]; count=0; badlogs=[]
    for p in root.rglob('TEST-*.xml'):
        s=E.parse(p).getroot();count+=int(s.get('tests','0'))
        assert not any(int(s.get(k,'0')) for k in ('errors','skipped'))
        for x in s.iter('testcase'):
            id=x.get('classname')+'#'+x.get('name');seen.append(id)
            if any(x.find(t) is not None for t in ('failure','error','skipped')):failures.append(id)
    logs=list(root.rglob('logcat*'))
    for p in logs:
        if p.is_file() and any(b in p.read_bytes() for b in (b'WindowLeaked',b'FATAL EXCEPTION')):badlogs.append(p.name)
    return {'total':count,'expected':len(expected),'missing':sorted(expected-set(seen)),'extra':sorted(set(seen)-expected),'duplicates':len(seen)-len(set(seen)),'failures':failures,'logs':len(logs),'badlogs':badlogs,'pass':count==len(seen)==len(expected) and len(seen)==len(set(seen)) and set(seen)==expected and not failures and not badlogs}
a=check('integrated',(old|earlier)-{legacy}|{new})
b=check('offline',offline)
# No change of application bytecode or assets between permission variants.
def payload(mode):
    p=base/mode/'outputs/apk/debug/app-debug.apk'
    with zipfile.ZipFile(p) as z:
        assert z.testzip() is None
        return {n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.dex') or n.startswith('assets/')}
p=payload('integrated');q=payload('offline')
same=p==q and bool(p)
out={'gate_passed':a['pass'] and b['pass'] and same,'integrated':a,'offline':b,'same_app_dex_assets':same,'original_case_ids_covered':158,'additional_case_ids':1}
print(json.dumps(out))
assert out['gate_passed']
