package com.glucopapa.shell;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import android.provider.DocumentsContract;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * MVP host for the self-contained V2 research shell.
 * Loads only verified app assets, blocks remote navigation/network.
 * SQLite is experimental and stores unencrypted snapshots in app-private storage.
 * Local files are selected explicitly through the Android document picker.
 */
public class MainActivity extends Activity {
    private static final String BASE = "https://appassets.androidplatform.net/assets/www/";
    private static final int CREATE_JSON = 3101;
    private static final int CREATE_BACKUP = 3102;
    private static final int OPEN_BACKUP = 3103;
    private static final int CREATE_AI_EXPORT = 3104;
    private static final String SETTINGS_NAME = "gf_shell_settings";
    private static final String XDRIP_KEY = "GFV2SHELL_XDRIP_LOCAL_v1";
    private static final String XDRIP_SOURCE_KEY = "GFV2SHELL_XDRIP_SOURCE_v1";
    private static final int BACKUP_BYTES = 32_000_000;
    private final ExecutorService fileWorker = Executors.newSingleThreadExecutor();
    private final AtomicReference<String> fileResult = new AtomicReference<>();
    private WebView view;
    private int pendingRequest;
    private String pendingFile;
    private GFNativeStorage nativeStorage;
    private GFNativeXDrip nativeXDrip;
    private GFNativeXDripHistory nativeXDripHistory;
    private volatile boolean foreground;
    private boolean backInFlight;
    private DiagnosticRing diagnostics;
    private DiagnosticWriter diagnosticWriter;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        view = new WebView(this);
        attachWebView();
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); // Local, pinned V2 JS modules only
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        WebView.setWebContentsDebuggingEnabled(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        view.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView w, WebResourceRequest request) {
                final Uri uri = request.getUrl();
                if ("appassets.androidplatform.net".equals(uri.getHost())
                    && "https".equals(uri.getScheme())) {
                    WebResourceResponse asset = loader.shouldInterceptRequest(uri);
                    if (asset != null) return asset;
                    return new WebResourceResponse("text/plain", "UTF-8", 404,
                        "Asset not found", java.util.Collections.emptyMap(),
                        new java.io.ByteArrayInputStream(new byte[0]));
                }
                return new WebResourceResponse("text/plain", "UTF-8", 403,
                    "Blocked by local-only shell", java.util.Collections.emptyMap(),
                    new java.io.ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest r) {
                return !r.getUrl().toString().startsWith(BASE);
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsConfirm(WebView w, String origin, String message, JsResult result) {
                if (!origin.startsWith(BASE)) { result.cancel(); return true; }
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("Подтвердить", (d, which) -> result.confirm())
                    .setNegativeButton("Отмена", (d, which) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }
        });
        // Safe only because ALL content is local, fixed assets and all external requests are blocked.
        view.addJavascriptInterface(new LocalExport(), "AndroidExporter");
        view.addJavascriptInterface(new ShellPreferences(), "GFShellPreferences");
        nativeStorage = new GFNativeStorage(getApplicationContext());
        view.addJavascriptInterface(nativeStorage, "GFNativeStorage");
        nativeXDrip = new GFNativeXDrip(getApplicationContext());
        view.addJavascriptInterface(nativeXDrip, "GFNativeXDrip");
        nativeXDripHistory = new GFNativeXDripHistory(nativeXDrip, () -> foreground &&
            "on".equals(getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE).getString(XDRIP_KEY, "off")));
        view.addJavascriptInterface(nativeXDripHistory, "GFNativeXDripHistory");
        diagnostics = new DiagnosticRing(getFilesDir().toPath().resolve("diagnostics"));
        diagnosticWriter = new DiagnosticWriter(diagnostics);
        view.addJavascriptInterface(diagnosticWriter, "AndroidDiagnostics");
        view.loadUrl(BASE + (BuildConfig.FIXTURE_JOURNAL ? "fixture-index.html" : "index.html"));
    }

    private void attachWebView() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            setContentView(view);
            return;
        }

        // Android 15 lays out target-35 activities behind the system bars.
        // Keep WebView controls inside the unobstructed native viewport.
        FrameLayout viewport = new FrameLayout(this);
        viewport.setBackgroundColor(Color.WHITE);
        viewport.addView(view, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        viewport.setOnApplyWindowInsetsListener((container, insets) -> {
            Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            container.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(viewport);

        WindowInsetsController controller = getWindow().getInsetsController();
        if (controller != null) {
            int lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            controller.setSystemBarsAppearance(lightBars, lightBars);
        }
        viewport.requestApplyInsets();
    }

    /** UI preferences only. All event data remains in GFStorage and SQLite. */
    public final class ShellPreferences {
        private final android.content.SharedPreferences preferences =
            getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE);

        @JavascriptInterface public String read(String key) {
            return supported(key) ? preferences.getString(key, null) : null;
        }

        @JavascriptInterface public boolean write(String key, String value) {
            if (BuildConfig.FIXTURE_JOURNAL && "GFV2SHELL_MODE_v1".equals(key) &&
                    ("demo".equals(value) || "local".equals(value)) ||
                XDRIP_KEY.equals(key) && ("on".equals(value) || "off".equals(value)) ||
                XDRIP_SOURCE_KEY.equals(key) && ("auto".equals(value) || "web".equals(value) || "provider".equals(value))) {
                return preferences.edit().putString(key, value).commit();
            }
            return false;
        }

        private boolean supported(String key) {
            return (BuildConfig.FIXTURE_JOURNAL && "GFV2SHELL_MODE_v1".equals(key)) ||
                XDRIP_KEY.equals(key) || XDRIP_SOURCE_KEY.equals(key);
        }
    }

    public final class LocalExport {
        @JavascriptInterface public void saveJson(String json) {
            chooseFile(CREATE_JSON, json, "ГлюкоПапа_V2_экспорт.json");
        }

        @JavascriptInterface public void saveBackup(String json) {
            chooseFile(CREATE_BACKUP, json, "ГлюкоПапа_V2_резервная_копия.json");
        }

        @JavascriptInterface public void openBackup() {
            chooseFile(OPEN_BACKUP, null, null);
        }

        @JavascriptInterface public void saveAiExport(String mode, String period) {
            if (!GFNativeStorage.acceptsMode(mode) || !AiJsonlExport.supports(period)) return;
            chooseFile(CREATE_AI_EXPORT, mode + ":" + period, AiJsonlExport.FILE_NAME);
        }

        @JavascriptInterface public String takeFileResult() {
            return fileResult.getAndSet(null);
        }
    }

    private void chooseFile(int request, String json, String name) {
        runOnUiThread(() -> {
            if (isDestroyed() || pendingRequest != 0) return;
            int max = request == CREATE_JSON ? 8_000_000 : 12_000_000;
            if (request != OPEN_BACKUP && (json == null || json.isEmpty() || json.length() > max)) {
                sendFileResult(request, "FILE_SIZE", null);
                return;
            }
            pendingRequest = request;
            pendingFile = json;
            Intent intent = new Intent(request == OPEN_BACKUP ? Intent.ACTION_OPEN_DOCUMENT
                : Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(request == CREATE_AI_EXPORT ? "application/x-ndjson" : "application/json");
            intent.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
            if (name != null) intent.putExtra(Intent.EXTRA_TITLE, name);
            try {
                startActivityForResult(intent, request);
            } catch (RuntimeException unavailable) {
                pendingRequest = 0;
                pendingFile = null;
                sendFileResult(request, "FILE_PICKER_UNAVAILABLE", null);
            }
        });
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != pendingRequest || pendingRequest == 0) return;
        String json = pendingFile;
        pendingFile = null;
        Uri uri = data != null ? data.getData() : null;
        if (resultCode != RESULT_OK || uri == null) {
            pendingRequest = 0;
            sendFileResult(requestCode, "FILE_CANCELLED", null);
            return;
        }
        GFNativeStorage storage = nativeStorage;
        fileWorker.execute(() -> {
            String code;
            String contents = null;
            try {
                if (requestCode == OPEN_BACKUP) {
                    contents = readBackup(uri);
                    code = "FILE_READ";
                } else if (requestCode == CREATE_AI_EXPORT) {
                    exportAi(storage, json, uri);
                    code = "FILE_SAVED";
                } else {
                    try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                        if (out == null) throw new IllegalStateException("Cannot open destination");
                        out.write(json.getBytes(StandardCharsets.UTF_8));
                    }
                    code = "FILE_SAVED";
                }
            } catch (Exception failure) {
                if (requestCode == CREATE_AI_EXPORT) {
                    // ACTION_CREATE_DOCUMENT provides a newly created document. Clean up partial output if supported.
                    try { DocumentsContract.deleteDocument(getContentResolver(), uri); }
                    catch (Exception ignored) { /* Missing footer still marks a partial export. */ }
                }
                code = requestCode == OPEN_BACKUP ? "FILE_READ_FAILED" : "FILE_WRITE_FAILED";
            }
            final String status = code;
            final String result = contents;
            runOnUiThread(() -> {
                pendingRequest = 0;
                sendFileResult(requestCode, status, result);
            });
        });
    }

    private void exportAi(GFNativeStorage storage, String request, Uri uri) throws Exception {
        String[] parameters = request.split(":", -1);
        if (parameters.length != 2 || !AiJsonlExport.supports(parameters[1])) throw new IllegalArgumentException("EXPORT_REQUEST");
        String mode = parameters[0], period = parameters[1];
        String key = "GFV2SHELL_DATA_v1_" + mode;
        JSONObject read = new JSONObject(storage.readSnapshot(key));
        if (!read.optBoolean("ok")) throw new IllegalStateException("EXPORT_SNAPSHOT");
        JSONObject snapshot = read.has("data") ? new JSONObject(read.getString("data"))
            : new JSONObject().put("schemaVersion", 5).put("revision", 0);
        Instant now = Instant.now();
        Instant start = AiJsonlExport.since(now, AiJsonlExport.timezone(snapshot), period);
        String traceStatus = diagnosticWriter.flushStatus();
        DiagnosticRing.View traces = diagnostics.read(mode, start, now, snapshot.getLong("revision"));
        try (OutputStream raw = getContentResolver().openOutputStream(uri, "wt")) {
            if (raw == null) throw new IllegalStateException("EXPORT_FILE_UNAVAILABLE");
            try (OutputStream buffered = new java.io.BufferedOutputStream(raw)) {
                new AiJsonlExport().write(buffered, snapshot, traces, traceStatus,
                    now, period, mode, BuildConfig.VERSION_NAME);
            }
        }
    }

    private String readBackup(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IllegalStateException("Cannot open source");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[16_384];
            for (int n; (n = in.read(buffer)) != -1;) {
                if (bytes.size() + n > BACKUP_BYTES) throw new IllegalArgumentException("File size");
                bytes.write(buffer, 0, n);
            }
            return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        }
    }

    private void sendFileResult(int request, String status, String contents) {
        if (isDestroyed() || view == null) return;
        try {
            JSONObject message = new JSONObject().put("status", status).put("report", request == CREATE_JSON)
                .put("aiExport", request == CREATE_AI_EXPORT);
            if (contents != null) message.put("data", contents);
            fileResult.set(message.toString());
            view.evaluateJavascript("if(window.GPApp)window.GPApp.consumeFileResult()", null);
        } catch (JSONException invalid) {
            fileResult.set(null);
        }
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        // On API 36 the focused WebView may consume a hardware BACK key.
        // Route it at the window boundary along the same path as a system back request.
        if (Build.VERSION.SDK_INT >= 36 && event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) navigateBack();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override public void onBackPressed() {
        navigateBack();
    }

    private void navigateBack() {
        if (view == null) {
            super.onBackPressed();
            return;
        }
        if (backInFlight) return;
        backInFlight = true;
        view.evaluateJavascript("Boolean(window.GPApp && GPApp.back())", handled -> {
            backInFlight = false;
            if (!isDestroyed() && !"true".equals(handled)) super.onBackPressed();
        });
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override protected void onPause() {
        foreground = false;
        if (nativeXDripHistory != null) nativeXDripHistory.suspend();
        super.onPause();
    }

    @Override protected void onDestroy() {
        if (view != null) {
            view.loadUrl("about:blank");
            view.removeJavascriptInterface("AndroidExporter");
            view.removeJavascriptInterface("AndroidDiagnostics");
            view.removeJavascriptInterface("GFShellPreferences");
            view.removeJavascriptInterface("GFNativeStorage");
            view.removeJavascriptInterface("GFNativeXDrip");
            view.removeJavascriptInterface("GFNativeXDripHistory");
            view.destroy();
            view = null;
            fileResult.set(null);
        }
        if (nativeStorage != null) {nativeStorage.close();nativeStorage = null;}
        if (nativeXDripHistory != null) nativeXDripHistory.close();
        if (nativeXDrip != null) {nativeXDrip.close();nativeXDrip = null;}
        fileWorker.shutdownNow();
        if (diagnosticWriter != null) diagnosticWriter.close();
        super.onDestroy();
    }
}
