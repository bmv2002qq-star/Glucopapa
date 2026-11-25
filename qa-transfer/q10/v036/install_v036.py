from pathlib import Path
import shutil,subprocess,json,hashlib
root=Path('qa-transfer/q10')
app=Path('q07-ci/android-app/app/src')
work=root/'v035/verified'
for n in ['GFCgmEvidencePolicyV3.js','policy_test.js']:
    shutil.copyfile(root/'v036'/n,work/n)
subprocess.run(['node','policy_test.js'],cwd=work,check=True)
dst=app/'main/assets/q10-donor'
shutil.copyfile(work/'GFCgmEvidencePolicyV3.js',dst/'GFCgmEvidencePolicyV3.js')
test=app/'androidTest/java/org/glukopapa/v3/m00/Q10EvidenceNativeInstrumentedTest.kt'
old=test.read_text()
a='"q10-donor/GFSafetyV3DiagnosticAdapter.js").joinToString'
b='"q10-donor/GFSafetyV3DiagnosticAdapter.js","q10-donor/GFCgmEvidencePolicyV3.js").joinToString'
assert old.count(a)==1
old=old.replace(a,b)
a='return {report:r,counts,coreVersion:GFSafety.VERSION};'
b='const policy=GFCgmEvidencePolicyV3.inspect(raw,stamp,now);const changed=GFCgmEvidencePolicyV3.inspect(raw,{...stamp,revision:stamp.revision+1},now);const stale=GFCgmEvidencePolicyV3.inspect(raw,stamp,now+16*60000);return {report:r,counts,coreVersion:GFSafety.VERSION,policy,changed,stale};'
assert old.count(a)==1
old=old.replace(a,b)
a='            val report=output.getJSONObject("report")'
b='''            val policy=output.getJSONObject("policy")
            assertEquals("0.3.6-qa",policy.getString("version"))
            assertEquals("OBSERVED_ONLY",policy.getString("status"))
            assertEquals("XDRIP_MODEL_QUALITY_UNKNOWN",policy.getString("code"))
            assertTrue(policy.isNull("qualityScore"));assertTrue(policy.isNull("currentMmol"))
            assertEquals(115.0/18.0,policy.getDouble("reportedMmol"),0.000001)
            assertEquals(before,policy.getJSONObject("stamp").getLong("revision"))
            val changed=output.getJSONObject("changed");assertEquals("REVISION_OR_PROFILE_CHANGED",changed.getString("code"))
            val stale=output.getJSONObject("stale");assertEquals("STALE",stale.getString("status"))
            for(r in listOf(policy,changed,stale))for(k in listOf("forecastInputEligible","clinicalUseAllowed","insulinDoseDecisionAllowed","automaticInjectionAllowed"))assertFalse(r.getBoolean(k))
            val report=output.getJSONObject("report")'''
assert old.count(a)==1
test.write_text(old.replace(a,b))
print('Q10_V036_POLICY_ASSET_SHA256',hashlib.sha256((dst/'GFCgmEvidencePolicyV3.js').read_bytes()).hexdigest())
print('Q10_V036_POLICY_INSTALLED_FOR_QA_ONLY')
