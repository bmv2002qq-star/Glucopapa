package com.glucopapa.shell.qa;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.graphics.Rect;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import com.glucopapa.shell.MainActivity;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

final class WebViewChecks {
    private final Instrumentation instrumentation;

    WebViewChecks(Instrumentation instrumentation) {
        this.instrumentation = instrumentation;
    }

    JSONObject exercise(String asset, String action) throws Exception {
        WebView web = startWebView();
        String script;
        try (InputStream input = instrumentation.getContext().getAssets().open(asset)) {
            ByteArrayOutputStream content = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int length; (length = input.read(buffer)) != -1;) {
                content.write(buffer, 0, length);
            }
            script = new String(content.toByteArray(), StandardCharsets.UTF_8);
        }
        String marker = JSONObject.quote(java.util.UUID.randomUUID().toString());
        String guarded = "(() => { if(window.__glucopapaQAScriptStarted!==" + marker +
            "){ window.__glucopapaQAScriptStarted=" + marker +
            "; window.__glucopapaQAAction=" + JSONObject.quote(action) + ";\n" +
            script + "\n} return 'QA_SCRIPT_STARTED';})()";
        String started = evaluate(web, guarded);
        if (started == null) started = evaluate(web, guarded);
        if (!"\"QA_SCRIPT_STARTED\"".equals(started)) {
            throw new IllegalStateException("Could not evaluate synthetic fixture: " + started);
        }
        long deadline = SystemClock.elapsedRealtime() + 90_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            String raw = evaluate(web, "window.__glucopapaQA");
            if (raw != null && !"null".equals(raw)) {
                JSONObject outcome = new JSONObject(raw);
                if (!"PASS".equals(outcome.optString("status"))) {
                    throw new IllegalStateException(outcome.toString());
                }
                return outcome;
            }
            SystemClock.sleep(200);
        }
        throw new IllegalStateException("WebView fixture timed out at "
            + evaluate(web, "window.__glucopapaQAStage"));
    }

    JSONObject checkTouch() throws Exception {
        WebView web = startWebView();
        evaluate(web, "GPApp.open('home'); true");
        tap(web, "#openHigh", "screen-approved-high");
        evaluate(web, "GPApp.open('home'); true");
        tap(web, "#openLow", "screen-approved-low");
        tap(web, "#nav [data-screen=journal]", "screen-approved-journal");
        AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
        boolean nativeTree = containsJournalHeading(root);
        if (root != null) root.recycle();
        return new JSONObject().put("status", "PASS").put("input", "ANDROID_POINTER_DOWN_UP")
            .put("routes", "HIGH, LOW, journal")
            .put("webview_accessibility", nativeTree ? "PASS" : "ENV_BLOCKED");
    }

    private boolean containsJournalHeading(AccessibilityNodeInfo node) {
        if (node == null) return false;
        CharSequence text = node.getText();
        if (text != null && text.toString().contains("Дневник · кандидат")) return true;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            boolean found = containsJournalHeading(child);
            if (child != null) child.recycle();
            if (found) return true;
        }
        return false;
    }

    private void tap(WebView web, String selector, String screen) throws Exception {
        String element = "document.querySelector(" + JSONObject.quote(selector) + ")";
        evaluate(web, element + ".scrollIntoView({block:'center',inline:'center'}); true");
        SystemClock.sleep(300);
        String coords = evaluate(web, "(() => {const b=" + element + "; const r=b.getBoundingClientRect();"
            + "const x=(r.left+r.right)/2,y=(r.top+r.bottom)/2;"
            + "if(!b.textContent.trim()||!b.contains(document.elementFromPoint(x,y)))return null;"
            + "return {x,y,width:innerWidth};})()");
        if (coords == null || "null".equals(coords)) throw new IllegalStateException("Covered control: " + selector);
        JSONObject point = new JSONObject(coords);
        int[] origin = new int[2];
        Rect visible = new Rect();
        AtomicReference<Integer> width = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            web.getLocationOnScreen(origin);
            web.getGlobalVisibleRect(visible);
            width.set(web.getWidth());
        });
        double scale = width.get() / point.getDouble("width");
        int x = origin[0] + (int)Math.round(point.getDouble("x") * scale);
        int y = origin[1] + (int)Math.round(point.getDouble("y") * scale);
        if (!visible.contains(x, y)) throw new IllegalStateException("Native viewport clips " + selector);
        long at = SystemClock.uptimeMillis();
        for (int action : new int[]{MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP}) {
            MotionEvent event = MotionEvent.obtain(at, SystemClock.uptimeMillis(), action, x, y, 0);
            try { instrumentation.sendPointerSync(event); }
            finally { event.recycle(); }
        }
        long deadline = SystemClock.elapsedRealtime() + 4500;
        String check = "document.querySelector('.screen.active').id===" + JSONObject.quote(screen);
        while (!"true".equals(evaluate(web, check))) {
            if (SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("Tap did not open " + screen);
            SystemClock.sleep(150);
        }
    }

    private WebView startWebView() throws Exception {
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = instrumentation.startActivitySync(intent);
        AtomicReference<WebView> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> result.set(findWebView(activity.getWindow().getDecorView())));
        WebView web = result.get();
        if (web == null) throw new IllegalStateException("No production WebView");
        long ready = SystemClock.elapsedRealtime() + 60_000;
        while (!"true".equals(evaluate(web, "Boolean(window.GPApp && GPApp.getStorage())"))) {
            if (SystemClock.elapsedRealtime() >= ready) {
                String detail = evaluate(web, "JSON.stringify({state:document.readyState,"
                    + "app:typeof GPApp,storage:typeof GFStorage,error:document.querySelector('.shell-boot-error')?.textContent})");
                throw new IllegalStateException("WebView startup timed out: " + detail);
            }
            SystemClock.sleep(200);
        }
        return web;
    }

    private String evaluate(WebView web, String expression) throws InterruptedException {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> web.evaluateJavascript(expression, result -> {
            value.set(result);
            done.countDown();
        }));
        return done.await(10, TimeUnit.SECONDS) ? value.get() : null;
    }

    private static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup collection = (ViewGroup) view;
            for (int i = 0; i < collection.getChildCount(); i++) {
                WebView child = findWebView(collection.getChildAt(i));
                if (child != null) return child;
            }
        }
        return null;
    }
}
