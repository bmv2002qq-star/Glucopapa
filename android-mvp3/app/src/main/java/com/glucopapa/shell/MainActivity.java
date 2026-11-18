package com.glucopapa.shell;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * MVP host for the self-contained V2 research shell.
 * Loads only verified app assets, blocks remote navigation/network.
 * SQLite is experimental and stores unencrypted snapshots in app-private storage.
 * No proven restore/backup or clinical reliability is claimed.
 */
public class MainActivity extends Activity {
    private static final String BASE = "https://appassets.androidplatform.net/assets/www/";
    private static final int CREATE_JSON = 3101;
    private WebView view;
    private String pendingExport;
    private GFNativeStorage nativeStorage;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        view = new WebView(this);
        setContentView(view);
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
        view.loadUrl(BASE + "index.html");
    }

    public final class LocalExport {
        @JavascriptInterface public void saveJson(String json) {
            if (json == null || json.isEmpty() || json.length() > 8_000_000) return;
            runOnUiThread(() -> {
                if (pendingExport != null) return;
                pendingExport = json;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                intent.putExtra(Intent.EXTRA_TITLE, "ГлюкоПапа_V2_экспорт.json");
                startActivityForResult(intent, CREATE_JSON);
            });
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != CREATE_JSON) return;
        String json = pendingExport;
        pendingExport = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null || json == null) return;
        try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
            if (out == null) throw new IllegalStateException("Cannot open destination");
            out.write(json.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            new AlertDialog.Builder(this).setTitle("Ошибка экспорта")
                .setMessage("Файл не сохранён: " + e.getMessage()).setPositiveButton("OK", null).show();
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
            view.destroy();
        }
        if (nativeStorage != null) {nativeStorage.close();nativeStorage = null;}
        super.onDestroy();
    }
}
