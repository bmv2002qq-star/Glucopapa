package org.glukopapa.v3.m00

import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

// Latches replace only the adapter. The queue, worker and restore fence are real.
internal class GfV3SettingsTrustedAdapter {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val writes = AtomicInteger()
    fun readSettingsSnapshot() = JSONObject().put("profileConfigured", true)
        .put("profileId", "audit").put("revision", 0)

    fun applyOwnerIntent(intent: JSONObject): JSONObject {
        check(intent.getBoolean("ownerConfirmed"))
        entered.countDown()
        check(release.await(5, TimeUnit.SECONDS))
        return JSONObject().put("revision", writes.incrementAndGet())
    }
}

fun main() {
    val adapter = GfV3SettingsTrustedAdapter()
    lateinit var reply: (Boolean) -> Unit
    val queue = GfV3SettingsOwnerIntentQueue(adapter) { _, callback -> reply = callback }
    try {
        val request = JSONObject().put("type", "GFSETTINGS_V3_OWNER_INTENT")
            .put("ownerConfirmed", true).put("command", "setting").put("role", "settingsWriter")
            .put("profileId", "audit").put("expectedRevision", 0).put("idempotencyKey", "audit-case")
            .put("payload", JSONObject().put("settingChangeId","audit-change").put("settingKey", "target")
                .put("value", JSONObject().put("mmolL", 6).put("source","OWNER_MANUAL")))
        val ticket = queue.enqueue(request.toString()).getString("ticket")
        reply(true)
        check(adapter.entered.await(5, TimeUnit.SECONDS))
        reply(false)
        val receipt = queue.poll(ticket).getString("state")
        adapter.release.countDown()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (adapter.writes.get()==0 && System.nanoTime()<deadline) Thread.sleep(1)
        println("receipt=$receipt adapterWrites=${adapter.writes.get()}")
        check(receipt == "APPLYING" && adapter.writes.get()==1) { "Late cancellation invalidated accepted work" }
    } finally {
        adapter.release.countDown()
        queue.cancelPendingOnDestroy()
    }
}
