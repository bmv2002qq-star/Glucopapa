"""Verify native GFStorage CI archives against the original v14.1 evidence."""
import argparse
import hashlib
import io
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

def sha(data):
    return hashlib.sha256(data).hexdigest()

def inspect(path):
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None, path
        gate = json.loads(z.read("qa-results/q11/gate.json"))
        suites = {}
        payloads = {}
        for mode, expected in (("integrated", 215), ("offline", 8)):
            base = f"qa-results/v042/{mode}/outputs"
            xml_files = [n for n in z.namelist() if n.startswith(base+"/androidTest-results/") and n.endswith(".xml")]
            assert len(xml_files) == 1, xml_files
            ids = set()
            failures = {}
            for case in ET.fromstring(z.read(xml_files[0])).iter("testcase"):
                ident = case.get("classname")+"#"+case.get("name")
                assert ident not in ids, ident
                ids.add(ident)
                for node in case:
                    if node.tag in {"failure", "error", "skipped"}:
                        failures[ident] = {"kind":node.tag,"trace":node.text}
            assert len(ids) == expected, (mode,len(ids))
            assert not gate[mode]["missing"] and not gate[mode]["extra"] and not gate[mode]["duplicates"]
            assert sorted(failures) == sorted(gate[mode]["failures"]), mode
            suites[mode] = (ids, failures)
            with zipfile.ZipFile(io.BytesIO(z.read(base+"/apk/debug/app-debug.apk"))) as apk:
                payloads[mode] = {n:sha(apk.read(n)) for n in apk.namelist() if
                                  n.startswith("assets/") or re.fullmatch(r"classes\d*\.dex", n)}
            assert payloads[mode] and any(k.endswith(".dex") for k in payloads[mode]), mode
        assert gate["same_app_dex_assets"] and payloads["integrated"] == payloads["offline"]
        crash = z.read("qa-results/q11/crash-buffer.log").decode().strip()
        return {"sha256":sha(Path(path).read_bytes()),"gate":gate["gate_passed"],
                "runnerExit":int(z.read("qa-results/q11/runner-exit.txt").strip()),
                "crashBuffer":crash, "suites":suites, "payloads":payloads}

def record(evidence):
    return {**{k:v for k,v in evidence.items() if k not in {"suites","payloads"}},
            "suites":{m:{"total":len(ids), "passed":len(ids)-len(fails), "failures":fails}
                       for m,(ids,fails) in evidence["suites"].items()}}

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path, nargs="?")
    args=parser.parse_args()
    before=inspect(args.baseline)
    out={"baseline":record(before)}
    if args.candidate:
        after=inspect(args.candidate)
        modes=before["suites"].keys()
        assert all(before["suites"][m][0]==after["suites"][m][0] for m in modes)
        assert before["payloads"]==after["payloads"], "Application dex/assets changed"
        out.update(candidate=record(after), exactIDs=True, appPayloadUnchanged=True)
    print(json.dumps(out,indent=2,ensure_ascii=False))
