package io.github.boxshelf;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Display;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Boxshelf on Android (AYN Thor). The shared UI runs in Capacitor's WebView; this activity only makes it feel like a
 * console front end: full screen with the system bars hidden, the screen kept on while it's being used, and controller
 * buttons left to the page's Gamepad API instead of Android turning B into "Back" and closing the app.
 */
public class MainActivity extends BridgeActivity {
    private long lastPadButton = 0;

    // ---------- keeping the screen on (beta.12) ----------
    // The screen stays on while Boxshelf is in front and was used in the last few minutes (the page's "Dim the screen
    // after" setting, else IDLE_DEFAULT), or while a RomM download runs (holdAwake). After that the flag is cleared and
    // Android's own screen timeout takes over, so a phone left on the shelf (or in attract mode) sleeps like any app.
    // It's never held while Boxshelf is paused: a game in front owns the screen then.
    private static final long IDLE_DEFAULT = 10 * 60_000L;
    // a pause longer than this (a game, the screen off) also pauses the page's WebView and its timers until Boxshelf is
    // back; short ones (a permission prompt, the folder picker) leave it running, and the launch's own short timers finish
    private static final long WEB_PAUSE_AFTER = 2500L;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private long lastInput = SystemClock.uptimeMillis();
    private long idleMs = IDLE_DEFAULT;
    private int holds = 0;
    private boolean keptOn = false;
    private boolean paused = false;
    private boolean checkPending = false;
    private boolean webPaused = false;
    private final Runnable awakeCheck = () -> { checkPending = false; applyAwake(); };
    private final Runnable webPause = this::pauseWeb;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BoxshelfNativePlugin.class); // folders, emulator detection, launching (must come before super.onCreate)
        super.onCreate(savedInstanceState);
        // (beta.12) phones and tablets turn with the screen (the manifest says fullUser); the Thor's two screens are laid
        // out side by side for landscape, so it stays landscape whatever its auto-rotate setting says
        if (android.os.Build.MODEL != null && android.os.Build.MODEL.toLowerCase(java.util.Locale.ROOT).contains("thor")) {
            setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        hideSystemBars();
        pinRefreshRate();
        applyAwake();

        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv != null) {
            wv.getSettings().setMediaPlaybackRequiresUserGesture(false); // menu sounds play without a touch first
            wv.getSettings().setUseWideViewPort(true);      // the page's <meta viewport width=1440> sets the layout size…
            wv.getSettings().setLoadWithOverviewMode(true); // …and it's scaled to fill the screen, like the TV layout
            wv.getSettings().setSupportZoom(false);
            wv.setBackgroundColor(0xFF0B0B14);
        }

        // System back (gesture / nav bar) becomes Esc on the page, so it steps back through Boxshelf's screens instead of
        // closing the app. Skipped right after a controller button, which the page already read through the Gamepad API.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (SystemClock.uptimeMillis() - lastPadButton < 200) return;
                sendKey("Escape", 27);
            }
        });
    }

    @Override
    public void onResume() {
        paused = false;
        lastInput = SystemClock.uptimeMillis(); // coming back counts as being used
        ui.removeCallbacks(webPause);
        resumeWeb(); // before the plugins hear "resume", so the page's timers run when it answers
        super.onResume();
        applyAwake();
    }

    @Override
    public void onPause() {
        super.onPause();
        paused = true;
        applyAwake(); // the flag goes at once: whatever is in front now owns the screen
        ui.removeCallbacks(webPause);
        ui.postDelayed(webPause, WEB_PAUSE_AFTER);
    }

    @Override
    public void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        // a screen closing while its timers are paused starts them again on its way out: they belong to the whole app
        if (webPaused) { WebView wv = getBridge() != null ? getBridge().getWebView() : null; if (wv != null) { try { wv.resumeTimers(); } catch (RuntimeException ignored) {} } webPaused = false; }
        super.onDestroy();
    }

    // the page's WebView stops drawing and its JavaScript timers stop (Android pauses the timers of every WebView in the
    // app: the bottom screen's too, which is hidden by then). Capacitor itself never does this (its KeepRunning is on)
    private void pauseWeb() {
        if (!paused || webPaused) return;
        if (BoxshelfNativePlugin.topStaysUp) return; // (beta.13) an app opened on the bottom screen: the shelf stays live
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) return;
        // (beta.13) Boxshelf's bottom page still on show (a game on top that doesn't use it): only this page stops drawing,
        // because pauseTimers() would freeze the bottom page's timers too
        try { wv.onPause(); if (!BoxshelfNativePlugin.bottomStaysUp) wv.pauseTimers(); webPaused = true; } catch (RuntimeException ignored) {}
    }

    // (beta.12) the timers are restarted every time Boxshelf comes to the front, paused here or not: pauseTimers() stops the
    // timers of every WebView in the app, and a Boxshelf screen made again (Android switching the Home app can close the
    // old one and start a new one) would otherwise never start them, and look frozen
    private void resumeWeb() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        if (wv == null) { webPaused = false; return; }
        try { if (webPaused) wv.onResume(); wv.resumeTimers(); } catch (RuntimeException ignored) {}
        webPaused = false;
    }

    /** Someone used Boxshelf (a key, a stick, a touch on either screen). Main thread only. */
    void noteInput() {
        lastInput = SystemClock.uptimeMillis();
        if (!keptOn && !paused) applyAwake();
    }

    /** The page's "Dim the screen after" (minutes; 0 or less = the default). Any thread. */
    void setIdleMinutes(int minutes) {
        final long ms = minutes > 0 ? Math.min(minutes, 240) * 60_000L : IDLE_DEFAULT;
        ui.post(() -> { idleMs = ms; ui.removeCallbacks(awakeCheck); checkPending = false; applyAwake(); });
    }

    /** Something long is running that the player is waiting on (a RomM download): the screen stays on. Any thread. */
    void holdAwake(boolean on) {
        ui.post(() -> { holds = Math.max(0, holds + (on ? 1 : -1)); if (!on) lastInput = SystemClock.uptimeMillis(); applyAwake(); });
    }

    // sets or clears FLAG_KEEP_SCREEN_ON, and checks again when the idle time is up (one timer, never a loop)
    private void applyAwake() {
        long now = SystemClock.uptimeMillis(), left = idleMs - (now - lastInput);
        boolean on = !paused && (holds > 0 || left > 0);
        if (on != keptOn) {
            keptOn = on;
            try {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } catch (RuntimeException ignored) {}
        }
        if (on && holds == 0 && !checkPending) { checkPending = true; ui.postDelayed(awakeCheck, Math.max(1000L, left)); }
    }

    /**
     * Boxshelf runs at 60 Hz, like the Windows build on a TV. The Thor's main screen runs at 120 Hz, which asked the phone
     * GPU to draw the 3D shelf and the museum twice as often as a PC does, and any frame that missed the 8 ms budget showed
     * as a stutter. Only this window asks for it: games and emulators launched from Boxshelf keep the screen's full rate.
     */
    private void pinRefreshRate() {
        try {
            Display d = getWindowManager().getDefaultDisplay();
            Display.Mode cur = d.getMode(), best = null;
            for (Display.Mode m : d.getSupportedModes()) {
                if (m.getPhysicalWidth() != cur.getPhysicalWidth() || m.getPhysicalHeight() != cur.getPhysicalHeight()) continue;
                float hz = m.getRefreshRate();
                if (hz > 58f && hz < 62f) { best = m; break; }
            }
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            if (best != null) lp.preferredDisplayModeId = best.getModeId();
            lp.preferredRefreshRate = 60f;
            getWindow().setAttributes(lp);
        } catch (Throwable ignored) {
            // a screen without a 60 Hz mode simply keeps its own rate
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars(); // bars come back after a swipe or returning from another app
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        noteInput();
        int src = e.getSource();
        boolean pad = (src & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
                || (src & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
        if (pad && (KeyEvent.isGamepadButton(e.getKeyCode()) || e.getKeyCode() == KeyEvent.KEYCODE_BACK)) {
            lastPadButton = SystemClock.uptimeMillis();
            super.dispatchKeyEvent(e); // the WebView still sees it, which feeds navigator.getGamepads()
            return true;               // but Android doesn't turn an unused B into Back and close the app
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        noteInput();
        return super.dispatchTouchEvent(e);
    }

    @Override
    public boolean dispatchGenericMotionEvent(MotionEvent e) {
        noteInput(); // sticks and triggers (the page reads them through the Gamepad API)
        return super.dispatchGenericMotionEvent(e);
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    private void sendKey(String key, int code) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        String ev = "{key:'" + key + "',code:'" + key + "',keyCode:" + code + ",which:" + code + ",bubbles:true,cancelable:true}";
        String js = "(function(){var t=document.activeElement||document.body;"
                + "t.dispatchEvent(new KeyboardEvent('keydown'," + ev + "));"
                + "t.dispatchEvent(new KeyboardEvent('keyup'," + ev + "));})();";
        getBridge().getWebView().evaluateJavascript(js, null);
    }
}
