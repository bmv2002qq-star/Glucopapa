package org.glukopapa.v3.m00

import android.app.job.JobParameters
import android.app.job.JobService
import kotlin.concurrent.thread

/** Android system-managed daily local backup. Does not need internet or credentials. */
class GfV3AutoBackupJobService:JobService(){
    override fun onStartJob(params:JobParameters):Boolean {
        thread(name="Q02-AutoBackup") {
            var retry=false
            var helper:GfDbHelper?=null
            try {
                helper=GfDbHelper(applicationContext)
                GfV3AutoLocalBackup(applicationContext,helper).createDaily()
                getSharedPreferences("q02-auto-status",MODE_PRIVATE).edit()
                    .putString("lastResult","SUCCESS").putLong("lastRunMillis",System.currentTimeMillis()).apply()
            } catch(_:Exception) {
                retry=true
                // Only a generic failure code and timestamp. No medical values or secrets.
                getSharedPreferences("q02-auto-status",MODE_PRIVATE).edit()
                    .putString("lastResult","FAILED").putLong("lastRunMillis",System.currentTimeMillis()).apply()
            } finally {
                try { helper?.close() } finally {jobFinished(params,retry)}
            }
        }
        return true
    }
    override fun onStopJob(params:JobParameters):Boolean = true
}
