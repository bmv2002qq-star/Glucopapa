from pathlib import Path
import hashlib,json,shutil
root=Path('qa-transfer/q10')
app=Path('q07-ci/android-app/app/src')
donor=root/'donor-audit'/'GFSafety.js'
b=donor.read_bytes()
assert hashlib.sha1(('blob '+str(len(b))+'\0').encode()+b).hexdigest()=='73c4d920a6f6a652f24ccaefb2388cc3cb6d8866'
dst=app/'main/assets/q10-donor'
dst.mkdir(parents=True,exist_ok=True)
shutil.copyfile(donor,dst/'GFSafety.js')
shutil.copyfile(root/'v034/Q10V3DonorProjection.js',dst/'Q10V3DonorProjection.js')
test=app/'androidTest/java/org/glukopapa/v3/m00/Q10EvidenceNativeInstrumentedTest.kt'
old=test.read_text()
assert 'private fun snapshot()=gateway.bindInstalledAdapter(E.OWNER).readQ10Snapshot()' in old
assert old.rstrip().endswith('}')
test.write_text(old.rstrip()[:-1]+'\n'+(root/'v034/Q10DonorNativeTest.fragment.kt').read_text()+'\n}\n')
cases=root/'v033/Q10_v033_cases.json'
expected=json.loads(cases.read_text())
case='org.glukopapa.v3.m00.Q10EvidenceNativeInstrumentedTest#q10ExactDonorRunsOnRealNativeSnapshotReadOnly'
assert case not in expected
expected.append(case)
cases.write_text(json.dumps(expected,ensure_ascii=False,indent=2)+'\n')
print('Q10_V034_EXACT_CORE_INSTALLED_FOR_ANDROID_QA')
