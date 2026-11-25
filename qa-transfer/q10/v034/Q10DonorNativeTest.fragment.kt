    @Test fun q10ExactDonorRunsOnRealNativeSnapshotReadOnly(){
        // The existing QA fixture authorizes the two installed adapters only in this isolated test database.
        accept(C.OWNER);accept(E.OWNER)
        write()
        val before=storage.revision()
        val auditBefore=count("v3_audit")
        val receiptBefore=count("v3_write_receipts")+count("v3_extended_receipts")
        val cgmBefore=count("v3_cgm")
        val snap=snapshot()
        val instr=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val ctx=instr.targetContext
        val scripts=listOf("q10-donor/GFSafety.js","q10-donor/Q10V3DonorProjection.js").joinToString("\n"){ctx.assets.open(it).bufferedReader().use{r->r.readText()}}
        val js=scripts+"\n;JSON.stringify(Q10V3DonorProjection.evaluate(JSON.parse("+JSONObject.quote(snap.toString())+"),"+JSONObject.quote(now.toString())+",GFSafety));"
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
            val report=JSONObject(org.json.JSONTokener(result.get()).nextValue() as String)
            assertEquals("0.1.0",report.getString("donorVersion"))
            assertEquals("V3_OBSERVATIONAL_ONLY",report.getString("code"))
            assertTrue(report.getJSONObject("counts").getInt("cgm")>0)
            assertEquals(before,report.getLong("revision"))
            for(k in listOf("forecastInputEligible","clinicalUseAllowed","insulinDoseDecisionAllowed","automaticInjectionAllowed"))assertFalse(report.getBoolean(k))
            assertEquals(before,storage.revision())
            assertEquals(auditBefore,count("v3_audit"))
            assertEquals(receiptBefore,count("v3_write_receipts")+count("v3_extended_receipts"))
            assertEquals(cgmBefore,count("v3_cgm"))
        } finally {instr.runOnMainSync{view.get()?.destroy()}}
    }
