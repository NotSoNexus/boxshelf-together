// The in-game Home menu: a transparent overlay window over the running emulator (it never takes focus, so the game
// stays fullscreen and keeps receiving keys). The XInput helper (padwatch) reports the Home trigger and, while the
// menu is open, the controller buttons; this module shows the menu, pauses the game and sends the emulator's own
// hotkeys for the chosen action.
const path = require('path');
const { BrowserWindow, screen } = require('electron');

// Default hotkeys of each emulator (a console's settings can override any of them: systems.<id>.hotkeys).
// pause is a toggle in all of these. Leave an action out when the emulator has no such feature or no default key.
const HOTKEYS = {
  dolphin: { pause: 'f10', save: 'shift+f1', load: 'f1', shot: 'f9', slot: 1 },
  pcsx2: { pause: 'space', save: 'f1', load: 'f3', shot: 'f8' },
  ppsspp: { save: 'f2', load: 'f4', shot: 'f12' },
  eden: { pause: 'f4', shot: 'ctrl+p' },
  cemu: { shot: 'f12' }, // no save states; F12 is Cemu's screenshot key
  xenia: {},
  shadps4: {},
  rpcs3: { shot: 'f12' }, // RPCS3: F12 screenshot; no default pause toggle or save-state key
  azahar: { pause: 'f4', save: 'ctrl+c', load: 'ctrl+v', shot: 'ctrl+p' }, // Azahar's defaults (save: oldest slot, load: newest)
  // (beta.7) RetroArch's own default keys (no pause: it pauses itself when the Home menu takes the focus) and DuckStation's;
  // Settings → <console> → Set up for me puts them back if they were changed (main/emusetup.js)
  retroarch: { save: 'f2', load: 'f4', shot: 'f8' },
  duckstation: { pause: 'space', save: 'f2', load: 'f1', shot: 'f10' },
  other: {}
};
function emulatorKind(systemId, exe) {
  const n = path.basename(exe || '').toLowerCase();
  if (/^retroarch/.test(n)) return 'retroarch';
  if (/duckstation/.test(n)) return 'duckstation';
  if (/dolphin/.test(n) || systemId === 'gc' || systemId === 'wii') return 'dolphin';
  if (/pcsx2/.test(n) || systemId === 'ps2') return 'pcsx2';
  if (/ppsspp/.test(n) || systemId === 'psp') return 'ppsspp';
  if (/cemu/.test(n) || systemId === 'wiiu') return 'cemu';
  if (/eden|yuzu|sudachi|citron|suyu|eglantine/.test(n) || systemId === 'sw' || systemId === 'sw2') return 'eden';
  if (/xenia/.test(n) || systemId === 'x360') return 'xenia';
  if (/shadps4/.test(n) || systemId === 'ps4') return 'shadps4';
  if (/rpcs3/.test(n) || systemId === 'ps3') return 'rpcs3';
  if (/azahar|lime3ds|citra/.test(n) || systemId === 'n3ds') return 'azahar';
  return 'other';
}
function hotkeysFor(systemId, exe, overrides) { return Object.assign({}, HOTKEYS[emulatorKind(systemId, exe)], overrides || {}); }

let win = null, padwatch = null, log = () => {}, onQuit = () => {}, onPower = () => {}, onShelf = () => {}, getSound = () => null, getUi = () => ({});
let session = null; // { meta, keys, startedAt, open, paused }
let shelf = null;   // the shelf version of the menu while it's open: { open: true }
let hideT = null;
let topGuard = null;

let getMainWin = () => null;
// the screen Boxshelf itself is on (a TV set up as the second display), not always the primary one
function displayBounds() { try { const m = getMainWin(); if (m && !m.isDestroyed()) return screen.getDisplayMatching(m.getBounds()).bounds; } catch {} return screen.getPrimaryDisplay().bounds; }
// menu-wide preferences: which face button confirms, and the chosen audio output device
function uiExtras() { let u = {}; try { u = getUi() || {}; } catch {} return { confirmButton: u.confirmButton === 'b' ? 'b' : 'a', audioOut: typeof u.audioOut === 'string' ? u.audioOut : '', reduceMotion: u.reduceMotion === true || u.reduceMotion === 'system' ? u.reduceMotion : false }; } /* (beta.12: the menu follows Boxshelf's Reduce motion, not the system by itself) */
// Confirm "Match my controller" (auto) and Home pressed on a Switch pad: its A (the right button) confirms, as on the shelf,
// and the prompts show its letters (whatever the setting). The helper reports Nintendo pads by position: their A arrives as 'b'.
function ninExtras() { let u = {}; try { u = getUi() || {}; } catch {}
  if (!(padwatch && typeof padwatch.homeFromNintendo === 'function' && padwatch.homeFromNintendo())) return {};
  return u.confirmButton !== 'a' && u.confirmButton !== 'b' ? { confirmButton: 'b', glyphs: 'nintendo' } : { glyphs: 'nintendo' }; }
function init(opts) { if (opts.getWin) getMainWin = opts.getWin; if (opts.getSound) getSound = opts.getSound; if (opts.getUi) getUi = opts.getUi; padwatch = opts.padwatch; log = opts.log || log; onQuit = opts.onQuit || onQuit; onPower = opts.onPower || onPower; onShelf = opts.onShelf || onShelf; hookWake(); }
// (Electron's power events only once the app is ready)
let wakeHooked = false;
function hookWake() { if (wakeHooked) return; wakeHooked = true; try { const { app, powerMonitor } = require('electron'); if (powerMonitor && app && typeof app.whenReady === 'function') app.whenReady().then(() => powerMonitor.on('resume', woke)).catch(() => {}); } catch {} }

function ensureWindow() {
  if (win && !win.isDestroyed()) { try { const b = displayBounds(), c = win.getBounds(); if (b.x !== c.x || b.y !== c.y || b.width !== c.width || b.height !== c.height) win.setBounds(b); } catch {} return win; }
  const b = displayBounds();
  win = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, transparent: true, focusable: false, skipTaskbar: true,
    resizable: false, movable: false, hasShadow: false, fullscreenable: false, backgroundColor: '#00000000', title: 'Boxshelf Home',
    webPreferences: { preload: path.join(__dirname, '..', 'preload-home.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.setIgnoreMouseEvents(true);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'home.html'));
  win.on('closed', () => { stopTopGuard(); win = null; });
  // (beta.9) the overlay's own page crashed (it did once, the moment the menu opened on the shelf): the controller then went
  // to a dead window, the shelf waited for a menu that never closed, and the Home button found it "already open". Now the
  // dead window goes, the menu closes the normal way (Resume: the controller back to the shelf or the game, a paused game
  // unpaused), and the next Home press makes a fresh overlay
  win.webContents.on('render-process-gone', (e, d) => {
    if (d && d.reason === 'clean-exit') return;
    log('home menu: its page crashed (' + (d && d.reason) + ' ' + (d && d.exitCode) + '): closing the menu so the controller works again');
    const w = win; win = null; clearTimeout(hideT); stopTopGuard();
    try { if (w && !w.isDestroyed()) w.destroy(); } catch {}
    if ((session && session.open) || shelf) { try { act('resume'); } catch (err) { log('home menu: resume after the crash failed', err.message); shelf = null; if (session) session.open = false; try { padwatch.setMenu(false); } catch {} } }
  });
  return win;
}
// Over an app (Stremio, Nuvio), the menu takes the focus while it's open: the app stays in front behind it otherwise and
// keeps reading the controller itself, so it went on moving around under the menu. Games don't need it (they're paused).
const overApp = () => !!(session && session.meta && session.meta.systemId === 'media');
function takeFocus() { if (!overApp() || !win || win.isDestroyed()) return; try { win.setFocusable(true); const b = win.getNativeWindowHandle(); padwatch.focusOnce(b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0))); } catch (e) { log('home menu focus', e.message); } }
function giveBack() { if (!win || win.isDestroyed()) return; try { win.setFocusable(false); } catch {} if (session && overApp()) padwatch.front(true); } // (the pointer stays where it was)
function stopTopGuard() { clearInterval(topGuard); topGuard = null; }
function keepOnTop() {
  const w = win;
  if (!w || w.isDestroyed()) return;
  try {
    // A fullscreen emulator can briefly re-assert its z-order after the Guide press.
    // Re-apply the highest Electron window level while the Home menu is visible.
    w.setAlwaysOnTop(true, 'screen-saver');
    if (!w.isVisible()) w.showInactive();
    w.moveTop();
  } catch (e) { log('home menu topmost', e.message); }
}
function startTopGuard() {
  stopTopGuard();
  // Run immediately, again after the emulator's fullscreen transition, then while this overlay is open.
  keepOnTop();
  setTimeout(() => { if ((session && session.open) || shelf) keepOnTop(); }, 120);
  setTimeout(() => { if ((session && session.open) || shelf) keepOnTop(); }, 500);
  topGuard = setInterval(() => {
    if (!((session && session.open) || shelf)) return stopTopGuard();
    keepOnTop();
  }, 900);
  if (topGuard.unref) topGuard.unref();
}
function showWin() { ensureWindow(); clearTimeout(hideT); startTopGuard(); }
function hideWinSoon(ms) { clearTimeout(hideT); hideT = setTimeout(() => { if (win && !win.isDestroyed() && !(session && session.open) && !shelf) { stopTopGuard(); win.hide(); } }, ms); }

// a game started: remember what's running and load the overlay now so it opens instantly later
function begin(meta) {
  if (process.platform === 'linux') return; // (Linux: no controller helper to open it during a game yet; no overlay window)
  // a shelf menu left open (or never closed because its page reloaded) must not capture the game's menu
  if (shelf) { shelf = null; padwatch && padwatch.setMenu(false); }
  session = { meta: meta || {}, keys: hotkeysFor(meta.systemId, meta.exe, meta.hotkeys), startedAt: Date.now(), open: false, paused: false, ready: false };
  // until the game's window is up the emulator can't take a pause key (and the loading screen is still in front): a
  // Home press then opens the menu at once and pauses as soon as the game is ready (see ready()). Never later than 15 s.
  const s0 = session, rt = setTimeout(() => { if (session === s0 && !s0.ready) ready(); }, 15000); if (rt.unref) rt.unref();
  try { ensureWindow(); } catch (e) { log('home menu window', e.message); }
}
function setMeta(extra) { if (session) Object.assign(session.meta, extra || {}); }
function end() { session = null; shelf = null; stopTopGuard(); padwatch && padwatch.setMenu(false); if (win && !win.isDestroyed()) { win.destroy(); win = null; } }

function actionsFor(k) { const a = ['resume']; if (k.save) a.push('save'); if (k.load) a.push('load'); if (k.shot) a.push('shot'); a.push('power', 'quit'); return a; }

async function open() {
  if (!session || session.open) return;
  session.open = true; session.slept = false;
  const k = session.keys, m = session.meta;
  // already paused (e.g. left paused by Sleep): don't toggle it back on
  const s = session;
  // the menu comes up straight away; pausing happens alongside (it used to wait for the pause key first)
  padwatch.setMenu(true); showWin(); s.shownAt = Date.now(); takeFocus();
  const send = () => win && !win.isDestroyed() && session === s && win.webContents.send('home:open', { inGame: true, title: m.title, system: m.systemName, cover: m.cover, accent: m.accent, glyphs: m.glyphs, layout: m.layout,
    startedAt: s.startedAt, actions: actionsFor(k), power: ['sleep', 'restart', 'shutdown'], canSave: !!k.save, slot: k.slot || 0, paused: s.paused, sound: getSound() || undefined, ...uiExtras(), ...ninExtras() });
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
  if (!s.ready) { s.pausePending = true; log('home menu: open', m.title || '', '(game still starting: pauses when its window is up)'); return; }
  await pauseNow(s);
}
async function pauseNow(s) {
  const k = s.keys, m = s.meta;
  if (s.pausing) return; // a pause key is already on its way (menu closed and reopened quickly): a second would undo it
  if (k.pause && !s.paused) { s.pausing = true; try {
    const ok = await padwatch.sendKeys([k.pause]);
    if (session !== s) return; // the game ended meanwhile
    if (ok && !s.open) { await padwatch.sendKeys([k.pause]); log('home menu: closed before the pause landed, unpaused again'); return; } // closed while pausing: undo it
    s.paused = ok;
    if (win && !win.isDestroyed()) win.webContents.send('home:paused', ok);
  } finally { s.pausing = false; } }
  log('home menu: open', m.title || '', s.paused ? '(paused)' : k.pause ? '(could not pause)' : '');
}
// The PC woke from a Sleep chosen in this menu: the game was left paused for the menu's Resume, so the menu comes back
// over it. Boxshelf can't read the emulator's pause state: a user who unpaused in the emulator first got a Home that
// didn't pause the game and a Resume that paused it (and every Home / Resume after that stayed the wrong way round).
function woke() {
  const s = session; if (!s || !s.slept) return; s.slept = false; if (s.open || !s.paused) return;
  log('home menu: woke from sleep, menu back over the paused game');
  setTimeout(() => { if (session === s && !s.open && s.paused) Promise.resolve(open()).catch(e => log('home menu', e && e.message)); }, 1500);
}
// the game's window is up and Boxshelf has stepped aside: from now on the menu can pause it. A menu opened while it was
// starting is brought back on top of the game (which just came to the front) and the game is paused now.
function ready() {
  const s = session; if (!s || s.ready) return; s.ready = true;
  if (s.open) { showWin(); setTimeout(() => { if (session === s && s.open) showWin(); }, 400); if (s.pausePending) { s.pausePending = false; pauseNow(s); } }
}
// keep the menu above Boxshelf's own loading screen while that screen is re-asserting itself on top
function raise() { if (isOpen()) keepOnTop(); }
function button(name, down) {
  if (!(((session && session.open) || shelf) && win && !win.isDestroyed())) return;
  // the Guide tap that opened the menu (or the controller's own echo of it) must not close it straight away
  const since = Date.now() - ((session && session.open && session.shownAt) || (shelf && shelf.shownAt) || 0);
  if (down && (name === 'home' || name === 'start') && since < 450) { log('home menu: ignored', name, 'just after opening (' + since + ' ms)'); return; }
  win.webContents.send('home:button', { btn: name, down });
}
const isOpen = () => !!((session && session.open) || shelf);

// The shelf version: Boxshelf itself is in front, nothing is paused; the choice goes back to the shelf (or Power).
function openShelf(info) {
  if (session || shelf) return false;
  shelf = { open: true, shownAt: Date.now() }; padwatch.setMenu(true); showWin();
  const send = () => win && win.webContents.send('home:open', Object.assign({ inGame: false, actions: ['shelfhome', 'museum', 'settings', 'power'], power: ['sleep', 'restart', 'shutdown', 'quitapp'] }, uiExtras(), info || {}));
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
  log('home menu: open on the shelf'); return true;
}

const TOAST = { save: 'State saved', load: 'State loaded', shot: 'Screenshot saved' };
async function act(action) {
  if (shelf && !(session && session.open)) { shelf = null; padwatch.setMenu(false); hideWinSoon(300); log('home menu (shelf):', action); onShelf(action); return; }
  if (!session || !session.open) return;
  session.open = false; padwatch.setMenu(false);
  if (action !== 'quit' && action !== 'restart' && action !== 'shutdown') setTimeout(giveBack, 120); // back to the app behind (quitting closes it anyway; after Sleep the app must have it again on waking, not the hidden menu)
  const k = session.keys, keys = [];
  if (action === 'quit') { log('home menu: quit'); hideWinSoon(250); onQuit(); return; }
  // Restart / Shut down from a game: close it properly first; the power action runs once it has exited
  if (action === 'restart' || action === 'shutdown') { log('home menu:', action, '(closing the game first)'); hideWinSoon(250); onQuit(action); return; }
  // Sleep from a game: save a state if the emulator can, leave the game paused (the menu's Resume unpauses after wake)
  if (action === 'sleep') { if (k.save) await padwatch.sendKeys([k.save]); hideWinSoon(200); log('home menu: sleep'); if (session) session.slept = true; setTimeout(() => onPower('sleep'), 600); return; }
  if (k[action]) keys.push(k[action]);
  const unpause = session.paused; if (unpause) { if (keys.length) keys.push('wait150'); keys.push(k.pause); }
  // the screenshot must not catch the menu: let the panel slide away first
  if (action === 'shot') await new Promise(r => setTimeout(r, 380));
  const ok = keys.length ? await padwatch.sendKeys(keys) : true;
  if (ok && unpause && session) session.paused = false; // only once the unpause key really went through
  const alive_ = win && !win.isDestroyed();
  if (!ok && alive_ && (TOAST[action] || unpause)) { win.webContents.send('home:toast', TOAST[action] ? `Couldn't ${action === 'shot' ? 'take the screenshot' : action === 'save' ? 'save the state' : 'load the state'}` : `Couldn't unpause the game`); hideWinSoon(2600); }
  else if (TOAST[action] && alive_) { win.webContents.send('home:toast', TOAST[action] + (action !== 'shot' && k.slot ? ` · slot ${k.slot}` : '')); hideWinSoon(2300); }
  else hideWinSoon(400);
  log('home menu:', action);
}

module.exports = { init, begin, setMeta, end, open, ready, raise, openShelf, isOpen, button, act, woke, hotkeysFor, emulatorKind, HOTKEYS };
