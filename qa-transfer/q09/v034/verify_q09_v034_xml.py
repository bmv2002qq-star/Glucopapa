import json,sys,xml.etree.ElementTree as E
from pathlib import Path
expected=json.loads(Path(sys.argv[2]).read_text())
actual=[]
files=list(Path(sys.argv[1]).rglob('*.xml'))
if not files: raise SystemExit('No Android XML')
for f in files:
    root=E.parse(f).getroot()
    for c in root.iter('testcase'):
        name=c.attrib['classname']+'#'+c.attrib['name']
        if any(x.tag in ('failure','error','skipped') for x in c):raise SystemExit('Unsuccessful case: '+name)
        actual.append(name)
    if root.tag=='testsuite':
        for k in ['failures','errors','skipped']:
            if int(root.get(k,'0')):raise SystemExit('Unsuccessful suite: '+str(f))
if sorted(actual)!=sorted(expected):raise SystemExit('Case mismatch: '+str({'missing':sorted(set(expected)-set(actual)),'unexpected':sorted(set(actual)-set(expected)),'actual':len(actual),'expected':len(expected)}))
print(json.dumps({'gate_passed':True,'total':len(actual),'q09':sum('.Q09' in x for x in actual),'baseline':105,'failures':0,'skipped':0,'errors':0}))
