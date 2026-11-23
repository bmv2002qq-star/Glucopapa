package org.glukopapa.v3.m00

import android.webkit.JavascriptInterface
import org.json.JSONObject

/** Request-only JavaScript bridge: absolutely no raw bytes, SQL, user identity, or passwords. */
internal class GfV3Q02Bridge(private val ui:GfV3BackupOwnerUi) {
    @JavascriptInterface fun request(action:String):String = try { JSONObject().put("ticket",ui.request(action)).toString() }
    catch(e:Exception){error(e)}
    @JavascriptInterface fun poll(ticket:String):String = try {ui.poll(ticket)}catch(e:Exception){error(e)}
    private fun error(e:Exception):String=JSONObject().put("error",JSONObject().put("code","Q02_ACTION_REJECTED")
        .put("message",e.message?:"REQUEST_FAILED")).toString()
}
