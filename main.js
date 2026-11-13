// Boxshelf — TV-style launcher for emulators, Steam and media apps.
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, net, nativeImage, session, safeStorage, screen } = require('electron');
const crypto = require('crypto');
const { spawn } = require('child_process');
const url = require('url');
const fs = require('fs');
const path = require('path');

const paths = require('./main/paths');
const stremio = require('./main/stremio');
const commercials = require('./main/commercials');
// Portable: the app's own folder holds Dolphin\, Eden\, PPSPP\, ROMS\ and themes\.
// A portable exe unpacks itself into TEMP; PORTABLE_EXECUTABLE_DIR is where the real Boxshelf.exe sits
const linux = require('./main/linux'); // (Linux / Steam Deck only)
const steamdeck = require('./main/steamdeck'); // (beta.8) Steam Deck: where Boxshelf runs, Add Boxshelf to Steam
const linuxpad = require('./main/linuxpad'); // (beta.9) Linux: hold Select + Start to close the game
paths.setAppRoot(linux.isLinux ? linux.appRoot(app.isPackaged, __dirname) : app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)) : __dirname);

const config = require('./main/config');
const profiles = require('./main/profiles');
const online = require('./main/online');
const padbattery = require('./main/padbattery');
const { CONSOLES, APPS } = require('./main/systems');
const { detectAll, detectSystem, findSteam } = require('./main/detect');
const { scanSystem: scanFolders, scanSystemAsync: scanFoldersAsync, forget: scanForget, setLog: scanSetLog } = require('./main/scanner'); // (beta.9: scanForget clears the scanner's kept scans)
const arcadenames = require('./main/arcadenames');
// (beta.5) a game's own name (Details → Rename: cfg.games["<console>:<file>"].title) replaces the scanned one wherever main
// reads games: the shelf, box art and manual lookups, matching. fileTitle keeps the scanned one. Copies, never the
// scanner's own objects (a reset must bring the file's name back)
function scanSystem(def, sc, fresh) { return ownNames(def, scanFolders(def, sc, fresh)); } // fresh (beta.9): past the scanner's kept scan (main/scanner.js)
async function scanSystemAsync(def, sc, fresh) { return ownNames(def, await scanFoldersAsync(def, sc, fresh)); } // (beta.10) the same, without holding the main process up
function ownNames(def, gs) { const G = cfg && cfg.games; if (!G) return gs;
  return gs.map(g => { const o = G[def.id + ':' + g.file]; return o && o.title && o.title !== g.title ? { ...g, fileTitle: g.title, title: o.title } : g; });
}
const ownTitle = id => { const o = cfg && cfg.games && cfg.games[String(id)]; return o && o.title ? o.title : ''; }; // (PC games, by id)
const { scanSteam, steamRoot, isMainSteam } = require('./main/steam');
const steamart = require('./main/steamart');
const pcgames = require('./main/pcgames'); // (beta.4) Epic, Quiver Launcher and games added by hand
const pccovers = require('./main/pccovers'); // (beta.5) choosing a PC game's cover (SteamGridDB, Steam's own, your own)
const wiiumanual = require('./main/wiiumanual');
const manualcoll = require('./main/manualcoll');
const manualstudio = require('./main/manualstudio'); // Manual Studio: every manual for a game side by side, per-game locks, per-console language / region
const launcher = require('./main/launcher');
const rocket = require('./main/rocket'); // (beta.12) RocketLauncher, Windows
const romm = require('./main/romm'); // (beta.12) RomM, a self-hosted game library
const gamewatch = require('./main/gamewatch'); // (beta.12) Seamless play: Steam and store games watched
const seamless = require('./main/seamless'); // (beta.12) Seamless play: screen mode, Go to desktop, the launch timeline
const themes = require('./main/themes');
const customThemes = require('./main/customthemes'); // (1.76) picture themes the user makes: Custom themes\<name>\
const library = require('./main/library');
const archive = require('./main/archive');
const padwatch = require('./main/padwatch');
const homemenu = require('./main/homemenu');
const emucfg = require('./main/emucfg');
const emusetup = require('./main/emusetup'); // (beta.7) Set up for me
const racores = require('./main/racores'); // (beta.7) RetroArch cores downloaded, BIOS files checked
const previews = require('./main/previews'); // (beta.7) video previews
const ytclips = require('./main/ytclips'); // (beta.8) console trailers: YouTube trailers kept as short clips
const addgames = require('./main/addgames'); // (beta.7) Add games: several at once, a folder, Playnite
const x360 = require('./main/x360');
const n3ds = require('./main/n3ds');
const kyty = require('./main/kyty'); // PS5: Kyty's launch settings and the KytyJets preset
const nx2 = require('./main/nx2'); // Switch 2: unpacked games and their newest update
const wiimote = require('./main/wiimote'); // the Wii remote on the shelf (through a DolphinBar)
const padsense = require('./main/padsense'); // which real controllers are plugged in (button prompts)
const modelfind = require('./main/modelfind');
const icons = require('./main/icons');
const dolphin = require('./main/dolphin');
const covers = require('./main/covers');
const artstudio = require('./main/artstudio');
const manuals = require('./main/manuals');
const ra = require('./main/ra');
const companion = require('./main/companion');
const updates = require('./main/updates'); // (1.82) beta update notice: the public beta page's newest release

const WINDOWED = process.argv.includes('--windowed');
let win = null;

// ---------- play history (per game: launches, last played, time in game) ----------
let history = null, histFile = null, histOpen = null;
// a map with no prototype: an id like "__proto__" from the page is just a key here
function loadHistory() {
  if (history) return history; histFile = profiles.dataFile('history.json'); history = Object.create(null);
  let raw = null; try { raw = fs.readFileSync(histFile, 'utf8'); } catch {}
  if (raw != null) { try { const o = JSON.parse(raw); if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') history[k] = histEntry(v); }
    catch (e) { try { fs.copyFileSync(histFile, histFile + '.corrupt-' + Date.now()); } catch {} log('history unreadable, kept a copy', e.message); } }
  return history;
}
// temp + rename: a crash or power cut mid-write can't wipe the play history
function saveHistory() { try { fs.writeFileSync(histFile + '.tmp', JSON.stringify(history)); fs.renameSync(histFile + '.tmp', histFile); } catch (e) { log('history save', e.message); } }
// (beta.12) each game also keeps when it was first played (first, ms), its longest session (long, ms) and its last
// sessions (s: [start in seconds, length in seconds], newest last, at most HIST_SESSIONS), so Details' "Your play" can
// show first played, longest, this month and hours by week. Older files have none of these: they start from now.
const HIST_SESSIONS = 120;
function histEntry(v) {
  const e = { count: +v.count || 0, ms: +v.ms || 0, last: +v.last || 0 };
  if (+v.first > 0) e.first = +v.first; if (+v.long > 0) e.long = +v.long;
  if (Array.isArray(v.s)) { const s = v.s.filter(x => Array.isArray(x) && x[0] > 0 && x[1] >= 0).slice(-HIST_SESSIONS).map(x => [Math.round(+x[0]), Math.round(+x[1])]); if (s.length) e.s = s; }
  return e;
}
function historyStart(id) { id = String(id).slice(0, 1024); const h = loadHistory(); const e = h[id] = h[id] || { count: 0, ms: 0, last: 0 }; const prev = { count: e.count, last: e.last, first: e.first }; e.count++; e.last = Date.now(); if (!e.first) e.first = e.last; histOpen = { id, at: Date.now(), prev }; saveHistory(); }
// the launch never started (the exe couldn't be run): take the play back off, "last played" included
function historyUndo() { if (!histOpen) return; const { id, prev } = histOpen, h = loadHistory(), e = h[id]; histOpen = null; if (!e || !prev) return; if (!prev.count && !e.ms) delete h[id]; else { e.count = prev.count; e.last = prev.last; if (prev.first) e.first = prev.first; else delete e.first; } saveHistory(); }
function historyEnd() { if (!histOpen) return; const h = loadHistory(), e = h[histOpen.id]; if (e) { const len = Math.max(0, Date.now() - histOpen.at); e.ms += len; if (len > (e.long || 0)) e.long = len;
  const s = Array.isArray(e.s) ? e.s : (e.s = []); s.push([Math.round(histOpen.at / 1000), Math.round(len / 1000)]); if (s.length > HIST_SESSIONS) s.splice(0, s.length - HIST_SESSIONS); saveHistory(); } histOpen = null; }

// ---------- trailer window (YouTube embed from the LaunchBox link); Esc or the close button ends it ----------
let trailerWin = null, coverWindowed = false;
function openTrailer(url) {
  if (!/^https?:\/\//i.test(url)) return { external: true }; // only web links leave the app (the URL comes from database data)
  let id = null; try { const u = new URL(url); id = u.hostname.includes('youtu.be') ? u.pathname.slice(1) : u.searchParams.get('v'); } catch {}
  if (!id || !/^[\w-]{6,20}$/.test(id)) { shell.openExternal(url).catch(e => log('trailer open', e.message)); return { external: true }; }
  if (trailerWin) { try { trailerWin.close(); } catch {} }
  const b = win ? win.getBounds() : { x: 0, y: 0, width: 1280, height: 720 };
  trailerWin = new BrowserWindow({ parent: win || undefined, modal: false, fullscreen: !!(win && win.isFullScreen()), x: b.x, y: b.y, width: b.width, height: b.height, backgroundColor: '#000000', autoHideMenuBar: true, title: 'Trailer', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'trailer' } }); // its own session: YouTube's page can't reach Boxshelf's bsfile:// files
  trailerWin.setMenuBarVisibility(false);
  ytLoad(trailerWin.webContents, id, { muted: false }).catch(e => log('trailer load', e.message)); // (beta.7: inside a page of its own; a bare embed no longer plays)
  trailerWin.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && (input.key === 'Escape' || input.key === 'Backspace')) { e.preventDefault(); try { trailerWin.close(); } catch {} } });
  trailerWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  trailerWin.webContents.on('will-navigate', e => e.preventDefault()); // (the player lives in its frame; the page itself never goes anywhere)
  const tw = trailerWin; tw.on('closed', () => { if (trailerWin === tw) trailerWin = null; if (alive() && trailerWin === null) win.focus(); if (trailerWin === null && cfg && cfg.ui.homeMenu === false && !launcher.isRunning()) padwatch.stop(); });
  // the trailer has the focus, so the shelf's own pad reading can't see the controller: the XInput helper closes it on B,
  // Back or Guide (with the Home menu off no helper runs on the shelf, so start one just for the trailer)
  if (!padwatch.isRunning()) { if (cfg && cfg.ui.homeMenu !== false) watchShelf(); else padwatch.start('none', 900, () => {}, { home: true, backHome: false, cmdFile: path.join(app.getPath('temp'), `boxshelf-pad-${process.pid}.txt`), onHome: () => closeTrailer(), onButton: (n, d) => { if (d && (n === 'b' || n === 'back')) closeTrailer(); } }); }
  return { external: false };
}
// (beta.7) YouTube only plays an embed that sits in a web page (a bare embed shows "Video player configuration error"):
// this little page, loaded as data with an https address of its own (nothing is fetched from that address), holds
// YouTube's player. preview: no controls, muted unless asked, looping, cropped past YouTube's title bar, faded in once
// it really plays; the page's title tells main how it went (yt-playing / yt-error).
function ytPage(id, o = {}) {
  const pv = { autoplay: 1, mute: o.muted === false ? 0 : 1, controls: o.preview ? 0 : 1, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3, disablekb: o.preview ? 1 : 0, fs: o.preview ? 0 : 1, ...(o.preview ? { loop: 1, playlist: id } : {}) };
  const crop = o.preview ? 'top:-60px;height:calc(100% + 120px)' : 'top:0;height:100%';
  return `<!doctype html><meta charset="utf-8"><title>yt</title><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}#p{position:absolute;left:0;width:100%;${crop};border:0;opacity:0;transition:opacity .45s ease}#p.on{opacity:1}</style>
<div id="p"></div><script src="https://www.youtube.com/iframe_api"></script><script>
function onYouTubeIframeAPIReady(){new YT.Player('p',{videoId:${JSON.stringify(id)},host:'https://www.youtube-nocookie.com',playerVars:${JSON.stringify(pv)},
events:{onStateChange:function(e){if(e.data===1){document.getElementById('p').className='on';document.title='yt-playing'}},onError:function(){document.title='yt-error'}}})}
setTimeout(function(){if(document.title==='yt')document.title='yt-error'},15000);</script>`;
}
const ytLoad = (wc, id, o) => wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ytPage(id, o)), { baseURLForDataURL: 'https://player.boxshelf.localhost/' });
// the Details preview: YouTube's player in a view of its own laid over the panel's video box (the renderer sends where);
// its own session like the trailer window, never keeps the keyboard, hidden whenever Details isn't showing it
let ytView = null, ytWant = null;
function ytEnsure() {
  if (ytView && !ytView.webContents.isDestroyed()) return ytView;
  const { WebContentsView } = require('electron');
  ytView = new WebContentsView({ webPreferences: { partition: 'trailer', sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try { ytView.setBackgroundColor('#00000000'); } catch {}
  const wc = ytView.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', e => e.preventDefault());
  wc.on('focus', () => { if (alive()) win.webContents.focus(); }); // (a click on the video must not take the controller's keys away from the shelf)
  wc.on('page-title-updated', (e, t) => { if (alive() && (t === 'yt-playing' || t === 'yt-error')) win.webContents.send('preview:yt', { id: ytWant, state: t.slice(3) }); });
  ytView.setVisible(false);
  win.contentView.addChildView(ytView);
  return ytView;
}
function ytBounds(r) { const z = alive() ? win.webContents.getZoomFactor() || 1 : 1; return { x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.max(1, Math.round(r.w * z)), height: Math.max(1, Math.round(r.h * z)) }; }
function ytStop() { ytWant = null; if (ytView && !ytView.webContents.isDestroyed()) { ytView.setVisible(false); ytView.webContents.loadURL('about:blank').catch(() => {}); } }
// true when there was a trailer to close (Guide and B close it before doing anything else)
function closeTrailer() { if (!trailerWin || trailerWin.isDestroyed()) return false; try { trailerWin.close(); } catch {} return true; }
let cfg = null;

// Keep settings next to the app so the whole folder can move between PCs.
app.setPath('userData', path.join(paths.appRoot(), 'data'));
// (beta.9) crash details, kept on this PC only (never uploaded): a crash of the screen or a helper leaves a small dump in
// data\Crashpad (the newest 10 are kept), so a crash can be looked into afterwards
try { app.setPath('crashDumps', path.join(paths.appRoot(), 'data', 'Crashpad')); require('electron').crashReporter.start({ uploadToServer: false, compress: true }); } catch {}

// Write problems to data\\boxshelf.log so they can be looked at later.
const LOG = path.join(paths.appRoot(), 'data', 'boxshelf.log');
// the user's home folder is written as ~ (logs get shared for help); the log is rotated at 2 MB (one older copy kept)
const HOME_RE = (() => { const h = require('os').homedir(); return h ? new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null; })();
// (beta.10) everything that could name the person, in every form a path takes: the home folder with \ / \\ (JSON) %5C %2F
// separators (file:/// addresses, URL-encoded, a config written as JSON), the user name as a folder anywhere (a NAS share,
// /run/media/<user>, an 8.3 short name like JOHNSM~1), Steam account numbers (userdata\<id>), home-network addresses, and
// the phone names older builds wrote in phone-companion lines. Used for every log line and everything in a problem report
const privacyScrub = (() => {
  const os = require('os'), SEP = '(?:\\\\\\\\|\\\\|/|%5[cC]|%2[fF])+', esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '(?: |%20)');
  let user = ''; try { user = os.userInfo().username || ''; } catch {}
  const home = os.homedir() || '', rules = [];
  // (beta.10) each part also as a URL writes it (bsfile:// and file:/// addresses): "J%C3%BCrgen", the drive as "C%3A"
  const alt = s => { const v = new Set([s]); for (const f of [encodeURIComponent, encodeURI]) { try { v.add(f(s)); } catch {} } return v.size > 1 ? '(?:' + [...v].map(esc).join('|') + ')' : esc(s); };
  const parts = home.split(/[\\/]+/).filter(Boolean);
  if (parts.length) rules.push([new RegExp((home.startsWith('/') ? SEP : '') + parts.map(alt).join(SEP), 'gi'), '~']);
  const seg = n => new RegExp(`(?<=${SEP})${n}(?=${SEP}|["'\\s,;)]|$)`, 'gi');
  if (user.length >= 2) rules.push([seg(alt(user)), '<user>']);
  const short = user.replace(/[^A-Za-z0-9]/g, '').slice(0, 6); if (short.length >= 2 && (user.length > 8 || /\s/.test(user))) rules.push([seg(esc(short) + '~\\d'), '<user>']);
  rules.push([new RegExp(`(userdata${SEP})\\d{3,}`, 'gi'), '$1<id>']);
  rules.push([/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g, '<lan ip>']);
  rules.push([/(Phone companion:) paired .*$/gm, '$1 a phone paired'], [/(Phone companion:) (?!a phone )(.{1,80}?) (asked to quit|quit|started) /g, '$1 a phone $3 ']);
  return t => { t = String(t); for (const [re, to] of rules) t = t.replace(re, to); return t; };
})();
let logChecked = false, logWrites = 0;
function log(...a) {
  try {
    if (++logWrites % 500 === 0) logChecked = false; // a long session re-checks the size now and then (once at start grew without limit)
    if (!logChecked) { logChecked = true; fs.mkdirSync(path.dirname(LOG), { recursive: true }); try { if (fs.statSync(LOG).size > 2 * 1024 * 1024) fs.renameSync(LOG, LOG + '.old'); } catch {} }
    let line = privacyScrub(a.join(' '));
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}
process.on('uncaughtException', e => log('ERROR', e && e.stack || e));
process.on('unhandledRejection', e => log('ERROR', e && e.stack || e));
log('Starting Boxshelf', app.getVersion());
if (linux.isLinux) { steamdeck.init({ log }); linuxpad.init({ log }); const d = steamdeck.info(); log('Linux start:', d.deck ? 'Steam Deck' : 'PC', '| started by Steam:', d.steam, '| Game Mode:', d.gameMode, '| options:', d.flags.join(' ') || 'none'); }

// Only one Boxshelf at a time: a second launch brings the first one forward.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) { log('Already running, focusing the open window'); app.quit(); }
// (beta.9) which page crashed (the shelf, the Home menu overlay, a helper page), the shelf's last steps (app.js uiCrumb: what
// it was doing, with its memory use) and the PC's free memory: written to the log only when one crashes. The shelf reloads
// itself (createWindow), the Home menu closes itself (homemenu.js); each says so in the log
const crumbs = [];
ipcMain.on('ui:crumb', (e, t) => { crumbs.push(new Date().toISOString().slice(11, 19) + ' ' + String(t).slice(0, 160)); if (crumbs.length > 10) crumbs.shift(); });
app.on('render-process-gone', (e, wc, d) => {
  let what = ''; try { what = alive() && wc === win.webContents ? 'the shelf' : (path.basename(String(wc.getURL() || '').split(/[?#]/)[0]) || wc.getTitle() || 'a helper page'); } catch {}
  log('Screen process stopped:', d.reason, d.exitCode, '(' + (what || 'unknown page') + ')');
  if (d.reason === 'clean-exit') return;
  if (crumbs.length) log("Shelf's last steps:", crumbs.join(' | '));
  try { const m = process.getSystemMemoryInfo(); log('Memory then: free', Math.round(m.free / 1024), 'MB of', Math.round(m.total / 1024), 'MB'); } catch {}
});
// (the dumps: the newest 10 kept, a while after start)
setTimeout(() => { try { const root = app.getPath('crashDumps'), all = []; const walk = d => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, n.name); if (n.isDirectory()) walk(f); else if (/\.dmp$/i.test(n.name)) all.push({ f, t: fs.statSync(f).mtimeMs }); } };
  walk(root); all.sort((a, b) => b.t - a.t).slice(10).forEach(x => { try { fs.unlinkSync(x.f); } catch {} }); } catch {} }, 60000).unref();
app.on('child-process-gone', (e, d) => log('Helper process stopped:', d.type, d.reason, d.exitCode));
process.on('exit', code => log('Exiting with code', code));
app.on('second-instance', () => { if (alive() && launcher.isRunning()) { padwatch.front(runKind === 'app'); return; } /* (a media app: leave the pad-driven pointer where it is) */ /* a game is on: keep it in front, don't half-show the shelf */ if (alive()) { if (win.isMinimized()) win.restore(); stepIn(); try { win.setOpacity(1); } catch {} win.show(); win.focus(); } });

// bsfile:// serves local images and videos (covers, Steam art, logos, boot videos).
// Chromium's web cache: downloads are saved by Boxshelf itself, so a small cache is plenty (it had grown to 360 MB)
app.commandLine.appendSwitch('disk-cache-size', String(64 * 1024 * 1024));
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
// (beta.12) a laptop with two graphics chips (Intel + NVIDIA / AMD): Chromium drew on the Intel one, so Automatic picked Low
// and the shelf lost its effects. Boxshelf is a TV front end; it asks for the strong one, as games do
if (process.platform === 'win32') app.commandLine.appendSwitch('force_high_performance_gpu');
// Windows: Chromium stops drawing a window it believes is covered ("native window occlusion"). Boxshelf sits invisible
// under the fullscreen game while one runs, and after quick open/close runs Chromium sometimes missed it being uncovered
// again: the screen stayed black until a key was pressed. The shelf pauses its own loops while a game runs (run:aside:
// controller polling, the theme layer, music), so it doesn't need Chromium's guess.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
protocol.registerSchemesAsPrivileged([{ scheme: 'bsfile', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false } }]);

let rootsCache = null, rootsCfg = null;
function allowedRoots() {
  if (rootsCache && rootsCfg === cfg) return rootsCache; // rebuilt only when the settings object changes (config:save replaces it)
  rootsCfg = cfg; return (rootsCache = computeRoots());
}
function computeRoots() {
  if (!library._cacheSet) { library.setCacheRoot(path.join(app.getPath('userData'), 'library')); library._cacheSet = true; }
  const roots = [path.join(paths.appRoot(), 'themes'), path.join(paths.appRoot(), 'Custom themes'), path.join(app.getPath('userData'), 'custom-theme-cache'), icons.folder(), ...library.roots()].filter(Boolean); // (custom themes: their pictures, and the scaled copies of big ones)
  for (const s of Object.values(cfg.systems)) { roots.push(...(s.romDirs || [])); if (s.artDir) roots.push(paths.expand(s.artDir)); }
  roots.push(path.join(app.getPath('userData'), 'stremio-art'), path.join(app.getPath('userData'), 'commercials')); // the movie shelves' posters and art; the retro TV's ads
  roots.push(path.join(app.getPath('userData'), 'music')); // (beta.13) a menu music file of your own, copied here by music:pick
  if (paths.artLibrary()) roots.push(paths.artLibrary());
  if (artstudio.cacheDir()) roots.push(artstudio.cacheDir()); // Art Studio's downloaded candidates (the picker's thumbnails)
  if (manualstudio.cacheDir()) roots.push(manualstudio.cacheDir()); // Manual Studio's first-page previews and PDFs (also read by the PDF helper by address)
  if (cfg.steam.path) roots.push(path.join(steamMain || steamRoot(cfg.steam.path) || cfg.steam.path, 'appcache', 'librarycache'), path.join(app.getPath('userData'), 'steam-art')); // Steam's art cache only, not its config files
  roots.push(path.join(app.getPath('userData'), 'steam-art'), path.join(app.getPath('userData'), 'pc-covers'), path.join(app.getPath('userData'), 'pc-cover-cache')); // (beta.5) Epic games' Steam art (even without Steam), chosen PC covers and the cover picker's thumbnails
  return roots.filter(Boolean).map(r => { r = path.resolve(r).toLowerCase(); return r.endsWith(path.sep) ? r : r + path.sep; });
}

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif', mp4: 'video/mp4', m4v: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', mov: 'video/quicktime', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream', json: 'application/json', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac' }; // (the audio ones: a menu music file of your own)

// Covers are asked for at the size they're shown (bsfile://…?t=<height>): big scans (Steam's are 1200×1800) are
// scaled once, kept in data\thumbs and served from there, so the shelf never decodes or holds full-size images.
const THUMB_EXT = /\.(jpe?g|png)$/i; // (not webp: nativeImage can't decode it, so it was retried on every request)
let thumbQ = Promise.resolve(); const thumbTurn = () => { const p = thumbQ.then(() => new Promise(r => setTimeout(r, 4))); thumbQ = p; return p; };
let thumbTmpN = 0, thumbHelperFails = 0; const thumbOriginal = new Set(), thumbBusy = new Map(); // covers already small enough (no decode next time); decodes in flight
function thumbFor(file, stat, h) {
  const key = file + '|' + Math.floor(stat.mtimeMs) + '|' + stat.size + '|' + h;
  if (thumbOriginal.has(key)) return Promise.resolve(null);
  if (thumbBusy.has(key)) return thumbBusy.get(key); // two cases asking for the same cover share one decode
  const p = (async () => {
    const dir = path.join(app.getPath('userData'), 'thumbs');
    const out = path.join(dir, crypto.createHash('sha1').update(file + '|' + Math.floor(stat.mtimeMs) + '|' + h).digest('hex').slice(0, 24) + '.jpg');
    try { return await fs.promises.readFile(out); } catch {}
    // the size check reads only the file header; the decode + scale happens off this thread where Windows can (shell thumbnailer)
    const sz = await spreads.sizeOfAsync(file); /* (beta.10: async, art on a NAS) */ if (sz && sz[1] <= h * 1.2) { if (thumbOriginal.size > 5000) thumbOriginal.clear(); thumbOriginal.add(key); return null; } // already about the right size: serve the original
    let img = null;
    if (process.platform === 'win32' && sz) { try { img = await nativeImage.createThumbnailFromPath(file, { width: Math.max(1, Math.round(sz[0] * h / sz[1])), height: h }); if (img && img.getSize().height < h * .9) img = null; /* a cached smaller shell thumbnail would look blurry */ } catch { img = null; } }
    // (beta.10) no shell thumbnailer (Linux): scaled in a hidden image window of its own (img-tools 'shrink', its own queue,
    // never behind a manual), off this thread; the decode here below is only what's left when that fails
    let buf = null;
    if (process.platform !== 'win32' && sz && sz[1] > 0 && thumbHelperFails < 3) { const r = await helperJob('img-tools.html', async () => { const b = await fs.promises.readFile(file); return { data: new Uint8Array(b.buffer, b.byteOffset, b.length), mode: 'shrink', w: Math.max(1, Math.round(sz[0] * h / sz[1])) }; }, 15000, false, 'thumbs');
      const m = !r.err && /^data:image\/jpeg;base64,(.+)$/.exec(String((r.pages || [])[0] || '')); if (m) buf = Buffer.from(m[1], 'base64'); else if (r.err && /timed out|gone|did not load/.test(r.err) && ++thumbHelperFails >= 3) log('thumbnails: the image window keeps failing (' + r.err + '), scaling them here from now on'); }
    if (!buf) {
    if (!img || img.isEmpty()) await thumbTurn(); // decoding here blocks the app: one at a time, with a breath in between (a burst of new art used to hold it up)
    if (!img || img.isEmpty()) { img = nativeImage.createFromPath(file); const s2 = img.isEmpty() ? null : img.getSize(); if (!s2 || s2.height <= h * 1.2) { if (thumbOriginal.size > 5000) thumbOriginal.clear(); thumbOriginal.add(key); return null; } /* undecodable: serve the original from now on */ img = img.resize({ height: h, quality: 'best' }); }
    buf = img.toJPEG(90); }
    const tmp = out + '.' + process.pid + '-' + (++thumbTmpN) + '.tmp'; // temp + rename: a crash mid-write left a cut-off thumbnail that was served from then on
    fs.promises.mkdir(dir, { recursive: true }).then(() => fs.promises.writeFile(tmp, buf)).then(() => fs.promises.rename(tmp, out)).catch(() => { fs.promises.unlink(tmp).catch(() => {}); });
    return buf;
  })().finally(() => thumbBusy.delete(key));
  thumbBusy.set(key, p); return p;
}
async function serveFile(request) {
  try {
    const u = new URL(request.url);
    const file = path.resolve(decodeURIComponent(u.pathname.replace(/^\//, '')));
    const lower = file.toLowerCase();
    if (!allowedRoots().some(r => lower.startsWith(r)) && !previewOk.has(lower) && !lower.startsWith(path.join(app.getPath('userData'), 'previews').toLowerCase() + path.sep) && !profiles.isImage(file)) return new Response('Not allowed', { status: 403 }); // (beta.7: a preview video found for a game, the Steam clips) (profile pictures and banners are picked from anywhere, so they pass here too)
    const stat = await fs.promises.stat(file);
    const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=3600' };
    const th = +u.searchParams.get('t');
    if (th >= 64 && th <= 4096 && THUMB_EXT.test(file)) { const b = await thumbFor(file, stat, Math.round(th)).catch(() => null); if (b) return new Response(b, { headers: { ...cors, 'Content-Type': 'image/jpeg', 'Content-Length': String(b.length) } }); }
    // Small files (covers, manual pages, PDFs) go out as one buffer: no Node→web stream bridging, nothing to break
    // when the page drops a request half-way. Big files (videos, 3D models) stream through Chromium's own file loader.
    if (stat.size <= 24 * 1024 * 1024 && !request.headers.get('range')) {
      return new Response(await fs.promises.readFile(file), { headers: { ...cors, 'Content-Length': String(stat.size) } });
    }
    const headers = {}; const range = request.headers.get('range'); if (range) headers.Range = range;
    const r = await net.fetch(url.pathToFileURL(file).toString(), { headers, bypassCustomProtocolHandlers: true });
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; }); Object.assign(h, { 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    return new Response(r.body, { status: r.status, headers: h });
  } catch (e) {
    log('bsfile', e && e.message);
    return new Response('Not found', { status: 404 });
  }
}

const artVer = new Map(); // covers replaced this session (Box art): a new address, so nothing shows the old picture from memory
function fileUrl(p) { if (!p) return null; const v = artVer.get(path.resolve(p).toLowerCase()); return 'bsfile://local/' + encodeURIComponent(p) + (v ? '?v=' + v : ''); }
// A game file named by the screen must be one the scanner could have found: inside one of that system's games folders.
function gameFile(systemId, file) {
  const sc = cfg.systems[systemId]; if (!sc) throw new Error('Unknown system.');
  const f = path.resolve(String(file || '')).toLowerCase();
  if (!(sc.romDirs || []).some(d => paths.inDir(f, d)) && !paths.inDir(f, rommDir(systemId))) throw new Error('That game is not in a games folder.'); // (beta.12: or RomM's download folder for a console with none)
  return { sc, file: String(file) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 900, ...(seamless.savedBounds() || startBounds()), // Settings → Display: opens on the TV chosen there (the main display when it isn't connected); (beta.12) in Seamless play's Window mode, where it was left
    fullscreen: !WINDOWED && seamless.startFullscreen(cfg.ui.startFullscreen), // (beta.12: Seamless play's Screen mode when it's on)
    backgroundColor: '#07070c',
    show: false, // shown once its first frame (the logo) is painted: no empty or half-drawn window while it starts
    autoHideMenuBar: true,
    title: 'Boxshelf',
    icon: path.join(__dirname, 'renderer', 'app-icon.ico'), // (local) the window/taskbar icon; without it Electron's atom shows
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.once('ready-to-show', () => { if (alive() && !win.isVisible()) win.show(); });
  setTimeout(() => { if (alive() && !win.isVisible()) win.show(); }, 4000); // never left hidden
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // (beta.9) the screen busy for several seconds without answering (Windows' "not responding"), and when it's back
  try { let hungAt = 0; win.on('unresponsive', () => { hungAt = Date.now(); log('The screen stopped answering (last:', lastEvent + ')'); }); win.on('responsive', () => { if (hungAt) log('The screen answers again after', Date.now() - hungAt, 'ms'); hungAt = 0; }); } catch {}
  win.webContents.on('did-finish-load', () => { scaleSent = ''; applyScale(); });
  // (beta.9) right-click in a text box: Cut / Copy / Paste / Select all, as anywhere else on the PC (an Electron app has no
  // menu of its own, so pasting a key with the mouse did nothing). Only on boxes you can type in; the rest of the screen is unchanged.
  win.webContents.on('context-menu', (e, p) => { if (!p || !p.isEditable) return;
    try { const { Menu } = require('electron'), f = p.editFlags || {};
      Menu.buildFromTemplate([{ role: 'cut', enabled: !!f.canCut }, { role: 'copy', enabled: !!f.canCopy }, { role: 'paste', enabled: !!f.canPaste }, { type: 'separator' }, { role: 'selectAll', enabled: !!f.canSelectAll }]).popup({ window: win }); } catch {} });
  try { win.on('resize', applyScaleSoon); win.on('moved', applyScaleSoon); } catch {} // another screen, fullscreen on/off, a resized window
  try { screen.on('display-metrics-changed', applyScaleSoon); } catch {}
  win.webContents.on('will-navigate', e => e.preventDefault());
  // the shelf's page crashed (out of memory, a graphics driver reset): load it again rather than leave a dead screen on the
  // TV. Not while a game runs (it comes back once the game ends), and at most 3 times in 2 minutes (a page that crashes
  // straight away again shouldn't loop)
  const crashes = []; win.webContents.on('render-process-gone', (e, d) => {
    if (!d || d.reason === 'clean-exit') return; log('Screen process gone:', d.reason, 'code', d.exitCode); /* (beta.9: why, not only that it reloaded) */ const now = Date.now(); while (crashes.length && now - crashes[0] > 120000) crashes.shift(); crashes.push(now);
    if (crashes.length > 3) { log('Screen crashed again: not reloading'); return; }
    const w0 = win, again = () => { if (win !== w0 || !alive()) return; if (launcher.isRunning()) { setTimeout(again, 2000); return; } log('Reloading the screen after a crash'); win.reload(); };
    setTimeout(again, 600);
  });
  win.on('closed', () => { log('Quit: the Boxshelf window was closed'); win = null; app.quit(); }); // hidden helper windows (Home overlay, manual renderer) must not keep Boxshelf alive
  // (beta.6) the taskbar hidden for a game comes back the moment you leave the fullscreen shelf: another app, the Start
  // menu, minimized, windowed (see taskbarBack)
  for (const ev of ['blur', 'leave-full-screen', 'minimize', 'hide']) win.on(ev, () => taskbarLeave(ev));
  seamless.trackWindow(win); // (beta.12) Window mode remembers the window's place and size
}
// (a blur that only went to one of Boxshelf's own windows, a trailer, isn't leaving: that window is watched instead)
function taskbarLeave(ev) {
  if (!tbHidden || launcher.isRunning() || launching) return;
  if (ev !== 'blur') { taskbarShow('left the shelf: ' + ev); return; }
  setTimeout(() => {
    if (!tbHidden || launcher.isRunning() || launching) return;
    const f = BrowserWindow.getFocusedWindow();
    if (f && !f.isDestroyed()) { if (f !== win && !f.bsTbWatch) { f.bsTbWatch = true; f.on('blur', () => taskbarLeave('blur')); } return; }
    taskbarShow('left the shelf: blur');
  }, 60);
}

const alive = () => win && !win.isDestroyed(); // the window can be gone already when Boxshelf quits while a game still runs
// Quitting a game: put Boxshelf's (black) screen in front *before* the emulator closes, so the Windows desktop never
// shows in between; the shelf then fades in as usual once the emulator has exited (onExit → bringBack).
function coverForQuit() {
  markEvent('coverForQuit'); quitAt = Date.now(); quitSeq++; seamless.mark('quit: cover up');
  if (!alive()) return;
  // quit while the loading screen was still up: its pending lift must not step Boxshelf aside in the middle of the quit
  if (coverTimer) { clearInterval(coverTimer.keep); clearTimeout(coverTimer); coverTimer = null; }
  try { win.webContents.send('run:quitting'); } catch {} // the shelf gets ready under a black cover while the game closes
  try {
    if (win.isMinimized()) win.restore();
    // Boxshelf never left the screen (see lift): it only turns opaque and comes to the front. No show() — Windows
    // animates a window that is shown, and the closing game's windows showed through that animation
    try { win.setOpacity(1); } catch {}
    win.setAlwaysOnTop(true, 'screen-saver'); if (!win.isVisible()) win.showInactive(); win.moveTop();
    padwatch.cover(true); // (beta.6) the helper keeps the cover over the closing game's windows too, every ~40 ms
    // A closing emulator can still pop windows up (it leaves fullscreen, shows its main window or a dialog): keep the
    // cover on top until it has really exited (onExit), like the start-up cover does
    clearQuitCover();
    const started = Date.now();
    quitCover = setInterval(() => {
      try {
        // (1.82) a Quit that came after the game had already exited: nothing will call onExit now, so let go of
        // always-on-top here too, or file pickers and browser windows open behind Boxshelf until the next launch
        if (!alive() || !launcher.isRunning()) { clearQuitCover(); if (alive() && !launcher.isRunning()) { try { win.setAlwaysOnTop(false); } catch {} } return; }
        if (Date.now() - started > 11000) { // still running well past the force-close: give the game the screen back, controller included
          clearQuitCover(); log('Quit: the game is still running, returning to it'); pendingPower = null; quitAt = 0; /* its exit later isn't "N ms after Quit" */
          win.setAlwaysOnTop(false); padwatch.cover(false); stepAside(); if (!padwatch.isRunning() && lastPadOpts) watchPad(lastPadOpts); padwatch.front(); setTimeout(() => { if (launcher.isRunning()) padwatch.front(); }, 1500); return; /* the helper may have just restarted */
        }
        win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); coverFullSize();
      } catch {}
    }, 100);
  } catch {}
}
let quitCover = null, quitAt = 0, quitSeq = 0; // quitSeq: a timer set before a Quit must not step Boxshelf aside during it
// (beta.6) Chromium shrinks a fullscreen window that isn't the active one by a pixel (2560x1439 on a 1440p screen, while
// the emulator has the focus): the game showed through that row as a sliver at the bottom of the black cover, starting
// and quitting. While the cover is up it's stretched back (only that 1-2 px shrink; the helper does it too, every pass).
function coverFullSize() {
  try { if (!alive() || !win.isFullScreen()) return; const b = win.getBounds(), d = screen.getDisplayMatching(b).bounds;
    if ((b.width !== d.width || b.height !== d.height || b.x !== d.x || b.y !== d.y) && Math.abs(b.width - d.width) <= 2 && Math.abs(b.height - d.height) <= 2) win.setBounds(d); } catch {}
}
function clearQuitCover() { if (quitCover) { clearInterval(quitCover); quitCover = null; } goneCover = false; }
// (beta.6) Nothing but Boxshelf and the game on screen: the taskbar is hidden from just before an emulator starts until
// the shelf is back (an emulator's window that wasn't fullscreen yet, or any more, made Windows raise it over the black
// cover for a moment, starting and closing). A file marks it hidden: a watchdog process (padwatch.taskbarGuard) puts it
// back if Boxshelf crashes or is ended, and the next start does too. Settings → Display → Screen & motion turns it off.
let tbHidden = false;
const tbMark = () => path.join(app.getPath('userData'), 'taskbar-hidden');
const tbWanted = () => process.platform === 'win32' && cfg.ui.hideTaskbar !== false && !seamless.windowMode(); // (beta.12: never in Seamless play's Window mode)
async function taskbarHide() {
  if (!tbWanted() || tbHidden) return;
  tbHidden = true; try { fs.writeFileSync(tbMark(), String(Date.now())); padwatch.taskbarGuard(process.pid, tbMark()); } catch {} // (the guard: back even if Boxshelf crashes)
  const t0 = Date.now(); const ok = await padwatch.taskbar(false); log('Taskbar hidden for the game', ok ? `(${Date.now() - t0} ms)` : '(no answer)');
}
// Back on the shelf after a game. Fullscreen and in front, Boxshelf would have the taskbar hidden by Windows anyway, so
// it stays hidden until you leave the shelf (the window's blur / leave-full-screen / minimize / hide, set up with the
// window). Showing it here instead left it over the fullscreen shelf until a mouse click: Windows only re-checks for a
// fullscreen app when the active window changes, and Boxshelf already was the active one. A windowed or unfocused shelf
// gets it back at once.
function taskbarBack(focused) {
  if (!tbHidden || launcher.isRunning() || launching) return;
  if (focused && alive() && win.isFullScreen() && win.isVisible() && !win.isMinimized()) { log('Taskbar stays hidden while the fullscreen shelf is in front'); return; }
  taskbarShow('back on the shelf');
}
function taskbarShow(why) {
  if (!tbHidden) return; tbHidden = false; try { fs.unlinkSync(tbMark()); } catch {}
  padwatch.taskbar(true).then(() => log('Taskbar back' + (why ? ' (' + why + ')' : '')));
  // (once more a moment later: the watchdog may have been in the middle of a pass when the marker went)
  setTimeout(() => { if (!tbHidden) padwatch.taskbar(true); }, 400);
}
// (beta.6) the game's window closed while the emulator is still running (quit from the emulator's own menu, or Esc): the
// black cover goes up at once, like a Quit from the Home menu; a window that comes back (the emulator only rebuilt it)
// gets the screen back
let goneCover = false;
function onGameWindow(back) {
  if (!back) {
    if (!launcher.isRunning() || quitCover || coverTimer || homemenu.isOpen()) return;
    log('Game window closed, the emulator still running: covering the screen until it exits'); coverForQuit(); goneCover = true; seamless.windowGone(); return; /* (beta.12: a watched game's end is looked for at once) */
  }
  if (!goneCover || !quitCover || !launcher.isRunning()) return;
  log('Game window back: stepping aside again'); clearQuitCover(); quitAt = 0;
  try { win.setAlwaysOnTop(false); } catch {} padwatch.cover(false); stepAside(); padwatch.front();
}
// While a game runs Boxshelf stays on screen, behind it, fully transparent: it can't be clicked or activated (so it
// never takes the focus from the game) and the page is told to stop drawing. Hiding the window instead meant Windows
// played its show animation when we came back, and the closing game's windows were visible through it.
function stepAside() {
  // (Linux: a see-through window isn't possible there, so Boxshelf hides while the game runs; bringBack shows it again)
  if (linux.isLinux) { try { win.webContents.send('run:aside', true); } catch {} try { win.hide(); } catch {} return; }
  try { win.setOpacity(0); } catch {}
  try { win.setIgnoreMouseEvents(true); } catch {}
  try { win.setFocusable(false); } catch {}
  try { win.webContents.send('run:aside', true); } catch {}
}
function stepIn() {
  try { win.setFocusable(true); } catch {}
  try { win.setIgnoreMouseEvents(false); } catch {}
  try { win.webContents.send('run:aside', false); } catch {}
}
// the game's window is fullscreen: lift the cover a beat later (its first frame), never sooner than 0.8 s in
function liftCover() {
  const t = coverTimer; if (!t || !t.lift) return;
  seamless.mark('window up');
  const wait = Math.max(350, (t.minMs || 800) - (Date.now() - t.at));
  setTimeout(() => { if (coverTimer === t) { log('game window ready: lifting the loading screen'); t.lift(); } }, wait);
}
let backKeep = null;
function bringBack() {
  markEvent('bringBack'); backAt = Date.now();
  if (!alive()) return;
  if (win.isMinimized()) win.restore();
  stepIn();
  if (!win.isVisible()) win.show();
  try { win.setOpacity(1); } catch {}
  win.setAlwaysOnTop(true);
  win.focus();
  // Windows often won't let a background app take the focus back: ask the controller helper to hand it over
  try { const b = win.getNativeWindowHandle(); padwatch.focusWindow(b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0))); } catch (e) { log('focus handoff', e.message); }
  // (beta.6) Stay on top until Windows has really given Boxshelf the focus (the helper's handoff comes when the shelf's
  // helper starts, ~1.5 s), at most 5 s. Letting go after 0.4 s left a gap: the closing game's focus went to the next
  // window in line (Discord, Explorer…), which then came up over the whole shelf. The taskbar returns after that.
  clearInterval(backKeep); const t0 = Date.now();
  backKeep = setInterval(() => {
    if (!alive() || launcher.isRunning()) { clearInterval(backKeep); backKeep = null; return; }
    const el = Date.now() - t0, focused = win.isFocused();
    if ((focused && el > 400) || el > 5000) {
      clearInterval(backKeep); backKeep = null; seamless.mark('shelf back'); try { win.setAlwaysOnTop(false); win.moveTop(); } catch {}
      if (!focused) log('Back on the shelf without the focus (Windows refused it)');
      taskbarBack(focused);
      return; }
    try { if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true); win.moveTop(); } catch {}
  }, 100);
  // (and ask for a fresh frame now and a moment later, in case the window still isn't being drawn)
  const paint = () => { try { if (alive() && !launcher.isRunning()) win.webContents.invalidate(); } catch {} };
  paint(); setTimeout(paint, 300); setTimeout(paint, 1200);
}

// While an emulator boots, keep Boxshelf's black loading screen above it so its
// windowed start-up never shows. Then step aside so the game is in front.
let coverTimer = null;
function coverWhileStarting(seconds) {
  if (coverTimer && coverTimer.keep) clearInterval(coverTimer.keep);
  clearTimeout(coverTimer);
  if (!win || !(seconds > 0)) return 0;
  seamless.mark('cover up');
  // In a window, the emulator's windows show around our edges: go fullscreen for the cover, then back
  const wasWindowed = !win.isFullScreen();
  if (wasWindowed) { try { win.setFullScreen(true); } catch {} }
  coverWindowed = wasWindowed;
  win.setAlwaysOnTop(true, 'screen-saver');
  padwatch.cover(true); // (beta.6) and the helper puts it back over any of the game's windows within ~40 ms
  // Some emulators (Eden) create their window in two steps and can pop over us; keep re-asserting until the cover ends.
  const t0 = Date.now(); let lastTop = 0;
  const keep = setInterval(() => { try { if (!alive() || !coverTimer) return; coverFullSize(); const now = Date.now(); if (now - t0 > 2500 && now - lastTop < 1000) return; lastTop = now; if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); homemenu.raise(); } catch {} }, 100);
  const lift = () => {
    if (!coverTimer) return; clearTimeout(coverTimer);
    coverTimer = null; clearInterval(keep);
    if (!alive()) return;
    // (a windowed Boxshelf stays fullscreen while hidden: switching back to a window here showed it popping up as a
    //  window for a moment before it hid. It goes back to a window when the game ends: see onExit)
    if (!launcher.isRunning()) { if (wasWindowed) { try { win.setFullScreen(false); } catch {} coverWindowed = false; } return; }
    win.webContents.send('run:ready'); // the loading screen fades to black (.28 s), then Boxshelf steps aside
    const qs = quitSeq; // Quit pressed in these 300 ms: the quit cover must stay opaque (stepAside made it see-through)
    setTimeout(() => {
    if (!alive() || !launcher.isRunning() || qs !== quitSeq) return;
    padwatch.cover(false); // (first: the helper must not pull the cover back over the game)
    win.setAlwaysOnTop(false);
    // the game straight to the front (no win.blur(): Windows hands a blurred window's focus to the next one in line,
    // usually the taskbar, which then showed over the fullscreen game until a click). The helper keeps the game in front
    // for a few seconds if the taskbar or desktop still ends up active; again a moment later in case its game window
    // appeared after the first one
    padwatch.front();
    // step aside without the minimize animation (the game is already fullscreen behind us); bringBack shows us again
    stepAside(); seamless.mark('cover down');
    homemenu.ready(); setTimeout(() => { if (launcher.isRunning()) { padwatch.front(); homemenu.raise(); } }, 1500);
    }, 300);
  };
  // lifts when the game's window is up and fullscreen (padwatch GAMEFS → liftCover), or after `seconds` at the latest
  coverTimer = setTimeout(lift, seconds * 1000);
  coverTimer.keep = keep; coverTimer.lift = lift; coverTimer.at = Date.now();
  return seconds;
}

function watchPad(opts) {
  opts = opts || {}; lastPadOpts = opts;
  // (the helper keeps Boxshelf's see-through window below the running game: above it, the taskbar showed over the game)
  try { if (alive()) { const b = win.getNativeWindowHandle(); padwatch.setSelf(b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0))); } } catch {}
  const home = cfg.ui.homeMenu !== false && !!opts.home;
  if (cfg.ui.quitCombo === false && !(opts.mouse || opts.fullscreenKey || home)) return;
  // with the quit combo turned off, use a mask no pad can press so only the other duties remain
  const combo = cfg.ui.quitCombo === false ? null : (cfg.ui.quitComboKeys || 'l3+r3');
  padwatch.start(combo || 'none', 900, () => { log('Quit combo: closing', launcher.isRunning() ? 'emulator' : 'nothing'); if (launcher.isRunning()) coverForQuit(); closeGame(); },
    { ...opts, home, nin: true, taskbarHidden: tbHidden, onWindow: opts.appPid ? onGameWindow : undefined, cmdFile: path.join(app.getPath('temp'), `boxshelf-pad-${process.pid}.txt`), onHome: kind => { homemenu.setMeta({ glyphs: kind || shelfGlyphs }); /* the menu shows the buttons of the pad that opened it (an XInput pad: the shelf's last prompts) */ Promise.resolve(homemenu.open()).catch(e => log('home menu', e && e.message)); }, onButton: (b, d) => homemenu.button(b, d), isMenuOpen: () => homemenu.isOpen(), onFullscreen: opts.appPid ? liftCover : undefined,
      keepUp: () => launcher.isRunning() && !quitCover }); // (beta.10: a helper that dies mid-game is started again, not during a Quit)
}
// (beta.12, Linux) a Flatpak emulator that closed at once on a game outside your home folder (an SD card, a USB drive):
// Flatpak keeps its apps out of those until allowed. The one line that allows it, or '' when that isn't the case
function flatpakFix(l) {
  if (!linux.isLinux || !l || !l.exe || !l.rom) return '';
  const m = /\/flatpak\/exports\/bin\/([\w.-]+)$/.exec(l.exe); if (!m) return '';
  const home = require('os').homedir(); let rom = path.resolve(l.rom); try { rom = fs.realpathSync(rom); } catch {} // (EmuDeck's ~/Emulation/roms is often a link to the SD card)
  if (rom.startsWith(home + '/')) return '';
  const top = (/^(\/run\/media\/[^/]+\/[^/]+|\/run\/media\/[^/]+|\/media\/[^/]+\/[^/]+|\/mnt\/[^/]+)/.exec(rom) || [])[1] || path.dirname(rom);
  return `flatpak override --user --filesystem='${top.replace(/'/g, "'\\''")}' ${m[1]}`; // (quoted: a drive's name can have spaces)
}
function onExit(info) {
  linuxpad.end(); // (beta.9: the Linux pad watcher only runs during a game)
  markEvent('game exited'); seamless.mark('game ended'); clearQuitCover(); wiimote.resume(); // (the Wii remote back to the shelf, after Dolphin had it)
  // (1.82) a game's emulator that closed by itself within 5 s (a missing BIOS, keys or firmware, bad launch options) wasn't a
  // play: the shelf says which emulator closed instead of quietly coming back, and the history isn't touched
  const quick = !!(info && !info.failedToStart && info.code !== -1 && !quitAt && runKind === 'game' && lastLaunch && info.ms < 5000);
  if (quick) { const def = CONSOLES.find(c => c.id === lastLaunch.systemId); info = { ...info, quick: true, emulatorName: (def && def.emulatorName) || 'The emulator', flatpakFix: flatpakFix(lastLaunch) }; log('Emulator closed right away:', info.emulatorName, 'code', info.code, info.ms + ' ms'); }
  if (quitAt) { log('game closed', Date.now() - quitAt, 'ms after Quit' + (Date.now() - quitAt > 2400 ? ' (had to be forced)' : '')); quitAt = 0; }
  padwatch.stop(); homemenu.end(); if (info && (info.failedToStart || info.quick)) historyUndo(); else historyEnd();
  setOnlinePresence(''); // presencia reseteada y horas sincronizadas
  if (coverTimer && coverTimer.keep) clearInterval(coverTimer.keep);
  // the emulator died inside the cover window: undo the temporary fullscreen too
  if (coverWindowed && alive()) { try { win.setFullScreen(false); } catch {} coverWindowed = false; }
  // Achievements earned during this session (RA needs a few seconds to register the last unlock)
  if (lastLaunch && ra.enabled() && ra.CONSOLE_ID[lastLaunch.systemId]) {
    const since = (Date.now() - lastLaunch.at) / 60000 + 2;
    setTimeout(() => ra.recent(since).then(list => { if (list.length && alive()) win.webContents.send('ra:unlocks', list); }).catch(e => log('RA recent', e.message)), 4000);
  }
  lastLaunch = null;
  clearTimeout(coverTimer); coverTimer = null;
  bringBack(); if (cfg.ui.homeMenu === false) focusOnlyHelper();
  // (beta.6) the taskbar comes back once the shelf has the focus again (bringBack)
  if (alive()) win.webContents.send('run:exited', info);
  if (pendingPower) { const p = pendingPower; pendingPower = null; if (Date.now() - p.at < 20000) { setTimeout(() => powerAction(p.kind), 800); setTimeout(() => { if (alive() && !launcher.isRunning()) watchShelf(); }, 15000); return; } /* a cancelled shutdown still needs Guide back */ log('Power: dropped a stale', p.kind); } // a game that took ages to close: don't shut the PC down out of the blue later
  setTimeout(watchShelf, 1500);
}
// ---------- (beta.12) Seamless play: what main/seamless.js needs from here ----------
// the latest the loading cover waits, from now (a watched game's process has just appeared: its window gets this long)
function coverDeadline(seconds) {
  const t = coverTimer; if (!t || !t.lift || !(seconds > 0)) return;
  clearTimeout(t); const n = setTimeout(t.lift, seconds * 1000);
  Object.assign(n, { keep: t.keep, lift: t.lift, at: t.at, minMs: t.minMs }); coverTimer = n;
}
// a watched game's playtime (its launch was already counted by history:touch: only the time is added, at onExit)
function historyTrack(id) { histOpen = { id: String(id).slice(0, 1024), at: Date.now(), prev: null }; }
// a Steam / store game that never showed up within 90 s: today's behaviour, the shelf with "Running through Steam"
function watchGaveUp() {
  clearQuitCover(); padwatch.stop(); homemenu.end(); linuxpad.end(); // (beta.12: the Linux pad watcher a watched Steam game started)
  if (coverTimer) { clearInterval(coverTimer.keep); clearTimeout(coverTimer); coverTimer = null; }
  if (coverWindowed && alive()) { try { win.setFullScreen(false); } catch {} coverWindowed = false; }
  padwatch.cover(false); bringBack();
  if (alive()) win.webContents.send('run:watchGaveUp');
  setTimeout(() => { if (!launcher.isRunning()) watchShelf(); }, 1500);
}

// Freeze watch: if the main process is blocked for more than a quarter second, log it with what was going on
// (a stall here freezes the shelf's input and window handling too)
let lagAt = Date.now(), lastEvent = 'start';
const markEvent = e => { lastEvent = e + ' @' + new Date().toISOString().slice(11, 19); };
setInterval(() => { const now = Date.now(), lag = now - lagAt - 100; lagAt = now; if (lag > 250) log('freeze watch: main process blocked', lag, 'ms (last:', lastEvent + ')'); }, 100).unref();
// (beta.9) what the freeze watch can't see: a helper process of the screen that died (the graphics process above all: a
// black flash or a stall on screen), and memory use every 15 minutes (a slow leak shows long before it ends in a crash)
app.on('child-process-gone', (e, d) => { if (!d || d.reason === 'clean-exit') return; log('Helper process gone:', d.type, d.reason, 'code', d.exitCode, d.serviceName || d.name || '');
  // (beta.10) the graphics process comes back on its own, but the shelf could stay black until it next moved: once it's back,
  // a fresh frame, and the screen puts its cases up again (renderer/app.js gpuBack)
  if (d.type === 'GPU') for (const ms of [1500, 4000]) setTimeout(() => { try { if (alive() && !launcher.isRunning()) { win.webContents.invalidate(); win.webContents.send('gpu:back'); } } catch {} }, ms); });
setInterval(() => { try { let all = 0, gpu = 0, screen = 0; for (const p of app.getAppMetrics()) { const k = ((p.memory && p.memory.workingSetSize) || 0) / 1024; all += k; if (p.type === 'GPU') gpu += k; else if (p.type === 'Tab') screen += k; }
  log('Memory:', Math.round(all), 'MB in all (screens', Math.round(screen), 'MB, graphics', Math.round(gpu), 'MB, main', Math.round(process.memoryUsage().rss / 1048576), 'MB)'); } catch {} }, 15 * 60e3).unref();
// ---------- library ----------
// An icon not extracted yet holds the scan up for at most 2.5 s; when it arrives later, the shelf rescans (cached then)
let iconLateT = null;
function iconQuick(exe) {
  const p = icons.iconFor(emuPath(exe)); let late = false, t;
  return Promise.race([p.then(v => { clearTimeout(t); return v; }), new Promise(r => { t = setTimeout(() => { late = true; r(null); }, 2500); })])
    .finally(() => { if (late) p.then(v => { if (v && !iconLateT) iconLateT = setTimeout(() => { iconLateT = null; if (alive()) win.webContents.send('library:changed', { icons: 1 }); }, 1000); }).catch(() => {}); });
}
// (beta.7) store games: real store titles, so their covers come from the Steam app with the same name (not Quiver's or
// hand-added programs: those often share a name with an unrelated game)
const STORE_SRC = new Set(['epic', 'gog', 'ubisoft', 'ea', 'xbox']);
async function buildLibrary() {
  const shelves = [];
  // (beta.12) RomM: the saved copy of its library for this build, and one background sync a little after the first
  if (rommOn() && !rommLib) await rommLoad();
  if (rommOn() && !rommSyncedOnce) { rommSyncedOnce = true; rommSync(20000); }
  for (const def of CONSOLES) {
    const sc = cfg.systems[def.id];
    if (!sc || !sc.enabled) continue;
    await new Promise(r => setImmediate(r)); // let covers and IPC through between shelves: a big folder scan shouldn't freeze everything
    if (!sc.emulator && !(sc.romDirs || []).length) continue;
    markEvent('scan ' + def.id); // (beta.9) the freeze watch names the console being scanned (these showed up as "start")
    if (def.id === 'x360') { let t; try { await Promise.race([x360.ensureDb(), new Promise(r => { t = setTimeout(r, 15000); })]); } catch {} finally { clearTimeout(t); } }
    // (beta.10) the folders read with fs.promises (a games folder on a NAS held the whole app up: no pictures, no input),
    // and the per-game details with a breath every 25 ms (thousands of games' info lookups in one go stalled it too)
    const games = []; let t0 = Date.now();
    for (const g of await scanSystemAsync(def, sc)) { if (Date.now() - t0 > 25) { await new Promise(r => setImmediate(r)); t0 = Date.now(); }
      games.push({ ...g, info: covers.gameInfo(def.id, g.title), manualMiss: manualMiss(def.id, g), art: { front: fileUrl(g.art.front), hero: fileUrl(g.art.hero), back: fileUrl(g.art.back), madeBack: g.art.madeBack || undefined, spine: fileUrl(g.art.spine), madeSpine: g.art.madeSpine || undefined, disc: fileUrl(g.art.disc), manual: def.id === 'wiiu' ? await withCoverAsync(def.id, g, (g.art.manual || []).map(fileUrl)) /* (beta.10: async) */ : (g.art.manual || []).map(fileUrl), manualPdf: fileUrl(g.art.manualPdf) } }); }
    // (beta.7) arcade zips are named from FinalBurn Neo's list: fetched once in the background, then the shelf refreshes
    for (const g of rommGames(def.id, games)) games.push(g); // (beta.12) this console's RomM games not on this PC yet
    if (games.length && arcadenames.SYSTEMS.has(def.id) && !arcadenames.ready()) arcadenames.fetchNames().then(ok => { if (ok && alive()) win.webContents.send('library:changed', { arcade: 1 }); });
    shelves.push({ id: def.id, kind: 'console', name: def.name, emulatorName: def.emulatorName, hasEmulator: !!sc.emulator && paths.isFile(emuPath(sc.emulator)) /* (1.82) an uninstalled one gets no Open tile */, emulator: sc.emulator, emulatorIcon: fileUrl(await iconQuick(sc.emulator)), gameArgs: sc.gameArgs, bootOnLaunch: sc.bootOnLaunch !== false, useIpl: def.id === 'gc' && !!sc.useIpl, insertAnim: sc.insertAnim !== false, games });
  }
  let pcShelf = [];
  // (beta.10) Steam was only looked for in the first-run setup: one installed later, moved, or not found then never showed.
  // While Steam is on and its folder is unset or wrong, look again (once per session) and keep what's found
  if (cfg.steam.enabled && !steamRoot(cfg.steam.path) && !steamLooked) { steamLooked = true;
    try { const p = await findSteam(); if (p && steamRoot(p)) { steamAuto = p; cfg = persistCfg(config.normalize({ ...cfg, steam: { ...cfg.steam, path: p } })); log('Steam: found it, set as the Steam folder'); } else log('Steam: not found (not in the registry or the usual folders); choose its folder in Settings → PC games'); } catch (e) { log('Steam: looking for it failed', e.message); } }
  // (beta.10) the folder set is a library on another drive, not Steam's own: Steam's own folder is looked for once a
  // session too, so every drive's library, playtimes and covers come along
  const steamGiven = cfg.steam.enabled && steamRoot(cfg.steam.path);
  if (steamGiven && !isMainSteam(steamGiven) && steamMain === undefined) { steamMain = null; try { const p = await findSteam(); if (p && steamRoot(p) && isMainSteam(steamRoot(p))) { steamMain = p; log('Steam: the folder set is a library; using Steam\'s own folder for the list of libraries'); } } catch {} }
  if (cfg.steam.enabled && cfg.steam.path) {
    // Steam's own cached art first, then anything Boxshelf fetched from the Steam store for games Steam has no cover for
    pcShelf = scanSteam(cfg.steam.path, { hideTools: cfg.steam.hideTools !== false, log, mainPath: steamMain || '' }).map(g => { const l = steamart.local(g.appid); return { ...g, ...(ownTitle(g.id) ? { title: ownTitle(g.id), fileTitle: g.title } : {}), info: steamart.gameInfo(g.appid), art: { front: fileUrl(pccovers.cover(g.id) || g.art.front || l.front), hero: fileUrl(g.art.hero || l.hero) } }; }); // (beta.5: a cover chosen in the picker wins)
  }
  // (beta.4) Epic's installs join the PC shelf; Quiver Launcher's apps and games added by hand get the Custom shelf. They
  // are PC games with a source (kind 'steam' keeps every shelf feature); covers come from the Steam app their title
  // matched (pcgames.matchSteam, never an appid the screen could launch: Play goes through launch:pc by id)
  const pc = cfg.pc || {}, epic = [], mine = [];
  if (pc.epic !== false) try { epic.push(...pcgames.epicGames()); } catch (e) { log('Epic library', e.message); }
  // (beta.7) GOG Galaxy, Ubisoft Connect, the EA app and Xbox / Game Pass join the PC shelf too, like Epic (store games)
  try { epic.push(...await pcgames.storeGames(pc)); } catch (e) { log('PC stores', e.message); }
  if (pc.quiver !== false) try { mine.push(...pcgames.quiverGames(pc.quiverPath)); } catch (e) { log('Quiver library', e.message); }
  try { mine.push(...pcgames.customGames(pc.custom)); } catch (e) { log('Custom games', e.message); }
  for (const g of [...epic, ...mine]) { const t = ownTitle(g.id); if (t) { g.fileTitle = g.title; g.title = t; } } // (beta.5: renamed in Details)
  pcgames.remember([...epic, ...mine]);
  // (Steam art by title only for Epic's store games: a recomp or a program added by hand often shares its name with an
  // unrelated Steam game, "Quarantine" got a puzzle game's cover; they keep the made-up case)
  const pcGame = g => { const sid = STORE_SRC.has(g.source) ? pcgames.steamIdOf(g.title) : null, l = sid ? steamart.local(sid) : {};
    return { kind: 'steam', source: g.source, id: g.id, title: g.title, ...(sid ? { info: steamart.gameInfo(sid) } : {}), art: { front: fileUrl(pccovers.cover(g.id) || l.front), hero: fileUrl(l.hero), icon: g.icon || undefined } }; };
  // (beta.10) a game added by hand can be moved to the PC shelf (Settings → Custom games → the game → Shelf)
  const toPc = mine.filter(g => g.shelf === 'pc'), onCustom = mine.filter(g => g.shelf !== 'pc');
  if (epic.length || toPc.length) pcShelf = pcShelf.concat([...epic, ...toPc].map(pcGame)).sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' }));
  if (pcShelf.length) shelves.push({ id: 'pc', kind: 'steam', name: 'PC', games: pcShelf });
  if (onCustom.length) shelves.push({ id: 'custom', kind: 'steam', name: 'Custom', games: onCustom.map(pcGame).sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' })) });
  const apps = [];
  for (const a of APPS) { const c = cfg.apps[a.id]; if (!c || !c.enabled || !c.path) continue; apps.push({ kind: 'app', id: 'app-' + a.id, appId: a.id, title: a.name, path: c.path, art: { icon: fileUrl(await iconQuick(c.path)) } }); }
  if (apps.length) shelves.push({ id: 'media', kind: 'apps', name: 'Media', games: apps });
  covers.flushInfoCache();
  return shelves;
}

// ---------- IPC ----------
ipcMain.on('renderer:log', (e, msg) => log('[ui]', msg));
padwatch.init(log, app.getPath('userData'));
// (beta.6) the last Boxshelf ended with the taskbar hidden (a crash, a power cut, ended from Task Manager): put it back
try { if (fs.existsSync(tbMark())) { fs.unlinkSync(tbMark()); padwatch.taskbar(true).then(() => log('Taskbar back (left hidden by the last session)')); } } catch {}
customThemes.init({ root: path.join(paths.appRoot(), 'Custom themes'), cache: path.join(app.getPath('userData'), 'custom-theme-cache'), nativeImage, systems: CONSOLES.map(c => c.id).concat('home', 'media'), log });
homemenu.init({ padwatch, log, getWin: () => (alive() ? win : null), getUi: () => cfg.ui, getSound: () => ({ enabled: cfg.ui.sound !== false, theme: cfg.ui.soundTheme || 'aero', volume: cfg.ui.volume == null ? .7 : cfg.ui.volume, boot: cfg.ui.bootSound || 'chime' }),
  // quit the game; with a power action, run it once the emulator has really exited (onExit)
  onQuit: then => { log('Home menu: quit'); pendingPower = then ? { kind: then, at: Date.now() } : null; coverForQuit(); closeGame(); },
  onPower: kind => powerAction(kind),
  onShelf: action => {
    // power actions: hand the shelf back first, so after waking (or a cancelled shutdown) it takes input again
    if (['sleep', 'restart', 'shutdown'].includes(action)) { if (alive()) win.webContents.send('shelf:menu', { open: false, action: 'resume' }); return powerAction(action); }
    if (action === 'quitapp') { log('Quit: Exit Boxshelf chosen in the Home menu'); return app.quit(); }
    // (beta.12, Seamless play) Go to desktop: Boxshelf minimised (Guide or the taskbar brings it back, see openShelfMenu)
    if (action === 'desktop') { if (alive()) win.webContents.send('shelf:menu', { open: false, action }); if (!(alive() && seamless.goToDesktop(win))) bringBack(); return; }
    if (alive()) { win.webContents.send('shelf:menu', { open: false, action }); bringBack(); }
  } });
// (beta.12) Seamless play (main/seamless.js): what it uses from here. Off (Settings → Display), nothing of it runs.
seamless.init({ cfg: () => cfg, log, platform: process.platform, runningName: () => launcher.runningName(),
  saveUi: patch => { cfg = persistCfg(config.normalize({ ...cfg, ui: { ...cfg.ui, ...patch } })); },
  busyCheck: () => busyCheck(), setLaunching: v => { launching = !!v; }, taskbarHide: () => taskbarHide(), taskbarShow: why => taskbarShow(why),
  beginRun: () => { runKind = 'watch'; pendingPower = null; }, onExit: info => onExit(info), launcher,
  homeBegin: meta => { if (cfg.ui.homeMenu !== false) homemenu.begin(meta); }, homeMeta: m => homemenu.setMeta(m),
  watchPad: o => watchPad(o), coverAgain: () => { if (coverTimer || quitCover) padwatch.cover(true); }, coverWhileStarting: s => coverWhileStarting(s), coverDeadline: s => coverDeadline(s),
  historyTrack: id => historyTrack(id), gaveUp: () => watchGaveUp() });
launcher.setEventHook(what => seamless.mark(what)); // (the launch timeline: when the game's process started)
// Sleep / Restart / Shut down the PC from the couch
let pendingPower = null, lastPadOpts = null, runKind = null;
// Media apps close at once (and some only hide to the tray): force them sooner than emulators, which may be saving
function closeGame() { return launcher.closeRunning(runKind === 'app' ? 2500 : 8000, pid => log('Quit: had to force-close', pid)); }
// Interface size for TVs across the room (Settings → Display): the whole page is zoomed, layout scales with it
// The page is laid out for a 1080-tall screen. On a taller one (1440p, or a 4K TV at 100 % Windows scaling) everything
// is scaled up with it, so the shelf looks the same on any TV: 1080 → 1×, 1440 → 1.33×, 2160 → 2× (never below 1×).
// Interface size (Settings → Display) multiplies on top. The renderer is told the automatic part so the museum and
// Inspect keep drawing at the screen's full sharpness (their pixel caps are meant per 1080p-sized pixel).
let scaleSent = '';
function applyScale() {
  if (!alive()) return;
  const user = [1, 1.15, 1.3].includes(+cfg.ui.uiScale) ? +cfg.ui.uiScale : 1;
  let auto = 1; try { const [, h] = win.getContentSize(); if (h > 0) auto = Math.max(1, Math.min(2, Math.round(h / 1080 * 100) / 100)); } catch {}
  const z = Math.round(user * auto * 1000) / 1000;
  try { if (Math.abs(win.webContents.getZoomFactor() - z) > .001) win.webContents.setZoomFactor(z); } catch {}
  const sig = auto + '|' + z; if (sig !== scaleSent) { scaleSent = sig; try { win.webContents.send('ui:scale', { auto, zoom: z }); } catch {} }
}
let scaleT = null; const applyScaleSoon = () => { clearTimeout(scaleT); scaleT = setTimeout(applyScale, 150); };
function powerAction(kind) {
  log('Power:', kind);
  // (beta.12) Linux / Steam Deck: systemd's own (SteamOS lets the Deck's user suspend, reboot and power off without a password)
  if (process.platform === 'linux') {
    const cmd = kind === 'sleep' ? 'suspend' : kind === 'restart' ? 'reboot' : kind === 'shutdown' ? 'poweroff' : '';
    // (beta.12) a desktop distro may refuse it (polkit asks for a password, or isn't allowed): said on the screen, not only logged
    const said = { sleep: 'Sleep', restart: 'Restart', shutdown: 'Shut down' }[kind];
    const fail = m => { log('Power failed', m); try { if (alive()) win.webContents.send('app:notice', `${said} didn't work: this PC didn't allow it. Use your desktop's own power menu.`); } catch {} };
    if (cmd) try { require('child_process').execFile('systemctl', [cmd], { timeout: 20000 }, (e, _o, se) => { if (e && !/Connection reset|disconnected/i.test(String(se || ''))) fail(String(se || e.message).trim().split('\n')[0]); }); } catch (e) { fail(e.message); }
    return;
  }
  if (process.platform !== 'win32') return;
  try {
    if (kind === 'sleep') spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"], { windowsHide: true, stdio: 'ignore', detached: true }).on('error', e => log('Power failed', e.message)).unref();
    else if (kind === 'restart' || kind === 'shutdown') spawn('shutdown.exe', [kind === 'restart' ? '/r' : '/s', '/t', '0'], { windowsHide: true, stdio: 'ignore', detached: true }).on('error', e => log('Power failed', e.message)).unref();
  } catch (e) { log('Power failed', e.message); }
}
// On the shelf the XInput helper still runs (lightly) so Guide can open the Home menu even though Chromium never sees it
function watchShelf() {
  if (cfg.ui.homeMenu === false || launcher.isRunning()) return;
  // (beta.12) a Guide "press" in the helper's first moment is a stale state (a pad coming up through Steam, the echo of the
  // Guide that ended a game): it opened the Home menu over the shelf, which then closed again at once
  const t0 = Date.now();
  padwatch.start('none', 900, () => {}, { home: true, backHome: false, taskbarHidden: tbHidden /* (beta.6: kept hidden until you leave the shelf) */, cmdFile: path.join(app.getPath('temp'), `boxshelf-pad-${process.pid}.txt`),
    onHome: () => { if (Date.now() - t0 < 1500) { log('Guide: ignored just after the controller helper started'); return; } if (!closeTrailer()) openShelfMenu(); }, onButton: (b, d) => { if (d && (b === 'b' || b === 'back') && !homemenu.isOpen() && closeTrailer()) return; homemenu.button(b, d); }, isMenuOpen: () => homemenu.isOpen() });
}
// With the Home menu off no shelf helper follows the game's, and Windows won't let Boxshelf take the focus back by
// itself: run a short-lived helper just to hand it over (bringBack's request is repeated by a new helper)
let focusOnlyT = null;
function focusOnlyHelper() {
  if (launcher.isRunning() || !padwatch.focusPending()) return;
  padwatch.start('none', 900, () => {}, { cmdFile: path.join(app.getPath('temp'), `boxshelf-pad-${process.pid}.txt`) });
  clearTimeout(focusOnlyT); focusOnlyT = setTimeout(() => { if (!launcher.isRunning() && cfg.ui.homeMenu === false) padwatch.stop(); }, 10000);
}
// from Guide: only when Boxshelf itself is what you're looking at; from the shelf's Home key: always
function openShelfMenu(fromKey) {
  if (alive() && !launcher.isRunning() && seamless.backFromDesktop(win)) { log('Guide: back from the desktop'); bringBack(); return; } // (beta.12, Seamless play: after Go to desktop)
  if (!alive() || homemenu.isOpen() || launcher.isRunning() || (!fromKey && (!win.isFocused() || cfg.ui.homeMenu === false))) return;
  // Guide: ask the shelf first — it only accepts on the shelf or the details panel (not Inspect, museum, Settings, starting a game)
  if (!fromKey) { win.webContents.send('shelf:menuRequest'); return; }
  if (!padwatch.isRunning()) watchShelf(); // buttons inside the menu come from the helper
  if (homemenu.openShelf({ ...(seamless.on() ? { actions: seamless.shelfActions() } : {}), title: 'Home', system: 'Boxshelf', subtitle: shelfSummary, accent: '#9d8cff', glyphs: shelfGlyphs, layout: cfg.ui.homeLayout === 'center' ? 'center' : 'side', confirmButton: shelfSwap ? 'b' : 'a', audioOut: typeof cfg.ui.audioOut === 'string' ? cfg.ui.audioOut : '' }))
    win.webContents.send('shelf:menu', { open: true });
}
// ---------- the Wii remote on the shelf (Windows) ----------
// A remote on a DolphinBar (Dolphin mode, never switched) points at the screen like on a Wii: the pointer drives the
// shelf as a mouse (hover, click, drag to scroll), A clicks where it points (or confirms the selection when it isn't
// pointing at the screen), and the other buttons reach the shelf as a controller (renderer: the virtual Wii pad). While
// the Home menu is open the remote drives that. Dolphin gets the remote for its games (pause / resume around them).
const wm = { b: 0, aMouse: false, sx: -1, sy: -1, seen: false, seenAt: 0, px: -1, py: -1, sentAt: 0, on: false }; let wmReady = false;
function wmGain() { const n = +cfg.ui.wmSpeed; return Number.isFinite(n) && n >= .8 && n <= 3 ? n : 1.5; }
function wmState(s) {
  if (!alive()) return;
  const B = wiimote.BTN, prevB = wm.b, now = Date.now(); wm.b = s.buttons;
  const press = k => (s.buttons & k) && !(prevB & k), lift = k => !(s.buttons & k) && (prevB & k);
  // a game owns the screen: Home opens Boxshelf's Home menu over it (the remote then drives the menu: Resume, Quit…).
  // (Dolphin's games have the remote themselves: there it's a held Home, from wmWatch)
  if (launcher.isRunning() || launching) { wm.aMouse = false; if (homemenu.isOpen()) wmMenu(press, lift); else if (press(B.home) && !launching) Promise.resolve((homemenu.setMeta({ glyphs: 'nintendo' }), homemenu.open())).catch(e => log('home menu', e && e.message)); return; }
  // the pointer: a central part of the camera's view covers the screen (wmSpeed), smoothed, a little still zone
  if (s.seen) {
    const g = wmGain(), cl = v => Math.max(0, Math.min(1, v)), tx = cl((s.x - .5) * g + .5), ty = cl((s.y - .5) * g + .5);
    if (wm.sx < 0 || !wm.seen) { wm.sx = tx; wm.sy = ty; } else { const d = Math.hypot(tx - wm.sx, ty - wm.sy), a = d > .03 ? .6 : d > .006 ? .35 : .12; wm.sx += (tx - wm.sx) * a; wm.sy += (ty - wm.sy) * a; }
    wm.seen = true; wm.seenAt = now;
  } else if (now - wm.seenAt > 250) wm.seen = false;
  const menu = homemenu.isOpen(), focused = win.isFocused();
  if (menu) {
    wmMenu(press, lift);
    if (wm.aMouse) { wm.aMouse = false; try { win.webContents.sendInputEvent({ type: 'mouseUp', x: wm.px, y: wm.py, button: 'left', clickCount: 1 }); } catch {} }
  } else if (focused) {
    const [w, h] = win.getContentSize(), px = Math.round(wm.sx * w), py = Math.round(wm.sy * h);
    if (wm.seen && (px !== wm.px || py !== wm.py)) { wm.px = px; wm.py = py; try { win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py, modifiers: wm.aMouse ? ['leftButtonDown'] : [] }); } catch {} }
    // A: a click where it points (held: a drag); not pointing at the screen: the confirm button, through the virtual pad
    if (press(B.a) && wm.seen) { wm.aMouse = true; try { win.webContents.sendInputEvent({ type: 'mouseDown', x: wm.px, y: wm.py, button: 'left', clickCount: 1 }); } catch {} }
    if (lift(B.a) && wm.aMouse) { wm.aMouse = false; try { win.webContents.sendInputEvent({ type: 'mouseUp', x: wm.px, y: wm.py, button: 'left', clickCount: 1 }); } catch {} }
  }
  // the shelf: the hand cursor and the buttons (A left out while it's acting as the mouse)
  if (now - wm.sentAt >= 12 || s.buttons !== prevB) { wm.sentAt = now; win.webContents.send('wiimote', { x: wm.sx, y: wm.sy, seen: wm.seen && !menu, b: menu ? 0 : s.buttons & ~(wm.aMouse ? B.a : 0), hold: cfg.ui.wmHold === 'sideways' ? 'sideways' : 'upright' }); }
}
// the Home menu (on the shelf or over a game): the remote's buttons, as the controller helper reports a pad's
function wmMenu(press, lift) {
  const B = wiimote.BTN, side = cfg.ui.wmHold === 'sideways', dir = side ? { up: 'left', down: 'right', left: 'down', right: 'up' } : { up: 'up', down: 'down', left: 'left', right: 'right' };
  for (const [k, name] of [['up', dir.up], ['down', dir.down], ['left', dir.left], ['right', dir.right], ['a', 'a'], ['two', 'a'], ['b', 'b'], ['one', 'b'], ['home', 'home'], ['plus', 'start']]) {
    if (press(B[k])) homemenu.button(name, true); else if (lift(B[k])) homemenu.button(name, false);
  }
}
// During a Dolphin game the remote is Dolphin's: Boxshelf only listens (never sends it anything) for Home held about a
// second, which opens Boxshelf's Home menu (a tap stays the game's own Wii HOME menu); while that menu is open the
// remote drives it. buttons: the remote's bits as the game's own reports carry them
const wmW = { b: 0, homeAt: 0, fired: false };
function wmWatch(buttons) {
  const B = wiimote.BTN, prev = wmW.b; wmW.b = buttons;
  const press = k => (buttons & k) && !(prev & k), lift = k => !(buttons & k) && (prev & k);
  if (!launcher.isRunning()) return;
  if (homemenu.isOpen()) { wmMenu(press, lift); wmW.homeAt = 0; return; }
  if (press(B.home)) { wmW.homeAt = Date.now(); wmW.fired = false; const at = wmW.homeAt; setTimeout(() => { if (wmW.homeAt === at && (wmW.b & B.home) && !wmW.fired && launcher.isRunning() && !homemenu.isOpen()) { wmW.fired = true; log('Wii remote: Home held, Home menu'); homemenu.setMeta({ glyphs: 'nintendo' }); Promise.resolve(homemenu.open()).catch(e => log('home menu', e && e.message)); } }, 900); }
  if (lift(B.home)) wmW.homeAt = 0;
}
function wmStart() {
  if (process.platform !== 'win32' || cfg.ui.wiimote === false || wiimote.isRunning()) return;
  wiimote.start({ cacheDir: path.join(app.getPath('userData'), 'wiimote-cache'), log, onState: wmState, onWatch: wmWatch,
    onConnect: on => { wm.on = on; if (!on) { wm.seen = false; wm.b = 0; if (wm.aMouse && alive()) { wm.aMouse = false; try { win.webContents.sendInputEvent({ type: 'mouseUp', x: wm.px, y: wm.py, button: 'left', clickCount: 1 }); } catch {} } } if (alive()) win.webContents.send('wiimote', { on, seen: false, b: 0 }); } });
}
// the real controllers plugged in (the shelf's button prompts for XInput pads: main/padsense.js)
handle('pads:present', (force) => padsense.list(force === true));
ipcMain.on('wm:rumble', (e, ms) => { if (wm.on && !launcher.isRunning()) wiimote.rumble(Math.max(10, Math.min(80, +ms || 25))); });
// the shelf sends its live prompt style and confirm swap (Confirm "Match my controller" follows the pad in use)
let shelfSummary = '', shelfGlyphs = 'xbox', shelfSwap = false;
const glyphsOf = g => g === 'ps' || g === 'nintendo' ? g : 'xbox';
ipcMain.on('shelf:info', (e, i) => { if (i && typeof i === 'object') { shelfSummary = String(i.summary || '').slice(0, 120); shelfGlyphs = glyphsOf(i.glyphs); shelfSwap = !!i.swap; } });
// the shelf can open it too (Home key), and passes keys through while it's open
ipcMain.on('shelf:openMenu', () => openShelfMenu(true));
ipcMain.on('shelf:menuKey', (e, k) => { const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', Escape: 'cancel', Backspace: 'cancel', Home: 'home' } /* keys mean select / back whichever face button confirms */; const b = map[k && k.key]; if (b) homemenu.button(b, !!k.down); });
// the overlay reports the chosen action; the shelf adds what it knows about the game (title, cover, colour, prompts)
const HOME_ACTIONS = ['resume', 'save', 'load', 'shot', 'quit', 'sleep', 'restart', 'shutdown', 'quitapp', 'shelfhome', 'museum', 'settings', 'desktop']; // (beta.12: desktop = Seamless play's Go to desktop)
ipcMain.on('home:act', (e, a) => homemenu.act(HOME_ACTIONS.includes(a) ? a : 'resume')); // anything unexpected still closes the menu properly
ipcMain.on('home:meta', (e, m) => { if (!m || typeof m !== 'object') return; const str = v => typeof v === 'string' ? v.slice(0, 4000000) : undefined;
  homemenu.setMeta({ title: str(m.title), cover: str(m.cover), accent: /^#[0-9a-f]{3,8}$/i.test(m.accent || '') ? m.accent : undefined, glyphs: glyphsOf(m.glyphs), layout: cfg.ui.homeLayout === 'center' ? 'center' : 'side' }); });
emucfg.init(log);
modelfind.init(log);
app.on('will-quit', () => { try { config.flush(); } catch {}; try { padbattery.stop(); } catch {} }); // (beta.9: settings still waiting to be written go to disk now)
app.on('before-quit', () => { if (onlinePresenceTimer) { clearInterval(onlinePresenceTimer); onlinePresenceTimer = null; } try { const p = profiles.current(); online.sync({ ...onlineSyncData(), name: p.name, avatar: p.avatar, banner: p.banner, playing: '' }); } catch {} if (tbHidden) { tbHidden = false; padwatch.stop(); padwatch.taskbarSync(true); try { fs.unlinkSync(tbMark()); } catch {} log('Taskbar back (Boxshelf quitting)'); } /* (beta.6) */ clearTimeout(scaleT); historyEnd(); companion.stop().catch(() => {}); /* the phone companion's server and its connections */ padwatch.stop(); wiimote.stop(); homemenu.end(); modelfind.stop(); clearQuitCover(); clearTimeout(focusOnlyT); if (coverTimer) { clearInterval(coverTimer.keep); clearTimeout(coverTimer); coverTimer = null; }
  romWatchers.forEach(w => { try { w.close(); } catch {} }); romWatchers = []; clearTimeout(romWatchT); clearTimeout(iconLateT); Object.values(retestT).forEach(clearTimeout); if (moving) clearTimeout(moving.t); });
function handle(name, fn) {
  ipcMain.handle(name, async (e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { if ((/^(archive|library|reading):/.test(name) || name === 'art:games') && !err.cancelled) log('IPC', name, 'failed:', err.message || String(err)); return { ok: false, error: err.message || String(err) }; } // (the magazines finder used to fail without a trace)
  });
}
// (beta.9) the Paste buttons beside the key boxes (setup's Accounts page): the clipboard's text, one line, read only when
// pressed (the page itself may not read the clipboard). Never logged.
handle('clipboard:text', () => { const { clipboard } = require('electron'); return String(clipboard.readText() || '').split(/\r?\n/)[0].trim().slice(0, 512); });
handle('clipboard:write', ({ text }) => { const { clipboard } = require('electron'); clipboard.writeText(String(text || '')); return true; });

  handle('config:get', () => ({ config: cfg, consoles: CONSOLES, apps: APPS, appRoot: paths.appRoot(), version: app.getVersion(), hasInfo: covers.hasInfo(), settingsBlocked: config.blocked(), profile: profiles.current() }));
  handle('profiles:list', () => profiles.list());
  handle('profiles:create', ({ name }) => profiles.create(name, config.file()));
  handle('profiles:update', ({ id, patch }) => { profiles.update(String(id || ''), patch && typeof patch === 'object' ? patch : {}); setTimeout(() => { try { const p = profiles.current(); online.sync({ ...onlineSyncData(), name: p.name, avatar: p.avatar, banner: p.banner }); } catch {} }, 2500); }); // an edited profile (picture included) reaches the server by itself
  handle('profiles:stage', ({ file }) => profiles.stage(file)); // a just-picked picture, served before the profile is saved

  // ---------- Boxshelf Online (perfiles y amigos; el internet va solo por aquí, la página no habla https) ----------
  online.init(profiles, config, log);
  const onlineSyncData = () => { let totalMs = 0; try { for (const v of Object.values(loadHistory())) totalMs += Math.max(0, +v.ms || 0); } catch {} return { totalMs, favorites: (cfg.ui && cfg.ui.favorites) || [] }; };
  handle('online:status', () => online.status());
  handle('online:setServer', ({ url }) => online.setServer(url));
  handle('online:checkName', ({ name }) => online.checkName(name));
  handle('online:register', async ({ name, password, email }) => {
    const res = await online.register(name, password, email);
    try {
      const cur = profiles.current();
      const newName = (res && res.name) || name;
      if (cur && cur.id && newName && !res.pendingVerification) {
        profiles.update(cur.id, { name: newName });
      }
    } catch {}
    return res;
  });
  handle('online:verifyEmail', async ({ email, code }) => {
    const res = await online.verifyEmail(email, code);
    try {
      const cur = profiles.current();
      if (cur && cur.id && res && res.name) {
        profiles.update(cur.id, { name: res.name });
      }
    } catch {}
    return res;
  });
  handle('online:resendCode', ({ email }) => online.resendCode(email));
  handle('online:login', async ({ identifier, password }) => {
    const res = await online.login(identifier, password);
    try {
      const cur = profiles.current();
      if (cur && cur.id && res && res.name) {
        const patch = { name: res.name };
        // Si el usuario en el servidor tiene avatar o banner, descargarlos a la carpeta del perfil local
        try {
          const profileData = await online.view(res.friendCode);
          if (profileData) {
            if (profileData.description) patch.description = profileData.description;
            const pDir = path.join(paths.dataDir(), 'profiles', cur.id);
            fs.mkdirSync(pDir, { recursive: true });
            const srv = online.server();
            if (profileData.avatar && typeof profileData.avatar === 'string') {
              const avUrl = profileData.avatar.startsWith('http') ? profileData.avatar : srv + profileData.avatar;
              const avDest = path.join(pDir, 'avatar.jpg');
              const okAv = await covers.download(avUrl, avDest);
              if (okAv && fs.existsSync(avDest)) patch.avatar = avDest;
            }
            if (profileData.banner && typeof profileData.banner === 'string') {
              const bnUrl = profileData.banner.startsWith('http') ? profileData.banner : srv + profileData.banner;
              const bnDest = path.join(pDir, 'banner.jpg');
              const okBn = await covers.download(bnUrl, bnDest);
              if (okBn && fs.existsSync(bnDest)) patch.banner = bnDest;
            }
          }
        } catch (errSync) {
          log('online login sync error', errSync.message);
        }
        profiles.update(cur.id, patch);
      }
    } catch {}
    return res;
  });
  handle('online:logout', () => {
    try {
      const cur = profiles.current();
      if (cur && cur.id) {
        let defaultName = 'Jugador 1';
        const list = profiles.list();
        if (list && list.profiles) {
          let idx = 1;
          while (list.profiles.some(x => x.id !== cur.id && x.name.toLowerCase() === defaultName.toLowerCase())) {
            idx++;
            defaultName = 'Jugador ' + idx;
          }
        }
        profiles.update(cur.id, {
          name: defaultName,
          description: '',
          avatar: '',
          banner: '',
          fit: { avatar: { z: 1, x: 0, y: 0 }, banner: { z: 1, x: 0, y: 0 } }
        });
      }
    } catch (e) {
      log('logout clear profile', e.message);
    }
    return online.logout();
  });
  handle('online:linkEmail', ({ email }) => online.linkEmail(email));
  handle('online:confirmEmail', ({ email, code }) => online.confirmEmail(email, code));
  handle('online:setPassword', ({ newPassword, currentPassword }) => online.setPassword(newPassword, currentPassword));
  handle('online:sync', () => {
    history = null; // forzar recarga fresca de history.json desde el disco
    const p = profiles.current();
    return online.sync({ ...onlineSyncData(), name: p.name, avatar: p.avatar, banner: p.banner });
  });
  handle('online:upload', ({ kind, data }) => online.upload(kind, data));
  handle('online:friends', () => online.friends());
  handle('online:friendAdd', ({ code }) => online.add(code));
  handle('online:friendRemove', ({ code }) => online.remove(code));
  handle('online:view', ({ code }) => online.view(code));

  // ---------- the controller's battery, for the shelf's HUD (Chromium never reports it) ----------
  padbattery.init(d => { try { if (alive()) win.webContents.send('pad:battery', d); } catch {} }, log);
  handle('pad:battery', () => padbattery.last());
  handle('profiles:select', ({ id }) => {
    if (launcher.isRunning()) throw new Error('Cierra el juego antes de cambiar de perfil.');
    config.flush(); profiles.select(String(id || '')); config.useFile(profiles.configFile());
    cfg = unsealed(config.load()); history = null; histFile = null; histOpen = null; scanForget(); lastLib = null;
    try { artstudio.forget(); } catch {}
    ra.setCredentials(cfg.ra && cfg.ra.enabled !== false ? cfg.ra.user : '', cfg.ra && cfg.ra.key);
    return profiles.current(); // the screen reloads itself: a scan here would only hold that up (start() scans for the new profile)
  });
  // The screen asks for a reload here: a page-initiated location.reload() never happens (will-navigate is blocked).
  handle('app:reload', () => { setTimeout(() => { try { if (alive() && win && !win.isDestroyed()) win.webContents.reload(); } catch {} }, 120); return true; });
// (1.82) Settings → About: the newest beta (force: ask GitHub now, not the answer from this start) and the page's links
handle('app:updateCheck', ({ force } = {}) => updates.check(app.getVersion(), !!force).then(r => ({ ...r, links: updates.LINKS })));
// (beta.12) the screen mode and the window's place are main's own (F11, Settings → Screen mode): a screen's older copy saved later doesn't undo them
handle('config:save', next => { if (!next || typeof next !== 'object' || !next.systems || !next.ui) throw new Error('Bad settings.'); scanForget(); return applyCfg({ ...next, art: cfg.art, games: cfg.games, emuSetup: { ...(next.emuSetup || {}), pending: (cfg.emuSetup || {}).pending || [] }, ui: { ...next.ui, sw2Last: cfg.ui.sw2Last, screenMode: cfg.ui.screenMode, windowBounds: cfg.ui.windowBounds }, ...(next.steam && !next.steam.path && steamAuto && cfg.steam && cfg.steam.path === steamAuto ? { steam: { ...next.steam, path: steamAuto } } : {}),
  keys: { ...(next.keys || {}), ...rommKeysFor(next) } }); }); // (beta.12: RomM's sign-in is main's: set by pairing, cleared by Sign out, or by the server address changing)
// (beta.12) the Steam folder main found by itself this session: a screen's older copy without it doesn't undo it (a path
// the player cleared on purpose is one main didn't just find, so it stays cleared)
let steamAuto = ''; // Art Studio styles and locks change through art:* only: a Settings save with its older copy mustn't undo them. (beta.8) The same for what main itself keeps: each game's own name and emulator (Details → Rename / Emulator), Set up for me's waiting list and Switch 2's last build: a screen's older copy saved later used to undo a rename, or bring back a setup that was already done
// settings saved (or restored from a backup): store them and put every change into effect now
function applyCfg(next) { const prev = cfg, hadMenu = cfg.ui.homeMenu !== false; next = rememberEmus(prev, next); const x = o => o && o.systems && o.systems.x360 && o.systems.x360.emulator; if (x(next) !== x(prev)) next = fixXenia(next); /* (the folder walk only when that path changed) */ cfg = persistCfg(config.normalize(next)); applyArtLibrary(); applyScale(); setTimeout(watchRoms, 0); if (cfg.ui.wiimote === false) wiimote.stop(); else if (wmReady) wmStart(); /* (Settings → Controller → Wii remote, at once) */
  // Home menu switched on/off: start or stop the shelf's Guide watcher now (not after the next game)
  if (!launcher.isRunning() && hadMenu !== (cfg.ui.homeMenu !== false)) { if (cfg.ui.homeMenu === false) padwatch.stop(); else watchShelf(); }
  ra.setCredentials(cfg.ra && cfg.ra.enabled !== false ? cfg.ra.user : '', cfg.ra && cfg.ra.key);
  try { cfgChanged(prev, cfg); } catch (e) { log('settings change', e.message); }
  try { seamless.applied(prev.ui, cfg.ui, alive() && !launcher.isRunning() ? win : null); } catch {} // (beta.12: Seamless play turned off: the screen as before)
  return cfg; }
handle('detect', () => detectAll());
// The last scan is kept on disk so the next launch can show the shelves immediately (as console UIs do) while a fresh
// scan runs behind them; the renderer only rebuilds if something actually changed.
// Wii U e-manuals start on their contents page: the box front goes first, so the booklet opens on a cover like a printed one
// (beta.9) a game with no manual that the manual search and the collections both looked up and found nothing for: when
// (Details says "No manual found online" instead of leaving it to guess whether the search ran)
function manualMiss(sysId, g) {
  if ((g.art && ((g.art.manual || []).length || g.art.manualPdf)) || sysId === 'wiiu') return undefined;
  try { const key = sysId + '|' + String(g.file).toLowerCase(), a = manuals.autoInfo(key), c = manualcoll.info(key);
    if (!a || !a.none || (c && c.src)) return undefined; return a.at || undefined; } catch { return undefined; }
}
function withCover(sysId, g, pages) { return sysId === 'wiiu' && pages.length && g.art.front && (wiiumanual.generated(g.title) || emanualPages(g)) && !manualstudio.chosen(sysId, g.file) /* a scanned manual picked in Manual Studio opens on its own cover */ ? [fileUrl(g.art.front), ...pages] : pages; }
// (beta.9) pages made from a Wii U e-manual, known by their shape: exactly 688 px wide (or twice / three times that) and
// tall. The marker generated() looks for lives in the data folder that made them, so the same games folder used from
// another copy of Boxshelf (the exe in another folder) opened on the e-manual's contents page instead of the box front.
function emanualPages(g) { try { const f = (g.art.manual || [])[0]; if (!f) return false; const z = require('./main/spreads').sizeOf(f); return !!z && z[0] % 688 === 0 && z[0] <= 2064 && z[1] > z[0] * 1.2; } catch { return false; } }
// (beta.10) the same for the library scan, with fs.promises (a games folder on a NAS held the scan up, a read per Wii U
// game), the answer kept by file + date + size
const emanualSeen = new Map();
async function emanualPagesAsync(g) { try { const f = (g.art.manual || [])[0]; if (!f) return false; const st = await fs.promises.stat(f), k = Math.floor(st.mtimeMs) + '|' + st.size, c = emanualSeen.get(f); if (c && c.k === k) return c.v;
  const z = await spreads.sizeOfAsync(f), v = !!z && z[0] % 688 === 0 && z[0] <= 2064 && z[1] > z[0] * 1.2; if (emanualSeen.size > 5000) emanualSeen.clear(); emanualSeen.set(f, { k, v }); return v; } catch { return false; } }
async function withCoverAsync(sysId, g, pages) { return sysId === 'wiiu' && pages.length && g.art.front && (wiiumanual.generated(g.title) || await emanualPagesAsync(g)) && !manualstudio.chosen(sysId, g.file) ? [fileUrl(g.art.front), ...pages] : pages; }
const libCacheFile = () => path.join(path.dirname(profiles.configFile()), 'library-cache.json'); // per profile, like history
// temp (own name per write: two scans can finish together) + rename: a crash mid-write never leaves a cut-off file behind
let atomicN = 0;
async function writeAtomic(file, data) { const tmp = `${file}.${process.pid}-${++atomicN}.tmp`; try { await fs.promises.writeFile(tmp, data); await fs.promises.rename(tmp, file); } catch (e) { fs.promises.unlink(tmp).catch(() => {}); throw e; } }
handle('library:cached', () => { try { return JSON.parse(fs.readFileSync(libCacheFile(), 'utf8')); } catch { return null; } });
// two scans asked for at once (startup + a background job finishing) share one
// …unless the settings changed after it started (that scan read the old ones): then a fresh one runs after it
// (compared by the settings a scan reads, not the object: an unrelated save such as the volume replaces cfg too)
let scanning = null, scanCfg = null, lastLib = null; // lastLib: the shelves of the last scan (Art Studio's game counts)
const scanSig = () => { try { return JSON.stringify([cfg.systems, cfg.steam, cfg.apps, cfg.ui && cfg.ui.artLibrary]); } catch { return String(Math.random()); } };
const scanOnce = () => {
  if (scanning && scanCfg === scanSig()) return scanning;
  const prev = scanning || Promise.resolve();
  const run = prev.catch(() => {}).then(() => { scanCfg = scanSig(); return buildLibrary(); });
  scanning = run.finally(() => { if (scanning === mine) scanning = null; }); const mine = scanning; scanCfg = scanSig();
  return scanning;
};
handle('library:scan', async (arg) => { const cacheFile = libCacheFile(); /* the profile can change while this scan runs */ const lib = await scanOnce(), json = JSON.stringify(lib); lastLib = lib; artstudio.forget();
  // ifChanged: the shelf already shows last session's library; when nothing changed, say so instead of sending the
  // whole library (about a megabyte) back for the screen to unpack and compare, which stalled the shelf as it appeared
  let same = false; if (arg && arg.ifChanged) { try { same = (await fs.promises.readFile(cacheFile, 'utf8')) === json; } catch {} }
  if (!same) writeAtomic(cacheFile, json).catch(() => {}); setTimeout(() => autoCovers(lib), 1500); setTimeout(() => steamFill(lib), 2500); setTimeout(() => wiiuManuals(lib), 3500); setTimeout(() => autoManuals(lib), 6000); return same ? { unchanged: true } : lib; });
// Wii U e-manuals: turn each game's built-in manual into reader pages (once per game, in a hidden window)
let wiiuBusy = false;
async function wiiuManuals(lib) {
  const wu = lib.find(s => s.id === 'wiiu'), sc = cfg.systems.wiiu; if (!wu || !sc || wiiuBusy) return;
  wiiuBusy = true; let made = 0;
  const artDirFor = g => paths.manualDirFor(sc, g.file);
  try { await wiiumanual.collect(wu.games, { artDirFor, baseFor: g => paths.artBase(g.file), render: renderWiiuManual, renderEpub: renderEpubManual, onDone: () => made++ }); }
  catch (e) { log('wiiu manuals', e.message); }
  finally { wiiuBusy = false; }
  if (made && alive()) win.webContents.send('library:changed', { manuals: made });
}
async function renderWiiuManual(model) { // on the shared background helper (one window, reused), like the other manual work
  const r = await helperJob('wiiu-manual.html', async () => model, 180000, true);
  if (r.err) log('wiiu manual render', r.err); if (r.err && !r.pages.length && /timed out|gone|did not load/.test(r.err)) return null;
  return r.pages.map(d => { const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(d)); return m ? Buffer.from(m[1], 'base64') : null; }).filter(Boolean);
}

// Background image work (PDF pages, cutting scans in half, spines) runs in a hidden helper window: one per page type,
// reused job after job and closed after a quiet half minute. (Opening a fresh window for every scan started a new
// process and graphics context each time, and the shelf stuttered while manuals came in.) Background jobs also wait
// while you're pressing buttons, and carry on once you stop.
let uiBusyAt = 0; ipcMain.on('ui:busy', () => { uiBusyAt = Date.now(); });
async function uiQuiet() { const t0 = Date.now(); while (alive() && Date.now() - uiBusyAt < 1500 && Date.now() - t0 < 20000) await new Promise(r => setTimeout(r, 300)); }
const helpers = {};
function helperJob(page, makeMsg, ms, bg, key) { // key: a queue (and window) of its own for the same page
  const H = helpers[key || page] || (helpers[key || page] = { q: Promise.resolve(), w: null, ready: null, idleT: 0, cur: null });
  const run = () => new Promise(async resolve => { // eslint-disable-line no-async-promise-executor
    let msg; try { msg = await makeMsg(); } catch (e) { return resolve({ err: e.message, pages: [] }); }
    if (bg) await uiQuiet();
    clearTimeout(H.idleT);
    if (!H.w || H.w.isDestroyed()) {
      const w = H.w = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { preload: path.join(__dirname, 'preload-wum.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      w.webContents.on('render-process-gone', () => { if (H.w === w) H.w = null; if (H.cur) H.cur({ err: 'helper window gone', pages: [] }); setImmediate(() => { if (!w.isDestroyed()) w.destroy(); }); }); // (a dead window left open was never freed)
      H.ready = new Promise(r => { w.webContents.once('did-finish-load', () => r(true)); setTimeout(() => r(false), 30000); });
      w.loadFile(path.join(__dirname, 'renderer', page)).catch(() => {});
    }
    const w = H.w; let finished = false;
    const finish = r => { if (finished) return; finished = true; H.cur = null; clearTimeout(t); ipcMain.removeListener('wum:done', onDone);
      H.idleT = setTimeout(() => { if (H.w && !H.w.isDestroyed()) H.w.destroy(); H.w = null; }, 30000); resolve(r); };
    const onDone = (e, err, pages) => { if (e.sender !== w.webContents) return; finish({ err, pages: Array.isArray(pages) ? pages : [] }); };
    const t = setTimeout(() => { if (H.w === w) { H.w = null; if (!w.isDestroyed()) w.destroy(); } finish({ err: 'timed out', pages: [] }); }, ms); // a stuck job: start the next one with a fresh window
    H.cur = finish; ipcMain.on('wum:done', onDone);
    if (!(await H.ready) || w.isDestroyed()) { if (H.w === w) H.w = null; if (!w.isDestroyed()) w.destroy(); return finish({ err: 'helper window did not load', pages: [] }); }
    w.webContents.send('wum:model', msg);
  });
  const p = H.q.then(run, run); H.q = p.then(() => {}, () => {}); return p; /* one job at a time per helper */
}
const jpegs = pages => pages.filter(d => /^data:image\/jpeg;base64,/.test(String(d)));
async function renderPdfPages(pdf, size, max, last, bg) {
  const r = await helperJob('pdf-pages.html', async () => { const data = await fs.promises.readFile(pdf); return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), max: max || 80, size: size || 1600, last: !!last }; }, 300000, bg);
  if (r.err) log('manual pdf', path.basename(pdf), r.err); return jpegs(r.pages);
}
// a reading-corner cover: its own helper window and queue (never behind a 300 s manual conversion), and the PDF is named
// by address, not read into memory and posted: pdf.js range-reads the few hundred KB page 1 needs, even from a 2 GB file
async function renderPdfCover(pdf, last) {
  const r = await helperJob('pdf-pages.html', async () => ({ url: fileUrl(pdf), max: 1, size: 900, last: !!last }), 60000, false, 'pdf-cover');
  if (!r.err) return jpegs(r.pages);
  log('library cover', path.basename(pdf), r.err);
  // range reading failed (an odd PDF): a file up to 64 MB is still drawn the old way, on the cover queue
  let size = 0; try { size = fs.statSync(pdf).size; } catch {} if (!size || size > 64 * 1048576) return [];
  const r2 = await helperJob('pdf-pages.html', async () => { const d = await fs.promises.readFile(pdf); return { data: new Uint8Array(d.buffer, d.byteOffset, d.length), max: 1, size: 900, last: !!last }; }, 60000, false, 'pdf-cover');
  if (r2.err) log('library cover (whole file)', path.basename(pdf), r2.err); return jpegs(r2.pages);
}
// scans uploaded as two-page spreads become single pages (Wii U pages are made here and are never spreads)
const spreads = require('./main/spreads');
// cut a scan into halves in a hidden window (decoding big scans here on the main thread froze the shelf)
// (beta.9) a manual page too big to show, made `w` pixels wide in the same hidden image window (never decoded here)
async function shrinkPage(file, w) {
  const r = await helperJob('img-tools.html', async () => { const b = await fs.promises.readFile(file); return { data: new Uint8Array(b.buffer, b.byteOffset, b.length), mode: 'shrink', w }; }, 60000, true);
  if (r.err) { log('shrink page', path.basename(file), r.err); return null; }
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(String((r.pages || [])[0] || ''));
  return m ? Buffer.from(m[1], 'base64') : null;
}
async function cropBoth(file) {
  const r = await helperJob('img-tools.html', async () => { const b = await fs.promises.readFile(file); return { data: new Uint8Array(b.buffer, b.byteOffset, b.length) }; }, 60000, true);
  if (r.err) log('crop', path.basename(file), r.err);
  const b = r.pages.map(d => { const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(d)); return m ? Buffer.from(m[1], 'base64') : null; });
  return b[0] && b[1] ? { left: b[0], right: b[1] } : null;
}
// Spine of a full box wrap, cut in the same hidden image window. Case shapes (front width and spine thickness, both
// relative to the case's height): DVD-style cases 135x190x14 mm, Wii U 135x190x11, Blu-ray 135x171x12, Switch
// 105x170x10, PSP 104x180x14, 3DS 136x121x13.5 (wider than tall). DS (beta.10 left it out, so a DS wrap was cut with
// GameCube's shape): same shell as the 3DS, 136x121x14.
const CASE = { gc: [.711, .074], wii: [.711, .074], ps2: [.711, .074], x360: [.711, .074], wiiu: [.711, .058], ps3: [.789, .07], ps4: [.789, .07], ps5: [.789, .07], sw: [.618, .059], sw2: [.618, .059], psp: [.578, .078], n3ds: [1.127, .112], nds: [1.127, .116] };
async function spineCut(file, sysId, part) { // part 'back' (1.71): the back panel left of the spine, from the same fold search
  const [front, spine] = CASE[sysId] || CASE.gc;
  const r = await helperJob('img-tools.html', async () => { const b = await fs.promises.readFile(file); return { data: new Uint8Array(b.buffer, b.byteOffset, b.length), mode: 'spine', front, spine, part: part === 'back' ? 'back' : 'spine' }; }, 30000, true);
  if (r.err) log(part === 'back' ? 'back cut' : 'spine', path.basename(file), r.err);
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(r.pages[0] || '')); return m ? Buffer.from(m[1], 'base64') : null;
}
covers.setSpineCutter(spineCut);
// a cartridge picture made from a Switch / 3DS game's front cover (1.73.5), in the same hidden image window: for the games no
// source has a cartridge photo of (Art Studio offers it last; automatic fetching uses it when nothing else was found)
async function cartMake(front, sysId) {
  const r = await helperJob('img-tools.html', async () => { const b = await fs.promises.readFile(front); return { data: new Uint8Array(b.buffer, b.byteOffset, b.length), mode: 'cart', sys: sysId }; }, 30000, true);
  if (r.err) log('cartridge from cover', path.basename(front), r.err);
  const m = /^data:image\/png;base64,(.+)$/.exec(String(r.pages[0] || '')); return m ? Buffer.from(m[1], 'base64') : null;
}
covers.setCartMaker(cartMake);
// crop(file, side): both halves come from one pass over the file
// each scan is cut once; its halves are let go once the right one has been taken (the cache used to keep every half of a whole run)
function makeCropper() { const cache = new Map(); return async (file, side) => { if (!cache.has(file)) cache.set(file, cropBoth(file)); const p = cache.get(file), r = await p; if (side === 'right' && cache.get(file) === p) cache.delete(file); return r ? r[side] : null; }; }
// Background manual work waits while a game runs (and for a few seconds after, so the shelf's fade-in stays smooth)
let backAt = 0;
async function gameIdle() { while (alive() && (launcher.isRunning() || Date.now() - backAt < 5000)) await new Promise(r => setTimeout(r, 1000)); }
const yieldNow = () => new Promise(r => setImmediate(r));
async function fixSpreads() {
  markEvent('fixSpreads');
  let n = 0; const ls = require('./main/dircache').lister();
  for (const { def, cfg: sc } of sysList(CONSOLES.map(c => c.id))) {
    if (def.id === 'wiiu') continue;
    await yieldNow(); await uiQuiet(); // (beta.9) between consoles too: consoles without manuals were scanned back to back, one long freeze
    let games = []; try { games = await scanSystemAsync(def, sc); } catch { continue; } // (beta.10: async)
    for (const g of games) {
      if (!(g.art && (g.art.manual || []).length)) continue;
      if (manualUser) return n; // (beta.9: a Wrong game / Repair press goes first)
      await yieldNow(); await gameIdle(); // one game at a time: checking hundreds of manuals in one go froze the shelf ~0.5 s
      try { const k = await spreads.splitManual(paths.manualDirFor(sc, g.file), paths.artBase(g.file), makeCropper(), { ls }); if (k) { n++; log('Manual spreads split', path.basename(g.file), '->', k, 'pages'); } }
      catch (e) { log('Manual spreads', path.basename(g.file), e.message); }
    }
  }
  return n;
}
// every game whose manual is still a PDF (just downloaded, or left over from before): make its pages
async function convertPdfManuals(done) {
  markEvent('convertPdfManuals');
  let n = 0;
  for (const { def, cfg: sc } of sysList(CONSOLES.map(c => c.id))) {
    await yieldNow(); await uiQuiet(); // (beta.9: a breath between consoles, as in fixSpreads)
    let games = []; try { games = await scanSystemAsync(def, sc); } catch { continue; } // (beta.10: async)
    for (const g of games) {
      if (!g.art || !g.art.manualPdf || (g.art.manual || []).length || !alive()) continue;
      if (manualUser) return n; // (beta.9: a Wrong game / Repair press goes first)
      await gameIdle();
      const t0 = Date.now(), pages = await renderPdfPages(g.art.manualPdf, undefined, undefined, undefined, true);
      const saved = pages.length ? await manuals.savePages(sc, g.file, pages, true, pages.length < 80) : 0; // 80 = the page cap: a longer PDF is kept
      log('Manual pages from PDF', path.basename(g.file), saved, 'pages in', Date.now() - t0, 'ms');
      if (saved) n++; if (done) done.set(g.file, saved);
    }
  }
  return n;
}
// E-book manuals: each XHTML page is opened offscreen at GamePad width, measured, cut between paragraphs and pictures
// (the same cutter the layout manuals use) and captured. The window can read only the unpacked e-book: no network.
const EPUB_W = 854, EPUB_MIN_H = 480, EPUB_MAX_H = 12000;
const EPUB_MEASURE = `(() => { const H = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), keep = [];
  for (const el of document.querySelectorAll('img,svg,video,canvas,p,li,h1,h2,h3,h4,h5,h6,tr,figure,dt,dd,table,span,a')) {
    const r = el.getBoundingClientRect(); if (r.height < 2 || r.width < 2) continue; const y = r.top + scrollY; keep.push([Math.round(y), Math.round(y + r.height)]); }
  return { H, keep }; })()`;
function renderEpubManual(root, pages) {
  return new Promise(resolve => {
    const ses = session.fromPartition('boxshelf-emanual'); // one shared, in-memory session (a new one per run was never freed)
    ses.webRequest.onBeforeRequest(null);
    const allowed = path.resolve(root).toLowerCase();
    ses.webRequest.onBeforeRequest((d, cb) => {
      let ok = false;
      try { if (d.url.startsWith('data:')) ok = true; else if (d.url.startsWith('file:')) ok = path.resolve(url.fileURLToPath(d.url)).toLowerCase().startsWith(allowed + path.sep); } catch {}
      cb({ cancel: !ok });
    });
    const w = new BrowserWindow({ show: false, width: EPUB_W, height: EPUB_MIN_H, useContentSize: true, webPreferences: { offscreen: true, session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false } });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', e => e.preventDefault());
    w.webContents.setAudioMuted(true);
    let done = false; const out = [];
    const finish = r => { if (done) return; done = true; clearTimeout(t); if (!w.isDestroyed()) w.destroy(); resolve(r); };
    const t = setTimeout(() => { log('wiiu e-book render timed out after', out.length, 'pages'); finish(out.length ? out : null); }, 60000 + pages.length * 20000);
    w.webContents.on('render-process-gone', (e, d) => { log('wiiu e-book renderer gone', d && d.reason); finish(null); });
    const wait = ms => new Promise(r => setTimeout(r, ms));
    (async () => {
      for (const file of pages) {
        if (done) return;
        try {
          w.setContentSize(EPUB_W, EPUB_MIN_H);
          await w.loadFile(file).catch(() => {});
          await w.webContents.insertCSS('*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important}');
          await wait(350);
          let m = await w.webContents.executeJavaScript(EPUB_MEASURE);
          if (m.H > EPUB_MIN_H) { w.setContentSize(EPUB_W, Math.min(m.H, EPUB_MAX_H)); await wait(300); m = await w.webContents.executeJavaScript(EPUB_MEASURE); }
          const H = Math.max(EPUB_MIN_H, Math.min(m.H, EPUB_MAX_H));
          if (H > EPUB_MIN_H) { w.setContentSize(EPUB_W, H); await wait(150); }
          const parts = H <= EPUB_MIN_H ? [[0, H]] : wiiumanual.splitPage(H, m.keep || []);
          const tall = w.getContentSize()[1] >= H - 2; /* if the window couldn't grow that tall, scroll each piece into view instead */
          if (!tall) { w.setContentSize(EPUB_W, Math.max(...parts.map(([a, b]) => b - a))); await wait(150); }
          for (const [a, b] of parts) {
            let y = a;
            if (!tall) { await w.webContents.executeJavaScript(`window.scrollTo(0, ${a}); window.scrollY`).then(sy => { y = a - sy; }); await wait(120); }
            const img = await w.webContents.capturePage({ x: 0, y, width: EPUB_W, height: Math.max(1, b - a) });
            if (!img.isEmpty()) out.push(img.toJPEG(88));
          }
        } catch (e) { log('wiiu e-book page', path.basename(file), e.message); }
      }
      finish(out);
    })();
  });
}
// Steam games missing a cover (or store info): fetch them in the background, then refresh the shelf once
let steamFilling = false;
async function steamFill(lib) {
  if (steamFilling || cfg.ui.autoCovers === false) return; const pcs = lib.filter(s => s.kind === 'steam'); if (!pcs.length) return;
  steamFilling = true;
  try {
    const all = pcs.flatMap(s => s.games); let games = all.filter(g => !g.source || g.source === 'steam'), matched = 0;
    // (beta.4) Epic / Quiver / hand-added games: their titles are matched to Steam apps (only with box art downloads turned
    // on in setup or Settings: it sends the titles to Steam's store search), then filled like Steam's own
    const others = all.filter(g => STORE_SRC.has(g.source)); // (only the stores' games: see buildLibrary's pcGame)
    if (others.length && cfg.ui.autoCovers === true) {
      matched = await pcgames.matchSteam(others.map(g => g.title));
      games = games.concat(others.map(g => { const id = pcgames.steamIdOf(g.title); return id ? { appid: String(id), title: g.title, art: { front: g.art.front, hero: g.art.hero } } : null; }).filter(Boolean));
    }
    const r = await steamart.fill(games); if ((r.covers || r.other || matched) && alive()) win.webContents.send('library:changed', { covers: r.covers });
  } /* heroes and store info: a quiet refresh, no toast */ catch (e) { log('steam art failed', e.message); } finally { steamFilling = false; }
}
let autoManualsDone = false, autoManualJob = null, manualSeen = null, manualAgain = false;
/* After covers: look up manuals for games that have none and take only confident English matches. Once per session,
   and again whenever games turn up that weren't there last time (added while Boxshelf is open), just for those:
   games already looked at are remembered by the collections / search memos, so a re-run only costs the new ones */
const libGameIds = lib => { const ids = new Set(); (lib || []).forEach(s => (s.games || []).forEach(g => { if (g && (g.kind === 'rom' || !g.kind)) ids.add(s.id + '|' + (g.file || g.id)); })); return ids; };
// ---- the art library (Settings → Box art, or at setup): one folder holding every console's box art and manuals ----
// Choosing one copies the art that's beside the games into it (in the background, never moving or deleting anything);
// downloads wait for that, so nothing already on the PC is fetched again.
let artLibSet = null, artCopy = null;
function applyArtLibrary() { paths.setReadingLibrary(cfg && cfg.ui && typeof cfg.ui.readingLibrary === 'string' ? cfg.ui.readingLibrary : ''); rootsCache = null; /* Settings → Magazines & guides: Magazines\ and Guides\ live there (bsfile:// must reach it too) */ const want = (cfg && cfg.ui && cfg.ui.artLibrary) || '', roots = Object.values((cfg && cfg.systems) || {}).filter(sc => sc && !sc.artDir).flatMap(sc => sc.romDirs || []), sig = want + '\n' + roots.join('\n');
  if (sig === artLibSet) return; artLibSet = sig; paths.setArtLibrary(want, roots); if (want) { /* (again when games folders change: one that now shares a name gets its own library folder, filled from beside the games) */ const p = copyArtToLibrary().catch(e => { log('Art library copy failed', e.message); return 0; }); artCopy = p; p.finally(() => { if (artCopy === p) artCopy = null; }); } }
async function copyArtToLibrary() {
  const lib = paths.artLibrary(); if (!lib) return 0; let n = 0, k = 0; const t0 = Date.now(); log('Art library:', lib, '(copying the art from beside the games)');
  for (const id of CONSOLES.map(c => c.id)) { const sc = cfg.systems[id]; if (!sc || sc.artDir) continue; // a console with its own art folder keeps it
    for (const root of sc.romDirs || []) { const lf = paths.libFolder(root);
      for (const src of [path.join(root, 'covers'), path.join(root, 'media', 'covers'), path.join(root, 'boxart')]) {
        let ents; try { ents = await fs.promises.readdir(src, { withFileTypes: true }); } catch { continue; }
        for (const d of ents) { if (!d.isFile() || !/\.(jpe?g|png|webp|pdf)$/i.test(d.name)) continue;
          const dest = path.join(lf, /-manual(-\d+)?\.[a-z0-9]+$/i.test(d.name) ? 'manuals' : 'covers', d.name);
          try { await fs.promises.access(dest); continue; } catch {}
          try { await fs.promises.mkdir(path.dirname(dest), { recursive: true }); await fs.promises.copyFile(path.join(src, d.name), dest, fs.constants.COPYFILE_EXCL); artstudio.copied(path.join(src, d.name), dest); n++; } catch (e) { if (e.code !== 'EEXIST') log('Art library copy', d.name, e.message); }
          if (++k % 25 === 0) { await uiQuiet(); await gameIdle(); } await new Promise(r => setImmediate(r)); } } } }
  log('Art library: copied', n, 'files in', Math.round((Date.now() - t0) / 1000), 's');
  if (n && alive()) win.webContents.send('library:changed', { artCopied: n }); return n;
}
async function autoManuals(lib) {
  markEvent('autoManuals'); if (artCopy) { try { await artCopy; } catch {} }
  const ids = lib ? libGameIds(lib) : null;
  const fresh = ids && manualSeen ? [...ids].some(id => !manualSeen.has(id)) : false;
  if (manualsBusy) { if (fresh) manualAgain = true; return; } // one is running: go again when it's done
  if (autoManualsDone && !fresh) return;
  while (autoJob && !covers.isPaused('auto')) { try { await Promise.race([autoJob, new Promise(r => setTimeout(r, 1000))]); } catch { break; } } // (beta.10) a paused background art run isn't waited on
  if (manualsBusy) { if (fresh) manualAgain = true; return; }
  if (ids) manualSeen = manualSeen ? new Set([...manualSeen, ...ids]) : ids;
  if (autoManualsDone) log('Auto manuals: new games since the last look, searching again');
  autoManualsDone = true; manualsBusy = true; let fin; autoManualJob = new Promise(r => { fin = r; });
  try {
    // the manual collections first (sharpest scans / official digital manuals; they also upgrade blurry manuals),
    // then the per-game search for whatever they don't have
    let coll = 0; const changed = [];
    // (beta.9) once: manuals picked before the stricter matching that it wouldn't pick (or with thumbnail pages) are set
    // aside and looked up again by the passes below
    let rechecked = null; // (its counts go to the shelf's "Manuals checked" message)
    if (cfg.ui.autoManuals !== false) { try { rechecked = await manuals.recheck(sysList(CONSOLES.map(c => c.id)), { cancelled: bgStop, idle: gameIdle, collInfo: key => manualcoll.info(key), locked: (id, f) => manualstudio.isLocked(id, f) || manualstudio.picked(id, f) }); } catch (e) { log('Manual re-check failed', e.message); } }
    if (cfg.ui.autoManuals !== false) { try { coll = await manualcoll.run(sysList(CONSOLES.map(c => c.id)), { renderPdf: (p, size) => renderPdfPages(p, size || 1600, undefined, undefined, true), crop: makeCropper(), cancelled: bgStop, idle: gameIdle, report: changed, skipSystem: d => manualstudio.prefFor(d.id) !== 'best', locked: (id, f) => manualstudio.isLocked(id, f) || manualstudio.picked(id, f) /* a picked manual: background passes leave it (1.73) */ }); } catch (e) { log('Manual collections failed', e.message); } }
    const r = cfg.ui.autoManuals === false ? { got: 0 } : await manuals.autoFetch(sysList(CONSOLES.map(c => c.id)), { skip: d => d.id === 'wiiu', cancelled: bgStop, idle: gameIdle, prefFor: id => manualstudio.prefFor(id), locked: (id, f) => manualstudio.isLocked(id, f) || manualstudio.picked(id, f) /* a picked manual: background passes leave it (1.73) */ }); // (Manual Studio: each console's language / region; hand-picked manuals left alone)
    const conv = await convertPdfManuals(), split = await fixSpreads();
    const rk = rechecked && rechecked.moved && !rechecked.cancelled && !bgStop() ? { checked: rechecked.checked, moved: rechecked.moved } : undefined; // (not when a Wrong game / Repair press stopped the pass part way: it says so when it's really done)
    if ((coll || r.got || conv || split || rk) && alive()) win.webContents.send('library:changed', { onlineManuals: Math.max(r.got, conv), manualUpdates: changed, rechecked: rk });
  } catch (e) { log('Auto manuals failed', e.message); }
  finally { manualsBusy = false; autoManualJob = null; if (manualUser) { autoManualsDone = false; manualResume = true; } /* stopped for a Wrong game / Repair press: it carries on after */ fin(); if (manualAgain && alive()) { manualAgain = false; setTimeout(() => scanOnce().then(l => autoManuals(l)).catch(() => {}), 4000); } }
}
// (beta.9) a Wrong game / Repair press stops the background manual pass at its next step (it used to wait for the whole
// pass, minutes, so the button seemed to do nothing), then the pass starts again where it is needed
let manualUser = 0, manualResume = false;
const bgStop = () => !alive() || manualUser > 0;
async function manualTurn(run) {
  manualUser++;
  // (beta.9) the screen says what it's waiting for: the background pass to stop at its next step, then the fix itself
  const tell = d => { try { if (alive()) win.webContents.send('manuals:turn', d); } catch {} };
  try { if (autoManualJob) { tell({ wait: true }); try { await autoManualJob; } catch {} } if (manualsBusy) throw new Error('Already downloading manuals.'); manualsBusy = true; tell({ go: true }); try { return await run(); } finally { manualsBusy = false; } }
  finally { manualUser--; manualResumeSoon(); }
}
function manualResumeSoon() { if (!manualUser && manualResume && alive()) { manualResume = false; setTimeout(() => scanOnce().then(l => autoManuals(l)).catch(() => {}), 4000); } }
// (beta.10) manuals:find / :download wait for the background pass the same way, stopping it at its next step (bgStop),
// but only while they wait: their own work (PDF pages, spreads) checks manualUser too. manualResumeSoon() after them.
async function manualBgWait(tell) { if (!autoManualJob) return; if (tell) tell(); manualUser++; try { await autoManualJob; } catch {} finally { manualUser--; } }
// one game's manual PDF into pages (the whole-library pass looked at every game for this)
async function pdfToPages(sc, g) {
  const pdf = path.join(paths.manualDirFor(sc, g.file), paths.artBase(g.file) + '-manual.pdf'); if (!paths.isFile(pdf)) return 0;
  const pages = await renderPdfPages(pdf, undefined, undefined, undefined, true);
  return pages.length ? manuals.savePages(sc, g.file, pages, true, pages.length < 80) : 0;
}
const autoTried = new Set(); let autoRunning = false;
let backMemo = null; const backFile = () => path.join(app.getPath('userData'), 'cover-checks.json');
function backDue(id) {
  if (!backMemo) { try { backMemo = JSON.parse(fs.readFileSync(backFile(), 'utf8')); } catch { backMemo = {}; } }
  if (backMemo[id] && Date.now() - backMemo[id] < 7 * 864e5) return false;
  backMemo[id] = Date.now(); return true; } /* saved once the cover run has finished (saveBackMemo): a run cut short must not skip these games for a week */
function saveBackMemo() { if (backMemo) writeAtomic(backFile(), JSON.stringify(backMemo)).catch(() => {});
}
// Games missing a front, back or spine get art fetched in the background (each game at most weekly, see backDue), then the shelf refreshes
async function autoCovers(lib) {
  markEvent('autoCovers'); if (artCopy) { try { await artCopy; } catch {} }
  if (cfg.ui.autoCovers === false || coversBusy || autoRunning || artstudio.busy()) return; // (a shelf being restyled: next scan)
  const ids = [], only = new Set();
  for (const sh of lib) {
    if (sh.kind !== 'console') continue;
    // backs and spines: checked weekly (a front alone, like Paper Mario, still wants its back and spine); a missing
    // front too, after its first look: one cover that doesn't exist anywhere mustn't send the console round every launch
    const missing = sh.games.filter(g => g.kind === 'rom' && !autoTried.has(g.id) && (!g.art.front || !g.art.back || g.art.madeBack || !g.art.spine || g.art.madeSpine) && backDue(g.id)); // (a made back or spine still wants a real scan)
    if (!missing.length) continue;
    missing.forEach(g => { autoTried.add(g.id); only.add(g.id); }); ids.push(sh.id);
  }
  if (!ids.length) return;
  const list = CONSOLES.filter(d => ids.includes(d.id) && cfg.systems[d.id] && (cfg.systems[d.id].romDirs || []).length).map(def => ({ def, cfg: cfg.systems[def.id] }));
  if (!list.length) return;
  autoRunning = true; coversBusy = true; let done, cut = false; autoJob = new Promise(r => { done = r; });
  try {
    log('Auto covers for', ids.join(','));
    // (its progress goes to the page too, a few times a second at most: the first-run Done screen shows "Getting box art")
    // (beta.10) …with the whole run's count (allDone of allTotal) and whether it's paused, for the shelf's art card
    let sentAt = 0; const doneBy = {}, st = autoState = { paused: false, last: null, t: 0 };
    st.send = () => { try { if (alive()) win.webContents.send('covers:auto', { ...st.last, allDone: Object.values(doneBy).reduce((a, b) => a + b, 0), allTotal: only.size, paused: st.paused }); } catch {} };
    const tell = info => { if (info && info.systemId && info.total) doneBy[info.systemId] = +info.done || 0; st.last = { stage: String(info && info.stage || ''), done: +(info && info.done) || 0, total: +(info && info.total) || 0, system: String(info && info.system || '') };
      const now = Date.now(); if (now - sentAt < 300 || !alive()) return; sentAt = now; st.send(); };
    const rep = await covers.downloadCovers(list, tell, ['front', 'back', 'spine', 'disc'], { only, region: cfg.ui.artRegion, hd: cfg.ui.artHD !== false, ...artOpts(false), tag: 'auto' }); // just the games that are due, not their whole consoles; "HD only" (Settings → Box art) applies here too; a console with an Art Studio style follows it, locked parts are left alone
    cut = !!rep.cancelled;
    try { if (alive()) win.webContents.send('covers:auto', { end: true, got: (rep.systems || []).reduce((a, r) => a + (r.front || 0), 0) }); } catch {}
    artstudio.forget(); // the Studio's game lists show the new pictures (Settings may hold off the shelf's rescan)
    const n = (rep.systems || []).reduce((a, r) => a + (r.front || 0) + (r.back || 0) + (r.spine || 0) + (r.disc || 0) + (r.upgraded || 0), 0);
    // the toast counts games that got a front cover (one per game); backs, spines, discs and sharper copies only refresh the shelf
    if (n && alive()) win.webContents.send('library:changed', { covers: (rep.systems || []).reduce((a, r) => a + (r.front || 0), 0) });
  } catch (e) { log('Auto covers failed', e.message); try { if (alive()) win.webContents.send('covers:auto', { end: true, got: 0, failed: true }); } catch {} }
  finally { const st = autoState; autoState = null; if (st) clearInterval(st.t); coversBusy = false; autoRunning = false; autoJob = null;
    if (cut || (st && st.stopped)) for (const id of only) if (backMemo) delete backMemo[id]; // (beta.10: a cancelled run's games are looked at again next start, not in a week)
    saveBackMemo(); done(); if (!(st && st.stopped)) setTimeout(() => makeBacks(ids).then(() => makeSpines(ids)), 3000); } // (beta.10: Cancel on the art card stops the made backs and spines too)
}
// (beta.10) the shelf's art card: Pause / Resume the background run (covers:cancel { auto } cancels it). Paused, its state is
// sent again every few seconds (a screen that reloads meanwhile still shows the card, with Resume). false: nothing running
let autoState = null;
function autoPause(on) { const st = autoState; if (!st || st.stopped) return false; if (st.paused === !!on) return true; if (!covers.pause('auto', on)) return false; st.paused = !!on; clearInterval(st.t); st.t = on ? setInterval(() => st.send(), 5000) : 0; st.send(); log('Auto covers', on ? 'paused' : 'resumed'); return true; }
handle('covers:pause', () => ({ ok: autoPause(true) }));
handle('covers:resume', () => ({ ok: autoPause(false) }));
// Made backs: a game with a front but no scanned back anywhere (new consoles above all: hardly any Switch 2 backs are
// scanned yet) gets one drawn from its own pictures and LaunchBox's details (renderer/img-tools.js back()), saved as
// "<name>-backmade.jpg" beside its art. The scanner uses it only while there's no real back, and the weekly art check
// keeps looking for a real one. Settings → Box art → "Make backs for games without one" (ui.makeBacks).
const BACK_BAND = { sw2: ['#e60012', '#fff', 'Nintendo Switch 2'], sw: ['#e60012', '#fff', 'Nintendo Switch'], ps5: ['#f2f4f8', '#111318', 'PS5'], ps4: ['#1d4ed8', '#fff', 'PS4'], ps3: ['#141414', '#fff', 'PS3'], ps2: ['#1d3fb8', '#fff', 'PlayStation 2'], psp: ['#141414', '#fff', 'PSP'], wii: ['#f2f2f2', '#222', 'Wii'], wiiu: ['#1fa3d9', '#fff', 'Wii U'], gc: ['#3b2a7a', '#fff', 'GameCube'], n3ds: ['#cf0a2c', '#fff', 'Nintendo 3DS'], x360: ['#57b52d', '#fff', 'Xbox 360'] };
let backsBusy = false;
async function fetchImage(u) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 10000);
  try { const r = await net.fetch(u, { signal: ac.signal }); if (!r.ok) return null; const b = Buffer.from(await r.arrayBuffer()); return b.length > 1000 && b.length < 15e6 ? b : null; } catch { return null; } finally { clearTimeout(t); }
}
async function makeBacks(ids) {
  if (backsBusy || cfg.ui.makeBacks === false || !Array.isArray(ids) || !ids.length) return;
  backsBusy = true; let made = 0;
  try {
    for (const id of ids) {
      const def = CONSOLES.find(c => c.id === id), sc = cfg.systems[id]; if (!def || !sc || !(sc.romDirs || []).length) continue;
      await yieldNow(); await uiQuiet(); // (beta.9: a breath between consoles)
      let games = []; try { games = await scanSystemAsync(def, sc); } catch { continue; } // (beta.10: async)
      for (const g of games) {
        if (!g.art || !g.art.front || (g.art.back && !g.art.madeBack) || g.art.madeBack) continue; // a real back, or one already made
        if (launcher.isRunning() || launching) return; // a game started: not now (the next art check carries on)
        const buf = await renderBack(id, g.title, g.art.front); if (!buf) continue;
        const dir = paths.artDirFor(sc, g.file); try { fs.mkdirSync(dir, { recursive: true }); await fs.promises.writeFile(path.join(dir, paths.artBase(g.file) + '-backmade.jpg'), buf); made++; } catch (e) { log('made back', g.title, e.message); }
      }
    }
  } finally { backsBusy = false; if (made) { log('Made backs:', made); if (alive()) win.webContents.send('library:changed', {}); } }
}
// Made spines: the same for a game no source has a spine of (Switch 2 above all), drawn in its console's style with the
// game's logo (SteamGridDB with the user's key, else LaunchBox's clear logo) or its title (renderer/img-tools.js
// madeSpine), saved as "<name>-spinemade.jpg". Used only while there's no real spine; the weekly art check keeps looking.
// Same setting as the made backs (ui.makeBacks).
let spinesBusy = false;
async function makeSpines(ids) {
  if (spinesBusy || cfg.ui.makeBacks === false || !Array.isArray(ids) || !ids.length) return;
  spinesBusy = true; let made = 0;
  try {
    for (const id of ids) {
      const def = CONSOLES.find(c => c.id === id), sc = cfg.systems[id]; if (!def || !sc || !(sc.romDirs || []).length || !CASE[id]) continue;
      await yieldNow(); await uiQuiet(); // (beta.9: a breath between consoles)
      let games = []; try { games = await scanSystemAsync(def, sc); } catch { continue; } // (beta.10: async)
      for (const g of games) {
        if (!g.art || !g.art.front || g.art.spine) continue; // a real spine, or one already made
        if (launcher.isRunning() || launching) return; // a game started: not now (the next art check carries on)
        const buf = await renderSpine(id, g.title, g.art.front); if (!buf) continue;
        const dir = paths.artDirFor(sc, g.file); try { fs.mkdirSync(dir, { recursive: true }); await fs.promises.writeFile(path.join(dir, paths.artBase(g.file) + '-spinemade.jpg'), buf); made++; } catch (e) { log('made spine', g.title, e.message); }
      }
    }
  } finally { spinesBusy = false; if (made) { log('Made spines:', made); if (alive()) win.webContents.send('library:changed', {}); } }
}
// The two makers, shared by the background passes above and the Art Studio, which offers a made back and spine for
// every game as one more choice (ranked after every real scan). A JPEG Buffer, or null.
async function renderBack(id, title, front) {
  if (!front || !paths.isFile(front)) return null;
  const def = CONSOLES.find(c => c.id === id), info = covers.gameInfo(id, title) || {}, band = BACK_BAND[id] || ['#16161b', '#fff', def ? def.name : ''];
  const shots = []; for (const u of (info.shots || []).slice(0, 3)) { const b = await fetchImage(u); if (b) shots.push(b); }
  const bg = info.bg ? await fetchImage(Array.isArray(info.bg) ? info.bg[0] : info.bg) : null;
  const r = await helperJob('img-tools.html', async () => { const b = await fs.promises.readFile(front); return { mode: 'back', data: new Uint8Array(b.buffer, b.byteOffset, b.length), shots: shots.map(x => new Uint8Array(x.buffer, x.byteOffset, x.length)), bg: bg ? new Uint8Array(bg.buffer, bg.byteOffset, bg.length) : null,
    title, overview: info.overview || '', esrb: info.esrb || '', players: info.players || '', pub: info.pub || '', year: info.year || (info.release ? String(info.release).slice(0, 4) : ''), band: { bg: band[0], fg: band[1], label: band[2] } }; }, 30000, true);
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(String((r.pages || [])[0] || ''));
  if (!m) { log('made back', title, r.err || 'nothing made'); return null; }
  return Buffer.from(m[1], 'base64');
}
async function renderSpine(id, title, front) {
  if (!front || !paths.isFile(front) || !CASE[id]) return null;
  const def = CONSOLES.find(c => c.id === id), info = covers.gameInfo(id, title) || {}, band = BACK_BAND[id] || ['#16161b', '#fff', def ? def.name : ''];
  let logo = null;
  try { const ls = await require('./main/steamgrid').logos({ title, names: covers.lookupNames(title) }, covers.sgMatch); for (const l of ls.slice(0, 2)) { logo = await fetchImage(l.url); if (logo) break; } } catch {}
  if (!logo && info.logo) logo = await fetchImage(info.logo);
  const r = await helperJob('img-tools.html', async () => { const b = await fs.promises.readFile(front); return { mode: 'madespine', data: new Uint8Array(b.buffer, b.byteOffset, b.length), logo: logo ? new Uint8Array(logo.buffer, logo.byteOffset, logo.length) : null,
    title, pub: info.pub || '', ratio: CASE[id][1], lightBody: !['ps2', 'ps3', 'ps4', 'psp', 'gc'].includes(id), band: { bg: band[0], fg: band[1], label: band[2] } }; }, 30000, true);
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(String((r.pages || [])[0] || ''));
  if (!m) { log('made spine', title, r.err || 'nothing made'); return null; }
  return Buffer.from(m[1], 'base64');
}
artstudio.setMaker({ back: renderBack, spine: renderSpine });
// (beta.12, Linux Game Mode) the desktop's file dialog can't be driven with a controller there (and may not show at all):
// every pick opens Boxshelf's own browser on the screen instead (renderer/picker.js). Same answer as showOpenDialog
const pickWaits = new Map(); let pickSeq = 0;
ipcMain.on('pick:done', (e, d) => { if (!alive() || e.sender !== win.webContents) return; const id = d && d.id, f = pickWaits.get(id); if (!f) return; pickWaits.delete(id); f(d || {}); });
// (the page reloaded or went while a pick was open: it can't answer any more, so it counts as cancelled)
const pickDrop = () => { for (const f of pickWaits.values()) { try { f({}); } catch {} } pickWaits.clear(); };
let pickHooked = null;
function pickHook() { if (!alive() || pickHooked === win) return; pickHooked = win; try { win.webContents.on('did-start-navigation', (e, url, inPlace, main) => { if (main !== false && !inPlace) pickDrop(); }); win.webContents.on('render-process-gone', pickDrop); win.on('closed', pickDrop); } catch {} }
async function openDialog(parent, o) {
  if (!(linux.isLinux && steamdeck.gameMode() && alive())) return dialog.showOpenDialog(parent, o);
  pickHook();
  const props = o.properties || [], id = ++pickSeq, exts = [...new Set((o.filters || []).flatMap(f => (f && f.extensions) || []).map(x => String(x).toLowerCase()))].filter(x => x !== '*');
  const res = await new Promise(resolve => { pickWaits.set(id, resolve); try { win.webContents.send('pick:open', { id, folder: props.includes('openDirectory'), title: String(o.title || ''), start: String(o.defaultPath || ''), exts }); } catch { pickWaits.delete(id); resolve({}); } });
  return res && res.path ? { canceled: false, filePaths: [String(res.path)] } : { canceled: true, filePaths: [] };
}
// the browser's folder listing: names only, folders first (hidden ones left out), only what the pick can use (folders, and
// for a file pick the files of its kinds), at most 5000. Read without holding the main process up (a No-Intro or MAME
// folder has tens of thousands of files)
const fsCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
handle('fs:list', async ({ dir, folder, exts } = {}) => {
  if (!linux.isLinux) throw new Error('Only on Linux.');
  const d = path.resolve(String(dir || require('os').homedir())), parent = path.dirname(d) !== d ? path.dirname(d) : '';
  let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { return { dir: d, parent, entries: [], error: e.code === 'EACCES' ? "Boxshelf isn't allowed to look in this folder." : "Couldn't open this folder." }; }
  const want = Array.isArray(exts) ? exts.map(x => String(x).toLowerCase()).filter(x => x && x !== 'exe') : [], keep = n => { if (folder) return false; if (!want.length) return true; const m = /\.([^.]+)$/.exec(n); return !!m && want.includes(m[1].toLowerCase()); };
  const out = [];
  for (const en of ents) { if (en.name.startsWith('.')) continue; let isDir = en.isDirectory(); if (en.isSymbolicLink()) { try { isDir = (await fs.promises.stat(path.join(d, en.name))).isDirectory(); } catch { continue; } } if (isDir || keep(en.name)) out.push({ n: en.name, d: isDir }); }
  out.sort((a, b) => (b.d - a.d) || fsCollator.compare(a.n, b.n));
  return { dir: d, parent, entries: out.slice(0, 5000), more: Math.max(0, out.length - 5000) };
});
// the browser's places: home, the SD card / USB drives, EmuDeck's and RetroDECK's folders, Applications, Downloads (the ones there)
handle('fs:places', () => {
  if (!linux.isLinux) return [];
  const os = require('os'), h = os.homedir(), user = os.userInfo().username, out = [], add = (label, p) => { try { if (fs.statSync(p).isDirectory() && !out.some(x => x.path === p)) out.push({ label, path: p }); } catch {} };
  add('Home', h);
  for (const base of ['/run/media/' + user, '/run/media', '/media/' + user]) { let L = []; try { L = fs.readdirSync(base, { withFileTypes: true }); } catch {} for (const e of L) if (e.isDirectory() && e.name !== user) add(/^mmcblk/.test(e.name) ? 'SD card' : e.name, path.join(base, e.name)); }
  add('Emulation (EmuDeck)', path.join(h, 'Emulation')); add('RetroDECK', path.join(h, 'retrodeck')); add('Applications', path.join(h, 'Applications'));
  add('Downloads', path.join(h, 'Downloads')); add('Desktop', path.join(h, 'Desktop'));
  // (hidden folders aren't listed: the Flatpak emulators' own folder gets a place, so one can be picked as the emulator)
  add('Flatpak apps', path.join(h, '.local/share/flatpak/exports/bin')); add('Flatpak apps (system)', '/var/lib/flatpak/exports/bin'); add('Whole drive', '/');
  return out;
});
handle('dialog:pick', async ({ kind, title, defaultPath, filters, multi }) => {
  const r = await openDialog(win, {
    title, defaultPath,
    properties: kind === 'folder' ? ['openDirectory'] : multi ? ['openFile', 'multiSelections'] : ['openFile'], // (beta.7) multi: Add games → Add several programs
    // (Linux: programs have no .exe, so a "Programs" filter would hide every emulator: there it shows all files)
    filters: kind === 'folder' ? undefined : linux.isLinux && (!filters || filters.some(f => f && Array.isArray(f.extensions) && f.extensions.includes('exe'))) ? undefined : (filters || [{ name: 'Programs', extensions: ['exe'] }])
  });
  return r.canceled ? null : multi ? r.filePaths : r.filePaths[0];
});
// (beta.13) menu music of your own: the file is copied into userData\music, so it keeps playing even if the original is
// moved, renamed or on a drive that isn't there. One file at a time; picking another replaces it.
handle('music:pick', async () => {
  const r = await openDialog(win, {
    title: 'Choose your menu music',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac'] }]
  });
  const src = r && !r.canceled && r.filePaths && r.filePaths[0];
  if (!src) return null;
  const dir = path.join(app.getPath('userData'), 'music');
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = (path.extname(src) || '.mp3').toLowerCase();
  const out = path.join(dir, 'custom-' + Date.now().toString(36) + ext); // a new name each time: the old address can't come back from the web cache
  for (const f of await fs.promises.readdir(dir).catch(() => [])) { const p = path.join(dir, f); if (/^custom[-.]/i.test(f) && p.toLowerCase() !== out.toLowerCase()) fs.promises.unlink(p).catch(() => {}); }
  await fs.promises.copyFile(src, out);
  return { file: out, name: path.basename(src), url: fileUrl(out) };
});
// ---------- (beta.7) Add games (main/addgames.js): a folder of games scanned; Playnite's library read (experimental) ----------
handle('games:scanFolder', ({ root }) => { const r = addgames.scanFolder(String(root || '')); return { ...r, games: r.games.map(g => ({ ...g, title: g.title })) }; });
handle('games:titleFor', ({ exes }) => (Array.isArray(exes) ? exes : []).slice(0, 500).map(e => ({ exe: String(e), title: addgames.titleFor(String(e)) })));
let pnPlan = null;
handle('playnite:find', ({ dir } = {}) => process.platform === 'win32' ? addgames.find(dir ? String(dir) : '') : null);
handle('playnite:plan', async ({ dir } = {}) => {
  const found = addgames.find(dir ? String(dir) : ''); if (!found) throw new Error('Playnite wasn\'t found. Choose its folder (the one with Playnite.DesktopApp.exe).');
  const p = addgames.plan(await addgames.read(found), found); pnPlan = p; return { ...p, app: found.app, portable: found.portable };
});
// the emulator for a console inside a folder Playnite named (its own program names, two folders deep at most)
handle('games:emuIn', ({ dir, systemId }) => {
  const def = CONSOLES.find(c => c.id === systemId); if (!def || !dir) return null; const names = new Set((def.exeNames || []).map(n => n.toLowerCase())); let hit = null;
  const walk = (d, left) => { if (hit) return; let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { if (hit) return; const p = path.join(d, e.name); if (e.isFile() && names.has(e.name.toLowerCase())) hit = p; else if (e.isDirectory() && left > 0) walk(p, left - 1); } };
  walk(String(dir), 2); return hit;
});
// covers for games just added: a Playnite cover picked from the last summary only (never any file the page names)
handle('games:covers', async ({ items }) => {
  const ok = new Set(pnPlan ? pnPlan.pc.flatMap(g => [g.cover, g.bg]).filter(Boolean).map(f => path.resolve(f).toLowerCase()) : []); let n = 0;
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'game';
  for (const it of (Array.isArray(items) ? items : []).slice(0, 2000)) { const f = it && String(it.file || ''); if (!f || !ok.has(path.resolve(f).toLowerCase())) continue;
    try { await pccovers.own('custom-' + slug(it.id), f); pcCoverBump('custom-' + slug(it.id)); n++; } catch (e) { log('Imported cover', e.message); } }
  if (n) { scanCfg = null; if (alive()) win.webContents.send('library:changed', { pcCover: 1 }); } return n;
});
// Xenia Manager picked instead of Xenia itself: the setting switches to the real emulator. Done on the config as it is
// loaded and saved (never in place during a scan): Settings gets the fixed path back from its save, so its own copy
// can't keep writing the Manager path back, and a scan doesn't change the config under the next scan's check
function fixXenia(c) {
  const sc = c && c.systems && c.systems.x360; if (!sc || !sc.emulator) return c;
  const r = emucfg.resolveExe('x360', emuPath(sc.emulator)); return r.changed ? { ...c, systems: { ...c.systems, x360: { ...sc, emulator: r.exe } } } : c;
}
let launching = false; // a second Play while a .cia installs (or anything runs) must not copy into the same files / touch the emulator's settings
// ---- a game's own emulator (Details → Emulator) ----
// Builds that were set as a console's emulator before are kept in cfg.emuSeen, so a build made for one game (a
// shadPS4 fork with that game's settings in custom_configs\<title id>.json) can be offered for it later.
function rememberEmus(prev, next) {
  try { if (!prev || !next || !next.systems) return next; const seen = Array.isArray(next.emuSeen) ? next.emuSeen.slice() : (prev.emuSeen || []).slice();
    for (const [id, sc] of Object.entries(prev.systems || {})) { const was = sc && sc.emulator, now = next.systems[id] && next.systems[id].emulator; if (was && was !== now) seen.unshift(was); }
    for (const g of Object.values(next.games || {})) if (g && g.emulator) seen.unshift(g.emulator);
    return { ...next, emuSeen: [...new Set(seen)].slice(0, 20) }; } catch { return next; }
}
// an emulator path as the launcher reads it ({app}, %VAR%, pasted "quotes"): what sits beside the exe is looked up from this
const emuPath = p => p ? paths.expand(String(p).trim().replace(/^"(.*)"$/, '$1')) : p;
function gameEmuOverride(systemId, file) { const o = cfg.games && cfg.games[systemId + ':' + file]; return o && o.emulator ? paths.expand(o.emulator) : ''; }
// a build that ships settings for this game (custom_configs\<title id>.json beside it, or in its user files)
function emuMadeFor(exe, titleId) {
  if (!exe || !titleId) return false; const d = path.dirname(exe);
  return ['custom_configs', path.join('user-files', 'custom_configs'), path.join('user', 'custom_configs')].some(k => paths.isFile(path.join(d, k, titleId + '.json')));
}
function titleIdOf(systemId, file) { try { if (systemId === 'ps5') { const id = kyty.titleId(file); if (id) return id; } if (systemId === 'sw2') return nx2.titleId(file); /* (PS5: the game's own param.json; a folder's name can carry another region's id) */ const m = /\b([A-Z]{4}\d{5})\b/.exec(file); if (m) return m[1]; if (systemId === 'ps4') { const sfo = path.join(path.dirname(file), 'sce_sys', 'param.sfo'); const b = fs.readFileSync(sfo); const t = /([A-Z]{4}\d{5})/.exec(b.toString('latin1')); if (t) return t[1]; } } catch {} return ''; }
handle('game:emulator', async ({ id }) => {
  const m = /^([a-z0-9]+):(.+)$/i.exec(String(id || '')), def = m && CONSOLES.find(c => c.id === m[1]);
  if (!def) throw new Error('Only console games can have their own emulator.');
  const { sc } = gameFile(def.id, m[2]), file = m[2], cur = gameEmuOverride(def.id, file), tid = titleIdOf(def.id, file);
  const shelfExe = paths.expand(sc.emulator || ''), name = p => path.basename(path.dirname(p)) || path.basename(p);
  const made = [...new Set([shelfExe, ...(cfg.emuSeen || []).map(paths.expand)])].filter(p => p && p !== cur && emuMadeFor(p, tid) && paths.isFile(p));
  const sugg = made.find(p => p !== shelfExe) || '';
  const buttons = ['Choose an emulator…'], acts = ['pick'];
  if (sugg) { buttons.push(`Use ${name(sugg)} (made for this game)`); acts.push('sugg'); }
  if (cur) { buttons.push(`Use the shelf's ${def.emulatorName}`); acts.push('default'); }
  buttons.push('Cancel'); acts.push('cancel');
  const detail = (cur ? `This game runs in:\n${cur}` : `This game runs in the shelf's ${def.emulatorName}:\n${shelfExe || '(not set up)'}`) + '\n\nPick a different build just for this game, e.g. a fork tuned for it.';
  const r = await dialog.showMessageBox(alive() ? win : undefined, { type: 'question', title: 'Emulator for this game', message: 'Which emulator should this game use?', detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
  const act = acts[r.response] || 'cancel'; let exe = '';
  if (act === 'cancel') return { ok: false, canceled: true, games: cfg.games };
  if (act === 'pick') { const f = await openDialog(alive() ? win : undefined, { title: `Emulator for this game (${def.emulatorName} or a build of it)`, defaultPath: cur || shelfExe || undefined, properties: ['openFile'], filters: linux.isLinux ? undefined : [{ name: 'Programs', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }] }); if (f.canceled || !f.filePaths || !f.filePaths[0]) return { ok: false, canceled: true, games: cfg.games }; exe = f.filePaths[0]; }
  if (act === 'sugg') exe = sugg;
  const games = { ...(cfg.games || {}) };
  if (act === 'default' || (exe && path.resolve(exe).toLowerCase() === path.resolve(shelfExe || '.').toLowerCase())) { const o = { ...(games[id] || {}) }; delete o.emulator; if (Object.keys(o).length) games[id] = o; else delete games[id]; } else games[id] = { ...(games[id] || {}), emulator: exe }; // (beta.8: the game's own name stays)
  applyCfg({ ...cfg, games });
  log('Game emulator:', id, '→', games[id] ? games[id].emulator : 'shelf default');
  return { ok: true, games: cfg.games };
});
// Switch 2: every Eglantine build in the emulator folders (people keep several forks; Play asks which one), the one to
// offer first for a game (its last pick, its Details → Emulator choice, then the shelf's), and whether the game is a .nup
// (beta.3) the folders and single builds added in Settings → Switch 2 → Builds (plain paths, at most 20 of each)
const sw2Added = k => { const v = (cfg.systems.sw2 || {})[k]; return Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x && x.length <= 1024))].slice(0, 20) : []; };
function sw2Roots() {
  const r = [path.join(paths.appRoot(), 'Switch 2 emu'), ...sw2Added('buildDirs')], e = emuPath((cfg.systems.sw2 || {}).emulator || '');
  // (beta.3) from the shelf's build up to the TOP folder that looks like a builds folder ("Switch 2 emu" above
  // "Selvet Forks\…\eglantine.exe"), six levels at most: three levels stopped one short, so a copy of Boxshelf kept away from
  // its builds found only the shelf's own fork. The widest folders come first, so builds are named from the top.
  if (e) { let d = path.dirname(e), top = null; for (let i = 0; i < 6 && path.dirname(d) !== d; i++) { if (/switch ?2|eglantine|forks?/i.test(path.basename(d))) top = d; d = path.dirname(d); } if (top) r.push(top); }
  const u = [...new Set(r.map(p => path.resolve(p).toLowerCase()))].map(k => r.find(p => path.resolve(p).toLowerCase() === k));
  return u.sort((a, b) => a.length - b.length);
}
// (1.82) the builds in the build folders, plus this game's own choice and the shelf's build when they sit elsewhere (the
// picker used to leave them out, and Play then turned them down); (beta.3) and the single builds added in Settings
// (beta.11) builds removed in Settings (sw2.buildHidden: their exes) are left out, wherever they were found; adding one
// again brings it back
async function sw2BuildList(file) {
  const low = p => path.resolve(p || '.').toLowerCase(), hidden = new Set(sw2Added('buildHidden').map(low));
  const list = (await nx2.builds(sw2Roots())).filter(b => !hidden.has(low(b.exe)));
  for (const [exe, hint] of [[file ? gameEmuOverride('sw2', file) : '', "This game's"], [emuPath((cfg.systems.sw2 || {}).emulator || ''), 'Shelf'], ...sw2Added('buildExes').map(x => [x, 'Added'])]) {
    if (!exe || hidden.has(low(exe)) || list.some(b => low(b.exe) === low(exe)) || !paths.isFile(exe)) continue;
    const b = await nx2.buildOf(exe, hint); if (b) list.push(b);
  }
  return list;
}
// (beta.11) "+ Add another emulator" at Play: one more Switch 2 build, kept with the ones added in Settings
handle('sw2:addBuild', async ({ exe } = {}) => {
  if (typeof exe !== 'string' || !exe || exe.length > 1024 || !paths.isFile(exe)) throw new Error('That file was not found.');
  if (process.platform === 'win32' && !/\.exe$/i.test(exe)) throw new Error('Choose the emulator\'s program (.exe).');
  const low = p => path.resolve(p).toLowerCase(), s = { ...(cfg.systems.sw2 || {}) };
  s.buildHidden = sw2Added('buildHidden').filter(x => low(x) !== low(exe));
  const added = sw2Added('buildExes'); if (!added.some(x => low(x) === low(exe))) s.buildExes = [...added, exe].slice(0, 20);
  cfg = persistCfg(config.normalize({ ...cfg, systems: { ...cfg.systems, sw2: s } }));
  return { ok: true };
});
handle('sw2:builds', async ({ file }) => {
  const list = await sw2BuildList(file), id = 'sw2:' + file, low = p => path.resolve(p || '.').toLowerCase();
  const nup = /\.nup$/i.test(String(file || '')), ok = b => !nup || b.nup;
  const want = [((cfg.ui.sw2Last || {})[id]) || '', gameEmuOverride('sw2', file), emuPath((cfg.systems.sw2 || {}).emulator || '')].filter(Boolean).map(low);
  const first = want.map(w => list.find(b => low(b.exe) === w && ok(b))).find(Boolean) || list.filter(ok).sort((a, b) => b.date - a.date)[0];
  return { builds: list, nup, first: first ? first.exe : '' };
});
handle('launch:game', async ({ systemId, file, emulator }) => {
  let { sc } = gameFile(systemId, file);
  // Switch 2: the build chosen at Play (only one of the listed builds), remembered as this game's first offer next time
  if (systemId === 'sw2' && emulator) {
    const b = (await sw2BuildList(file)).find(x => path.resolve(x.exe).toLowerCase() === path.resolve(emulator).toLowerCase());
    if (!b) throw new Error(`That Switch 2 build isn't in the emulator folders any more (${emulator}).`);
    if (/\.nup$/i.test(file) && !b.nup) throw new Error(`${b.label} can't open .nup games. Choose a newer build.`);
    const last = { ...(cfg.ui.sw2Last || {}), ['sw2:' + file]: b.exe }; try { applyCfg({ ...cfg, ui: { ...cfg.ui, sw2Last: last } }); } catch (e) { log('Switch 2: last build not remembered:', e.message); } // (beta.8: only a preference: a locked settings file mustn't stop the game)
    log('Switch 2 build:', b.label); sc = { ...sc, emulator: b.exe };
  } else {
  // this game's own emulator build, when one was chosen for it
  const own = gameEmuOverride(systemId, file);
  if (own) { if (!paths.isFile(own)) throw new Error(`This game's own emulator isn't there any more (${own}). Choose another in its Details → Emulator, or go back to the shelf's.`); sc = { ...sc, emulator: own }; }
  else sc = { ...sc, emulator: emuPath(sc.emulator) }; // the real path for everything below (Azahar's SD card folder, Dolphin's settings), not "{app}\…" or "%VAR%\…"
  // (Switch 2 started without a choice, its shelf build gone: the newest build that can open the game)
  if (systemId === 'sw2' && !paths.isFile(sc.emulator)) { const b = (await nx2.builds(sw2Roots())).filter(x => !/\.nup$/i.test(file) || x.nup).sort((a, c) => c.date - a.date)[0]; if (b) sc = { ...sc, emulator: b.exe }; }
  }
  if (launching || launcher.isRunning()) throw new Error(launcher.busyMessage()); // (beta.10: names what's running)
  launching = true;
  try {
    // (beta.12) a RomM game not on this PC yet: downloaded first (its progress on the boot slide), then started like any game
    if (!paths.isFile(file) && !paths.isDir(file) && rommOn()) { const got = await rommFetch(systemId, file); if (got) { file = got; if (alive()) win.webContents.send('library:changed', { romm: 1 }); } }
    return await launchGameNow(systemId, file, sc);
  } finally { launching = false; }
});
// (beta.6) RetroArch's cores: <its folder>\cores\<core>_libretro.dll, or the folder its own settings name
// (retroarch.cfg's libretro_directory; ":" there means RetroArch's own folder)
// (beta.11) the standalone emulators a retro shelf can use, by program name, and the options each one takes (DeSmuME and
// VisualBoyAdvance-M have no reliable fullscreen option: they open the game in their own window, fullscreen per their settings)
const ALT_ARGS = [[/desmume/i, '"{rom}"'], [/visualboyadvance|vbam/i, '"{rom}"'], [/mgba/i, '-f "{rom}"'], [/melonds/i, '-f "{rom}"'], [/duckstation/i, '-fullscreen -batch -nogui -- "{rom}"']];
const RA_CORE_NAME = { swanstation: 'SwanStation', mesen: 'Mesen', snes9x: 'Snes9x', mupen64plus_next: 'Mupen64Plus-Next', gambatte: 'Gambatte', mgba: 'mGBA', melondsds: 'melonDS DS', genesis_plus_gx: 'Genesis Plus GX', flycast: 'Flycast',
  mednafen_saturn: 'Beetle Saturn', mednafen_pce_fast: 'Beetle PCE Fast', fbneo: 'FinalBurn Neo', picodrive: 'PicoDrive', stella: 'Stella', handy: 'Handy', mednafen_wswan: 'Beetle Cygne', dosbox_pure: 'DOSBox Pure' };
function retroCore(exe, core) {
  const dir = path.dirname(exe), dirs = [path.join(dir, 'cores')];
  for (const cfgFile of [path.join(dir, 'retroarch.cfg'), path.join(process.env.APPDATA || '', 'RetroArch', 'retroarch.cfg')]) {
    let t = ''; try { t = fs.readFileSync(cfgFile, 'utf8'); } catch { continue; }
    const m = /^\s*libretro_directory\s*=\s*"([^"]*)"/m.exec(t); if (m && m[1] && m[1] !== 'default') dirs.unshift(m[1].replace(/^:[\\/]?/, dir + path.sep));
    break;
  }
  for (const d of dirs) { const f = path.join(d, core + '_libretro.dll'); if (paths.isFile(f)) return f; }
  return null;
}
async function launchGameNow(systemId, file, sc) {
  if (systemId === 'ps4' && /\.pkg$/i.test(file)) throw new Error('This PS4 game is still a .pkg package, which shadPS4 can\'t run. Extract it to a folder first (current shadPS4 builds no longer install packages themselves) with a PKG extractor such as PKG Editor or the ShadPS4Plus pkg_extractor, into a folder inside your PS4 games folder. Once that folder has an eboot.bin in it, the game shows up here as installed.');
  // (beta.12, Windows) a console started through RocketLauncher: its own path (launchViaRocket); none of the emulator
  // preparation below applies, RocketLauncher picks and starts the emulator itself
  if (rocket.useFor(systemId, cfg)) { const via = await launchViaRocket(systemId, file, sc); if (via) return via; }
  if (systemId === 'x360') sc.emulator = emucfg.resolveExe('x360', sc.emulator).exe; // (sc is this launch's copy: the saved setting is fixed on load / save)
  // (1.82) no emulator, or one that's gone: say which console and emulator, before anything is prepared for it (Dolphin's
  // settings, a 3DS .cia installed into Azahar's folder)
  { const def = CONSOLES.find(c => c.id === systemId), con = def ? def.name : systemId, emu = (def && def.emulatorName) || 'its emulator';
    if (!sc.emulator) throw new Error(`No emulator is set up for ${con} yet. Choose ${emu} in Settings → ${con} → Emulator.`);
    if (!paths.isFile(sc.emulator)) throw new Error(`${emu} isn't at ${sc.emulator} any more. Choose it again in Settings → ${con} → Emulator.`); }
  // GameCube startup sequence: tell Dolphin not to skip it, and lift the
  // loading screen early so the whole sequence is visible.
  const ipl = systemId === 'gc' && sc.useIpl;
  const extra = ipl ? ['-C', 'Dolphin.Core.SkipIPL=False'] : [];
  // Dolphin's warning pop-ups (e.g. "IPL file is not a known good dump") use its panic handlers.
  if (ipl && sc.hideDolphinWarnings) extra.push('-C', 'Dolphin.Interface.UsePanicHandlers=False');
  await setupPending(sc.emulator); // (beta.7) Set up for me, waiting for this emulator's settings file (made by its first run)
  emucfg.beforeLaunch(systemId, sc.emulator, { quitCombo: cfg.ui.quitCombo === false ? null : (cfg.ui.quitComboKeys || 'l3+r3') }); extra.push(...emucfg.launchArgs(systemId, sc.emulator)); // Dolphin: borderless + no stop question for this run only
  // 3DS .cia: installed into Azahar the first time (the boot slide shows how far), then the installed copy is booted
  let rom = systemId === 'n3ds' ? await n3ds.bootFile(file, sc.emulator, t => { if (alive()) win.webContents.send('launch:status', String(t)); }) : file;
  if (systemId === 'sw2') { rom = nx2.bootFile(file); log('Switch 2 launch:', path.basename(nx2.gameRoot(file)), rom !== file ? '(newest update)' : ''); } // (an unpacked game: its newest update's exefs\main)
  // PS5 (Kyty): the game's folder, with the Kyty launcher's settings, the game's patch file and the build's preset
  let env = null;
  // (PS5: Settings pointed at Kyty's launcher: the game itself starts in kyty_emulator.exe beside it; no emulator there = the launcher)
  if (systemId === 'ps5' && /^(kyty_)?launcher\.exe$/i.test(path.basename(sc.emulator || ''))) { const emu = path.join(path.dirname(sc.emulator), 'kyty_emulator.exe'); if (paths.isFile(emu)) sc.emulator = emu; else sc.viaLauncher = true; }
  // (PS5, "Start games through Kyty's launcher" on: the launcher itself, where the game is started; it takes no game to open)
  if (systemId === 'ps5' && sc.viaLauncher) { const ui = ['kyty_launcher.exe', 'launcher.exe'].map(n => path.join(path.dirname(sc.emulator || ''), n)).find(paths.isFile); if (!ui) throw new Error("Kyty's launcher (kyty_launcher.exe) isn't next to kyty_emulator.exe. Turn off \"Start games through Kyty's launcher\" in Settings → PS5, or check the emulator path."); log('PS5 launch: through the launcher'); sc.emulator = ui; sc.gameArgs = ''; sc.coverSeconds = 1; extra.length = 0; } // (the launcher applies the preset itself)
  else if (systemId === 'ps5') { const k = await kyty.spec(sc.emulator, file); /* (beta.10: async, the build's options probe no longer blocks) */ extra.push(...k.args); env = k.env; rom = k.dir; log('PS5 launch:', path.basename(rom), k.args.filter(x => /^--/.test(x)).join(' '), env ? '(preset)' : ''); }
  // (beta.8) Switch through Ryujinx (EmuDeck's usual pick): its own options, not Eden's / Citron's "-f -g" (an edited
  // command line is left as it is)
  if (systemId === 'sw' && /ryujinx|ryubing/i.test(path.basename(sc.emulator || '')) && /^\s*-f\s+-g\s+"\{rom\}"\s*$/.test(sc.gameArgs || '')) { sc = { ...sc, gameArgs: '--fullscreen "{rom}"' }; log('Switch launch: Ryujinx options'); }
  // (beta.11) a retro shelf started in another standalone emulator than the one its options are for (DeSmuME on the DS
  // shelf was handed melonDS's -f, which it refuses; mGBA or VisualBoyAdvance-M on a Game Boy shelf): that emulator's own
  // options, as long as the shelf's options are still the default ones (an edited command line is left as it is)
  { const def0 = CONSOLES.find(c => c.id === systemId), b = path.basename(sc.emulator || '');
    if (def0 && def0.retro && !/retroarch/i.test(b) && (!sc.gameArgs || sc.gameArgs === def0.gameArgs)) { const alt = ALT_ARGS.find(([re]) => re.test(b));
      if (alt && alt[1] !== sc.gameArgs) { sc = { ...sc, gameArgs: alt[1] }; log('Launch options for', b); } } }
  // (beta.6) RetroArch: this console's core from RetroArch's cores folder, fullscreen; a core that isn't downloaded yet is
  // said plainly (RetroArch itself would just open its menu)
  { const def = CONSOLES.find(c => c.id === systemId);
    if (def && def.raCore && (linux.isLinux ? linux.isRetroArch(sc.emulator) : /^retroarch\.exe$/i.test(path.basename(sc.emulator || '')))) {
      let core = linux.isLinux ? linux.retroCore(sc.emulator, def.raCore) : retroCore(sc.emulator, def.raCore); const nm = RA_CORE_NAME[def.raCore] || def.raCore;
      // (beta.7) a missing core is downloaded now, from the same place RetroArch's Online Updater gets it (Windows)
      if (!core && process.platform === 'win32') { const say = t => { if (alive()) win.webContents.send('launch:status', t); }; say(`Getting RetroArch's ${nm} core…`);
        try { core = await racores.get(sc.emulator, def.raCore, p => say(`Getting RetroArch's ${nm} core… ${p}%`)); } catch (e) { log('Core download failed:', def.raCore, e.message); throw new Error(`RetroArch doesn't have the ${nm} core for ${def.name} yet, and it couldn't be downloaded (${e.message}). In RetroArch: Main Menu → Online Updater → Core Downloader → ${nm}, then press Play again.`); } }
      if (!core) throw new Error(`RetroArch doesn't have the ${nm} core for ${def.name} yet. In RetroArch: Main Menu → Online Updater → Core Downloader → ${nm}, then press Play again.`);
      sc.gameArgs = `-f -L "${core}" "{rom}"`; log('RetroArch launch:', def.id, path.basename(core)); } }
  // Dolphin: the Wii remote is let go first, so Dolphin finds it as it always does
  if (systemId === 'gc' || systemId === 'wii' || /dolphin/i.test(path.basename(sc.emulator || ''))) await wiimote.pause();
  await taskbarHide(); // (beta.6) gone before the emulator's first window can show
  let r; try { r = launcher.launchGame(sc, rom, onExit, extra, env); } catch (e) { wiimote.resume(); taskbarShow('the game did not start'); throw e; } runKind = 'game'; pendingPower = null; const gTitle_ = gameTitleOf(systemId, file); launcher.setRunningName(gTitle_); { const d_ = CONSOLES.find(c => c.id === systemId); setOnlinePresence(d_ ? `${gTitle_} (${d_.name})` : gTitle_); } if (linux.isLinux) linuxpad.begin(() => closeGame()); // (beta.9: hold Select + Start to close it)
  // (Dolphin: once it has the remote, Boxshelf listens alongside for a held Home; listening only, nothing is sent)
  if (systemId === 'gc' || systemId === 'wii' || /dolphin/i.test(path.basename(sc.emulator || ''))) setTimeout(() => { if (launcher.isRunning()) wiimote.watch(); }, 4000);
  lastLaunch = { systemId, at: Date.now(), rom: String(rom || ''), exe: String(sc.emulator || '') }; historyStart(systemId + ':' + file); // (beta.12: the game and emulator, for the Linux Flatpak hint)
  const def = CONSOLES.find(c => c.id === systemId);
  if (cfg.ui.homeMenu !== false) homemenu.begin({ systemId, exe: sc.emulator, systemName: def ? def.name : systemId, hotkeys: sc.hotkeys });
  const base = ipl ? (sc.iplCoverSeconds ?? 2.5) : (+sc.coverSeconds || 0);
  // the loading screen now lifts the moment the game's window is up and fullscreen; the per-console seconds (plus a
  // margin for slow starts) are only the latest it waits
  watchPad({ appPid: r.pid, home: true });
  // the +3 s margin only when the helper is running (it lifts the cover early); without it the configured time is used
  // the boot slide (GameCube's too, since it lost its own insert animation) stays a fixed time so its progress line always
  // fills. When this console's boot video played instead (its switch on, a video added, no IPL), there is no slide to wait for.
  // The real GameCube startup (IPL) isn't held back either: the cover lifts as soon as Dolphin is up, so the whole sequence shows
  const vid = sc.bootOnLaunch !== false && !ipl && !!(themes.list([systemId])[systemId] || {}).boot;
  const slide = sc.insertAnim !== false && !vid && !ipl, minMs = slide ? 3500 : 800;
  const want = base > 0 ? base + (padwatch.isRunning() ? 3 : 0) : 0;
  const cover = coverWhileStarting(slide ? Math.max(want, minMs / 1000 + .5) : want);
  if (coverTimer) coverTimer.minMs = minMs;
  // no launch cover: still make sure the game ends up in front once its window exists
  const seq = ++noCoverSeq; // a quick quit and relaunch must not let this launch's timers act on the next game
  const qs = quitSeq; // (nor during a Quit: the game must not be pulled over the quit cover)
  if (!(cover > 0)) for (const ms of [2500, 4500]) setTimeout(() => { if (seq === noCoverSeq && qs === quitSeq && launcher.isRunning()) { padwatch.front(); homemenu.ready(); homemenu.raise(); } }, ms);
  return { ...r, cover };
}
// (beta.12, Windows) Play through RocketLauncher (docs/ROCKETLAUNCHER-PLAN.md): it brings its fade, bezels and pause menu
// and starts the emulator set up in RocketLauncherUI; Boxshelf waits on it like on any game (Home menu, playtime, the
// return). Boxshelf's own cover lifts at once (RocketLauncher's fade takes over) and it's never named as -f, so
// RocketLauncher leaves its window alone. "Every console": a console RocketLauncher has no system for keeps its
// emulator (null back: the usual launch)
async function launchViaRocket(systemId, file, sc) {
  const exe = cfg.rocket && cfg.rocket.exe;
  if (!exe || !paths.isFile(exe)) throw new Error("RocketLauncher isn't where Settings → Consoles says. Find it again there, or start this console with its emulator.");
  const list = await rocket.systems(exe), system = String(sc.rocketSystem || '').trim() || rocket.nameFor(systemId, list);
  const a = rocket.argsFor({ system, file, list, plugin: cfg.rocket.frontend || '' });
  if (!a.known && cfg.rocket.mode === 'all' && sc.viaRocket !== true) return null;
  if (a.known && a.ready === false) throw new Error(`RocketLauncher has no emulator set for ${system} yet. Set one in RocketLauncherUI, or start this console with its emulator (Settings → Consoles).`);
  await taskbarHide();
  const t0 = Date.now();
  const done = info => { rocket.lastError(exe, t0).then(err => { if (err && info && !info.error && info.code !== -1) log('RocketLauncher said:', err); onExit(err && info && !info.error ? { ...info, error: 'RocketLauncher: ' + err } : info); }, () => onExit(info)); };
  let r; try { r = launcher.launchRocket(exe, a.args, done); } catch (e) { taskbarShow('the game did not start'); throw e; }
  runKind = 'game'; pendingPower = null; const gTitle_ = gameTitleOf(systemId, file); launcher.setRunningName(gTitle_); { const d_ = CONSOLES.find(c => c.id === systemId); setOnlinePresence(d_ ? `${gTitle_} (${d_.name})` : gTitle_); }
  log('RocketLauncher launch:', systemId, '-s', system, a.inRoms ? '(by name)' : '(by path)');
  lastLaunch = { systemId, at: Date.now() }; historyStart(systemId + ':' + file);
  const def = CONSOLES.find(c => c.id === systemId);
  if (cfg.ui.homeMenu !== false) homemenu.begin({ systemId, exe, systemName: def ? def.name : systemId, hotkeys: {} });
  watchPad({ appPid: r.pid, home: true });
  return { ...r, cover: coverWhileStarting(1) };
}
// ---------- (beta.12) RomM, a self-hosted game library (main/romm.js) ----------
// Its games join their console's shelf at the place they'll have once downloaded (<the console's first games folder>\
// <RomM's file name>, so favourites and playtime carry over), with a cloud badge until then. Play downloads one first,
// its progress on the boot slide, B cancels (the part kept for a resume). The library is the saved copy at once and a
// background sync once the shelf is up; covers are RomM's until Boxshelf's own art arrives.
let rommLib = null, rommSyncing = null, rommDl = null, rommLocal = null, rommSyncedOnce = false;
// (beta.12) RomM's sign-in token belongs to the server it was paired with (keys.rommTokenServer, its origin): it's never
// sent anywhere else. A token saved before this (no origin with it) is taken as the saved server's, once.
function rommApply() { const r = cfg.romm || {}, k = cfg.keys || {}; try { romm.setServer(r.server || '', { skipTlsVerify: !!r.skipTls }); const o = romm.originOf(r.server); let t = k.rommToken || '';
  if (t && !k.rommTokenServer && o) cfg.keys = { ...k, rommTokenServer: o }; else if (t && k.rommTokenServer !== o) t = '';
  romm.setToken(t); } catch (e) { log('RomM', e.message); } }
// a Settings save: the token stays only while the server address still leads to the one it was paired with
function rommKeysFor(next) { const k = cfg.keys || {}, o = romm.originOf(next && next.romm && next.romm.server), bound = k.rommTokenServer || romm.originOf(cfg.romm && cfg.romm.server);
  const keep = !!k.rommToken && !!o && o === bound; if (k.rommToken && !keep) log('RomM: the server address changed, so the old sign-in was dropped (it belongs to the other server)');
  return { rommToken: keep ? k.rommToken : '', rommTokenServer: keep ? bound : '' }; }
const rommOn = () => !!(cfg.romm && cfg.romm.server && (cfg.keys || {}).rommToken);
const rommDir = sysId => { const d = ((cfg.systems[sysId] || {}).romDirs || [])[0]; return d ? (emuPath(d) || d) : path.join(app.getPath('userData'), 'RomM games', sysId); };
const rommSafe = n => String(n || 'game').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'game';
// where each downloaded RomM game ended up (a multi-file game's launch file is inside its own folder)
const rommLocalFile = () => path.join(app.getPath('userData'), 'romm-local.json');
function rommLocalGet() { if (!rommLocal) { try { rommLocal = JSON.parse(fs.readFileSync(rommLocalFile(), 'utf8')) || {}; } catch { rommLocal = {}; } } return rommLocal; }
function rommLocalSet(id, file) { const m = rommLocalGet(); m[id] = file; try { fs.writeFileSync(rommLocalFile(), JSON.stringify(m)); } catch {} }
async function rommLoad() { if (!rommOn()) { rommLib = null; return null; } try { rommLib = await romm.cached(); } catch { rommLib = null; } return rommLib; }
// this console's RomM games not already on the shelf (by place, by where a download went, or by title)
function rommGames(sysId, local) {
  const L = (rommOn() && cfg.romm.cloud !== false && rommLib && rommLib.consoles && rommLib.consoles[sysId]) || []; if (!L.length) return [];
  const dir = rommDir(sysId), have = new Set(local.map(g => String(g.file || '').toLowerCase())), titles = new Set(local.map(g => String(g.title || '').toLowerCase())), done = rommLocalGet(), out = [];
  for (const r of L) {
    const file = path.join(dir, rommSafe(r.file || r.title)), got = done[r.rommId];
    if (have.has(file.toLowerCase()) || (got && have.has(String(got).toLowerCase())) || titles.has(String(r.title || '').toLowerCase())) continue;
    // downloaded already, somewhere the scan doesn't look (a console with no games folder: Boxshelf's own RomM folder):
    // shown as the game on this PC, not with the cloud
    const here = got && paths.isFile(got) ? got : null, f = here || file;
    out.push({ kind: 'rom', id: sysId + ':' + f, title: r.title, file: f, ext: path.extname(f).slice(1).toLowerCase(), sizeBytes: r.size || null, added: Date.parse(r.updatedAt || '') || 0,
      info: covers.gameInfo(sysId, r.title) || { summary: r.summary || undefined, released: r.released || undefined, genres: r.genres || undefined },
      art: { front: r.cover ? fileUrl(r.cover) : null }, romm: { id: r.rommId, size: r.size || null, multi: !!r.multi, cloud: !here } });
  }
  return out;
}
// a background sync (the saved copy shows meanwhile); a change refreshes the shelf. Never two at once
function rommSync(delayMs = 0) {
  if (rommSyncing || !rommOn()) return rommSyncing;
  rommSyncing = new Promise(r => setTimeout(r, delayMs)).then(async () => {
    const before = rommLib ? rommLib.count : -1, lib = await romm.library({}); if (!lib || !lib.consoles) return lib; rommLib = lib;
    const cv = await romm.covers(Object.values(lib.consoles).flat(), { max: 500 }).catch(() => null); if (cv && cv.downloaded) rommLib = await romm.cached().catch(() => rommLib);
    if (alive() && (lib.fetched || lib.removed || (cv && cv.downloaded) || before !== lib.count)) win.webContents.send('library:changed', { romm: 1 });
    log('RomM sync:', lib.count, 'games', lib.offline ? '(offline: the saved copy)' : '', lib.skipped && lib.skipped.platforms ? `(${lib.skipped.platforms} platforms Boxshelf has no shelf for)` : ''); return lib;
  }).catch(e => { log('RomM sync', e.message); return null; }).finally(() => { rommSyncing = null; });
  return rommSyncing;
}
// Play on a RomM game not downloaded yet: downloaded into its console's folder first (→ the file to start)
async function rommFetch(sysId, file) {
  const lo = String(file).toLowerCase(), L = (rommLib && rommLib.consoles && rommLib.consoles[sysId]) || [], dir = rommDir(sysId);
  const r = L.find(x => path.join(dir, rommSafe(x.file || x.title)).toLowerCase() === lo); if (!r) return null;
  const got = rommLocalGet()[r.rommId]; if (got && paths.isFile(got)) return got;
  const say = t => { if (alive()) win.webContents.send('launch:status', t); };
  const mb = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
  say('Getting it from RomM…'); const ctl = new AbortController(); rommDl = ctl;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const res = await romm.download(r, dir, { signal: ctl.signal, onProgress: p => { if (p && p.phase === 'download' && p.total) say(`Getting it from RomM… ${Math.floor(100 * p.received / p.total)}% of ${mb(p.total)}`); else if (p && p.phase === 'extract') say('Unpacking it…'); } });
    const f = res && (res.file || res.zip); if (!f || !paths.isFile(f)) throw new Error("RomM's download didn't give a game file.");
    if (res.zip && res.extracted === false) throw new Error(`${r.title} came as a zip Boxshelf couldn't unpack. It's in ${dir}.`);
    rommLocalSet(r.rommId, f); log('RomM download:', r.title, res.resumed ? '(resumed)' : '', res.verified ? '(checked)' : ''); return f;
  } catch (e) {
    const why = { aborted: 'Download stopped. Press Play again to carry on from where it was.', 'hash-mismatch': "The download didn't match RomM's copy (checked and removed). Press Play to try again.", auth: 'RomM turned Boxshelf away: pair it again in Settings → Accounts & services → RomM.', 'not-found': "RomM doesn't have that game any more.", 'no-space': 'Not enough free space for it on this drive.', offline: "RomM can't be reached right now." }[e && e.code];
    throw new Error(why || ('RomM: ' + (e && e.message || e)));
  } finally { if (rommDl === ctl) rommDl = null; }
}
handle('romm:cancel', () => { if (rommDl) { rommDl.abort(); return true; } return false; });
handle('romm:status', async () => ({ ...romm.status(), server: (cfg.romm || {}).server || '', paired: rommOn(), count: rommLib ? rommLib.count : null, at: rommLib ? rommLib.at : null, offline: !!(rommLib && rommLib.offline), skipped: rommLib ? rommLib.skipped : null }));
const rommSaveToken = t => { cfg = persistCfg(config.normalize({ ...cfg, keys: { ...cfg.keys, rommToken: String(t || ''), rommTokenServer: t ? romm.originOf(cfg.romm && cfg.romm.server) : '' } })); rommApply(); };
handle('romm:pairStart', async () => { rommApply(); const r = await romm.pairStart(); if (r && r.qrUrl) { try { r.qr = companion.qrSvg(r.qrUrl); } catch {} } return r; }); // (the QR drawn here, as the phone companion's)
handle('romm:pairPoll', async () => { const r = await romm.pairPoll(); if (r && r.state === 'ok' && r.token) { rommSaveToken(r.token); rommLoad().then(() => rommSync(0)); delete r.token; } return r; });
handle('romm:pairCancel', () => { romm.pairCancel(); return true; });
handle('romm:pairCode', async ({ code } = {}) => { rommApply(); const r = await romm.pairWithCode(String(code || '').replace(/\D/g, '').slice(0, 12)); if (r && r.token) { rommSaveToken(r.token); rommLoad().then(() => rommSync(0)); return { ok: true }; } return { ok: false, error: (r && r.error) || 'not accepted' }; });
handle('romm:test', async () => { rommApply(); return romm.test(); });
handle('romm:sync', async () => { const r = await rommSync(0); return r ? { ok: !r.error, count: r.count, offline: !!r.offline, error: r.error || null } : { ok: false, error: rommOn() ? 'busy' : 'not paired' }; });
handle('romm:forget', async () => { await romm.forget().catch(() => {}); rommLib = null; rommSaveToken(''); if (alive()) win.webContents.send('library:changed', { romm: 1 }); return true; });
// (beta.12) Close Steam, from the card after a Steam game when Steam still holds the controller: Steam's own exit link,
// so it closes the way its menu would (not while a game Boxshelf watches is still running)
handle('steam:exit', async () => { if (launcher.isRunning()) throw new Error('A game is still running.'); await shell.openExternal('steam://exit'); log('Steam: asked to close (it was holding the controller)'); return true; });
// Settings → Consoles: RocketLauncher found on this PC (its path, or ''), and its systems with the name each console
// would use (no ROM paths go to the page: a count only)
handle('rocket:find', async () => process.platform === 'win32' ? rocket.find() : '');
handle('rocket:systems', async ({ exe } = {}) => {
  const e = String(exe || (cfg.rocket && cfg.rocket.exe) || ''); if (process.platform !== 'win32' || !e || !paths.isFile(e)) return { list: [], names: {} };
  const list = await rocket.systems(e, true), names = {};
  for (const c of CONSOLES) { const n = rocket.nameFor(c.id, list); const s = list.find(x => x.name === n); names[c.id] = { name: n, known: !!s, ready: s ? s.ready : false, folders: s ? s.romPaths.length : 0,
    matches: !!(s && (((cfg.systems[c.id] || {}).romDirs) || []).some(d => s.romPaths.some(p => path.resolve(p).toLowerCase() === path.resolve(emuPath(d) || d).toLowerCase()))) }; }
  return { list: list.map(s => ({ name: s.name, ready: s.ready })), names };
});
// (busy check first: a .cia still installing, or a game running, must not have its emulator's settings rewritten under it)
const busyCheck = () => { if (launching || launcher.isRunning()) throw new Error(launcher.busyMessage()); }; // (beta.10: names what's running)
// (beta.10) a game's title for that message: the shelf's (the last scan), else its file or folder name, never a path
function gameTitleOf(systemId, file) { try { const s = (lastLib || []).find(x => x.id === systemId), lo = String(file).toLowerCase(), g = s && (s.games || []).find(x => String(x.file || '').toLowerCase() === lo); if (g && g.title) return String(g.title); } catch {}
  const f = String(file || ''), b = path.basename(f); return /^(main|.+\.rpx)$/i.test(b) ? path.basename(path.dirname(path.dirname(f))) : /^(eboot\.bin|default\.xex)$/i.test(b) ? path.basename(path.dirname(f)) : path.basename(b, path.extname(b)); } // (a Wii U code\x.rpx, a Switch 2 exefs\main: the game's folder)
handle('launch:emulator', async ({ systemId }) => { let sc = cfg.systems[systemId]; if (!sc) throw new Error('Unknown system.'); busyCheck(); sc = { ...sc, emulator: emuPath(sc.emulator) }; const wii = systemId === 'gc' || systemId === 'wii' || /dolphin/i.test(path.basename(sc.emulator || '')); if (wii) { launching = true; try { await wiimote.pause(); } finally { launching = false; } } /* (beta.8: a second press while the Wii remote lets go is refused, as for games) */ /* (Dolphin: the Wii remote is its) */ if (systemId === 'ps5') { const ui = ['kyty_launcher.exe', 'launcher.exe'].map(n => path.join(path.dirname(sc.emulator || ''), n)).find(paths.isFile); if (ui) sc.emulator = ui; } /* (PS5: kyty_emulator needs a game; the emulator on its own is Kyty's launcher) */ emucfg.beforeLaunch(systemId, sc.emulator, { quitCombo: cfg.ui.quitCombo === false ? null : (cfg.ui.quitComboKeys || 'l3+r3') }); taskbarShow('an emulator in its own window'); /* (beta.10: still hidden from the last game, it stayed gone over the emulator's window) */ let r; try { r = launcher.launchEmulator(sc, onExit); } catch (e) { if (wii) wiimote.resume(); throw e; } /* (1.82: a missing exe no longer leaves the remote paused) */ runKind = 'emulator'; pendingPower = null; { const def = CONSOLES.find(c => c.id === systemId); if (def) { launcher.setRunningName(def.emulatorName || def.name); setOnlinePresence(def.name || def.emulatorName); } } watchPad(); return r; });
handle('launch:app', async ({ appId, link }) => {
  const a = cfg.apps[appId]; if (!a) throw new Error('Unknown app.'); busyCheck();
  const args = appId === 'stremio' && /^stremio:\/\/\/detail\/[^\s"]+$/.test(String(link || '')) ? [String(link)] : []; // a title from the museum's movie shelves opens on its page
  if (a.fullscreen !== false) { launching = true; try { await taskbarHide(); } finally { launching = false; } } // (beta.6; an app kept in a window keeps the taskbar. launching: a second press meanwhile is refused)
  else taskbarShow('an app in a window'); // (beta.10: still hidden from the last game, it stayed gone over the app's window)
  let r; try { r = launcher.launchApp(a.path, onExit, args); } catch (e) { taskbarShow('the app did not start'); throw e; } runKind = 'app'; pendingPower = null;
  // Media apps don't speak controller: drive the pointer from the pad and press the fullscreen key once the window is up.
  const meta = APPS.find(x => x.id === appId); if (meta && meta.name) { launcher.setRunningName(meta.name); setOnlinePresence(meta.name); }
  if (cfg.ui.homeMenu !== false) homemenu.begin({ systemId: 'media', exe: a.path, systemName: 'Media', title: meta ? meta.name : appId, hotkeys: {} });
  watchPad({ mouse: a.padMouse === true, appPid: r.pid, fullscreenKey: a.fullscreen === false ? null : (a.fullscreenKey || 'F11'), home: true });
  // Same loading screen as the games: it stays in front while the app's window opens (windowed at first) and goes
  // fullscreen, and lifts as soon as the app is fullscreen (padwatch GAMEFS); the seconds are only the latest it waits
  const cover = coverWhileStarting(a.fullscreen === false ? 4 : (+a.coverSeconds || 15));
  return { ...r, cover };
});
// (beta.12) Seamless play on: the Steam game is watched (main/seamless.js: the loading cover, Home menu, playtime and the
// return to the shelf); off: handed to Steam as before
handle('launch:steam', ({ appid }) => { try { setOnlinePresence(`${pcTitleOf('steam-' + appid, 'Steam game')} (Steam)`); } catch {}
  // (beta.12, Linux) watched there too (main/gamewatch.js reads /proc): playtime, the shelf hidden while it runs and back
  // after, and the View + Menu hold closes it
  if (linux.isLinux && /^\d{1,10}$/.test(String(appid))) { const r = seamless.launchWatched({ kind: 'steam', id: 'steam-' + appid, appid: String(appid), dir: gamewatch.steamInstallDir([steamMain, cfg.steam.path], appid), title: pcTitleOf('steam-' + appid, 'Steam game'), systemName: 'Steam', start: () => launcher.launchSteam(appid) });
    return Promise.resolve(r).then(x => { if (launcher.isRunning()) linuxpad.begin(() => closeGame()); return x; }); } /* (its playtime: launchWatched's 'started') */
  if (seamless.on() && /^\d{1,10}$/.test(String(appid))) return seamless.launchWatched({ kind: 'steam', id: 'steam-' + appid, appid: String(appid), dir: gamewatch.steamInstallDir([steamMain, cfg.steam.path], appid), title: pcTitleOf('steam-' + appid, 'Steam game'), systemName: 'Steam', start: () => launcher.launchSteam(appid) });
  return launcher.launchSteam(appid);
});
// (beta.12) a PC game's title from the last scan (for the log and the Home menu; never a path)
function pcTitleOf(id, def) { try { for (const s of lastLib || []) { const g = (s.games || []).find(x => x.id === id); if (g && g.title) return String(g.title).slice(0, 120); } } catch {} return def; }
const STORE_NAME = { epic: 'Epic Games', ubisoft: 'Ubisoft', ea: 'EA', xbox: 'Xbox', gog: 'GOG' };
// (beta.4) a PC game that isn't Steam's, named by id only: Epic's go through its launcher's link; Quiver's and the ones
// added by hand start their own program in its own folder (recomps read their files from there), with the Home menu and
// the quit buttons like any app
handle('launch:pc', async ({ id }) => {
  const g = pcgames.byId(id); if (!g) throw new Error("That game isn't on the shelf any more. The shelf is refreshing; try again in a moment.");
  // (beta.12) Seamless play on: a store game (Epic, Ubisoft, EA, Xbox) is still started through its store, and watched
  if (seamless.on() && ((g.uri && /^(com\.epicgames\.launcher|uplay|origin2):\/\//i.test(g.uri)) || (g.shellApp && /^[\w.-]+_[a-z0-9]+![\w.-]+$/i.test(g.shellApp))))
    return seamless.launchWatched({ kind: g.source, id: g.id, dir: g.dir || '', exe: g.exe || '', title: g.title, systemName: STORE_NAME[g.source] || 'PC',
      start: () => { if (g.uri) return shell.openExternal(g.uri); const p = spawn('explorer.exe', ['shell:AppsFolder\\' + g.shellApp], { detached: true, stdio: 'ignore' }); p.on('error', e => log('Xbox launch', e.message)); p.unref(); } });
  // through its store's launcher (Epic, and from beta.7 Ubisoft Connect and the EA app: their sign-in, cloud saves, overlay)
  if (g.uri && /^(com\.epicgames\.launcher|uplay|origin2):\/\//i.test(g.uri)) { busyCheck(); log('PC launch:', g.source, g.title); return shell.openExternal(g.uri).then(() => ({ external: true })); }
  // (beta.7) an Xbox / Game Pass game is a Windows app: started as one (its package family and app id, from pcgames.xboxGames)
  if (g.shellApp) { if (!/^[\w.-]+_[a-z0-9]+![\w.-]+$/i.test(g.shellApp)) throw new Error("Couldn't start that Xbox game."); busyCheck(); log('PC launch: Xbox,', g.title);
    const p = spawn('explorer.exe', ['shell:AppsFolder\\' + g.shellApp], { detached: true, stdio: 'ignore' }); p.on('error', e => log('Xbox launch', e.message)); p.unref(); return { external: true }; }
  if (!paths.isFile(g.exe)) throw new Error(`${g.title} isn't at ${g.exe} any more. ${g.source === 'quiver' ? 'Check it in Quiver Launcher.' : g.source === 'gog' ? 'Check it in GOG Galaxy.' : 'Remove it in Settings → Custom games and add it again.'}`);
  busyCheck();
  launching = true; try { await taskbarHide(); } finally { launching = false; } // (beta.6)
  let r; try { r = launcher.launchApp(g.exe, onExit, launcher.buildArgs(g.args || '', '')); } catch (e) { taskbarShow('the game did not start'); throw e; } runKind = 'app'; pendingPower = null; launcher.setRunningName(g.title); setOnlinePresence(`${g.title} (PC)`); log('PC launch:', g.source, g.title);
  if (cfg.ui.homeMenu !== false) homemenu.begin({ systemId: 'pc', exe: g.exe, systemName: g.source === 'quiver' ? 'Quiver' : g.source === 'gog' ? 'GOG' : 'Custom', title: g.title, hotkeys: {} });
  if (seamless.on()) historyTrack(g.id); // (beta.12, Seamless play: its playtime too)
  watchPad({ mouse: false, appPid: r.pid, fullscreenKey: null, home: true });
  return { ...r, cover: coverWhileStarting(10) };
});
// (beta.5) a PC game's cover picker (main/pccovers.js): the page names the game by id and an option by key only
const pcLookup = id => { id = String(id || ''); const m = /^steam-(\d{1,10})$/.exec(id); if (m) return { id, appid: m[1], title: '' }; const g = pcgames.byId(id); return g ? { id, title: g.title } : null; };
const pcGameOf = id => { const g = pcLookup(id); if (!g) throw new Error("That game isn't on the shelf any more."); return g; };
let pcCoverT = 0; // (beta.9: one shelf refresh for a run of covers, not one per cover)
// (beta.12) a chosen cover gets a new address each time (the same file name used to give the same bsfile:// address, so
// a second pick showed the old picture from the cache and the shelf saw nothing new), and the shelf's rescan is a fresh
// one: a scan already running may have read the covers before this one was saved
const pcCoverBump = id => { const f = id && pccovers.cover(id); if (f) artVer.set(path.resolve(f).toLowerCase(), Date.now()); };
const pcCoverChanged = id => { pcCoverBump(id); scanCfg = null; clearTimeout(pcCoverT); pcCoverT = setTimeout(() => { if (alive()) win.webContents.send('library:changed', { pcCover: 1 }); }, 700); };
// (beta.9) the games that never get an automatic cover (Quiver's, and programs added by hand or from Playnite: their
// names often match an unrelated game) and have none chosen yet: the batch cover finder's list
handle('pccover:missing', () => pcgames.all().filter(g => (g.source === 'custom' || g.source === 'quiver') && !pccovers.cover(g.id)).map(g => ({ id: g.id, title: g.title, source: g.source })));
handle('pccover:options', ({ id, term }) => { const g = pcGameOf(id), t = String(term || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return pccovers.options(t ? { id: g.id, title: t, term: true } : g); }); // (beta.5: term = Search by name, a title instead of the game's own / its Steam app)
handle('pccover:use', async ({ id, key }) => { pcGameOf(id); await pccovers.use(id, key); pcCoverChanged(id); return { ok: true }; });
handle('pccover:own', async ({ id }) => {
  pcGameOf(id);
  const r = await openDialog(alive() ? win : undefined, { title: 'Choose a cover', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  await pccovers.own(id, r.filePaths[0]); pcCoverChanged(id); return { ok: true };
});
handle('pccover:reset', ({ id }) => { pcGameOf(id); pccovers.reset(id); pcCoverChanged(); return { ok: true }; });
// (beta.5) Details → Rename: a console game by its console and file (it must be one the scanner could find), a PC game by
// id. An empty name (or the file's own) goes back to the scanned one. The shelf rescans; art and manuals look it up by
// the new name from then on
handle('game:rename', ({ systemId, file, id, title }) => {
  let key;
  if (systemId && file) { const def = CONSOLES.find(c => c.id === systemId); if (!def || !cfg.systems[def.id]) throw new Error('Unknown console.'); gameFile(def.id, file); key = def.id + ':' + file; }
  else { pcGameOf(id); key = String(id); }
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const games = { ...(cfg.games || {}) }, cur = { ...(games[key] || {}) };
  if (t) cur.title = t; else delete cur.title;
  if (Object.keys(cur).length) games[key] = cur; else delete games[key];
  applyCfg({ ...cfg, games }); log('Game renamed:', key.split(':')[0], t ? 'to a name of its own' : 'back to its file name');
  if (systemId) { try { artstudio.forget(systemId); } catch {} }
  return { ok: true, title: t };
});
// (beta.12) Details → Your play → Status: where the player is with a game, in their own words (kept per game id beside its
// own emulator and name, so the shelf can sort and filter by it later). '' clears it.
handle('game:status', ({ id, status }) => {
  const key = String(id == null ? '' : id).slice(0, 2048); if (!key) throw new Error('No game.');
  const s = config.GAME_STATUS.includes(status) ? status : '';
  const games = { ...(cfg.games || {}) }, cur = { ...(games[key] || {}) };
  if (s) cur.status = s; else delete cur.status;
  if (Object.keys(cur).length) games[key] = cur; else delete games[key];
  applyCfg({ ...cfg, games }); return { ok: true, games: cfg.games };
});
handle('pc:status', async () => { const pc = cfg.pc || {}; let epic = null; try { epic = pcgames.epicGames().length; } catch {}
  // (beta.7) each store's installed games, counted whether its switch is on or not (Settings says what it would add)
  const n = async f => { try { return (await f()).length; } catch { return null; } };
  const [gog, ubisoft, ea, xbox] = await Promise.all([n(pcgames.gogGames), n(pcgames.ubisoftGames), n(pcgames.eaGames), n(pcgames.xboxGames)]);
  return { quiver: pcgames.quiverRoots(pc.quiverPath)[0] || '', epic, gog, ubisoft, ea, xbox }; });
handle('pc:findQuiver', () => { const t0 = Date.now(), d = pcgames.quiverFind(); log('Find Quiver:', d ? 'found' : 'not found', Date.now() - t0, 'ms'); return d || ''; });
// the reading corner: your Magazines\ and Guides\ folders (the screen only ever names items by id)
handle('library:list', () => { try { library.setCacheRoot(path.join(app.getPath('userData'), 'library')); return library.list().map(i => ({ id: i.id, kind: i.kind, type: i.type, title: i.title, series: i.series || '', pages: i.pages || 0 })); } catch (e) { log('library', e.message); return []; } });
handle('library:cover', async ({ id, side }) => { const f = await library.cover(id, async (pdf, last) => { const p = await renderPdfCover(pdf, last); return p && p[0] ? Buffer.from(p[0].split(',')[1], 'base64') : null; }, side === 'back' ? 'back' : 'front').catch(e => { log('library cover', e.message); return null; }); if (!f) return null; try { return fileUrl(f) + '?v=' + Math.floor(fs.statSync(f).mtimeMs); } catch { return fileUrl(f); } });
// the museum's movie shelves: your Stremio library, read from Stremio's own storage on this PC
handle('stremio:library', async () => { const a = cfg.apps && cfg.apps.stremio; if (!a || a.enabled === false) return []; try { return await stremio.library(a.path); } catch (e) { log('Stremio library', e.message); return []; } });
handle('stremio:poster', async ({ id, url }) => { const f = await stremio.poster(String(id || ''), String(url || '')); if (!f) return null; try { return fileUrl(f) + '?v=' + Math.floor(fs.statSync(f).mtimeMs); } catch { return null; } });
handle('stremio:details', async ({ type, id }) => { const d = await stremio.details(String(type || 'movie'), String(id || '')).catch(e => { log('stremio details', e.message); return null; }); if (!d) return null; const u = f => { if (!f) return null; try { return fileUrl(f) + '?v=' + Math.floor(fs.statSync(f).mtimeMs); } catch { return null; } }; return Object.assign({}, d, { files: { background: u(d.files.background), logo: u(d.files.logo), disc: u(d.files.disc) } }); });
async function fanartTest(key) {
  try { const r = await net.fetch(`https://webservice.fanart.tv/v3/movies/tt0111161?api_key=${encodeURIComponent(String(key))}`); if (r.status === 401 || r.status === 403) return { ok: false, error: 'not accepted' }; const j = await r.json(); return j && j.name ? { ok: true } : { ok: false, error: j && j['error message'] || 'unexpected answer' }; } catch (e) { return { ok: false, error: e.message }; } }
// the museum's retro TV: ads looked up in the background (only once the TV is on), fetched when one plays
let tvScanning = false;
handle('tv:scan', async () => { if (tvScanning) return false; tvScanning = true;
  try { const games = [];
    // the shelves as last scanned (a full re-scan of every games folder here blocked the main process on each museum visit)
    if (lastLib) { for (const s of lastLib) if (s && s.kind === 'console' && Array.isArray(s.games)) s.games.forEach(g => games.push({ sysId: s.id, file: g.file, title: g.title })); }
    else for (const { def, cfg: sc } of sysList(CONSOLES.map(c => c.id))) { let gs = []; try { gs = await scanSystemAsync(def, sc); } catch {} gs.forEach(g => games.push({ sysId: def.id, file: g.file, title: g.title })); } // (beta.10: async scan)
    const n = await commercials.scan(games, { cancelled: () => !alive(), idle: async () => { await uiQuiet(); await gameIdle(); } }); if (n && alive()) win.webContents.send('tv:found', { n }); return true; }
  catch (e) { log('TV ads scan', e.message); return false; } finally { tvScanning = false; } });
handle('tv:list', () => commercials.list());
handle('tv:adFor', ({ systemId, file }) => commercials.adFor(String(systemId || ''), String(file || '')));
// only an ad Boxshelf itself found (matched by its key), never an id / file the page made up
handle('tv:local', async ({ ad }) => { const k = ad && typeof ad.key === 'string' ? ad.key : ''; const real = k && commercials.list().find(a => a.key === k); const f = real ? await commercials.local(real) : null; return f ? fileUrl(f) : null; });
handle('library:pages', async ({ id }) => { const p = await library.pages(id); return p.type === 'pdf' ? { type: 'pdf', url: fileUrl(p.file) } : { type: 'images', urls: p.files.map(fileUrl) }; });
handle('archive:search', ({ text, kind, page, plain }) => archive.search(text, kind === 'guide' ? 'guide' : 'magazine', page, !!plain));
handle('archive:check', ({ ids }) => archive.check(ids));
handle('archive:download', async ({ id, kind, title, series }) => {
  const k = kind === 'guide' ? 'guide' : 'magazine';
  // (beta.11) progress at most five times a second (it was every network chunk: ~1,000 messages per 50 MB), the last always
  let at = 0, tail = null; const send = (n, t, unit) => { if (alive()) win.webContents.send('archive:progress', { id, bytes: n, total: t, unit: unit || 'bytes' }); };
  const r = await archive.download(id, k, { title: typeof title === 'string' ? title : '', series: typeof series === 'string' ? series : '' }, (n, t, unit) => { const now = Date.now(); clearTimeout(tail); if (now - at >= 200 || (t && n >= t)) { at = now; send(n, t, unit); } else tail = setTimeout(() => { at = Date.now(); send(n, t, unit); }, 200); }).finally(() => clearTimeout(tail));
  return { existed: r.existed, name: path.basename(r.file), count: r.count || 0 };
});
handle('archive:cancel', ({ id }) => archive.cancel(String(id || ''))); // the download rejects with "Cancelled." and removes its half file
// Settings → Magazines & guides: the full paths, and magazines left in an earlier Boxshelf folder (copied, never moved)
handle('reading:where', () => ({ root: paths.readingRoot(), custom: !!cfg.ui.readingLibrary, magazines: library.folder('magazine'), guides: library.folder('guide') }));
const oldReading = () => paths.findOldReading({ current: paths.readingRoot(), logFile: LOG, known: (cfg.ui.installs || []).filter(x => typeof x === 'string'), home: require('os').homedir() });
handle('reading:old', () => oldReading());
let readingCopy = null;
handle('reading:import', async ({ root }) => {
  const offer = oldReading().find(o => o.root.toLowerCase() === String(root || '').toLowerCase()); // only a folder Boxshelf itself offered
  if (!offer) throw new Error('That folder has no magazines or guides to bring over.');
  if (readingCopy) throw new Error('Already copying.');
  readingCopy = { stop: false }; log('Reading: copying', offer.files, 'files from', offer.root, 'to', paths.readingRoot());
  try {
    const r = await paths.copyReading(offer.root, paths.readingRoot(), p => { if (alive()) win.webContents.send('reading:import', p); }, () => readingCopy.stop);
    log('Reading: copied', r.copied, 'skipped', r.skipped, 'failed', r.failed, r.lastError || '', r.cancelled ? '(stopped)' : '');
    if (r.copied && alive()) win.webContents.send('library:changed', { reading: r.copied });
    return r;
  } finally { readingCopy = null; }
});
handle('reading:importStop', () => { if (readingCopy) readingCopy.stop = true; return true; });
handle('library:open', ({ kind }) => { const d = library.folder(kind); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
handle('themes:list', () => {
  const ids = [...CONSOLES.map(c => c.id), 'pc', 'media'];
  const raw = themes.list(ids);
  const out = {};
  // theme files keep the same name when replaced, so the URL carries the file's mtime: a new file is a new URL (serveFile ignores the query)
  const vurl = p => { const u = fileUrl(p); if (!u) return null; try { return u + '?v=' + Math.floor(fs.statSync(p).mtimeMs); } catch { return u; } };
  for (const [id, t] of Object.entries(raw)) {
    out[id] = { logoPrev: !!themes.prevLogo(id), logo: vurl(t.logo), boot: vurl(t.boot), console: vurl(t.console), model: vurl(t.model), modelOpts: t.modelOpts || null, controller: vurl(t.controller), media: vurl(t.media), mediaOpts: t.mediaOpts || null };
    // a heavy 3D model is shown from its light copy once Boxshelf has made one (see models:saveOptimized); until then the
    // original is used and the screen is told it's worth optimizing
    for (const k of ['model', 'controller', 'media']) { const p = t[k]; if (!p || !/\.glb$/i.test(p)) continue; let st; try { st = fs.statSync(p); } catch { continue; } if (st.size < MODEL_HEAVY) continue;
      const op = optimizedPath(p, st); if (fs.existsSync(op)) out[id][k] = vurl(op); else (out[id].heavy = out[id].heavy || []).push(k); }
  }
  return out;
});
// the light copy of a heavy model, next to it in themes\<system>\.optimized\, named after the original's size and
// date so a replaced or edited model gets a fresh one (the original is never changed)
const MODEL_HEAVY = 8 * 1048576;
let noCoverSeq = 0;
// a model replaced or removed: its light copies go too (they'd never be used again)
function dropOptimized(systemId, kind) { try { const t = themes.list([systemId])[systemId], p = t && t[kind]; if (!p || !/\.(glb|gltf)$/i.test(p)) return; const dir = path.join(path.dirname(p), '.optimized'), base = path.basename(p, path.extname(p)).toLowerCase() + '-';
  for (const f of fs.readdirSync(dir)) if (f.toLowerCase().startsWith(base)) fs.unlinkSync(path.join(dir, f)); } catch {} }
function optimizedPath(p, st) { st = st || fs.statSync(p); return path.join(path.dirname(p), '.optimized', `${path.basename(p, path.extname(p))}-${st.size}-${Math.floor(st.mtimeMs)}.glb`); }
handle('models:saveOptimized', ({ systemId, kind, bytes }) => {
  if (!['model', 'controller', 'media'].includes(kind)) throw new Error('Unknown model.');
  const t = themes.list([systemId])[systemId], p = t && t[kind]; if (!p) throw new Error('No model.');
  const b = Buffer.from(bytes && bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength) : bytes || []);
  const st = fs.statSync(p);
  if (b.length < 1024 || b.toString('latin1', 0, 4) !== 'glTF' || b.length >= st.size) throw new Error('Not a usable model.');
  const op = optimizedPath(p, st), dir = path.dirname(op), base = path.basename(p, path.extname(p)).toLowerCase() + '-';
  fs.mkdirSync(dir, { recursive: true });
  try { for (const f of fs.readdirSync(dir)) if (f.toLowerCase().startsWith(base) && path.join(dir, f) !== op) fs.unlinkSync(path.join(dir, f)); } catch {} // older copies of this model
  fs.writeFileSync(op + '.tmp', b); fs.renameSync(op + '.tmp', op);
  log('3D model optimized:', systemId, kind, Math.round(st.size / 1048576) + ' MB ->', Math.round(b.length / 1048576) + ' MB');
  return true;
});
handle('themes:set', ({ systemId, kind, file }) => { if (['model', 'controller', 'media'].includes(kind)) dropOptimized(systemId, kind); themes.set(systemId, kind, file); return true; });
handle('themes:fit', ({ systemId, patch }) => themes.saveFit(systemId, patch));
handle('themes:remove', ({ systemId, kind }) => { if (['model', 'controller', 'media'].includes(kind)) dropOptimized(systemId, kind); themes.remove(systemId, kind); return true; });
// Customize → Logo → Find a logo (main/logofind.js: a hand-picked list of official logos on Wikimedia Commons, no account). The
// console id must be one of Boxshelf's own, the key one this console's own cached list offered (logofind.file looks it up); the
// picture goes in through the same theme path and extension check as a logo you pick yourself, and the one it replaces is moved
// aside (Restore brings it back). Errors come back as words for the screen: never a credential, never an address.
const logoDir = () => path.join(app.getPath('userData'), 'logo-find');
let logofindReady = false;
const logofind = () => { const L = require('./main/logofind'); if (!logofindReady) { logofindReady = true; L.init({ log }); } return L; };
const logoSys = id => { if (typeof id !== 'string' || !CONSOLES.some(c => c.id === id) || !logofind().ids().includes(id)) throw new Error('Unknown system.'); return id; };
handle('themes:findLogos', async ({ systemId }) => {
  const id = logoSys(systemId), L = logofind(), r = await L.list(id);
  // previews: each file fetched once (then cached a week) and handed over as a data: address, so the screen never sees a source's URL
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const out = await Promise.all(r.list.map(async c => { try { const f = await L.file(id, c.key, logoDir()); return { ...c, preview: `data:${mime[f.ext] || 'image/png'};base64,` + (await fs.promises.readFile(f.file)).toString('base64') }; } catch { return null; } }));
  const got = out.filter(Boolean); return { ok: true, list: got, offline: !got.length && r.list.length > 0 };
});
handle('themes:useLogo', async ({ systemId, key }) => {
  const id = logoSys(systemId); if (typeof key !== 'string' || !/^cm-[a-z0-9-]{1,64}$/i.test(key)) throw new Error('Unknown logo.');
  let f; try { f = await logofind().file(id, key, logoDir()); } catch (e) { return { ok: false, error: String((e && e.message) || "Couldn't get that logo").slice(0, 200) }; }
  themes.setLogoKeepingOld(id, f.file); log('Logo set for', id, 'from', f.source); return { ok: true };
});
handle('themes:restoreLogo', ({ systemId }) => { themes.restoreLogo(logoSys(systemId)); return true; });
// (1.76) custom themes: the list (pictures as bsfile addresses), one made from a picture, the folder opened
handle('customThemes:list', () => customThemes.list().map(t => ({ ...t, bg: fileUrl(t.bg), sys: Object.fromEntries(Object.entries(t.sys).map(([k, v]) => [k, fileUrl(v)])) })));
handle('customThemes:create', ({ file, name }) => customThemes.create(file, name));
handle('customThemes:open', () => { customThemes.ensureExamples(); fs.mkdirSync(customThemes.root(), { recursive: true }); return shell.openPath(customThemes.root()); });
handle('themes:open', ({ systemId }) => { fs.mkdirSync(themes.dir(systemId), { recursive: true }); return shell.openPath(themes.dir(systemId)); });
handle('dolphin:ipl', ({ systemId }) => dolphin.findIpl(emuPath((cfg.systems[systemId || 'gc'] || {}).emulator)));
// (beta.10) Linux: Dolphin's folders there aren't the Windows ones these look in, so no stray ~/AppData folder is made
handle('dolphin:iplFolder', async ({ systemId, region }) => { if (linux.isLinux) throw new Error('Not available on Linux yet.'); const d = dolphin.ensureIplFolder(emuPath((cfg.systems[systemId || 'gc'] || {}).emulator), region); await shell.openPath(d); return d; });
let coversBusy = false, autoJob = null;
// the screen's list of console ids: a real array of strings (a plain string would match by substring: "gcwii".includes("gc"))
const idList = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string');
handle('covers:download', async ({ systemIds, types, hd }) => {
  systemIds = idList(systemIds);
  // the quiet background download may be running: wait for it (it shares the same files) rather than refusing
  coversUserCancel = false;
  if (autoRunning && autoJob) { if (alive()) win.webContents.send('covers:progress', { stage: 'Finishing the background cover download first…' }); autoPause(false); /* (beta.10: a paused one carries on, or this would wait for ever) */ await autoJob; }
  if (coversUserCancel) return { systems: [], hd: !!hd, cancelled: true }; // Cancel pressed while it waited for the background run
  if (coversBusy) throw new Error('Covers are already downloading.');
  coversBusy = true;
  try {
    const list = CONSOLES.filter(d => systemIds.includes(d.id) && cfg.systems[d.id] && (cfg.systems[d.id].romDirs || []).length)
      .map(def => ({ def, cfg: cfg.systems[def.id] }));
    if (!list.length) throw new Error('Add a games folder first.');
    log('Download covers for', list.map(x => x.def.id).join(','));
    await artstudio.ready(); // the record of which pictures Boxshelf wrote (first start of 1.68): an HD upgrade asks it
    const rep = await covers.downloadCovers(list, info => { if (alive()) win.webContents.send('covers:progress', info); }, types, { hd: !!hd, region: cfg.ui.artRegion, ...artOpts(true) });
    const got = (rep.systems || []).reduce((a, r) => a + r.front + r.back + r.spine + r.disc + (r.upgraded || 0), 0);
    if (got && alive()) win.webContents.send('library:changed', { covers: 0 }); // the shelf picks the new pictures up
    if (got) artstudio.forget(); // …and so do the Studio's game lists
    return rep;
  } finally { coversBusy = false; }
});
let coversUserCancel = false;
handle('covers:cancel', (a) => { if (a && a.auto) { const st = autoState; if (st) { st.stopped = true; st.paused = false; clearInterval(st.t); } covers.cancel('auto'); return true; } // (beta.10) the art card: only the background run
  coversUserCancel = true; covers.cancel(); return true; });
handle('covers:coverage', async () => { const out = []; for (const s of sysList(CONSOLES.map(c => c.id))) { await yieldNow(); out.push(...(await covers.coverage([s]))); } return out; }); // (beta.9: a console at a time, with a breath between: every console's pictures in one go froze Settings' Box art page; beta.10: coverage is async)
// New games while Boxshelf is open: watch the game folders, and once nothing has changed in them for 8 s (a big copy is
// finished) tell the shelf to look again. A new game then shows up on the shelf, and in the museum it arrives as a parcel.
// Never during a game (it waits), and at most one rescan per quiet spell.
let romWatchers = [], romWatchT = 0, romWatchKey = null, romMissing = new Set(), romRetryT = 0; // (beta.9: romMissing: games folders not there yet, a USB or network drive)
function watchRoms() {
  const dirs = new Set(); Object.values(cfg.systems || {}).forEach(s => { if (s && s.enabled !== false) (s.romDirs || []).forEach(d => dirs.add(d)); });
  // only when the watched folders really changed (every settings save calls this); a pending rescan (romWatchT) stays due
  const key = [...dirs].sort().join('\n'); if (key === romWatchKey) return; romWatchKey = key;
  romWatchers.forEach(w => { try { w.close(); } catch {} }); romWatchers = [];
  for (const d of dirs) romWatchDir(d);
  // (beta.9) a folder that isn't there yet (its drive not plugged in) is tried again every minute; once it's there, it's
  // watched and the shelf looks at it at once
  for (const d of [...romMissing]) if (!dirs.has(d)) romMissing.delete(d);
  romRetrySoon();
}
function romPoke() { scanForget(); /* (beta.9: a games folder changed, so the kept scans are out of date) */ clearTimeout(romWatchT); romWatchT = setTimeout(function fire() { if (launcher.isRunning()) { romWatchT = setTimeout(fire, 15000); return; } if (alive()) win.webContents.send('library:changed', { watch: 1 }); }, 8000); }
const romWatchEv = (ev, name) => { if (name && /(^|[\\/])(covers|\.optimized|\.manual-originals)([\\/]|$)|-manual-|\.(png|jpe?g|json|txt|ini|tmp|part|srm|sav|sra|state(\d+|\.auto)?|st\d|ss\d|mcd|mcr|ps2|dsv|eep|fla|flash|mpk|bkr|brm|rtc|bak|log|cfg|lock|db|sqlite|db-journal|crdownload)$/i.test(name)) return; romPoke(); }; /* (beta.9: an emulator's saves, save states and memory cards beside the games aren't new games: they rescanned the whole library just after every game. Never .bin, .img or .zip: those are games) */
// (beta.10) Linux has no native recursive watch: Node's fallback walked the whole tree with readdirSync on this thread (an SD
// card of extracted PS3 / Switch games held the app up). There the folder itself is watched, and its direct subfolders
// (a game in its own folder) are added a few at a time from an async listing
async function romWatchSubs(d, top) {
  let ents = []; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
  let k = 0;
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.') || /^(covers|manuals)$/i.test(e.name)) continue;
    if (!romWatchers.includes(top) || ++k > 2000) return;
    if (k % 8 === 0) { await new Promise(r => setImmediate(r)); if (!romWatchers.includes(top)) return; }
    try { const s = fs.watch(path.join(d, e.name), romWatchEv); s.bsSubOf = d; s.on('error', () => { try { s.close(); } catch {} romWatchers = romWatchers.filter(x => x !== s); }); romWatchers.push(s); } catch {}
  }
}
function romWatchDir(d) {
  try { const w = fs.watch(d, { recursive: !linux.isLinux }, romWatchEv);
    w.bsDir = d; if (linux.isLinux) setImmediate(() => romWatchSubs(d, w).catch(() => {}));
    // (beta.10) a watch that fails (its USB / network drive gone) was dead for good: it's closed and the folder joins the
    // ones tried again every minute (a stale watcher, already replaced, is left alone)
    w.on('error', e => { if (!romWatchers.includes(w)) return; try { w.close(); } catch {} romWatchers = romWatchers.filter(x => x !== w); romMissing.add(d); romWatchKey = null; log('Games folder watch stopped (' + ((e && e.code) || 'error') + '), trying it again every minute:', d); romRetrySoon(); });
    romWatchers.push(w); if (romMissing.has(d)) { romMissing.delete(d); log('Games folder is back, watching it:', d); romPoke(); } } catch { romMissing.add(d); }
}
// (beta.10) the retry looks at the missing folders only (it rebuilt every watcher, and fs.watch opens a folder on this
// thread: an offline share could hold the app up), each checked with fs.promises first; never during a game
let romRetrying = false;
function romRetrySoon() { clearTimeout(romRetryT); romRetryT = 0; if (romMissing.size) romRetryT = setTimeout(romRetry, 60000); }
async function romRetry() {
  romRetryT = 0; if (romRetrying) return; if (launcher.isRunning() || launching) return romRetrySoon();
  romRetrying = true;
  try { for (const d of [...romMissing]) { let ok = false; try { ok = (await fs.promises.stat(d)).isDirectory(); } catch {}
    if (ok && romMissing.has(d) && !launcher.isRunning() && !romWatchers.some(w => w.bsDir === d)) romWatchDir(d); } }
  finally { romRetrying = false; }
  if (!romRetryT) romRetrySoon();
}
const sysList = ids => CONSOLES.filter(d => ids.includes(d.id) && cfg.systems[d.id] && (cfg.systems[d.id].romDirs || []).length).map(def => ({ def, cfg: cfg.systems[def.id] }));
let manualsBusy = false, findToken = null;
handle('manuals:recent', () => manualcoll.recent(30));
handle('manuals:coverage', async () => { const out = []; for (const s of sysList(CONSOLES.map(c => c.id))) { await yieldNow(); out.push(...(await manuals.coverage([s]))); } return out; }); // (beta.9: a console at a time, as covers:coverage; beta.10: coverage is async)
handle('manuals:find', async ({ systemIds }) => {
  systemIds = idList(systemIds);
  // a second search while one runs is turned down before it takes the token: it used to replace it and then clear it,
  // so Cancel could no longer stop the first
  if (findToken) throw new Error('Already searching for manuals.');
  // (beta.10) the token is made before waiting for the background pass (a Cancel meanwhile was lost), and that pass is asked
  // to stop at its next step (manualUser, as a Wrong game / Repair press does); it carries on afterwards
  const token = findToken = { cancelled: false };
  try {
    await manualBgWait(() => { if (alive()) win.webContents.send('covers:progress', { stage: 'Finishing the background manual download first…' }); });
    if (token.cancelled) return [];
    if (manualsBusy) throw new Error('Already searching for manuals.');
    manualsBusy = true;
    try { const list = sysList(systemIds); if (!list.length) throw new Error('Add a games folder first.'); log('Manual search for', systemIds.join(',')); return await manuals.findAll(list, info => { if (alive()) win.webContents.send('covers:progress', info); }, token); }
    finally { manualsBusy = false; }
  } finally { if (findToken === token) findToken = null; manualResumeSoon(); }
});
// ---------- RetroAchievements ----------
let lastLaunch = null;
handle('ra:progress', ({ systemId, title, force }) => ra.progress(systemId, title, !!force));
handle('ra:shelf', ({ systemId, titles }) => ra.shelfProgress(systemId, titles || []));
handle('ra:profile', () => ra.profile());
handle('ra:enabled', () => ({ enabled: ra.enabled(), systems: Object.keys(ra.CONSOLE_ID) }));
handle('models:find', ({ systemId, name, site }) => modelfind.start(systemId, name, site, r => { if (alive()) win.webContents.send('models:installed', r); }));
handle('history:get', () => loadHistory());
handle('history:touch', ({ id }) => { const open = histOpen; historyStart(String(id)); histOpen = open; return true; }); // Steam / app launches: count the launch, no duration
handle('trailer:open', ({ url }) => openTrailer(String(url || '')));
// ---------- start with Windows ----------
const STARTUP_LNK = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Boxshelf.lnk');
function psRun(script) {
  return new Promise((resolve, reject) => {
    const enc = Buffer.from("$ProgressPreference = 'SilentlyContinue'\n" + script, 'utf16le').toString('base64');
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, timeout: 20000 }, (err, out, errOut) => err ? reject(new Error((paths.psError(errOut) || err.message).slice(0, 300))) : resolve(String(out)));
  });
}
const loginItem = () => ({ path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: WINDOWED ? ['--windowed'] : [] });
// (beta.12) Linux: start at login through the desktop's autostart folder (~/.config/autostart, the XDG way KDE's Desktop
// Mode and GNOME read), pointing at the AppImage. Game Mode on a Steam Deck starts Steam, not this: there Boxshelf is
// started from the Library (Add to Steam)
const LINUX_AUTOSTART = () => path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), 'autostart', 'boxshelf.desktop');
// (a .desktop Exec value: inside the quotes ", `, $ and \ take a backslash, then backslashes are doubled again and % doubled)
const desktopQuote = s => '"' + String(s).replace(/(["`$\\])/g, '\\$1').replace(/\\/g, '\\\\').replace(/%/g, '%%') + '"';
const linuxAutostartText = exe => ['[Desktop Entry]', 'Type=Application', 'Name=Boxshelf', 'Comment=Your games on a shelf', 'Exec=' + desktopQuote(exe), 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
// (beta.12) at start: the fixed link follows this AppImage, and a Start at login entry from an older version (its own
// file name) is pointed at the link
if (process.platform === 'linux') app.whenReady().then(() => { try { const exe = linux.stableAppImage(); const f = LINUX_AUTOSTART(); if (exe && fs.existsSync(f)) { const want = linuxAutostartText(exe); if (fs.readFileSync(f, 'utf8') !== want) { fs.writeFileSync(f + '.tmp', want); fs.renameSync(f + '.tmp', f); log('Start at login: pointed at', exe === process.env.APPIMAGE ? 'this AppImage' : 'Boxshelf.AppImage'); } } } catch (e) { log('Start at login: not refreshed:', e.message); } });
handle('autostart:get', () => {
  if (process.platform === 'linux') return { enabled: fs.existsSync(LINUX_AUTOSTART()), how: 'desktop' };
  if (process.platform !== 'win32') return { enabled: false, how: 'unsupported' };
  if (app.isPackaged) return { enabled: !!app.getLoginItemSettings(loginItem()).openAtLogin, how: 'exe' };
  return { enabled: fs.existsSync(STARTUP_LNK()), how: 'shortcut' };
});
handle('autostart:set', async ({ enabled }) => {
  if (process.platform === 'linux') {
    const f = LINUX_AUTOSTART();
    if (!enabled) { try { fs.unlinkSync(f); } catch {} return { enabled: false, how: 'desktop' }; }
    const exe = linux.stableAppImage() || process.env.APPIMAGE; if (!exe) throw new Error('Start at login needs the AppImage version of Boxshelf.');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const text = linuxAutostartText(exe);
    fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f);
    return { enabled: true, how: 'desktop' };
  }
  if (process.platform !== 'win32') throw new Error('Only on Windows.');
  // the exe: Windows' own start-up entry; a shortcut left by the folder version is removed so only one Boxshelf starts
  if (app.isPackaged) { try { fs.unlinkSync(STARTUP_LNK()); } catch {} app.setLoginItemSettings({ openAtLogin: !!enabled, ...loginItem() }); return { enabled: !!enabled, how: 'exe' }; }
  const lnk = STARTUP_LNK();
  if (!enabled) { try { fs.unlinkSync(lnk); } catch {} return { enabled: false, how: 'shortcut' }; }
  const bat = path.join(paths.appRoot(), 'Start Boxshelf.bat');
  if (!fs.existsSync(bat)) throw new Error('Start Boxshelf.bat was not found next to the app.');
  const q = v => `'${String(v).replace(/['‘’‚‛]/g, m => m + m)}'`; // (beta.8: PowerShell also ends a quoted string at curly quotes, as in a folder named with one; doubling makes any of them literal)
  await psRun(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)}); $s.TargetPath = ${q(bat)}; $s.WorkingDirectory = ${q(paths.appRoot())}; $s.WindowStyle = 7; $s.Description = 'Boxshelf'; $s.Save()`);
  log('Autostart shortcut created', lnk);
  return { enabled: true, how: 'shortcut' };
});
handle('app:openFolder', () => shell.openPath(paths.appRoot()));
const songs = require('./main/songs');
handle('songs:list', () => songs.list());
handle('songs:read', ({ file }) => new Uint8Array(songs.read(file)));
handle('songs:open', () => { fs.mkdirSync(songs.folder(), { recursive: true }); return shell.openPath(songs.folder()); });
// links from the page (e.g. a cover's source page) open in the default browser: https only
handle('app:openExternal', ({ url: u }) => { let x; try { x = new URL(String(u)); } catch { throw new Error('Bad link.'); } if (x.protocol !== 'https:') throw new Error('Only https links open.'); return shell.openExternal(x.toString()); });
// put back the emulator settings files Boxshelf changed (each was backed up once as <file>.boxshelf-bak)
// ---------- (beta.7) Video previews (main/previews.js) ----------
// what a game's preview is: a video file you have, Steam's trailer (joined into a small clip, kept), or YouTube's
// trailer (the LaunchBox link). Files found are let through bsfile one by one (previewOk), never whole folders.
const previewOk = new Set();
const previewOpts = sc => ({ dirs: (cfg.ui.previewDirs || []).map(d => paths.expand(d)), artDirs: paths.artDirsFor ? paths.artDirsFor(sc) : [], launchbox: covers.LAUNCHBOX });
handle('preview:find', async ({ systemId, file, title, id, youtube }) => {
  if ((cfg.ui.previews || 'off') === 'off') return null;
  let r = null;
  if (systemId && file) {
    const def = CONSOLES.find(c => c.id === systemId); const { sc } = gameFile(systemId, file);
    const f = def ? previews.findFile(def, sc, { file, title }, previewOpts(sc)) : null;
    if (f) { previewOk.add(path.resolve(f).toLowerCase()); return { type: 'file', url: fileUrl(f) }; }
  }
  const m = /^steam-(\d+)$/.exec(String(id || ''));
  if (m) { const f = await previews.steamClip(m[1]); if (f) return { type: 'file', url: fileUrl(f), steam: true }; }
  let yid = youtube ? previews.youtubeId(youtube) : null;
  // (beta.11) a console game whose LaunchBox trailer is gone (private, removed) or that has none: YouTube is searched for
  // its trailer (ytclips.search, remembered per game) and that one is clipped. Asked once; the renderer is told either way
  // (preview:clip with url, or none: it used to wait 45 s for a clip that was never coming)
  const def0 = systemId ? CONSOLES.find(c => c.id === systemId) : null, sysName = def0 ? def0.name : '';
  const clipsOn = cfg.ui.previewClips !== false && ytclips.supported() && ytclips.helperState().have;
  const tell = (pid, c, dead) => { if (alive()) win.webContents.send('preview:clip', c ? { id: pid, url: fileUrl(c) } : { id: pid, none: true, gone: !!dead }); };
  if (clipsOn && def0 && title && (!yid || ytclips.gone(yid))) {
    const known = ytclips.searchKnown(title, systemId);
    if (known) yid = known;
    else if (known === null) return null; // (searched before: nothing that fits)
    else { const pid = yid || 's' + crypto.createHash('sha1').update(systemId + '|' + title).digest('hex').slice(0, 11);
      ytclips.clipFromSearch(title, systemId, sysName).then(x => tell(pid, x && x.file), () => tell(pid, null)); return { type: 'pending', id: pid }; }
  }
  // (beta.8) console trailers: the clip if it's kept; else it's made in the background and the renderer is told when
  // it's ready (preview:clip), while YouTube's player covers the Media tab in the meantime
  if (yid && cfg.ui.previewClips !== false && ytclips.supported()) {
    const f = ytclips.cached(yid); if (f) return { type: 'file', url: fileUrl(f), yt: yid };
    // (beta.11) a link that turns out to be gone: the search instead; nothing at all: the renderer is told (none)
    if (ytclips.helperState().have) { const vid = yid; ytclips.clip(vid).then(async c => { if (!c && ytclips.gone(vid) && def0 && title) { const x = await ytclips.clipFromSearch(title, systemId, sysName); c = x ? x.file : null; } tell(vid, c, !c && ytclips.gone(vid)); }).catch(() => tell(vid, null)); if (cfg.ui.previewYoutube !== false) r = { type: 'youtube', id: yid, pending: true }; else r = { type: 'pending', id: yid }; return r; }
  }
  if (cfg.ui.previewYoutube !== false && yid) r = { type: 'youtube', id: yid };
  return r;
});
// (beta.11) the games either side of the one you're resting on: their trailers made ahead, so they play at once when you
// get there. Nothing is told or played; YouTube clips wait behind every clip asked for now (ytclips' low asks), and a
// Steam trailer is fetched as when Details asks. At most three games per call
handle('preview:warm', list => {
  if ((cfg.ui.previews || 'off') === 'off' || !Array.isArray(list)) return false;
  for (const o of list.slice(0, 3)) previewWarm(o || {}).catch(() => {});
  return true;
});
async function previewWarm({ systemId, file, title, id, youtube }) {
  if (systemId && file) { const def = CONSOLES.find(c => c.id === systemId), { sc } = gameFile(systemId, file);
    if (!def || previews.findFile(def, sc, { file, title }, previewOpts(sc))) return; }
  const m = /^steam-(\d+)$/.exec(String(id || '')); if (m) { await previews.steamClip(m[1]); return; }
  const def0 = systemId ? CONSOLES.find(c => c.id === systemId) : null;
  if (!def0 || cfg.ui.previewClips === false || !ytclips.supported() || !ytclips.helperState().have) return;
  let yid = youtube ? previews.youtubeId(youtube) : null;
  if (yid && !ytclips.gone(yid)) { if (ytclips.cached(yid)) return; if (await ytclips.clip(yid, { low: true }) || !ytclips.gone(yid)) return; }
  if (title) await ytclips.clipFromSearch(title, systemId, def0.name, { low: true });
}
// (beta.8) console trailers: the helper, how many clips are kept, clearing them
handle('ytclip:status', () => ytclips.status());
handle('ytclip:helper', async () => { const ok = await ytclips.getHelper(p => { if (alive()) win.webContents.send('ytclip:progress', { pct: p }); }); if (alive()) win.webContents.send('ytclip:progress', { done: true, ok }); return ok; });
handle('ytclip:clear', () => { ytclips.clear(); return true; });
// (beta.8) Steam Deck: where Boxshelf runs (the shelf's Desktop Mode card, Settings), and Add Boxshelf to Steam
handle('deck:info', () => ({ ...steamdeck.info(), inSteam: linux.isLinux && process.env.APPIMAGE ? steamdeck.inSteam(linux.stableAppImage() || process.env.APPIMAGE) : false }));
// (beta.12) the shortcut points at the fixed Boxshelf.AppImage link, so it keeps working after an update
handle('deck:addToSteam', ({ closeSteam } = {}) => steamdeck.addToSteam({ exe: linux.stableAppImage() || process.env.APPIMAGE || '', iconSrc: path.join(__dirname, 'renderer', 'app-icon.png'), dataDir: app.getPath('userData'), closeSteam: !!closeSteam }));
// (beta.12) Details' box: the sound of the clip that's playing, by the clip's own address: { clip: false } for anything but
// Boxshelf's own YouTube clips (their sound is in the video), else { clip: true, url } (url null: it couldn't be had).
// Kept the first time, so it plays at once after that
handle('preview:clipAudio', async ({ url } = {}) => {
  const u = String(url || ''); if (!u.startsWith('bsfile://local/')) return null;
  let f; try { f = decodeURIComponent(u.slice(15).split('?')[0]); } catch { return null; }
  const st = previews.steamIdOf(f); if (st) { const a = await previews.steamAudio(st); return { clip: true, url: a ? fileUrl(a) : null }; } // (Steam clips are the picture only too: their sound is fetched the same way)
  const id = ytclips.idOfClip(f); if (!id) return { clip: false }; // (your own video: its sound is in it)
  const a = await ytclips.audio(id); return { clip: true, url: a ? fileUrl(a) : null };
});
handle('preview:yt', ({ id, rect, muted }) => {
  if (!alive() || !/^[\w-]{6,20}$/.test(String(id || '')) || !rect) return false;
  const v = ytEnsure(); ytWant = id; v.setBounds(ytBounds(rect)); v.setVisible(true);
  ytLoad(v.webContents, id, { preview: true, muted: muted !== false }).catch(() => {});
  return true;
});
handle('preview:ytMove', ({ rect, show }) => { if (!ytView || ytView.webContents.isDestroyed() || !ytWant) return; if (rect) ytView.setBounds(ytBounds(rect)); ytView.setVisible(show !== false); });
handle('preview:ytStop', () => ytStop());
// Settings / the first run: how many games have a video file, per console; the Steam clips' size; forget / clear
handle('preview:count', async () => {
  previews.forget(); const out = []; let total = 0;
  for (const def of CONSOLES) { const sc = cfg.systems[def.id]; if (!sc || sc.enabled === false || !(sc.romDirs || []).length) continue;
    await new Promise(r => setImmediate(r)); let games = []; try { games = await scanSystemAsync(def, sc); } catch {} // (beta.10: async)
    const n = previews.countFiles(def, sc, games, previewOpts(sc)); if (n) out.push({ id: def.id, name: def.name, n, of: games.length }); total += n; }
  return { total, systems: out, steamBytes: previews.steamSize(), clips: ytclips.status() };
});
handle('preview:clearSteam', () => { previews.clearSteam(); return true; });
// ---------- (beta.7) Set up for me (main/emusetup.js): Windows for now (the emulators' Linux settings live elsewhere) ----------
let gpuPreset = null;
async function setupOpts() {
  const g = cfg.emuSetup && cfg.emuSetup.graphics;
  if (g && g !== 'auto') return { graphics: g };
  if (!gpuPreset) { let info = null; try { info = await app.getGPUInfo('basic'); } catch {} gpuPreset = emusetup.presetFor(info); }
  return { graphics: gpuPreset };
}
const setupOn = () => process.platform === 'win32';
function setupExe(systemId) { const sc = cfg.systems[systemId]; if (!sc || !sc.emulator) throw new Error('Choose this console\'s emulator first.'); return emuPath(sc.emulator); }
const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
async function setupPending(exe) {
  const P = cfg.emuSetup && cfg.emuSetup.pending; if (!setupOn() || !P || !P.some(p => samePath(emuPath(p), exe))) return;
  const st = emusetup.status(exe); if (!st.supported || !st.ready) return;
  try { const r = emusetup.apply(exe, { resume: cfg.emuSetup.resume }, await setupOpts()); log('Set up at launch:', st.name, r.ok ? (r.applied || []).join(', ') : r.why); } catch (e) { log('Set up at launch failed', e.message); }
  cfg.emuSetup.pending = P.filter(p => !samePath(emuPath(p), exe)); try { persistCfg(cfg); } catch {}
}
handle('emusetup:status', async ({ systemId }) => {
  const sc = cfg.systems[systemId]; if (!sc || !sc.emulator) return { supported: false, none: true };
  if (!setupOn()) return { supported: false, why: 'Windows only for now' };
  const exe = emuPath(sc.emulator), s = emusetup.status(exe), def = CONSOLES.find(c => c.id === systemId);
  // (beta.7) RetroArch: this console's core (there or not), and the BIOS files it wants, checked in RetroArch's system folder
  // and the shared one (Neo Geo: the games folder too). Other emulators: whether their BIOS folder has anything in it.
  let core = null, bios = null;
  if (s.kind === 'retroarch' && def && def.raCore) {
    core = { id: def.raCore, name: RA_CORE_NAME[def.raCore] || def.raCore, installed: !!retroCore(exe, def.raCore) };
    try { bios = await racores.bios(systemId, [emusetup.biosDirOf('retroarch', exe), emusetup.sharedBiosDir(), ...(systemId === 'neogeo' ? sc.romDirs || [] : [])]); } catch {}
  } else if (s.kind === 'duckstation' || s.kind === 'pcsx2') {
    const dirs = [emusetup.biosDirOf(s.kind, exe)].filter(Boolean), re = s.kind === 'pcsx2' ? /^(scph|ps2|bios).*\.bin$/i : /\.bin$/i;
    let any = false; for (const d of dirs) { try { if (fs.readdirSync(d).some(n => re.test(n))) any = true; } catch {} }
    bios = { need: 'any', ok: any, files: [], dir: dirs[0] || '' };
  }
  if (bios) bios.dir = bios.dir || emusetup.biosDirOf(s.kind, exe) || emusetup.sharedBiosDir();
  return { ...s, preset: (await setupOpts()).graphics, pending: (cfg.emuSetup.pending || []).some(p => samePath(emuPath(p), exe)), sharedBios: emusetup.sharedBiosDir(), core, bios };
});
// (beta.7) Get this core (Settings → a RetroArch console → Set up for me), with its progress on the row
handle('racore:get', async ({ systemId }) => {
  const sc = cfg.systems[systemId], def = CONSOLES.find(c => c.id === systemId); if (!sc || !sc.emulator || !def || !def.raCore) throw new Error('This console doesn\'t use a RetroArch core.');
  const exe = emuPath(sc.emulator); if (!/^retroarch\.exe$/i.test(path.basename(exe))) throw new Error('This console doesn\'t run in RetroArch.');
  const f = await racores.get(exe, def.raCore, p => { if (alive()) win.webContents.send('racore:progress', { systemId, pct: p }); });
  return { ok: true, file: f, name: RA_CORE_NAME[def.raCore] || def.raCore };
});
// Opens the folder this console's emulator reads its BIOS files from (made if it isn't there yet)
handle('bios:open', async ({ systemId }) => {
  const sc = cfg.systems[systemId]; if (!sc || !sc.emulator) throw new Error('Choose this console\'s emulator first.');
  const exe = emuPath(sc.emulator), k = emusetup.kindOf(exe), d = (k && emusetup.biosDirOf(k, exe)) || emusetup.sharedBiosDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  const e = await shell.openPath(d); if (e) throw new Error(e); return d;
});
handle('emusetup:plan', async ({ systemId }) => {
  if (!setupOn()) return { ok: false, why: 'Windows only for now', changes: [] };
  const exe = setupExe(systemId), k = emusetup.kindOf(exe); if (!k) return { ok: false, why: 'not one Boxshelf can set up yet', changes: [] };
  const p = emusetup.plan(k, exe, await setupOpts());
  return { ...p, changes: (p.changes || []).map(c => ({ group: c.group, file: c.file, key: (c.section ? `[${c.section}] ` : '') + c.key, value: c.value })) };
});
handle('emusetup:apply', async ({ systemId, on }) => {
  if (!setupOn()) return { ok: false, why: 'Windows only for now' }; busyCheck();
  const o = on && typeof on === 'object' ? Object.fromEntries(emusetup.GROUPS.filter(g => on[g] != null).map(g => [g, !!on[g]])) : {};
  if (o.resume == null) o.resume = cfg.emuSetup.resume;
  return emusetup.apply(setupExe(systemId), o, await setupOpts());
});
handle('emusetup:undo', ({ systemId }) => { if (!setupOn()) return { ok: false }; busyCheck(); return emusetup.undo(setupExe(systemId)); });
// The first run's "Set up my emulators for me": each emulator the picked consoles use, once. New ones are set up now (or
// at their next launch, if they haven't been opened yet); ones you've used before are left as they are and listed.
handle('emusetup:auto', async () => {
  const out = { done: [], later: [], left: [] }; if (!setupOn()) return out;
  const seen = new Set(), opts = await setupOpts();
  for (const [id, sc] of Object.entries(cfg.systems)) {
    if (!sc || sc.enabled === false || !sc.emulator) continue; const exe = emuPath(sc.emulator), key = path.resolve(exe).toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    const st = emusetup.status(exe); if (!st.supported || st.done) continue;
    if (st.used) { out.left.push(st.name); continue; }
    if (!st.ready) { if (!cfg.emuSetup.pending.some(p => samePath(emuPath(p), exe))) cfg.emuSetup.pending.push(sc.emulator); out.later.push(st.name); continue; }
    try { const r = emusetup.apply(exe, { resume: cfg.emuSetup.resume }, opts); if (r.ok) out.done.push(st.name); else log('Set up for me:', st.name, r.why); } catch (e) { log('Set up for me failed', st.name, e.message); }
  }
  try { persistCfg(cfg); } catch {}
  out.emuSetup = cfg.emuSetup; // (the wizard keeps its own copy of the settings: it takes this one, so its next save keeps the list)
  return out;
});handle('emucfg:restore', () => emucfg.restoreBackups(Object.fromEntries(Object.entries(cfg.systems).map(([k, v]) => [k, v && emuPath(v.emulator)])))); // the real path: a portable "{app}\…" one finds its User\Config backups
handle('manuals:cancel', () => { if (findToken) findToken.cancelled = true; return true; });
handle('manuals:download', async ({ choices }) => {
  // every target must be a game the scanner could have found (inside that system's games folders)
  choices = (Array.isArray(choices) ? choices : []).filter(c => { try { return c && typeof c.id === 'string' && !!gameFile(c.systemId, c.file); } catch { return false; } });
  if (findToken) throw new Error('Already downloading manuals.'); // (the background pass doesn't take the token: it's waited for below)
  const token = findToken = { cancelled: false }; // (beta.10: as manuals:find, a Cancel while the background pass stops isn't lost)
  try {
  await manualBgWait();
  if (token.cancelled) return [];
  if (manualsBusy) throw new Error('Already downloading manuals.');
  manualsBusy = true;
  try {
    const rep = await manuals.downloadChosen(sysList(CONSOLES.map(c => c.id)), choices, info => { if (alive()) win.webContents.send('covers:progress', info); });
    if (rep.some(x => x.pages === -1)) { if (alive()) win.webContents.send('covers:progress', { stage: 'Turning PDF manuals into pages…' }); const made = new Map(); await convertPdfManuals(made); rep.forEach(x => { if (x.pages === -1) { x.pages = made.get(x.file) || 0; if (!x.pages) x.error = 'the PDF could not be turned into pages'; } }); }
    try { manuals.noteChosen(choices, rep); } catch {}
    await fixSpreads();
    return rep;
  }
  finally { manualsBusy = false; }
  } finally { if (findToken === token) findToken = null; manualResumeSoon(); }
});
// (beta.9) Wrong game / Repair work on this one game only, right away
const collOpts = () => ({ renderPdf: (p, size) => renderPdfPages(p, size || 1600, undefined, undefined, true), crop: makeCropper() });
// (beta.10) async: the whole-console walk behind it held the main process up (a games folder on a NAS)
async function oneGame(systemId, file) { const s = sysList([systemId])[0]; if (!s) throw new Error('Unknown system.'); const g = (await scanSystemAsync(s.def, s.cfg)).find(x => x.file.toLowerCase() === String(file).toLowerCase()); if (!g) throw new Error('Game not found.'); return { def: s.def, sc: s.cfg, g }; }
handle('manuals:reject', async ({ systemId, file }) => {
  const gf = gameFile(systemId, file);
  return manualTurn(async () => {
    const key = systemId + '|' + gf.file.toLowerCase(), collSrc = manualcoll.forget(key);
    // a scan collection's copy of this game first (not the one just rejected), then the search's next best
    const r = await manuals.rejectManual(sysList(CONSOLES.map(c => c.id)), systemId, gf.file, { collSrc, tryFirst: (def, sc, g) => manualcoll.fetchFor(def, sc, g, collOpts()),
      progress: info => { if (alive()) win.webContents.send('covers:progress', info); } });
    const { sc, g } = await oneGame(systemId, gf.file);
    if (r.pdf) r.got = await pdfToPages(sc, g);
    if (r.got && !r.from) { try { await spreads.splitManual(paths.manualDirFor(sc, g.file), paths.artBase(g.file), makeCropper()); } catch (e) { log('Manual spreads', path.basename(g.file), e.message); } }
    if (alive()) win.webContents.send('library:changed', { manuals: 1 });
    r.pages = await manualPagesOf(systemId, gf.file); // (beta.9: the reader reopens with these, no whole-library scan)
    return r;
  });
});
// (beta.9) one game's manual pages as the shelf has them (addresses, the box front first where the library puts it there)
async function manualPagesOf(systemId, file) { try { const { def, g } = await oneGame(systemId, file); return await withCoverAsync(def.id, g, ((g.art && g.art.manual) || []).map(fileUrl)); } catch { return null; } }
// Repair: the right game's manual that looks wrong (no cover, thumbnails, two pages side by side, huge pages). A scan
// collection's copy replaces it when one has the game (unless that's the copy already there); otherwise it's put right
// where it is (manuals.repairInPlace). The pages as they were are kept in .manual-originals.
handle('manuals:repair', async ({ systemId, file }) => {
  const gf = gameFile(systemId, file);
  return manualTurn(async () => {
    const { def, sc, g } = await oneGame(systemId, gf.file), key = systemId + '|' + g.file.toLowerCase();
    if (manualstudio.isLocked(systemId, g.file)) throw new Error('This manual was chosen in Manual Studio: change it there.');
    const had = manualcoll.info(key), c = await manualcoll.fetchFor(def, sc, g, Object.assign(collOpts(), { force: true, skipSrc: had && had.src }));
    let r = c && c.got ? { changed: true, what: 'swapped for the clean scan from ' + c.from } : null;
    if (!r) { const fresh = (await oneGame(systemId, gf.file)).g; r = await manuals.repairInPlace(sc, fresh, { crop: makeCropper(), front: fresh.art && fresh.art.front, sysId: systemId }); }
    if (r.changed && alive()) win.webContents.send('library:changed', { manuals: 1 });
    if (r.changed) r.pages = await manualPagesOf(systemId, gf.file);
    return r;
  });
});
// (beta.9) Settings → Get manuals → Check my manuals: the one-time re-check again, on demand (another game's manual or
// thumbnail pages set aside and looked up again, huge pages made smaller), then the same passes as the background job for
// the games it set aside. Progress on 'manuals:check'; Cancel stops it at its next step
// (Cancel works while it still waits for the background pass to pause; like that pass, it waits while a game is played;
// "replaced" counts only the set-aside games that have a manual again, not manuals the search found for other games)
let checkStop = false;
handle('manuals:check', async () => { checkStop = false; return manualTurn(async () => {
  const say = d => { try { if (alive()) win.webContents.send('manuals:check', d); } catch {} }, stop = () => !alive() || checkStop;
  if (stop()) return { checked: 0, moved: 0, shrunk: 0, got: 0, cancelled: true };
  const locked = (id, f) => manualstudio.isLocked(id, f) || manualstudio.picked(id, f);
  const rc = await manuals.recheck(sysList(CONSOLES.map(c => c.id)), { force: true, cancelled: stop, idle: gameIdle, collInfo: key => manualcoll.info(key), locked,
    progress: p => say({ stage: 'Checking manuals · ' + p.system, done: p.sysDone, total: p.sysTotal, checked: p.checked, moved: p.moved }) });
  let got = 0, coll = 0; const changed = [];
  if (rc.moved && !stop()) {
    say({ stage: 'Looking up the set-aside games…', checked: rc.checked, moved: rc.moved });
    try { coll = await manualcoll.run(sysList(CONSOLES.map(c => c.id)), { renderPdf: (p, size) => renderPdfPages(p, size || 1600, undefined, undefined, true), crop: makeCropper(), cancelled: stop, idle: gameIdle, report: changed, skipSystem: d => manualstudio.prefFor(d.id) !== 'best', locked }); } catch (e) { log('Manual collections failed', e.message); }
    if (!stop()) { try { got = (await manuals.autoFetch(sysList(CONSOLES.map(c => c.id)), { skip: d => d.id === 'wiiu', cancelled: stop, idle: gameIdle, prefFor: id => manualstudio.prefFor(id), locked })).got || 0; } catch (e) { log('Manual search failed', e.message); } }
    if (!stop()) { try { await convertPdfManuals(); await fixSpreads(); } catch (e) { log('Manual pages failed', e.message); } }
  }
  // (one scan per console for all its set-aside games, a pause between consoles: a scan per game froze main for seconds)
  let replaced = 0; const bySys = new Map(); for (const x of rc.list || []) { if (!bySys.has(x.sysId)) bySys.set(x.sysId, new Set()); bySys.get(x.sysId).add(String(x.file).toLowerCase()); }
  for (const [sysId, files] of bySys) { await yieldNow(); const s = sysList([sysId])[0]; if (!s) continue;
    try { for (const g of await scanSystemAsync(s.def, s.cfg)) if (files.has(g.file.toLowerCase()) && g.art && g.art.manual && g.art.manual.length) replaced++; } catch {} } // (beta.10: async scan)
  if ((rc.moved || rc.shrunk || coll || got) && alive()) win.webContents.send('library:changed', { onlineManuals: got, manualUpdates: changed });
  log('Check my manuals:', rc.checked, 'looked at,', rc.moved, 'set aside,', replaced, 'replaced,', rc.shrunk || 0, 'made smaller,', got + coll, 'found in all', stop() ? '(cancelled)' : '');
  return { checked: rc.checked, moved: rc.moved, shrunk: rc.shrunk || 0, got: replaced, found: got + coll, cancelled: !!(rc.cancelled || checkStop) };
}); });
handle('manuals:checkCancel', () => { checkStop = true; return true; });
// (beta.10) async, two at a time, one stat per path: a sync stat of a sleeping network share held main up until the SMB
// timeout (10 s or more) per path. A path that hasn't answered in 2.5 s is reported offline (and not missing)
handle('fs:check', async list => {
  const ps = Array.isArray(list) ? list : [], out = new Array(ps.length); let i = 0;
  const one = p => new Promise(res => { const t = setTimeout(() => res({ path: p, file: false, dir: false, offline: true }), 2500);
    let q; try { q = fs.promises.stat(paths.expand(p)); } catch (e) { q = Promise.reject(e); }
    q.then(s => ({ path: p, file: s.isFile(), dir: s.isDirectory() }), () => ({ path: p, file: false, dir: false })).then(r => { clearTimeout(t); res(r); }); });
  await Promise.all([0, 1].map(async () => { while (i < ps.length) { const k = i++; out[k] = await one(ps[k]); } }));
  return out;
});
handle('app:quit', o => { log('Quit: asked by the shelf (' + String((o && o.why) || 'no reason given').slice(0, 60) + ')'); app.quit(); }); // (why: the quick menu's Exit, or the quit combo held on the shelf)
handle('app:power', kind => { if (['sleep', 'restart', 'shutdown'].includes(kind)) powerAction(kind); return true; }); // the Quick Shelf's Power card
// Box art (quick menu → Box art): an image you pick becomes this game's front cover. It's copied into the game's art
// folder under the name the scanner looks for; the cover it replaces is moved to a "replaced" folder there, not deleted.
handle('art:choose', async ({ id }) => {
  const m = /^([a-z0-9]+):(.+)$/i.exec(String(id || '')), def = m && CONSOLES.find(c => c.id === m[1]), sc = def && cfg.systems[def.id];
  if (!def || !sc) throw new Error('Box art can only be changed for console games.');
  const file = gameFile(def.id, m[2]).file; // a game the scanner could have found: the art can't be written (or old art moved) anywhere else
  const r = await openDialog(alive() ? win : undefined, { title: 'Choose box art', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const src = r.filePaths[0], ext = path.extname(src).slice(1).toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) throw new Error('Pick a JPG, PNG or WebP image.');
  const dir = paths.artDirFor(sc, file), base = paths.artBase(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${base}.${ext}`), same = path.resolve(dest).toLowerCase() === path.resolve(src).toLowerCase();
  // copied in first (under a name the scanner ignores): a failed copy (disk full, file gone) leaves the old cover where it was;
  // then the old covers move to replaced\ (stamped to the millisecond) and the new one is renamed in; any failure puts them back
  // in the game's Art Studio turn (a restyle step or a Studio pick on this game waits), locked before the turn ends
  await artstudio.serial(def.id, file, async () => {
    const tmp = path.join(dir, `${base}.incoming-pick.${ext}`); if (same) { await covers.placeArt(dir, base, '', dest, '.' + ext, 'own'); /* the file already in place: kept; a front of another type (.png beside .jpg) moves aside so this one shows */ } else {
      try { await fs.promises.copyFile(src, tmp); } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; }
      try { await covers.placeArt(dir, base, '', tmp, '.' + ext, 'own'); } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; } }
    artVer.set(path.resolve(dest).toLowerCase(), Date.now());
    setArtLock(def.id, file, 'front', { look: 'exact', key: 'chosen', at: Date.now() }); // your pick: background auto-fetch leaves it alone (a shelf style change replaces it unless the game is locked); the time keeps a restyle already running from undoing it
  });
  artstudio.forget(def.id); // the Studio's list for this console shows the new cover
  log('Box art: set', dest);
  if (alive()) win.webContents.send('library:changed', { artChosen: 1 });
  return { ok: true };
});
// ---------- Art Studio (Settings → Art & manuals): every version of each part, shelf styles, per-game locks ----------
function setArtLock(sysId, file, part, val) { const a = cfg.art || { styles: {}, locks: {} }, k = artstudio.lockKey(sysId, file), locks = { ...(a.locks || {}) }, e = { ...(locks[k] || {}) }; if (val) e[part] = val; else delete e[part]; if (Object.keys(e).length) locks[k] = e; else delete locks[k]; saveArt({ ...a, locks }); }
function saveArt(art) { cfg = persistCfg(config.normalize({ ...cfg, art })); }
// what every cover download hands covers.js: the console's style, and the parts locked per game
// A console nobody has given a style keeps the old auto-fetch exactly (styleFor → null: the old Box art region / Prefer HD
// order); its derived default style is only what the Studio shows and what its own Shelf-style picks use.
// mayReplace: an HD upgrade replaces only a picture Boxshelf wrote (explicit = "Download box art now", which may also upgrade
// pictures from before 1.68); a locked game or part is never touched (lockedFor)
const artOpts = explicit => ({ styleFor: id => (cfg.art && cfg.art.styles && cfg.art.styles[id] ? artstudio.styleFor(cfg, id) : null), lockedFor: (id, file) => artstudio.lockedFor(id, file), serial: (id, file, fn) => artstudio.serial(id, file, fn), mayReplace: f => artstudio.mayReplace(f, !!explicit), isPoster: f => artstudio.isPoster(f) });
let artChangedT = null;
function initArtStudio() {
  artstudio.init({ dataDir: app.getPath('userData'), log, getCfg: () => cfg, setArt: saveArt, consoles: () => sysList(CONSOLES.map(c => c.id)).map(x => ({ def: x.def, sc: x.cfg })), scan: (def, sc, fresh) => scanSystemAsync(def, sc, fresh),
    count: id => { const sh = lastLib && lastLib.find(x => x.id === id && x.kind === 'console'); return sh ? sh.games.length : null; },
    gameFile, fileUrl, send: (ch, d) => { if (alive()) win.webContents.send(ch, d); },
    placed: dest => { artVer.set(path.resolve(dest).toLowerCase(), Date.now()); },
    // one shelf refresh for a burst of changes (a Use, then another a second later)
    changed: info => { clearTimeout(artChangedT); artChangedT = setTimeout(() => { if (alive()) win.webContents.send('library:changed', { artStudio: 1, ...info }); }, 300); },
    idle: gameIdle, coversBusy: () => { if (coversBusy && autoState && autoState.paused) autoPause(false); return coversBusy; }, // (beta.10: the Studio waiting on a paused background run carries it on)
    // "Use my own picture…": main opens the picker; the screen never sends a path
    pickImage: async ({ title }) => { const r = await openDialog(alive() ? win : undefined, { title, properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }); return r.canceled || !r.filePaths || !r.filePaths[0] ? null : r.filePaths[0]; } });
}
handle('art:studio', () => artstudio.studio());
handle('art:games', async a => { const t0 = Date.now(), r = await artstudio.games(a), ms = Date.now() - t0; if (ms > 3000) log('Art games list slow:', a && a.systemId, ms, 'ms'); return r; }); // (beta.3: a report of the page stuck on "Loading…")
handle('art:style', a => artstudio.setStyle(a));
handle('art:cands', a => artstudio.cands(a));
handle('art:use', a => artstudio.use(a));
handle('art:mix', a => artstudio.mix(a));
handle('art:undo', a => artstudio.undo(a));
handle('art:sets', a => artstudio.sets(a)); // matching sets for one game (1.72)
handle('art:useSet', a => artstudio.useSet(a));
handle('art:undoSet', a => artstudio.undoSet(a));
handle('art:cancel', a => artstudio.cancel(a));
handle('art:lock', a => artstudio.lockGame(a)); // the whole game locked as it is / back on the shelf style
handle('art:own', a => artstudio.own(a)); // your own picture for one part (main opens the picker)
handle('art:release', a => artstudio.release(a)); // a console's kept pictures handed to its shelf style
// "LaunchBox index not built yet": build it now (the same one-time download Download box art now does), progress on covers:progress
let artIndexing = null, artRefreshing = null;
// Settings → Art & manuals → Refresh art database (1.71): a forced rebuild of the index (newer picture types appear), through
// covers' single-build guard; progress { phase, pct, got, total } on art:indexProgress; art:refreshCancel stops it, old index kept
handle('art:refreshIndex', () => { if (!artRefreshing && coversBusy && !covers.isPaused('auto')) throw new Error('Box art is downloading right now. Try again when it finishes.'); if (!artRefreshing) artRefreshing = covers.refreshIndex(p => { if (alive()) win.webContents.send('art:indexProgress', p); }).then(() => { artstudio.forget(); return covers.indexInfo(); }).finally(() => { artRefreshing = null; }); return artRefreshing; });
handle('art:refreshCancel', () => ({ cancelled: covers.cancelRefresh() }));
handle('art:indexInfo', () => covers.indexInfo());
// ---------- Manual Studio (Settings → Art & manuals → Manuals; Details → Choose manual…; the Art Studio's Manual part) ----------
function initManualStudio() {
  manualstudio.init({ dataDir: app.getPath('userData'), log, consoles: () => sysList(CONSOLES.map(c => c.id)).map(x => ({ def: x.def, sc: x.cfg })), scan: (def, sc, fresh) => scanSystemAsync(def, sc, fresh), gameFile, fileUrl,
    send: (ch, d) => { if (alive()) win.webContents.send(ch, d); }, idle: gameIdle,
    changed: info => { if (alive()) win.webContents.send('library:changed', info); },
    renderPdf: p => renderPdfPages(p, 1600), renderFirst: async p => { const d = (await renderPdfCover(p))[0]; const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(d || '')); return m ? Buffer.from(m[1], 'base64') : null; },
    crop: makeCropper(),
    // "My PDF…": main opens the picker; the screen never sends a path
    pickPdf: async ({ title }) => { const r = await openDialog(alive() ? win : undefined, { title, properties: ['openFile'], filters: [{ name: 'PDF manuals', extensions: ['pdf'] }] }); return r.canceled || !r.filePaths || !r.filePaths[0] ? null : r.filePaths[0]; } });
}
handle('manual:studio', () => manualstudio.studio());
handle('manual:games', a => manualstudio.games(a));
handle('manual:cands', a => manualstudio.cands(a));
handle('manual:use', a => manualstudio.use(a));
handle('manual:undo', a => manualstudio.undo(a));
handle('manual:lock', a => manualstudio.lock(a));
handle('manual:own', a => manualstudio.own(a));
handle('manual:pref', a => manualstudio.setPref(a));
handle('manual:cancel', a => manualstudio.cancel(a));
handle('art:index', () => { if (!artIndexing && coversBusy && !covers.isPaused('auto')) throw new Error('Box art is downloading right now: it builds the index too. Try again when it finishes.'); if (!artIndexing) artIndexing = covers.buildIndex(info => { if (alive()) win.webContents.send('covers:progress', info); }).then(() => { artstudio.forget(); return { index: covers.indexState() }; }).finally(() => { artIndexing = null; }); return artIndexing; });
// the smoothness test (1.73.5): full screen, a maximized window, or a window half the screen's size, to tell whether full-screen
// presentation or the number of pixels is what costs frames. { mode } → whether it's full screen now
handle('app:winMode', async ({ mode } = {}) => {
  if (!alive()) return false;
  if (mode === 'full') { if (win.isMaximized()) win.unmaximize(); if (!win.isFullScreen()) win.setFullScreen(true); }
  else if (mode === 'max' || mode === 'half') { if (win.isFullScreen()) { win.setFullScreen(false); await new Promise(r => setTimeout(r, 600)); }
    if (mode === 'max') win.maximize(); else { if (win.isMaximized()) win.unmaximize(); const a = screen.getDisplayMatching(win.getBounds()).workArea; win.setBounds({ x: a.x + Math.round(a.width / 4), y: a.y + Math.round(a.height / 4), width: Math.round(a.width / 2), height: Math.round(a.height / 2) }); } }
  return win.isFullScreen();
});
handle('app:fullscreen', () => { if (alive()) { const to = !win.isFullScreen(); win.setFullScreen(to); seamless.fullscreenToggled(to); /* (beta.12: F11 sets Seamless play's screen mode) */ } return alive() && win.isFullScreen(); });
// (beta.12) Seamless play: Settings → Screen mode, and B on the starting screen of a watched game (main/seamless.js)
handle('seamless:screenMode', ({ mode } = {}) => seamless.setScreenMode(alive() ? win : null, String(mode || ''), launcher.isRunning()));
handle('seamless:cancel', () => seamless.cancel(launcher));

// The RetroAchievements key is kept encrypted for this Windows user (DPAPI via safeStorage), not as plain text in
// config.json: a copied or shared Boxshelf folder doesn't carry a usable key
// personal API keys (Settings → Connections) are kept encrypted too, the same way
let sealWarned = false; // (beta.10: once a session, when keys can only be kept unencrypted (Linux with no keyring); the file is then owner-only)
function sealKeys(c) { if (!c || !c.keys || !Object.values(c.keys).some(Boolean)) return c; try { if (!safeStorage.isEncryptionAvailable()) { if (!sealWarned) { sealWarned = true; log('API keys: no system keyring, so they are kept unencrypted in the settings file (readable by this user only)'); } return c; } const enc = {}; for (const [k, v] of Object.entries(c.keys)) enc[k] = v ? safeStorage.encryptString(String(v)).toString('base64') : ''; return { ...c, keys: Object.fromEntries(Object.keys(c.keys).map(k => [k, ''])), keysEnc: enc }; } catch (e) { log('API keys: encryption failed, kept as before', e.message); return c; } }
// (beta.10) sealed keys this session can't unlock (a Steam Deck's Game Mode has no KWallet, a folder moved to another PC)
// are kept as they are and written back while their key stays empty: dropped, they were gone for good, even where they open
const keptSealed = { keys: {}, ra: '' };
function unsealKeys(c) { if (c && c.keysEnc) { c.keys = c.keys || {}; for (const [k, v] of Object.entries(c.keysEnc)) { if (v && !c.keys[k]) { try { c.keys[k] = safeStorage.decryptString(Buffer.from(v, 'base64')); delete keptSealed.keys[k]; } catch { keptSealed.keys[k] = v; log('API key', k, 'could not be unlocked here (moved to another PC?): kept as it was; enter it again to use it here'); } } } delete c.keysEnc; } return c; }
function keepSealed(c) {
  if (!c) return c; const extra = {};
  for (const [k, v] of Object.entries(keptSealed.keys)) { if (c.keys && c.keys[k]) delete keptSealed.keys[k]; else extra[k] = v; } // a key entered again replaces the one kept
  if (Object.keys(extra).length) c = { ...c, keysEnc: { ...(c.keysEnc || {}), ...extra } };
  if (keptSealed.ra) { if (c.ra && c.ra.key) keptSealed.ra = ''; else if (c.ra) c = { ...c, ra: { ...c.ra, keyEnc: keptSealed.ra } }; }
  return c;
}
function sealed(c) {
  c = keepSealed(sealKeys(c));
  if (!c || !c.ra || !c.ra.key) return c;
  try { if (!safeStorage.isEncryptionAvailable()) return c; } catch { return c; }
  try { return { ...c, ra: { ...c.ra, key: '', keyEnc: safeStorage.encryptString(String(c.ra.key)).toString('base64') } }; } catch (e) { log('RetroAchievements key: encryption failed, kept as before', e.message); return c; }
}
function unsealed(c) {
  unsealKeys(c);
  if (c && c.ra && c.ra.keyEnc && !c.ra.key) { try { c.ra.key = safeStorage.decryptString(Buffer.from(c.ra.keyEnc, 'base64')); keptSealed.ra = ''; } catch (e) { keptSealed.ra = c.ra.keyEnc; log('RetroAchievements key could not be unlocked here (moved to another PC?): kept as it was; enter it again to use it here'); } }
  if (c && c.ra) delete c.ra.keyEnc; return c;
}
let steamLooked = false, steamMain; // (beta.10: Steam looked for again at most once a session, see buildLibrary; steamMain: Steam's own folder when the one set is a library elsewhere)
function persistCfg(next) { config.save(sealed(next)); return next; }
// What changed in a save that main has to act on: the display, Steam's tools, the accounts (re-checked on their own)
function cfgChanged(prev, next) {
  if (!prev || !next) return;
  // (beta.12) RomM's address or its settings changed: used from now on, its library read again on the next build
  if (JSON.stringify(prev.romm || {}) !== JSON.stringify(next.romm || {})) { rommApply(); rommLib = null; rommSyncedOnce = false; }
  const pu = prev.ui || {}, nu = next.ui || {};
  if (nu.display && nu.display !== pu.display) setTimeout(() => { try { moveToDisplay(nu.display); } catch (e) { log('display move', e.message); } }, 0);
  if ((prev.steam && prev.steam.hideTools !== false) !== (next.steam && next.steam.hideTools !== false) && alive()) win.webContents.send('library:changed', { steam: 1 });
  const ra0 = prev.ra || {}, ra1 = next.ra || {};
  if (String(ra0.user || '') !== String(ra1.user || '') || String(ra0.key || '') !== String(ra1.key || '')) retestSoon('ra');
  if (String((prev.keys || {}).fanart || '') !== String((next.keys || {}).fanart || '')) retestSoon('fanart');
  if (String((prev.keys || {}).steamgriddb || '') !== String((next.keys || {}).steamgriddb || '')) { retestSoon('steamgriddb'); artstudio.forget(); } // the Art Studio's lists gain (or lose) its posters
  if (['ssUser', 'ssPass', 'ssDevId', 'ssDevPass'].some(k => String((prev.keys || {})[k] || '') !== String((next.keys || {})[k] || ''))) { require('./main/screenscraper').credsChanged(); retestSoon('screenscraper'); artstudio.forget(); } // ScreenScraper (1.71): the same, for its sign-in
}

// ---------- displays (Settings → Display) ----------
const scr = () => { try { return screen && typeof screen.getAllDisplays === 'function' ? screen : null; } catch { return null; } };
function displaysList() {
  const S = scr(); if (!S) return [];
  const all = S.getAllDisplays(), prim = S.getPrimaryDisplay();
  let cur = null; try { if (alive()) cur = S.getDisplayMatching(win.getBounds()); } catch {}
  return all.map((d, i) => { const sf = d.scaleFactor || 1, w = Math.round(d.size.width * sf), h = Math.round(d.size.height * sf), primary = !!prim && d.id === prim.id;
    return { id: String(d.id), label: `Display ${i + 1} — ${w}×${h}` + (primary ? ' (main)' : ''), primary, current: cur ? d.id === cur.id : primary, width: w, height: h }; });
}
function displayById(id) { const S = scr(); if (!S || id == null || id === '') return null; return S.getAllDisplays().find(d => String(d.id) === String(id)) || null; }
// where the window opens: centred in the chosen display's work area (the OS picks the main display when nothing is chosen)
function startBounds() {
  try { const d = displayById(cfg && cfg.ui && cfg.ui.display); if (!d) return {}; const wa = d.workArea, w = Math.min(1600, wa.width), h = Math.min(900, wa.height);
    return { x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + Math.round((wa.height - h) / 2), width: w, height: h }; } catch { return {}; }
}
// move the window to another display now; a fullscreen window leaves fullscreen, moves, and goes fullscreen there again
let moving = null;
function moveToDisplay(id) {
  if (!alive()) return false; const d = displayById(id); if (!d) return false;
  // a move to this display is already under way (Settings moves live, then the save asks again): let it finish
  if (moving && moving.id === String(d.id)) return true;
  const S = scr(); if (!moving) { try { const cur = S.getDisplayMatching(win.getBounds()); if (cur && cur.id === d.id) return true; } catch {} }
  // another move still leaving fullscreen: take it over, and go fullscreen again at the end as it would have
  const wasFull = moving ? moving.wasFull : win.isFullScreen(), wa = d.workArea;
  if (moving) { clearTimeout(moving.t); moving = null; }
  const place = () => { if (!alive()) return; const b = win.getBounds(), w = Math.min(b.width, wa.width), h = Math.min(b.height, wa.height);
    win.setBounds({ x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + Math.round((wa.height - h) / 2), width: w, height: h });
    if (wasFull) win.setFullScreen(true); log('Moved to display', String(d.id)); };
  if (!wasFull) { place(); return true; }
  const m = moving = { t: null, id: String(d.id), wasFull: true }; let done = false;
  const go = () => { if (done || moving !== m) return; done = true; moving = null; clearTimeout(m.t); place(); };
  win.once('leave-full-screen', () => setTimeout(go, 50)); m.t = setTimeout(go, 800); // never stuck if the event doesn't come
  if (win.isFullScreen()) win.setFullScreen(false);
  return true;
}
handle('display:list', () => displaysList());
handle('display:move', ({ id } = {}) => moveToDisplay(String(id == null ? '' : id)));

// ---------- secrets out: backups and problem reports never carry keys, tokens or passwords ----------
const SECRET_NAME = /(key|token|password|passwd|secret)(enc)?$/i, NOT_SECRET = new Set(['fullscreenKey']); // a keyboard key, not a secret
function stripSecrets(v, depth = 0) {
  if (depth > 20) return undefined;
  if (Array.isArray(v)) return v.map(x => stripSecrets(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) { if (depth === 0 && (k === 'keys' || k === 'keysEnc')) continue; if (SECRET_NAME.test(k) && !NOT_SECRET.has(k)) continue; out[k] = stripSecrets(x, depth + 1); }
  return out;
}
// the values themselves, to blank out of any text that goes out (the log)
function secretValues() { const out = []; const add = x => { if (typeof x === 'string' && x.length >= 6) out.push(x); };
  try { add(cfg.ra && cfg.ra.key); for (const x of Object.values(cfg.keys || {})) add(x); } catch {} return out; }
function scrubText(t) { for (const x of secretValues()) t = t.split(x).join('[removed]');
  // (beta.10) the RetroAchievements account name too (older logs had it in cache names), then every path / name form
  try { const u = cfg && cfg.ra && String(cfg.ra.user || '').trim(); if (u && u.length >= 3) t = t.replace(new RegExp('(?<![A-Za-z0-9])' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'gi'), '[ra user]'); } catch {}
  return privacyScrub(t); }
const isPlain = v => !!v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, over) { if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over; const out = { ...base }; for (const [k, v] of Object.entries(over)) out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : v; return out; }
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
function freeName(dir, name, ext) { for (let i = 1; i < 100; i++) { const f = path.join(dir, name + (i > 1 ? ` (${i})` : '') + ext); if (!fs.existsSync(f)) return f; } return path.join(dir, `${name} ${Date.now()}${ext}`); }

// ---------- settings backup / restore ----------
const BACKUP_V = 1;
handle('settings:backup', async () => {
  let dir; try { dir = app.getPath('documents'); } catch { dir = require('os').homedir(); }
  const r = await dialog.showSaveDialog(alive() ? win : undefined, { title: 'Back up Boxshelf settings', defaultPath: freeName(dir, `Boxshelf settings ${stamp()}`, '.json'), filters: [{ name: 'Boxshelf settings', extensions: ['json'] }] });
  if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true };
  const h = loadHistory(), hist = {}; for (const [k, v] of Object.entries(h)) hist[k] = { count: v.count, ms: v.ms, last: v.last, ...(v.first ? { first: v.first } : {}), ...(v.long ? { long: v.long } : {}) };
  const data = { app: 'Boxshelf', version: app.getVersion(), backup: BACKUP_V, at: new Date().toISOString(), config: stripSecrets(cfg), history: hist };
  try { await fs.promises.writeFile(r.filePath + '.tmp', JSON.stringify(data, null, 1)); await fs.promises.rename(r.filePath + '.tmp', r.filePath); }
  catch (e) { try { await fs.promises.unlink(r.filePath + '.tmp'); } catch {} log('settings backup failed', e.message); return { ok: false, error: e.message }; }
  log('Settings backed up'); return { ok: true, file: r.filePath };
});
// checks a parsed backup; returns the reason it can't be used, or ''
function badBackup(b) {
  if (!isPlain(b) || b.app !== 'Boxshelf') return 'That isn\'t a Boxshelf settings backup.';
  if (typeof b.version !== 'string' || !/^\d+(\.\d+)*/.test(b.version)) return 'That backup has no Boxshelf version.';
  if (!isPlain(b.config) || !isPlain(b.config.ui) || !isPlain(b.config.systems)) return 'That backup has no settings in it.';
  if (b.history != null && !isPlain(b.history)) return 'The play history in that backup is damaged.';
  return '';
}
// the backup's settings over today's; today's keys and accounts stay (a backup never has them)
function restoredConfig(cur, b) {
  const next = deepMerge(cur, stripSecrets(b.config)); delete next.keysEnc;
  next.keys = { ...(cur.keys || {}) };
  next.ra = { ...(next.ra || {}), key: (cur.ra && cur.ra.key) || '' }; delete next.ra.keyEnc;
  if (cur.ra && cur.ra.key && cur.ra.user) next.ra.user = cur.ra.user; // the key belongs to this account
  return next;
}
// play history: per game the larger count / time and the later date, so nothing played since the backup is lost
function mergeHistory(h, add) {
  let n = 0; for (const [k0, v] of Object.entries(add || {})) { if (!isPlain(v) || k0 === '__proto__' || k0 === 'constructor' || k0 === 'prototype') continue; const k = String(k0).slice(0, 1024), e = (Object.prototype.hasOwnProperty.call(h, k) && h[k]) || { count: 0, ms: 0, last: 0 }; /* (beta.12: a restored backup can't reach the object's prototype) */
    h[k] = { ...e, count: Math.max(e.count, Math.max(0, +v.count || 0)), ms: Math.max(e.ms, Math.max(0, +v.ms || 0)), last: Math.max(e.last, Math.max(0, +v.last || 0)) }; /* (beta.12: this game's own sessions stay; the earlier first played and the longer session win) */
    if (+v.first > 0 && (!e.first || +v.first < e.first)) h[k].first = +v.first; if (+v.long > (e.long || 0)) h[k].long = +v.long; n++; }
  return n;
}
handle('settings:restore', async () => {
  const r = await openDialog(alive() ? win : undefined, { title: 'Restore Boxshelf settings', properties: ['openFile'], filters: [{ name: 'Boxshelf settings', extensions: ['json'] }] });
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  let b; try { const st = await fs.promises.stat(r.filePaths[0]); if (st.size > 32 * 1024 * 1024) return { ok: false, error: 'That file is too big to be a settings backup.' }; b = JSON.parse(await fs.promises.readFile(r.filePaths[0], 'utf8')); }
  catch (e) { return { ok: false, error: 'That file couldn\'t be read as a settings backup.' }; }
  const why = badBackup(b); if (why) return { ok: false, error: why };
  applyCfg(restoredConfig(cfg, b));
  if (b.history) { const n = mergeHistory(loadHistory(), b.history); if (n) saveHistory(); }
  log('Settings restored from a backup made with', String(b.version).slice(0, 20));
  if (alive()) { win.webContents.send('library:changed', { restored: 1 }); win.webContents.send('history:changed', { restored: 1 }); }
  return { ok: true };
});

// ---------- play history: forget it all ----------
handle('history:clear', () => { const h = loadHistory(); for (const k of Object.keys(h)) delete h[k]; saveHistory(); log('Play history cleared');
  if (alive()) { win.webContents.send('history:changed', { cleared: 1 }); win.webContents.send('library:changed', { history: 1 }); } return { ok: true }; });

// ---------- problem report (a zip on the Desktop to send when asking for help) ----------
function zipFolder(src, dest) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      // paths go in through the environment, never into the command text
      execFileQ('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $env:BS_SRC).FullName -DestinationPath $env:BS_ZIP -Force'], { env: { ...process.env, BS_SRC: src, BS_ZIP: dest } }, ok => resolve(ok && fs.existsSync(dest)));
    } else execFileQ('zip', ['-j', '-q', dest, ...fs.readdirSync(src).map(n => path.join(src, n))], {}, ok => resolve(ok && fs.existsSync(dest)));
  });
}
function execFileQ(cmd, args, opts, cb) { try { require('child_process').execFile(cmd, args, { windowsHide: true, timeout: 60000, ...opts }, err => cb(!err)); } catch { cb(false); } }
async function reportInfo() {
  const os = require('os'), L = [];
  L.push(`Boxshelf ${app.getVersion()}`, `Electron ${process.versions.electron}  Chrome ${process.versions.chrome}  Node ${process.versions.node}`);
  L.push(`OS: ${os.type()} ${os.release()} ${os.arch()}${typeof os.version === 'function' ? ' (' + os.version() + ')' : ''}`, `CPU: ${(os.cpus()[0] || {}).model || '?'} × ${os.cpus().length}`, `Memory: ${Math.round(os.totalmem() / 1073741824)} GB (${Math.round(os.freemem() / 1073741824)} GB free)`);
  L.push(`Packaged: ${app.isPackaged ? 'yes' : 'no'}  Windowed: ${WINDOWED ? 'yes' : 'no'}  Fullscreen now: ${alive() && win.isFullScreen() ? 'yes' : 'no'}`);
  // (1.82) how much memory Boxshelf itself uses, per process (the shelf, the GPU, helpers), to tell from a report whether
  // Boxshelf is what fills a PC's RAM
  L.push('', 'Boxshelf memory (working set):');
  try { let total = 0; for (const m of app.getAppMetrics()) { const mb = Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024); total += mb; L.push(`  ${m.type}${m.serviceName ? ' ' + m.serviceName : ''}: ${mb} MB`); }
    L.push(`  total: ${total} MB${launcher.isRunning() ? ' (a game is running)' : ''}`); } catch (e) { L.push('  ' + e.message); }
  L.push('', 'Displays:'); try { for (const d of displaysList()) L.push(`  ${d.label}${d.current ? ' ← Boxshelf' : ''}`); } catch {}
  L.push('', 'Graphics:');
  try { let t; const gpu = await Promise.race([app.getGPUInfo('basic'), new Promise(r => { t = setTimeout(() => r(null), 5000); })]); clearTimeout(t);
    if (gpu) { for (const g of (gpu.gpuDevice || [])) L.push(`  ${g.active ? '* ' : '  '}vendor ${g.vendorId} device ${g.deviceId}${g.driverVersion ? ' driver ' + g.driverVersion : ''}${g.description ? ' ' + g.description : ''}`); if (gpu.auxAttributes) L.push('  ' + JSON.stringify(gpu.auxAttributes).slice(0, 2000)); } else L.push('  (no answer)'); } catch (e) { L.push('  ' + e.message); }
  try { L.push('  features: ' + JSON.stringify(app.getGPUFeatureStatus())); } catch {}
  return L.join('\r\n') + '\r\n';
}
let reporting = null;
handle('app:reportProblem', () => reporting || (reporting = makeReport().finally(() => { reporting = null; })));
async function makeReport() {
  let desk; try { desk = app.getPath('desktop'); } catch {} if (!desk || !fs.existsSync(desk)) desk = require('os').homedir();
  const name = `Boxshelf problem report ${stamp()}`, tmp = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'boxshelf-report-'));
  try {
    for (const [f, n] of [[LOG, 'boxshelf.log'], [LOG + '.old', 'boxshelf.log.old']]) { try { await fs.promises.writeFile(path.join(tmp, n), scrubText(await fs.promises.readFile(f, 'utf8'))); } catch {} }
    const c = stripSecrets(cfg); if (c.ra) delete c.ra.user; // the account name isn't needed to help
    await fs.promises.writeFile(path.join(tmp, 'config.json'), scrubText(JSON.stringify(c, null, 2)));
    await fs.promises.writeFile(path.join(tmp, 'info.txt'), scrubText(await reportInfo()));
    const zip = freeName(desk, name, '.zip');
    if (await zipFolder(tmp, zip)) { log('Problem report written'); return { ok: true, file: zip }; }
    try { await fs.promises.unlink(zip); } catch {}
    const dir = freeName(desk, name, ''); await fs.promises.mkdir(dir, { recursive: true }); // no zip tool: the files in a folder instead
    for (const n of await fs.promises.readdir(tmp)) await fs.promises.copyFile(path.join(tmp, n), path.join(dir, n));
    log('Problem report written (folder)'); return { ok: true, file: dir, folder: true };
  } catch (e) { log('problem report failed', e.message); return { ok: false, error: e.message }; }
  finally { fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}

// ---------- account / API status (Settings → Accounts & services) ----------
const API_SERVICES = ['ra', 'fanart', 'steamgriddb', 'screenscraper'];
let apiStat = null; const apiStatFile = () => path.join(app.getPath('userData'), 'api-status.json');
function apiStatusLoad() { if (apiStat) return apiStat; apiStat = {}; try { const j = JSON.parse(fs.readFileSync(apiStatFile(), 'utf8')); if (isPlain(j)) for (const s of API_SERVICES) if (isPlain(j[s])) apiStat[s] = j[s]; } catch {} return apiStat; }
function apiConfigured(s) { return s === 'ra' ? !!(cfg.ra && cfg.ra.user && cfg.ra.key) : s === 'fanart' || s === 'steamgriddb' ? !!(cfg.keys && cfg.keys[s]) : s === 'screenscraper' ? require('./main/screenscraper').configured() : false; }
// what the screen shows: the last result, or 'none' while there's no account / key (a stale ok must not show for a removed key)
function apiStatusView() { const st = apiStatusLoad(), out = {}; for (const s of API_SERVICES) out[s] = apiConfigured(s) ? (st[s] || { state: 'none', at: 0, msg: 'Not checked yet' }) : { state: 'none', at: 0, msg: 'Not set up' }; return out; }
function apiStatusSave() { writeAtomic(apiStatFile(), JSON.stringify(apiStat)).catch(e => log('api status save', e.message)); } // (both services re-tested at once used to share one .tmp)
const apiRuns = {};
function testApi(s) {
  if (!API_SERVICES.includes(s)) throw new Error('Unknown service.');
  if (apiRuns[s]) return apiRuns[s];
  return apiRuns[s] = (async () => {
    let res;
    if (!apiConfigured(s)) res = { state: 'none', at: Date.now(), msg: 'Not set up' };
    else if (s === 'ra') {
      const user = cfg.ra.user, key = cfg.ra.key;
      try { const p = await ra.test(user, key); res = { state: 'ok', at: Date.now(), msg: 'Connected', user: String(p.user || user), points: +p.points || 0 }; }
      catch (e) { res = { state: 'fail', at: Date.now(), msg: scrubText(String(e && e.message || e)).slice(0, 300), user: String(user) }; }
    } else if (s === 'screenscraper') { // (the account's answer carries today's quota: shown on the Test toast)
      const r = await require('./main/screenscraper').test();
      res = r.ok ? { state: 'ok', at: Date.now(), msg: 'Working', ...(r.left != null ? { left: r.left } : {}) } : { state: 'fail', at: Date.now(), msg: scrubText(String(r.error || 'not accepted')).slice(0, 300) };
    } else {
      const r = s === 'steamgriddb' ? await require('./main/steamgrid').test(cfg.keys.steamgriddb) : await fanartTest(cfg.keys.fanart);
      res = r.ok ? { state: 'ok', at: Date.now(), msg: 'Key works' } : { state: 'fail', at: Date.now(), msg: scrubText(String(r.error || 'not accepted')).slice(0, 300) };
    }
    apiStatusLoad()[s] = res; apiStatusSave();
    return res;
  })().finally(() => { apiRuns[s] = null; });
}
const retestT = {};
function retestSoon(s) {
  clearTimeout(retestT[s]);
  retestT[s] = setTimeout(async () => { retestT[s] = null;
    try { if (apiRuns[s]) await apiRuns[s].catch(() => {}); await testApi(s); } catch (e) { log('API check', s, e.message); }
    if (alive()) win.webContents.send('api:status', apiStatusView()); }, 1500);
}
handle('api:status', () => apiStatusView());
// per console: are achievements on and signed in inside its emulator? (reads the emulators' own settings; never tokens)
handle('ra:emulators', () => require('./main/raemu').check({ ...cfg, systems: Object.fromEntries(Object.entries(cfg.systems).map(([k, v]) => [k, v ? { ...v, emulator: emuPath(v.emulator) } : v])) }, ra.CONSOLE_ID)); // real paths ({app}, %VAR%, quotes), as a launch uses
handle('api:test', async ({ service } = {}) => { const s = String(service || ''); if (retestT[s]) { clearTimeout(retestT[s]); retestT[s] = null; } /* tested now: the re-test the save queued isn't needed */ await testApi(s); const v = apiStatusView()[s]; if (alive()) win.webContents.send('api:status', apiStatusView()); return v; });
// temp folders a crash or power cut left behind (manual downloads, e-book unpacking)
function sweepTemp() {
  const tmp = require('os').tmpdir(), old = Date.now() - 864e5;
  fs.promises.readdir(tmp).then(names => { for (const n of names) if (/^boxshelf-(manual|emanual)/i.test(n)) { const f = path.join(tmp, n); fs.promises.stat(f).then(st => { if (st.mtimeMs < old) return fs.promises.rm(f, { recursive: true, force: true }); }).catch(() => {}); } }).catch(() => {});
}
// data\thumbs: small copies of covers for the shelf. Old ones (covers since replaced, games removed) are cleared out:
// anything not used for 60 days, and the oldest beyond 300 MB
async function pruneThumbs() {
  const dir = path.join(app.getPath('userData'), 'thumbs'); let names = []; try { names = await fs.promises.readdir(dir); } catch { return; }
  const list = []; for (const n of names) { try { const st = await fs.promises.stat(path.join(dir, n)); list.push({ f: path.join(dir, n), t: Math.max(st.atimeMs, st.mtimeMs), s: st.size }); } catch {} }
  list.sort((a, b) => b.t - a.t); let total = 0, gone = 0; const old = Date.now() - 60 * 864e5;
  for (const x of list) { total += x.s; if (x.t < old || total > 300 * 1024 * 1024) { try { await fs.promises.unlink(x.f); gone++; } catch {} } }
  if (gone) log('Thumbnails: cleared', gone, 'old ones');
}
// ---------- Phone companion (main/companion.js): a phone on the home Wi-Fi browses the library, starts games, reads
// manuals and works as a remote. Off until switched on in Settings → Phone companion.
// Its buttons: into the Home menu while that's open (a window of its own); Home opens the menu (over the game, or the
// shelf's, which the shelf accepts only on the shelf / Details); everything else reaches the shelf as one more controller
// (renderer/companion/tv-input.js). While a game runs only Home does something: the game has the controller.
function companionInput(m) {
  if (!m || typeof m !== 'object') return;
  if (m.text != null || m.key) { if (alive() && !homemenu.isOpen() && !launcher.isRunning()) win.webContents.send('companion:input', m); return; }
  const b = String(m.b || ''), down = !!m.d;
  if (homemenu.isOpen()) { if (['up', 'down', 'left', 'right', 'a', 'b', 'start', 'home'].includes(b)) homemenu.button(b, down); return; }
  if (b === 'home') { if (!down || cfg.ui.homeMenu === false) return; if (launcher.isRunning()) Promise.resolve(homemenu.open()).catch(e => log('home menu', e && e.message)); else if (alive()) win.webContents.send('shelf:menuRequest'); return; }
  if (launcher.isRunning() || !alive()) return;
  win.webContents.send('companion:input', { b, d: down });
}
function initCompanion() {
  companion.init({ log, dataDir: app.getPath('userData'), webDir: path.join(__dirname, 'renderer', 'companion'), fontDir: path.join(__dirname, 'renderer', 'fonts'), version: app.getVersion(),
    library: () => { if (lastLib) return lastLib; try { return lastLib = JSON.parse(fs.readFileSync(libCacheFile(), 'utf8')); } catch { return []; } }, // the shelves as last scanned
    hidden: () => (Array.isArray(cfg.ui.hidden) ? cfg.ui.hidden : []), glyphs: () => ({ style: shelfGlyphs, swap: shelfSwap }), homeMenu: () => cfg.ui.homeMenu,
    running: () => (launching || launcher.isRunning() ? { id: histOpen && histOpen.id, kind: runKind } : null),
    // Play goes through the shelf's own launch (boot video / slide, history, Home menu), as pressing A on that box would
    play: p => { if (!alive()) return false; win.webContents.send('companion:input', { play: p }); return true; },
    quit: async () => { if (!launcher.isRunning()) return; log('Phone companion: quit'); pendingPower = null; coverForQuit(); closeGame(); },
    input: companionInput, thumb: (f, st, h) => thumbFor(f, st, h),
    raFor: sys => ra.enabled() && !!ra.CONSOLE_ID[sys], achievements: (sys, title) => (ra.enabled() && ra.CONSOLE_ID[sys] ? ra.progress(sys, title, false) : null),
    changed: st => { if (alive()) win.webContents.send('companion:state', st); } });
}
handle('companion:state', () => companion.state());
handle('companion:set', o => companion.set(o && typeof o === 'object' ? { enabled: o.enabled, port: o.port } : {}));
handle('companion:forget', ({ id } = {}) => companion.forget(String(id || '')));
handle('companion:pin', () => companion.renewPin());
// No page Boxshelf shows ever needs the camera, microphone, location, notifications…: refuse them all, everywhere
function denyPermissions(ses) { try { ses.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'fullscreen')); ses.setPermissionCheckHandler((wc, perm) => perm === 'fullscreen'); } catch {} }
app.on('session-created', denyPermissions);
if (firstInstance) app.whenReady().then(() => { try { startUp(); } catch (e) {
  // something on this PC stops Boxshelf from starting (a read-only folder, a damaged file): say so, don't hang invisibly
  log('ERROR starting', e && e.stack || e);
  try { dialog.showErrorBox('Boxshelf could not start', `${e && e.message || e}\n\nDetails are in data\\boxshelf.log. Boxshelf needs to be able to write to its own folder.`); } catch {}
  try { app.exit(1); } catch { process.exit(1); }
} });
function startUp() {
  if (session && session.defaultSession) denyPermissions(session.defaultSession);
    config.init(app.getPath('userData'), log);
    profiles.init(app.getPath('userData'), log);
    config.useFile(profiles.configFile());
  arcadenames.init(app.getPath('userData'), log); // (beta.7) arcade game names, main/arcadenames.js
  emusetup.init({ log, dataDir: app.getPath('userData'), appRoot: paths.appRoot() }); racores.init({ log }); previews.init({ log, dataDir: app.getPath('userData'), appRoot: paths.appRoot() }); ytclips.init({ log, dataDir: app.getPath('userData') }); addgames.init({ log });
  cfg = unsealed(config.load()); { const fx = fixXenia(cfg); if (fx !== cfg) { cfg = fx; try { persistCfg(cfg); } catch {} } } applyArtLibrary();
  // (beta.12) a Steam Deck's 7" 1280x800 screen: TV-sized labels came out ~1.4 mm, and the automatic scale (by height, 800)
  // stays at 1. Once (deckScaled), Interface size starts at 115%; a size chosen in Settings later is never changed again
  if (linux.isLinux && steamdeck.info().deck && !cfg.ui.deckScaled) { cfg = { ...cfg, ui: { ...cfg.ui, uiScale: Math.max(1.15, +cfg.ui.uiScale || 1), deckScaled: true } }; try { persistCfg(cfg); log('Steam Deck: Interface size starts at', cfg.ui.uiScale); } catch {} }
  romm.init({ dataDir: app.getPath('userData'), log: (...a) => log(...a) }); rommApply(); // (beta.12) RomM: its saved library and covers live in the data folder
  { const here = paths.appRoot(), L = Array.isArray(cfg.ui.installs) ? cfg.ui.installs.filter(x => typeof x === 'string') : []; if (!L.some(x => x.toLowerCase() === here.toLowerCase())) { cfg.ui.installs = [here, ...L].slice(0, 6); try { persistCfg(cfg); } catch {} } } // where Boxshelf has run from: a later move can offer the magazines left here
  // consoles added in an update (PS5): found once, as setup would have (an emulator or games folder set by hand is kept)
  { const known = Array.isArray(cfg.ui.knownSystems) ? cfg.ui.knownSystems : [], add = ['ps5', 'sw2'].filter(id => !known.includes(id) && cfg.systems[id]);
    if (add.length) { for (const id of add) { const c = cfg.systems[id]; if (cfg.setupDone && !c.emulator && !(c.romDirs || []).length) { const d = detectSystem(id); if (d) { if (d.emulator) c.emulator = d.emulator; if (d.romDirs.length) c.romDirs = d.romDirs; log('New console', id, d.emulator ? 'emulator found' : 'no emulator', d.romDirs.length + ' games folder(s)'); } } }
      cfg.ui.knownSystems = [...known, ...add]; try { persistCfg(cfg); } catch {} } }
  // Switch 2: builds come and go (forks get swapped often); a shelf build that's gone points at the newest one there is
  { const e = cfg.systems.sw2 && cfg.systems.sw2.emulator; if (e && !paths.isFile(emuPath(e))) nx2.builds(sw2Roots()).then(l => { const b = l.sort((a, c) => c.date - a.date)[0]; if (b && cfg.systems.sw2 && !paths.isFile(emuPath(cfg.systems.sw2.emulator))) { log('Switch 2: shelf build gone, now', b.label); applyCfg({ ...cfg, systems: { ...cfg.systems, sw2: { ...cfg.systems.sw2, emulator: b.exe } } }); } }).catch(() => {}); }
  if (cfg.ra && cfg.ra.key) { try { const raw = JSON.parse(fs.readFileSync(config.file(), 'utf8')); if (raw && raw.ra && raw.ra.key) persistCfg(cfg); } catch {} } // an older plain-text key: encrypt it now
  covers.init(app.getPath('userData'), log); require('./main/steamgrid').init({ dataDir: app.getPath('userData'), log, key: () => (cfg && cfg.keys && cfg.keys.steamgriddb) || '' }); require('./main/screenscraper').init({ dataDir: app.getPath('userData'), log, creds: () => { const k = (cfg && cfg.keys) || {}; return { user: k.ssUser || '', pass: k.ssPass || '', devId: k.ssDevId || '', devPass: k.ssDevPass || '' }; } }); initArtStudio(); initManualStudio(); // (SteamGridDB: the Art Studio's optional poster source)
  commercials.init({ log, dir: path.join(app.getPath('userData'), 'commercials'), memoFile: path.join(app.getPath('userData'), 'commercials.json'), fetchBuf: async url => { const r = await net.fetch(url, { signal: AbortSignal.timeout(30000) }); /* (beta.10: a stalled answer gives up) */ if (r.status === 404) return null; if (!r.ok) throw new Error('archive.org answered ' + r.status); return Buffer.from(await r.arrayBuffer()); }, // (busy / down: a failure, so no game is noted as "no ad" for a month)
    // url → file, streamed; resolves to the bytes written (0: not found), rejects past max bytes
    // (beta.10) gives up when nothing arrives for 60 s or it takes over 15 minutes in all (a stalled storage server hung it
    // for the whole session: that ad never played or retried); the rejection makes commercials.local() drop the .part
    fetchFile: async (url, dest, max) => { const ac = new AbortController(); let idle = setTimeout(() => ac.abort(), 60000); const all = setTimeout(() => ac.abort(), 15 * 60000);
      try { const r = await net.fetch(url, { signal: ac.signal }); if (!r.ok || !r.body) { try { if (r.body) await r.body.cancel(); } catch {} return 0; } let n = 0;
        const { Readable, Transform } = require('stream');
        await require('stream/promises').pipeline(Readable.fromWeb(r.body), new Transform({ transform(c, e, cb) { clearTimeout(idle); idle = setTimeout(() => ac.abort(), 60000); n += c.length; cb(n > max ? new Error('too big') : null, c); } }), fs.createWriteStream(dest));
        return n; } finally { clearTimeout(idle); clearTimeout(all); } } });
  stremio.init({ log, fanartKey: () => (cfg && cfg.keys && cfg.keys.fanart) || '', artDir: path.join(app.getPath('userData'), 'stremio-art'), fetchBuf: async url => { const r = await net.fetch(url, { signal: AbortSignal.timeout(30000) }); /* (beta.10: a stalled answer gives up) */ if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); } }); // null = really not there; other failures throw, so nothing "missing" is cached for them
  icons.init(app.getPath('userData'), log);
  x360.init(app.getPath('userData'), log); scanSetLog(log); // (beta.10: games folders that can't be read go in the log)
  steamart.init(app.getPath('userData'), log); pcgames.init(app.getPath('userData'), log); pccovers.init({ dataDir: app.getPath('userData'), log, fileUrl, fetchImage, steamgrid: require('./main/steamgrid'), steamCover: id => steamart.local(id).front, match: covers.sgMatch, steamSearch: (t, exact) => pcgames.steamSearch(t, exact) });
  wiiumanual.init(app.getPath('userData'), log);
  ra.init(app.getPath('userData'), log); ra.setCredentials(cfg.ra && cfg.ra.enabled !== false ? cfg.ra.user : '', cfg.ra && cfg.ra.key);
  manuals.init(log); archive.init(log); manuals.setStore(path.join(app.getPath('userData'), 'manual-auto.json')); manuals.setRejectStore(path.join(app.getPath('userData'), 'manual-rejects.json'));
  manuals.setShrink(shrinkPage); // (beta.9) oversized manual pages made smaller in the background image window
  manualcoll.init({ cacheDir: path.join(app.getPath('userData'), 'boxart-cache'), memoFile: path.join(app.getPath('userData'), 'manual-collections.json'), log });
  protocol.handle('bsfile', serveFile);
  createWindow();
  initCompanion(); // (after the window: what it reports goes to Settings there)
  setTimeout(watchShelf, 4000);
  setTimeout(() => { wmReady = true; wmStart(); }, 3000); // the Wii remote (Settings → Controller → Wii remote)
  nx2.setMemoFile(path.join(app.getPath('userData'), 'sw2-builds.json'));
  setTimeout(() => makeBacks(CONSOLES.map(c => c.id)).then(() => makeSpines(CONSOLES.map(c => c.id))), 90000); // backs and spines for games the art checks found none for (a few at most, after the busy start)
  // Switch 2: the build list ready before the first Play (each build's .nup check reads its 40-60 MB program once, then it's remembered)
  setTimeout(() => { if ((cfg.systems.sw2 || {}).emulator || (cfg.systems.sw2 || {}).romDirs) nx2.builds(sw2Roots()).catch(() => {}); }, 20000);
  setTimeout(watchRoms, 6000); // after the busy start
  // (1.82) a newer beta on the public page: the shelf says so once (Settings → About → Check for new betas turns it off)
  updates.init(log);
  setTimeout(() => { if (cfg.ui.updateCheck === false) return;
    updates.check(app.getVersion()).then(r => { if (r && r.newer && alive()) win.webContents.send('app:update', r); }).catch(() => {}); }, 25000);
  setTimeout(sweepTemp, 20000);
  // once: empty the web cache an older version let grow (the 64 MB limit keeps it small from here on)
  setTimeout(() => { try { const mark = path.join(app.getPath('userData'), '.cache-trimmed'); if (fs.existsSync(mark)) return; session.defaultSession.clearCache().then(() => { fs.writeFileSync(mark, ''); log('Web cache emptied'); }).catch(() => {}); } catch {} }, 25000);
  setTimeout(pruneThumbs, 30000);
}

app.on('window-all-closed', () => app.quit());
