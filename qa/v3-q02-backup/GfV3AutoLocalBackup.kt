package org.glukopapa.v3.m00

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device-bound automatic local backup: a random 256-bit passphrase protects the
 * standard portable Q02 encrypted SQLite snapshot. AndroidKeyStore wraps ONLY the
 * random passphrase. No plaintext medical JSON or secret is written to disk.
 * Automatic copies are not portable after uninstall/device-key loss; manual SAF
 * export remains a separate Q29 device task.
 */
internal class GfV3AutoLocalBackup(private val ctx:Context,private val helper:GfDbHelper) {
    companion object {
        const val PERIODIC_JOB_ID= 22002
        const val INITIAL_JOB_ID = 22003
        private const val KEY_ALIAS="glukopapa.v3.q02.device-autobackup.aes"
        private const val FILE_PREFIX="GPV3-AUTO-"
        private const val FILE_SUFFIX=".gpv3auto"
        private val MAGIC="GPV3-AUTO-1".toByteArray(Charsets.US_ASCII)
        private val random=SecureRandom()
        private val gate=Any()
        private const val MAX_FILE=128*1024*1024+1024
        fun schedule(ctx:Context) {
            val jobs=ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
            val component=ComponentName(ctx,GfV3AutoBackupJobService::class.java)
            val periodic=JobInfo.Builder(PERIODIC_JOB_ID,component)
                .setPeriodic(24*60*60*1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_NONE)
                .setPersisted(true).build()
            // Replacing the pending periodic JobInfo on every Activity launch postpones
            // the next backup indefinitely for a frequently opened application.
            if(jobs.getPendingJob(PERIODIC_JOB_ID)==null)
                check(jobs.schedule(periodic)==JobScheduler.RESULT_SUCCESS) {"Q02_AUTO_PERIODIC_SCHEDULE_FAILED"}
            // Initial backup after install/activation, next periodic job handles later days.
            val directory=File(ctx.filesDir,"q02-encrypted")
            val exists=directory.listFiles()?.any{it.name.startsWith(FILE_PREFIX)&&it.name.endsWith(FILE_SUFFIX)}?:false
            if(!exists && jobs.getPendingJob(INITIAL_JOB_ID)==null) {
                val first=JobInfo.Builder(INITIAL_JOB_ID,component)
                    .setMinimumLatency(20_000L)
                    .setOverrideDeadline(5*60*1000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_NONE).build()
                check(jobs.schedule(first)==JobScheduler.RESULT_SUCCESS) {"Q02_AUTO_INITIAL_SCHEDULE_FAILED"}
            }
        }
    }
    private val dir:File get()=File(ctx.filesDir,"q02-encrypted").apply{if(!exists())check(mkdirs())}
    private fun key():SecretKey {
        val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}
        val existing=store.getKey(KEY_ALIAS,null) as? SecretKey
        if(existing!=null)return existing
        val generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }
    fun list():List<String> = synchronized(gate) { dir.listFiles()?.filter {it.isFile&&it.name.matches(Regex("^GPV3-AUTO-[0-9a-f-]{36}\\.gpv3auto$"))}
        ?.sortedByDescending {it.lastModified()}?.map{it.name}?:emptyList() }
    fun createDaily(force:Boolean=false):String = synchronized(gate) {
        val existing=list().firstOrNull()
        if(existing!=null && !force){
            val file=File(dir,existing)
            if(System.currentTimeMillis()-file.lastModified() < 23*60*60*1000L)return@synchronized existing
        }
        val rawPass=ByteArray(32).also(random::nextBytes)
        val pass=Base64.encodeToString(rawPass,Base64.NO_WRAP).toCharArray()
        var encrypted=ByteArray(0)
        var wrapped=ByteArray(0)
        try {
            encrypted=GfV3EncryptedSnapshot(ctx,helper).createEncrypted(pass)
            val cipher=Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE,key())
            cipher.updateAAD(MAGIC)
            wrapped=cipher.doFinal(rawPass)
            val bytes=ByteArrayOutputStream()
            DataOutputStream(bytes).use { out ->
                out.write(MAGIC)
                out.write(cipher.iv)
                out.writeInt(wrapped.size)
                out.write(wrapped)
                out.writeInt(encrypted.size)
                out.write(encrypted)
            }
            val name=FILE_PREFIX+UUID.randomUUID()+FILE_SUFFIX
            val tmp=File(dir,".$name.partial")
            val target=File(dir,name)
            try {
                FileOutputStream(tmp).use{it.write(bytes.toByteArray());it.fd.sync()}
                check(tmp.renameTo(target)) {"Q02_AUTO_FINALIZE_FAILED"}
                val older=list().drop(7)
                older.forEach{File(dir,it).delete()}
                return@synchronized name
            } finally {tmp.delete()}
        } finally {rawPass.fill(0);pass.fill('\u0000');encrypted.fill(0);wrapped.fill(0)}
    }
    fun restoreLocal(name:String,expectedCurrentRevision:Long):GfV3EncryptedSnapshot.Summary = synchronized(gate) {
        require(Regex("^GPV3-AUTO-[0-9a-f-]{36}\\.gpv3auto$").matches(name)) {"Q02_AUTO_FILE_NAME_INVALID"}
        val f=File(dir,name)
        require(f.isFile && f.length() in 1..MAX_FILE.toLong()) {"Q02_AUTO_FILE_INVALID"}
        val input=DataInputStream(ByteArrayInputStream(f.readBytes()))
        val header=ByteArray(MAGIC.size).also(input::readFully)
        require(header.contentEquals(MAGIC)) {"Q02_AUTO_FORMAT_UNSUPPORTED"}
        val nonce=ByteArray(12).also(input::readFully)
        val wrappedLen=input.readInt()
        require(wrappedLen in 16..128) {"Q02_AUTO_WRAP_LENGTH_INVALID"}
        val wrapped=ByteArray(wrappedLen).also(input::readFully)
        val envLen=input.readInt()
        require(envLen in 64..(MAX_FILE-128) && input.available()==envLen) {"Q02_AUTO_ENVELOPE_LENGTH_INVALID"}
        val envelope=ByteArray(envLen).also(input::readFully)
        val raw=Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,nonce));updateAAD(MAGIC);doFinal(wrapped)
        }
        require(raw.size==32) {"Q02_AUTO_WRAPPED_KEY_INVALID"}
        val pass=Base64.encodeToString(raw,Base64.NO_WRAP).toCharArray()
        try {
            // Before actual restore keep current state as another encrypted auto backup.
            GfV3EncryptedSnapshot(ctx,helper).inspectEncrypted(envelope,pass)
            val secure=GfV3EncryptedSnapshot(ctx,helper)
            createDaily(force=true) // persist current state with independent KeyStore-wrapped pass
            return@synchronized secure.restoreEncrypted(envelope,pass,expectedCurrentRevision,name)
        } finally {raw.fill(0);pass.fill('\u0000');envelope.fill(0);wrapped.fill(0)}
    }
}
