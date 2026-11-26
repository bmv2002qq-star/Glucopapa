from pathlib import Path
import hashlib, json, re
app=Path('q07-ci/android-app/app/src/androidTest/java/org/glukopapa/v3/m00')
sources=[
 ('qa/v3-q01-emulator/Q01AndroidRuntimeTest.kt','0265fec1c0e918884103fd66a5a07289f695709b'),
 ('qa/v3-q02-backup/Q02AndroidBackupTest.kt','fad7041c3ae86345ed7f62e6f3efbfcaa3c97e06'),
 ('qa/v3-q03-normalized/Q03AndroidReadOnlyTest.kt','e4d82c9cde6bf91fc10d70bc586eb733c6e5805f')
]
expected=set(json.loads(Path('qa-transfer/q10/v040/earlier_cases.json').read_text()))
actual=set()
for src,blob in sources:
    p=Path(src);b=p.read_bytes()
    assert hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==blob,p
    text=b.decode('utf8')
    # The historical test's exact schema assertion must track the verified
    # current schema 9, not silently accept any version.
    if p.name=='Q01AndroidRuntimeTest.kt':
        a='assertEquals(7,db.readableDatabase.version)'
        assert text.count(a)==1
        text=text.replace(a,'assertEquals(9,db.readableDatabase.version)')
    names=re.findall(r'@Test\s+fun\s+(\w+)\s*\(',text)
    actual.update('org.glukopapa.v3.m00.'+p.stem+'#'+n for n in names)
    target=app/p.name
    assert not target.exists(),target
    target.write_text(text)
    print('Q10_V040_TEST_SOURCE_SHA256',target.name,hashlib.sha256(target.read_bytes()).hexdigest())
assert actual==expected,(actual-expected,expected-actual)
assert len(expected)==16
print('Q10_V040_16_ORIGINAL_CASE_IDS_ADDED; 142 prior IDs unchanged; only test schema expectation updated')

# Restore test-only libraries used by the original Q01/Q02 instrumentation.
gradle=Path('q07-ci/android-app/app/build.gradle.kts')
g=gradle.read_text()
assert g.count('dependencies {')==1
assert 'espresso-core' not in g and 'uiautomator' not in g
g=g.replace('dependencies {','dependencies {\n    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")\n    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")',1)
gradle.write_text(g)
print('Q10_V041_TEST_ONLY_DEPENDENCIES_RESTORED')
