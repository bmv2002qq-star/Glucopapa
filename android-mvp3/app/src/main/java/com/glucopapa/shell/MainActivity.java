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
    private static final int BACKUP_BYTES = 32_000_000;
    private final ExecutorService fileWorker = Executors.newSingleThreadExecutor();
    private final AtomicReference<String> fileResult = new AtomicReference<>();
    private WebView view;
    private int pendingRequest;
    private String pendingFile;
    private GFNativeStorage nativeStorage;
    private GFNativeXDrip nativeXDrip;

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
        nativeStorage = new GFNativeStorage(getApplicationContext());
        view.addJavascriptInterface(nativeStorage, "GFNativeStorage");
        nativeXDrip = new GFNativeXDrip(getApplicationContext());
        view.addJavascriptInterface(nativeXDrip, "GFNativeXDrip");
        view.loadUrl(BASE + "index.html");
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
            intent.setType("application/json");
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
        fileWorker.execute(() -> {
            String code;
            String contents = null;
            try {
                if (requestCode == OPEN_BACKUP) {
                    contents = readBackup(uri);
                    code = "FILE_READ";
                } else {
                    try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                        if (out == null) throw new IllegalStateException("Cannot open destination");
                        out.write(json.getBytes(StandardCharsets.UTF_8));
                    }
                    code = "FILE_SAVED";
                }
            } catch (Exception failure) {
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
            JSONObject message = new JSONObject().put("status", status).put("report", request == CREATE_JSON);
            if (contents != null) message.put("data", contents);
            fileResult.set(message.toString());
            view.evaluateJavascript("if(window.GPApp)window.GPApp.consumeFileResult()", null);
        } catch (JSONException invalid) {
            fileResult.set(null);
        }
    }

    @Override public void onBackPressed() {
        // Browser history is not used for module navigation; press back exits prototype.
        super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (view != null) {
            view.loadUrl("about:blank");
            view.removeJavascriptInterface("AndroidExporter");
            view.removeJavascriptInterface("GFNativeStorage");
            view.removeJavascriptInterface("GFNativeXDrip");
            view.destroy();
            view = null;
            fileResult.set(null);
        }
        if (nativeStorage != null) {nativeStorage.close();nativeStorage = null;}
        if (nativeXDrip != null) {nativeXDrip.close();nativeXDrip = null;}
        fileWorker.shutdownNow();
        super.onDestroy();
    }
}
