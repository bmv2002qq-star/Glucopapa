package com.glucopapa.shell.qa;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Intent;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.webkit.WebView;
import com.glucopapa.shell.MainActivity;
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

    JSONObject exercise() throws Exception {
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = instrumentation.startActivitySync(intent);
        AtomicReference<WebView> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> result.set(findWebView(activity.getWindow().getDecorView())));
        WebView web = result.get();
        if (web == null) throw new IllegalStateException("No production WebView");
        long ready = SystemClock.elapsedRealtime() + 15_000;
        while (!"true".equals(evaluate(web, "Boolean(window.GPApp && GPApp.getStorage())"))) {
            if (SystemClock.elapsedRealtime() >= ready) throw new IllegalStateException("WebView startup timed out");
            SystemClock.sleep(200);
        }
        String script;
        try (InputStream input = instrumentation.getContext().getAssets().open("webview-qa.js")) {
            script = new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
        UiAutomation automation = instrumentation.getUiAutomation();
        AccessibilityServiceInfo service = automation.getServiceInfo();
        service.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        automation.setServiceInfo(service);
        instrumentation.runOnMainSync(() -> web.evaluateJavascript(script, null));
        long deadline = SystemClock.elapsedRealtime() + 90_000;
        while (SystemClock.elapsedRealtime() < deadline) {
            confirmTestDialog(automation);
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

    private String evaluate(WebView web, String expression) throws InterruptedException {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> web.evaluateJavascript(expression, result -> {
            value.set(result);
            done.countDown();
        }));
        return done.await(1, TimeUnit.SECONDS) ? value.get() : null;
    }

    private void confirmTestDialog(UiAutomation automation) {
        for (AccessibilityWindowInfo window : automation.getWindows()) {
            if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText("Подтвердить")) {
                if ("android.widget.Button".contentEquals(node.getClassName())
                    && "Подтвердить".equals(String.valueOf(node.getText()))
                    && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return;
            }
        }
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
