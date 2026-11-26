from pathlib import Path
import hashlib, json
root=Path('qa-transfer/q10')
app=Path('q07-ci/android-app/app/src')
main=app/'main/java/org/glukopapa/v3/m00/MainActivity.kt'
q07=app/'androidTest/java/org/glukopapa/v3/m00/Q07RinFastWebViewInstrumentedTest.kt'
def replace(p,a,b):
    s=p.read_text()
    assert s.count(a)==1,(str(p),a,s.count(a))
    p.write_text(s.replace(a,b))
replace(main,'private fun confirmScopedOwner(title:String,message:String,finish:(Boolean)->Unit){','private fun confirmScopedOwner(title:String,message:String,finish:(Boolean)->Unit,positiveLabel:String="Подтвердить"){')
replace(main,'.setPositiveButton("Подтвердить"){_,_->resolve(true)}','.setPositiveButton(positiveLabel){_,_->resolve(activityResumed&&!isFinishing&&!isDestroyed&&dialogHasFocus())}')
# Keep the explicit positive callback, requiring the actual foreground owner window.
replace(main,'            var resolved=false','            fun dialogHasFocus()=scopedOwnerDialog?.window?.decorView?.hasWindowFocus()==true\n            var resolved=false')
replace(main,'''            runOnUiThread {
                AlertDialog.Builder(this).setTitle("РинФаст — подтверждение владельца")
                    .setMessage(msg).setPositiveButton("Подтвердить факт"){_,_->finish(true)}
                    .setNegativeButton("Отмена"){_,_->finish(false)}
                    .setOnCancelListener{finish(false)}.show()
            }''','''            confirmScopedOwner("РинФаст — подтверждение владельца",msg,finish,"Подтвердить факт")''')
replace(main,'/** Q08/Q09 owner consent','/** Q07/Q08/Q09 owner consent')
# Strengthen existing Q07 scenario: prove actual pending window and release after Activity teardown.
replace(q07,'        try {\n            val web=','        val captured=AtomicReference<android.app.AlertDialog?>()\n        try {\n            val web=')
replace(q07,'            val awaiting=decoded(js(web,"GPV3Q07Native.pollOwnerAction(${JSONObject.quote(ticket)})"))','''            val field=MainActivity::class.java.getDeclaredField("scopedOwnerDialog").apply{isAccessible=true}
            for(i in 0 until 80){
                instr.runOnMainSync{
                    val d=field.get(activity) as? android.app.AlertDialog
                    if(d?.isShowing==true&&d.window?.decorView?.isAttachedToWindow==true)captured.set(d)
                }
                if(captured.get()!=null)break
                Thread.sleep(100)
            }
            assertNotNull("Q07 pending owner dialog never attached",captured.get())
            val awaiting=decoded(js(web,"GPV3Q07Native.pollOwnerAction(${JSONObject.quote(ticket)})"))''')
replace(q07,'        }finally {GfV3QaActivityLifecycle.finishAndAwait(instr,activity)}','''        }finally {GfV3QaActivityLifecycle.finishAndAwait(instr,activity)}
        instr.runOnMainSync{
            assertFalse("Q07 pending dialog survived Activity teardown",captured.get()?.isShowing==true)
            assertFalse("Q07 pending dialog decor still attached",captured.get()?.window?.decorView?.isAttachedToWindow==true)
        }
        GfDbHelper(ctx).use{h->
            h.readableDatabase.rawQuery("SELECT COUNT(*) FROM v3_events",null).use{c->assertTrue(c.moveToFirst());assertEquals(0L,c.getLong(0))}
        }''')
for p in [main,q07]:
    print('Q10_V039_DIALOG_SOURCE_SHA256',p.name,hashlib.sha256(p.read_bytes()).hexdigest())
expected=json.loads((root/'v033/Q10_v033_cases.json').read_text())
assert len(expected)==len(set(expected))==142
print('Q10 v039 scoped Q07 dialog lifecycle, unchanged 142 named tests; no callback bypass')
