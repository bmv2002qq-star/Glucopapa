"""Extract exact Android testcase IDs, compare suites and keep failed assertions."""
import argparse
import collections
import hashlib
import json
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("baseline",type=Path)
parser.add_argument("candidate",type=Path)
args=parser.parse_args()

def extract(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        result={}
        for name in archive.namelist():
            if "/androidTest-results/" not in name or not name.endswith(".xml"):
                continue
            group=name.split("/")[2]
            for test in ET.fromstring(archive.read(name)).iter("testcase"):
                key=test.attrib["classname"]+"#"+test.attrib["name"]
                failure=next((el for el in test if el.tag in ("failure","error","skipped")),None)
                result.setdefault(group,[]).append((key,None if failure is None else {
                    "state": failure.tag, "message": failure.get("message"), "stack": failure.text
                }))
        assert set(result)=={"offline","integrated"}, result.keys()
        return result

old,new=extract(args.baseline),extract(args.candidate)
out={"sha256":{str(p.name):hashlib.sha256(p.read_bytes()).hexdigest() for p in (args.baseline,args.candidate)}}
for group in sorted(new):
    before={k for k,_ in old[group]}
    after=collections.Counter(k for k,_ in new[group])
    out[group]={
        "before":len(old[group]),"after":len(new[group]),
        "added":sorted(after.keys()-before),"removed":sorted(before-after.keys()),
        "duplicates":sorted(k for k,n in after.items() if n>1),
        "failures":{key:state for key,state in new[group] if state is not None}
    }
print(json.dumps(out,ensure_ascii=False,indent=2))
