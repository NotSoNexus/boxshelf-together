package io.github.boxshelf;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Boxshelf's Android side: the few things the shared UI can't do from a web page.
 * pickFolder (Storage Access Framework, permission kept across restarts), listFiles (fast recursive listing of a picked
 * folder), apps / activities (which emulators are installed), launch (start an emulator with a game), readText /
 * writeText (settings in the app's private storage), and a "resume" event when the player comes back from a game.
 */
@CapacitorPlugin(name = "BoxshelfNative")
public class BoxshelfNativePlugin extends Plugin {
    // (beta.12) the plugin's threads are shut down with the activity (handleOnDestroy); work handed to them after that is
    // dropped instead of throwing on the plugin's thread (the page that asked is gone, nobody waits for the answer)
    private static final RejectedExecutionHandler DROP = new ThreadPoolExecutor.DiscardPolicy();
    private final ExecutorService io = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<Runnable>(), Executors.defaultThreadFactory(), DROP);
    // box art downloads get their own threads, so a slow server never holds up a folder scan (io) or the page. Six: the
    // page asks for up to four pictures at once (each source has its own limit there) plus a lookup or a name list, and
    // most of a download is waiting on the network. Background priority: they never compete with the shelf's frames
    private final ExecutorService net = new ThreadPoolExecutor(6, 6, 0L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<Runnable>(), r -> {
        Thread t = new Thread(() -> { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); r.run(); }, "boxshelf-net");
        t.setDaemon(true);
        return t;
    }, DROP);
    // ...but at most two pictures are decoded and scaled at once (the CPU- and memory-heavy part: a big full wrap can
    // take tens of MB while it is cut), whatever number are downloading
    private final Semaphore decodeGate = new Semaphore(2);
    private static final Set<String> SKIP_DIRS = new HashSet<>(java.util.Arrays.asList("dlc", "update", "updates", "patches", "mods", "sce_sys", "sce_module", "boxshelf art"));

    // ---------- folders ----------
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        // no folder picker on the device: the picker never opens, so its callback never runs and the call is answered here
        try { startActivityForResult(call, i, "folderPicked"); }
        catch (ActivityNotFoundException e) { call.reject("No folder picker is installed on this device"); }
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null || data.getData() == null) { JSObject r = new JSObject(); r.put("canceled", true); call.resolve(r); return; }
        Uri tree = data.getData();
        // read + write, so the same pick works for an art & manuals folder Boxshelf saves into (read only if write isn't offered)
        ContentResolver cr = getContext().getContentResolver();
        // (beta.10) whether Android kept the permission is said back (persisted): without it the folder reads today but not
        // after a restart, and the page tells the player so instead of the pick quietly "working"
        boolean kept = false; String why = "";
        try { cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); kept = true; }
        catch (SecurityException e) { try { cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); kept = true; } catch (SecurityException e2) { why = String.valueOf(e2.getMessage()); } }
        JSObject r = new JSObject();
        r.put("uri", tree.toString());
        r.put("persisted", kept); if (!kept) r.put("persistError", why);
        // (beta.8) a picker that hands back a plain document link instead of a folder tree (some makers' pickers) threw
        // here and left the folder step waiting forever: it's answered as a cancel instead
        try { r.put("docId", DocumentsContract.getTreeDocumentId(tree)); }
        catch (IllegalArgumentException e) { JSObject c = new JSObject(); c.put("canceled", true); c.put("error", "not a folder"); call.resolve(c); return; }
        call.resolve(r);
    }

    @PluginMethod
    public void fontScale(PluginCall call) { // (beta.11) Android's own font size (Settings → Display → Font size): 1 is normal → { scale }
        float s = 1f;
        try { s = getContext().getResources().getConfiguration().fontScale; } catch (Exception e) { s = 1f; }
        JSObject r = new JSObject(); r.put("scale", (double) s); call.resolve(r);
    }

    @PluginMethod
    public void folderAccess(PluginCall call) { // the folders Boxshelf can still read (permissions survive reboots, not uninstalls)
        JSArray a = new JSArray();
        for (android.content.UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) if (p.isReadPermission()) a.put(p.getUri().toString());
        JSObject r = new JSObject(); r.put("uris", a); call.resolve(r);
    }

    @PluginMethod
    public void releaseFolder(PluginCall call) { // (beta.10) a folder removed in Settings: its lasting permission given back { uri } → { released }
        String s = call.getString("uri", "");
        boolean done = false;
        if (s != null && !s.isEmpty()) {
            ContentResolver cr = getContext().getContentResolver();
            for (android.content.UriPermission p : cr.getPersistedUriPermissions()) { // (only a grant that's really there: anything else would throw)
                if (!s.equals(p.getUri().toString())) continue;
                int flags = (p.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0) | (p.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
                if (flags == 0) continue;
                try { cr.releasePersistableUriPermission(p.getUri(), flags); done = true; } catch (SecurityException ignored) {}
            }
        }
        JSObject r = new JSObject(); r.put("released", done); call.resolve(r);
    }

    @PluginMethod
    public void openUrl(PluginCall call) { // (beta.10) Settings' "Open site" links: an https address in the device's browser (nothing else is opened)
        String s = call.getString("url", "");
        Uri u = Uri.parse(s == null ? "" : s.trim());
        if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty()) { call.reject("Only https links can be opened"); return; }
        try { getContext().startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); }
        catch (ActivityNotFoundException e) { call.reject("No browser is installed to open that link"); }
        catch (RuntimeException e) { call.reject("That link couldn't be opened"); }
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        final String treeStr = call.getString("uri");
        final int maxDepth = call.getInt("depth", 4);
        final JSArray extArr = call.getArray("exts", new JSArray());
        if (treeStr == null) { call.reject("No folder given"); return; }
        io.execute(() -> {
            try {
                Set<String> exts = new HashSet<>();
                for (int k = 0; k < extArr.length(); k++) exts.add(extArr.getString(k).toLowerCase(Locale.ROOT));
                Uri tree = Uri.parse(treeStr);
                ContentResolver cr = getContext().getContentResolver();
                String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED };
                JSArray out = new JSArray();
                ArrayDeque<String[]> todo = new ArrayDeque<>(); // { docId, relative dir, depth }
                todo.add(new String[] { startId(tree), "", "0" }); // the picked folder, or one of its sub folders (…/tree/X/document/Y)
                int dirs = 0;
                while (!todo.isEmpty() && dirs < 5000) {
                    stepAside(); // (beta.12) a game started meanwhile: the scan waits for Boxshelf to be back
                    String[] d = todo.poll(); dirs++;
                    int depth = Integer.parseInt(d[2]);
                    Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(tree, d[0]);
                    try (Cursor c = cr.query(kids, cols, null, null, null)) {
                        // the picked folder itself can't be listed (SD card out, not mounted yet): an error, not "no games",
                        // so the page keeps the games it had there instead of saving an empty shelf
                        if (c == null && dirs == 1) throw new IOException("The folder can't be reached");
                        if (c == null) continue;
                        while (c.moveToNext()) {
                            String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                            if (name == null || name.startsWith(".")) continue;
                            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                                if (depth < maxDepth && !SKIP_DIRS.contains(name.toLowerCase(Locale.ROOT)))
                                    todo.add(new String[] { id, d[1].isEmpty() ? name : d[1] + "/" + name, String.valueOf(depth + 1) });
                                continue;
                            }
                            int dot = name.lastIndexOf('.');
                            String ext = dot > 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
                            if (!exts.isEmpty() && !exts.contains(ext)) continue;
                            JSObject f = new JSObject();
                            f.put("name", name); f.put("docId", id); f.put("dir", d[1]); f.put("ext", ext);
                            f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                            f.put("size", c.isNull(3) ? 0 : c.getLong(3)); f.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
                            out.put(f);
                        }
                    }
                }
                JSObject r = new JSObject(); r.put("files", out); r.put("dirs", dirs); call.resolve(r);
            } catch (Exception e) { call.reject("Couldn't read that folder: " + e.getMessage()); }
        });
    }

    // A folder inside a picked one is addressed as ".../tree/<picked>/document/<sub folder>": Android's permission for the
    // picked folder covers everything under it, so one pick of the main ROMs folder is enough for every console in it.
    // → the folder to start from: that sub folder's id, or the picked folder itself
    private static String startId(Uri u) {
        List<String> seg = u.getPathSegments();
        if (seg.size() >= 4 && "tree".equals(seg.get(0)) && "document".equals(seg.get(2))) return seg.get(3);
        return DocumentsContract.getTreeDocumentId(u);
    }

    @PluginMethod
    public void listDirs(PluginCall call) { // the folders directly inside a picked folder (or a sub folder of it) → { dirs: [{ name, docId, uri }] }
        final String treeStr = call.getString("uri");
        if (treeStr == null) { call.reject("No folder given"); return; }
        io.execute(() -> {
            try {
                Uri tree = Uri.parse(treeStr);
                ContentResolver cr = getContext().getContentResolver();
                String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
                JSArray out = new JSArray();
                try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, startId(tree)), cols, null, null, null)) {
                    while (c != null && c.moveToNext()) {
                        String id = c.getString(0), name = c.getString(1);
                        if (name == null || name.startsWith(".") || !DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) continue;
                        JSObject d = new JSObject(); d.put("name", name); d.put("docId", id);
                        d.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                        out.put(d);
                    }
                }
                JSObject r = new JSObject(); r.put("dirs", out); call.resolve(r);
            } catch (Exception e) { call.reject("Couldn't read that folder: " + e.getMessage()); }
        });
    }

    // ---------- installed apps ----------
    @PluginMethod
    public void apps(PluginCall call) { // every app with a launcher icon: { pkg, label }
        PackageManager pm = getContext().getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> list = pm.queryIntentActivities(main, 0);
        Set<String> seen = new HashSet<>(); JSArray a = new JSArray();
        for (ResolveInfo ri : list) {
            String pkg = ri.activityInfo.packageName;
            if (!seen.add(pkg)) continue;
            JSObject o = new JSObject(); o.put("pkg", pkg); o.put("label", String.valueOf(ri.loadLabel(pm))); a.put(o);
        }
        JSObject r = new JSObject(); r.put("apps", a); call.resolve(r);
    }

    // (beta.12) the bottom screen's Apps tab: small icons for some apps, { pkgs: [..] (40 at most), size } → { icons: { pkg: data URL } }.
    // Drawn on a background thread at the size asked for (a PNG of a few KB each); an app that has gone is simply left out
    @PluginMethod
    public void appIcons(PluginCall call) {
        final JSArray pkgs = call.getArray("pkgs", new JSArray());
        final int size = Math.max(32, Math.min(192, call.getInt("size", 96)));
        if (net.isShutdown()) { call.reject("Closing"); return; }
        net.execute(() -> { // (the background-priority pool: never behind a trailer copy on previewIo)
            JSObject icons = new JSObject();
            PackageManager pm = getContext().getPackageManager();
            for (int n = 0; n < pkgs.length() && n < 40; n++) {
                String p = pkgs.optString(n, "");
                if (p.isEmpty()) continue;
                try {
                    android.graphics.drawable.Drawable d = pm.getApplicationIcon(p);
                    Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
                    android.graphics.Canvas c = new android.graphics.Canvas(b);
                    d.setBounds(0, 0, size, size); d.draw(c);
                    java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
                    b.compress(Bitmap.CompressFormat.PNG, 100, o); b.recycle();
                    icons.put(p, "data:image/png;base64," + android.util.Base64.encodeToString(o.toByteArray(), android.util.Base64.NO_WRAP));
                } catch (Exception | OutOfMemoryError ignored) {}
            }
            JSObject r = new JSObject(); r.put("icons", icons); call.resolve(r);
        });
    }

    // (beta.12) one of Android's own settings pages, from the bottom screen's Apps tab: wifi, bluetooth, display, sound
    // (anything else: the main Settings screen)
    @PluginMethod
    public void openSettingsPage(PluginCall call) {
        String page = call.getString("page", ""), a;
        switch (page == null ? "" : page) {
            case "wifi": a = android.provider.Settings.ACTION_WIFI_SETTINGS; break;
            case "bluetooth": a = android.provider.Settings.ACTION_BLUETOOTH_SETTINGS; break;
            case "display": a = android.provider.Settings.ACTION_DISPLAY_SETTINGS; break;
            case "sound": a = android.provider.Settings.ACTION_SOUND_SETTINGS; break;
            default: a = android.provider.Settings.ACTION_SETTINGS;
        }
        try { getActivity().startActivity(new Intent(a).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); }
        catch (ActivityNotFoundException e) {
            try { getActivity().startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); }
            catch (ActivityNotFoundException e2) { call.reject("Settings couldn't be opened"); }
        }
    }

    @PluginMethod
    public void activities(PluginCall call) { // an app's activities (exported only), to find its game-start screen
        String pkg = call.getString("pkg");
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(pkg, PackageManager.GET_ACTIVITIES);
            JSArray a = new JSArray();
            if (pi.activities != null) for (ActivityInfo ai : pi.activities) if (ai.exported) a.put(ai.name);
            JSObject r = new JSObject(); r.put("activities", a); r.put("version", pi.versionName); call.resolve(r);
        } catch (PackageManager.NameNotFoundException e) { call.reject("Not installed: " + pkg); }
    }

    @PluginMethod
    public void chooseApp(PluginCall call) { // a plain Android list (d-pad and touch friendly): items [{ pkg, label }] → { pkg } or { canceled }
        JSArray items = call.getArray("items", new JSArray());
        final String[] labels = new String[items.length()], pkgs = new String[items.length()];
        for (int n = 0; n < items.length(); n++) { JSONObject o = items.optJSONObject(n); labels[n] = o == null ? "?" : o.optString("label", o.optString("pkg")); pkgs[n] = o == null ? "" : o.optString("pkg"); }
        getActivity().runOnUiThread(() -> new android.app.AlertDialog.Builder(getActivity())
            .setTitle(call.getString("title", "Choose an app"))
            .setItems(labels, (dlg, which) -> { JSObject r = new JSObject(); r.put("pkg", pkgs[which]); r.put("label", labels[which]); call.resolve(r); })
            .setOnCancelListener(dlg -> { JSObject r = new JSObject(); r.put("canceled", true); call.resolve(r); })
            .show());
    }

    // ---------- launching ----------
    @PluginMethod
    public void launch(PluginCall call) {
        String pkg = call.getString("pkg"), activity = call.getString("activity"), action = call.getString("action"), category = call.getString("category"), data = call.getString("data");
        keepBottom = Boolean.TRUE.equals(call.getBoolean("keepBottom", false)); // (beta.12: a game that doesn't use the bottom screen leaves Boxshelf's up)
        if (pkg == null) { call.reject("No emulator set"); return; }
        Intent i;
        if (activity != null && !activity.isEmpty()) { i = new Intent(); i.setClassName(pkg, activity); }
        else { i = getContext().getPackageManager().getLaunchIntentForPackage(pkg); if (i == null) { call.reject("That app can't be opened"); return; } }
        if (action != null && !action.isEmpty()) i.setAction(action);
        if (category != null && !category.isEmpty()) i.addCategory(category);
        if (data != null && !data.isEmpty()) i.setData(Uri.parse(data));
        JSObject extras = call.getObject("extras", new JSObject());
        try {
            for (Iterator<String> it = extras.keys(); it.hasNext(); ) {
                String k = it.next(); Object v = extras.get(k);
                if (v instanceof Boolean) i.putExtra(k, (Boolean) v);
                else if (v instanceof Integer) i.putExtra(k, (Integer) v);
                else if (v instanceof JSONArray) { JSONArray ja = (JSONArray) v; String[] s = new String[ja.length()]; for (int n = 0; n < s.length; n++) s[n] = ja.getString(n); i.putExtra(k, s); }
                else i.putExtra(k, String.valueOf(v));
            }
        } catch (JSONException e) { call.reject("Bad launch settings: " + e.getMessage()); return; }
        // read access for every content:// the emulator is handed (data or extras), through ClipData so the intent's own
        // data stays exactly what the emulator expects
        JSArray grants = call.getArray("grant", new JSArray());
        try {
            ClipData clip = null;
            for (int n = 0; n < grants.length(); n++) {
                Uri u = Uri.parse(grants.getString(n));
                if (clip == null) clip = ClipData.newRawUri("game", u); else clip.addItem(new ClipData.Item(u));
            }
            if (clip != null) { i.setClipData(clip); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); }
        } catch (JSONException ignored) {}
        JSArray flags = call.getArray("flags", new JSArray());
        for (int n = 0; n < flags.length(); n++) {
            String f = flags.optString(n);
            if ("clearTask".equals(f)) i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK);
            if ("clearTop".equals(f)) i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        }
        // always a task of its own: Boxshelf is a singleTask Home app, so an emulator started inside its task (an explicit
        // activity without "clearTask") could be closed when Home is pressed
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        // a game (handed over as data or extras) also starts that task afresh: with NEW_TASK alone, an emulator still in the
        // background from an earlier game (Home pressed during it) is just brought back, and the new game never starts,
        // because Android doesn't compare extras. Opening an app or an emulator on its own keeps its task as it was
        boolean game = (data != null && !data.isEmpty()) || extras.length() > 0;
        if (game) i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK);
        // (beta.13) which screen: "bottom" opens it on the Thor's second display (Boxshelf's page steps aside there and the
        // shelf on top keeps running); "top" asks for the main display. Android 8+ only (setLaunchDisplayId)
        String screenWanted = call.getString("screen", "");
        boolean toBottom = "bottom".equals(screenWanted);
        android.os.Bundle opts = null;
        if (toBottom || "top".equals(screenWanted)) {
            int id = toBottom ? (bottom != null ? bottom.displayId() : -1) : android.view.Display.DEFAULT_DISPLAY;
            if (toBottom && (id < 0 || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O)) { call.reject("There's no bottom screen to open it on"); return; }
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) opts = android.app.ActivityOptions.makeBasic().setLaunchDisplayId(id).toBundle();
        }
        try {
            sideApp = toBottom; sideAt = toBottom ? android.os.SystemClock.uptimeMillis() : 0;
            launchedAt = toBottom ? 0 : android.os.SystemClock.uptimeMillis(); // (beta.12: the pause that follows is the game taking over, see stepAside)
            if (toBottom && bottom != null) bottom.stepAway();
            if (opts != null) getActivity().startActivity(i, opts); else getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) { launchedAt = 0; backFromAway(); call.reject("The emulator didn't accept the game (" + (activity != null ? activity : pkg) + ")");
        } catch (SecurityException e) { launchedAt = 0; backFromAway(); call.reject("Android blocked opening the emulator: " + e.getMessage()); }
    }

    private void backFromAway() { if (sideApp) { sideApp = false; if (bottom != null) bottom.comeBack(); } }

    // (beta.13) the top screen's "Bring Boxshelf back" while an app is open on the bottom screen
    @PluginMethod
    public void bottomBack(PluginCall call) { sideApp = false; if (bottom != null) bottom.comeBack(); call.resolve(); }

    // (beta.13) the bottom screen's Apps tab, held: Android's own "App info" page for that app
    @PluginMethod
    public void appInfo(PluginCall call) {
        String pkg = call.getString("pkg", "");
        if (pkg == null || pkg.isEmpty()) { call.reject("No app"); return; }
        try { getActivity().startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); }
        catch (ActivityNotFoundException e) { call.reject("App info couldn't be opened"); }
    }

    // (beta.13) Settings' Paste key: the text on Android's clipboard (an API key copied in a browser), or "" when there's
    // none. Android 10+ lets only the app in front read it, which Boxshelf is while its keyboard is up.
    @PluginMethod
    public void clipRead(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            String text = "";
            try {
                android.content.ClipboardManager cm = (android.content.ClipboardManager) getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                ClipData c = cm != null ? cm.getPrimaryClip() : null;
                if (c != null && c.getItemCount() > 0) { CharSequence t = c.getItemAt(0).coerceToText(getContext()); if (t != null) text = t.toString(); }
            } catch (RuntimeException ignored) {}
            if (text.length() > 4000) text = text.substring(0, 4000);
            JSObject r = new JSObject(); r.put("text", text); call.resolve(r);
        });
    }

    // ---------- the Home screen (Boxshelf as the Thor's launcher, and the way back out) ----------
    private Intent homeIntent() { return new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME); }

    @PluginMethod
    public void homeStatus(PluginCall call) { // { isDefault, current: { pkg, label }, launchers: [{ pkg, label }] }
        PackageManager pm = getContext().getPackageManager();
        String me = getContext().getPackageName();
        JSObject r = new JSObject();
        ResolveInfo def = pm.resolveActivity(homeIntent(), PackageManager.MATCH_DEFAULT_ONLY);
        // with no default chosen Android answers with its own "choose an app" screen (package "android"): no current launcher
        String cur = def != null && def.activityInfo != null && !"android".equals(def.activityInfo.packageName) ? def.activityInfo.packageName : null;
        r.put("isDefault", me.equals(cur));
        if (cur != null) { JSObject c = new JSObject(); c.put("pkg", cur); c.put("label", String.valueOf(def.loadLabel(pm))); r.put("current", c); }
        JSArray list = new JSArray(); Set<String> seen = new HashSet<>();
        for (ResolveInfo ri : pm.queryIntentActivities(homeIntent(), 0)) {
            String p = ri.activityInfo.packageName;
            if (p.equals(me) || !seen.add(p)) continue;
            JSObject o = new JSObject(); o.put("pkg", p); o.put("label", String.valueOf(ri.loadLabel(pm))); list.put(o);
        }
        r.put("launchers", list);
        call.resolve(r);
    }

    @PluginMethod
    public void openHomeSettings(PluginCall call) { // Android's own "Home app" chooser (apps may not make themselves the default)
        String[] actions = { android.provider.Settings.ACTION_HOME_SETTINGS, android.provider.Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, android.provider.Settings.ACTION_SETTINGS };
        for (String a : actions) {
            try { getActivity().startActivity(new Intent(a).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); return; }
            catch (ActivityNotFoundException ignored) {}
        }
        call.reject("This device has no Home app setting");
    }

    @PluginMethod
    public void openAndroidSettings(PluginCall call) {
        try { getActivity().startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); }
        catch (ActivityNotFoundException e) { call.reject("Settings couldn't be opened"); }
    }

    @PluginMethod
    public void launchHome(PluginCall call) { // open another launcher (Cocoon, the stock one…) by package
        String pkg = call.getString("pkg");
        Intent i = homeIntent().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        if (pkg != null) i.setPackage(pkg);
        try { getActivity().startActivity(i); call.resolve(); }
        catch (ActivityNotFoundException e) { call.reject("That launcher isn't installed any more"); }
    }

    @PluginMethod
    public void closeApp(PluginCall call) { call.resolve(); getActivity().runOnUiThread(() -> getActivity().finishAndRemoveTask()); }

    // the Home key while Boxshelf is the Home app (or a launcher shortcut) arrives here as a new intent
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent != null && intent.hasCategory(Intent.CATEGORY_HOME)) notifyListeners("home", new JSObject());
    }

    // ---------- magazines & guides (0.3.2): the Internet Archive store's downloads and the reading corner (ReadingStore) ----------
    // (beta.10) made in load() (the plugin's own thread, before any call): no lock needed, so a reading call never waits
    // behind anything else that locks the plugin
    private volatile ReadingStore readingStore;

    private ReadingStore reading() {
        ReadingStore s = readingStore;
        if (s == null) { synchronized (readingLock) { if (readingStore == null) readingStore = new ReadingStore(getContext(), userAgent(), (e, o) -> notifyListeners(e, o)); s = readingStore; } }
        return s;
    }
    private final Object readingLock = new Object(); // (only if load() couldn't make it: a short lock of its own)

    @PluginMethod
    public void readingDownload(PluginCall call) { reading().download(call); } // progress: "readingProgress" events { id, bytes, total, conns }

    @PluginMethod
    public void readingCancel(PluginCall call) { reading().cancel(call); }

    @PluginMethod
    public void readingLocal(PluginCall call) { reading().local(call); }

    @PluginMethod
    public void readingCover(PluginCall call) { reading().cover(call); }

    @PluginMethod
    public void readingZip(PluginCall call) { reading().zip(call); }

    // ---------- box art (downloaded here, never by the page: no CORS, never on the UI thread) ----------
    // The original picture is saved in a "Boxshelf Art" folder inside the games folder the player picked (so it stays with
    // the games, like the covers folder on Windows); if Android only gave read access there, in the app's own storage.
    // A display-size copy (about 512 px tall) always goes to the app's own storage: that's what the shelf shows, so a
    // 3000 px scan never has to be decoded while the cases slide.
    private static final String ART_DIR = "Boxshelf Art";
    // game manuals (0.3.0): page pictures in a "Boxshelf Manuals" folder beside the games (read: also the PC's "covers" and
    // "manuals" folders copied over with the games)
    private static final String MANUAL_DIR = "Boxshelf Manuals";
    private static String folderFor(String f) { return "covers".equals(f) ? "covers" : "manuals".equals(f) ? MANUAL_DIR : "pcmanuals".equals(f) ? "manuals" : ART_DIR; }
    private static final Pattern PNG_HREF = Pattern.compile("href=\"([^\"]+?\\.png)\"", Pattern.CASE_INSENSITIVE);
    // fetchArt's "is a newer picture there?" check and its write, and saveArt's write, one at a time: a picture picked in
    // Art Studio while a background download finishes is never written over by it (always taken before artDirLock)
    private final Object artFileLock = new Object();
    private final Object artDirLock = new Object(); // two downloads must not both create "Boxshelf Art" (Android would make "Boxshelf Art (1)")
    private final java.util.Map<String, String> artDirs = new java.util.HashMap<>(); // tree|sub → folder id (only touched under artDirLock)
    private String ua = null;

    private String userAgent() { // one descriptive User-Agent, as the Windows build sends (GameTDB and the others like to know who's calling)
        if (ua != null) return ua;
        String v = "0";
        try { v = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName; } catch (Exception ignored) {}
        ua = "Boxshelf/" + v + " (Android)";
        return ua;
    }

    private static final class Got { int status; byte[] body; String type; }

    // GET with timeouts, following redirects by hand (HttpURLConnection won't follow http <-> https on its own)
    private Got httpGet(String url, JSObject headers, int maxBytes) throws IOException {
        String u = url;
        final String host0 = new URL(url).getHost();
        for (int hop = 0; hop < 6; hop++) {
            // (beta.10) the caller's headers (a SteamGridDB key, say) go only to the host they were meant for, and an
            // https request never follows a redirect down to plain http
            if (hop > 0) { URL nu = new URL(u); if (!nu.getHost().equalsIgnoreCase(host0)) headers = null; if ("http".equals(nu.getProtocol()) && url.startsWith("https:")) throw new IOException("Refused a redirect from https to http"); }
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            boolean reuse = false; // answered and read to the end: the connection stays open for the next request (keep-alive)
            try {
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", userAgent());
                if (headers != null) for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, headers.optString(k)); }
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && code != 304) {
                    String loc = c.getHeaderField("Location");
                    reuse = drain(c);
                    if (loc == null) { Got g = new Got(); g.status = code; return g; }
                    u = new URL(new URL(u), loc).toString();
                    continue;
                }
                Got g = new Got(); g.status = code; g.type = c.getContentType();
                if (code >= 200 && code < 300) {
                    if (c.getContentLengthLong() > maxBytes) throw new TooBig(); // (beta.10) said up front: not downloaded at all (API 24)
                    try (InputStream in = new BufferedInputStream(c.getInputStream())) { g.body = readAll(in, maxBytes); }
                    reuse = true;
                } else reuse = drain(c); // a 404 (GameTDB's region guesses, mostly) is read out too, so it doesn't cost a new connection
                return g;
            } finally { if (!reuse) c.disconnect(); } // (a failed or half-read answer: its connection is closed, never reused)
        }
        throw new IOException("Too many redirects");
    }

    // the rest of a small answer (an error page, a redirect) read and closed → true when it was read to the end, so its
    // connection goes back to the pool and the next request to that server skips a new TLS handshake. A big one is dropped
    private static boolean drain(HttpURLConnection c) {
        InputStream in;
        try { in = c.getErrorStream(); if (in == null) in = c.getInputStream(); } catch (Exception e) { return false; }
        if (in == null) return true; // no body at all
        try {
            byte[] buf = new byte[8192]; int total = 0, n;
            while ((n = in.read(buf)) > 0) { total += n; if (total > 256 * 1024) return false; }
            return true;
        } catch (IOException e) { return false; }
        finally { try { in.close(); } catch (IOException ignored) {} }
    }

    // (beta.10) a file over the size limit: not "busy" (tried again every start, the whole 80 MB each time) but there and
    // too big, which the callers answer as missing (toobig)
    static final class TooBig extends IOException { TooBig() { super("File too large"); } }

    private static byte[] readAll(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384]; int n;
        while ((n = in.read(buf)) > 0) { bo.write(buf, 0, n); if (bo.size() > maxBytes) throw new TooBig(); }
        return bo.toByteArray();
    }

    private static String safeName(String s) {
        String t = String.valueOf(s).replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (t.length() > 150) t = t.substring(0, 150);
        return t.isEmpty() ? "_" : t;
    }

    @PluginMethod
    public void artIndex(PluginCall call) { // a libretro thumbnails folder page → { status, names: [file names without .png] }
        final String url = call.getString("url");
        if (url == null) { call.reject("No address"); return; }
        net.execute(() -> {
            try {
                Got g = httpGet(url, null, 32 * 1024 * 1024);
                JSArray names = new JSArray();
                if (g.body != null) {
                    Matcher m = PNG_HREF.matcher(new String(g.body, StandardCharsets.UTF_8));
                    while (m.find()) {
                        try { String h = m.group(1).replace("&amp;", "&").replace("&#39;", "'").replace("&#039;", "'").replace("&apos;", "'").replace("&quot;", "\"");
                            String n = URLDecoder.decode(h.replace("+", "%2B"), "UTF-8"); names.put(n.substring(0, n.length() - 4)); }
                        catch (Exception ignored) {} // one odd link: skip it
                    }
                }
                JSObject r = new JSObject(); r.put("status", g.status); r.put("names", names); call.resolve(r);
            } catch (Exception e) { call.reject("Offline or blocked: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void httpText(PluginCall call) { // a small text / JSON answer (SteamGridDB's search, ScreenScraper's lookups with ss) → { status, text }
        final String url = call.getString("url");
        final JSObject headers = call.getObject("headers", new JSObject());
        final boolean ss = call.getBoolean("ss", false), igdb = call.getBoolean("igdb", false), ra = call.getBoolean("ra", false);
        final String body = call.getString("body", null); // (0.3.1) a POST (IGDB's queries)
        // (beta.12) contentType: the POST body's type (text/plain unless the page says otherwise). romm: a call to the saved
        // RomM server, its sign-in added here from the saved settings (only for that server's addresses; auth false: none),
        // and an error answer's body handed back too (RomM's pairing says "pending" / "slow_down" in a 400's body)
        final String ctype = call.getString("contentType", "text/plain");
        final boolean romm = call.getBoolean("romm", false), rommAuth = call.getBoolean("auth", true);
        if (url == null) { call.reject("No address"); return; }
        net.execute(() -> {
            try {
                Got g;
                if (romm) {
                    JSObject h = new JSObject();
                    for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); if (!"authorization".equalsIgnoreCase(k)) h.put(k, headers.optString(k)); }
                    String tok = rommAuth ? rommToken(url) : null;
                    if (tok != null) h.put("Authorization", "Bearer " + tok);
                    g = body != null ? httpPost(url, h, body, ctype == null ? "text/plain" : ctype, 4 * 1024 * 1024, true) : httpGet(url, h, 32 * 1024 * 1024);
                } else if (ra) { // (0.3.5) RetroAchievements: the username + web API key are added here, from the saved settings
                    String signed = raSign(url);
                    if (signed == null) { JSObject r = new JSObject(); r.put("status", 401); r.put("text", ""); call.resolve(r); return; }
                    g = httpGet(signed, headers, 8 * 1024 * 1024);
                } else if (igdb) { // IGDB: the Twitch sign-in is added here, from the saved settings (the page never sees the secret)
                    String[] k = igdbKeys();
                    if (k == null) { JSObject r = new JSObject(); r.put("status", 401); r.put("text", ""); call.resolve(r); return; }
                    g = null;
                    for (int attempt = 0; attempt < 2; attempt++) {
                        String tok = igdbToken(k, attempt > 0);
                        if (tok == null) { JSObject r = new JSObject(); r.put("status", 401); r.put("text", ""); call.resolve(r); return; }
                        JSObject h = new JSObject(); h.put("Client-ID", k[0]); h.put("Authorization", "Bearer " + tok); h.put("Accept", "application/json");
                        g = httpPost(url, h, body == null ? "" : body, "text/plain", 4 * 1024 * 1024);
                        if (g.status != 401) break; // a refused token (revoked, expired early): a fresh one, once
                    }
                } else if (body != null) g = httpPost(url, headers, body, ctype == null ? "text/plain" : ctype, 4 * 1024 * 1024);
                else g = httpGet(ss ? ssSign(url) : url, headers, 4 * 1024 * 1024);
                JSObject r = new JSObject(); r.put("status", g.status); r.put("text", g.body == null ? "" : new String(g.body, StandardCharsets.UTF_8)); call.resolve(r);
            } catch (Exception e) { call.reject(ss || igdb || ra ? "Offline or blocked" : "Offline or blocked: " + e.getMessage()); } // (an error can echo the address; RomM's never carry the sign-in)
        });
    }

    // (0.3.5) a RetroAchievements Web API address with the saved account added (z = username, y = web API key), or null
    // when it isn't set up (the page honours "Show achievements" itself, so Test still works with it off). Only ever for
    // retroachievements.org's API: the key goes nowhere else, and the page never builds, logs or keeps an address with it
    private String raSign(String url) {
        if (url == null || !url.startsWith("https://retroachievements.org/API/")) return null;
        try {
            File f = fileFor("config.json");
            if (!f.isFile()) return null;
            String text;
            try (InputStream in = new FileInputStream(f)) { text = new String(readAll(in, 4 * 1024 * 1024), StandardCharsets.UTF_8); }
            JSONObject ra = new JSONObject(text).optJSONObject("ra");
            if (ra == null) return null;
            String user = ra.optString("user", "").trim(), key = ra.optString("key", "").trim();
            if (user.isEmpty() || key.isEmpty()) return null;
            return url + (url.indexOf('?') >= 0 ? "&" : "?") + "z=" + java.net.URLEncoder.encode(user, "UTF-8") + "&y=" + java.net.URLEncoder.encode(key, "UTF-8");
        } catch (Exception e) { return null; }
    }

    // (0.3.5) RetroAchievements' own hash of a few games (RaHash.java: cartridge consoles, arcade names), read on a
    // low-priority thread of its own so a folder scan or a download never waits on it, and the file never crosses the
    // bridge. { items: [{ uri, kind, name, exts }] } → { hashes: [32 hex characters, or "" when it couldn't be made] }
    private final ExecutorService hashPool = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<Runnable>(), r -> {
        Thread t = new Thread(() -> { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); r.run(); }, "boxshelf-rahash");
        t.setDaemon(true);
        return t;
    }, DROP);

    @PluginMethod
    public void raHash(PluginCall call) {
        final JSArray items = call.getArray("items", new JSArray());
        hashPool.execute(() -> {
            JSArray out = new JSArray();
            try {
                ContentResolver cr = getContext().getContentResolver();
                int count = items == null ? 0 : items.length();
                for (int i = 0; i < count; i++) {
                    stepAside(); // (beta.12) never hashing while a game runs
                    String h = null;
                    try {
                        JSONObject it = items.getJSONObject(i);
                        h = RaHash.of(cr, it.optString("uri", ""), it.optString("kind", ""), it.optString("name", ""), it.optJSONArray("exts"));
                    } catch (Exception | OutOfMemoryError e) { h = null; } // unreadable, gone, not that kind of file: no hash (titles still match)
                    out.put(h == null ? "" : h);
                }
            } catch (Throwable t) { /* answer with what was made */ }
            JSObject r = new JSObject(); r.put("hashes", out); call.resolve(r);
        });
    }

    // a POST with a small body (no redirects: the APIs that take one answer directly)
    private Got httpPost(String url, JSObject headers, String body, String type, int maxBytes) throws IOException { return httpPost(url, headers, body, type, maxBytes, false); }

    // errBody (beta.12, RomM): an error answer's body is read too (up to 256 KB), not just its status
    private Got httpPost(String url, JSObject headers, String body, String type, int maxBytes, boolean errBody) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(15000); c.setReadTimeout(30000);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("User-Agent", userAgent()); c.setRequestProperty("Content-Type", type);
            if (headers != null) for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, headers.optString(k)); }
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(b.length);
            try (OutputStream out = c.getOutputStream()) { out.write(b); }
            Got g = new Got(); g.status = c.getResponseCode(); g.type = c.getContentType();
            if (g.status >= 200 && g.status < 300) { try (InputStream in = new BufferedInputStream(c.getInputStream())) { g.body = readAll(in, maxBytes); } }
            else if (errBody) {
                InputStream es = c.getErrorStream();
                if (es != null) { try (InputStream in = new BufferedInputStream(es)) { g.body = readAll(in, 256 * 1024); } catch (IOException ignored) { g.body = null; } }
            }
            else drain(c);
            return g;
        } finally { c.disconnect(); }
    }

    // IGDB (0.3.1): { client id, secret } from the saved settings (Settings → Accounts & services), or null when not set up
    private String[] igdbKeys() {
        try {
            File f = fileFor("config.json");
            if (!f.isFile()) return null;
            String text;
            try (InputStream in = new FileInputStream(f)) { text = new String(readAll(in, 4 * 1024 * 1024), StandardCharsets.UTF_8); }
            JSONObject keys = new JSONObject(text).optJSONObject("keys");
            if (keys == null) return null;
            String id = keys.optString("igdbId", "").trim(), secret = keys.optString("igdbSecret", "").trim();
            return id.isEmpty() || secret.isEmpty() ? null : new String[] { id, secret };
        } catch (Exception e) { return null; }
    }

    private String igdbTok = null, igdbTokFor = null; private long igdbTokUntil = 0;
    // (beta.10) the token's own lock: it's held across the sign-in request, which must never block the plugin's thread
    // (reading(), lbIndex and the rest lock the plugin itself; a slow Twitch answer used to hold them all up)
    private final Object tokenLock = new Object();
    // a Twitch app token for IGDB (client credentials; it lasts about two months), kept in memory for this run
    private String igdbToken(String[] k, boolean fresh) {
        synchronized (tokenLock) {
            if (!fresh && igdbTok != null && k[0].equals(igdbTokFor) && System.currentTimeMillis() < igdbTokUntil) return igdbTok;
            try {
                String form = "client_id=" + java.net.URLEncoder.encode(k[0], "UTF-8") + "&client_secret=" + java.net.URLEncoder.encode(k[1], "UTF-8") + "&grant_type=client_credentials";
                Got g = httpPost("https://id.twitch.tv/oauth2/token", null, form, "application/x-www-form-urlencoded", 64 * 1024);
                if (g.status != 200 || g.body == null) { igdbTok = null; return null; }
                JSONObject j = new JSONObject(new String(g.body, StandardCharsets.UTF_8));
                igdbTok = j.optString("access_token", null); igdbTokFor = k[0];
                igdbTokUntil = System.currentTimeMillis() + Math.max(60, j.optLong("expires_in", 3600) - 300) * 1000L;
                return igdbTok;
            } catch (Exception e) { return null; }
        }
    }

    // ScreenScraper's sign-in, added to one of its addresses at the moment of the request, from the saved settings: the page
    // never builds, logs or keeps an address with the password in it (or passes one through the bridge, which logs calls in
    // debug builds). Not a ScreenScraper https address: left as it is
    // (beta.10) Boxshelf's own ScreenScraper developer login, when this build has one: assets/ss-dev.json { "devId", "devPass" }
    // (outside the web page's folder, so the page can't read it; never in git, the .gitignore lists it). Read once; null: none
    private String[] ssOwn = null; private boolean ssOwnRead = false;
    private synchronized String[] readSsOwnDev() {
        if (ssOwnRead) return ssOwn; ssOwnRead = true;
        try (InputStream in = getContext().getAssets().open("ss-dev.json")) {
            JSONObject j = new JSONObject(new String(readAll(in, 64 * 1024), StandardCharsets.UTF_8));
            String id = j.optString("devId", "").trim(), pw = j.optString("devPass", "");
            if (!id.isEmpty() && !pw.isEmpty()) ssOwn = new String[] { id, pw };
        } catch (Exception e) { ssOwn = null; }
        return ssOwn;
    }
    // whether this build has its own developer login (yes / no only, never the values), for Settings' wording
    @PluginMethod
    public void ssOwnDev(PluginCall call) { JSObject r = new JSObject(); r.put("has", readSsOwnDev() != null); call.resolve(r); }

    private String ssSign(String url) {
        try {
            URL u = new URL(url);
            String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
            if (!"https".equals(u.getProtocol()) || !(host.equals("screenscraper.fr") || host.endsWith(".screenscraper.fr"))) return url;
            File f = fileFor("config.json");
            if (!f.isFile()) return url;
            String text;
            try (InputStream in = new FileInputStream(f)) { text = new String(readAll(in, 4 * 1024 * 1024), StandardCharsets.UTF_8); }
            JSONObject keys = new JSONObject(text).optJSONObject("keys");
            if (keys == null) return url;
            String user = keys.optString("ssUser", "").trim(), pass = keys.optString("ssPass", ""), devId = keys.optString("ssDevId", "").trim(), devPass = keys.optString("ssDevPass", "");
            if (devId.isEmpty()) { String[] own = readSsOwnDev(); if (own != null) { devId = own[0]; devPass = own[1]; } } // (beta.10) Boxshelf's own, when this build has one
            StringBuilder b = new StringBuilder(url);
            char sep = url.indexOf('?') >= 0 ? '&' : '?';
            String[][] add = { { "softname", "Boxshelf" }, { "ssid", user }, { "sspassword", pass }, { "devid", devId }, { "devpassword", devId.isEmpty() ? "" : devPass } };
            for (String[] kv : add) {
                if (kv[1].isEmpty()) continue;
                b.append(sep).append(kv[0]).append('=').append(java.net.URLEncoder.encode(kv[1], "UTF-8"));
                sep = '&';
            }
            return b.toString();
        } catch (Exception e) { return url; }
    }

    @PluginMethod
    public void discId(PluginCall call) { // GameCube / Wii disc id from the image header (GameTDB names its art by it) → { id } or {}
        final String uri = call.getString("uri");
        if (uri == null) { call.reject("No file"); return; }
        net.execute(() -> {
            JSObject r = new JSObject();
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                byte[] h = new byte[0x8010]; int off = 0, n;
                while (in != null && off < h.length && (n = in.read(h, off, h.length - off)) > 0) off += n;
                String magic = latin1(h, off, 0, 4);
                // plain images keep the id at 0; RVZ / WIA keep a copy of the header at 0x58, CISO the disc from 0x8000, WBFS from 0x200
                int at = ("RVZ\u0001".equals(magic) || "WIA\u0001".equals(magic)) ? 0x58 : "CISO".equals(magic) ? 0x8000 : "WBFS".equals(magic) ? 0x200 : 0;
                String id = latin1(h, off, at, 6);
                if (id.matches("[A-Z][A-Z0-9]{5}")) r.put("id", id);
            } catch (Exception ignored) {} // unreadable or compressed (GCZ): no id, the other sources still try
            call.resolve(r);
        });
    }

    private static String latin1(byte[] b, int len, int at, int n) { return at + n <= len ? new String(b, at, n, StandardCharsets.ISO_8859_1) : ""; }

    // the child of parentId called name (a folder when dir), or null
    private String findChild(ContentResolver cr, Uri tree, String parentId, String name, boolean dir) {
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
        try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId), cols, null, null, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                String n = c.getString(1);
                if (n != null && n.equalsIgnoreCase(name) && dir == DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) return c.getString(0);
            }
        } catch (Exception ignored) {}
        return null;
    }

    // "Boxshelf Art" (and its sub folder, when one is asked for) in the picked games folder; created when make is true
    private String artDirId(ContentResolver cr, Uri tree, String sub, boolean make) throws IOException { return artDirId(cr, tree, ART_DIR, sub, make); }

    // folder: "Boxshelf Art", or (read only) the Windows build's "covers" folder beside the games
    private String artDirId(ContentResolver cr, Uri tree, String folder, String sub, boolean make) throws IOException {
        synchronized (artDirLock) {
            String cacheKey = tree + "|" + (sub == null ? "" : sub) + (ART_DIR.equals(folder) ? "" : "|" + folder), known = artDirs.get(cacheKey);
            if (known != null) return known;
            String id = startId(tree); // "Boxshelf Art" goes inside the console's own folder, also when that's a sub folder of the pick
            String[] path = (sub == null || sub.isEmpty()) ? new String[] { folder } : new String[] { folder, safeName(sub) };
            for (String part : path) {
                String kid = findChild(cr, tree, id, part, true);
                if (kid == null) {
                    if (!make) return null;
                    Uri made = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, id), DocumentsContract.Document.MIME_TYPE_DIR, part);
                    if (made == null) throw new IOException("Couldn't make the " + part + " folder");
                    kid = DocumentsContract.getDocumentId(made);
                }
                id = kid;
            }
            artDirs.put(cacheKey, id);
            return id;
        }
    }
    private void forgetArtDir(Uri tree, String sub) { forgetArtDir(tree, ART_DIR, sub); }
    private void forgetArtDir(Uri tree, String folder, String sub) { synchronized (artDirLock) { artDirs.remove(tree + "|" + (sub == null ? "" : sub) + (ART_DIR.equals(folder) ? "" : "|" + folder)); } }

    @PluginMethod
    public void artList(PluginCall call) { // the pictures already in a games folder's "Boxshelf Art" → { exists, files: [{ name, uri }] }
        // (folder: "covers" lists the Windows build's art folder instead, so art scraped on the PC and copied over is used)
        final String treeStr = call.getString("tree"), sub = call.getString("sub", ""), folder = folderFor(call.getString("folder", ""));
        if (treeStr == null || treeStr.isEmpty()) { call.reject("No folder given"); return; }
        io.execute(() -> {
            JSObject r = new JSObject(); JSArray files = new JSArray();
            try {
                Uri tree = Uri.parse(treeStr); ContentResolver cr = getContext().getContentResolver();
                String dir = artDirId(cr, tree, folder, sub, false);
                r.put("exists", dir != null);
                if (dir != null) {
                    String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
                    try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, dir), cols, null, null, null)) {
                        while (c != null && c.moveToNext()) {
                            String n = c.getString(1);
                            if (n == null || DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) continue;
                            JSObject f = new JSObject(); f.put("name", n); f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0)).toString()); files.put(f);
                        }
                    }
                }
            } catch (Exception e) { r.put("exists", false); r.put("error", String.valueOf(e.getMessage())); }
            r.put("files", files); call.resolve(r);
        });
    }

    // a picture's bytes decoded at a fraction of their size (inSampleSize): about maxH tall (and minW wide), or a bit more
    private static Bitmap decodeAbout(byte[] body, int maxH, int minW) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options(); o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(body, 0, body.length, o);
        if (o.outWidth <= 0 || o.outHeight <= 0) throw new IOException("Not a picture");
        int sample = 1; while (o.outHeight / (sample * 2) >= maxH && o.outWidth / (sample * 2) >= minW) sample *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options(); d.inSampleSize = sample;
        Bitmap bmp = BitmapFactory.decodeByteArray(body, 0, body.length, d);
        if (bmp == null) throw new IOException("Not a picture");
        return bmp;
    }

    // the same, but no side over maxSide (a huge scan or a camera photo is halved until it fits: memory stays small)
    private static Bitmap decodeAtMost(byte[] body, int maxSide) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options(); o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(body, 0, body.length, o);
        if (o.outWidth <= 0 || o.outHeight <= 0) throw new IOException("Not a picture");
        int sample = 1; while (o.outHeight / sample > maxSide || o.outWidth / sample > maxSide) sample *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options(); d.inSampleSize = sample;
        Bitmap bmp = BitmapFactory.decodeByteArray(body, 0, body.length, d);
        if (bmp == null) throw new IOException("Not a picture");
        return bmp;
    }

    // the display copy: about maxH tall, JPEG (PNG when it has see-through parts, like a disc) in files/art/<key>/ → its
    // absolute path
    private String writeDisplay(byte[] body, String key, String name, int maxH) throws IOException {
        decodeGate.acquireUninterruptibly();
        try { return writeBitmap(decodeAbout(body, maxH, 64), new File(getContext().getFilesDir(), "art/" + safeName(key)), name, maxH); }
        finally { decodeGate.release(); }
    }

    // bmp scaled to maxH tall and saved in dir as <name>.jpg / .png → its absolute path. bmp is always recycled
    private static String writeBitmap(Bitmap bmp, File dir, String name, int maxH) throws IOException {
        try {
            if (bmp.getHeight() > maxH) {
                int w = Math.max(1, Math.round(bmp.getWidth() * (float) maxH / bmp.getHeight()));
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, w, maxH, true);
                if (scaled != bmp) { bmp.recycle(); bmp = scaled; }
            }
            boolean alpha = bmp.hasAlpha() && seeThrough(bmp);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Couldn't make " + dir);
            File out = new File(dir, safeName(name) + (alpha ? ".png" : ".jpg")), tmp = new File(out.getPath() + ".tmp");
            try (FileOutputStream fo = new FileOutputStream(tmp)) {
                if (!bmp.compress(alpha ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, 85, fo)) throw new IOException("Couldn't encode the picture");
            }
            // the other format from an earlier fetch of the same picture would just be left over
            File other = new File(dir, safeName(name) + (alpha ? ".jpg" : ".png")); if (other.exists()) other.delete();
            if (!tmp.renameTo(out)) { out.delete(); if (!tmp.renameTo(out)) throw new IOException("Couldn't save " + out.getName()); }
            return out.getAbsolutePath();
        } finally { bmp.recycle(); }
    }

    // ---------- full box wraps (back | spine | front, as GameTDB's "coverfull" and ScreenScraper's "box-texture") ----------
    // Where the faces are: the front is as wide as the case's shape says (height × ratio, the console's STYLE.ratio) and the
    // spine is what's left between the two faces. A scan with margins or bleed can make that guess silly; then the console's
    // case depth decides (STYLE.depth: spine width ÷ face width). → { faceWidth, spineWidth }, or null: not a wrap at all
    static int[] wrapCuts(int w, int h, double ratio, double depth) {
        if (w <= 0 || h <= 0) return null;
        double r = ratio > 0.3 && ratio < 2 ? ratio : 0.71;
        if (w < h * Math.min(r, 0.95) * 1.7) return null; // narrower than two faces side by side: a single picture, not a wrap
        int face = (int) Math.round(h * r), spine = w - 2 * face;
        if (spine < Math.max(2, face * 0.03) || spine > face * 0.4) {
            double d = depth > 0.01 && depth < 0.5 ? depth : 0.1;
            face = (int) Math.round(w / (2 + d)); spine = w - 2 * face;
        }
        if (spine < 1 || face < 8) return null;
        return new int[] { face, spine };
    }

    // one face of a wrap ("back" | "spine" | "front") as a new bitmap; src is left as it is
    static Bitmap cutFace(Bitmap src, String part, double ratio, double depth) throws IOException {
        int W = src.getWidth(), H = src.getHeight();
        int[] c = wrapCuts(W, H, ratio, depth);
        if (c == null) throw new IOException("Not a full box wrap");
        int x = "back".equals(part) ? 0 : "spine".equals(part) ? c[0] : c[0] + c[1];
        int w = "spine".equals(part) ? c[1] : Math.min(c[0], W - x);
        if (x < 0 || w < 1 || x + w > W) throw new IOException("Not a full box wrap");
        Bitmap face = Bitmap.createBitmap(src, x, 0, w, H);
        if (face == null || face == src) throw new IOException("Couldn't cut the wrap"); // (never the whole picture: x / w say so)
        return face;
    }

    // a wrap → display copies of the faces asked for (want: front / back / spine; none given = all three), named dname,
    // dname-back and dname-spine → { front, back, spine } (absolute paths)
    private JSObject writeParts(byte[] body, String key, String dname, int maxH, double ratio, double depth, JSArray want) throws IOException {
        decodeGate.acquireUninterruptibly();
        try { return cutParts(body, key, dname, maxH, ratio, depth, want); }
        finally { decodeGate.release(); }
    }
    private JSObject cutParts(byte[] body, String key, String dname, int maxH, double ratio, double depth, JSArray want) throws IOException {
        Bitmap src = decodeAbout(body, maxH, 64);
        try {
            if (wrapCuts(src.getWidth(), src.getHeight(), ratio, depth) == null) throw new IOException("Not a full box wrap");
            File dir = new File(getContext().getFilesDir(), "art/" + safeName(key));
            JSObject out = new JSObject();
            for (String p : new String[] { "front", "back", "spine" }) {
                if (!wanted(want, p)) continue;
                out.put(p, writeBitmap(cutFace(src, p, ratio, depth), dir, "front".equals(p) ? dname : dname + "-" + p, maxH));
            }
            return out;
        } finally { src.recycle(); }
    }

    private static boolean wanted(JSArray want, String p) {
        if (want == null || want.length() == 0) return true;
        for (int i = 0; i < want.length(); i++) if (p.equals(want.optString(i, ""))) return true;
        return false;
    }

    // see-through anywhere along the edges or corners (a disc, a cut-out box)? Many scans carry an alpha channel they never use
    private static boolean seeThrough(Bitmap b) {
        int w = b.getWidth(), h = b.getHeight();
        int[][] at = { {0, 0}, {w - 1, 0}, {0, h - 1}, {w - 1, h - 1}, {w / 2, 0}, {w / 2, h - 1}, {0, h / 2}, {w - 1, h / 2}, {w / 8, h / 8}, {w - 1 - w / 8, h - 1 - h / 8} };
        for (int[] p : at) if (((b.getPixel(p[0], p[1]) >>> 24) & 0xff) < 250) return true;
        return false;
    }

    private static String extFor(String type, String url) {
        String t = type == null ? "" : type.toLowerCase(Locale.ROOT);
        if (t.contains("png")) return "png";
        if (t.contains("jpeg") || t.contains("jpg")) return "jpg";
        if (t.contains("webp")) return "webp";
        String u = url.toLowerCase(Locale.ROOT).replaceAll("[?#].*$", "");
        if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "jpg";
        if (u.endsWith(".webp")) return "webp";
        return "png";
    }

    // the original into "Boxshelf Art" in the games folder → its content:// address, or null when that folder can't be
    // written (read-only permission, a removed SD card…)
    private String saveToTree(String treeStr, String sub, String file, String ext, byte[] body) { return saveToTree(treeStr, ART_DIR, sub, file, ext, body); }

    // the same into another of Boxshelf's folders beside the games ("Boxshelf Manuals")
    private String saveToTree(String treeStr, String folder, String sub, String file, String ext, byte[] body) {
        if (treeStr == null || treeStr.isEmpty()) return null;
        Uri doc = null; ContentResolver cr = getContext().getContentResolver();
        boolean made = false; Uri tree = null; String dir = null;
        try {
            tree = Uri.parse(treeStr);
            String mime = "jpg".equals(ext) ? "image/jpeg" : "image/" + ext;
            for (int attempt = 0; attempt < 2 && doc == null; attempt++) {
                dir = artDirId(cr, tree, folder, sub, true);
                String have = findChild(cr, tree, dir, file, false);
                if (have != null) { doc = DocumentsContract.buildDocumentUriUsingTree(tree, have); break; }
                try { doc = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, dir), mime, file); }
                catch (Exception e) { doc = null; }
                if (doc == null) forgetArtDir(tree, folder, sub); // the folder may have been deleted since it was found: look again
                else made = true;
            }
            if (doc == null) return null;
            try (OutputStream out = cr.openOutputStream(doc, "wt")) { // "wt": an old, longer picture must not leave its tail behind
                if (out == null) throw new IOException("No output");
                out.write(body);
            }
            noteArt(treeStr, dir, file, System.currentTimeMillis()); // (beta.12) newerPicture's listing sees it at once
            return doc.toString();
        } catch (Exception e) {
            if (doc != null && made) try { DocumentsContract.deleteDocument(cr, doc); } catch (Exception ignored) {} // no half-written picture left behind
            if (tree != null) forgetArtDir(tree, folder, sub);
            return null;
        }
    }

    @PluginMethod
    public void fetchFile(PluginCall call) {
        // a manual page saved as it comes (no display copy): { tree, sub, folder: "manuals", name (no extension), url, key }
        // → { ok, name, file } / { ok: false, missing } (not there) / { ok: false, busy } (offline, or the server said slow down).
        // No tree (art kept inside Boxshelf), or a folder Android only lets us read: the app's own storage instead.
        final String treeStr = call.getString("tree", ""), sub = call.getString("sub", ""), url = call.getString("url", ""), name = safeName(call.getString("name", "file")), key = call.getString("key", "file");
        final String folder = "manuals".equals(call.getString("folder", "")) ? MANUAL_DIR : ART_DIR;
        // pdf (0.3.1): a whole PDF manual, kept in the app's cache only (the page turns it into pictures, saved with saveBytes)
        final boolean pdf = call.getBoolean("pdf", false);
        if (url.isEmpty()) { call.reject("No address given"); return; }
        net.execute(() -> {
            JSObject r = new JSObject();
            Got g;
            try { g = httpGet(url, null, (pdf ? 80 : 40) * 1024 * 1024); }
            catch (TooBig e) { r.put("ok", false); r.put("missing", true); r.put("toobig", true); call.resolve(r); return; } // (beta.10) never fetched again for nothing
            catch (Throwable e) { r.put("ok", false); r.put("busy", true); call.resolve(r); return; }
            try {
                if (g.status == 404 || g.status == 410) { r.put("ok", false); r.put("missing", true); call.resolve(r); return; }
                if (g.body == null) { r.put("ok", false); r.put("busy", true); r.put("status", g.status); call.resolve(r); return; } // 5xx / 429 / 403: try later
                if (g.body.length < 2048) { r.put("ok", false); r.put("missing", true); call.resolve(r); return; } // an error page, not a page of the manual
                if (pdf) {
                    if (g.body[0] != '%' || g.body[1] != 'P' || g.body[2] != 'D' || g.body[3] != 'F') { r.put("ok", false); r.put("missing", true); call.resolve(r); return; } // not a PDF after all
                    File dir = new File(getContext().getCacheDir(), "manpdf");
                    if (!dir.isDirectory()) dir.mkdirs();
                    // (beta.10) the page drops each PDF once its pages are saved (dropPdf); any left over from a run cut short go here
                    File[] old = dir.listFiles(); long stale = System.currentTimeMillis() - 3600_000L;
                    if (old != null) for (File x : old) if (x.isFile() && x.lastModified() < stale) x.delete();
                    File f = new File(dir, safeName(key) + "-" + name + ".pdf");
                    try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(g.body); }
                    r.put("ok", true); r.put("name", f.getName()); r.put("file", f.getAbsolutePath()); call.resolve(r); return;
                }
                String ext = extFor(g.type, url), file = name + "." + ext;
                String saved = saveToTree(treeStr, folder, sub, file, ext, g.body);
                if (saved == null) {
                    File dir = new File(getContext().getFilesDir(), "manuals/" + safeName(key));
                    if (!dir.isDirectory()) dir.mkdirs();
                    File f = new File(dir, file);
                    try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(g.body); }
                    saved = f.getAbsolutePath();
                }
                r.put("ok", true); r.put("name", file); r.put("file", saved); call.resolve(r);
            } catch (Throwable e) { JSObject x = new JSObject(); x.put("ok", false); x.put("busy", true); call.resolve(x); }
        });
    }

    @PluginMethod
    public void dropPdf(PluginCall call) { // (beta.10) a PDF manual's download once its pages are saved { path } → { removed }. Only the cache's manpdf folder
        String p = call.getString("path", "");
        boolean ok = false;
        try {
            File dir = new File(getContext().getCacheDir(), "manpdf"), f = new File(p == null ? "" : p);
            if (f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator) && f.isFile()) ok = f.delete();
        } catch (Exception ignored) {}
        JSObject r = new JSObject(); r.put("removed", ok); call.resolve(r);
    }

    // (beta.9) a game's video preview, found beside the games (a "videos" folder): copied once into the app's cache so the
    // page can play it (the page can't open the games folder's documents itself). { uri, name, size } → { ok, path }.
    // Kept under 300 MB, the oldest dropped first; a copy that's already there (same size) is used as it is.
    private static final long PREVIEW_CAP = 300L << 20;
    // (beta.10) previews copy on a thread of their own (a 300 MB video used to hold up folder scans, art lists and manual
    // pages on io), and only the newest ask counts: one for another video (you moved on) stops an older copy part way
    private final ExecutorService previewIo = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<Runnable>(), r -> {
        Thread t = new Thread(() -> { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); r.run(); }, "boxshelf-preview");
        t.setDaemon(true);
        return t;
    }, DROP);
    private volatile String previewWant = "";
    @PluginMethod
    public void copyPreview(PluginCall call) {
        final String uriStr = call.getString("uri", ""), name = safeName(call.getString("name", "preview"));
        final long size = call.getLong("size", 0L);
        if (uriStr.isEmpty()) { call.reject("No video"); return; }
        previewWant = name;
        previewIo.execute(() -> {
            File part = null;
            try {
                if (!name.equals(previewWant)) { JSObject x = new JSObject(); x.put("ok", false); x.put("superseded", true); call.resolve(x); return; } // a newer one was asked for
                File dir = new File(getContext().getCacheDir(), "previews");
                if (!dir.isDirectory()) dir.mkdirs();
                File f = new File(dir, name);
                if (f.isFile() && (size <= 0 || f.length() == size)) { f.setLastModified(System.currentTimeMillis()); JSObject r = new JSObject(); r.put("ok", true); r.put("path", f.getAbsolutePath()); call.resolve(r); return; }
                part = new File(dir, name + ".part");
                try (java.io.InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr)); FileOutputStream out = new FileOutputStream(part)) {
                    if (in == null) throw new java.io.IOException("can't open the video");
                    byte[] b = new byte[256 * 1024]; int n; long total = 0;
                    while ((n = in.read(b)) > 0) { out.write(b, 0, n); total += n; if (total > PREVIEW_CAP) throw new java.io.IOException("video too big");
                        if (!name.equals(previewWant)) throw new java.io.InterruptedIOException("superseded");
                        stepAside(); }
                }
                if (!part.renameTo(f)) { part.delete(); throw new java.io.IOException("couldn't keep the video"); }
                // the cache stays under its cap: the videos not shown for longest go first
                File[] all = dir.listFiles(); long used = 0;
                if (all != null) {
                    java.util.Arrays.sort(all, (a, c) -> Long.compare(c.lastModified(), a.lastModified()));
                    for (File x : all) { used += x.length(); if (used > PREVIEW_CAP && !x.equals(f)) x.delete(); }
                }
                JSObject r = new JSObject(); r.put("ok", true); r.put("path", f.getAbsolutePath()); call.resolve(r);
            } catch (Throwable e) {
                if (part != null && part.isFile()) part.delete(); // (a copy stopped part way leaves nothing behind)
                JSObject x = new JSObject(); x.put("ok", false); x.put("error", String.valueOf(e.getMessage())); if (e instanceof java.io.InterruptedIOException) x.put("superseded", true); call.resolve(x);
            }
        });
    }

    @PluginMethod
    public void saveBytes(PluginCall call) {
        // a picture made in the page (a PDF manual's page): { tree, sub, folder: "manuals", name (no extension), ext, b64, key }
        // → { ok, name, file } into "Boxshelf Manuals" beside the games, or the app's own storage when that can't be written
        final String treeStr = call.getString("tree", ""), sub = call.getString("sub", ""), name = safeName(call.getString("name", "file")), key = call.getString("key", "file");
        final String ext = "png".equals(call.getString("ext", "jpg")) ? "png" : "jpg", b64 = call.getString("b64", "");
        final String folder = "manuals".equals(call.getString("folder", "")) ? MANUAL_DIR : ART_DIR;
        if (b64.isEmpty()) { call.reject("Nothing to save"); return; }
        io.execute(() -> {
            try {
                byte[] body = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                String file = name + "." + ext, saved = saveToTree(treeStr, folder, sub, file, ext, body);
                if (saved == null) {
                    File dir = new File(getContext().getFilesDir(), "manuals/" + safeName(key));
                    if (!dir.isDirectory()) dir.mkdirs();
                    File f = new File(dir, file);
                    try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(body); }
                    saved = f.getAbsolutePath();
                }
                JSObject r = new JSObject(); r.put("ok", true); r.put("name", file); r.put("file", saved); call.resolve(r);
            } catch (Throwable e) { JSObject x = new JSObject(); x.put("ok", false); call.resolve(x); }
        });
    }

    @PluginMethod
    public void fetchArt(PluginCall call) {
        // { tree, sub, name, urls: [tried in order], key, maxH } → { ok, from, saved: 'folder' | 'app', file, display }
        // or { ok: false, missing } (no source has it) / { ok: false, busy } (offline, or a server having a bad day: try later).
        // With split (a full box wrap: name is "<game>-full"): the wrap is kept whole and display copies of its faces are made
        // (want: which ones; dname their name; ratio / depth the console's case shape) → also parts: { front, back, spine }
        final String treeStr = call.getString("tree", ""), sub = call.getString("sub", ""), name = safeName(call.getString("name", "art")), key = call.getString("key", "art");
        final int maxH = Math.max(64, Math.min(2048, call.getInt("maxH", 512)));
        final JSArray urls = call.getArray("urls", new JSArray());
        final boolean split = call.getBoolean("split", false);
        final JSObject data = call.getData();
        final double ratio = data == null ? 0.71 : data.optDouble("ratio", 0.71), depth = data == null ? 0.1 : data.optDouble("depth", 0.1);
        final JSArray want = call.getArray("want", new JSArray());
        final String dname = safeName(call.getString("dname", name));
        final boolean ss = call.getBoolean("ss", false); // ScreenScraper addresses: signed here (ssSign)
        // keepSince (ms, the background job's start; 0 = off): a picture of this name written since then is never written over
        final long keepSince = data == null ? 0L : data.optLong("keepSince", 0L);
        net.execute(() -> {
            boolean busy = false;
            for (int k = 0; k < urls.length(); k++) {
                String url = urls.optString(k, "");
                if (url.isEmpty()) continue;
                Got g;
                try { g = httpGet(ss ? ssSign(url) : url, null, 25 * 1024 * 1024); }
                catch (TooBig e) { continue; } // (beta.10) over the limit: as good as not there (never "busy": it would be fetched again every start)
                catch (Throwable e) { busy = true; continue; } // Throwable: even out of memory, the call must still be answered
                if (g.status == 404 || g.status == 410) continue;
                if (g.body == null) { busy = true; continue; } // 5xx / 429 / 403: not remembered as "not there"
                if (g.body.length < 1024) continue; // an error page (or ScreenScraper's "NOMEDIA"), not a picture
                try {
                    String ext = extFor(g.type, url), file = name + "." + ext;
                    JSObject r = new JSObject(); r.put("ok", true); r.put("from", url.replaceAll("[?#].*$", "")); r.put("name", file); // (never the query: a ScreenScraper address carries the sign-in)
                    if (split) { // also proves it's a picture, and a wrap, before anything is saved
                        JSObject parts = writeParts(g.body, key, dname, maxH, ratio, depth, want);
                        r.put("parts", parts);
                        r.put("display", parts.optString("front", parts.optString("back", parts.optString("spine", ""))));
                    } else r.put("display", writeDisplay(g.body, key, name, maxH));
                    boolean kept;
                    synchronized (artFileLock) {
                        kept = newerPicture(treeStr, sub, name, key, keepSince);
                        String saved = kept ? null : saveToTree(treeStr, sub, file, ext, g.body);
                        if (saved != null) { r.put("saved", "folder"); r.put("file", saved); }
                        else if (!kept) {
                            File dir = new File(getContext().getFilesDir(), "art-full/" + safeName(key));
                            if (!dir.isDirectory()) dir.mkdirs();
                            File f = new File(dir, file);
                            try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(g.body); }
                            r.put("saved", "app"); r.put("file", f.getAbsolutePath());
                        }
                    }
                    if (kept) { // a picture was put there while this downloaded (picked in Art Studio): left as it is
                        JSObject k2 = new JSObject(); k2.put("ok", false); k2.put("kept", true); k2.put("missing", false); k2.put("busy", false);
                        call.resolve(k2); return;
                    }
                    call.resolve(r); return;
                } catch (Throwable e) { continue; } // not a picture we can read (or too big to decode, or no wrap): the next source
            }
            JSObject r = new JSObject(); r.put("ok", false); r.put("missing", !busy); r.put("busy", busy); call.resolve(r);
        });
    }

    @PluginMethod
    public void artThumb(PluginCall call) { // a display copy of a picture already there (Boxshelf Art, or the app's own) → { display }
        // (split, want, dname, ratio, depth: a full wrap, as fetchArt → also parts: { front, back, spine })
        final String src = call.getString("src"), key = call.getString("key", "art"), name = safeName(call.getString("name", "art"));
        final int maxH = Math.max(64, Math.min(2048, call.getInt("maxH", 512)));
        final boolean split = call.getBoolean("split", false);
        final JSObject data = call.getData();
        final double ratio = data == null ? 0.71 : data.optDouble("ratio", 0.71), depth = data == null ? 0.1 : data.optDouble("depth", 0.1);
        final JSArray want = call.getArray("want", new JSArray());
        final String dname = safeName(call.getString("dname", name));
        if (src == null) { call.reject("No picture given"); return; }
        net.execute(() -> {
            try {
                byte[] body = readSrc(src);
                JSObject r = new JSObject();
                if (split) { JSObject parts = writeParts(body, key, dname, maxH, ratio, depth, want); r.put("parts", parts); r.put("display", parts.optString("front", parts.optString("back", parts.optString("spine", "")))); }
                else r.put("display", writeDisplay(body, key, name, maxH));
                call.resolve(r);
            } catch (Throwable e) { call.reject("Couldn't read that picture: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void artExists(PluginCall call) { // which display copies (absolute paths in the app's storage) are gone → { missing: [paths] }
        final JSArray paths = call.getArray("paths", new JSArray());
        io.execute(() -> {
            JSArray missing = new JSArray();
            for (int k = 0; k < paths.length(); k++) { String p = paths.optString(k, ""); if (!p.isEmpty() && !new File(p).isFile()) missing.put(p); }
            JSObject r = new JSObject(); r.put("missing", missing); call.resolve(r);
        });
    }

    @PluginMethod
    public void artForget(PluginCall call) { // display copies no longer used (0.3.2: made again sharper) → { removed }. Only files under files/art/
        final JSArray paths = call.getArray("paths", new JSArray());
        io.execute(() -> {
            int n = 0;
            try {
                String root = new File(getContext().getFilesDir(), "art").getCanonicalPath() + File.separator;
                for (int k = 0; k < paths.length(); k++) {
                    String p = paths.optString(k, "");
                    if (p.isEmpty()) continue;
                    try { File f = new File(p); if (f.getCanonicalPath().startsWith(root) && f.isFile() && f.delete()) n++; } catch (Exception ignored) {}
                }
            } catch (Exception ignored) {}
            JSObject r = new JSObject(); r.put("removed", n); call.resolve(r);
        });
    }

    // a picture Boxshelf may read: a content:// document (a picked folder, a picked picture) or a file of its own
    private byte[] readSrc(String src) throws IOException {
        if (src.startsWith("content:")) {
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(src))) {
                if (in == null) throw new IOException("Unreadable");
                return readAll(in, 40 * 1024 * 1024);
            }
        }
        File f = new File(src);
        String path = f.getCanonicalPath(), files = getContext().getFilesDir().getCanonicalPath(), cache = getContext().getCacheDir().getCanonicalPath();
        if (!path.startsWith(files + File.separator) && !path.startsWith(cache + File.separator)) throw new IOException("Not one of Boxshelf's files");
        try (InputStream in = new FileInputStream(f)) { return readAll(in, 40 * 1024 * 1024); }
    }

    private static String sniffExt(byte[] b) {
        if (b.length > 12 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "png";
        if (b.length > 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) return "jpg";
        if (b.length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "webp";
        return null; // something else Android can still read (HEIC, GIF, BMP…): saved as a JPEG copy
    }

    private static byte[] jpegOf(Bitmap bmp, int q) throws IOException {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            if (!bmp.compress(Bitmap.CompressFormat.JPEG, q, bo)) throw new IOException("Couldn't encode the picture");
            return bo.toByteArray();
        } finally { bmp.recycle(); }
    }

    // ---------- Art Studio: every version of a part, downloaded once into the app's cache and shown as small cards ----------
    @PluginMethod
    public void artCache(PluginCall call) {
        // { url, id, cut?: 'front' | 'back' | 'spine' (a face of a full wrap), ratio, depth, maxH } → { file, thumb, w, h }
        // (w × h: the picture, or the cut face, at full size) or { missing } / { busy }. id names the cache file: the page
        // passes a fingerprint of the address without any sign-in in it, so one version is never downloaded twice
        final String url = call.getString("url"), id = safeName(call.getString("id", "x")), cut = call.getString("cut", "");
        final JSObject data = call.getData();
        final double ratio = data == null ? 0.71 : data.optDouble("ratio", 0.71), depth = data == null ? 0.1 : data.optDouble("depth", 0.1);
        final int maxH = Math.max(64, Math.min(1024, call.getInt("maxH", 360)));
        final boolean ss = call.getBoolean("ss", false);
        if (url == null || url.isEmpty()) { call.reject("No address"); return; }
        net.execute(() -> {
            JSObject r = new JSObject();
            try {
                File dir = new File(getContext().getCacheDir(), "artc");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No cache folder");
                File f = new File(dir, id + ".bin");
                byte[] body;
                boolean fresh = false;
                if (f.isFile() && f.length() > 0) { try (InputStream in = new FileInputStream(f)) { body = readAll(in, 40 * 1024 * 1024); } }
                else {
                    Got g;
                    try { g = httpGet(ss ? ssSign(url) : url, null, 25 * 1024 * 1024); }
                    catch (TooBig e) { r.put("missing", true); r.put("toobig", true); call.resolve(r); return; } // (beta.10) not offered, never fetched again for nothing
                    catch (Throwable e) { r.put("busy", true); call.resolve(r); return; }
                    if (g.status == 404 || g.status == 410 || (g.body != null && g.body.length < 1024)) { r.put("missing", true); call.resolve(r); return; }
                    if (g.body == null) { r.put("busy", true); call.resolve(r); return; }
                    body = g.body; fresh = true;
                }
                BitmapFactory.Options o = new BitmapFactory.Options(); o.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(body, 0, body.length, o);
                int w = o.outWidth, h = o.outHeight;
                if (w <= 0 || h <= 0) { r.put("missing", true); call.resolve(r); return; }
                Bitmap bmp = decodeAbout(body, maxH, 16);
                if (!cut.isEmpty()) {
                    int[] c = wrapCuts(w, h, ratio, depth);
                    if (c == null) { bmp.recycle(); r.put("missing", true); call.resolve(r); return; } // not a wrap after all
                    Bitmap face;
                    try { face = cutFace(bmp, cut, ratio, depth); } finally { bmp.recycle(); }
                    bmp = face; w = "spine".equals(cut) ? c[1] : c[0];
                }
                String thumb = writeBitmap(bmp, new File(dir, "t"), id + (cut.isEmpty() ? "" : "-" + cut), maxH);
                if (fresh) {
                    File tmp = new File(dir, id + ".tmp");
                    try (FileOutputStream fo = new FileOutputStream(tmp)) { fo.write(body); }
                    if (!tmp.renameTo(f)) tmp.delete();
                    trimCache(dir);
                }
                r.put("file", f.getAbsolutePath()); r.put("thumb", thumb); r.put("w", w); r.put("h", h);
                call.resolve(r);
            } catch (Throwable e) { r.put("missing", true); call.resolve(r); } // unreadable as a picture (or too big): not offered
        });
    }

    // the studio's cache stays small: past 300 downloads the oldest go (their small cards with them)
    private static void trimCache(File dir) {
        File[] all = dir.listFiles();
        if (all == null || all.length <= 320) return;
        java.util.Arrays.sort(all, (x, y) -> Long.compare(x.lastModified(), y.lastModified()));
        for (int i = 0; i < all.length - 300; i++) {
            if (!all[i].isFile()) continue;
            String n = all[i].getName();
            all[i].delete();
            if (n.endsWith(".bin")) {
                String id = n.substring(0, n.length() - 4);
                File[] t = new File(dir, "t").listFiles();
                if (t != null) for (File x : t) if (x.getName().startsWith(id + ".") || x.getName().startsWith(id + "-")) x.delete();
            }
        }
    }

    @PluginMethod
    public void pickImage(PluginCall call) { // Android's own picture picker (Storage Access Framework) → { uri } or { canceled }
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // no picture picker on the device: the picker never opens, so its callback never runs and the call is answered here
        try { startActivityForResult(call, i, "imagePicked"); }
        catch (ActivityNotFoundException e) { call.reject("No picture picker is installed on this device"); }
    }

    @ActivityCallback
    private void imagePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        JSObject r = new JSObject();
        if (data == null || data.getData() == null) { r.put("canceled", true); call.resolve(r); return; }
        r.put("uri", data.getData().toString());
        call.resolve(r);
    }

    @PluginMethod
    public void saveArt(PluginCall call) {
        // { src (a studio download, a picked picture or a kept older one), tree, sub, name, key, dname, maxH, cut?, ratio, depth }
        // → { ok, display, file, saved: 'folder' | 'app', name, old? }. The picture goes into "Boxshelf Art" as <name>.<ext>
        // (a face cut from a wrap: as a JPEG). Whatever was there under that name, in any picture type, is first copied to the
        // app's own storage (old: for Undo) and then removed, so the folder never holds two pictures for one part.
        // dname: the display copy's own name (new each time, so the shelf never shows a cached older picture)
        final String src = call.getString("src"), treeStr = call.getString("tree", ""), sub = call.getString("sub", ""), name = safeName(call.getString("name", "art")),
            key = call.getString("key", "art"), cut = call.getString("cut", "");
        final String dname = safeName(call.getString("dname", name));
        final int maxH = Math.max(64, Math.min(2048, call.getInt("maxH", 512)));
        final JSObject data = call.getData();
        final double ratio = data == null ? 0.71 : data.optDouble("ratio", 0.71), depth = data == null ? 0.1 : data.optDouble("depth", 0.1);
        if (src == null || src.isEmpty()) { call.reject("No picture given"); return; }
        net.execute(() -> {
            try {
                byte[] body = readSrc(src);
                String ext;
                if (!cut.isEmpty()) {
                    Bitmap full = decodeAtMost(body, 4096), face;
                    try { face = cutFace(full, cut, ratio, depth); } finally { full.recycle(); }
                    body = jpegOf(face, 92); ext = "jpg";
                } else {
                    ext = sniffExt(body);
                    if (ext == null) { body = jpegOf(decodeAtMost(body, 4096), 92); ext = "jpg"; }
                }
                String display = writeDisplay(body, key, dname, maxH); // (proves it's a picture before anything is touched)
                String file = name + "." + ext, old = null, saved = null;
                JSObject r = new JSObject(); r.put("ok", true); r.put("display", display); r.put("name", file);
                synchronized (artFileLock) {
                    if (!treeStr.isEmpty()) { old = clearOld(treeStr, sub, name, key); saved = saveToTree(treeStr, sub, file, ext, body); }
                    if (saved != null) { r.put("saved", "folder"); r.put("file", saved); }
                    else {
                        File dir = new File(getContext().getFilesDir(), "art-full/" + safeName(key));
                        if (!dir.isDirectory()) dir.mkdirs();
                        for (String e : PIC_EXTS) {
                            File was = new File(dir, name + "." + e);
                            if (!was.isFile()) continue;
                            if (old == null) old = keepOld(new FileInputStream(was), key, name, e);
                            if (old != null) was.delete();
                        }
                        File f = new File(dir, file);
                        try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(body); }
                        r.put("saved", "app"); r.put("file", f.getAbsolutePath());
                    }
                }
                if (old != null) r.put("old", old);
                call.resolve(r);
            } catch (Throwable e) { call.reject("Couldn't use that picture: " + e.getMessage()); }
        });
    }

    private static final String[] PIC_EXTS = { "png", "jpg", "jpeg", "webp" };

    // fetchArt's keepSince: is a "<name>.<png|jpg|jpeg|webp>" there (the games folder's Boxshelf Art, or the app's own
    // art-full when there's no folder) that was written at or after since? A few seconds of slack, as memory card file
    // systems round file times. A time that can't be read counts as older (written over, as before). Called under artFileLock
    private boolean newerPicture(String treeStr, String sub, String name, String key, long since) {
        if (since <= 0) return false;
        long after = since - 3000L;
        if (treeStr == null || treeStr.isEmpty()) {
            File dir = new File(getContext().getFilesDir(), "art-full/" + safeName(key));
            for (String e : PIC_EXTS) { File f = new File(dir, name + "." + e); if (f.isFile() && f.lastModified() >= after) return true; }
            return false;
        }
        try {
            Uri tree = Uri.parse(treeStr); ContentResolver cr = getContext().getContentResolver();
            String dir = artDirId(cr, tree, sub, false);
            if (dir == null) return false;
            ArtListing l = artListing(cr, tree, treeStr + "|" + dir, dir);
            if (l == null) return false;
            synchronized (artListings) {
                for (String e : PIC_EXTS) { Long t = l.times.get((name + "." + e).toLowerCase(Locale.ROOT)); if (t != null && t >= after) return true; }
            }
        } catch (Exception ignored) {}
        return false;
    }

    // (beta.12) newerPicture's view of an art folder: each file's name (lower case) → when it was last written. Listed
    // once (a big "Boxshelf Art" folder used to be listed again for every picture downloaded) and kept current by
    // Boxshelf's own writes (noteArt); listed afresh after ART_LIST_TTL, so a change made outside Boxshelf is seen too.
    // The map is only read or changed under its own lock (artListings)
    private static final long ART_LIST_TTL = 120_000L;
    private static final class ArtListing { final java.util.Map<String, Long> times = new java.util.HashMap<>(); long at; }
    private final java.util.Map<String, ArtListing> artListings = new java.util.HashMap<>(); // tree|folder id → its listing

    private ArtListing artListing(ContentResolver cr, Uri tree, String key, String dir) {
        long now = android.os.SystemClock.uptimeMillis();
        synchronized (artListings) { ArtListing l = artListings.get(key); if (l != null && now - l.at < ART_LIST_TTL) return l; }
        ArtListing fresh = new ArtListing();
        fresh.at = now;
        String[] cols = { DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_LAST_MODIFIED };
        try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, dir), cols, null, null, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                String n = c.getString(0);
                if (n == null || c.isNull(1)) continue; // (a time that can't be read counts as older)
                fresh.times.put(n.toLowerCase(Locale.ROOT), c.getLong(1));
            }
        }
        synchronized (artListings) {
            if (artListings.size() > 64) artListings.clear(); // (one per console's art folder: never grows for ever)
            artListings.put(key, fresh);
        }
        return fresh;
    }

    // Boxshelf wrote (time > 0) or removed (0) a file in an art folder: a listing of that folder is updated to match
    private void noteArt(String treeStr, String dir, String file, long time) {
        if (treeStr == null || dir == null || file == null) return;
        synchronized (artListings) {
            ArtListing l = artListings.get(treeStr + "|" + dir);
            if (l == null) return;
            if (time > 0) l.times.put(file.toLowerCase(Locale.ROOT), time); else l.times.remove(file.toLowerCase(Locale.ROOT));
        }
    }

    // every "<name>.<png|jpg|jpeg|webp>" in the games folder's Boxshelf Art: the first is kept in the app's own storage
    // (→ its path, for Undo) and all are removed. One that can't be kept is left where it is (never lost)
    private String clearOld(String treeStr, String sub, String name, String key) {
        String old = null;
        try {
            Uri tree = Uri.parse(treeStr); ContentResolver cr = getContext().getContentResolver();
            String dir = artDirId(cr, tree, sub, false);
            if (dir == null) return null;
            for (String e : PIC_EXTS) {
                String id = findChild(cr, tree, dir, name + "." + e, false);
                if (id == null) continue;
                Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                if (old == null) { InputStream in = cr.openInputStream(doc); if (in != null) old = keepOld(in, key, name, e); }
                if (old != null) { try { if (DocumentsContract.deleteDocument(cr, doc)) noteArt(treeStr, dir, name + "." + e, 0); } catch (Exception ignored) {} }
            }
        } catch (Exception ignored) {}
        return old;
    }

    // a picture about to be replaced → files/art-old/<key>/<name>-<time>.<ext> (closes in) → its path, or null
    private String keepOld(InputStream in, String key, String name, String ext) {
        try (InputStream i = in) {
            File dir = new File(getContext().getFilesDir(), "art-old/" + safeName(key));
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            File f = new File(dir, safeName(name) + "-" + System.currentTimeMillis() + "." + ext);
            try (FileOutputStream fo = new FileOutputStream(f)) { byte[] buf = new byte[16384]; int n; while ((n = i.read(buf)) > 0) fo.write(buf, 0, n); }
            // only the newest 60 per console are kept (Undo goes back 10 picks per part): the folder never grows for ever
            File[] all = dir.listFiles();
            if (all != null && all.length > 60) {
                java.util.Arrays.sort(all, (x, y) -> Long.compare(y.lastModified(), x.lastModified()));
                for (int k = 60; k < all.length; k++) if (all[k].isFile()) all[k].delete();
            }
            return f.getAbsolutePath();
        } catch (Exception e) { return null; }
    }

    // ---------- (beta.12) RomM: a game downloaded into its console's games folder ----------
    // The Windows build's main/romm.js download, on the device: streamed straight into the console's games folder (its
    // SAF tree) as "<name>.part", carried on from where it got to (a Range request, the part appended to), checked against
    // RomM's size and hash (sha1, else md5: the finished file read back, on this thread), then renamed. A game made of
    // several files arrives as a zip: unpacked into a folder of its own (nothing outside it, ".." refused), each file's
    // CRC checked, and the file to start chosen (m3u, cue, gdi … else the biggest). One download at a time, on a
    // background thread of its own; progress as "rommProgress" events { id, phase: download | verify | extract, received,
    // total } at most 4 a second; rommCancel stops it (the part is kept for the next Play).
    // { id, url, tree, name, size, multi, sha1, md5, files: [{ name, size, sha1, md5 }] } → { ok, uri, docId, name, dir,
    // verified, already } or rejected with a code: cancelled, busy, no-token, auth, not-found, no-space, no-folder,
    // hash-mismatch, zip-bad, rename, cleartext, offline, http-<status>.
    private static final String[] ROMM_LAUNCH = { "m3u", "cue", "gdi", "ccd", "cdi", "chd", "iso", "rvz", "wbfs", "wua", "nsp", "xci" };
    private static final Pattern CONTENT_RANGE = Pattern.compile("bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)", Pattern.CASE_INSENSITIVE);
    private static final Pattern RANGE_TOTAL = Pattern.compile("/(\\d+)\\s*$");
    private final Object rommLock = new Object();
    private boolean rommBusy = false; // (only touched under rommLock)
    private volatile boolean rommStop = false;
    private volatile HttpURLConnection rommConn = null;

    static final class RommFail extends IOException { final String code; RommFail(String code) { super(code); this.code = code; } }

    // the saved RomM server's address as the page writes it: http:// added when missing, no trailing "/" or "/api"
    private static String rommBase(String server) {
        String u = server == null ? "" : server.trim();
        if (u.isEmpty()) return "";
        if (!u.toLowerCase(Locale.ROOT).startsWith("http://") && !u.toLowerCase(Locale.ROOT).startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (u.toLowerCase(Locale.ROOT).endsWith("/api")) u = u.substring(0, u.length() - 4);
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    // { base, token } from the saved settings (config.json: romm.server, keys.rommToken), or null when not paired.
    // (beta.12) The token belongs to the server it was paired with (keys.rommTokenServer, that server's origin, as on the
    // PC): when the saved address now leads somewhere else, the token is never sent there. A token saved before this (no
    // origin kept with it) is taken as the saved server's, as on the PC
    private String[] rommAccount() {
        try {
            File f = fileFor("config.json");
            if (!f.isFile()) return null;
            String text;
            try (InputStream in = new FileInputStream(f)) { text = new String(readAll(in, 4 * 1024 * 1024), StandardCharsets.UTF_8); }
            JSONObject cfg = new JSONObject(text);
            JSONObject rm = cfg.optJSONObject("romm"), keys = cfg.optJSONObject("keys");
            if (rm == null || keys == null) return null;
            String base = rommBase(rm.optString("server", "")), tok = keys.optString("rommToken", "").trim();
            if (base.isEmpty() || tok.isEmpty()) return null;
            String bound = keys.optString("rommTokenServer", "").trim();
            if (!bound.isEmpty() && !bound.equalsIgnoreCase(originOf(base))) return null;
            return new String[] { base, tok };
        } catch (Exception e) { return null; }
    }

    // an address's origin as a browser writes it (scheme://host[:port], the port only when it isn't the scheme's own), or ""
    static String originOf(String url) {
        try {
            URL u = new URL(url);
            String scheme = u.getProtocol().toLowerCase(Locale.ROOT), host = u.getHost().toLowerCase(Locale.ROOT);
            if (host.isEmpty()) return "";
            int port = u.getPort();
            boolean own = port == -1 || ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
            return scheme + "://" + host + (own ? "" : ":" + port);
        } catch (Exception e) { return ""; }
    }

    // the sign-in, only for an address on the saved RomM server (it is never sent anywhere else), or null
    private String rommToken(String url) {
        String[] a = rommAccount();
        if (a == null || url == null || !url.startsWith(a[0] + "/")) return null;
        return a[1];
    }

    private void rommProgress(String id, String phase, long received, long total) {
        JSObject e = new JSObject(); e.put("id", id); e.put("phase", phase); e.put("received", received); e.put("total", total);
        notifyListeners("rommProgress", e);
    }

    private static boolean cleartext(Throwable e) { String m = e == null ? null : e.getMessage(); return m != null && m.toUpperCase(Locale.ROOT).contains("CLEARTEXT"); }

    // (beta.12) what RomM downloads made in the games folders (the document's address → the size written; -1 for a game's
    // folder): only those are ever replaced. A file that was swapped for another since (a different size) is the player's
    private android.content.SharedPreferences rommMadePrefs() { return getContext().getSharedPreferences("boxshelf_romm_made", android.content.Context.MODE_PRIVATE); }

    private boolean rommMade(ContentResolver cr, Uri tree, String docId, boolean dir) {
        try {
            String k = DocumentsContract.buildDocumentUriUsingTree(tree, docId).toString();
            android.content.SharedPreferences p = rommMadePrefs();
            if (!p.contains(k)) return false;
            if (dir) return true;
            long want = p.getLong(k, -2L);
            return want >= 0 && docSize(cr, tree, docId) == want;
        } catch (RuntimeException e) { return false; }
    }

    private void rommMark(Uri tree, String docId, long size) {
        try { rommMadePrefs().edit().putLong(DocumentsContract.buildDocumentUriUsingTree(tree, docId).toString(), size).apply(); } catch (RuntimeException ignored) {}
    }

    private void rommUnmark(Uri tree, String docId) {
        try { rommMadePrefs().edit().remove(DocumentsContract.buildDocumentUriUsingTree(tree, docId).toString()).apply(); } catch (RuntimeException ignored) {}
    }

    // the name a download takes beside a player's own file or folder of the same name: "Game (RomM).chd", "Game (RomM)"
    private static String rommAlt(String name, boolean dir) {
        int dot = dir ? -1 : name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) + " (RomM)" + name.substring(dot) : name + " (RomM)";
    }

    @PluginMethod
    public void rommCancel(PluginCall call) {
        boolean had;
        synchronized (rommLock) { had = rommBusy; if (had) rommStop = true; }
        final HttpURLConnection c = rommConn;
        if (had && c != null) net.execute(() -> { try { c.disconnect(); } catch (Exception ignored) {} }); // (a read stuck on the network ends at once)
        JSObject r = new JSObject(); r.put("ok", had); call.resolve(r);
    }

    @PluginMethod
    public void rommDownload(PluginCall call) {
        final String url = call.getString("url", ""), treeStr = call.getString("tree", ""), id = call.getString("id", "");
        final String name = safeName(call.getString("name", ""));
        final long size = Math.max(0L, call.getData().optLong("size", 0L));
        final boolean multi = call.getBoolean("multi", false);
        final String sha1 = call.getString("sha1", ""), md5 = call.getString("md5", "");
        final JSArray files = call.getArray("files", new JSArray());
        if (url == null || url.isEmpty() || name.equals("_") || name.equals(".") || name.equals("..")) { call.reject("bad-game"); return; }
        if (treeStr == null || treeStr.isEmpty()) { call.reject("no-folder"); return; }
        final String[] acct = rommAccount();
        if (acct == null) { call.reject("no-token"); return; }
        if (!url.startsWith(acct[0] + "/")) { call.reject("auth"); return; }
        synchronized (rommLock) { if (rommBusy) { call.reject("busy"); return; } rommBusy = true; rommStop = false; }
        Thread t = new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
            JSObject res = null; String fail = null;
            holdAwake(true); // (beta.12) the screen stays on while the player waits for the game
            try {
                res = rommRun(Uri.parse(treeStr), url, acct[0], acct[1], name, size, multi, sha1 == null ? "" : sha1.trim(), md5 == null ? "" : md5.trim(), files, id == null ? "" : id);
            } catch (RommFail e) { fail = rommStop ? "cancelled" : e.code; }
            catch (Throwable e) { fail = rommStop ? "cancelled" : cleartext(e) ? "cleartext" : (e instanceof IOException ? "offline" : "error"); }
            finally { rommConn = null; synchronized (rommLock) { rommBusy = false; rommStop = false; } holdAwake(false); }
            if (res != null) call.resolve(res); else call.reject(fail == null ? "error" : fail);
        }, "boxshelf-romm");
        t.setDaemon(true);
        try { t.start(); }
        catch (Throwable e) { synchronized (rommLock) { rommBusy = false; } call.reject("error"); }
    }

    private JSObject rommRun(Uri tree, String url, String base, String token, String name, long size, boolean multi, String sha1, String md5, JSArray files, String id) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        String dirId = startId(tree);
        // already there (an earlier download, or copied over): nothing to fetch. (beta.12) Also under the name a download
        // gets beside a file of the player's own ("<name> (RomM)", rommAlt)
        if (!multi) {
            String have = findChild(cr, tree, dirId, name, false);
            if (have != null && size > 0 && docSize(cr, tree, have) == size) return rommResult(tree, have, name, "", "size", true);
            String altName = rommAlt(name, false), alt = findChild(cr, tree, dirId, altName, false);
            if (alt != null && size > 0 && docSize(cr, tree, alt) == size) return rommResult(tree, alt, docName(cr, tree, alt, altName), "", "size", true);
        } else {
            for (String fn : new String[] { name, rommAlt(name, true) }) {
                String folder = findChild(cr, tree, dirId, fn, true);
                if (folder != null) { JSObject done = rommMultiDone(cr, tree, folder, fn, files); if (done != null) return done; }
            }
        }
        String partName = (multi ? name + ".zip" : name) + ".part";
        String part0 = findChild(cr, tree, dirId, partName, false);
        long need = (multi ? size * 2 : size) - (part0 == null ? 0 : Math.max(0L, docSize(cr, tree, part0))), free = freeBytes(dirId);
        if (need > 0 && free >= 0 && free < need + (64L << 20)) throw new RommFail("no-space");
        String partId = rommFetch(cr, tree, dirId, partName, url, base, token, multi ? 0 : size, id);
        Uri part = DocumentsContract.buildDocumentUriUsingTree(tree, partId);
        if (rommStop) throw new RommFail("cancelled");
        if (!multi) {
            String verified = "none";
            if (size > 0) {
                long got = docSize(cr, tree, partId);
                if (got >= 0 && got != size) { deleteDoc(cr, part); throw new RommFail("hash-mismatch"); }
                verified = "size";
            }
            String algo = !sha1.isEmpty() ? "SHA-1" : !md5.isEmpty() ? "MD5" : null;
            if (algo != null) {
                String got = hashDoc(cr, part, algo, id, size);
                if (!got.equalsIgnoreCase(!sha1.isEmpty() ? sha1 : md5)) { deleteDoc(cr, part); throw new RommFail("hash-mismatch"); }
                verified = !sha1.isEmpty() ? "sha1" : "md5";
            }
            // (beta.12) a file of that name already there (the wrong size): replaced only when an earlier RomM download made
            // it (rommMade); a file of the player's own is never deleted, the game goes beside it as "<name> (RomM).<ext>"
            String target = name;
            String old = findChild(cr, tree, dirId, name, false);
            if (old != null && !old.equals(partId)) {
                if (rommMade(cr, tree, old, false)) { deleteDoc(cr, DocumentsContract.buildDocumentUriUsingTree(tree, old)); rommUnmark(tree, old); }
                else {
                    target = rommAlt(name, false);
                    String alt = findChild(cr, tree, dirId, target, false);
                    if (alt != null && !alt.equals(partId) && rommMade(cr, tree, alt, false)) { deleteDoc(cr, DocumentsContract.buildDocumentUriUsingTree(tree, alt)); rommUnmark(tree, alt); }
                }
            }
            Uri done;
            try { done = DocumentsContract.renameDocument(cr, part, target); } catch (Exception e) { throw new RommFail("rename"); }
            String doneId = DocumentsContract.getDocumentId(done != null ? done : part);
            rommMark(tree, doneId, docSize(cr, tree, doneId));
            return rommResult(tree, doneId, docName(cr, tree, doneId, target), "", verified, false);
        }
        // several files: the zip unpacked into a folder of its own. (beta.12) A folder of that name Boxshelf didn't make
        // (the player's own) is left as it is: the game goes into "<name> (RomM)" beside it
        String folderName = name;
        String folderId = findChild(cr, tree, dirId, name, true);
        if (folderId != null && !rommMade(cr, tree, folderId, true)) {
            folderName = rommAlt(name, true);
            folderId = findChild(cr, tree, dirId, folderName, true);
        }
        boolean madeFolder = false;
        if (folderId == null) {
            Uri made;
            try { made = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, dirId), DocumentsContract.Document.MIME_TYPE_DIR, folderName); }
            catch (Exception e) { made = null; }
            if (made == null) throw new RommFail("no-folder");
            folderId = DocumentsContract.getDocumentId(made);
            madeFolder = true;
            rommMark(tree, folderId, -1L);
        }
        try { rommUnzip(cr, part, tree, folderId, files, id); }
        catch (RommFail e) {
            if (madeFolder) { deleteDoc(cr, DocumentsContract.buildDocumentUriUsingTree(tree, folderId)); rommUnmark(tree, folderId); }
            if ("hash-mismatch".equals(e.code)) deleteDoc(cr, part); // (a damaged download: fetched again next time; else it's kept)
            throw e;
        } catch (Exception e) {
            if (madeFolder) { deleteDoc(cr, DocumentsContract.buildDocumentUriUsingTree(tree, folderId)); rommUnmark(tree, folderId); }
            if (rommStop) throw new RommFail("cancelled");
            throw new RommFail("zip-bad");
        }
        deleteDoc(cr, part);
        JSObject r = rommMultiDone(cr, tree, folderId, docName(cr, tree, folderId, folderName), new JSArray());
        if (r == null) throw new RommFail("zip-bad");
        r.put("already", false); r.put("verified", "files");
        return r;
    }

    private JSObject rommResult(Uri tree, String docId, String fileName, String dir, String verified, boolean already) {
        JSObject r = new JSObject();
        r.put("ok", true); r.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, docId).toString()); r.put("docId", docId);
        r.put("name", fileName); r.put("dir", dir); r.put("verified", verified); r.put("already", already);
        return r;
    }

    private static long docSize(ContentResolver cr, Uri tree, String docId) {
        try (Cursor c = cr.query(DocumentsContract.buildDocumentUriUsingTree(tree, docId), new String[] { DocumentsContract.Document.COLUMN_SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {}
        return -1;
    }

    private static String docName(ContentResolver cr, Uri tree, String docId, String fallback) {
        try (Cursor c = cr.query(DocumentsContract.buildDocumentUriUsingTree(tree, docId), new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {}
        return fallback;
    }

    private static void deleteDoc(ContentResolver cr, Uri doc) { try { DocumentsContract.deleteDocument(cr, doc); } catch (Exception ignored) {} }

    // free space on the games folder's volume ("primary:…" = internal storage, "1A2B-3C4D:…" = an SD card), -1 = can't tell
    private static long freeBytes(String docId) {
        try {
            int i = docId == null ? -1 : docId.indexOf(':');
            if (i <= 0) return -1;
            String vol = docId.substring(0, i);
            File root = "primary".equals(vol) ? android.os.Environment.getExternalStorageDirectory() : new File("/storage/" + vol);
            return new android.os.StatFs(root.getPath()).getAvailableBytes();
        } catch (Throwable e) { return -1; }
    }

    private static String mimeOf(String fileName) {
        int dot = fileName.lastIndexOf('.');
        String ext = dot > 0 ? fileName.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String m = ext.isEmpty() ? null : android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m == null ? "application/octet-stream" : m; // (a type that matches the name: the folder keeps the name as given)
    }

    // the download into "<name>.part" (made when missing, carried on when there), tried again twice on a dropped connection
    private String rommFetch(ContentResolver cr, Uri tree, String dirId, String partName, String url, String base, String token, long expect, String id) throws Exception {
        for (int attempt = 0; ; attempt++) {
            if (rommStop) throw new RommFail("cancelled");
            String partId = findChild(cr, tree, dirId, partName, false);
            long have = partId == null ? 0 : Math.max(0L, docSize(cr, tree, partId));
            if (partId != null && expect > 0 && have > expect) { deleteDoc(cr, DocumentsContract.buildDocumentUriUsingTree(tree, partId)); partId = null; have = 0; }
            if (partId != null && expect > 0 && have == expect) return partId;
            if (partId == null) {
                Uri made;
                try { made = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, dirId), "application/octet-stream", partName); }
                catch (Exception e) { made = null; }
                if (made == null) throw new RommFail("no-folder");
                partId = DocumentsContract.getDocumentId(made);
                have = 0;
            }
            try { rommStream(cr, DocumentsContract.buildDocumentUriUsingTree(tree, partId), url, base, token, have, expect, id); return partId; }
            catch (RommFail e) {
                if (rommStop) throw new RommFail("cancelled");
                if (!"range".equals(e.code) || attempt >= 2) throw e; // (range: the part was dropped, start again from nothing)
            } catch (IOException e) {
                if (rommStop) throw new RommFail("cancelled");
                if (attempt >= 2 || cleartext(e)) throw e;
                try { Thread.sleep(1000); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); throw new RommFail("cancelled"); }
            }
        }
    }

    // one request: the bytes after `have` appended to the part (or the whole file written again when the server sends it all)
    private void rommStream(ContentResolver cr, Uri part, String url, String base, String token, long have, long expect, String id) throws IOException {
        String u = url;
        HttpURLConnection c = null;
        try {
            int code;
            for (int hop = 0; ; hop++) {
                if (hop >= 6) throw new IOException("Too many redirects");
                URL nu = new URL(u);
                if (hop > 0 && "http".equals(nu.getProtocol()) && url.startsWith("https:")) throw new IOException("Refused a redirect from https to http");
                c = (HttpURLConnection) nu.openConnection();
                rommConn = c;
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(20000);
                c.setReadTimeout(30000); // (a stalled transfer ends here and is picked up again from where it got to)
                c.setRequestProperty("User-Agent", userAgent());
                c.setRequestProperty("Accept", "*/*");
                c.setRequestProperty("Accept-Encoding", "identity");
                if (token != null && u.startsWith(base + "/")) c.setRequestProperty("Authorization", "Bearer " + token);
                if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
                if (rommStop) throw new RommFail("cancelled");
                code = c.getResponseCode();
                if (code >= 300 && code < 400 && code != 304) {
                    String loc = c.getHeaderField("Location");
                    drain(c); c.disconnect(); c = null;
                    if (loc == null) throw new RommFail("http-" + code);
                    u = new URL(new URL(u), loc).toString();
                    continue;
                }
                break;
            }
            if (code == 416 && have > 0) { // asked for more than there is: complete already, or a part that doesn't belong
                Matcher m = RANGE_TOTAL.matcher(String.valueOf(c.getHeaderField("Content-Range")));
                long full = m.find() ? Long.parseLong(m.group(1)) : expect;
                drain(c);
                if (full > 0 && full == have) return;
                deleteDoc(cr, part);
                throw new RommFail("range");
            }
            if (code == 401 || code == 403) { drain(c); throw new RommFail("auth"); }
            if (code == 404) { drain(c); throw new RommFail("not-found"); }
            if (code < 200 || code >= 300) { drain(c); throw new RommFail("http-" + code); }
            boolean append = false;
            long total;
            if (code == 206 && have > 0) {
                Matcher m = CONTENT_RANGE.matcher(String.valueOf(c.getHeaderField("Content-Range")));
                if (!m.find() || Long.parseLong(m.group(1)) != have) { deleteDoc(cr, part); throw new RommFail("range"); }
                append = true;
                total = "*".equals(m.group(3)) ? -1 : Long.parseLong(m.group(3));
            } else {
                have = 0;
                long len = c.getContentLengthLong();
                total = len > 0 ? len : (expect > 0 ? expect : -1);
            }
            long received = have;
            OutputStream o;
            try { o = cr.openOutputStream(part, append ? "wa" : "wt"); }
            catch (Exception e) {
                if (!append) throw new RommFail("no-folder");
                deleteDoc(cr, part); throw new RommFail("range"); // (a folder that can't append: the whole file again)
            }
            if (o == null) throw new RommFail("no-folder");
            rommProgress(id, "download", received, total);
            try (OutputStream out = o; InputStream in = c.getInputStream()) {
                byte[] buf = new byte[256 * 1024];
                long tick = android.os.SystemClock.uptimeMillis();
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (rommStop) throw new RommFail("cancelled");
                    out.write(buf, 0, n);
                    received += n;
                    long now = android.os.SystemClock.uptimeMillis();
                    if (now - tick >= 250) { tick = now; rommProgress(id, "download", received, total); }
                }
            }
            rommProgress(id, "download", received, total);
            if (total > 0 && received != total) throw new IOException("Short download (" + received + " of " + total + ")");
        } finally {
            if (c != null) c.disconnect();
            rommConn = null;
        }
    }

    private String hashDoc(ContentResolver cr, Uri doc, String algo, String id, long total) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance(algo);
        rommProgress(id, "verify", 0, total);
        try (InputStream in = cr.openInputStream(doc)) {
            if (in == null) throw new IOException("The download can't be read back");
            byte[] buf = new byte[256 * 1024];
            long done = 0, tick = android.os.SystemClock.uptimeMillis();
            int n;
            while ((n = in.read(buf)) > 0) {
                if (rommStop) throw new RommFail("cancelled");
                md.update(buf, 0, n);
                done += n;
                long now = android.os.SystemClock.uptimeMillis();
                if (now - tick >= 250) { tick = now; rommProgress(id, "verify", done, total); }
            }
        }
        return hexOf(md.digest());
    }

    private static String hexOf(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x & 0xff));
        return s.toString();
    }

    // every file under a game's folder (a few levels down): lower-case name → { docId, name, size, relative path }
    private java.util.Map<String, String[]> listTree(ContentResolver cr, Uri tree, String folderId) {
        java.util.Map<String, String[]> out = new java.util.LinkedHashMap<>();
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE };
        ArrayDeque<String[]> todo = new ArrayDeque<>();
        todo.add(new String[] { folderId, "", "0" });
        while (!todo.isEmpty() && out.size() < 5000) {
            String[] d = todo.poll();
            try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, d[0]), cols, null, null, null)) {
                while (c != null && c.moveToNext()) {
                    String kid = c.getString(0), n = c.getString(1);
                    if (n == null) continue;
                    String rel = d[1].isEmpty() ? n : d[1] + "/" + n;
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) { if (Integer.parseInt(d[2]) < 3) todo.add(new String[] { kid, rel, String.valueOf(Integer.parseInt(d[2]) + 1) }); continue; }
                    String k = n.toLowerCase(Locale.ROOT);
                    if (!out.containsKey(k)) out.put(k, new String[] { kid, n, String.valueOf(c.isNull(3) ? -1 : c.getLong(3)), rel });
                }
            } catch (Exception ignored) {}
        }
        return out;
    }

    // a multi-file game's folder, complete (every file RomM lists there at its size; with no list, any file) → its result
    // with the file to start, else null
    private JSObject rommMultiDone(ContentResolver cr, Uri tree, String folderId, String name, JSArray files) {
        java.util.Map<String, String[]> have = listTree(cr, tree, folderId);
        if (have.isEmpty()) return null;
        int count = files == null ? 0 : files.length();
        for (int i = 0; i < count; i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null) continue;
            String fn = f.optString("name", "");
            int slash = Math.max(fn.lastIndexOf('/'), fn.lastIndexOf('\\'));
            String[] h = have.get(safeName(slash >= 0 ? fn.substring(slash + 1) : fn).toLowerCase(Locale.ROOT));
            long want = f.optLong("size", -1);
            if (h == null || (want >= 0 && Long.parseLong(h[2]) != want)) return null;
        }
        String[] pick = null;
        for (String e : ROMM_LAUNCH) {
            for (String[] h : have.values()) if (!h[3].contains("/") && h[1].toLowerCase(Locale.ROOT).endsWith("." + e)) { pick = h; break; }
            if (pick != null) break;
        }
        if (pick == null) for (String[] h : have.values()) if (pick == null || Long.parseLong(h[2]) > Long.parseLong(pick[2])) pick = h;
        if (pick == null) return null;
        return rommResult(tree, pick[0], pick[1], name, "files", true);
    }

    private static final class ZipEnt { String name; int flags, method; long crc, comp, unc, local; }

    // part of the zip, read by position (the folder's file is opened once, seekable); pad: one 0 byte after the end, which
    // a raw inflater may want to finish
    private static final class ChanIn extends InputStream {
        private final java.nio.channels.FileChannel ch; private long pos; private final long end; private boolean pad;
        ChanIn(java.nio.channels.FileChannel ch, long from, long to, boolean pad) { this.ch = ch; this.pos = from; this.end = to; this.pad = pad; }
        @Override public int read() throws IOException { byte[] b = new byte[1]; int n = read(b, 0, 1); return n <= 0 ? -1 : (b[0] & 0xff); }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (pos >= end) { if (pad) { pad = false; b[off] = 0; return 1; } return -1; }
            int want = (int) Math.min((long) len, end - pos);
            int n = ch.read(java.nio.ByteBuffer.wrap(b, off, want), pos);
            if (n <= 0) throw new IOException("zip: short read");
            pos += n;
            return n;
        }
    }

    private static java.nio.ByteBuffer readAt(java.nio.channels.FileChannel ch, long pos, int len) throws IOException {
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(len);
        while (b.hasRemaining()) { int n = ch.read(b, pos + b.position()); if (n <= 0) break; }
        if (b.hasRemaining()) throw new IOException("zip: short read");
        b.flip();
        b.order(java.nio.ByteOrder.LITTLE_ENDIAN);
        return b;
    }

    // the zip's own directory (zip64 too), then each file unpacked into the game's folder, its CRC (and RomM's hash, when
    // it lists one for that name) checked as it's written
    private void rommUnzip(ContentResolver cr, Uri zip, Uri tree, String folderId, JSArray files, String id) throws Exception {
        java.util.Map<String, JSONObject> want = new java.util.HashMap<>();
        int fc = files == null ? 0 : files.length();
        for (int i = 0; i < fc; i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null) continue;
            String fn = f.optString("name", "");
            int slash = Math.max(fn.lastIndexOf('/'), fn.lastIndexOf('\\'));
            want.put(safeName(slash >= 0 ? fn.substring(slash + 1) : fn).toLowerCase(Locale.ROOT), f);
        }
        android.os.ParcelFileDescriptor pfd = cr.openFileDescriptor(zip, "r");
        if (pfd == null) throw new IOException("The zip can't be read");
        try (android.os.ParcelFileDescriptor.AutoCloseInputStream fis = new android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd)) {
            java.nio.channels.FileChannel ch = fis.getChannel();
            long zsize = ch.size();
            int tailLen = (int) Math.min(zsize, 65557L);
            if (tailLen < 22) throw new IOException("zip: too short");
            java.nio.ByteBuffer tail = readAt(ch, zsize - tailLen, tailLen);
            int e = -1;
            for (int i = tailLen - 22; i >= 0; i--) if (tail.getInt(i) == 0x06054b50) { e = i; break; }
            if (e < 0) throw new IOException("zip: no directory");
            long count = tail.getShort(e + 10) & 0xffffL, cdSize = tail.getInt(e + 12) & 0xffffffffL, cdOff = tail.getInt(e + 16) & 0xffffffffL;
            if (count == 0xffffL || cdSize == 0xffffffffL || cdOff == 0xffffffffL) {
                int loc = e - 20;
                if (loc < 0 || tail.getInt(loc) != 0x07064b50) throw new IOException("zip64: no locator");
                java.nio.ByteBuffer z = readAt(ch, tail.getLong(loc + 8), 56);
                if (z.getInt(0) != 0x06064b50) throw new IOException("zip64: no directory");
                count = z.getLong(32); cdSize = z.getLong(40); cdOff = z.getLong(48);
            }
            if (count < 0 || count > 100000 || cdSize < 0 || cdSize > (64L << 20) || cdOff < 0 || cdOff + cdSize > zsize) throw new IOException("zip: bad directory");
            java.nio.ByteBuffer cd = readAt(ch, cdOff, (int) cdSize);
            java.util.List<ZipEnt> list = new java.util.ArrayList<>();
            int p = 0;
            for (long i = 0; i < count; i++) {
                if (p + 46 > cd.limit() || cd.getInt(p) != 0x02014b50) throw new IOException("zip: bad entry");
                ZipEnt en = new ZipEnt();
                en.flags = cd.getShort(p + 8) & 0xffff; en.method = cd.getShort(p + 10) & 0xffff;
                en.crc = cd.getInt(p + 16) & 0xffffffffL; en.comp = cd.getInt(p + 20) & 0xffffffffL; en.unc = cd.getInt(p + 24) & 0xffffffffL;
                int nLen = cd.getShort(p + 28) & 0xffff, xLen = cd.getShort(p + 30) & 0xffff, cLen = cd.getShort(p + 32) & 0xffff;
                en.local = cd.getInt(p + 42) & 0xffffffffL;
                if (p + 46 + nLen + xLen > cd.limit()) throw new IOException("zip: bad entry");
                byte[] nb = new byte[nLen];
                for (int k = 0; k < nLen; k++) nb[k] = cd.get(p + 46 + k);
                en.name = new String(nb, (en.flags & 0x800) != 0 ? StandardCharsets.UTF_8 : StandardCharsets.ISO_8859_1);
                for (int x = p + 46 + nLen, end = x + xLen; x + 4 <= end; ) {
                    int hid = cd.getShort(x) & 0xffff, hlen = cd.getShort(x + 2) & 0xffff;
                    if (hid == 0x0001) {
                        int z = x + 4;
                        if (en.unc == 0xffffffffL && z + 8 <= end) { en.unc = cd.getLong(z); z += 8; }
                        if (en.comp == 0xffffffffL && z + 8 <= end) { en.comp = cd.getLong(z); z += 8; }
                        if (en.local == 0xffffffffL && z + 8 <= end) { en.local = cd.getLong(z); }
                    }
                    x += 4 + hlen;
                }
                list.add(en);
                p += 46 + nLen + xLen + cLen;
            }
            long total = 0, done = 0, tick = android.os.SystemClock.uptimeMillis();
            for (ZipEnt en : list) total += Math.max(0L, en.unc);
            java.util.Map<String, String> dirs = new java.util.HashMap<>();
            dirs.put("", folderId);
            byte[] buf = new byte[256 * 1024];
            rommProgress(id, "extract", 0, total);
            for (ZipEnt en : list) {
                if (rommStop) throw new RommFail("cancelled");
                String rel = en.name.replace('\\', '/');
                if (rel.endsWith("/")) continue;
                java.util.List<String> parts = new java.util.ArrayList<>();
                for (String s : rel.split("/")) {
                    if (s.isEmpty() || s.equals(".")) continue;
                    if (s.equals("..")) throw new RommFail("zip-bad"); // (nothing outside the game's folder)
                    parts.add(safeName(s));
                }
                if (parts.isEmpty() || rel.matches("^[A-Za-z]:.*")) throw new RommFail("zip-bad");
                if ((en.flags & 1) != 0 || (en.method != 0 && en.method != 8)) throw new RommFail("zip-bad");
                if (en.local < 0 || en.comp < 0 || en.local + 30 > zsize) throw new IOException("zip: bad entry");
                // its folder inside the game's folder (made as needed)
                String parent = folderId, key = "";
                for (int k = 0; k < parts.size() - 1; k++) {
                    key = key.isEmpty() ? parts.get(k) : key + "/" + parts.get(k);
                    String known = dirs.get(key.toLowerCase(Locale.ROOT));
                    if (known == null) {
                        known = findChild(cr, tree, parent, parts.get(k), true);
                        if (known == null) {
                            Uri made = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, parent), DocumentsContract.Document.MIME_TYPE_DIR, parts.get(k));
                            if (made == null) throw new IOException("Couldn't make a folder");
                            known = DocumentsContract.getDocumentId(made);
                        }
                        dirs.put(key.toLowerCase(Locale.ROOT), known);
                    }
                    parent = known;
                }
                String fileName = parts.get(parts.size() - 1);
                String have = findChild(cr, tree, parent, fileName, false);
                Uri doc;
                if (have != null) doc = DocumentsContract.buildDocumentUriUsingTree(tree, have);
                else {
                    doc = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, parent), mimeOf(fileName), fileName);
                    if (doc == null) throw new IOException("Couldn't make " + fileName);
                }
                java.nio.ByteBuffer lh = readAt(ch, en.local, 30);
                if (lh.getInt(0) != 0x04034b50) throw new IOException("zip: bad local header");
                long data = en.local + 30 + (lh.getShort(26) & 0xffff) + (lh.getShort(28) & 0xffff);
                if (data + en.comp > zsize) throw new IOException("zip: entry past the end");
                JSONObject w = want.get(fileName.toLowerCase(Locale.ROOT));
                String wSha1 = w == null || w.isNull("sha1") ? "" : w.optString("sha1", "").trim(), wMd5 = w == null || w.isNull("md5") ? "" : w.optString("md5", "").trim(); // (a JSON null reads as "null" with optString)
                java.security.MessageDigest md = !wSha1.isEmpty() ? java.security.MessageDigest.getInstance("SHA-1") : !wMd5.isEmpty() ? java.security.MessageDigest.getInstance("MD5") : null;
                java.util.zip.CRC32 crc = new java.util.zip.CRC32();
                java.util.zip.Inflater inf = en.method == 8 ? new java.util.zip.Inflater(true) : null;
                long wrote = 0;
                try (OutputStream out = cr.openOutputStream(doc, "wt");
                     InputStream in = inf != null ? new java.util.zip.InflaterInputStream(new ChanIn(ch, data, data + en.comp, true), inf, 65536) : new ChanIn(ch, data, data + en.comp, false)) {
                    if (out == null) throw new IOException("The games folder can't be written to");
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (rommStop) throw new RommFail("cancelled");
                        out.write(buf, 0, n);
                        crc.update(buf, 0, n);
                        if (md != null) md.update(buf, 0, n);
                        wrote += n; done += n;
                        long now = android.os.SystemClock.uptimeMillis();
                        if (now - tick >= 250) { tick = now; rommProgress(id, "extract", done, total); }
                    }
                } finally { if (inf != null) inf.end(); }
                if (wrote != en.unc || crc.getValue() != en.crc) throw new RommFail("hash-mismatch");
                if (md != null && !hexOf(md.digest()).equalsIgnoreCase(!wSha1.isEmpty() ? wSha1 : wMd5)) throw new RommFail("hash-mismatch");
                long wantSize = w == null ? -1 : w.optLong("size", -1);
                if (wantSize >= 0 && wantSize != wrote) throw new RommFail("hash-mismatch");
            }
            rommProgress(id, "extract", total, total);
        }
    }

    // ---------- settings files (app-private storage) ----------
    private File fileFor(String name) { return new File(getContext().getFilesDir(), name.replaceAll("[^A-Za-z0-9._-]", "_")); }

    // (beta.12) the biggest settings file read back whole: LaunchBox's per-console indexes (lb-<platform>.json) run to tens
    // of MB, nothing else comes close. Over it (or out of memory reading it) the call is still answered, with an error
    private static final long READ_TEXT_MAX = 96L << 20;

    @PluginMethod
    public void readText(PluginCall call) {
        File f = fileFor(call.getString("name", "x"));
        JSObject r = new JSObject();
        if (!f.exists()) { r.put("text", null); call.resolve(r); return; }
        long len = f.length();
        if (len > READ_TEXT_MAX) { call.reject("Couldn't read " + f.getName() + ": it's too big (" + (len >> 20) + " MB)"); return; }
        String text;
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) len]; int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
            text = new String(b, 0, off, StandardCharsets.UTF_8);
        } catch (Throwable e) { call.reject(e instanceof OutOfMemoryError ? "Couldn't read " + f.getName() + ": not enough memory" : "Couldn't read " + f.getName()); return; }
        try { r.put("text", text); call.resolve(r); }
        catch (Throwable e) { call.reject("Couldn't read " + f.getName() + ": not enough memory"); } // (the answer is copied again on its way to the page)
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        File f = fileFor(call.getString("name", "x")), tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8)); out.getFD().sync();
        } catch (Exception e) { call.reject("Couldn't save " + f.getName()); return; }
        // write-then-rename: a crash mid-save never leaves half a file. (beta.8) If the rename over the old file fails, the
        // old one is moved aside first and only removed once the new one is in place; it's put back if that fails too, and
        // the save says so (it used to delete the old file first: two failed renames lost the settings)
        if (!tmp.renameTo(f)) {
            File old = new File(f.getPath() + ".old"); old.delete();
            boolean aside = !f.exists() || f.renameTo(old);
            if (aside && tmp.renameTo(f)) old.delete();
            else { if (aside && !f.exists() && old.exists()) old.renameTo(f); tmp.delete(); call.reject("Couldn't save " + f.getName()); return; }
        }
        call.resolve();
    }

    // ---------- the bottom screen (AYN Thor's second display: BottomScreen.java, page bottom.html) ----------
    private BottomScreen bottom;

    @Override
    public void load() {
        try { readingStore = new ReadingStore(getContext(), userAgent(), (e, o) -> notifyListeners(e, o)); } catch (RuntimeException e) { readingStore = null; } // (beta.10: reading() makes it later if this failed)
        try {
            bottom = new BottomScreen(getActivity(), new BottomScreen.Listener() {
                @Override
                public void onMessage(String json) { JSObject r = new JSObject(); r.put("msg", json); notifyListeners("bottom", r); }

                @Override
                public void onChange() { notifyListeners("bottomChange", new JSObject()); }
            });
        } catch (RuntimeException e) { bottom = null; } // no display service: simply no bottom screen
    }

    @PluginMethod
    public void bottomStatus(PluginCall call) { // { available, enabled, shown, width, height, density, name }
        if (bottom == null) { JSObject r = new JSObject(); r.put("available", false); r.put("enabled", false); r.put("shown", false); call.resolve(r); return; }
        call.resolve(bottom.status());
    }

    @PluginMethod
    public void bottomShow(PluginCall call) { if (bottom != null) bottom.setEnabled(true, call.getBoolean("remember", false)); call.resolve(); }

    @PluginMethod
    public void bottomHide(PluginCall call) { if (bottom != null) bottom.setEnabled(false, call.getBoolean("remember", false)); call.resolve(); }

    // ---------- the LaunchBox Games Database (0.3.3): LaunchBoxIndex does the work on its own thread ----------
    private volatile LaunchBoxIndex lbJob = null;

    @PluginMethod
    public void lbIndex(PluginCall call) { // { plats: [LaunchBox platform names] } → { ok, at, plats, counts, bytes }; "lbIndex" events { phase, pct, got, total }
        final JSArray arr = call.getArray("plats", new JSArray());
        final Set<String> plats = new HashSet<>();
        for (int k = 0; k < arr.length(); k++) { String p = arr.optString(k, ""); if (!p.isEmpty()) plats.add(p); }
        if (plats.isEmpty()) { call.reject("No consoles given"); return; }
        synchronized (this) { if (lbJob != null) { call.reject("busy"); return; } lbJob = new LaunchBoxIndex(); }
        final LaunchBoxIndex job = lbJob;
        final String ua = userAgent();
        Thread t = new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
            try {
                JSObject r = job.run(getContext().getFilesDir(), new File(getContext().getFilesDir(), "lb-work"), plats, ua, (phase, pct, got, total) -> {
                    JSObject e = new JSObject(); e.put("phase", phase); e.put("pct", pct); e.put("got", got); e.put("total", total);
                    notifyListeners("lbIndex", e);
                });
                call.resolve(r);
            } catch (Throwable e) {
                call.reject(job.cancelled() ? "cancelled" : ("LaunchBox: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage())));
            } finally { synchronized (this) { if (lbJob == job) lbJob = null; } }
        }, "boxshelf-lb");
        t.setDaemon(true);
        t.start();
    }

    @PluginMethod
    public void lbCancel(PluginCall call) { LaunchBoxIndex j = lbJob; if (j != null) j.cancel(); JSObject r = new JSObject(); r.put("ok", j != null); call.resolve(r); }

    @PluginMethod
    public void bottomPost(PluginCall call) { // { msg: {...} } → the bottom page's bsBottom.recv
        JSObject m = call.getObject("msg");
        if (m == null) { call.reject("No message"); return; }
        if (bottom != null) bottom.post(m.toString());
        call.resolve();
    }

    // ---------- (beta.12) the screen kept on: MainActivity decides, the page says how long ----------
    @PluginMethod
    public void keepAwake(PluginCall call) { // { minutes: Settings' "Dim the screen after", 0 = Boxshelf's default } → {}
        int m = call.getInt("minutes", 0);
        android.app.Activity a = getActivity();
        if (a instanceof MainActivity) ((MainActivity) a).setIdleMinutes(m);
        call.resolve();
    }

    private void holdAwake(boolean on) {
        try { android.app.Activity a = getActivity(); if (a instanceof MainActivity) ((MainActivity) a).holdAwake(on); }
        catch (RuntimeException ignored) {}
    }

    // ---------- (beta.12) while a game runs, Boxshelf costs nothing ----------
    // A game or app started from Boxshelf is in front (Boxshelf paused soon after launch() and not back yet): long
    // background work (a folder scan, RetroAchievements hashing, a video preview copy, LaunchBox's index) waits between
    // steps until Boxshelf is back, so the emulator has the CPU and storage to itself. The page's own work already stops
    // then (android-api.js quiet()), and MainActivity pauses the WebView and its timers. Downloads already on the network
    // are left to finish (background priority; a paused connection would only time out).
    private static final Object awayLock = new Object();
    private static volatile boolean gameOn = false;
    private volatile long launchedAt = 0;
    private volatile boolean keepBottom = false; // (beta.12) the last game launched doesn't use the bottom screen: Boxshelf's stays up
    private volatile boolean sideApp = false;    // (beta.13) the last app was opened on the bottom screen: the shelf on top stays live
    private volatile long sideAt = 0;
    // (beta.13) read by MainActivity when it pauses: Boxshelf's bottom page is still on show (a game or app on top that
    // doesn't use it), so the app-wide pauseTimers() would freeze it; the top page only stops drawing then
    static volatile boolean bottomStaysUp = false;
    // (beta.13) an app opened on the bottom screen: the top page isn't paused at all
    static volatile boolean topStaysUp = false;

    static void setGameOn(boolean on) { synchronized (awayLock) { gameOn = on; if (!on) awayLock.notifyAll(); } }

    /** Waits while a game started from Boxshelf is in front (wakes once a minute at most). Call between steps, off the main thread. */
    static void stepAside() {
        if (!gameOn) return;
        synchronized (awayLock) {
            while (gameOn) {
                try { awayLock.wait(60_000L); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
            }
        }
    }

    // ---------- coming back from a game ----------
    @Override
    protected void handleOnResume() {
        setGameOn(false);
        bottomStaysUp = false; topStaysUp = false;
        notifyListeners("resume", new JSObject());
        if (bottom != null) bottom.onResume();
    }

    @Override
    protected void handleOnPause() {
        // (beta.13) an app just opened on the bottom screen: the shelf on top is still what's on show, nothing pauses
        if (sideApp && bottom != null && bottom.isAway() && android.os.SystemClock.uptimeMillis() - sideAt < 10_000L) { topStaysUp = true; return; }
        topStaysUp = false;
        boolean game = android.os.SystemClock.uptimeMillis() - launchedAt < 10_000L; // (a launch() just now: the game is what took over)
        if (game) setGameOn(true);
        notifyListeners("pause", new JSObject());
        // the game gets the bottom screen when it uses one (DS / 3DS / Wii U emulators, bottom-screen mods); any other
        // game leaves Boxshelf's bottom screen up, showing the game being played (beta.12). Anything else that comes in
        // front (Android's settings, another app) gets it back as before
        boolean keep = game && keepBottom && bottom != null && !bottom.isAway();
        bottomStaysUp = keep;
        if (bottom != null && !keep) bottom.onPause();
    }

    @Override
    protected void handleOnDestroy() {
        if (bottom != null) bottom.release();
        setGameOn(false); // (nothing may wait for a Boxshelf that's gone)
        // a RomM download or a LaunchBox index still going stops (the part is kept for next time, as with B)
        boolean had; synchronized (rommLock) { had = rommBusy; if (had) rommStop = true; }
        final HttpURLConnection c = had ? rommConn : null;
        final LaunchBoxIndex j = lbJob;
        if (c != null || j != null) { // (closing a connection can touch the network: never on the main thread)
            Thread t = new Thread(() -> {
                if (c != null) { try { c.disconnect(); } catch (Exception ignored) {} }
                if (j != null) { try { j.cancel(); } catch (Exception ignored) {} }
            }, "boxshelf-stop");
            t.setDaemon(true);
            t.start();
        }
        // the plugin's own threads end with it: nothing runs on for a page that's gone (queued work is dropped, and a
        // fresh plugin, with threads of its own, comes with the next activity)
        for (ExecutorService x : new ExecutorService[] { io, net, hashPool, previewIo }) { try { x.shutdownNow(); } catch (RuntimeException ignored) {} }
    }
}
