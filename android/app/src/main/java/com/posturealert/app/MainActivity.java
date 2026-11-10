package com.posturealert.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Shows the PostureAlert web app (copied into assets/web at build time) in a WebView,
 * and connects its buttons to PostureService through window.PostureNative.
 */
public class MainActivity extends Activity implements PostureService.Listener {
    /** Android reserves this host for apps serving their own files, so it never reaches the network. */
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/index.html";
    private static final int REQ_PERMISSIONS = 1;

    private WebView web;
    private boolean connectAfterPermissions;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new AssetClient());
        web.addJavascriptInterface(new Bridge(), "PostureNative");
        PostureService.setListener(this);
        web.loadUrl(START_URL);
    }

    @Override
    protected void onDestroy() {
        PostureService.setListener(null);
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // The page uses #hash tabs, so back moves between tabs first
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ---------- Serving the web files from assets ----------

    private final class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!HOST.equals(url.getHost())) return null;
            String path = url.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
            Map<String, String> headers = Collections.singletonMap("Cache-Control", "no-cache");
            try {
                InputStream in = getAssets().open("web" + path);
                String type = mimeType(path);
                String encoding = type.startsWith("text/") || type.contains("javascript") || type.contains("json") ? "utf-8" : null;
                return new WebResourceResponse(type, encoding, 200, "OK", headers, in);
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) return false;
            // Links to other sites open in the phone's browser
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (Exception ignored) {
                // no browser installed
            }
            return true;
        }
    }

    private static String mimeType(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    // ---------- Page -> app ----------

    /** Methods run on a WebView thread, so each hops to the main thread first. */
    private final class Bridge {
        @JavascriptInterface
        public void hello() {
            runOnUiThread(PostureService::hello);
        }

        @JavascriptInterface
        public void connect() {
            runOnUiThread(MainActivity.this::connectWithPermissions);
        }

        @JavascriptInterface
        public void disconnect() {
            runOnUiThread(() -> PostureService.disconnect(MainActivity.this));
        }

        @JavascriptInterface
        public void send(int id, String text) {
            runOnUiThread(() -> PostureService.send(id, text));
        }

        @JavascriptInterface
        public void powerOff(int id) {
            runOnUiThread(() -> PostureService.powerOff(id));
        }

        @JavascriptInterface
        public void setAlerts(boolean vibrate, boolean notify) {
            getSharedPreferences(PostureService.PREFS, MODE_PRIVATE).edit()
                    .putBoolean(PostureService.PREF_VIBRATE, vibrate)
                    .putBoolean(PostureService.PREF_NOTIFY, notify)
                    .apply();
        }
    }

    private void connectWithPermissions() {
        List<String> missing = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            addIfMissing(missing, Manifest.permission.BLUETOOTH_SCAN);
            addIfMissing(missing, Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            addIfMissing(missing, Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            addIfMissing(missing, Manifest.permission.POST_NOTIFICATIONS);
        }
        if (missing.isEmpty()) {
            startService();
            return;
        }
        connectAfterPermissions = true;
        requestPermissions(missing.toArray(new String[0]), REQ_PERMISSIONS);
    }

    private void addIfMissing(List<String> list, String permission) {
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) list.add(permission);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_PERMISSIONS || !connectAfterPermissions) return;
        connectAfterPermissions = false;
        // Bluetooth is required; notifications are optional (the device still buzzes on the back)
        if (PostureService.hasPermissions(this)) startService();
        else onError("PermissionError", "bluetooth permission denied");
    }

    private void startService() {
        Intent intent = new Intent(this, PostureService.class).setAction(PostureService.ACTION_CONNECT);
        startForegroundService(intent);
    }

    // ---------- App -> page ----------

    private void callPage(String method, Object... args) {
        StringBuilder js = new StringBuilder("window.__postureNative && window.__postureNative.").append(method).append('(');
        for (int i = 0; i < args.length; i++) {
            if (i > 0) js.append(',');
            Object a = args[i];
            js.append(a instanceof String ? JSONObject.quote((String) a) : String.valueOf(a));
        }
        js.append(')');
        web.evaluateJavascript(js.toString(), null);
    }

    @Override
    public void onStatus(String status, int attempt) {
        callPage("onStatus", status, attempt);
    }

    @Override
    public void onError(String name, String message) {
        callPage("onError", name, message);
    }

    @Override
    public void onPacket(byte[] data) {
        callPage("onPacket", Base64.encodeToString(data, Base64.NO_WRAP));
    }

    @Override
    public void onReply(int id, boolean ok, String message) {
        callPage("onReply", id, ok, message);
    }
}
