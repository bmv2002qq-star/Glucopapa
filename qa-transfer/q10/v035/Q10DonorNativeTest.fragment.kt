    @Test fun q10ExactDonorRunsOnRealNativeSnapshotReadOnly(){
        // The existing QA fixture authorizes the two installed adapters only in this isolated test database.
        accept(C.OWNER);accept(E.OWNER)
        write()
        assertExactDonorParity(1,0,0,false,false)
    }
    @Test fun q10ExactDonorMapsActualProducerFactsReadOnly(){
        accept(E.OWNER);accept(C.OWNER);qaActivate("GFNutrition","mealFlow");qaActivate("GFInjectionFact","actionWriter");qaActivate(GfV3Q08Rules.OWNER,"actionWriter");qaActivate("GFSport","conditionWriter");qaActivate("GFIllness","conditionWriter")
        val plate=qaPlate();val meal=GfV3Q04MealFacts(gateway.bindInstalledAdapter("GFNutrition"));val time=now.minusSeconds(3600).toString()
        meal.plan("qa-q10-donor-meal",plate,"qa-q10-donor-plan",storage.revision(),time)
        meal.start("qa-q10-donor-meal",plate,"qa-q10-donor-start",storage.revision(),time)
        meal.confirmActual("qa-q10-donor-meal",plate,plate,"qa-q10-donor-event","qa-q10-donor-confirm",storage.revision(),true,time,time)
        GfV3Q07InjectionFacts(gateway.bindInstalledAdapter("GFInjectionFact")).confirm("qa-q10-donor-rapid","qa-q10-donor-rapid-key",0.5,"abdomen",now.minusSeconds(3900).toString(),"",storage.revision(),true)
        GfV3Q08InjectionFacts(gateway.bindInstalledAdapter(GfV3Q08Rules.OWNER)).confirm(profile,"qa-q10-donor-basal",storage.revision(),"morning",0.5,"buttock",now.minusSeconds(7200).toString(),true)
        val activity=GfV3Q05ActivityFacts(gateway.bindInstalledAdapter("GFSport"),gateway.bindInstalledAdapter("GFIllness"),gateway.bindInstalledAdapter("GFSettings"))
        activity.startSport("qa-q10-donor-sport","qa-q10-donor-sport-start",storage.revision(),true,now.minusSeconds(600).toString())
        activity.startIllness("qa-q10-donor-illness",1.0,"qa-q10-donor-ill-start",storage.revision(),true,now.minusSeconds(1200).toString())
        write()
        assertExactDonorParity(1,2,1,true,true)
    }
    private fun assertExactDonorParity(expectedCgm:Int,expectedInjections:Int,expectedMeals:Int,activeIllness:Boolean,activeSport:Boolean){
        val before=storage.revision()
        val auditBefore=count("v3_audit")
        val receiptBefore=count("v3_write_receipts")+count("v3_extended_receipts")
        val cgmBefore=count("v3_cgm")
        val snap=snapshot()
        val current=snapshot()
        val stamp=JSONObject()
        for(k in listOf("profileId","schemaVersion","revision","inputRevision"))stamp.put(k,current.get(k))
        val instr=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val ctx=instr.targetContext
        val scripts=listOf("q10-donor/sha256_ascii.js","q10-donor/GFSafety.js","q10-donor/GFSafetyV3DiagnosticAdapter.js").joinToString("\n"){ctx.assets.open(it).bufferedReader().use{r->r.readText()}}
        val js=scripts+"\n;JSON.stringify((()=>{const a=GFSafetyV3DiagnosticAdapter,raw="+JSONObject.quote(snap.toString())+",stamp=JSON.parse("+JSONObject.quote(stamp.toString())+"),now="+now.toEpochMilli()+";const r=a.evaluate(raw,stamp,now,GFSafety);let counts=null;try{const p=a.prepare(raw,stamp,now);counts={cgm:p.input.readings.length,injections:p.input.injections.length,meals:p.input.meals.length,illness:p.input.conditions.illness===true,activity:p.input.conditions.activity===true}}catch(e){}return {report:r,counts,coreVersion:GFSafety.VERSION};})());"
        val latch=java.util.concurrent.CountDownLatch(1)
        val result=java.util.concurrent.atomic.AtomicReference<String>()
        val view=java.util.concurrent.atomic.AtomicReference<android.webkit.WebView>()
        try {
            instr.runOnMainSync {
                val web=android.webkit.WebView(ctx)
                view.set(web)
                web.settings.javaScriptEnabled=true
                web.settings.allowFileAccess=false
                web.settings.allowContentAccess=false
                web.settings.blockNetworkLoads=true
                web.webViewClient=object:android.webkit.WebViewClient(){
                    override fun onPageFinished(v:android.webkit.WebView,url:String){
                        v.evaluateJavascript(js){value->result.set(value);latch.countDown()}
                    }
                }
                web.loadDataWithBaseURL(null,"<html><body></body></html>","text/html","UTF-8",null)
            }
            assertTrue("Donor evaluation timed out",latch.await(20,java.util.concurrent.TimeUnit.SECONDS))
            val output=JSONObject(org.json.JSONTokener(result.get()).nextValue() as String)
            val report=output.getJSONObject("report")
            assertEquals("0.1.0",output.getString("coreVersion"))
            assertEquals("0.3.5-qa",report.getString("version"))
            assertEquals("BLOCKED",report.getString("donorStatus"))
            val issues=report.getJSONArray("donorIssues")
            assertTrue((0 until issues.length()).any{issues.getJSONObject(it).getString("code")=="INCOMPLETE_HISTORY"})
            val counts=output.getJSONObject("counts")
            assertEquals(expectedCgm,counts.getInt("cgm"));assertEquals(expectedInjections,counts.getInt("injections"));assertEquals(expectedMeals,counts.getInt("meals"))
            assertEquals(activeIllness,counts.getBoolean("illness"));assertEquals(activeSport,counts.getBoolean("activity"))
            assertEquals(before,report.getJSONObject("stamp").getLong("revision"))
            for(k in listOf("forecastInputEligible","clinicalUseAllowed","insulinDoseDecisionAllowed","automaticInjectionAllowed"))assertFalse(report.getBoolean(k))
            assertEquals(before,storage.revision())
            assertEquals(auditBefore,count("v3_audit"))
            assertEquals(receiptBefore,count("v3_write_receipts")+count("v3_extended_receipts"))
            assertEquals(cgmBefore,count("v3_cgm"))
        } finally {instr.runOnMainSync{view.get()?.destroy()}}
    }
