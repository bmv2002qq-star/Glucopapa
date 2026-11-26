import sys, json, pathlib, xml.etree.ElementTree as ET
root=pathlib.Path(sys.argv[1]); old=json.loads(pathlib.Path(sys.argv[2]).read_text())
earlier=json.loads(pathlib.Path('qa-transfer/q10/v040/earlier_cases.json').read_text())
assert len(old)==len(set(old))==142 and len(earlier)==len(set(earlier))==16
assert not set(old)&set(earlier)
expected=set(old)|set(earlier)
seen=[]; failures=[]; counts={'failures':0,'errors':0,'skipped':0}; totals=0
for p in root.rglob('TEST-*.xml'):
    suite=ET.parse(p).getroot()
    totals+=int(suite.get('tests','0'))
    for k in counts:counts[k]+=int(suite.get(k,'0'))
    for x in suite.iter('testcase'):
        name=x.get('classname')+'#'+x.get('name')
        seen.append(name)
        if any(x.find(t) is not None for t in ('failure','error','skipped')):failures.append(name)
missing=sorted(expected-set(seen)); extra=sorted(set(seen)-expected)
out={'gate_passed':totals==158 and len(seen)==len(set(seen))==158 and not missing and not extra and not failures and not any(counts.values()),'total':totals,'q10':sum('Q10' in s.split('#')[0] for s in seen),'baseline':sum('Q10' not in s.split('#')[0] for s in seen),'earlier':len(set(earlier)&set(seen)),'previous142':len(set(old)&set(seen)),**counts,'missing':missing,'unexpected':extra,'unsuccessful':failures}
print(json.dumps(out))
assert out['gate_passed']
