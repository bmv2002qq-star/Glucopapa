from pathlib import Path
import shutil, subprocess, hashlib, json
root=Path('qa-transfer/q10')
app=Path('q07-ci/android-app/app/src')
work=root/'v035/verified'
for name in ['GFHighLowInputGateV3.js','gate_test.js']:
    shutil.copyfile(root/'v038'/name,work/name)
    expected={'GFHighLowInputGateV3.js':'510aeaae337cf1fb879a4ec0e50ebf3bf086f2e2a2539b48bf209f3044b7c231','gate_test.js':'859fde6f74b1e8084b31a6b1dca3c16d1e0908b572e35c99ce9443b5734e9618'}[name]
    assert hashlib.sha256((work/name).read_bytes()).hexdigest()==expected
subprocess.run(['node','gate_test.js'],cwd=work,check=True)
dst=app/'main/assets/q10-donor'
shutil.copyfile(work/'GFHighLowInputGateV3.js',dst/'GFHighLowInputGateV3.js')
main=app/'main/java/org/glukopapa/v3/m00/GfV3Q10OfflineDiagnostics.kt'
native=app/'androidTest/java/org/glukopapa/v3/m00/Q10EvidenceNativeInstrumentedTest.kt'
ui=app/'androidTest/java/org/glukopapa/v3/m00/Q10EvidenceWebViewInstrumentedTest.kt'
def replace(path,a,b):
    text=path.read_text()
    assert text.count(a)==1,(str(path),a,text.count(a))
    path.write_text(text.replace(a,b))
replace(main,'const val VERSION="v0.3.7-qa"','const val VERSION="v0.3.8-qa"')
replace(main,'"GFCgmEvidencePolicyV3.js" to "3ee2d9f2086636bab5243d8cad5b814a0e1a4ee44889f221e4fac90b9061efce")','"GFCgmEvidencePolicyV3.js" to "3ee2d9f2086636bab5243d8cad5b814a0e1a4ee44889f221e4fac90b9061efce",\n            "GFHighLowInputGateV3.js" to "510aeaae337cf1fb879a4ec0e50ebf3bf086f2e2a2539b48bf209f3044b7c231")')
replace(main,'policy:GFCgmEvidencePolicyV3.inspect(raw,stamp,now),coreVersion:GFSafety.VERSION','policy:GFCgmEvidencePolicyV3.inspect(raw,stamp,now),gate:GFHighLowInputGateV3.inspect(raw,stamp,now),coreVersion:GFSafety.VERSION')
replace(main,'val d=out.getJSONObject("report");val p=out.getJSONObject("policy")','val d=out.getJSONObject("report");val p=out.getJSONObject("policy");val g=out.getJSONObject("gate")')
replace(main,'for(x in listOf(d,p))','for(x in listOf(d,p,g))')
replace(main,'            val ds=d.optJSONObject("stamp");val ps=p.optJSONObject("stamp")','''            require(g.getString("version")=="0.3.8-qa"&&g.getString("status")=="BLOCKED")
            require(g.get("allowDose")==false&&g.get("allowRecommendation")==false)
            require(g.getString("foodCoverage")=="NOT_PROVEN"&&g.getString("insulinCoverage")=="NOT_PROVEN"&&g.getString("activityEffect")=="NOT_APPLIED")
            for(k in listOf("glucose","iob","cob")){val v=g.getJSONObject(k);require(v.getString("status")=="UNKNOWN"&&v.has("value")&&v.isNull("value"))}
            val gs=g.optJSONObject("stamp");if(gs!=null)require(stampMatches(gs,s))
            val gc=safeCode(g.getString("code"));val gi=codes(g.getJSONArray("issues"))
            val ds=d.optJSONObject("stamp");val ps=p.optJSONObject("stamp")
            if(ds!=null)require(gs!=null&&gc=="THERAPEUTIC_INPUT_NOT_READY")''')
replace(main,'.put("projectionCodes",codes(d.getJSONArray("issues")))', '.put("gateVersion","0.3.8-qa").put("gateStatus","BLOCKED").put("gateCode",gc).put("gateIssues",gi)\n                .put("projectionCodes",codes(d.getJSONArray("issues")))')
replace(native,'assertEquals("v0.3.7-qa",trace.getString("runtimeVersion"))','assertEquals("v0.3.8-qa",trace.getString("runtimeVersion"));assertEquals("0.3.8-qa",trace.getString("gateVersion"));assertEquals("BLOCKED",trace.getString("gateStatus"));assertEquals("THERAPEUTIC_INPUT_NOT_READY",trace.getString("gateCode"));assertTrue(trace.getJSONArray("gateIssues").toString().contains("IOB_NOT_PROVEN"))')
replace(ui,"t.policyCode==='NO_CGM'","t.policyCode==='NO_CGM'&&t.gateVersion==='0.3.8-qa'&&t.gateStatus==='BLOCKED'&&t.gateCode==='THERAPEUTIC_INPUT_NOT_READY'")
expected=json.loads((root/'v033/Q10_v033_cases.json').read_text())
assert len(expected)==len(set(expected))==142
assert hashlib.sha256((app/'main/assets/www/q10/evidence.html').read_bytes()).hexdigest()=='919e6db8494c5cd740ab8c16659eba92fe087548b71955c2e31cd075e5efc5c3'
print('Q10 v038 separate availability gate installed read-only; 142 named tests required')
