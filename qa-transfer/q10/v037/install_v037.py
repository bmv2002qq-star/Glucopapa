from pathlib import Path
import json, shutil, hashlib
root=Path('qa-transfer/q10')
app=Path('q07-ci/android-app/app/src')
main=app/'main/java/org/glukopapa/v3/m00'
test=app/'androidTest/java/org/glukopapa/v3/m00'
def replace(path,a,b):
    s=path.read_text()
    assert s.count(a)==1, (str(path),a,s.count(a))
    path.write_text(s.replace(a,b))
shutil.copyfile(root/'v037/GfV3Q10OfflineDiagnostics.kt',main/'GfV3Q10OfflineDiagnostics.kt')
replace(main/'GfV3Q10Evidence.kt','val mealCoverage:String="NOT_PROVEN") {','val mealCoverage:String="NOT_PROVEN",val runtimeTraceJson:String?=null) {')
replace(main/'GfV3Q10ReadAdapter.kt','private val storage:GfV3Storage) {','private val storage:GfV3Storage,private val offline:((JSONObject,E.Stamp,Instant)->JSONObject)?=null) {')
replace(main/'GfV3Q10ReadAdapter.kt','        val result=project(s,checked)\n        if(result.stamp!=null&&currentStamp()?.let{E.matches(result.stamp,it)}!=true)E.unavailable(checked,"REVISION_CHANGED") else result','''        val result=project(s,checked)
        val stamp=result.stamp
        if(stamp!=null&&currentStamp()?.let{E.matches(stamp,it)}!=true)E.unavailable(checked,"REVISION_CHANGED")
        else if(stamp!=null&&offline!=null){
            val trace=try{offline.invoke(s,stamp,checked)}catch(_:Exception){GfV3Q10OfflineDiagnostics.failure("EXECUTION_FAILED")}
            if(currentStamp()?.let{E.matches(stamp,it)}!=true)E.unavailable(checked,"REVISION_CHANGED")
            else result.copy(runtimeTraceJson=trace.toString(),issues=if(trace.optString("status")=="CHECKED")result.issues else (result.issues+"Q10_RUNTIME_UNAVAILABLE").distinct())
        }else result''')
replace(main/'GfV3Q10Controller.kt','        return out\n    }','        r.runtimeTraceJson?.let{out.put("runtimeTrace",JSONObject(it))}\n        return out\n    }')
replace(main/'MainActivity.kt','GfV3Q10ReadAdapter(nativeModuleGateway,v3)','GfV3Q10ReadAdapter(nativeModuleGateway,v3,GfV3Q10OfflineDiagnostics(applicationContext)::inspect)')
replace(test/'Q10EvidenceWebViewInstrumentedTest.kt','            assertEquals("true",js(web,"JSON.parse(GPV3Q10Native.readState()).forecastInputEligible===false','            assertEquals("true",js(web,"(()=>{const t=JSON.parse(GPV3Q10Native.readState()).runtimeTrace;return t?.status===\'CHECKED\'&&t.coreExecuted===true&&t.coreVersion===\'0.1.0\'&&t.policyVersion===\'0.3.6-qa\'&&t.policyCode===\'NO_CGM\'})()"))\n            assertEquals("true",js(web,"JSON.parse(GPV3Q10Native.readState()).forecastInputEligible===false')
native=test/'Q10EvidenceNativeInstrumentedTest.kt'
s=native.read_text();assert s.rstrip().endswith('}')
extra='''    @Test fun q10ActualReadAdapterInvokesOfflineDonorAndPolicy(){
        accept(E.OWNER);accept(C.OWNER);write()
        val rev=storage.revision();val audit=count("v3_audit");val receipts=count("v3_write_receipts")+count("v3_extended_receipts")
        val actual=GfV3Q10ReadAdapter(gateway,storage,GfV3Q10OfflineDiagnostics(ctx)::inspect).inspect(now)
        val trace=JSONObject(actual.runtimeTraceJson!!)
        assertEquals("CHECKED",trace.getString("status"));assertTrue(trace.getBoolean("coreExecuted"))
        assertEquals("v0.3.7-qa",trace.getString("runtimeVersion"));assertEquals("0.1.0",trace.getString("coreVersion"))
        assertEquals("OBSERVED_ONLY",trace.getString("policyStatus"));assertEquals("BLOCKED",trace.getString("donorStatus"))
        assertNotNull(actual.latest);assertFalse(actual.forecastInputEligible);assertNull(actual.qualityScore)
        assertEquals(rev,storage.revision());assertEquals(audit,count("v3_audit"));assertEquals(receipts,count("v3_write_receipts")+count("v3_extended_receipts"));assertEquals(1,count("v3_cgm"))
    }
    @Test fun q10RuntimeFailureKeepsReadOnlyObservationWithoutAuthorization(){
        accept(E.OWNER);accept(C.OWNER);write();val rev=storage.revision();val audit=count("v3_audit")
        val actual=GfV3Q10ReadAdapter(gateway,storage){_,_,_->throw IllegalStateException("fixture only")}.inspect(now)
        val trace=JSONObject(actual.runtimeTraceJson!!)
        assertEquals("UNAVAILABLE",trace.getString("status"));assertFalse(trace.getBoolean("coreExecuted"))
        assertTrue(actual.issues.contains("Q10_RUNTIME_UNAVAILABLE"));assertNotNull(actual.latest);assertFalse(actual.forecastInputEligible)
        assertEquals(rev,storage.revision());assertEquals(audit,count("v3_audit"));assertEquals(1,count("v3_cgm"))
    }
'''
native.write_text(s.rstrip()[:-1]+extra+'}\n')
cases=root/'v033/Q10_v033_cases.json'
expected=json.loads(cases.read_text());assert len(expected)==140
expected.extend(['org.glukopapa.v3.m00.Q10EvidenceNativeInstrumentedTest#q10ActualReadAdapterInvokesOfflineDonorAndPolicy','org.glukopapa.v3.m00.Q10EvidenceNativeInstrumentedTest#q10RuntimeFailureKeepsReadOnlyObservationWithoutAuthorization'])
cases.write_text(json.dumps(expected,indent=2)+'\n')
assert len(expected)==len(set(expected))==142
assert hashlib.sha256((app/'main/assets/www/q10/evidence.html').read_bytes()).hexdigest()=='919e6db8494c5cd740ab8c16659eba92fe087548b71955c2e31cd075e5efc5c3'
for n in ['GfV3Q10OfflineDiagnostics.kt','GfV3Q10Evidence.kt','GfV3Q10ReadAdapter.kt','GfV3Q10Controller.kt','MainActivity.kt']:
    print('Q10_RUNTIME_SOURCE_SHA256',n,hashlib.sha256((main/n).read_bytes()).hexdigest())
print('Q10 v037 read-only runtime wired; 142 named tests required')
