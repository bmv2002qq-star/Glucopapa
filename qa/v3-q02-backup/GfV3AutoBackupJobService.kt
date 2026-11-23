package org.glukopapa.v3.m00

import android.app.job.JobParameters
import android.app.job.JobService
import kotlin.concurrent.thread

/** Android system-managed daily local backup. Does not need internet or credentials. */
class GfV3AutoBackupJobService:JobService(){
    override fun onStartJob(params:JobParameters):Boolean {
        thread(name="Q02-AutoBackup") {
            val helper=GfDbHelper(applicationContext)
            try { GfV3AutoLocalBackup(applicationContext,helper).createDaily() }
            catch(_:Exception) { /* no raw medical content in logs; retry on next scheduled pass */ }
            finally {helper.close();jobFinished(params,false)}
        }
        return true
    }
    override fun onStopJob(params:JobParameters):Boolean = true
}
