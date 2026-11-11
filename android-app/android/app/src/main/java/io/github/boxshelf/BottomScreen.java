package io.github.boxshelf;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.Presentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.drawable.ColorDrawable;
import android.hardware.display.DisplayManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The AYN Thor's second (bottom) screen. While Boxshelf is in front it shows a small page of its own there
 * (bottom.html: the selected game's case to turn and open, its details, trophies and a few big buttons), in an
 * android.app.Presentation holding a second WebView.
 *
 * Why it's built this way:
 *  - The Presentation belongs to Boxshelf's window, so it's hidden the moment Boxshelf pauses (a game starts, Android's
 *    settings open…) and comes back on resume. The bottom screen is therefore always free for DS / 3DS emulators and
 *    bottom-screen mods while a game runs.
 *  - Its window can't take key focus (FLAG_NOT_FOCUSABLE): touching the bottom screen must never steal the controller
 *    from the shelf on the top screen. Touches still arrive.
 *  - The second WebView has no Capacitor server behind it, so it serves https://localhost/… itself: the app's own web
 *    files (assets/public, where Capacitor packs www) and https://localhost/_capacitor_file_/… from the app's private
 *    files folder only (where downloaded covers are kept). Nothing else on the device is reachable from it.
 *  - Everything here runs on the main thread (the public methods post there), and every failure ends in "no bottom
 *    screen", never a crash: a phone without a second screen simply never shows one.
 */
final class BottomScreen implements DisplayManager.DisplayListener {
    interface Listener {
        void onMessage(String json); // the bottom page said something (a button press, "ready")
        void onChange();             // shown / hidden / screen added or removed
    }

    private static final String TAG = "BoxshelfBottom";
    private static final String PAGE = "https://localhost/bottom.html";
    private static final String PREF_ON = "bottom_on";
    private static final int BG = 0xFF0B0B14;

    private final Activity activity;
    private final Listener listener;
    private final DisplayManager dm;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Screen screen;      // the presentation on the bottom display, or null
    private volatile boolean visible;    // it's on screen right now
    private boolean resumed;
    private boolean released;
    private long lastRebuild;
    private int rebuilds;

    BottomScreen(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        this.dm = (DisplayManager) activity.getSystemService(Context.DISPLAY_SERVICE);
        this.prefs = activity.getSharedPreferences("boxshelf_bottom", Context.MODE_PRIVATE);
        if (dm != null) dm.registerDisplayListener(this, main);
    }

    // ---------- lifecycle (called by the plugin on the main thread) ----------
    void onResume() { main.post(() -> { resumed = true; showIfWanted(); }); }

    void onPause() { main.post(() -> { resumed = false; hideNow(); }); }

    // (beta.13) An app opened on the bottom screen (held on the Apps tab: "Open on bottom screen"): the page steps aside
    // so the app is seen, and stays aside (Boxshelf coming to the front again doesn't cover the app) until the player
    // asks for it back from the top screen, or turns the bottom screen off and on.
    private volatile boolean away;
    boolean isAway() { return away; }
    int displayId() { try { Display d = findDisplay(); return d == null ? -1 : d.getDisplayId(); } catch (RuntimeException e) { return -1; } }
    void stepAway() { main.post(() -> { away = true; hideNow(); }); }
    void comeBack() { main.post(() -> { away = false; rebuilds = 0; showIfWanted(); }); }

    void release() {
        // Right now when we're already on the main thread (the activity's onDestroy): posted, it would run after the
        // activity is gone and Android would log the presentation's window as leaked.
        Runnable r = () -> {
            if (released) return;
            released = true;
            main.removeCallbacksAndMessages(null); // a pending rebuild must not bring it back
            if (dm != null) dm.unregisterDisplayListener(this);
            dropScreen();
        };
        if (Looper.myLooper() == Looper.getMainLooper()) r.run(); else main.post(r);
    }

    // ---------- what the page can ask for ----------
    // (0.4.0) The bottom page is on by default only on the AYN Thor (its built-in second screen). (beta.12) Only the Thor:
    // AYN's other handhelds (Odin 2, Portal…) have one screen, so a second display there is a TV or a dock. On any other
    // device a second display is usually a TV, a monitor or a cast (HDMI, DeX, Miracast): left alone unless the player
    // turns the bottom screen on in Settings.
    static boolean thorDevice() {
        return String.valueOf(Build.MODEL).toLowerCase(Locale.ROOT).contains("thor"); // (the model only: other makers use "thor" as a code name)
    }
    static String deviceName() { return (Build.MANUFACTURER + " " + Build.MODEL).trim(); }
    boolean enabled() { return prefs.getBoolean(PREF_ON, thorDevice()); }

    /** On / off. remember = keep the choice across restarts (Settings), otherwise just for now. */
    void setEnabled(boolean on, boolean remember) {
        if (remember) prefs.edit().putBoolean(PREF_ON, on).apply();
        main.post(() -> {
            if (on) { rebuilds = 0; away = false; showIfWanted(); }
            else { dropScreen(); listener.onChange(); } // off means off: the WebView is freed too
        });
    }

    /** A message for the bottom page (JSON text): handed to window.bsBottom.recv as a string, safely quoted. */
    void post(String json) {
        if (json == null) return;
        main.post(() -> {
            Screen s = screen;
            if (s == null || s.web == null) return;
            try { s.web.evaluateJavascript("window.bsBottom&&bsBottom.recv(" + JSONObject.quote(json) + ")", null); }
            catch (RuntimeException e) { Log.w(TAG, "post failed", e); }
        });
    }

    @SuppressWarnings("deprecation") // Display.getRealMetrics: still the simple way to read a second screen's size
    JSObject status() {
        JSObject r = new JSObject();
        Display d = null;
        try { d = findDisplay(); } catch (RuntimeException ignored) {}
        r.put("available", d != null);
        r.put("enabled", enabled());
        r.put("shown", visible);
        r.put("away", away);             // (beta.13) an app is open on the bottom screen
        r.put("device", deviceName());   // (0.4.0) e.g. "AYN Thor": shown in Settings so a player can tell what it saw
        r.put("builtIn", thorDevice());  // the second screen is the handheld's own (on by default), not a TV or a cast
        if (d != null) {
            DisplayMetrics m = new DisplayMetrics();
            d.getRealMetrics(m);
            r.put("width", m.widthPixels);
            r.put("height", m.heightPixels);
            r.put("density", (double) m.density);
            r.put("name", String.valueOf(d.getName()));
        }
        return r;
    }

    // ---------- showing and hiding ----------
    // (beta.12) Which second display: the handheld's own panel, never a TV. A Thor in its dock has three displays (its two
    // panels and the TV), and the TV is the one Android lists as a "presentation" display, so the first one found was
    // often the TV. Each usable display is scored: built-in signs up, HDMI / USB-C / cast signs down, and on a tie the
    // lowest id (the built-in panels are set up at boot, a plugged-in screen comes later). The name is only a hint (some
    // makers' second panels are named like an HDMI screen), so a lone display that looks external is still used, except
    // on the Thor when the display's own EDID says it's a plugged-in TV or monitor (sinkScore < 0): never the bottom page there.
    private Display findDisplay() {
        if (dm == null) return null;
        boolean thor = thorDevice();
        Display best = null;
        int bestScore = 0;
        for (Display d : dm.getDisplays()) {
            if (!usable(d)) continue;
            if (thor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && Api31.sinkScore(d) < 0) continue;
            int s = score(d);
            if (best == null || s > bestScore || (s == bestScore && d.getDisplayId() < best.getDisplayId())) { best = d; bestScore = s; }
        }
        return best;
    }

    private static boolean usable(Display d) {
        return d != null && d.getDisplayId() != Display.DEFAULT_DISPLAY && d.isValid() && (d.getFlags() & Display.FLAG_PRIVATE) == 0;
    }

    // > 0: looks built in, < 0: looks like a TV, monitor or cast, 0: can't tell
    private static int score(Display d) {
        int s = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) s = Api31.sinkScore(d); // what the display itself says (EDID), when it says
        String n = String.valueOf(d.getName()).toLowerCase(Locale.ROOT);
        if (n.contains("built-in") || n.contains("builtin") || n.contains("internal") || n.contains("内置")) s += 1; // (the last: Chinese for "built in")
        if (n.contains("hdmi") || n.contains("displayport") || n.contains("usb") || n.contains("external") || n.contains("wifi")
                || n.contains("wi-fi") || n.contains("wireless") || n.contains("miracast") || n.contains("cast") || n.contains("overlay")
                || n.contains("virtual")) s -= 4;
        return s;
    }

    // Display.getDeviceProductInfo (Android 12+), kept in a class of its own so older Androids never load it
    @TargetApi(Build.VERSION_CODES.S)
    private static final class Api31 {
        static int sinkScore(Display d) {
            try {
                android.hardware.display.DeviceProductInfo p = d.getDeviceProductInfo();
                if (p == null) return 0;
                int t = p.getConnectionToSinkType();
                if (t == android.hardware.display.DeviceProductInfo.CONNECTION_TO_SINK_BUILT_IN) return 2;
                if (t == android.hardware.display.DeviceProductInfo.CONNECTION_TO_SINK_DIRECT
                        || t == android.hardware.display.DeviceProductInfo.CONNECTION_TO_SINK_TRANSITIVE) return -4;
            } catch (RuntimeException ignored) {}
            return 0;
        }
    }

    private void showIfWanted() {
        if (released || !resumed || away || !enabled() || activity.isFinishing()) return;
        Display d;
        try { d = findDisplay(); } catch (RuntimeException e) { d = null; }
        if (d == null) { if (screen != null) dropScreen(); listener.onChange(); return; }
        Screen s = screen;
        if (s != null && s.getDisplay().getDisplayId() != d.getDisplayId()) { dropScreen(); s = null; }
        try {
            if (s == null) { s = new Screen(activity, d); screen = s; }
            s.show();
            if (s.web != null) s.web.onResume();
            visible = true;
        } catch (RuntimeException e) { // WindowManager.InvalidDisplayException (the screen went away meanwhile) and friends
            Log.w(TAG, "couldn't show the bottom screen", e);
            dropScreen();
        }
        listener.onChange();
    }

    private void hideNow() {
        Screen s = screen;
        if (s == null) return;
        try {
            if (s.web != null) s.web.onPause(); // its animations stop while hidden
            s.hide();
            visible = false;
        } catch (RuntimeException e) { dropScreen(); }
        listener.onChange();
    }

    private void dropScreen() {
        Screen s = screen;
        screen = null;
        visible = false;
        if (s == null) return;
        s.dropping = true;
        try { s.dismiss(); } catch (RuntimeException ignored) {}
        WebView w = s.web;
        s.web = null;
        if (w != null) {
            try {
                ViewParent p = w.getParent();
                if (p instanceof ViewGroup) ((ViewGroup) p).removeView(w);
                w.destroy();
            } catch (RuntimeException ignored) {}
        }
    }

    /** Android closed the presentation by itself (screen changed or removed, renderer gone): build a new one, a few times at most. */
    private void rebuildSoon() {
        long now = SystemClock.uptimeMillis();
        if (now - lastRebuild > 30000) rebuilds = 0;
        lastRebuild = now;
        if (++rebuilds > 3) { Log.w(TAG, "bottom screen keeps closing; leaving it off until the next start"); return; }
        main.postDelayed(this::showIfWanted, 800);
    }

    // ---------- screens coming and going ----------
    // (beta.12) a screen plugged in while the page is up moves it only when the new one is the better choice (findDisplay:
    // a TV never takes it from the built-in panel); the page's own screen going away tries the others
    @Override
    public void onDisplayAdded(int displayId) {
        Screen s = screen;
        if (s == null) { showIfWanted(); return; }
        Display d;
        try { d = findDisplay(); } catch (RuntimeException e) { d = null; }
        if (d != null && d.getDisplayId() != s.getDisplay().getDisplayId()) showIfWanted();
    }

    @Override
    public void onDisplayRemoved(int displayId) {
        Screen s = screen;
        if (s != null && s.getDisplay().getDisplayId() == displayId) { dropScreen(); listener.onChange(); showIfWanted(); }
    }

    @Override
    public void onDisplayChanged(int displayId) {}

    // ---------- the presentation and its WebView ----------
    private final class Screen extends Presentation {
        WebView web;
        boolean dropping;

        Screen(Context outer, Display display) {
            super(outer, display);
            setCancelable(false);
            setOnDismissListener(dlg -> {
                if (dropping) return; // we closed it
                main.post(() -> { if (screen == Screen.this) { dropScreen(); listener.onChange(); rebuildSoon(); } });
            });
        }

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            Window w = getWindow();
            if (w != null) {
                // (beta.12) no FLAG_KEEP_SCREEN_ON of its own: MainActivity keeps the screen on while Boxshelf is used,
                // and a touch here counts as use (dispatchTouchEvent below)
                w.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
                        | WindowManager.LayoutParams.FLAG_FULLSCREEN);
                w.setBackgroundDrawable(new ColorDrawable(BG));
                // the whole panel, edge to edge: no strip kept for system bars or a cutout (on the Thor the page left
                // black bands at the bottom and the side)
                w.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
                w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    WindowManager.LayoutParams lp = w.getAttributes();
                    lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                            ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                            : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                    w.setAttributes(lp);
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) w.setDecorFitsSystemWindows(false);
            }
            WebView v = new WebView(getContext());
            WebSettings st = v.getSettings();
            st.setJavaScriptEnabled(true);
            st.setDomStorageEnabled(true);
            st.setSupportZoom(false);
            st.setBuiltInZoomControls(false);
            st.setDisplayZoomControls(false);
            st.setAllowFileAccess(false);
            st.setAllowContentAccess(false);
            st.setMediaPlaybackRequiresUserGesture(true);
            v.setBackgroundColor(BG);
            v.setVerticalScrollBarEnabled(false);
            v.setHorizontalScrollBarEnabled(false);
            v.setOverScrollMode(View.OVER_SCROLL_NEVER);
            v.setFocusable(false);
            v.addJavascriptInterface(new PageBridge(main, listener), "BoxshelfBottom");
            v.setWebViewClient(new Client());
            v.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(ConsoleMessage m) {
                    Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                    return true;
                }
            });
            web = v;
            setContentView(v, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            hideBars(w);
            v.loadUrl(PAGE);
        }

        @Override
        public boolean dispatchTouchEvent(MotionEvent ev) {
            if (activity instanceof MainActivity) ((MainActivity) activity).noteInput(); // (the main thread: input arrives there)
            return super.dispatchTouchEvent(ev);
        }

        @SuppressWarnings("deprecation")
        private void hideBars(Window w) {
            if (w == null) return;
            try {
                w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowInsetsController c = w.getInsetsController();
                    if (c != null) {
                        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        c.hide(WindowInsets.Type.systemBars());
                    }
                }
            } catch (RuntimeException ignored) {} // bars on the bottom screen are cosmetic
        }
    }

    /**
     * window.BoxshelfBottom.post(json) on the bottom page. Called on a WebView thread: handed to the main thread.
     * A public static class with a public method, like Capacitor's own bridge, so the WebView may always call it.
     */
    public static final class PageBridge {
        private final Handler main;
        private final Listener listener;

        PageBridge(Handler main, Listener listener) { this.main = main; this.listener = listener; }

        @JavascriptInterface
        public void post(String json) {
            if (json == null || json.length() > 65536) return;
            main.post(() -> listener.onMessage(json));
        }
    }

    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            return serve(req.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            return true; // the bottom page never navigates anywhere (a link would open a whole browser on the bottom screen)
        }

        @Override
        @TargetApi(Build.VERSION_CODES.O)
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // the page's renderer died: drop this WebView (returning true promises that) and build a fresh one, instead of
            // Android closing the whole app
            main.post(() -> {
                Screen s = screen;
                if (s != null && s.web == view) { dropScreen(); listener.onChange(); rebuildSoon(); }
                else { try { view.destroy(); } catch (RuntimeException ignored) {} }
            });
            return true;
        }
    }

    // ---------- the bottom page's files ----------
    private WebResourceResponse serve(Uri u) {
        if (u == null || !"https".equals(u.getScheme()) || !"localhost".equals(u.getHost())) return null; // anything else (online art) loads normally
        String path = u.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/bottom.html";
        try {
            if (path.startsWith("/_capacitor_file_/")) return fileResponse(path.substring("/_capacitor_file_".length()));
            if (path.contains("..")) return notFound();
            InputStream in = activity.getAssets().open("public" + path);
            return ok(mime(path), in);
        } catch (IOException | RuntimeException e) {
            return notFound();
        }
    }

    private WebResourceResponse fileResponse(String abs) throws IOException {
        File f = new File(abs);
        String path = f.getCanonicalPath(), files = activity.getFilesDir().getCanonicalPath() + File.separator, cache = activity.getCacheDir().getCanonicalPath() + File.separator;
        // the app's own files only: its storage, and its cache (the Art Studio's versions are kept there while you choose)
        if (!(path.startsWith(files) || path.startsWith(cache)) || !f.isFile()) return notFound();
        return ok(mime(abs), new FileInputStream(f));
    }

    private static WebResourceResponse ok(String mime, InputStream in) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        String enc = mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("svg+xml") ? "UTF-8" : null;
        return new WebResourceResponse(mime, enc, 200, "OK", h, in);
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        int q = p.indexOf('?');
        if (q >= 0) p = p.substring(0, q);
        String ext = p.lastIndexOf('.') >= 0 ? p.substring(p.lastIndexOf('.') + 1) : "";
        switch (ext) {
            case "html": case "htm": return "text/html";
            case "js": case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": return "application/json";
            case "woff2": return "font/woff2";
            case "woff": return "font/woff";
            case "ttf": return "font/ttf";
            case "png": return "image/png";
            case "jpg": case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            case "avif": return "image/avif";
            case "svg": return "image/svg+xml";
            case "glb": return "model/gltf-binary";
            case "mp4": return "video/mp4";
            case "webm": return "video/webm";
            default: return "application/octet-stream";
        }
    }
}
