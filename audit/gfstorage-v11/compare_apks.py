"""Compare production payload bytes in the APKs from two CI evidence archives."""
import argparse
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument("baseline",type=Path)
parser.add_argument("candidate",type=Path)
args=parser.parse_args()

def payloads(path):
    with zipfile.ZipFile(path) as archive:
        apps={}
        for group in ("integrated","offline"):
            name=f"qa-results/v042/{group}/outputs/apk/debug/app-debug.apk"
            with zipfile.ZipFile(io.BytesIO(archive.read(name))) as apk:
                apps[group]={name:hashlib.sha256(apk.read(name)).hexdigest() for name in apk.namelist()
                             if re.fullmatch(r"classes\d*\.dex",name) or name.startswith("assets/")}
            assert any(name.endswith(".dex") for name in apps[group])
            assert any(name.startswith("assets/") for name in apps[group])
        return apps

before,after=payloads(args.baseline),payloads(args.candidate)
result={}
for group in before:
    diff=sorted(name for name in before[group].keys()|after[group].keys()
                if before[group].get(name)!=after[group].get(name))
    result[group]={"entries":len(after[group]),"changes":diff}
print(json.dumps(result,indent=2))
assert not any(group["changes"] for group in result.values())
