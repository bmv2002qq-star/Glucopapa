from pathlib import Path
import hashlib,json,shutil,base64,zipfile,io,subprocess
root=Path('qa-transfer/q10')
app=Path('q07-ci/android-app/app/src')
donor=root/'donor-audit'/'GFSafety.js'
b=donor.read_bytes()
assert hashlib.sha1(('blob '+str(len(b))+'\0').encode()+b).hexdigest()=='73c4d920a6f6a652f24ccaefb2388cc3cb6d8866'
payload=base64.b64decode((root/'v035/Q10_v035_TRANSFER.b64').read_text(),validate=False)
assert hashlib.sha256(payload).hexdigest()=='19aad0486f34d83bc1492a99e9f9da6836ee4ad1da9bc726335d63babc630a09'
work=root/'v035/verified'
work.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(io.BytesIO(payload)) as z:
    assert z.testzip() is None
    m=json.loads(z.read('SHA256.json'))
    assert set(m)=={'GFSafetyV3DiagnosticAdapter.js','sha256_ascii.js','test.js','parity.js','chromium_parity.py'}
    assert set(z.namelist())==set(m)|{'SHA256.json'}
    for n,h in m.items():
        assert hashlib.sha256(z.read(n)).hexdigest()==h,n
        (work/n).write_bytes(z.read(n))
shutil.copyfile(donor,work/'GFSafety.js')
subprocess.run(['node','test.js'],cwd=work,check=True)
subprocess.run(['node','parity.js'],cwd=work,check=True)
dst=app/'main/assets/q10-donor'
dst.mkdir(parents=True,exist_ok=True)
for n in ['GFSafety.js','sha256_ascii.js','GFSafetyV3DiagnosticAdapter.js']:
    shutil.copyfile(work/n,dst/n)
test=app/'androidTest/java/org/glukopapa/v3/m00/Q10EvidenceNativeInstrumentedTest.kt'
old=test.read_text()
assert 'private fun snapshot()=gateway.bindInstalledAdapter(E.OWNER).readQ10Snapshot()' in old
assert old.rstrip().endswith('}')
test.write_text(old.rstrip()[:-1]+'\n'+(root/'v035/Q10DonorNativeTest.fragment.kt').read_text()+'\n}\n')
cases=root/'v033/Q10_v033_cases.json'
expected=json.loads(cases.read_text())
assert len(expected)==138
for name in ['q10ExactDonorRunsOnRealNativeSnapshotReadOnly','q10ExactDonorMapsActualProducerFactsReadOnly']:
    case='org.glukopapa.v3.m00.Q10EvidenceNativeInstrumentedTest#'+name
    assert case not in expected
    expected.append(case)
cases.write_text(json.dumps(expected,ensure_ascii=False,indent=2)+'\n')
print('Q10_V035_EXACT_CORE_AND_STRICT_ADAPTER_INSTALLED_FOR_ANDROID_QA_140_CASES')
