// Boxshelf on Android: the real window.boxshelf (the Windows build gets it from preload.js).
// Loaded after mock.js, which provides harmless defaults for everything not listed here; this file replaces the calls
// that matter on Android: settings, finding emulators, picking folders, scanning, launching and coming back.
// In a normal browser it does nothing (the demo stays), unless the page has ?fakeNative=1 (a pretend phone, for testing).
(function () {
  const status = m => { window.__bsAndroid = m; try { console.log('[boxshelf] status ' + m); } catch {} try { if (status.note) status.note(); } catch {} }; // the device tests read this (beta.10: the emulator test from status.note's file)
  // on the device: Capacitor says so, or Android's bridge object is there (it exists from the first line of the page)
  const isNative = !!((window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) || window.androidBridge ||
    (window.Capacitor && Capacitor.getPlatform && Capacitor.getPlatform() === 'android'));
  const fake = /[?&]fakeNative=1/.test(location.search);
  if (!isNative && !fake) { status('off (not on a device: ' + (window.Capacitor ? 'Capacitor present, platform ' + (Capacitor.getPlatform && Capacitor.getPlatform()) : 'no Capacitor') + ')'); return; }
  try { setup(); } catch (e) { status('FAILED: ' + (e && e.message || e)); console.error('Boxshelf Android adapter failed', e); }
  function setup() {
  const api = window.boxshelf, A = window.BS_ANDROID, T = window.BSTitles;
  window.BS_WORDMARK_OVERRIDES = { media: ['Apps', 'On this device'] }; // the apps shelf's title on Android (systems-extra.js applies it)
  if (!api || !A || !T) { status(`FAILED: missing ${!api ? 'mock.js ' : ''}${!A ? 'android-systems.js ' : ''}${!T ? 'shared/titles.js' : ''}`); return; }
  const reg = (window.capacitorExports && capacitorExports.registerPlugin) || (window.Capacitor && Capacitor.registerPlugin);
  if (isNative && !reg) { status('FAILED: capacitor.js did not load (no registerPlugin)'); return; }
  const N = isNative ? reg('BoxshelfNative') : fakeNative();
  if (!isNative) window.__fakeN = N; // browser tests only
  window.BS_NATIVE = N; // android-bottom.js (the bottom screen) talks to the same plugin
  // (beta.11) Android's own font size, kept for Text size: Automatic (android-early.js reads it as the page starts); a change
  // is used from the next start (an APK without this call just answers nothing: 1 stays)
  if (N && N.fontScale) Promise.resolve(N.fontScale()).then(r => { const s = r && +r.scale; if (s > .5 && s < 3) try { localStorage.setItem('bs-fontscale', String(Math.round(s * 100) / 100)); } catch {} }).catch(() => {});
  // (beta.10) the emulator test's channel (ci/emulator-test.sh reads it with run-as): the app logs nothing to Android's log
  // ("loggingBehavior": "none"), so the status, whether the adapter started, and the first script errors go into a small
  // file in the app's own folder. Only those words: never settings, keys or paths it was handed
  if (isNative) { const errs = []; let t = 0;
    const put = () => { clearTimeout(t); t = setTimeout(() => { N.writeText({ name: 'device-test.txt', text: ['status ' + (window.__bsAndroid || ''), 'ready ' + (status.ready ? 'device' : 'no'), ...errs.map(e => 'error ' + e)].join('\n') }).catch(() => {}); }, 300); };
    const err = m => { m = String(m || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!m || /net::ERR_/.test(m) || errs.length >= 8) return; errs.push(m); put(); };
    addEventListener('error', e => err(e && (e.message || (e.error && e.error.message))));
    addEventListener('unhandledrejection', e => { const r = e && e.reason; err('Unhandled: ' + ((r && r.message) || (typeof r === 'string' ? r : 'rejection'))); });
    const ce = console.error; console.error = function (...a) { try { err(a.map(x => typeof x === 'string' ? x : x && x.message ? x.message : '').filter(Boolean).join(' ')); } catch {} return ce.apply(this, a); };
    status.note = put; }
  const E = A.EMULATORS, SYS = A.SYSTEMS, sysById = Object.fromEntries(SYS.map(s => [s.id, s]));
  const log = (...m) => { try { console.log('[boxshelf]', ...m); } catch {} };

  // ---------- storage ----------
  const load = async (name, def) => { try { const r = await N.readText({ name }); return r && r.text ? JSON.parse(r.text) : def; } catch { return def; } };
  const store = (name, obj) => N.writeText({ name, text: JSON.stringify(obj) }).catch(e => log('save failed', name, e && e.message));
  const st = { config: null, folders: {}, foldersOff: [], library: null, history: {}, home: {} }; // folders: shown path → SAF tree uri; home: { prev: {pkg,label} }; foldersOff (beta.10): games folders removed in Settings (detect() leaves them out)
  const ready = (async () => {
    st.config = await load('config.json', null) || defaultConfig();
    for (const s of SYS) if (!st.config.systems[s.id]) st.config.systems[s.id] = sysDefaults();
    st.folders = await load('folders.json', {}); st.foldersOff = [].concat(await load('folders-off.json', [])).filter(x => typeof x === 'string'); st.library = await load('library.json', null); st.history = await load('history.json', {}); st.home = await load('home.json', {});
    { const f = histFix(st.history); st.history = f.h; if (f.changed) store('history.json', st.history); } // (0.3.2) the PC's shape
    st.config.ui = st.config.ui || {}; if (st.config.ui.autoCovers === undefined) st.config.ui.autoCovers = true; // box art comes on its own on Android unless switched off
    // (beta.11) Text size: android-early.js reads it from localStorage, so the saved choice is copied back in case the
    // WebView's storage was cleared; it's used from the next start
    { const ts = st.config.ui.textSize; if (/^(auto|normal|large|larger|largest)$/.test(ts || '')) try { if (localStorage.getItem('bs-textsize') !== ts) localStorage.setItem('bs-textsize', ts); } catch {} }
    if (st.config.ui.fullArt === undefined) st.config.ui.fullArt = true; // backs and spines too, where a source has them
    art.db = Object.assign({ v: 1, games: {}, miss: {}, ids: {} }, await load('art.json', {}));
    art.db.studio = Object.assign({ styles: {}, games: {} }, art.db.studio || {});
    man.db = Object.assign({ v: 1, games: {}, miss: {} }, await load('manuals.json', {}));
    // 0.3.2: 0.3.1 missed most manuals (their page counts weren't read), and a miss waits two weeks: those are forgotten once
    if ((man.db.v || 1) < 2) { man.db.miss = {}; man.db.v = 2; saveMan(); }
    if (!Object.keys(art.db.games).length) art.db.dispH = DISPLAY_H; // nothing made at the old size yet: nothing to sharpen
    dropOldDisplays();
    await Promise.race([art.checked = checkDisplays(), sleep(1500)]); // a display copy that's gone is never handed to the shelf
    if (st.library) { applyArt(st.library); applyManuals(st.library); }
    refreshHome();
  })();
  ready.then(() => setTimeout(() => manQueue('start'), 8000)); // manuals after the box art has had its start
  ready.then(() => setTimeout(() => sharpenDisplays().catch(e => log('box art: sharpen', e && e.message)), 6000)); // (0.3.2) the 512 px copies made again at 1024
  function sysDefaults() { return { enabled: true, emulator: '', gameArgs: '', emulatorArgs: '', romDirs: [], artDir: '', bootOnLaunch: true, core: '' }; }
  function defaultConfig() { const systems = {}; for (const s of SYS) systems[s.id] = sysDefaults();
    return { version: 1, setupDone: false, systems, steam: { enabled: false, path: '' }, apps: { stremio: { enabled: false, path: '' }, nuvio: { enabled: false, path: '' } }, ui: { sound: true, startFullscreen: true, autoCovers: true } }; }

  // ---------- paths ----------
  // SAF ids look like "primary:ROMs/gc" (internal storage) or "1A2B-3C4D:ROMs" (SD card)
  const idToPath = id => { const i = String(id).indexOf(':'); if (i < 0) return String(id); const vol = id.slice(0, i), rest = id.slice(i + 1);
    return (vol === 'primary' ? '/storage/emulated/0' : '/storage/' + vol) + (rest ? '/' + rest : ''); };
  const treeIdOf = uri => { const m = /\/tree\/([^/]+)/.exec(uri); return m ? decodeURIComponent(m[1]) : ''; };

  // ---------- emulators ----------
  const fmtEmu = (e, pkg) => `${e.name} (${pkg})`;
  const pkgOf = s => { const m = /\(([A-Za-z0-9_.]+)\)\s*$/.exec(String(s || '')); return m ? m[1] : (/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(String(s || '')) ? s : ''); };
  const emuFor = pkg => Object.values(E).find(e => (e.packages || []).includes(pkg)) || Object.values(E).find(e => e.match && e.match.test(pkg)) || null;
  let installed = null;
  async function apps(force) { if (installed && !force) return installed; const r = await N.apps(); installed = new Map((r.apps || []).map(a => [a.pkg, a.label])); return installed; }
  function findInstalled(emuId, inst) { const e = E[emuId]; if (!e) return null;
    for (const p of e.packages || []) if (inst.has(p)) return p;
    if (e.match) for (const p of inst.keys()) if (e.match.test(p)) return p; return null; }
  const actCache = {};
  async function resolveActivity(pkg, wanted) {
    if (!wanted || !wanted.length) return '';
    if (!actCache[pkg]) { try { actCache[pkg] = (await N.activities({ pkg })).activities || []; } catch { actCache[pkg] = []; } }
    const acts = actCache[pkg];
    for (const w of wanted) { if (w.startsWith('*')) { const suf = w.slice(1); const hit = acts.find(a => a.endsWith(suf)); if (hit) return hit; }
      else if (acts.includes(w) || !acts.length) return w; }
    const first = wanted.find(w => !w.startsWith('*'));
    return first || ''; // nothing matched: an exact name may still work (activity lists can hide aliases); else the app's own start screen
  }

  // ---------- scanning ----------
  const COMP = A.COMPANION;
  // (beta.9) video previews on Android: the videos beside the games ("videos", "media/videos", "snap" folders under a
  // console's games folder, the way RetroBat / Batocera / ES-DE scrapers leave them) come with the scan itself (the same
  // listing, three more file types); by system id: Map(key -> { uri, name, size })
  const portKey = p => String(p || '').replace(/[^\w]/g, '_'); // (beta.9: a package name as a settings key, dots and all)
  const VID_EXTS = ['mp4', 'webm', 'm4v'], vids = new Map(), ytFns = [];
  const ytOff = () => { const f = document.getElementById('bsYt'); if (f) { f.src = 'about:blank'; f.remove(); } };
  const ytPlace = (f, r, show) => { f.style.left = r.x + 'px'; f.style.top = r.y + 'px'; f.style.width = r.w + 'px'; f.style.height = r.h + 'px'; f.style.visibility = show ? 'visible' : 'hidden'; };
  const vkey = n => String(n || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/-(video|01|02|trailer)$/i, '').replace(/[^a-z0-9]+/g, '');
  // failed (optional): the folders that couldn't be read this time (no permission, SD card out) are added to it
  async function scanSystem(s, c, failed) {
    const files = [], vmap = new Map();
    for (const dir of c.romDirs || []) {
      const uri = st.folders[dir]; if (!uri) { log('no access to', dir); if (failed) failed.push({ dir, uri: '' }); continue; }
      const exts = [...new Set([...s.extensions, ...Object.keys(COMP), ...VID_EXTS])];
      try { const r = await N.listFiles({ uri, exts, depth: 4 }); for (const f of r.files || []) {
        if (VID_EXTS.includes(String(f.ext || '').toLowerCase()) && !s.extensions.includes(f.ext)) { const base = String(f.name).replace(/\.[^.]+$/, '').toLowerCase(), v = { uri: f.uri, name: f.name, size: f.size || 0 };
          if (!vmap.has('=' + base)) vmap.set('=' + base, v); const k = vkey(f.name); if (k && !vmap.has(k)) vmap.set(k, v); continue; }
        files.push({ ...f, path: idToPath(f.docId), tree: uri }); } }
      catch (e) { log('scan failed', dir, e && e.message); if (failed) failed.push({ dir, uri }); }
    }
    vids.set(s.id, vmap);
    // a .cue / .gdi / .m3u owns the track and disc files beside it; those never get boxes of their own
    const byDir = new Map(); for (const f of files) { const k = f.path.slice(0, f.path.lastIndexOf('/')); (byDir.get(k) || byDir.set(k, []).get(k)).push(f); }
    const hidden = new Set();
    for (const list of byDir.values()) for (const f of list) { const owned = COMP[f.ext]; if (!owned) continue;
      const stem = f.name.replace(/\.[^.]+$/, '').toLowerCase();
      for (const g of list) if (g !== f && owned.includes(g.ext) && (f.ext !== 'm3u' || g.name.toLowerCase().startsWith(stem.replace(/\s*\(dis[ck] \d+\)/i, '').slice(0, 12)))) hidden.add(g); }
    const games = new Map();
    for (const f of files) {
      if (hidden.has(f) || !s.extensions.includes(f.ext) || T.skipFile(f.name)) continue;
      const info = T.cleanTitle(f.name, { updateWords: s.id === 'sw' }); if (info.extra) continue; // (beta.10: the bare word rule is the Switch's only)
      const key = info.title.toLowerCase() + '|' + (info.region || ''), prev = games.get(key);
      if (prev) { prev.discs.push(f.path); if ((info.disc || 1) >= (prev.disc || 1)) continue; }
      games.set(key, { kind: 'rom', id: s.id + ':' + f.path, title: info.title, region: info.region, disc: info.disc, file: f.path, uri: f.uri, ext: f.ext,
        sizeBytes: f.size || 0, added: f.mtime || 0, art: {}, romTree: f.tree, discs: prev ? prev.discs : [f.path] });
    }
    // (beta.10) Details → Rename (renameGame): a game's own name, kept as the PC keeps it (config.games["<console>:<file>"].title); fileTitle keeps the scanned one
    const own = (st.config && st.config.games) || {};
    for (const g of games.values()) { const o = own[s.id + ':' + g.file]; if (o && o.title && o.title !== g.title) { g.fileTitle = g.title; g.title = String(o.title); } }
    return [...games.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
  }
  // a games folder that couldn't be read (permission lost, SD card out or not mounted yet) keeps the games the last scan
  // found in it, so the saved library never loses them; a folder that was read and is really empty still clears
  function keepUnread(sysId, failed, games) {
    const prev = (st.library || []).find(sh => sh && sh.id === sysId && sh.kind === 'console'); if (!prev) return;
    const under = (f, d) => { const p = String(d || '').replace(/\/+$/, ''); return !!p && (f === p || String(f || '').startsWith(p + '/')); };
    const have = new Set(games.map(g => g.id)); let n = 0;
    for (const g of prev.games || []) { if (!g || g.kind !== 'rom' || have.has(g.id)) continue;
      if (!failed.some(x => (x.uri && g.romTree === x.uri) || under(g.file, x.dir))) continue;
      games.push(Object.assign({}, g, { art: {} })); have.add(g.id); n++; }
    if (!n) return;
    games.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
    log('scan: kept', n, 'games of', sysId, 'from folders that could not be read');
  }
  async function scanAll() {
    await ready; const out = [];
    // (beta.12) RomM: its saved library and where its downloads went (read once), merged into each console below
    if (rmOn()) { try { await rmCache(); await rmLocal(); } catch (e) { log('RomM library', e && e.message); } }
    for (const s of SYS) { const c = st.config.systems[s.id]; if (!c || !c.enabled || (!c.emulator && !(c.romDirs || []).length)) continue;
      const e = emuFor(pkgOf(c.emulator)) || E[s.emus[0]], failed = [], games = await scanSystem(s, c, failed);
      if (failed.length) keepUnread(s.id, failed, games);
      try { rmMerge(s, c, games); } catch (e2) { log('RomM games', e2 && e2.message); }
      out.push({ id: s.id, kind: 'console', name: s.name, emulatorName: e ? e.name : '', hasEmulator: !!c.emulator, emulator: c.emulator, gameArgs: '', bootOnLaunch: c.bootOnLaunch !== false, games }); }
    // Apps shelf: every app on the device with a launcher icon (Thor tools, store, media apps…), Boxshelf itself left out
    // (beta.9) ports, recomps and custom APKs picked in Settings → Games → Ports & custom APKs: a Custom shelf of their own
    // (and off the Apps shelf, so nothing shows twice). Stored per app as config.portsOn["com_example_game"] = true
    const portOn = p => !!(st.config.portsOn && st.config.portsOn[portKey(p)]);
    try { const inst = await apps(true);
      const ports = [...inst].filter(([p]) => p !== 'io.github.boxshelf' && portOn(p)).sort((x, y) => String(x[1]).localeCompare(String(y[1]), undefined, { sensitivity: 'base' }))
        .map(([p, label]) => ({ kind: 'app', id: 'port-' + p, appId: p, title: String(label), path: p, art: {} }));
      if (ports.length) out.push({ id: 'custom', kind: 'apps', name: 'Custom', games: ports }); } catch (e) { log('ports shelf', e && e.message); }
    if (st.config.apps.android === undefined || st.config.apps.android.enabled !== false) { try { const inst = await apps(true);
      const list = [...inst].filter(([p]) => p !== 'io.github.boxshelf' && !portOn(p)).sort((x, y) => String(x[1]).localeCompare(String(y[1]), undefined, { sensitivity: 'base' }))
        .map(([p, label]) => ({ kind: 'app', id: 'app-' + p, appId: p, title: String(label), path: p, art: {} }));
      if (list.length) out.push({ id: 'media', kind: 'apps', name: 'Apps', games: list }); } catch (e) { log('apps shelf', e && e.message); } }
    applyArt(out); applyManuals(out); st.library = out; store('library.json', out); // (saved at once: a delayed save was lost if the app closed or reloaded right after a scan; tested in beta.8)
    setTimeout(() => queueArt('scan'), 1500); // after the shelf has had its turn
    setTimeout(() => manQueue('scan'), 5000);
    if (rmOn() && !rm.synced) { rm.synced = true; setTimeout(() => rmSync(false), 20000); } // (beta.12) RomM: one background sync a little after the first scan
    return out;
  }
  const gameByFile = file => { for (const sh of st.library || []) for (const g of sh.games || []) if (g.file === file || (g.discs || []).includes(file)) return g; return null; };

  // ---------- launching ----------
  let onExit = () => {}, running = null, justBack = 0;
  // (beta.13) apps that draw on both screens (DS / 3DS / Wii U emulators): opened on top, they get the bottom screen too
  const DUAL_APP = /(melonds|drastic|citra|azahar|lime3ds|borked3ds|mandarine|panda3ds|\.cemu|cemu\.|nds4droid)/i;
  let bottomAway = ''; // (beta.13) the app opened on the bottom screen, until Boxshelf's is brought back

  // ---------- the Home screen: Boxshelf as the Thor's launcher, and the way back to the old one ----------
  // Same logic as the other front ends that can be the Home app (Cocoon, Daijisho, ES-DE): Home always comes back here;
  // the launcher you had before is remembered so one press takes you back to it; Android's own screen picks the default.
  let home = { isDefault: false, launchers: [] };
  async function refreshHome() {
    try { home = await N.homeStatus();
      if (!home.isDefault && home.current && home.current.pkg) { st.home.prev = home.current; store('home.json', st.home); } // remember the launcher in use
    } catch (e) { log('home status', e && e.message); }
    return home;
  }
  const prevLauncher = () => { const p = st.home.prev; return p && (home.launchers || []).some(l => l.pkg === p.pkg) ? p : null; };
  async function exitHome() {
    let p = prevLauncher();
    if (!p) { const list = home.launchers || [];
      if (list.length === 1) p = list[0];
      else if (list.length > 1) { const r = await N.chooseApp({ title: 'Go to which home screen?', items: list }); if (!r || r.canceled) return; p = { pkg: r.pkg, label: r.label }; st.home.prev = p; store('home.json', st.home); } }
    await N.launchHome(p ? { pkg: p.pkg } : {});
  }
  // Home key (only reaches Boxshelf while it's the Home app): back from a game = just the shelf; on the shelf = quick menu
  if (N.addListener) Promise.resolve().then(() => N.addListener('home', () => {
    if (running || Date.now() - justBack < 1500) return;
    try { window.Shelf && Shelf.homeButton && Shelf.homeButton(); } catch (e) { log('home button', e && e.message); }
  })).catch(e => log('home listener', e && e.message));
  const sub = (v, ctx) => typeof v === 'string' ? v.replace('$DOC', ctx.doc || '').replace('$PATH', ctx.path || '').replace('$CORE', ctx.core || '').replace('$CFG', ctx.cfg || '') : (v && typeof v === 'object' && 'bool' in v ? !!v.bool : v);
  async function start(systemId, game) {
    await ready; const s = sysById[systemId], c = st.config.systems[systemId] || {};
    // (beta.12) this game's own emulator app and core (Details → Emulator), when that app is still installed; else the shelf's
    const own = (game && (st.config.games || {})[systemId + ':' + game.file]) || {};
    let pkg = pkgOf(own.emulator); if (pkg && !(await apps()).has(pkg)) { log('launch: this game\'s own emulator is gone, using the shelf\'s'); pkg = null; }
    const ownCore = pkg && own.core && s && s.cores.includes(own.core) ? own.core : '';
    if (!pkg) pkg = pkgOf(c.emulator);
    if (!pkg) { const inst = await apps(); for (const id of s.emus) { pkg = findInstalled(id, inst); if (pkg) break; } }
    if (!pkg) throw new Error(`No emulator for ${s ? s.name : systemId} is installed. Pick one in Settings → ${s ? s.name : 'Consoles'}.`);
    // (beta.10) an app Boxshelf has no launch data for: its own start screen, handed the game the standard way (VIEW with
    // the game's document), which most emulators take; one that doesn't simply opens on its own screen
    const e = emuFor(pkg); if (!e) log('launch: no launch data for', pkg, '- handing it the game as VIEW');
    let spec = e ? Object.assign({}, e.launch, (e.variants || {})[pkg] || {}) : { action: 'android.intent.action.VIEW', data: 'doc' };
    const ctx = { doc: game && game.uri, path: game && game.file,
      core: s && s.cores.length ? `/data/data/${pkg}/cores/${(ownCore || c.core || s.cores[0])}_libretro_android.so` : '',
      cfg: `/storage/emulated/0/Android/data/${pkg}/files/retroarch.cfg` };
    const req = { pkg, grant: [] };
    if (game) {
      req.activity = await resolveActivity(pkg, spec.activity);
      if (spec.action) req.action = spec.action; if (spec.category) req.category = spec.category;
      if (spec.data === 'doc') req.data = ctx.doc; else if (spec.data === 'path') req.data = ctx.path;
      if (spec.extras) { req.extras = {}; for (const [k, v] of Object.entries(spec.extras)) req.extras[k] = sub(v, ctx); }
      req.flags = spec.flags || [];
      if (ctx.doc) req.grant.push(ctx.doc);
    }
    // (beta.12, the Thor) a game that doesn't use a second screen leaves Boxshelf's bottom screen up while it runs; DS,
    // 3DS and Wii U games (their emulators draw on it) get the bottom screen as before
    req.keepBottom = !/^(nds|n3ds|wiiu)$/.test(String(systemId || ''));
    log('launch', JSON.stringify(req));
    running = { systemId, file: game && game.file, id: game && game.id, at: Date.now() };
    try { await N.launch(req); } catch (err) { running = null; throw new Error((err && err.message) || String(err)); }
    if (running && running.id) { const h = histOf(running.id); h.count++; h.last = Date.now(); store('history.json', st.history); } // (0.3.2) every start counts, as on the PC
    setTimeout(() => (window.__bsRunReady || (() => {}))(), 900); // the emulator is in front: the launch screen can go
    return {};
  }
  // (beta.12) the first Play of a session used to ask Android for the list of apps and the emulator's screens first: asked
  // ahead now, once the shelf has settled (never while it moves or a game runs), so Play goes straight to the emulator
  setTimeout(async function warm() {
    try { await ready; if (running) return; if (window.BS_BUSY && window.BS_BUSY()) { setTimeout(warm, 1500); return; }
      const inst = await apps(), seen = new Set();
      for (const s of Object.values(sysById)) { const c = st.config.systems[s.id] || {}; let pkg = pkgOf(c.emulator);
        if (!pkg) for (const id of s.emus || []) { pkg = findInstalled(id, inst); if (pkg) break; }
        if (!pkg || seen.has(pkg)) continue; seen.add(pkg);
        const e = emuFor(pkg), spec = e ? Object.assign({}, e.launch, (e.variants || {})[pkg] || {}) : null; if (spec && spec.activity) await resolveActivity(pkg, spec.activity); }
    } catch (e) { log('launch warm-up', e && e.message); }
  }, 6000);
  if (N.addListener) Promise.resolve().then(() => N.addListener('resume', onResume)).catch(e => log('resume listener', e && e.message));
  function onResume() {
    refreshHome(); // the Home app may have been changed in Android's settings meanwhile
    if (!running) return; const r = running; running = null; justBack = Date.now();
    if (r.id) { const h = histOf(r.id); h.ms += Math.max(0, Date.now() - r.at); h.last = Date.now(); store('history.json', st.history); }
    setTimeout(() => onExit({ code: 0 }), 250);
  }
  // play history in the PC's shape (main.js): { count: starts, ms: time played, last: ms since 1970 }, which the shelf reads
  // (Home, Most played, play time). 0.3.1 and before kept { launches (never counted), minutes, last in seconds }: turned
  // into the PC's shape when loaded
  function histOf(id) { return st.history[id] = st.history[id] || { count: 0, ms: 0, last: 0 }; }
  function histFix(h) {
    const out = {}; let changed = false;
    for (const [k, v] of Object.entries(h || {})) { if (!v || typeof v !== 'object') { changed = true; continue; }
      if ('count' in v && 'ms' in v) { out[k] = { count: +v.count || 0, ms: +v.ms || 0, last: +v.last || 0 }; continue; }
      changed = true; const ms = (+v.minutes || 0) * 60000; out[k] = { count: Math.max(+v.launches || 0, ms || v.last ? 1 : 0), ms, last: (+v.last || 0) < 1e11 ? (+v.last || 0) * 1000 : +v.last }; }
    return { h: out, changed };
  }

  // ---------- box art: fetched in the background, saved beside the games ----------
  // The free sources the Windows build uses that need no big download first, best first: GameTDB (GameCube / Wii covers,
  // full wraps and discs, by the disc id in the file), ScreenScraper (only with the player's own account: fronts, backs,
  // spines, full wraps and discs for most consoles), libretro's thumbnail library (fronts, named like No-Intro / Redump
  // files), plus SteamGridDB posters when a key is set. (LaunchBox's database, Windows' main source for backs and spines,
  // is a 110 MB download and a 500 MB file to index: too much for a handheld, so it isn't used here.)
  // The native side downloads (no CORS, never on the UI thread) and saves the original in "Boxshelf Art" inside the
  // games folder the player picked, with the Windows build's names (<game>.png, -back, -spine, -disc; a full wrap is kept
  // whole as <game>-full), plus ~512 px display copies in the app's own storage that the shelf shows. A wrap is cut into
  // its back, spine and front natively (no big picture ever reaches the page).
  // Four jobs at a time (each source host has its own limit: libretro 3, GameTDB 2, ScreenScraper the account's
  // maxthreads), the shelf in front first, only while the shelf is quiet and no game is running. What was found is remembered (art.json),
  // so a restart shows it at once and never downloads it again.
  const LR = { gc: 'Nintendo - GameCube', wii: 'Nintendo - Wii', wiiu: 'Nintendo - Wii U', sw: 'Nintendo - Switch', n3ds: 'Nintendo - Nintendo 3DS', nds: 'Nintendo - Nintendo DS',
    ps2: 'Sony - PlayStation 2', psp: 'Sony - PlayStation Portable', psx: 'Sony - PlayStation', n64: 'Nintendo - Nintendo 64', dreamcast: 'Sega - Dreamcast', saturn: 'Sega - Saturn',
    megadrive: 'Sega - Mega Drive - Genesis', mastersystem: 'Sega - Master System - Mark III', gamegear: 'Sega - Game Gear', snes: 'Nintendo - Super Nintendo Entertainment System',
    nes: 'Nintendo - Nintendo Entertainment System', gba: 'Nintendo - Game Boy Advance', gbc: 'Nintendo - Game Boy Color', gb: 'Nintendo - Game Boy',
    pcengine: 'NEC - PC Engine - TurboGrafx 16', neogeo: 'SNK - Neo Geo',
    segacd: 'Sega - Mega-CD - Sega CD', sega32x: 'Sega - 32X', atari2600: 'Atari - 2600', atarilynx: 'Atari - Lynx', wonderswan: 'Bandai - WonderSwan', dos: 'DOS' }; // (beta.9: the rest of wave 2) // arcade: MAME sets are named by short zip names, which libretro's titles never match
  const TDB_SYS = { gc: 'wii', wii: 'wii' }; // GameTDB keeps GameCube under its Wii art. (3DS / Switch / Wii U are named by title ids that
  // need decrypting or unpacking the game to read: not done here, ScreenScraper covers those consoles by file name instead)
  const TDB_REGIONS = { E: ['US'], N: ['US'], J: ['JA'], K: ['KO'], P: ['EN', 'FR', 'DE', 'ES', 'IT', 'NL'], D: ['DE', 'EN'], F: ['FR', 'EN'], S: ['ES', 'EN'], I: ['IT', 'EN'], H: ['NL', 'EN'], U: ['EN', 'AU'], X: ['EN', 'US'], Y: ['EN', 'US'], Z: ['EN', 'US'] };
  const SUFFIX = { front: '', back: '-back', spine: '-spine', disc: '-disc', full: '-full' }; // the Windows build's file names: <game file name>.png, <game file name>-back.png…
  // DISPLAY_H: the display copies the cases show (0.3.2: 1024 px tall; 512 was soft on the Thor's 1080p screen and blurry in
  // Inspect. The museum still asks the decoder for 512, so its textures stay small)
  const PIC_EXT = ['png', 'jpg', 'jpeg', 'webp'], DISPLAY_H = 1024, MISS_DAYS = 7, LR_DAYS = 7, PARTS = ['front', 'back', 'spine', 'disc'];
  const art = { db: { v: 1, games: {}, miss: {}, ids: {}, studio: { styles: {}, games: {} } }, q: [], keys: new Set(), toastAt: 0, total: 0, done: 0, added: 0, found: 0, running: false, paused: false, reason: '', lists: {}, folders: {}, folderP: {}, now: new Map(), sig: '', arrived: new Set(), flushT: 0, saveT: 0, paintAt: 0, stale: {}, checked: null };
  // the shelf's norm (main/lbindex.js): "The Legend of Zelda: Ocarina of Time" = "legend of zelda ocarina of time"
  const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 };
  const ROMAN_RE = new RegExp('\\b(' + Object.keys(ROMAN).sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(ROMAN_RE, r => ROMAN[r]).replace(/\s+/g, ' ').trim();
  const libretroSafe = s => s.replace(/[&*/:`<>?\\|"]/g, '_');
  const baseOf = file => String(file).split('/').pop().replace(/\.[^.]+$/, '');
  const fileUrl = p => (isNative && window.Capacitor && Capacitor.convertFileSrc) ? Capacitor.convertFileSrc(p) : p; // https://localhost/_capacitor_file_/… (same origin: the CSP's 'self')
  // where new originals are saved (Settings / the setup wizard): 'roms' = a "Boxshelf Art" folder beside the games (kept
  // when Boxshelf is reinstalled), 'app' = only inside Boxshelf's own storage (nothing is ever written into the games
  // folders). Either way, pictures already in a "Boxshelf Art" (or the PC's "covers") folder are still used.
  const artWhere = () => (st.config && st.config.ui && st.config.ui.artWhere) === 'app' ? 'app' : 'roms';
  const saveTree = tree => artWhere() === 'app' ? '' : tree; // no tree: the native side keeps it in the app's storage
  // full box art (backs and spines) is on unless switched off in Settings; it needs a source that has it for the console
  const fullOn = () => !(st.config && st.config.ui && st.config.ui.fullArt === false);
  const partsFor = sysId => { const L = ['front'], more = !!(TDB_SYS[sysId] || ssOn(sysId) || lbHas(sysId)); if (more) L.push('disc'); if (more && fullOn()) L.push('wrap'); return L; }; // (LaunchBox: 0.3.3)
  // a part this game already has: on its art, or remembered in art.json (a picture is never fetched twice)
  const recHas = (id, p) => !!(art.db.games[id] && art.db.games[id][p]);
  const hasPart = (g, part) => part === 'wrap' ? !!((g.art && g.art.back && g.art.spine) || (recHas(g.id, 'back') && recHas(g.id, 'spine')))
    : !!((g.art && g.art[part]) || recHas(g.id, part));
  // the console's case shape (renderer STYLE: ratio = width ÷ height, depth = spine ÷ width): where a wrap is cut
  const caseShape = sysId => { let s = null; try { s = typeof STYLE !== 'undefined' ? STYLE[sysId] : null; } catch {} return { ratio: (s && s.ratio) || 0.71, depth: (s && s.depth) || 0.1 }; };
  // the museum has no "sliding" flag: there, quiet means nobody has pressed anything for a moment (a fast walk through
  // the shelves never shares its frames with a finished download, a JSON write or a list being indexed)
  const musBusy = () => { try { return !!(window.Shelf && Shelf.getMode && Shelf.getMode() === 'museum' && Shelf.idleMs && Shelf.idleMs() < 1500); } catch { return false; } };
  const quiet = () => !running && !art.paused && !document.hidden && !(window.BS_BUSY && window.BS_BUSY()) && !musBusy();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // wait for a quiet moment: no game running, Boxshelf in front, the shelf not sliding; then an idle slot of the page.
  // Checked every 250 ms (a timer that only reads a few numbers): work starts again soon after the shelf stops
  // maxMs (beta.7): the longest to wait for quiet, for light work that must not wait forever (the reading corner's folder
// listing is answered by the native side, off this thread). Without it the wait has no end: on a device (or the build
// machine) where something never settles, that work never ran at all.
async function idleTurn(maxMs) { const until = maxMs ? Date.now() + maxMs : Infinity; while (!quiet() && Date.now() < until) await sleep(250); if (window.requestIdleCallback) await new Promise(r => requestIdleCallback(r, { timeout: 2000 })); }
// what "quiet" is waiting on right now (the device test prints it when a background job didn't run)
window.BS_FOLDERS = () => ({ ...st.folders }); // (the device test's diagnosis: shown path → folder; a copy)
window.BS_QUIET = () => ({ running: !!running, artPaused: !!art.paused, hidden: !!document.hidden, busy: !!(window.BS_BUSY && window.BS_BUSY()), museumMoving: !!musBusy() });
  // (0.3.5) a download the native side runs and saves by itself (a manual's page) only waits for the shelf to stop sliding:
  // what comes back is one small message, so it needs no idle slot (waiting for one before every page made manuals slow)
  async function netTurn() { while (running || art.paused || document.hidden || (window.BS_BUSY && window.BS_BUSY())) await sleep(150); }
  if (N.addListener) Promise.resolve().then(() => { N.addListener('pause', () => { art.paused = true; }); N.addListener('resume', () => { art.paused = false; }); }).catch(() => {});
  // (beta.12) how long the screen stays on without input (MainActivity): Settings' "Dim the screen after", else the native
  // default (10 min). An APK without keepAwake (or the browser test's pretend device) just doesn't answer
  function awakeSync() { const m = +((st.config && st.config.ui) || {}).dimMinutes || 0;
    if (isNative && N && N.keepAwake) Promise.resolve().then(() => N.keepAwake({ minutes: m > 0 ? m : 0 })).catch(() => {}); }
  ready.then(awakeSync).catch(() => {});
  // a short fingerprint (FNV-1a, twice): cache names for downloads, and to notice a changed sign-in without keeping it
  const fp = s => { let a = 2166136261, b = 5381; for (const ch of String(s)) { const c = ch.charCodeAt(0); a = Math.imul(a ^ c, 16777619); b = (Math.imul(b, 33) ^ c) >>> 0; } return (a >>> 0).toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); };

  // what's remembered → the games' art (the same { front, back, spine, disc } shape the Windows build gives, so the shelf just works)
  // the libraries the page was given: a rescan that comes back the same leaves the shelf on the older objects, which must
  // get the new pictures too (the shelf's cases share each game's art object)
  const handed = [];
  const handOut = lib => { if (lib && !handed.includes(lib)) { handed.unshift(lib); handed.length = Math.min(handed.length, 3); } return lib; };
  function applyArt(lib) {
    for (const sh of lib || []) for (const g of sh.games || []) { const rec = art.db.games[g.id]; if (!rec || g.kind !== 'rom') continue;
      g.art = g.art || {}; for (const part of Object.keys(rec)) if (rec[part] && rec[part].d) { g.art[part] = fileUrl(rec[part].d); urlRec.set(g.art[part], rec[part]); } }
  }
  // (0.3.3) smaller copies for the shelf: a case is drawn about 500 px tall, and decoding the 1024 px copy for every case
  // that slides into view was several times the work. Each display copy gets a 576 px copy (cases on the shelf) and a 128 px
  // one (the backdrop blur and glow colour), made from it in quiet moments; boxshelf.thumbFor(url, px) hands the shelf the
  // smallest one big enough, or null (the full copy) while it isn't made yet. Inspect, the museum and the bottom screen
  // keep the 1024 px copy.
  const SMALL = [576, 128], urlRec = new Map(), smallQ = [];
  let smallRun = false;
  function smallSoon(id, part) { if (!N.artThumb) return; smallQ.push([id, part]); if (!smallRun) { smallRun = true; setTimeout(smallWork, 4000); } }
  async function smallWork() {
    try {
      while (smallQ.length) {
        await idleTurn();
        const [id, part] = smallQ.shift(), rec = art.db.games[id] && art.db.games[id][part];
        if (!rec || !rec.d || (rec.s && SMALL.every(h => rec.s[h]))) continue;
        const m = /^(.*)[\\/]([^\\/]+?)(?:\.[a-z0-9]+)?$/i.exec(String(rec.d)); if (!m) continue;
        const dir = m[1].split(/[\\/]/).pop(), base = m[2], s = {};
        let src = rec.d;
        for (const h of SMALL) { // (the 128 px copy from the 576 px one: less to decode)
          try { const r = await N.artThumb({ src, key: dir, name: base + '~s' + h, maxH: h }); if (r && r.display) { s[h] = r.display; src = r.display; } } catch (e) { log('box art: small copy', base, e && e.message); break; }
        }
        if (art.db.games[id] && art.db.games[id][part] === rec) { if (Object.keys(s).length) { rec.s = s; saveArt(); } }
        else if (Object.keys(s).length) { (art.db.trash = art.db.trash || []).push(...Object.values(s)); saveArt(); } // (the picture changed meanwhile: these go)
      }
    } finally { smallRun = false; }
  }
  function thumbFor(url, px) {
    const r = urlRec.get(url); if (!r || !r.s) return null;
    if (px <= 180 && r.s[128]) return fileUrl(r.s[128]);
    if (px <= 600 && r.s[576]) return fileUrl(r.s[576]);
    return null;
  }
  // the copies still to make: every display copy at the new size that has none yet (after a start, behind the sharpening)
  ready.then(() => setTimeout(() => { for (const [id, rec] of Object.entries(art.db.games)) for (const part of PARTS) { const v = rec && rec[part]; if (v && v.d && v.h === DISPLAY_H && !(v.s && SMALL.every(h => v.s[h]))) smallSoon(id, part); } }, 9000));
  // games that share one picked folder with another console get a sub folder each (two consoles' "Tetris (USA)" would clash)
  function subFor(sysId, tree) {
    let n = 0; for (const s of SYS) { const c = st.config.systems[s.id]; if (c && c.enabled !== false && (c.romDirs || []).some(d => st.folders[d] === tree)) n++; }
    return n > 1 ? (sysById[sysId] || {}).name || sysId : '';
  }
  // → how many pictures were queued. force (Fetch missing art now): also the games nothing was found for lately.
  // only: just these keys (display copies to re-make from originals Boxshelf already has: no download, so even with
  // automatic art switched off)
  function queueArt(reason, force, only) {
    if (!st.library || !st.config) return 0;
    if (!only && !force && st.config.ui && st.config.ui.autoCovers === false) return 0;
    const now = Date.now(); let n = 0;
    for (const sh of st.library) { if (sh.kind !== 'console') continue;
      const parts = only ? ['front', 'disc', 'wrap'] : partsFor(sh.id); // (a display copy to re-make: whatever part it was)
      for (const g of sh.games || []) { if (g.kind !== 'rom' || !g.file) continue;
        // locked as it is in Art Studio: nothing automatic touches it (a lost display copy is still made again)
        const sg = art.db.studio.games[g.id]; if (sg && sg.frozen && !only) continue;
        for (const part of parts) { const k = g.id + '|' + part;
          if (hasPart(g, part) || art.keys.has(k) || (only && !only.has(k))) continue; // never twice, never one that has its picture
          if (!force && art.db.miss[k] && now - art.db.miss[k] < MISS_DAYS * 864e5) continue;
          art.keys.add(k); art.q.push({ g, sysId: sh.id, part, k, noNet: !!only && st.config.ui && st.config.ui.autoCovers === false }); n++; } } }
    if (!n) return 0;
    if (!art.running) { art.total = 0; art.done = 0; art.added = 0; art.found = 0; art.folders = {}; art.folderP = {}; art.reason = reason;
      for (const k of Object.keys(art.lists)) art.lists[k].then(L => { if (!L) delete art.lists[k]; }); } // a list that failed (offline) is asked for again
    art.total += n; art.sig = ''; log('box art: queued', n, 'for', reason); // (art.sig: a running fetch orders its queue again, new games included)
    if (!art.running) runArt();
    paintArt(true);
    return n;
  }
  // the order of the queue: the shelf in front first, nearest the game in focus outward (fronts before discs / backs),
  // then the other shelves' fronts, then the rest. Sorted again when you move to another shelf or far along this one
  const focusSig = f => f ? f.sys + '|' + Math.floor(f.sel / 8) : '';
  function orderQueue() {
    let f = null; try { f = window.Shelf && Shelf.artFocus ? Shelf.artFocus(true) : null; } catch {}
    art.sig = focusSig(f); if (!art.q.length) return;
    const at = new Map(); if (f && f.ids) f.ids.forEach((id, i) => { if (id != null && !at.has(String(id))) at.set(String(id), i); });
    const rank = j => { const i = f && j.sysId === f.sys ? at.get(String(j.g.id)) : undefined, front = j.part === 'front';
      if (i === undefined) return front ? 3e6 : 4e6;
      const d = Math.abs(i - f.sel); return d <= 12 ? (front ? 0 : 1e6) + d : (front ? 2e6 : 4e6) + d; };
    const r = new Map(); art.q.forEach((j, n) => r.set(j, rank(j) + n / 1e6)); // (ties keep the queue's own order)
    art.q.sort((a, b) => r.get(a) - r.get(b));
  }
  // where you are changed enough to matter: the queue is ordered again (only between jobs, in a quiet moment)
  function reorderIfMoved() { let f = null; try { f = window.Shelf && Shelf.artFocus ? Shelf.artFocus(false) : null; } catch {} if (focusSig(f) !== art.sig) orderQueue(); }
  // a few downloads per source at once: polite to each server, and most of the waiting overlaps
  const GATE = { libretro: 3, gametdb: 2, other: 2 }, gates = {};
  const hostOf = u => { const h = String(u || '').replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
    return /(^|\.)libretro\.com$/.test(h) ? 'libretro' : /(^|\.)gametdb\.com$/.test(h) ? 'gametdb' : 'other'; };
  // (0.3.1) one download engine for art and manuals (and magazines / guides later): a few at once per site, and a site
  // that answers "slow down" (busy) is left alone for a while (slowDown), the wait growing if it keeps saying so
  async function gated(host, fn) {
    const g = gates[host] || (gates[host] = { n: 0, w: [], peak: 0, until: 0, miss: 0 }), lim = GATE[host] || 2;
    while (g.until > Date.now()) await sleep(Math.min(5000, g.until - Date.now()));
    while (g.n >= lim) await new Promise(r => g.w.push(r));
    g.n++; g.peak = Math.max(g.peak, g.n);
    try { return await fn(); } finally { g.n--; const r = g.w.shift(); if (r) r(); }
  }
  function slowDown(host, ok) { // ok: it answered fine (the next "slow down" waits the shortest time again)
    const g = gates[host] || (gates[host] = { n: 0, w: [], peak: 0, until: 0, miss: 0 });
    if (ok) { g.miss = 0; return; }
    g.miss = Math.min(5, g.miss + 1); g.until = Math.max(g.until, Date.now() + 4000 * 2 ** (g.miss - 1)); // 4 s, 8 s … ~1 min
  }
  // libretro's name lists for every console in the queue, asked for at once when the first download starts (a few at a time), so the
  // first libretro cover of each console doesn't wait for its own list
  function prefetchLists() { const ids = new Set(); for (const j of art.q) if (j.part === 'front' && !j.noNet && LR[j.sysId]) ids.add(j.sysId); for (const id of ids) lrList(id); }
  const WORKERS = 4;
  async function runArt() {
    art.running = true; art.now = new Map(); art.prefetched = false; orderQueue(); card.start();
    // the "fetching" toast waits for the first picture (or comes at once when asked for): offline, an automatic run
    // would otherwise say "Fetching…" at every start and then never finish the sentence
    art.toastAt = new Set(art.q.map(j => j.g.id)).size; if (art.reason === 'now') startToast();
    const worker = async () => { while (art.q.length) { await idleTurn(); reorderIfMoved(); const j = art.q.shift(); if (!j) break;
      art.now.set(j, j.g.title || baseOf(j.g.file)); card.paint();
      j.t0 = Date.now(); // (when the job started: a picture the player picks after this is never written over, see found and keepSince)
      try { await (j.part === 'wrap' ? wrapJob(j) : artJob(j)); } catch (e) { log('box art', j.g.title, e && e.message); }
      art.now.delete(j); art.keys.delete(j.k); art.done++; paintArt(); card.paint(); } };
    try { await Promise.all(Array.from({ length: WORKERS }, worker)); } finally { card.finish();
      art.running = false; if (quiet()) flushArrived(true); else flushArrived(); saveArt(true); ssSave(); idleTurn().then(() => store('library.json', st.library)); paintArt(true); // the writes wait for a still shelf
      log('box art: done', art.added, 'of', art.total);
      if (art.added) { if (art.reason === 'now' || !cardOn() || !card.shown()) shelfToast(`Added box art for ${art.added} game${art.added === 1 ? '' : 's'}`); } // (else the card says it)
      else if (art.reason === 'now') shelfToast(art.found ? `Added ${art.found} more picture${art.found === 1 ? '' : 's'} (backs, spines, discs)` : 'No new box art found');
      // something queued in the moment between the last job and here would wait for the next start otherwise
      if (art.q.length) setTimeout(() => { if (!art.running && art.q.length) { art.total = art.q.length; art.done = 0; art.added = 0; art.found = 0; art.reason = 'more'; runArt(); } }, 0);
    }
  }
  const cardOn = () => !(st.config && st.config.ui && st.config.ui.artProgress === false); // the progress card says it instead of the toasts
  function startToast() { if (art.toastAt >= 3 && !cardOn()) shelfToast(`Fetching box art for ${art.toastAt} games in the background`); art.toastAt = 0; }
  // a picture already in the games folder's "Boxshelf Art" under one of the picture types → { name, uri } or null
  const inFolder = (have, name) => { for (const e of PIC_EXT) { const uri = have.get((name + '.' + e).toLowerCase()); if (uri) return { name: name + '.' + e, uri }; } return null; };
  // one group of addresses (one source) through the native download; ScreenScraper's through its limits
  const fetchGroup = (grp, o) => grp.ss ? ssFetch(Object.assign({}, o, { urls: grp.urls })) : gated(hostOf(grp.urls[0]), () => N.fetchArt(Object.assign({}, o, { urls: grp.urls })));
  function folderSaved(r, tree, sub) { if (r.saved === 'folder' && tree) { const m = art.folders[tree + '|' + sub]; if (m && r.name) m.set(String(r.name).toLowerCase(), r.file); }
    else if (r.saved === 'app' && tree) log('box art: games folder is read-only, kept in app storage', r.name); }
  // a front or a disc
  async function artJob(j) {
    const { g, sysId, part } = j, tree = g.romTree || '', sub = tree ? subFor(sysId, tree) : '', name = baseOf(g.file) + SUFFIX[part];
    if (recHas(g.id, part)) return; // given a picture (Art Studio) while this job waited in the queue: nothing to do
    // 0. its display copy went missing (Android cleared the app's cache folder…): made again from the original we have
    const old = art.stale[j.k];
    if (old) { delete art.stale[j.k];
      try { const r = await N.artThumb({ src: old.f, key: sysId, name, maxH: DISPLAY_H }); if (r && r.display) return found(j, r.display, old.f, old.w); } catch (e) { log('box art: original gone', name, e && e.message); } }
    // 1. already in the games folder's "Boxshelf Art" (an earlier install, the PC, or put there by hand): no download.
    // found() keeps the original's address (not just its name), so a lost display copy can be made again from it
    if (tree) { const f = inFolder(await folderFiles(tree, sub), name);
      if (f) try { const r = await N.artThumb({ src: f.uri, key: sysId, name, maxH: DISPLAY_H }); if (r && r.display) return found(j, r.display, f.uri, 'folder'); } catch (e2) { log('box art: unreadable', name, e2 && e2.message); } }
    if (j.noNet) return; // re-making a display copy with automatic art off: nothing is downloaded
    // the first job that really has to download asks for every console's libretro list at once (not before: art that's
    // all already in the folders, e.g. after a reinstall, needs no list at all)
    if (!art.prefetched) { art.prefetched = true; prefetchLists(); }
    // 2. the sources, best first, one at a time (a source that has it ends the search)
    const save = saveTree(tree); let unsure = false;
    for (const next of artGroups(sysId, g, part)) { const grp = await next(); if (grp.unsure) unsure = true; if (!grp.urls.length) continue;
      const r = await fetchGroup(grp, { tree: save, sub, name, key: sysId, maxH: DISPLAY_H, keepSince: j.t0 || 0 });
      if (r && r.kept) return; // a picture was put in its place while this downloaded (Art Studio): left as it is, nothing remembered as missing
      if (r && r.ok) { folderSaved(r, save, sub); return found(j, r.display, r.file, r.saved); }
      if (!r || r.busy) unsure = true; }
    if (!unsure) art.db.miss[j.k] = Date.now(); // busy / offline: not remembered, the next run tries again
  }
  // the back and the spine ("wrap"): a full wrap cut natively into its faces, else a back / spine of their own
  async function wrapJob(j) {
    const { g, sysId } = j, tree = g.romTree || '', sub = tree ? subFor(sysId, tree) : '', base = baseOf(g.file), shape = caseShape(sysId), save = saveTree(tree);
    const need = () => ['back', 'spine'].filter(p => !(g.art && g.art[p]));
    let unsure = false;
    // 0. a back / spine whose display copy went missing: made again from its original (a whole wrap is cut again)
    for (const p of need()) { const sk = g.id + '|' + p, old = art.stale[sk]; if (!old) continue; delete art.stale[sk];
      const whole = /-full\.[a-z0-9]+$/i.test(decodeURIComponent(String(old.f)));
      try { const r = await N.artThumb(Object.assign({ src: old.f, key: sysId, name: base + SUFFIX[whole ? 'full' : p], maxH: DISPLAY_H }, whole ? Object.assign({ split: true, want: [p], dname: base }, shape) : {}));
        const d = whole ? r && r.parts && r.parts[p] : r && r.display; if (d) found(j, d, old.f, old.w, p); } catch (e) { log('box art: original gone', base + SUFFIX[p], e && e.message); } }
    if (!need().length) return;
    // 1. already in "Boxshelf Art": the whole wrap (<game>-full), or a back / spine of its own (from the PC, say)
    if (tree) { const have = await folderFiles(tree, sub), full = inFolder(have, base + SUFFIX.full);
      if (full) try { const r = await N.artThumb(Object.assign({ src: full.uri, key: sysId, name: base + SUFFIX.full, split: true, want: need(), dname: base, maxH: DISPLAY_H }, shape));
        if (r && r.parts) for (const p of need()) if (r.parts[p]) found(j, r.parts[p], full.uri, 'folder', p); } catch (e) { log('box art: unreadable', base + SUFFIX.full, e && e.message); }
      for (const p of need()) { const f = inFolder(have, base + SUFFIX[p]); if (!f) continue;
        try { const r = await N.artThumb({ src: f.uri, key: sysId, name: base + SUFFIX[p], maxH: DISPLAY_H }); if (r && r.display) found(j, r.display, f.uri, 'folder', p); } catch (e) { log('box art: unreadable', base + SUFFIX[p], e && e.message); } }
      if (!need().length) return; }
    if (j.noNet) return; // re-making display copies with automatic art off: nothing is downloaded
    // 2. a full wrap (GameTDB's full cover, then ScreenScraper's box texture), and 3. ScreenScraper's own back and spine scans.
    // CD jewel cases (PlayStation, Saturn, Dreamcast) have the spines on the back insert, which a wrap cut can't find: there
    // the scans of their own come first
    const wrap = async () => { for (const next of wrapGroups(sysId, g)) { if (!need().length) break; const grp = await next(); if (grp.unsure) unsure = true; if (!grp.urls.length) continue;
        const r = await fetchGroup(grp, Object.assign({ tree: save, sub, name: base + SUFFIX.full, key: sysId, maxH: DISPLAY_H, split: true, want: need(), dname: base }, shape));
        if (r && r.ok && r.parts) { folderSaved(r, save, sub); for (const p of need()) if (r.parts[p]) found(j, r.parts[p], r.file, r.saved, p); }
        else if (!r || r.busy) unsure = true; } };
    // (0.3.3: LaunchBox's own back and spine scans first, once its database is on the device, then ScreenScraper's)
    const own = async () => { for (const p of need()) for (const next of [() => LB_PLAT[sysId] ? lbGroup(sysId, g, p) : { urls: [] }, () => ssGroup(sysId, g, p)]) {
        const grp = await next(); if (grp.unsure) unsure = true; if (!grp.urls.length) continue;
        const r = await fetchGroup(grp, { tree: save, sub, name: base + SUFFIX[p], key: sysId, maxH: DISPLAY_H, keepSince: j.t0 || 0 });
        if (r && r.kept) { unsure = true; break; } // (put in its place meanwhile: left as it is)
        if (r && r.ok) { folderSaved(r, save, sub); found(j, r.display, r.file, r.saved, p); break; } else if (!r || r.busy) unsure = true; } };
    if (JEWEL.has(sysId)) { await own(); await wrap(); } else { await wrap(); await own(); }
    if (need().length && !unsure) art.db.miss[j.k] = Date.now();
  }
  if (!isNative) window.__bsArtFound = (id, part, display) => { // browser tests: a picture "arrives" for a game, through the real path
    for (const sh of st.library || []) for (const g of sh.games || []) if (g.id === id) return found({ g, part, k: id + '|' + part }, display, '', 'folder'); };
  // listed once per run: the promise is shared, so jobs running side by side never see a half-read folder
  function folderFiles(tree, sub) { const k = tree + '|' + sub; return art.folderP[k] || (art.folderP[k] = readFolder(tree, sub)); }
  async function readFolder(tree, sub) {
    const k = tree + '|' + sub, m = new Map(); art.folders[k] = m;
    try { const r = await N.artList({ tree, sub }); for (const f of (r && r.files) || []) m.set(String(f.name).toLowerCase(), f.uri); } catch (e) { log('box art: folder list', e && e.message); }
    // the Windows build's "covers" folder beside the games (same names): art scraped on the PC and copied over with the
    // games is used as it is, never downloaded again. Read only; "Boxshelf Art" wins where both have a picture
    try { const r = await N.artList({ tree, sub: '', folder: 'covers' }); for (const f of (r && r.files) || []) { const k = String(f.name).toLowerCase(); if (!m.has(k)) m.set(k, f.uri); } } catch {}
    return m;
  }
  // At start: every display copy art.json lists still there? (They live in the app's storage, which Android or a
  // cleaner app can empty.) A missing one is forgotten and queued to be made again from its original, never downloaded.
  async function checkDisplays() {
    const list = []; for (const [id, rec] of Object.entries(art.db.games)) for (const [part, v] of Object.entries(rec || {})) if (v && v.d) list.push({ id, part, v });
    if (!list.length || !N.artExists) return 0;
    let gone; try { gone = new Set(((await N.artExists({ paths: list.map(x => x.v.d) })) || {}).missing || []); } catch (e) { log('box art: check', e && e.message); return 0; }
    if (!gone.size) return 0;
    const only = new Set();
    for (const { id, part, v } of list) { if (!gone.has(v.d)) continue;
      if (!art.db.games[id] || art.db.games[id][part] !== v) continue; // (replaced while the check ran: the new one stays)
      applyRec({ id }, part, null); // forgotten, and off every copy of the game the page has
      if (v.f) art.stale[id + '|' + part] = { f: v.f, w: v.w || '' };
      only.add(id + '|' + (part === 'back' || part === 'spine' ? 'wrap' : part)); } // backs and spines come back through the wrap job
    for (const id of Object.keys(art.db.games)) if (!Object.keys(art.db.games[id]).length) delete art.db.games[id];
    log('box art:', gone.size, 'display copies missing, making them again');
    saveArt(); ready.then(() => queueArt('restore', false, only)); // once the library is loaded
    return gone.size;
  }
  // (0.3.2) display copies made before at 512 px are made again at DISPLAY_H from the originals Boxshelf already has: nothing
  // is downloaded. Nearest the game in focus first, one at a time and only in quiet moments; each case keeps its old copy
  // until the sharper one is ready. The old copies are deleted at the next start (a case scrolling back into view this
  // session may still ask for one). A record's h says the size its copy was made at.
  async function sharpenDisplays() {
    if ((art.db.dispH || 512) >= DISPLAY_H || art.sharpening || !N.artThumb) return;
    art.sharpening = true;
    try {
      while (art.running) await sleep(2000); // after a box art run: the decoder stays free for the shelf
      const where = new Map(); for (const sh of st.library || []) if (sh.kind === 'console') for (const g of sh.games || []) if (g.kind === 'rom') where.set(String(g.id), { g, sysId: sh.id });
      let f = null; try { f = window.Shelf && Shelf.artFocus ? Shelf.artFocus(true) : null; } catch {}
      const near = new Map(); if (f && f.ids) f.ids.forEach((id, i) => { if (id != null && !near.has(String(id))) near.set(String(id), Math.abs(i - f.sel)); });
      const todo = [];
      for (const [id, rec] of Object.entries(art.db.games)) { const w = where.get(id); if (!w) continue;
        for (const part of PARTS) { const v = rec && rec[part]; if (v && v.d && v.f && !v.h) todo.push({ id, part, w, rank: (f && w.sysId === f.sys && near.has(id) ? near.get(id) : 1e5) + (part === 'front' ? 0 : .5) }); } }
      todo.sort((a, b) => a.rank - b.rank);
      if (todo.length) log('box art: sharper copies of', todo.length, 'pictures');
      for (const t of todo) {
        await idleTurn();
        const rec = art.db.games[t.id], v = rec && rec[t.part]; if (!v || !v.d || !v.f || v.h) continue; // changed meanwhile (a new pick is made at the new size)
        const base = baseOf(t.w.g.file), whole = /-full\.[a-z0-9]+$/i.test(decodeURIComponent(String(v.f)));
        try {
          const r = await N.artThumb(Object.assign({ src: v.f, key: t.w.sysId, name: base + SUFFIX[whole ? 'full' : t.part] + '~hd', maxH: DISPLAY_H }, whole ? Object.assign({ split: true, want: [t.part], dname: base + '~hd' }, caseShape(t.w.sysId)) : {}));
          const d = whole ? r && r.parts && r.parts[t.part] : r && r.display;
          if (!d) throw new Error('no copy made');
          if (rec[t.part] !== v) { if (d !== v.d) (art.db.trash = art.db.trash || []).push(d); continue; } // a pick came in while this one was being made (the copy just made goes)
          if (d !== v.d) (art.db.trash = art.db.trash || []).push(v.d);
          applyRec(t.w.g, t.part, Object.assign({}, v, { d, h: DISPLAY_H }));
        } catch (e) { // tried again at the next start; after three tries the original is taken to be gone (h 1) and the old copy stays
          if (rec[t.part] === v) { const n = (v.hf || 0) + 1; rec[t.part] = Object.assign({}, v, n >= 3 ? { h: 1, hf: n } : { hf: n }); }
          log('box art: kept the old copy', base + SUFFIX[t.part], e && e.message); }
      }
      // done once every copy is at the new size (or given up on); one that failed for now is tried again next start
      if (!Object.values(art.db.games).some(r => PARTS.some(p => r && r[p] && r[p].d && r[p].f && !r[p].h))) art.db.dispH = DISPLAY_H;
      saveArt();
    } finally { art.sharpening = false; }
  }
  // the copies the sharper ones replaced (last session): deleted, unless an Art Studio Undo still points at one
  // (beta.10) also Art Studio's: the copy a new pick replaced, and the ones its Undo history lets go. One an Undo still points
  // at stays in the list for a later pass (it used to be dropped from it, and its file was never deleted); one that's in use
  // again (put back by Undo) leaves the list: it comes back to it when it's replaced
  function dropOldDisplays() {
    const L = art.db.trash; if (!L || !L.length) return;
    const live = new Set(), hist = new Set(); for (const rec of Object.values(art.db.games)) for (const v of Object.values(rec || {})) if (v && v.d) { live.add(v.d); for (const p of Object.values(v.s || {})) live.add(p); }
    for (const S of Object.values(art.db.studio.games || {})) for (const H of Object.values((S && S.hist) || {})) for (const h of H || []) if (h && h.rec && h.rec.d) hist.add(h.rec.d);
    const all = [...new Set(L.filter(Boolean))], paths = all.filter(p => !live.has(p) && !hist.has(p));
    art.db.trash = all.filter(p => hist.has(p) && !live.has(p));
    if (paths.length && N.artForget) N.artForget({ paths }).catch(e => log('box art: tidy', e && e.message));
    saveArt();
  }
  const trashRec = r => { if (!r) return; const T = art.db.trash = art.db.trash || [], add = p => { if (p && !T.includes(p)) T.push(p); }; add(r.d); for (const p of Object.values(r.s || {})) add(p); }; // (deleted next start, if nothing points at it then; each once)
  // a part's picture is in place (rec null: forgotten): remembered, and on every copy of the game the page was handed (a rescan made new objects)
  function applyRec(g, part, rec) {
    const recs = art.db.games[g.id] = art.db.games[g.id] || {};
    const was = recs[part]; if (was && (!rec || rec.d !== was.d)) trashRec(was); // the copy replaced, and its small copies with it (beta.10: the display copy too; kept while an Undo points at it)
    if (rec && rec.s && (!was || was.d !== rec.d || was.s !== rec.s)) { rec = Object.assign({}, rec); delete rec.s; } // (a record carried over or put back: its small copies are made again)
    if (rec) { recs[part] = rec; urlRec.set(fileUrl(rec.d), rec); smallSoon(g.id, part); } else delete recs[part];
    const url = rec ? fileUrl(rec.d) : null, apply = x => { if (!x) return; x.art = x.art || {}; if (url) x.art[part] = url; else delete x.art[part]; };
    apply(g); for (const lib of [st.library, ...handed]) for (const sh of lib || []) for (const x of sh.games || []) if (x.id === g.id && x !== g) apply(x);
    art.arrived.add(g.id); flushArrived(); saveArt();
  }
  // file: the original's address (a content:// uri or an app file), so a lost display copy can be made again from it
  function found(j, display, file, where, part) {
    part = part || j.part;
    // a background job only fills a part that had no picture when it was queued: one there now was set while it ran
    // (Art Studio, My picture…) and stays. (j.t0: a real job; the browser tests' __bsArtFound hands a picture in directly)
    if (j.t0 && recHas(j.g.id, part)) { log('box art: kept the picture set meanwhile for', j.g.title, part); return; }
    applyRec(j.g, part, { d: display, f: file || '', w: where || '', h: DISPLAY_H }); delete art.db.miss[j.k];
    if (part === 'front') art.added++;
    if (!j.counted) { j.counted = true; art.found++; } // (a wrap's back and spine are one find)
    if (art.toastAt && art.running) startToast();
  }
  // new covers onto the cases in view, a few at a time and only while the shelf is still (each swap is one async decode)
  function flushArrived(now) {
    if (art.flushT && !now) return;
    clearTimeout(art.flushT); art.flushT = 0;
    if (!art.arrived.size) return;
    if (!now && !quiet()) { art.flushT = setTimeout(() => { art.flushT = 0; flushArrived(); }, 1200); return; }
    if (!now) { art.flushT = setTimeout(() => { art.flushT = 0; if (quiet()) flushArrived(true); else flushArrived(); }, 600); return; } // gather the next few first, and check again: you may have started moving meanwhile
    const ids = [...art.arrived]; art.arrived.clear();
    try { if (window.Shelf && Shelf.artUpdated) Shelf.artUpdated(ids); } catch (e) { log('box art: shelf update', e && e.message); }
  }
  // the list is written whole (JSON of every game's art): only in a quiet moment, never in the middle of a slide
  function saveArt(now) { clearTimeout(art.saveT); art.saveT = 0; if (now && quiet()) { store('art.json', art.db); return; } art.saveT = setTimeout(() => saveArt(true), now ? 1500 : 4000); }
  function shelfToast(m) { try { if (window.Shelf && Shelf.toast && (!Shelf.getMode || /^(browse|details)$/.test(Shelf.getMode()))) Shelf.toast(m); } catch {} }
  // Settings → Art & manuals shows the count while it's open there (repainted at most once a second)
  function paintArt(force) {
    const t = Date.now(); if (!force && t - art.paintAt < 1000) return; art.paintAt = t;
    try { const S = window.Settings; if (S && S.isOpen && S.isOpen() && S.repaint && S._state && S._state().sec === 'art') S.repaint(); } catch {}
  }
  // The progress card: a small dark note in the corner while art is fetched ("Fetching art · 12/80", the games being
  // looked up right now, a thin bar). position:fixed on its own layer, so the shelf's layout is never touched; text
  // repainted at most 4 times a second and never while the shelf slides (it holds still until the slide ends); only on
  // the shelf (not over the museum, Settings or a game); fades out 2 s after the run. Settings → Art & manuals can turn it off.
  const card = (() => {
    let el = null, nEl, tEl, bar, hEl, drawT = 0, watchT = 0, hideT = 0, lastAt = 0, live = false, shown = false, sig = '', lastNames = [], src = art; // src: the run it's showing (art, or man: the manuals)
    const allowed = cardOn;
    const onShelf = () => { try { return !window.Shelf || !Shelf.getMode || /^(browse|details)$/.test(Shelf.getMode()); } catch { return true; } };
    const sliding = () => !!(window.BS_BUSY && window.BS_BUSY());
    function make() {
      el = document.createElement('div'); el.className = 'bs-artcard'; el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<div class="ac-top"><span class="ac-h"></span><span class="ac-n"></span></div><div class="ac-t"></div><div class="ac-bar"><i></i></div>';
      hEl = el.querySelector('.ac-h'); nEl = el.querySelector('.ac-n'); tEl = el.querySelector('.ac-t'); bar = el.querySelector('.ac-bar i');
      document.body.appendChild(el);
    }
    function vis(v) { if (v === shown) return; shown = v; el.classList.toggle('show', v); }
    function draw() {
      clearTimeout(drawT); drawT = 0; if (!el) return;
      const want = (live || hideT) && allowed() && onShelf() && !document.hidden;
      if (!want) { vis(false); return; }
      if (sliding()) { drawT = setTimeout(draw, 300); return; } // mid-slide: nothing changes until the shelf is still
      lastAt = performance.now();
      const total = Math.max(src.total, src.done); let names = [...src.now.values()].filter((t, i, a) => a.indexOf(t) === i).slice(0, 2);
      if (names.length) lastNames = names; else names = lastNames; // (between two jobs the last ones stay: no flicker)
      const W = src.words || ['Fetching art', 'Added art for', 'Box art up to date'];
      const head = live ? W[0] : (src.added ? `${W[1]} ${src.added} game${src.added === 1 ? '' : 's'}` : W[2]);
      const s2 = [head, src.done, total, live ? names.join(' · ') : ''].join('\n');
      if (s2 !== sig) { sig = s2; hEl.textContent = head; nEl.textContent = live || src.done ? `${src.done}/${total}` : '';
        tEl.textContent = live ? (names.join(' · ') || 'Looking…') : ''; bar.style.transform = `scaleX(${total ? Math.min(1, src.done / total) : 0})`; }
      vis(true);
    }
    // a light check while it's up: you may have opened the museum or Settings meanwhile (no frame loop, just a timer)
    const watch = () => { clearTimeout(watchT); watchT = (live || hideT) ? setTimeout(() => { draw(); watch(); }, 1000) : 0; };
    return {
      start(s) { if (!el) make(); src = s || art; clearTimeout(hideT); hideT = 0; live = true; sig = ''; lastNames = []; draw(); watch(); },
      paint() { if (!el || !live || drawT) return; const wait = 250 - (performance.now() - lastAt); if (wait > 0) drawT = setTimeout(draw, wait); else draw(); },
      finish() { if (!el || !live) return; live = false; clearTimeout(hideT);
        hideT = setTimeout(() => { hideT = 0; clearTimeout(drawT); drawT = 0; vis(false); watch(); }, 2000); draw(); },
      // up on screen now (a run that ends in the museum or Settings can't show its "Added…" there: the toast says it instead)
      shown: () => shown
    };
  })();
  const artSub = () => art.running ? { text: `Fetching art ${art.done}/${art.total}`, cls: 'warn' } : art.total ? { text: `Last run: found ${art.found} of ${art.total} missing picture${art.total === 1 ? '' : 's'}` } : null;

  // ---------- game manuals (0.3.0): a console's manuals, fetched on the device ----------
  // Per console (Settings → Art & manuals, or the setup wizard), each game's manual from the Internet Archive as page
  // pictures, saved beside the games in "Boxshelf Manuals" with the Windows build's names (<game>-manual-01.jpg …), so the
  // reader in Inspect shows them as it does on the PC. Pages already there (an earlier run, or the PC's "covers" /
  // "manuals" folders copied over with the games) are used as they are and never downloaded again. In the background, in
  // quiet moments and after the box art, through the same progress card, one archive.org download per game at a time.
  // (GamesDatabase.org only has PDFs; the reader needs pages, and turning a PDF into pages is the PC's job.)
  // (0.3.1: pages come down several at once, MAN_PAGE_PAR per manual; the Internet Archive draws each page on request,
  // so one after another left most of the time waiting. 1280 px wide is still more than the Thor's screen shows.)
  // (0.3.5: three manuals at once, six pages each, ten requests to archive.org at most; its "slow down" still backs off)
  const MAN_PAGES = 60, MAN_MISS_DAYS = 14, MAN_WORKERS = 3, MAN_PAGE_PAR = 6, PAGE_W = 1280;
  const man = { db: { v: 1, games: {}, miss: {} }, q: [], keys: new Set(), looked: new Set(), running: false, total: 0, done: 0, added: 0, now: new Map(), folders: {}, reason: '',
    words: ['Fetching manuals', 'Added manuals for', 'Manuals up to date'] };
  GATE.archive = 10; // archive.org: ten requests at once at most (it answers bigger bursts with "slow down": slowDown backs off)
  const uiOf = () => (st.config && st.config.ui) || {};
  const manFor = sysId => !!uiOf()['manual_' + sysId];      // this console's manuals are wanted (Settings / the wizard)
  const manAuto = () => !!uiOf().autoManuals;                // ...and fetched by themselves, new games included
  const manSure = () => uiOf().manualSure !== false;         // only confident English matches
  const pad2 = i => String(i).padStart(2, '0');
  const hasManual = g => !!(g.art && g.art.manual && g.art.manual.length);
  // the games' manuals from manuals.json (the same art.manual list of page addresses the Windows build gives)
  function applyManuals(lib) {
    for (const sh of lib || []) for (const g of sh.games || []) { const r = man.db.games[g.id]; if (!r || !r.pages || !r.pages.length || g.kind !== 'rom') continue;
      g.art = g.art || {}; g.art.manual = r.pages.map(fileUrl); }
  }
  function manIn(g, pages) { // a game's manual is in place: remembered, and on every copy of the game the page was handed
    const was = man.db.games[g.id] || {}; man.db.games[g.id] = Object.assign({}, was, { pages, rejected: false }); delete man.db.miss[g.id];
    const urls = pages.map(fileUrl);
    for (const lib of [st.library, ...handed]) for (const sh of lib || []) for (const x of sh.games || []) if (x.id === g.id) { x.art = x.art || {}; x.art.manual = urls; }
    saveMan();
  }
  function saveMan(now) { clearTimeout(man.saveT); man.saveT = 0; if (now && quiet()) { store('manuals.json', man.db); return; } man.saveT = setTimeout(() => saveMan(true), now ? 1500 : 4000); }
  // the files of one games folder that could be manual pages: "Boxshelf Manuals" first, then the PC's "covers" and "manuals"
  function manFolder(tree, sub) { const k = tree + '|' + sub; return man.folders[k] || (man.folders[k] = (async () => {
    const m = new Map(), add = (r, under) => { for (const f of (r && r.files) || []) { const n = String(f.name).toLowerCase(); if (!under || !m.has(n)) m.set(n, f.uri); } };
    try { add(await N.artList({ tree, sub, folder: 'manuals' })); } catch {}
    for (const folder of ['covers', 'pcmanuals']) try { add(await N.artList({ tree, sub: '', folder }), true); } catch {}
    return m; })()); }
  // one game's pages in a folder listing, in page order: <game>-manual-01.jpg, -02 … (any picture type)
  function pagesIn(m, base, most) { const pre = base.toLowerCase() + '-manual-', out = [];
    for (const [n, uri] of m) if (n.startsWith(pre)) { const k = /^(\d{1,3})\.(jpe?g|png|webp)$/.exec(n.slice(pre.length)); if (k) out.push([+k[1], uri]); }
    out.sort((a, b) => a[0] - b[0]); return out.slice(0, most || MAN_PAGES).map(x => x[1]); }
  // Every game's folders are looked in once a session (the PC's manuals are used whatever is switched on); the games of
  // the consoles whose manuals are wanted then go on to a download. → how many downloads were queued.
  // force (Download manuals now): also the games nothing was found for lately.
  function manQueue(reason, force, only) { // only: just these games (a manual set aside as the wrong one: fetched again)
    if (!st.library || !st.config) return 0;
    const now = Date.now(); let n = 0, nets = 0;
    for (const sh of st.library) { if (sh.kind !== 'console') continue; const want = !!only || (manFor(sh.id) && (force || manAuto()));
      for (const g of sh.games || []) { if (g.kind !== 'rom' || !g.file || !g.romTree || hasManual(g) || man.keys.has(g.id) || (only && !only.has(g.id))) continue;
        const net = want && (force || !(man.db.miss[g.id] && now - man.db.miss[g.id] < MAN_MISS_DAYS * 864e5));
        if (!net && man.looked.has(g.id)) continue;
        man.keys.add(g.id); man.q.push({ g, sysId: sh.id, net }); n++; if (net) nets++; } }
    if (!n) return 0;
    if (!man.running) { man.total = 0; man.done = 0; man.added = 0; man.folders = {}; man.reason = reason; }
    man.total += nets; if (nets) log('manuals: queued', nets, 'downloads for', reason);
    if (!man.running) runMan();
    paintArt(true);
    return nets;
  }  async function runMan() {
    man.running = true; man.now = new Map();
    // after the box art (one run on the card at a time). 0.3.2: a long art run (a big library, a slow source) no longer holds
    // the manuals back for good: after a minute they come alongside it, without a card of their own
    for (let t = 0; art.running && t < 15; t++) await sleep(1000); // (0.3.5: 15 s, was a minute)
    const showCard = !art.running && man.q.some(j => j.net); if (showCard) card.start(man);
    const worker = async () => { while (man.q.length) { await idleTurn(); const j = manNext(); if (!j) break;
      if (j.net) { man.now.set(j, j.g.title || baseOf(j.g.file)); if (showCard) card.paint(); }
      try { await manJob(j); } catch (e) { log('manuals', j.g.title, e && e.message); }
      man.now.delete(j); man.keys.delete(j.g.id); if (j.net) { man.done++; paintArt(); if (showCard) card.paint(); } } };
    try { await Promise.all(Array.from({ length: MAN_WORKERS }, worker)); } finally {
      if (showCard) card.finish(); man.running = false; saveMan(true); idleTurn().then(() => store('library.json', st.library)); paintArt(true);
      log('manuals: done', man.added, 'of', man.total);
      if (man.added && (man.reason === 'now' || !cardOn() || !card.shown())) shelfToast(`Added manuals for ${man.added} game${man.added === 1 ? '' : 's'}`);
      else if (!man.added && man.reason === 'now') shelfToast('No new manuals found');
      if (man.q.length) setTimeout(() => { if (!man.running && man.q.length) { man.total = man.q.length; man.done = 0; man.added = 0; man.reason = 'more'; runMan(); } }, 0);
    }
  }
  // (0.3.5) the next manual: one for the console on screen first (the shelf you're looking at fills in before the rest)
  function manNext() { let f = null; try { f = window.Shelf && Shelf.artFocus ? Shelf.artFocus(false) : null; } catch {}
    const k = f && f.sys ? man.q.findIndex(j => j.net && j.sysId === f.sys) : -1; return k > 0 ? man.q.splice(k, 1)[0] : man.q.shift(); }
  window.__bsManNext = q => { const was = man.q; man.q = q.slice(); try { return [manNext(), man.q]; } finally { man.q = was; } }; // browser tests: which manual goes next
  async function manJob(j) {
    const { g, sysId } = j, tree = g.romTree, sub = subFor(sysId, tree), base = baseOf(g.file), rec = man.db.games[g.id] || {};
    // 1. already in a folder (complete, as far as Boxshelf knows; a manual set aside as the wrong one is replaced instead)
    const have = await manFolder(tree, sub), there = pagesIn(have, base, rec.want); man.looked.add(g.id);
    if (there.length && !rec.rejected && !(rec.want > there.length)) { manIn(g, there); if (j.net) man.added++; return; }
    if (!j.net) return;
    // 2. the Internet Archive's best match, and how many pages it has
    const c = await iaBest(sysId, g.title, rec.no || []);
    const meta = c ? await iaJson(`https://archive.org/metadata/${encodeURIComponent(c.id)}`) : null;
    // (0.3.2) the page count: most items never say one in their metadata (imagecount), so it's read from the scan's own
    // page list, as the PC does; 0.3.1 sent those items down the slow PDF path. No count at all: the server would repeat
    // the last page past the end, so the pages aren't guessed
    const pages = c ? Math.min(MAN_PAGES, (+(meta && meta.metadata && meta.metadata.imagecount) || 0) || await iaPageCount(c.id, meta)) : 0;
    const jp2 = c && meta ? ((meta.files || []).find(x => /_jp2\.zip$/i.test(x.name || '')) || null) : null;
    if (!pages) { // no page pictures: a PDF instead (the Archive item's own, else GamesDatabase's), turned into pages here
      const iaUrl = c ? iaPdf(c.id, meta) : null;
      const gdbUrl = iaUrl || (rec.no || []).includes('gdb') ? null : await gdbPdf(sysId, g.title).catch(() => null);
      const r = iaUrl || gdbUrl ? await pdfManual(j, iaUrl || gdbUrl, have, base, rec, iaUrl ? c.id : 'gdb') : 'none';
      if (r === 'none' || r === 'missing') { man.db.miss[g.id] = Date.now(); saveMan(); }
      return;
    }
    man.db.games[g.id] = Object.assign({}, rec, { id: c.id, want: pages }); saveMan();
    // 3. its pages, MAN_PAGE_PAR at once (a page already there from a run cut short isn't fetched again)
    const out = new Array(pages), todo = [];
    for (let i = 0; i < pages; i++) { const name = `${base}-manual-${pad2(i + 1)}`, had = rec.rejected ? null : inFolder(have, name); if (had) out[i] = had.uri; else todo.push({ i, name }); }
    let stop = null; // the first page that failed stops the rest: { i, busy }
    const pageWorker = async () => { while (todo.length && !stop) { const p = todo.shift(); await netTurn(); if (stop) return;
      const get = url => gated('archive', () => N.fetchFile({ tree: saveTree(tree), sub, folder: 'manuals', name: p.name, key: 'manual-' + sysId, url }));
      let r = await get(`https://archive.org/download/${encodeURIComponent(c.id)}/page/n${p.i}_w${PAGE_W}.jpg`);
      // the page straight from the scan's picture archive, as the PC falls back to
      if ((!r || !r.ok) && !(r && r.busy) && jp2 && meta.server && meta.dir) { const stem = jp2.name.replace(/_jp2\.zip$/i, ''), inner = `${stem}_jp2/${stem}_${String(p.i).padStart(4, '0')}.jp2`;
        r = await get(`https://${meta.server}/BookReader/BookReaderImages.php?zip=${encodeURIComponent(meta.dir + '/' + jp2.name)}&file=${encodeURIComponent(inner)}&id=${encodeURIComponent(c.id)}&scale=2&rotate=0`); }
      if (!r || !r.ok) { if (r && r.busy) slowDown('archive'); if (!stop || p.i < stop.i) stop = { i: p.i, busy: !!(r && r.busy) }; return; }
      slowDown('archive', true); out[p.i] = r.file; have.set(String(r.name).toLowerCase(), r.file); } };
    await Promise.all(Array.from({ length: Math.min(MAN_PAGE_PAR, todo.length) }, pageWorker));
    if (stop) { if (!stop.busy) { man.db.miss[g.id] = Date.now(); saveMan(); } log('manuals:', g.title, 'stopped at page', stop.i + 1, 'of', pages, stop.busy ? '(busy: later)' : ''); return; } // busy: picked up again next time, from the missing pages
    manIn(g, out); man.added++;
  }
  // ----- the Internet Archive (the Windows build's search, main/manuals.js, cut down for one confident pick per game) -----
  const MAN_WORDS = { gc: ['gamecube', 'game cube', 'gcn', 'ngc'], wii: ['wii'], wiiu: ['wii u', 'wiiu'], psp: ['psp', 'playstation portable'], sw: ['switch'], ps3: ['ps3', 'playstation 3'],
    ps2: ['ps2', 'playstation 2'], psx: ['playstation', 'psx', 'ps1', 'psone'], n3ds: ['3ds', 'nintendo 3ds'], nds: ['nintendo ds', 'nds'], n64: ['nintendo 64', 'n64'],
    snes: ['super nintendo', 'snes', 'super famicom'], nes: ['nintendo entertainment system', 'nes', 'famicom'], gba: ['game boy advance', 'gba'], gbc: ['game boy color', 'gbc'],
    gb: ['game boy', 'gameboy'], megadrive: ['genesis', 'mega drive', 'megadrive'], saturn: ['saturn'], dreamcast: ['dreamcast'], mastersystem: ['master system'],
    gamegear: ['game gear'], pcengine: ['turbografx', 'pc engine'], neogeo: ['neo geo'],
    segacd: ['sega cd', 'mega cd', 'mega-cd'], sega32x: ['32x', 'sega 32x'], atari2600: ['atari 2600', '2600'], atarilynx: ['lynx', 'atari lynx'], wonderswan: ['wonderswan', 'wonderswan color'], dos: ['ms-dos', 'msdos', 'dos'] };
  const NOISE_W = /^(manual|instruction|instructions|booklet|nintendo|sony|sega|eng|english|usa|us|eu|pal|ntsc|scan|scans|game|games)$/;
  const manWords = s => new Set(norm(s).split(' ').filter(w => w.length > 1 || /\d/.test(w)));
  function manScore(title, t) { // how much of the game's title the item covers; much else in it, or another sequel number, counts against
    const A = manWords(title), B = manWords(t); if (!A.size) return 0; let hit = 0; for (const w of A) if (B.has(w)) hit++;
    const noise = [...B].filter(w => !A.has(w) && !NOISE_W.test(w) && !Object.values(MAN_WORDS).some(L => L.some(x => x.split(' ').includes(w)))).length;
    const nums = S => [...S].filter(w => /^\d{1,2}$/.test(w)), want = nums(A), got = nums(B), wrongSequel = got.some(x => !A.has(x)) || (want.length && got.length && !want.every(x => B.has(x)));
    return hit / A.size * (noise >= 3 ? .6 : noise === 2 ? .8 : 1) * (wrongSequel ? .4 : 1); }
  const otherConsole = (sysId, t) => { const low = ' ' + String(t).toLowerCase() + ' ', has = w => new RegExp('\\b' + w.replace(/ /g, '\\s?') + '\\b').test(low);
    return !(MAN_WORDS[sysId] || []).some(has) && Object.entries(MAN_WORDS).some(([k, L]) => k !== sysId && L.some(w => w.length > 3 && has(w))); };
  async function iaJson(url) {
    const r = await gated('archive', () => N.httpText({ url, headers: { Accept: 'application/json' } }));
    if (!r || r.status === 429 || r.status >= 500) throw new Error('archive.org busy');
    if (r.status !== 200) return null; try { return JSON.parse(r.text); } catch { return null; } }
  // an item's page count from its scan files (the PC's way): <stem>_page_numbers.json, else the leaves in <stem>_scandata.xml → 0 when neither says
  async function iaPageCount(id, meta) {
    const files = (meta && meta.files) || [], dl = n => `https://archive.org/download/${encodeURIComponent(id)}/${String(n).split('/').map(encodeURIComponent).join('/')}`;
    const pn = files.find(x => /_page_numbers\.json$/i.test(x.name || ''));
    // (archive.org busy: thrown on, so the game is tried again later instead of being sent down the PDF path or marked missed)
    if (pn) { const j = await iaJson(dl(pn.name)); const n = j && Array.isArray(j.pages) ? j.pages.length : 0; if (n) return n; }
    const sd = files.find(x => /_scandata\.xml$/i.test(x.name || ''));
    if (sd) { const r = await gated('archive', () => N.httpText({ url: dl(sd.name) }));
      if (r && (r.status === 429 || r.status >= 500)) throw new Error('archive.org busy');
      // only the leaves that are pages of the book (colour cards and blank leaves left out of the reader aren't)
      const n = r && r.status === 200 ? (String(r.text || '').match(/<page\b[\s\S]*?<\/page>/g) || []).filter(p => !/<addToAccessFormats>\s*false/i.test(p)).length : 0; if (n) return n; }
    return 0;
  }
  async function iaBest(sysId, title, no) {
    const W = MAN_WORDS[sysId] || [], t = String(title || '').replace(/\s*[([].*?[)\]]/g, '').replace(/"/g, '').trim(); if (!t) return null;
    const ask = async q => { const j = await iaJson(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=language&fl[]=imagecount&fl[]=downloads&rows=12&output=json`); return (j && j.response && j.response.docs) || []; };
    // the PC's three tries (main/manuals.js): the title with the console's words, then the title alone, then plain words
    let docs = await ask(`(${JSON.stringify(t)}) AND mediatype:texts AND (manual OR instruction OR booklet)` + (W.length ? ` AND (${W.map(w => JSON.stringify(w)).join(' OR ')})` : ''));
    if (!docs.length) docs = await ask(`title:(${JSON.stringify(t)}) AND mediatype:texts AND (manual OR instruction OR booklet)`); // (busy: thrown on, tried again later)
    if (!docs.length) docs = await ask(`${t.replace(/[^\w\s]/g, ' ')} ${W[0] || ''} manual AND (mediatype:texts OR mediatype:image)`);
    const best = docs.map(d => { const name = String(d.title || ''), lg = String(Array.isArray(d.language) ? d.language[0] : d.language || '').toLowerCase();
      let s = manScore(t, name) * 10;
      if (/mode d.emploi|spielanleitung|manuale|manual de|bedienungsanleitung/i.test(name)) s -= 3;
      if (lg && !/^(eng|en|english)/.test(lg)) s -= 4;
      if (/manual|instruction|booklet/i.test(name)) s += 1;
      if (/guide|strategy|magazine|catalog|price/i.test(name)) s -= 3;
      if (otherConsole(sysId, name)) s -= 6;
      s += Math.min(1, (+d.downloads || 0) / 500);
      return { id: String(d.identifier || ''), title: name, score: s }; })
      .filter(c => c.id && !no.includes(c.id) && c.score >= (manSure() ? 7 : 5)).sort((a, b) => b.score - a.score)[0]; // (7: the PC's confident pick)
    return best || null;
  }
  // ----- PDF manuals (0.3.1): an Archive item with only a PDF, or GamesDatabase.org's PDF (the Windows build's search,
  // main/manuals.js), drawn into page pictures here with pdf.js (renderer/vendor) and saved beside the games like any other
  // manual. One page at a time, only while the shelf is still; the JPEG encode runs in a worker.
  const PDF_MAX = 80 * 1024 * 1024; // (the native side's limit for a PDF manual: fetchFile)
  function iaPdf(id, meta) { // (beta.10: one the Archive lists as over the limit is never downloaded just to be refused)
    const f = ((meta && meta.files) || []).find(x => /\.pdf$/i.test(x.name || '') && !/_text\.pdf$/i.test(x.name) && !/encrypted/i.test(x.format || '') && !(+x.size > PDF_MAX));
    return f ? `https://archive.org/download/${encodeURIComponent(id)}/${String(f.name).split('/').map(encodeURIComponent).join('/')}` : null;
  }
  const GDB_SYSTEM = { gc: 'nintendo-gamecube', wii: 'nintendo-wii', wiiu: 'nintendo-wii-u', psp: 'sony-psp', sw: 'nintendo-switch', ps3: 'sony-playstation-3', ps4: 'sony-playstation-4',
    ps2: 'sony-playstation-2', x360: 'microsoft-xbox-360', n3ds: 'nintendo-3ds', psx: 'sony-playstation', snes: 'nintendo-snes', n64: 'nintendo-n64', gba: 'nintendo-game-boy-advance',
    nds: 'nintendo-ds', megadrive: 'sega-genesis' };
  GATE.gdb = 3;
  function gdbSlugs(title) { // its page addresses come from the title: a few spellings are tried
    const t = String(title).replace(/\s*\(.*?\)/g, '');
    const base = t.toLowerCase().replace(/&/g, 'and').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');
    const out = new Set([base.replace(/-+$/, ''), base.replace(/-+$/, '') + '-', base]);
    out.add(t.toLowerCase().replace(/&/g, 'and').replace(/['’]/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')); // (GamesDatabase writes Assassin's as assassin-s)
    const m = t.match(/^(The|A)\s+(.*)$/i); if (m) out.add(gdbSlugs(m[2])[0]);
    const m2 = t.match(/^(.*?),\s*(The|A)(\s*-\s*.*)?$/i); if (m2) out.add(gdbSlugs(`${m2[2]} ${m2[1]}${m2[3] || ''}`)[0]);
    return [...out].filter(Boolean);
  }
  async function gdbPdf(sysId, title) {
    const sys = GDB_SYSTEM[sysId]; if (!sys) return null;
    for (const slug of gdbSlugs(title)) {
      const r = await gated('gdb', () => N.httpText({ url: `https://www.gamesdatabase.org/game/${sys}/${slug}` })).catch(() => null);
      if (!r || r.status !== 200 || !r.text || /Game Not Found/i.test(r.text)) continue;
      const m = r.text.match(/href="([^"]*\/Manual\/[^"]+\.pdf)"/i); if (!m) return null; // the game's page, without a manual
      return m[1].startsWith('http') ? m[1] : 'https://www.gamesdatabase.org' + (m[1].startsWith('/') ? '' : '/') + m[1];
    }
    return null;
  }
  let pdfLibP = null;
  function pdfLib() { // pdf.js, loaded the first time a PDF manual comes along
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return pdfLibP || (pdfLibP = new Promise(res => { const s = document.createElement('script'); s.src = 'vendor/pdf.min.js';
      s.onload = () => { try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; } catch {} res(window.pdfjsLib || null); }; s.onerror = () => { pdfLibP = null; res(null); }; document.head.appendChild(s); }));
  }
  let jpgW = null, jpgId = 0; const jpgCb = new Map();
  function toJpegB64(c) { // a drawn page → base64 JPEG (encoded in a worker: a canvas encode on this thread stalls the shelf)
    const viaHere = () => c.toDataURL('image/jpeg', .88).split(',')[1];
    try { if (jpgW === null) { if (typeof OffscreenCanvas === 'undefined') throw 0;
        jpgW = new Worker(URL.createObjectURL(new Blob(['onmessage=async e=>{let b=null;try{const m=e.data.bm,o=new OffscreenCanvas(m.width,m.height);o.getContext("2d").drawImage(m,0,0);m.close();b=await o.convertToBlob({type:"image/jpeg",quality:.88})}catch(x){}postMessage({id:e.data.id,b})}'], { type: 'text/javascript' })));
        jpgW.onmessage = e => { const f = jpgCb.get(e.data.id); jpgCb.delete(e.data.id); if (f) f(e.data.b); }; jpgW.onerror = () => { jpgW = false; jpgCb.forEach(f => f(null)); jpgCb.clear(); }; } } catch { jpgW = false; }
    if (!jpgW) return Promise.resolve(viaHere());
    return createImageBitmap(c).then(bm => new Promise(res => { const id = ++jpgId; jpgCb.set(id, res); jpgW.postMessage({ id, bm }, [bm]); }))
      .then(b => b ? new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => res(viaHere()); r.readAsDataURL(b); }) : viaHere(), viaHere);
  }
  // → 'ok' | 'busy' (try later) | 'missing' (no such file / not a PDF) | 'none' (couldn't read it)
  async function pdfManual(j, url, have, base, rec, id) {
    const { g, sysId } = j, tree = g.romTree, sub = subFor(sysId, tree), host = /archive\.org/.test(url) ? 'archive' : 'gdb';
    const lib = await pdfLib(); if (!lib) return 'none';
    const f = await gated(host, () => N.fetchFile({ url, name: base + '-manual', key: 'manual-' + sysId, pdf: true }));
    if (!f || !f.ok) { if (f && f.busy) { slowDown(host); return 'busy'; }
      // (beta.10) too big to use: that copy is set aside for the game (never downloaded again), like a wrong one
      if (f && f.toobig) { const r0 = man.db.games[g.id] || rec; man.db.games[g.id] = Object.assign({}, r0, { no: [...new Set([...(r0.no || []), id])] }); saveMan(); log('manuals: PDF too big', g.title); }
      return 'missing'; }
    slowDown(host, true);
    let doc = null;
    try {
      const data = /^data:/.test(f.file) ? Uint8Array.from(atob(f.file.split(',')[1]), ch => ch.charCodeAt(0)) // (the pretend device's file; the page may not fetch data: addresses)
        : new Uint8Array(await (await fetch(fileUrl(f.file))).arrayBuffer());
      doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
      const n = Math.min(doc.numPages, MAN_PAGES), out = [];
      man.db.games[g.id] = Object.assign({}, rec, { id, want: n, pdf: true }); saveMan();
      for (let i = 1; i <= n; i++) {
        const name = `${base}-manual-${pad2(i)}`, had = rec.rejected ? null : inFolder(have, name);
        if (had) { out.push(had.uri); continue; }
        await idleTurn();
        const page = await doc.getPage(i), v0 = page.getViewport({ scale: 1 }), v = page.getViewport({ scale: PAGE_W / Math.max(v0.width, v0.height * .75) });
        const c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height);
        const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); // (drawn on the CPU: the graphics card stays the shelf's)
        await page.render({ canvasContext: x, viewport: v }).promise; page.cleanup();
        const b64 = await toJpegB64(c); c.width = c.height = 0;
        const r = await N.saveBytes({ tree: saveTree(tree), sub, folder: 'manuals', name, ext: 'jpg', b64, key: 'manual-' + sysId });
        if (!r || !r.ok) return 'none';
        out.push(r.file); have.set(String(r.name).toLowerCase(), r.file);
      }
      manIn(g, out); man.added++; return 'ok';
    } catch (e) { log('manuals: PDF', g.title, e && e.message); return 'none'; }
    finally { if (doc) try { doc.destroy(); } catch {}
      // (beta.10) the PDF (up to 80 MB in the cache) goes once it's been read: its pages are saved, and a new try downloads it again anyway
      if (N.dropPdf && f.file && !/^data:/.test(f.file)) N.dropPdf({ path: f.file }).catch(() => {}); }
  }
  const manSub = () => man.running ? { text: `Fetching manuals ${man.done}/${man.total}`, cls: 'warn' } : man.total ? { text: `Last run: ${man.added} of ${man.total} game${man.total === 1 ? '' : 's'} got a manual` } : null;

  // ----- the sources -----
  // GameTDB's regions for a disc id: the disc's own first, then US / EN (a few: every one is a download to try)
  const tdbRegs = id => { const own = TDB_REGIONS[id[3]] || ['US', 'EN']; return { own, all: [...own, 'US', 'EN'].filter((r, i, a) => a.indexOf(r) === i).slice(0, 3) }; };
  const TDB_REG = { US: 'usa', JA: 'jpn', KO: '', EN: 'eur', FR: 'eur', DE: 'eur', ES: 'eur', IT: 'eur', NL: 'eur', AU: 'eur' };
  // → the sources, best first, each asked only when the ones before it didn't have the picture: [async () => { urls, ss?, unsure? }]
  // (unsure: the source couldn't be asked, offline say, so an empty answer doesn't mean "there's none")
  function artGroups(sysId, g, part) {
    const out = [];
    if (TDB_SYS[sysId] && g.uri && (part === 'front' || part === 'disc')) out.push(async () => { const id = await discIdOf(g), urls = [];
      if (id) { const root = 'https://art.gametdb.com/' + TDB_SYS[sysId];
        for (const r of tdbRegs(id).all) { if (part === 'front') urls.push(`${root}/coverHQ/${r}/${id}.png`, `${root}/cover/${r}/${id}.png`); else urls.push(`${root}/disc/${r}/${id}.png`); } }
      return { urls }; });
    if ((part === 'front' || part === 'disc') && LB_PLAT[sysId]) out.push(() => lbGroup(sysId, g, part)); // (0.3.3) LaunchBox's scans, once its database is on the device
    if (part === 'front' || part === 'disc') out.push(() => ssGroup(sysId, g, part));
    // (0.3.3) IGDB's official HD covers (with the user's Twitch keys), before libretro's smaller ones
    if (part === 'front') out.push(async () => { if (!igdbOn()) return { urls: [] };
      try { return { urls: (await igdbCovers(sysId, g.title)).slice(0, 2).map(x => x.url) }; } catch (e) { log('IGDB', e && e.message); return { urls: [], unsure: true }; } });
    if (part === 'front' && LR[sysId]) out.push(async () => { const L = await lrList(sysId);
      return { urls: lrMatches(L, g).map(n => `https://thumbnails.libretro.com/${encodeURIComponent(LR[sysId])}/Named_Boxarts/${encodeURIComponent(n + '.png')}`), unsure: !L }; });
    if (part === 'front') out.push(async () => { const key = sgKey(); if (!key) return { urls: [] };
      try { return { urls: (await sgdb(key, g.title)).map(x => x.url) }; } catch (e) { log('SteamGridDB', e && e.message); return { urls: [], unsure: true }; } });
    return out;
  }
  function wrapGroups(sysId, g) {
    const out = [];
    if (TDB_SYS[sysId] && g.uri) out.push(async () => { const id = await discIdOf(g), urls = [];
      if (id) { const root = 'https://art.gametdb.com/' + TDB_SYS[sysId]; for (const r of tdbRegs(id).all) urls.push(`${root}/coverfullHQ/${r}/${id}.png`, `${root}/coverfull/${r}/${id}.png`); }
      return { urls }; });
    if (LB_PLAT[sysId]) out.push(() => lbGroup(sysId, g, 'wrap')); // (0.3.3) LaunchBox's full box scans
    out.push(() => ssGroup(sysId, g, 'wrap'));
    return out;
  }

  // ----- the LaunchBox Games Database on the device (0.3.3) -----
  // Opt-in: Settings says the download size (about 110 MB) before anything comes down. The native side downloads
  // Metadata.zip (four connections, resumed after a break), streams the XML out of it on a low-priority thread and writes
  // one file per console (lb-<platform>.json: games [id, name, year], pictures [id, type, region, file]) for the consoles
  // on your shelves; the zip is deleted. Here a console's file is read the first time a game of it needs art, its names
  // indexed in small idle slices (as libretro's lists), and dropped again two minutes after the last use.
  const LB_PLAT = { gc: 'Nintendo GameCube', wii: 'Nintendo Wii', wiiu: 'Nintendo Wii U', sw: 'Nintendo Switch', n3ds: 'Nintendo 3DS', nds: 'Nintendo DS',
    psx: 'Sony Playstation', ps2: 'Sony Playstation 2', ps3: 'Sony Playstation 3', ps4: 'Sony Playstation 4', psp: 'Sony PSP', x360: 'Microsoft Xbox 360',
    n64: 'Nintendo 64', snes: 'Super Nintendo Entertainment System', nes: 'Nintendo Entertainment System', gba: 'Nintendo Game Boy Advance',
    gbc: 'Nintendo Game Boy Color', gb: 'Nintendo Game Boy', megadrive: 'Sega Genesis', saturn: 'Sega Saturn', dreamcast: 'Sega Dreamcast',
    mastersystem: 'Sega Master System', gamegear: 'Sega Game Gear', pcengine: 'NEC TurboGrafx-16', neogeo: 'SNK Neo Geo AES',
    segacd: 'Sega CD', sega32x: 'Sega 32X', atari2600: 'Atari 2600', atarilynx: 'Atari Lynx', wonderswan: 'WonderSwan', dos: 'MS-DOS' };
  const LB_IMG = 'https://images.launchbox-app.com/', LB_MB = 110, LB_DAYS = 90;
  const lb = { meta: undefined, shards: {}, dropT: 0, job: null, prog: null, L: [] };
  const lbSafe = p => String(p).replace(/[^A-Za-z0-9]+/g, '_');
  async function lbMeta() { if (lb.meta === undefined) { const m = await load('lb-meta.json', null); lb.meta = m && Array.isArray(m.plats) ? m : null; } return lb.meta; }
  const lbHas = sysId => !!(lb.meta && LB_PLAT[sysId] && lb.meta.plats.includes(LB_PLAT[sysId]));
  // one console's file → { list: [{ id, name, n }], img: Map id → [{ type, region, file }] } (or null: not indexed)
  // (at most two consoles' files kept at once, the least recently used one let go: a long art run across every console
  // never holds all of them; all go two minutes after the last use)
  function lbShard(sysId) {
    clearTimeout(lb.dropT); lb.dropT = setTimeout(() => { lb.shards = {}; }, 120000);
    if (lb.shards[sysId]) { const p = lb.shards[sysId]; delete lb.shards[sysId]; lb.shards[sysId] = p; return p; } // (most recently used last)
    const keys = Object.keys(lb.shards); if (keys.length >= 2) delete lb.shards[keys[0]];
    return (lb.shards[sysId] = (async () => {
      await lbMeta(); if (!lbHas(sysId)) return null;
      // the text is read, then parsed only in a quiet moment (a few MB of JSON is never parsed while the shelf slides)
      let s = null; try { const r = await N.readText({ name: 'lb-' + lbSafe(LB_PLAT[sysId]) + '.json' }); await idleTurn(); s = r && r.text ? JSON.parse(r.text) : null; } catch { s = null; }
      if (!s || !Array.isArray(s.games)) return null;
      const list = [], img = new Map(), I = s.images || [];
      for (let i = 0; i < s.games.length; i += 400) { // ~400 names per slice: thousands of games never hold up a frame
        if (i) await idleTurn();
        for (const x of s.games.slice(i, i + 400)) list.push({ id: x[0], name: x[1], n: norm(x[1]) });
      }
      for (let i = 0; i < I.length; i += 3000) { // the pictures in slices too
        await idleTurn();
        for (let k = i; k < Math.min(I.length, i + 3000); k++) { const x = I[k], L = img.get(x[0]) || img.set(x[0], []).get(x[0]); L.push({ type: x[1], region: x[2], file: x[3] }); }
      }
      return { list, img };
    })());
  }
  // the PC's matcher (main/covers.js matchTitle): exact, without spaces, without a brand prefix, "and" ignored, then close calls;
  // ties go to the entry with the most box art
  function lbMatch(list, title, art) {
    if (!list || !list.length || !title) return null;
    const want = norm(title), tight = want.replace(/ /g, ''); if (!want) return null;
    const richest = a => a.length ? a.reduce((x, y) => art(y) > art(x) ? y : x) : null;
    const exact = richest(list.filter(g => g.n === want)) || richest(list.filter(g => g.n.replace(/ /g, '') === tight)); if (exact) return exact;
    const BRAND = /^(disney s|disneys|disney pixar|disney|pixar|nickelodeon|nick|mtv|cartoon network|dreamworks|activision|ea sports|ea|sega|capcom|konami|ubisoft|thq|namco)\s+/;
    const unbrand = x => x.replace(BRAND, '').replace(BRAND, ''), want2 = unbrand(want);
    if (want2 !== want) { const e2 = richest(list.filter(g => g.n === want2 || unbrand(g.n) === want2)); if (e2) return e2; }
    const noAnd = s => s.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (noAnd(want) !== want) { const e3 = richest(list.filter(g => noAnd(g.n) === noAnd(want))); if (e3) return e3; }
    const W = new Set(want2.split(' ').filter(Boolean)), wantW = want2.split(' ').filter(Boolean); let best = null, bestScore = 0;
    for (const g of list) { let score = 0;
      if (g.n.startsWith(want2 + ' ') || want2.startsWith(g.n + ' ')) { const extra = g.n.length > want2.length ? g.n.slice(want2.length) : want2.slice(g.n.length); if (!/\b(\d+|[ivx]+)\b/.test(extra)) score = .9 - Math.abs(g.n.length - want2.length) / 200; } // "Pikmin" never stands in for "Pikmin 2"
      else { const G = g.n.split(' ').filter(Boolean); if (G.length) { let hit = 0; for (const w of G) if (W.has(w)) hit++; const j = hit / new Set([...W, ...G]).size; if (j >= .75) score = j;
        else if (W.size >= 3) { const extra = G.filter(w => !W.has(w)); let k = 0; for (const w of G) if (k < wantW.length && w === wantW[k]) k++;
          if (k === wantW.length && extra.length <= 3 && !extra.some(w => /^(\d+|[ivx]+)$/.test(w))) score = .8 - extra.length * .03; } } }
      if (score && !art(g)) score -= .05;
      if (score > bestScore) { bestScore = score; best = g; } }
    return best;
  }
  const LB_REG = { usa: /^(north america|united states|usa|canada)$/i, eur: /^(europe|pal|united kingdom|uk|germany|france|spain|italy|netherlands|sweden|australia|scandinavia|oceania)$/i, jpn: /^japan$/i };
  const lbRegion = s => { s = String(s || '').trim(); for (const r of ['usa', 'eur', 'jpn']) if (LB_REG[r].test(s)) return r; return /^world$/i.test(s) ? 'world' : ''; };
  // a game's LaunchBox pictures → [{ type, region, file }] (none: not indexed, or no match)
  async function lbImages(sysId, g) {
    if (!LB_PLAT[sysId]) return []; await lbMeta(); if (!lbHas(sysId)) return [];
    const s = await lbShard(sysId); if (!s) return [];
    const art = e => (s.img.get(e.id) || []).filter(i => /^(Box - |Disc$)/.test(i.type)).length;
    let e = lbMatch(s.list, g.title, art);
    if (!e && /\s(\+|&|and)\s/i.test(g.title)) e = lbMatch(s.list, g.title.split(/\s(?:\+|&|and)\s/i)[0], art);
    return e ? s.img.get(e.id) || [] : [];
  }
  // the order of a part's pictures: the game's own region first, then North America, World, Europe, Japan
  function lbSort(L, g) { const own = regionKey(g.region), rank = r => r === own ? 0 : r === 'usa' ? 1 : r === 'world' ? 2 : r === '' ? 3 : r === 'eur' ? 4 : 5;
    return L.slice().sort((a, b) => rank(lbRegion(a.region)) - rank(lbRegion(b.region))); }
  const LB_TYPES = { front: ['Box - Front', 'Box - Front - Reconstructed'], back: ['Box - Back', 'Box - Back - Reconstructed'], spine: ['Box - Spine'], disc: ['Disc', 'Cart - Front'], wrap: ['Box - Full'] };
  // the automatic fetch's LaunchBox group for a part (real scans only: fan art is for the Art Studio)
  async function lbGroup(sysId, g, part) {
    const imgs = await lbImages(sysId, g), urls = [];
    for (const t of LB_TYPES[part] || []) for (const im of lbSort(imgs.filter(i => i.type === t), g)) urls.push(LB_IMG + encodeURI(im.file));
    return { urls: urls.slice(0, 4) };
  }
  // Art Studio's LaunchBox versions of a part: every region and kind, fan art too (marked)
  async function lbStudio(sysId, g, part) {
    const imgs = await lbImages(sysId, g), out = [];
    const types = { front: ['Box - Front', 'Box - Front - Reconstructed', 'Fanart - Box - Front', 'Steam Poster'], back: ['Box - Back', 'Box - Back - Reconstructed', 'Fanart - Box - Back'], spine: ['Box - Spine', 'Box - Full'], disc: ['Disc', 'Cart - Front', 'Fanart - Cart - Front', 'Fanart - Disc'] }[part] || [];
    for (const t of types) for (const im of lbSort(imgs.filter(i => i.type === t), g)) {
      const fan = /^Fanart|^Steam Poster/.test(t), recon = /Reconstructed/.test(t), region = lbRegion(im.region), full = t === 'Box - Full';
      const what = full ? 'Cut from full box' : fan ? 'Fan art' : recon ? 'Clean rebuild' : /Cart/.test(t) ? 'Cartridge' : part === 'disc' ? 'Disc scan' : 'Box scan';
      out.push({ url: LB_IMG + encodeURI(im.file), source: 'launchbox', region, kind: recon || fan ? 'clean' : 'scan', fan, cut: full ? 'spine' : '', label: [what, RW[region] || im.region || ''].filter(Boolean).join(' · ') });
    }
    return out;
  }
  // the consoles worth indexing: every console on a shelf with games that LaunchBox knows
  const lbWanted = () => [...new Set((st.library || []).filter(sh => sh.kind === 'console' && (sh.games || []).length && LB_PLAT[sh.id]).map(sh => LB_PLAT[sh.id]))];
  const lbEmit = p => { lb.prog = p; lb.L.forEach(f => { try { f(p); } catch (e) { console.error(e); } }); if (window.Settings && Settings.repaint) Settings.repaint(); };
  if (N.addListener) Promise.resolve().then(() => N.addListener('lbIndex', e => { if (lb.job) lbEmit({ phase: e.phase, pct: e.pct, got: e.got, total: e.total }); })).catch(() => {});
  // build (or rebuild) the database → { state, at, bytes }; one at a time (a second ask joins the first)
  function lbBuild() {
    if (lb.job) return lb.job;
    return (lb.job = (async () => {
      await ready; const plats = lbWanted();
      if (!plats.length) throw new Error('No consoles with games that LaunchBox knows yet');
      if (!N.lbIndex) throw new Error('This version of Boxshelf can\'t download the LaunchBox database');
      lbEmit({ phase: 'start' });
      const r = await N.lbIndex({ plats });
      lb.meta = undefined; lb.shards = {}; await lbMeta(); cands.lists = {}; // (the studio's lists from before have no LaunchBox versions)
      // what nothing was found for on the consoles just indexed is asked for again, LaunchBox now in the line (only when box
      // art comes by itself: with automatic art off, nothing is downloaded)
      const idx = new Set(plats); for (const sh of st.library || []) if (sh.kind === 'console' && idx.has(LB_PLAT[sh.id])) for (const g of sh.games || []) for (const p of ['front', 'disc', 'wrap']) delete art.db.miss[g.id + '|' + p];
      saveArt(); setTimeout(() => queueArt('launchbox', false), 1500);
      log('LaunchBox: index built', JSON.stringify(r && r.counts));
      return lbInfo();
    })().finally(() => { lb.job = null; lb.prog = null; lbEmit(null); }));
  }
  if (!isNative) window.__bsLbGroup = (sysId, file, part) => lbGroup(sysId, gameFor(sysId, file), part); // browser tests: the fetch's LaunchBox group
  function lbInfo() { const m = lb.meta; return m ? { state: 'ready', at: m.at, bytes: m.bytes || 0, plats: m.plats.length, missing: lbWanted().filter(p => !m.plats.includes(p)).length } : { state: lb.job ? 'preparing' : 'missing', at: 0, bytes: 0 }; }
  ready.then(() => lbMeta()).catch(() => {});
  const sgKey = () => st.config.keys && typeof st.config.keys.steamgriddb === 'string' ? st.config.keys.steamgriddb.trim() : '';
  // libretro's list of a console's covers: fetched once a week, then the names are indexed in small idle slices
  function lrList(sysId) {
    if (art.lists[sysId]) return art.lists[sysId];
    return (art.lists[sysId] = (async () => {
      let c = await load('lr-' + sysId + '.json', null);
      if (!c || !Array.isArray(c.names) || Date.now() - c.at > LR_DAYS * 864e5) {
        try { const r = await gated('libretro', () => N.artIndex({ url: `https://thumbnails.libretro.com/${encodeURIComponent(LR[sysId])}/Named_Boxarts/` }));
          if (r && r.names && r.names.length) { c = { at: Date.now(), names: r.names }; store('lr-' + sysId + '.json', c); } // an empty page isn't worth remembering…
          else if (r && (r.status === 404 || r.status === 410)) { c = { at: Date.now(), names: [] }; store('lr-' + sysId + '.json', c); } } // …unless libretro has no such console at all
        catch (e) { log('libretro list', sysId, e && e.message); } }
      if (!c || !Array.isArray(c.names)) return null; // offline: this run does without (nothing is marked missing), the next run asks again
      const names = c.names, idx = new Map();
      for (let i = 0; i < names.length; i += 250) { // ~250 titles per idle slice: thousands of names never hold up a frame
        for (const n of names.slice(i, i + 250)) { const k = norm(T.cleanTitle(n + '.png').title); (idx.get(k) || idx.set(k, []).get(k)).push(n); }
        await idleTurn(); }
      return { set: new Set(names), idx };
    })());
  }
  // the Windows matcher (libretroAll): the file's own name first, then every release with the same clean title, this game's region first
  function lrMatches(L, g) {
    if (!L || !L.set.size) return [];
    const base = baseOf(g.file), out = [];
    for (const c of [base, libretroSafe(base)]) if (L.set.has(c) && !out.includes(c)) out.push(c);
    const reg = (g.region || 'USA').toLowerCase(), hits = (L.idx.get(norm(g.title)) || []).slice();
    const rank = h => { const l = h.toLowerCase(); return l.includes('(' + reg) ? 0 : /\(usa/.test(l) ? 1 : /\(world/.test(l) ? 2 : 3; };
    hits.sort((a, b) => rank(a) - rank(b));
    for (const n of hits) if (!out.includes(n)) out.push(n);
    return out.slice(0, 3);
  }
  async function discIdOf(g) {
    if (art.db.ids[g.id] !== undefined) return art.db.ids[g.id];
    let id = null; try { const r = await N.discId({ uri: g.uri }); id = (r && r.id) || null; } catch {}
    art.db.ids[g.id] = id; return id;
  }
  // SteamGridDB posters → [{ url, label }] (0.3.1: every case-shaped size, up to n, in its own order: best voted first)
  async function sgdb(key, title, n = 2) {
    const H = { Authorization: 'Bearer ' + key }, base = 'https://www.steamgriddb.com/api/v2';
    const s = await N.httpText({ url: `${base}/search/autocomplete/${encodeURIComponent(title)}`, headers: H });
    const hit = s && s.status === 200 && (JSON.parse(s.text).data || [])[0]; if (!hit) return [];
    const r = await N.httpText({ url: `${base}/grids/game/${hit.id}?dimensions=600x900,342x482,660x930&types=static&nsfw=false&humor=false`, headers: H });
    return r && r.status === 200 ? (JSON.parse(r.text).data || []).filter(x => /^https:/.test(x.url)).slice(0, n).map(x => ({ url: x.url, label: 'SteamGridDB' + (x.style ? ' · ' + x.style.replace(/_/g, ' ') : '') + (x.author && x.author.name ? ' · by ' + x.author.name : '') })) : [];
  }
  // IGDB (0.3.1): official covers up to 1080p. Needs a free Twitch developer Client ID + Secret (Settings → Accounts &
  // services); the native side adds the sign-in to each request, the page never handles the secret.
  const igdbOn = () => { const k = st.config.keys || {}; return !!(String(k.igdbId || '').trim() && String(k.igdbSecret || '').trim()); };
  const IGDB_PLAT = { gc: 21, wii: 5, wiiu: 41, sw: 130, psx: 7, ps2: 8, ps3: 9, ps4: 48, psp: 38, psvita: 46, n64: 4, snes: 19, nes: 18, gba: 24, gb: 33, gbc: 22, nds: 20, n3ds: 37,
    megadrive: 29, saturn: 32, dreamcast: 23, mastersystem: 64, gamegear: 35, pcengine: 86, x360: 12, xbox: 11 };
  GATE.igdb = 2;
  async function igdbCovers(sysId, title, n = 4) { // → [{ url, label }], the games whose names match best
    const t = String(title || '').replace(/\s*[([].*?[)\]]/g, '').replace(/["\\]/g, '').trim(), p = IGDB_PLAT[sysId]; if (!t) return [];
    const q = `search "${t}"; fields name,cover.image_id; where cover != null${p ? ` & platforms = (${p})` : ''}; limit 10;`;
    const r = await gated('igdb', () => N.httpText({ url: 'https://api.igdb.com/v4/games', body: q, igdb: true }));
    if (!r || r.status === 429 || r.status >= 500) { if (r && r.status === 429) slowDown('igdb'); throw new Error('IGDB busy'); } // (busy: asked again later, not remembered as "none")
    if (r.status !== 200) return [];
    let L = []; try { L = JSON.parse(r.text) || []; } catch {}
    return L.map(x => ({ x, s: manScore(t, x.name || '') })).filter(o => o.s >= .6 && o.x.cover && o.x.cover.image_id).sort((a, b) => b.s - a.s).slice(0, n)
      .map(({ x }) => ({ url: `https://images.igdb.com/igdb/image/upload/t_1080p/${encodeURIComponent(x.cover.image_id)}.jpg`, label: 'IGDB · ' + (x.name || 'Official cover') }));
  }

  // ---------- ScreenScraper (optional: only with the player's own account, Settings → Accounts & services) ----------
  // The Windows logic (main/screenscraper.js) on the native HTTP: as many requests at once as the account allows
  // (maxthreads), spaced to its maxrequestspermin; 429 pauses a minute, a used-up day pauses until the next UTC day, a
  // refused sign-in stops the calls until it's changed. Games are matched by file name + size (+ the GameCube / Wii disc
  // id), then by title. Lookups are remembered (ss-cache.json: a game a week, no match a day).
  // The sign-in never passes through the page's requests: the native side adds it to ScreenScraper's addresses at the
  // moment of the request (from the saved settings). Media addresses in the answers carry it in their query: they're kept
  // without it (ssClean). Nothing here logs an address or a body.
  const SS_SYS = { gc: 13, wii: 16, wiiu: 18, sw: 225, n3ds: 17, nds: 15, ps2: 58, psp: 61, psx: 57, n64: 14, dreamcast: 23, saturn: 22, megadrive: 1, mastersystem: 2,
    gamegear: 21, snes: 4, nes: 3, gba: 12, gbc: 10, gb: 9, pcengine: 31, neogeo: 142, segacd: 20, sega32x: 19, atari2600: 26, atarilynx: 28, wonderswan: 45, dos: 135 };
  const JEWEL = new Set(['psx', 'saturn', 'dreamcast', 'pcengine']); // CD cases: back insert with the spines on it
  const SS_MEDIA = { front: ['box-2D'], back: ['box-2D-back'], spine: ['box-2D-side'], wrap: ['box-texture'], disc: ['support-2D'] };
  const SS_REGION = r => { r = String(r || '').toLowerCase(); return r === 'us' || r === 'cus' ? 'usa' : r === 'jp' ? 'jpn' : r === 'wor' ? 'world' : /^(eu|fr|de|es|it|uk|nl|pt|se|dk|fi|no|pl|gr|ru|au|nz)$/.test(r) ? 'eur' : ''; };
  const SS_MSG = { rate: 'ScreenScraper asked us to slow down', quota: "Today's ScreenScraper lookups are used up", closed: 'ScreenScraper is closed to apps right now', auth: 'The ScreenScraper login was not accepted', blocked: 'ScreenScraper has blocked this version of Boxshelf', net: "Couldn't reach ScreenScraper" };
  const ss = { until: 0, why: '', bad: '', threads: 1, spacing: 0, lastAt: 0, active: 0, waiting: [], cache: null, saveT: 0, dirty: false };
  const ssKeys = () => { const k = (st.config && st.config.keys) || {}; return { user: String(k.ssUser || '').trim(), pass: String(k.ssPass || ''), devId: String(k.ssDevId || '').trim(), devPass: String(k.ssDevPass || '') }; };
  const ssSig = () => { const c = ssKeys(); return fp([c.user, c.pass, c.devId, c.devPass].join('\0')); };
  const ssConfigured = () => { const c = ssKeys(); return !!(c.user && c.pass); };
  // (beta.10) ScreenScraper turns away every app without a developer login: the player's own, or this build's (native
  // assets/ss-dev.json, yes / no only). Without one nothing is sent, and the Test says so plainly (as on Windows)
  let ssOwnDev = false; Promise.resolve().then(async () => { try { ssOwnDev = !!(N.ssOwnDev && (await N.ssOwnDev()).has); } catch { ssOwnDev = false; } });
  const ssDevOk = () => !!ssKeys().devId || ssOwnDev;
  const ssEnabled = () => ssConfigured() && ssDevOk() && ssSig() !== ss.bad;
  const ssOn = sysId => !!SS_SYS[sysId] && ssEnabled();
  const ssErr = (code, msg) => Object.assign(new Error(msg), { code });
  const ssPause = (ms, why) => { ss.until = Math.max(ss.until, Date.now() + ms); ss.why = why; };
  const nextUtcDay = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - Date.now() + 60e3; };
  async function ssLimited(fn) { // the account's maxthreads at once, every request spaced to its per-minute rate
    while (ss.active >= ss.threads) await new Promise(r => ss.waiting.push(r));
    ss.active++;
    try { const at = Math.max(Date.now(), ss.lastAt + ss.spacing); ss.lastAt = at; if (at > Date.now()) await sleep(at - Date.now()); return await fn(); }
    finally { ss.active--; const n = ss.waiting.shift(); if (n) n(); }
  }
  function ssLearn(u) { // the account's limits, as each answer reports them (numbers arrive as strings)
    if (!u || typeof u !== 'object') return null;
    const n = k => { const v = parseInt(u[k], 10); return Number.isFinite(v) ? v : null; };
    const th = n('maxthreads'); if (th) ss.threads = Math.max(1, Math.min(th, 4));
    const pm = n('maxrequestspermin'); if (pm) ss.spacing = Math.ceil(60000 / pm);
    const today = n('requeststoday'), max = n('maxrequestsperday');
    if (today != null && max && today >= max) { ssPause(nextUtcDay(), 'quota'); log("ScreenScraper: today's lookups are used up, pausing until tomorrow"); }
    return { left: today != null && max ? Math.max(0, max - today) : null };
  }
  function ssFailure(status, text) { // the HTTP status / body → an error (or null: the answer is fine). Only a few words of the body are looked at
    const t = String(text || '').slice(0, 400), dev = /d[ée]veloppeur|developer|devid/i.test(t);
    if (status === 401) { ssPause(10 * 60e3, 'closed'); return ssErr('closed', SS_MSG.closed); }
    if (status === 403 || /erreur de login|identifiants|login error/i.test(t)) { ss.bad = ssSig(); return ssErr('auth', dev ? 'The ScreenScraper developer login was not accepted' : SS_MSG.auth); }
    if (status === 423) { ssPause(10 * 60e3, 'closed'); return ssErr('closed', 'ScreenScraper is down for now'); }
    if (status === 426) { ssPause(864e5, 'blocked'); return ssErr('blocked', SS_MSG.blocked); }
    if (status === 429) { ssPause(60e3, 'rate'); log('ScreenScraper: rate limited, pausing a minute'); return ssErr('rate', SS_MSG.rate); }
    if (status === 430 || /quota/i.test(t)) { ssPause(nextUtcDay(), 'quota'); log("ScreenScraper: today's lookups are used up, pausing until tomorrow"); return ssErr('quota', SS_MSG.quota); }
    if (status === 431) { ssPause(60 * 60e3, 'quota'); return ssErr('quota', 'ScreenScraper: too many unknown games today'); }
    if (status >= 500) return ssErr('net', 'ScreenScraper answered ' + status);
    return null;
  }
  // one API file → its "response" (null: not found). Throws: nocreds | auth | rate | quota | closed | blocked | net
  async function ssApi(file, q) {
    if (!ssConfigured()) throw ssErr('nocreds', 'No ScreenScraper account');
    if (ssSig() === ss.bad) throw ssErr('auth', SS_MSG.auth);
    if (Date.now() < ss.until) throw ssErr(ss.why || 'rate', SS_MSG[ss.why] || SS_MSG.rate);
    return ssLimited(async () => {
      const p = new URLSearchParams({ output: 'json' }); for (const [k, v] of Object.entries(q || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
      let r; try { r = await N.httpText({ url: `https://api.screenscraper.fr/api2/${file}?${p}`, ss: true, headers: { Accept: 'application/json' } }); } catch { throw ssErr('net', SS_MSG.net); }
      const status = (r && r.status) || 0, text = (r && r.text) || '';
      if (status === 404) return null;
      const f = ssFailure(status, /^\s*\{/.test(text) ? '' : text); if (f) throw f;
      if (status === 400) return null; // (a request it couldn't use: a name with nothing to go on)
      if (status < 200 || status >= 300) throw ssErr('net', 'ScreenScraper answered ' + status);
      if (/non trouv|not found/i.test(text.slice(0, 200)) && !/^\s*\{/.test(text)) return null; // "Erreur : Rom/Iso/Dossier non trouvée !"
      let j; try { j = JSON.parse(text); } catch { throw ssErr('net', 'ScreenScraper sent something unexpected'); }
      const resp = j && j.response; if (!resp || typeof resp !== 'object') return null;
      resp.limits = ssLearn(resp.ssuser); return resp;
    });
  }
  // a media address from an answer, without any sign-in in it; null when it isn't ScreenScraper's
  const SS_CRED = /^(devid|devpassword|softname|ssid|sspassword|output)$/i;
  function ssClean(u) {
    let x; try { x = new URL(String(u || '')); } catch { return null; }
    if (!/^https?:$/.test(x.protocol) || !/(^|\.)screenscraper\.fr$/i.test(x.hostname) || String(u).length > 1500) return null;
    for (const k of [...x.searchParams.keys()]) if (SS_CRED.test(k)) x.searchParams.delete(k);
    x.protocol = 'https:'; return x.toString();
  }
  function ssMediaOf(jeu) {
    const want = new Set(Object.values(SS_MEDIA).flat()), out = [];
    for (const m of Array.isArray(jeu && jeu.medias) ? jeu.medias : []) {
      if (!m || !want.has(String(m.type)) || (m.parent && m.parent !== 'jeu')) continue;
      const url = ssClean(m.url); if (!url) continue;
      out.push({ type: String(m.type), region: String(m.region || '').toLowerCase().slice(0, 8), url }); if (out.length >= 80) break;
    }
    return out;
  }
  async function ssCacheGet() { if (!ss.cache) { const c = await load('ss-cache.json', null); ss.cache = c && c.games && typeof c.games === 'object' ? c : { games: {} }; } return ss.cache; }
  function ssSave() { if (!ss.dirty || !ss.cache) return; clearTimeout(ss.saveT);
    ss.saveT = setTimeout(async () => { await idleTurn(); const now = Date.now(), G = ss.cache.games;
      for (const [k, v] of Object.entries(G)) if (now - v[1] > (v[0] ? 7 : 1) * 864e5) delete G[k];
      const ks = Object.keys(G); if (ks.length > 8000) ks.slice(0, ks.length - 8000).forEach(k => delete G[k]);
      ss.dirty = false; store('ss-cache.json', ss.cache); }, 3000); }
  // the title search's best near match (the Windows rule: the same title, or nearly all the same words; "Pikmin" isn't "Pikmin 2")
  function ssMatch(flat, g) {
    const want = norm(g.title), W = new Set(want.split(' ').filter(Boolean)); let best = null, bs = 0;
    for (const x of flat) { const n = norm(x.name); let s = n === want ? 2 : 0;
      if (!s) { const G = n.split(' ').filter(Boolean); if (G.length && W.size) { let hit = 0; for (const w of G) if (W.has(w)) hit++; const jac = hit / new Set([...W, ...G]).size; if (jac >= .75) s = jac; } }
      if (s > bs) { bs = s; best = x; } }
    return best;
  }
  // which ScreenScraper game a file is, and its media → { id, media } or null. Throws the ssApi errors (offline, paused…)
  async function ssLookup(sysId, g) {
    const sys = SS_SYS[sysId]; if (!sys || !g.file) return null;
    const c = await ssCacheGet(), ck = sysId + '|' + String(g.file).toLowerCase() + '|' + (g.sizeBytes || 0), hit = c.games[ck];
    if (hit && Date.now() - hit[1] < (hit[0] ? 7 : 1) * 864e5) return hit[0] ? { id: hit[0], media: (Array.isArray(hit[2]) ? hit[2] : []).map(m => m && { ...m, url: ssClean(m.url) }).filter(m => m && m.url) } : null;
    const iso = /^(iso|gcm|gcz|rvz|wbfs|wia|ciso|cso|chd|cue|bin|img|gdi|pbp|zso)$/i.test(g.ext || '');
    const q = { systemeid: sys, romtype: iso ? 'iso' : 'rom', romnom: String(g.file).split('/').pop(), romtaille: g.sizeBytes || undefined };
    if (TDB_SYS[sysId] && g.uri) { const id = await discIdOf(g); if (id) q.serialnum = id; }
    let jeu = null; const resp = await ssApi('jeuInfos.php', q);
    if (resp && resp.jeu && resp.jeu.id && String(resp.jeu.id) !== '0') jeu = resp.jeu;
    if (!jeu && g.title) { // by title: ScreenScraper's own search, then only an exact / near title counts
      const s = await ssApi('jeuRecherche.php', { systemeid: sys, recherche: String(g.title).slice(0, 120) });
      const flat = []; for (const x of (s && Array.isArray(s.jeux) ? s.jeux : []).slice(0, 30)) if (x && x.id && Array.isArray(x.noms)) for (const n of x.noms) if (n && n.text) flat.push({ id: x.id, name: String(n.text), jeu: x });
      const m = flat.length ? ssMatch(flat, g) : null;
      if (m) { jeu = m.jeu; if (!Array.isArray(jeu.medias) || !jeu.medias.length) { const r2 = await ssApi('jeuInfos.php', { systemeid: sys, gameid: m.id }); if (r2 && r2.jeu) jeu = r2.jeu; } }
    }
    const out = jeu ? { id: +jeu.id || String(jeu.id), media: ssMediaOf(jeu) } : null;
    c.games[ck] = out ? [out.id, Date.now(), out.media] : [0, Date.now()]; ss.dirty = true; ssSave(); return out;
  }
  // this game's region first, then the world / USA / Europe / Japan prints
  const ssRank = (g, r) => { const k = regionKey(g.region), want = k === 'jpn' ? ['jp', 'wor'] : k === 'eur' ? ['eu', 'uk', 'fr', 'de', 'wor'] : ['us', 'wor'];
    const i = want.indexOf(r); return i >= 0 ? i : r === 'us' ? 6 : r === 'wor' ? 7 : r === 'eu' ? 8 : r === 'jp' ? 9 : 10; };
  // → [{ type, region, url }] of the types asked for, best region first ([] without an account, no match, offline…), plus .unsure
  async function ssPick(sysId, g, types) {
    const out = []; out.unsure = false;
    if (!ssOn(sysId)) return out;
    try { const hit = await ssLookup(sysId, g); if (hit) out.push(...hit.media.filter(m => types.includes(m.type)).sort((a, b) => ssRank(g, a.region) - ssRank(g, b.region))); }
    catch (e) { out.unsure = true; if (e.code !== 'nocreds') log('ScreenScraper:', e.message); } // (our own words, never an address)
    return out;
  }
  async function ssGroup(sysId, g, part) { const L = await ssPick(sysId, g, SS_MEDIA[part] || []); return Object.assign({ urls: L.slice(0, 3).map(m => m.url), ss: true }, { unsure: L.unsure }); }
  // a native download of ScreenScraper media, within the account's limits (paused / no account: "busy", tried again later)
  function ssFetch(o) { if (!ssEnabled() || Date.now() < ss.until) return Promise.resolve({ ok: false, busy: true }); return ssLimited(() => N.fetchArt(Object.assign({}, o, { ss: true }))); }
  function ssCredsChanged() { ss.bad = ''; if (ss.why === 'auth') { ss.until = 0; ss.why = ''; } }
  // Settings → Accounts & services → Test (ScreenScraper and SteamGridDB on Android; RetroAchievements and fanart.tv aren't used here)
  const apiSt = {};
  async function testApi(s) {
    await ready; const at = Date.now();
    if (s === 'screenscraper') {
      if (!ssConfigured()) return (apiSt[s] = { state: 'none', at: 0, msg: 'Not set up' });
      if (!ssDevOk()) return (apiSt[s] = { state: 'fail', at, msg: 'no developer login' }); // (beta.10: not the player's password)
      ssCredsChanged(); if (ss.why !== 'quota' && ss.why !== 'blocked') { ss.until = 0; ss.why = ''; } // a test is a fresh try (a used-up day stays used up)
      try { const r = await ssApi('ssuserInfos.php', {}); apiSt[s] = r && r.ssuser ? { state: 'ok', at, msg: 'Working', left: r.limits ? r.limits.left : null } : { state: 'fail', at, msg: 'not accepted' }; }
      catch (e) { apiSt[s] = { state: 'fail', at, msg: e.code === 'auth' ? (/developer/.test(e.message) ? 'developer login not accepted' : 'not accepted') : e.message }; }
      if (apiSt[s].state === 'ok' && st.config.ui.autoCovers !== false) setTimeout(() => queueArt('setting'), 800); // the account works: backs, spines and discs can come now
      return apiSt[s];
    }
    if (s === 'steamgriddb') {
      const key = sgKey(); if (!key) return (apiSt[s] = { state: 'none', at: 0, msg: 'Not set up' });
      try { const r = await N.httpText({ url: 'https://www.steamgriddb.com/api/v2/search/autocomplete/zelda', headers: { Authorization: 'Bearer ' + key } });
        apiSt[s] = r && r.status === 200 ? { state: 'ok', at, msg: 'Key works' } : r && (r.status === 401 || r.status === 403) ? { state: 'fail', at, msg: 'not accepted' } : { state: 'fail', at, msg: 'SteamGridDB answered ' + (r && r.status) }; }
      catch { apiSt[s] = { state: 'fail', at, msg: "Couldn't reach SteamGridDB" }; }
      return apiSt[s];
    }
    if (s === 'igdb') { // (0.3.1) a tiny query: the native side signs in to Twitch with the saved Client ID + Secret
      if (!igdbOn()) return (apiSt[s] = { state: 'none', at: 0, msg: 'Not set up' });
      try { const r = await N.httpText({ url: 'https://api.igdb.com/v4/games', body: 'fields name; limit 1;', igdb: true });
        apiSt[s] = r && r.status === 200 ? { state: 'ok', at, msg: 'Working' } : r && (r.status === 401 || r.status === 403) ? { state: 'fail', at, msg: 'Client ID or Secret not accepted' } : { state: 'fail', at, msg: 'IGDB answered ' + (r && r.status) }; }
      catch { apiSt[s] = { state: 'fail', at, msg: "Couldn't reach IGDB" }; }
      return apiSt[s];
    }
    return (apiSt[s] = { state: 'fail', at, msg: 'Not used on Android yet' });
  }

  // ---------- Art Studio on Android: the Windows studio's screens (Settings → Art & manuals → Art Studio, or a game's
  // "Change art"), backed by the sources above. Every version of a part, from every source, is listed at once; the small
  // cards then arrive one by one as the native side downloads each version once into the app's cache (two at a time,
  // ScreenScraper's within its limits). Picking one saves it into "Boxshelf Art" with the Windows names (a face cut from a
  // wrap: as a JPEG) and swaps it onto the shelf; the picture it replaced is kept (Undo). "My picture…" is Android's own
  // picture picker. Per-console looks are remembered; LaunchBox's scans, matching sets and re-fetch jobs are Windows-only.
  const LOOKS = ['shelf', 'authentic', 'hd', 'region:usa', 'region:eur', 'region:jpn', 'special'];
  const RW = { usa: 'USA', eur: 'Europe', jpn: 'Japan', world: 'World' };
  const sgOf = id => { const S = art.db.studio.games; return S[id] || (S[id] = { lock: {}, hist: {} }); };
  const styleOf = sysId => art.db.studio.styles[sysId] || { preset: 'authentic', region: 'usa', parts: {} };
  // a release's region as the studio names it ("Japan, USA" is a USA print too)
  const regionKey = r => { r = String(r || '').toLowerCase(); return /usa|world/.test(r) ? 'usa' : /japan/.test(r) ? 'jpn' : /europe|uk|france|germany|spain|italy|australia/.test(r) ? 'eur' : 'usa'; };
  function gameFor(systemId, file) {
    const f = String(file || '').toLowerCase();
    for (const sh of st.library || []) if (sh.id === systemId) for (const g of sh.games || []) if (g.kind === 'rom' && String(g.file).toLowerCase() === f) return g;
    throw new Error("That game isn't on the shelf");
  }
  const artOf = g => { const a = g.art || {}; return { front: a.front || null, back: a.back || null, spine: a.spine || null, disc: a.disc || null }; };
  // the Windows studio's scores: how well a version suits each look (authentic scans, sharpest HD, one region, special editions)
  function scoreOf(c, region) {
    const px = (c.w || 0) * (c.h || 0), hi = Math.min(1, px / (2400 * 3360)), reg = region || 'usa', sg = c.source === 'steamgriddb' ? 100 : c.fan ? 30 : 0; // (fan art, LaunchBox's: never ahead of a real scan)
    const a = (c.kind === 'scan' ? 60 : c.kind === 'hd' ? 42 : 30) + 30 + (c.region === reg ? 10 : 0) + hi * 8;
    return { authentic: Math.round(a - sg), hd: Math.round(hi * 90 + (c.kind === 'hd' ? 10 : 0)), region: Math.round((c.region === reg ? 70 : 0) + 18 + hi * 10 - sg), special: Math.round(40 + hi * 10 + (c.region === reg ? 8 : 0) - sg) };
  }
  // every version of one part → [{ key, url, ss?, cut?, guess?, source, region, edition, kind, label }]
  async function studioCands(sysId, g, part) {
    const out = [], add = (url, o) => { if (!url || out.some(x => x.url === url && (x.cut || '') === (o.cut || ''))) return; out.push(Object.assign({ key: 'k' + fp(url + '|' + (o.cut || '')), id: 'a' + fp(url), url, edition: 'original', region: '' }, o)); };
    if (TDB_SYS[sysId] && g.uri) { const id = await discIdOf(g);
      if (id) { const root = 'https://art.gametdb.com/' + TDB_SYS[sysId], R = tdbRegs(id);
        for (const r of [...R.all, ...(R.all.includes('JA') ? [] : ['JA'])]) { const region = TDB_REG[r] || '', guess = !R.own.includes(r), rw = RW[region] || r;
          if (part === 'front') { add(`${root}/coverHQ/${r}/${id}.png`, { source: 'gametdb', region, kind: 'hd', label: 'HD cover · ' + rw, guess }); add(`${root}/cover/${r}/${id}.png`, { source: 'gametdb', region, kind: 'scan', label: 'Cover · ' + rw, guess }); }
          if (part === 'back' || part === 'spine') for (const k of ['coverfullHQ', 'coverfull']) add(`${root}/${k}/${r}/${id}.png`, { source: 'gametdb', region, kind: k === 'coverfullHQ' ? 'hd' : 'scan', cut: part, label: (part === 'back' ? "From GameTDB's full cover · " : 'Cut from full cover · ') + rw, guess });
          if (part === 'disc') { add(`${root}/disc/${r}/${id}.png`, { source: 'gametdb', region, kind: 'scan', label: 'Disc · ' + rw, guess }); add(`${root}/discM/${r}/${id}.png`, { source: 'gametdb', region, kind: 'clean', label: 'Disc artwork · ' + rw, guess: true }); }
        } } }
    // (0.3.3) LaunchBox: every region's scans, clean rebuilds and fan art (marked), a spine cut from a full box scan
    if (LB_PLAT[sysId]) try { for (const c of await lbStudio(sysId, g, part)) add(c.url, Object.assign({ source: 'launchbox', region: c.region, kind: c.kind, label: c.label }, c.cut ? { cut: c.cut } : {}, c.fan ? { fan: true } : {})); } catch (e) { log('LaunchBox', e && e.message); }
    const cart = sysId === 'n3ds' || sysId === 'sw' || sysId === 'nds' || sysId === 'gba' || sysId === 'gb' || sysId === 'gbc' || sysId === 'snes' || sysId === 'nes' || sysId === 'n64' || sysId === 'megadrive';
    const types = { front: ['box-2D'], back: ['box-2D-back', 'box-texture'], spine: ['box-2D-side', 'box-texture'], disc: ['support-2D'] }[part] || [];
    for (const m of await ssPick(sysId, g, types)) { const region = SS_REGION(m.region), rw = RW[region] || (m.region && m.region !== 'ss' ? m.region.toUpperCase() : '');
      const what = m.type === 'box-2D' ? 'Box front' : m.type === 'box-2D-back' ? 'Box back' : m.type === 'box-2D-side' ? 'Spine' : m.type === 'box-texture' ? 'Cut from full wrap' : cart ? 'Cartridge' : 'Disc';
      add(m.url, { source: 'screenscraper', ss: true, region, kind: 'scan', label: [what, rw].filter(Boolean).join(' · '), ...(m.type === 'box-texture' ? { cut: part } : {}) }); }
    if (part === 'front' && LR[sysId]) for (const n of lrMatches(await lrList(sysId), g)) { const rg = /\((?:[^)]*)?usa/i.test(n) ? 'usa' : /\((?:[^)]*)?(europe|uk|germany|france)/i.test(n) ? 'eur' : /\((?:[^)]*)?japan/i.test(n) ? 'jpn' : /\(world/i.test(n) ? 'world' : '';
      add(`https://thumbnails.libretro.com/${encodeURIComponent(LR[sysId])}/Named_Boxarts/${encodeURIComponent(n + '.png')}`, { source: 'libretro', region: rg, kind: 'clean', label: 'Cover' + (RW[rg] ? ' · ' + RW[rg] : '') }); }
    if (part === 'front' && igdbOn()) try { for (const x of await igdbCovers(sysId, g.title)) add(x.url, { source: 'igdb', kind: 'hd', label: x.label }); } catch (e) { log('IGDB', e && e.message); }
    if (part === 'front') { const key = sgKey(); if (key) try { for (const x of await sgdb(key, g.title, 12)) add(x.url, { source: 'steamgriddb', kind: 'hd', label: x.label }); } catch (e) { log('SteamGridDB', e && e.message); } }
    return out;
  }
  const cands = { gen: 0, lists: {}, got: {}, L: [], J: [] }; // got: this session's downloads, id|cut → { file, thumb, w, h }
  const ckey = (sysId, file, part) => sysId + '|' + String(file || '').toLowerCase() + '|' + part;
  const emitC = e => cands.L.forEach(f => { try { f(e); } catch (x) { console.error(x); } });
  const pub = (c, region, inUse) => ({ key: c.key, source: c.source, region: c.region, edition: c.edition, kind: c.kind, label: c.label, w: c.w || null, h: c.h || null, thumb: c.thumb || null, inUse: !!inUse, score: scoreOf(c, region) });
  // one version downloaded once (the native cache keeps it across visits) → { file, thumb, w, h } or null
  async function candGet(c, shape) {
    const k = c.id + '|' + (c.cut || ''); if (cands.got[k]) return cands.got[k];
    const o = Object.assign({ url: c.url, id: c.id, cut: c.cut || '', maxH: 360 }, shape);
    const r = c.ss ? (ssEnabled() && Date.now() >= ss.until ? await ssLimited(() => N.artCache(Object.assign(o, { ss: true }))) : null) : await N.artCache(o);
    if (!r || !r.thumb || !r.file) return null;
    return (cands.got[k] = { file: r.file, thumb: fileUrl(r.thumb), w: r.w, h: r.h });
  }
  async function candThumbs(gen, sysId, file, part, list, region) {
    const shape = caseShape(sysId), todo = list.filter(c => !c.thumb); let i = 0;
    const one = async () => { while (i < todo.length) { const c = todo[i++], ev = { systemId: sysId, file, part, key: c.key };
      if (gen !== cands.gen) { if (!c.guess) emitC(Object.assign(ev, { failed: true, cancelled: true })); continue; } // a newer list took the downloads over
      let r = null; try { r = await candGet(c, shape); } catch {}
      if (!r) { if (!c.guess) emitC(Object.assign(ev, { failed: true })); continue; }
      Object.assign(c, { thumb: r.thumb, w: r.w, h: r.h });
      emitC(Object.assign(ev, { thumb: r.thumb, w: r.w, h: r.h, score: scoreOf(c, region) }, c.guess ? { cand: pub(c, region) } : {})); } };
    await Promise.all([one(), one()]);
  }
  // a version (or a picked / kept picture: src) into place for one part → the game's art
  async function usePic(sysId, g, part, o) {
    const tree = g.romTree || '', base = baseOf(g.file), name = base + SUFFIX[part];
    const noSave = e => Object.assign(e instanceof Error ? e : new Error(String((e && e.message) || e || "Couldn't save that picture")), { noSave: true }); // (beta.10: nothing changed yet, so it may be tried again)
    const r = await N.saveArt(Object.assign({ src: o.src, tree: saveTree(tree), sub: tree ? subFor(sysId, tree) : '', name, key: sysId, dname: name + '~' + Date.now().toString(36), maxH: DISPLAY_H, cut: o.cut || '' }, caseShape(sysId))).catch(e => { throw noSave(e); });
    if (!r || !r.ok || !r.display) throw noSave(new Error("Couldn't save that picture"));
    if (r.saved === 'folder' && tree) { const m = art.folders[tree + '|' + (tree ? subFor(sysId, tree) : '')]; if (m && r.name) m.set(String(r.name).toLowerCase(), r.file); }
    const S = sgOf(g.id), prev = (art.db.games[g.id] || {})[part] || null;
    if (!o.undo) { const H = S.hist[part] = S.hist[part] || []; H.push({ rec: prev, old: r.old || null }); if (H.length > 10) { const h0 = H.shift(); if (h0) trashRec(h0.rec); } } // (beta.10: the copy the history lets go is tidied too)
    if (!o.set) delete lastSet[g.id]; // (a change of its own after a set: Undo set no longer applies)
    applyRec(g, part, { d: r.display, f: r.file || '', w: r.saved || '', h: DISPLAY_H }); delete art.db.miss[g.id + '|' + part];
    if (part === 'back' || part === 'spine') delete art.db.miss[g.id + '|wrap'];
    return artOf(g);
  }
  async function useCand(sysId, g, part, c) {
    const got = await candGet(c, caseShape(sysId)); if (!got) throw new Error("That version couldn't be downloaded");
    return useGot(sysId, g, part, c, got, {});
  }
  // (beta.10) a version downloaded earlier this session whose cached file the native cache has since let go (trimCache keeps
  // 300): that download is forgotten and the version fetched again, once, instead of failing with "Couldn't save that picture"
  async function useGot(sysId, g, part, c, got, o) {
    try { return await usePic(sysId, g, part, Object.assign({ src: got.file, cut: c.cut }, o)); }
    catch (e) { const k = c.id + '|' + (c.cut || ''); if (!(e && e.noSave) || cands.got[k] !== got) throw e;
      delete cands.got[k]; const again = await candGet(c, caseShape(sysId)); if (!again) throw e;
      if (again.thumb) Object.assign(c, { thumb: again.thumb, w: again.w, h: again.h });
      return usePic(sysId, g, part, Object.assign({ src: again.file, cut: c.cut }, o)); }
  }
  // ----- matching sets (0.3.3; the PC's main/artstudio.js buildSets): front, back, spine and disc that belong together -----
  // One source and region with all four parts (LaunchBox / GameTDB / ScreenScraper), the best of each source in one region,
  // and the sharpest HD set. Never SteamGridDB posters, fan art, or a guessed address that hasn't come down yet. The spine
  // comes from the same full scan as the back when there is one.
  const SET_SRC = { launchbox: 'LaunchBox', gametdb: 'GameTDB', screenscraper: 'ScreenScraper' }, REG_NAME = { usa: 'USA', eur: 'Europe', jpn: 'Japan' };
  const setsMemo = {}, lastSet = {};
  const setUsable = c => c.source !== 'steamgriddb' && !c.fan && !c.failed && !(c.guess && !c.thumb);
  const regOk = (c, R, strict) => c.region === R || (!strict && (!c.region || c.region === 'world'));
  async function partLists(sysId, g, fresh) { const L = {};
    for (const p of PARTS) { const k = ckey(sysId, g.file, p); L[p] = (!fresh && cands.lists[k]) || (cands.lists[k] = await studioCands(sysId, g, p));
      for (const c of L[p]) { const got = cands.got[c.id + '|' + (c.cut || '')]; if (got && !c.thumb) Object.assign(c, { thumb: got.thumb, w: got.w, h: got.h }); } } // (versions already down this session keep their pictures)
    return L; }
  function buildSets(g, L) {
    const own = regionKey(g.region), out = [], seen = new Set();
    const best = (p, R, sk, pred, parts) => { let pool = L[p].filter(c => setUsable(c) && pred(c, p)); if (!pool.length) return null;
      if (p === 'spine' && parts.back && parts.back.cut) { const same = pool.filter(c => c.cut && c.url === parts.back.url); if (same.length) pool = same; }
      return pool.slice().sort((a, b) => scoreOf(b, R)[sk] - scoreOf(a, R)[sk])[0]; };
    const add = (id, label, R, src, hd, pred) => { const parts = {}, sk = hd ? 'hd' : 'region';
      for (const p of PARTS) { const c = best(p, R || own, sk, pred, parts); if (!c) return; parts[p] = c; }
      const sig = PARTS.map(p => parts[p].key).join('|'); if (seen.has(sig) && !hd) return; seen.add(sig); // (the HD set stays even when a region set has the same four)
      out.push({ id, label: label + ' · complete', region: R || '', source: src, hd: !!hd, same: !!(parts.back.cut && parts.spine.cut && parts.back.url === parts.spine.url), parts }); };
    for (const R of ['usa', 'eur', 'jpn'].sort((a, b) => (b === own) - (a === own))) { // the copy you own first
      for (const src of Object.keys(SET_SRC)) add(`${R}-${src}`, `${REG_NAME[R]} · ${SET_SRC[src]}`, R, src, false, (c, p) => c.source === src && regOk(c, R, p !== 'disc'));
      add(`${R}-mixed`, `${REG_NAME[R]} · best of each source`, R, 'mixed', false, (c, p) => regOk(c, R, p !== 'disc'));
    }
    add('hd', 'HD', '', 'mixed', true, () => true);
    return out.sort((a, b) => (b.source !== 'mixed') - (a.source !== 'mixed') || b.same - a.same);
  }
  const setView = (s, g) => ({ id: s.id, label: s.label, region: s.region, source: s.source, hd: s.hd, same: s.same, parts: Object.fromEntries(PARTS.map(p => [p, pub(s.parts[p], regionKey(g.region))])) });
  // a whole set into place: all four downloaded first (nothing changes if one can't be had), each part your pick; Undo set puts all four back
  async function applySet(sysId, g, set) {
    const shape = caseShape(sysId), got = await Promise.all(PARTS.map(p => candGet(set.parts[p], shape).catch(() => null)));
    const miss = PARTS.filter((p, i) => !got[i]); if (miss.length) throw new Error(`The ${miss.join(' and ')} of that set couldn't be downloaded. Nothing was changed.`);
    const S = sgOf(g.id), prev = JSON.parse(JSON.stringify(S.lock || {})), done = [];
    try { for (let i = 0; i < PARTS.length; i++) { const p = PARTS[i]; await useGot(sysId, g, p, set.parts[p], got[i], { set: true }); S.lock[p] = { look: 'exact', key: set.parts[p].key }; done.push(p); } }
    catch (e) { // all four or none: the parts already in go back as they were
      for (const p of done) { const H = S.hist[p] || [], h = H[H.length - 1]; if (!h) continue; try { if (h.old) await usePic(sysId, g, p, { src: h.old, undo: true, set: true }); else applyRec(g, p, h.rec); } catch {} H.pop(); trashRec(h.rec); }
      S.lock = prev; saveArt(); throw new Error(`That set couldn't be put in (${e && e.message}). Nothing was changed.`);
    }
    saveArt(); return { prev, len: Object.fromEntries(PARTS.map(p => [p, (S.hist[p] || []).length])) }; // (len: Undo set checks nothing came after it)
  }

  // ----- a console's look, applied (0.3.3): choosing a shelf style in Art Studio re-picks its games' art in the background -----
  // Complete sets (one region, or HD) put in a whole matching set where a game has one, else each part by that look; the other
  // looks pick each part's best version. A game you locked, and a part you picked yourself, stay as they are. One game at a
  // time, in quiet moments; the progress goes to Settings as art:job events; Stop (artCancel) ends it after the game in hand.
  const jobs = {};
  const jobView = j => ({ id: j.id, systemId: j.sysId, label: j.label, done: j.done, total: j.total, state: j.state, msg: j.msg || '', kept: j.kept || 0, sets: { set: j.sets || 0 } });
  const emitJob = j => { const v = jobView(j); cands.J.forEach(f => { try { f(v); } catch (e) { console.error(e); } }); };
  const lookFor = (style, part) => style.preset === 'sets' ? (style.setsHd ? 'hd' : 'region:' + (style.region || 'usa')) : style.preset === 'mix' ? ((style.parts || {})[part] || 'authentic') : style.preset === 'region' ? 'region:' + (style.region || 'usa') : (style.preset || 'authentic');
  const skOf = l => l === 'hd' ? 'hd' : String(l).startsWith('region') ? 'region' : l === 'special' ? 'special' : 'authentic';
  function startRestyle(sysId, style, label) {
    for (const j of Object.values(jobs)) if (j.sysId === sysId && j.state === 'run') j.c = true; // a newer look for the same console takes over
    const sh = (st.library || []).find(s => s.id === sysId), games = ((sh && sh.games) || []).filter(g => g.kind === 'rom');
    const id = 'j' + Date.now().toString(36) + (++startRestyle.n), j = jobs[id] = { id, sysId, label, done: 0, total: games.length, state: 'run', kept: 0, sets: 0, c: false };
    (async () => {
      emitJob(j);
      for (const g of games) {
        if (j.c) break;
        await idleTurn(); if (j.c) break;
        const S = art.db.studio.games[g.id];
        const own = p => !!(S && S.lock && S.lock[p] && S.lock[p].look === 'exact'); // a part you picked
        if (S && S.frozen) { j.kept++; j.done++; emitJob(j); continue; }
        try {
          const L = await partLists(sysId, g), todo = PARTS.filter(p => !own(p) && (L[p] || []).length);
          let done = new Set();
          if (style.preset === 'sets' && todo.length === 4) {
            const R = style.region || 'usa', sets = buildSets(g, L);
            const set = style.setsHd ? sets.find(s => s.hd) : sets.find(s => s.region === R && s.source !== 'mixed') || sets.find(s => s.region === R);
            if (set) { const A = sgOf(g.id), auto = A.auto = A.auto || {};
              if (PARTS.some(p => auto[p] !== set.parts[p].key)) { await applySet(sysId, g, set); for (const p of PARTS) { A.lock[p] = null; auto[p] = set.parts[p].key; } } // (a look's choice, not your pick)
              j.sets++; done = new Set(PARTS); }
          }
          for (const p of todo) { if (done.has(p) || j.c) continue;
            const look = lookFor(style, p), reg = String(look).startsWith('region:') ? look.slice(7) : regionKey(g.region), sk = skOf(look);
            const c = L[p].filter(x => !(x.guess && !x.thumb) && !x.failed).sort((a, b) => scoreOf(b, reg)[sk] - scoreOf(a, reg)[sk])[0]; if (!c) continue;
            const A = sgOf(g.id), auto = A.auto = A.auto || {}; if (auto[p] === c.key) continue; // already the one this look picks
            try { await useCand(sysId, g, p, c); auto[p] = c.key; A.lock[p] = null; } catch (e) { log('restyle', g.title, p, e && e.message); }
          }
          saveArt();
        } catch (e) { log('restyle', g.title, e && e.message); }
        j.done++; emitJob(j);
      }
      j.state = j.c ? 'cancelled' : 'done'; emitJob(j); saveArt(true);
      if (!j.c) shelfToast(`${(sh && sh.name) || 'Console'}: ${label.replace(/^Re-fetching /, '')} done${j.sets ? ` · ${j.sets} complete set${j.sets === 1 ? '' : 's'}` : ''}`);
    })();
    return j.id;
  }
  startRestyle.n = 0;

  const studioApi = {
    artStudio: async () => { await ready;
      const consoles = (st.library || []).filter(sh => sh.kind === 'console' && (sh.games || []).some(g => g.kind === 'rom')).map(sh => { const L = sh.games.filter(g => g.kind === 'rom'), S = art.db.studio.games;
        return { id: sh.id, name: sh.name, total: L.length, style: JSON.parse(JSON.stringify(styleOf(sh.id))), locked: L.filter(g => S[g.id] && (S[g.id].frozen || PARTS.some(p => S[g.id].lock[p]))).length,
          frozen: L.filter(g => S[g.id] && S[g.id].frozen).length, kept: 0, job: null }; });
      return { consoles, looks: LOOKS.slice(1) }; },
    artGames: async ({ systemId }) => { await ready; const sh = (st.library || []).find(s => s.id === systemId); if (!sh) throw new Error('Unknown console');
      return (sh.games || []).filter(g => g.kind === 'rom').map(g => { const S = art.db.studio.games[g.id];
        return { file: g.file, title: g.title, region: regionKey(g.region), art: artOf(g), low: {}, lock: JSON.parse(JSON.stringify((S && S.lock) || {})), frozen: !!(S && S.frozen) }; }); },
    // (0.3.3) the look is applied: a background job re-picks the console's games (Complete sets: whole matching sets, one region or HD)
    artStyle: async ({ systemId, style }) => { await ready; const s = style || {};
      const v = art.db.studio.styles[systemId] = Object.assign({ preset: String(s.preset || 'authentic'), region: String(s.region || 'usa'), parts: Object.assign({}, s.parts || {}) }, s.preset === 'sets' ? { setsHd: !!s.setsHd } : {}); saveArt();
      const sh = (st.library || []).find(x => x.id === systemId), jobId = startRestyle(systemId, v, `Re-fetching ${(sh && sh.name) || systemId}`);
      return { style: JSON.parse(JSON.stringify(v)), jobId, note: 're-picking its art in the background' }; },
    artSets: async ({ systemId, file }) => { await ready; const g = gameFor(systemId, file), sets = buildSets(g, await partLists(systemId, g, true)); // (fresh, as the PC's)
      setsMemo[g.id] = sets;
      const todo = [], seen = new Set(); for (const s of sets) for (const p of PARTS) { const c = s.parts[p]; if (!c.thumb && !seen.has(c.key)) { seen.add(c.key); todo.push([p, c]); } }
      setTimeout(async () => { const shape = caseShape(systemId); let i = 0; // the sets' small pictures, two at a time
        const one = async () => { while (i < todo.length) { const [p, c] = todo[i++]; let r = null; try { r = await candGet(c, shape); } catch {}
          if (r) Object.assign(c, { thumb: r.thumb, w: r.w, h: r.h }); else c.failed = true;
          emitC(Object.assign({ systemId, file, part: p, key: c.key, set: true }, r ? { thumb: r.thumb, w: r.w, h: r.h } : { failed: true })); } };
        await Promise.all([one(), one()]); }, 0);
      return { sets: sets.map(s => setView(s, g)) }; },
    artUseSet: async ({ systemId, file, setId }) => { await ready; const g = gameFor(systemId, file);
      let set = (setsMemo[g.id] || []).find(s => s.id === setId); if (!set) set = buildSets(g, await partLists(systemId, g)).find(s => s.id === setId);
      if (!set) throw new Error('That set is no longer offered. Open the sets again.');
      lastSet[g.id] = await applySet(systemId, g, set);
      return { art: artOf(g), lock: JSON.parse(JSON.stringify(sgOf(g.id).lock)), changed: PARTS.slice() }; },
    artUndoSet: async ({ systemId, file }) => { await ready; const g = gameFor(systemId, file), m = lastSet[g.id]; if (!m) throw new Error('Nothing to undo');
      const S = sgOf(g.id);
      if (m.len && PARTS.some(p => (S.hist[p] || []).length !== m.len[p])) { delete lastSet[g.id]; throw new Error('Something changed since that set went in. Undo it one part at a time.'); }
      for (const p of PARTS) { const H = S.hist[p] || [], h = H[H.length - 1]; if (!h) continue;
        if (h.old) await usePic(systemId, g, p, { src: h.old, undo: true }); else applyRec(g, p, h.rec); H.pop(); trashRec(h.rec); } // (beta.10: tidied unless in use again)
      S.lock = m.prev || {}; delete lastSet[g.id]; saveArt();
      return { art: artOf(g), lock: JSON.parse(JSON.stringify(S.lock)) }; },
    // (0.3.1) the free sources that could add versions of this part but aren't set up: Art Studio's "More art sources" card
    // (beta.12: ScreenScraper offered for every part, the front too: it has fronts for most consoles)
    artSourcesMissing: (systemId, part) => [LB_PLAT[systemId] && !lbHas(systemId) && 'LaunchBox', !ssConfigured() && 'ScreenScraper', ...(part === 'front' ? [!sgKey() && 'SteamGridDB', !igdbOn() && 'IGDB'] : [])].filter(Boolean),
    // (0.3.3) the LaunchBox database on the device: Settings' "Refresh art database" row and Art Studio's "build the index" ask
    artBuildIndex: () => lbBuild(),
    artRefreshIndex: () => lbBuild(),
    artRefreshCancel: async () => { if (N.lbCancel) await N.lbCancel(); return true; },
    artIndexInfo: async () => { await lbMeta(); return lbInfo(); },
    onArtIndex: fn => { lb.L.push(fn); return () => { const i = lb.L.indexOf(fn); if (i >= 0) lb.L.splice(i, 1); }; },
    artCandidates: async ({ systemId, file, part }) => { await ready; const gen = ++cands.gen;
      if (!PARTS.includes(part)) throw new Error('Unknown part');
      const g = gameFor(systemId, file), region = regionKey(g.region), list = await studioCands(systemId, g, part), S = art.db.studio.games[g.id], lk = S && S.lock[part];
      for (const c of list) { const got = cands.got[c.id + '|' + (c.cut || '')]; if (got) Object.assign(c, { thumb: got.thumb, w: got.w, h: got.h }); }
      cands.lists[ckey(systemId, file, part)] = list;
      const cur = g.art && g.art[part] ? [{ key: 'current', source: 'current', region: '', edition: 'original', kind: 'scan', label: 'Current picture', thumb: g.art[part], w: null, h: null, inUse: true, score: { authentic: 0, hd: 0, region: 0, special: 0 } }] : [];
      const out = cur.concat(list.filter(c => !c.guess || c.thumb).map(c => pub(c, region, !cur.length && lk && lk.key === c.key)));
      if (gen === cands.gen) setTimeout(() => candThumbs(gen, systemId, file, part, list, region), 0);
      return { list: out, index: 'ready' }; },
    artUse: async ({ systemId, file, part, key }) => { await ready; const g = gameFor(systemId, file);
      if (key === 'current') return { art: artOf(g) };
      const c = (cands.lists[ckey(systemId, file, part)] || []).find(x => x.key === key); if (!c) throw new Error("That version isn't in the list any more");
      const a = await useCand(systemId, g, part, c); sgOf(g.id).lock[part] = { look: 'exact', key }; saveArt(); return { art: a }; },
    artMix: async ({ systemId, file, part, look }) => { await ready; const g = gameFor(systemId, file), S = sgOf(g.id);
      if (look === 'shelf') { S.lock[part] = null; saveArt(); return { art: artOf(g), key: null }; }
      const reg = String(look).startsWith('region:') ? look.slice(7) : regionKey(g.region), sk = look === 'hd' ? 'hd' : String(look).startsWith('region') ? 'region' : look === 'special' ? 'special' : 'authentic';
      const list = cands.lists[ckey(systemId, file, part)] || (cands.lists[ckey(systemId, file, part)] = await studioCands(systemId, g, part));
      for (const c of list.slice().sort((a, b) => scoreOf(b, reg)[sk] - scoreOf(a, reg)[sk]).slice(0, 5)) {
        try { const a = await useCand(systemId, g, part, c); S.lock[part] = { look, key: c.key }; saveArt(); return { art: a, key: c.key }; } catch {} }
      throw new Error('No version found for that look'); },
    artUndo: async ({ systemId, file, part }) => { await ready; const g = gameFor(systemId, file), S = sgOf(g.id), H = S.hist[part] || [], h = H[H.length - 1];
      if (!h || (!h.old && !h.rec)) throw new Error('Nothing to undo');
      let a; if (h.old) a = await usePic(systemId, g, part, { src: h.old, undo: true }); else { applyRec(g, part, h.rec); a = artOf(g); }
      H.pop(); trashRec(h.rec); S.lock[part] = { look: 'exact' }; saveArt(); return { art: a, lock: S.lock[part] }; },
    artLock: async ({ systemId, file, lock }) => { await ready; const g = gameFor(systemId, file), S = sgOf(g.id); S.frozen = !!lock; saveArt();
      if (!lock) setTimeout(() => queueArt('unlock'), 500); // anything missing follows the shelf again
      return { frozen: S.frozen, lock: JSON.parse(JSON.stringify(S.lock)), repick: 0, jobId: null }; },
    // "My picture…": Android's picture picker (the page never sees a path); cut: a whole box opened flat, the spine cut from it
    artOwn: async ({ systemId, file, part, cut }) => { await ready; const g = gameFor(systemId, file);
      if (!PARTS.includes(part)) throw new Error('Unknown part'); if (cut && part !== 'spine') throw new Error('Only a spine can be cut');
      const p = await N.pickImage(); if (!p || p.canceled || !p.uri) return { canceled: true };
      const a = await usePic(systemId, g, part, { src: p.uri, cut: cut ? 'spine' : '' }); const S = sgOf(g.id); S.lock[part] = { look: 'exact', key: 'own' }; saveArt();
      return { art: a, lock: S.lock[part] }; },
    artCancel: async ({ jobId } = {}) => { const j = jobs[jobId]; if (j && j.state === 'run') j.c = true; return { ok: !!j }; }, // (a console look's re-pick stops after the game in hand)
    onArtCand: fn => { cands.L.push(fn); return () => { const i = cands.L.indexOf(fn); if (i >= 0) cands.L.splice(i, 1); }; },
    onArtJob: fn => { cands.J.push(fn); return () => { const i = cands.J.indexOf(fn); if (i >= 0) cands.J.splice(i, 1); }; }, // (no re-fetch jobs on Android)
    // the quick menu's art button where there's no studio: a picture of your own for the front
    chooseArt: async id => { await ready; for (const sh of st.library || []) for (const g of sh.games || []) if (g.id === id && g.kind === 'rom') {
      const r = await studioApi.artOwn({ systemId: sh.id, file: g.file, part: 'front' }); return r && r.canceled ? { ok: false, canceled: true } : { ok: true }; }
      return { ok: false }; }
  };

  // Settings → Art & manuals on Android: the toggles say what happens here, and "Download box art now" (Windows' planner)
  // becomes "Fetch missing art now" with the progress under it
  // "Where art is saved" (asked in the setup wizard too): beside the games, or only inside Boxshelf
  // where each kind of picture comes from (Accounts & services, and the setup wizard's full case art question)
  const ART_HELP = 'Box art: libretro (no account) only has front covers. Backs, spines and discs come from GameTDB for GameCube and Wii (no account), or from a ScreenScraper account for every other console. You can also copy your PC\'s ROMS\\<console>\\covers folders onto this device, next to the games: Boxshelf uses those pictures as they are.';
  const whereRow = () => { const S = window.Settings; if (!S || !S.bindv) return null;
    return Object.assign({ t: 'choice', label: 'Where box art is saved', opts: [['roms', 'Next to my ROMs'], ['app', 'Inside Boxshelf']],
      info: 'Next to my ROMs: a "Boxshelf Art" folder in each games folder; it stays with your games and is used again if you reinstall Boxshelf. Inside Boxshelf: private to the app and removed when you uninstall it; nothing is written into your games folders. Art already in a "Boxshelf Art" folder is used either way.',
      keys: 'art folder save location storage roms' }, S.bindv('ui.artWhere', 'roms')); };
  // the LaunchBox database row: says the size before anything comes down, shows the download and sorting, can stop (a
  // stopped download picks up where it left off)
  const mbOf = b => b > 0 ? (b / 1048576).toFixed(b < 10485760 ? 1 : 0) : '0';
  const lbSub = () => { const p = lb.prog;
    if (lb.job) return { cls: 'warn', text: !p || p.phase === 'start' ? 'Starting…' : p.phase === 'download' ? `Downloading… ${mbOf(p.got)} of ${mbOf(p.total)} MB · ${p.pct || 0}%` : p.phase === 'read' ? `Sorting it by console… ${p.pct || 0}%` : 'Finishing…' };
    const i = lbInfo(); if (i.state !== 'ready') return { text: `Not downloaded yet · about ${LB_MB} MB` };
    return { text: `Ready · ${i.plats} console${i.plats === 1 ? '' : 's'} · built ${new Date(i.at).toLocaleDateString()}` + (i.missing ? ` · ${i.missing} new console${i.missing === 1 ? '' : 's'}: Refresh` : ''), cls: i.missing ? 'warn' : '' }; };
  const lbRow = () => ({ t: 'action', label: 'LaunchBox art database', btn: () => lb.job ? 'Stop' : lbInfo().state === 'ready' ? 'Refresh' : `Download · ${LB_MB} MB`, sub: lbSub, keys: 'launchbox database art box scans back spine disc download region',
    info: `The biggest set of real box scans: fronts, backs, spines and discs in every region, from the LaunchBox Games Database (thanks, LaunchBox). One download of about ${LB_MB} MB, sorted on this device for the consoles on your shelves; after that only the pictures you use come down. Refresh it now and then (or when you add a console) for newer scans.`,
    run: () => { if (lb.job) return studioApi.artRefreshCancel();
      lbBuild().then(() => shelfToast('LaunchBox art database ready'), e => { const m = String((e && e.message) || e); shelfToast(/cancel/i.test(m) ? 'Stopped · it picks up where it left off next time' : m); }); } });
  window.BS_SETTINGS_PATCH = (sections, h) => {
    const sec = sections.find(s => s && s.id === 'art'); if (!sec) return sections;
    const rows = [], bind = (h && h.bind) || (window.Settings && Settings.bindb);
    for (const r of sec.rows.filter(r => !(r && r.label === 'Art library folder'))) {
      if (r && r.label === 'Fetch box art for new games') {
        rows.push(Object.assign(r, { label: 'Fetch box art automatically', d: true, // on by default here
          info: 'Front covers for every game (and discs and full box art where a source has them), in the background while the shelf is quiet. Saved where "Where box art is saved" says, and never downloaded twice. Searching sends game file names to GameTDB and libretro (and ScreenScraper with your account).' }));
        if (bind) rows.push(Object.assign({ t: 'toggle', label: 'Full box art (backs & spines)', keys: 'full box art back spine wrap case cover',
          info: 'Backs and spines for the cases too, so they look complete when you turn them around: GameCube and Wii from GameTDB\'s full covers (cut into back, spine and front), every other console with a ScreenScraper account (Accounts & services). The whole cover is kept as "<game>-full" beside the others.' }, bind('ui.fullArt', true)));
        if (bind) rows.push(Object.assign({ t: 'toggle', label: 'Show download progress', keys: 'progress fetching art card corner download status',
          info: 'A small card in the corner of the shelf while box art is being fetched: how many are done, the games being looked up, and a thin bar. It fades away when the run is over.' }, bind('ui.artProgress', true)));
        continue; }
      if (r && r.label === 'Fetch manuals for new games') {
        rows.push(Object.assign(r, { label: 'Fetch manuals automatically', keys: 'manual booklet instructions automatic',
          info: 'Manuals for the consoles switched on below, in the background while the shelf is quiet: each game\'s manual from the Internet Archive (archive.org), as pages you read in Inspect. Saved in a "Boxshelf Manuals" folder beside the games and never downloaded twice. Manuals copied over from the PC (its "covers" or "manuals" folders) are used as they are, whatever is switched on here.' }));
        if (bind) for (const sh of (st.library || []).filter(s => s && s.kind === 'console' && (s.games || []).length)) {
          const b = bind('ui.manual_' + sh.id, false), set0 = b.set; b.set = v => { set0(v); if (v) setTimeout(() => manQueue('settings'), 1500); }; // switched on: its manuals start coming (with automatic on)
          rows.push(Object.assign({ t: 'toggle', label: `Manuals: ${sh.name}`, keys: 'manual booklet console ' + sh.name, info: `Fetch the manuals of your ${sh.name} games (${sh.games.length}).` }, b)); }
        continue; }
      if (r && r.label === 'Download manuals now') { rows.push({ t: 'action', label: 'Download manuals now', btn: () => man.running ? 'Fetching…' : 'Download',
        info: 'Looks for every missing manual of the consoles switched on above, including games nothing was found for last time.', run: () => api.manualsNow(), sub: manSub, keys: 'manual booklet download' }); continue; }
      if (r && /^Manuals by console/.test(r.label || '')) continue; // (choosing between every version found: the PC's Manual Studio)
      if (r && r.label === 'Download box art now') { const w = whereRow(); if (w) rows.push(w);
        rows.push({ t: 'action', label: 'Fetch missing art now', btn: () => art.running ? 'Fetching…' : 'Fetch',
          info: 'Looks again for every missing picture (covers, discs, backs and spines), including ones nothing was found for last time.', run: () => api.artFetchNow(), sub: artSub, keys: 'covers box art download missing back spine' }); continue; }
      rows.push(r); }
    sec.rows = rows;
    // (beta.9) Games → Ports & custom APKs: switch on the installed apps that are games (ports, recomps, a custom APK) and
    // they get a Custom shelf of their own, off the Apps shelf. One switch per app, saved with the rest of Settings
    const con = sections.find(s => s && s.id === 'consoles');
    if (con && h && h.M && bind) {
      const P = { list: null, loading: false };
      const load = () => { if (P.list || P.loading) return; P.loading = true;
        api.androidApps().then(L => { P.list = L || []; }).catch(() => { P.list = []; }).finally(() => { P.loading = false; if (window.Settings && Settings.repaint) Settings.repaint(); }); };
      const appRows = () => { load(); if (!P.list) return [{ t: 'action', label: 'Looking for your apps…', btn: '', ns: true, run: () => {} }];
        if (!P.list.length) return [{ t: 'action', label: 'No apps found', btn: '', ns: true, run: () => {} }];
        return P.list.map(a => Object.assign({ t: 'toggle', label: a.label, keys: 'port ports apk recomp custom app ' + a.label, rescan: true, ns: true,
          info: `Puts ${a.label} on the Custom shelf (and off the Apps shelf). It starts like any app; nothing on the device is changed.` }, bind('portsOn.' + portKey(a.pkg), false))); };
      const page = h.M('Ports & custom APKs', 'android-ports', 'Ports, recomps and games you installed as an APK, on a Custom shelf of their own.',
        'Switch on the apps that are games. They get a case on the Custom shelf, like your consoles\' games, and leave the Apps shelf.', [{ t: 'dyn', fn: appRows }],
        { keys: 'port ports apk apks recomp recomps custom shelf android games add', sub: () => { const n = Object.values(st.config.portsOn || {}).filter(Boolean).length; return { text: n ? `${n} on the Custom shelf` : 'None yet' }; } });
      con.rows = [...con.rows, { t: 'head', text: 'Ports & custom APKs' }, page];
    }
    const acct = sections.find(s => s && s.id === 'acct'); // (keys live in Boxshelf's private storage here, not Windows' encrypted store)
    if (acct) acct.lead = 'Sign-ins and keys that add extra art and features. Kept in Boxshelf\'s private storage on this device. ' + ART_HELP;
    // IGDB (0.3.1, Android): official HD covers in Art Studio, with a free Twitch developer app's Client ID + Secret
    const S_ = window.Settings;
    if (acct && S_ && S_.bindv) {
      const at = acct.rows.findIndex(r => r && r.status === 'screenscraper'), ig = [
        { t: 'head', text: 'IGDB' },
        Object.assign({ t: 'text', label: 'IGDB Client ID', info: 'Official HD covers (up to 1080p) for most games, offered in Art Studio on the Front. Free: sign in at dev.twitch.tv with a Twitch account, Your Console → Applications → Register (any name; OAuth redirect http://localhost; category Application Integration), then copy its Client ID here and make a New Secret for the next line.', ph: 'Not set', keys: 'igdb twitch client id covers hd art studio' }, S_.bindv('keys.igdbId', ''), { d: undefined }),
        Object.assign({ t: 'text', label: 'IGDB Client Secret', info: 'The Secret of the same Twitch app. Kept in Boxshelf\'s private storage on this device and only ever sent to Twitch, to sign in for IGDB.', secret: true, ph: 'Not set', keys: 'igdb twitch secret' }, S_.bindv('keys.igdbSecret', ''), { d: undefined }),
        { t: 'action', label: 'Test IGDB', btn: 'Test', info: 'Signs in with the Client ID and Secret and asks IGDB one question.', run: () => api.testApi('igdb').then(() => S_.repaint && S_.repaint()), sub: () => apiSt.igdb ? { text: apiSt.igdb.msg, cls: apiSt.igdb.state === 'ok' ? '' : 'warn' } : null, keys: 'igdb test' }];
      acct.rows.splice(at < 0 ? acct.rows.length : at + 1, 0, ...ig);
    }
    // LaunchBox (0.3.3): one row in Accounts & services and in Art & manuals (where "More art sources" and box art lead)
    if (acct) acct.rows.push({ t: 'head', text: 'LaunchBox' }, lbRow());
    const fetchAt = sec.rows.findIndex(r => r && r.label === 'Fetch missing art now'); sec.rows.splice(fetchAt < 0 ? sec.rows.length : fetchAt + 1, 0, lbRow());
    const walk = rows => (rows || []).forEach(r => { if (!r || typeof r !== 'object') return; if (typeof r.info === 'string') r.info = r.info.replace('Stored encrypted.', 'Kept in Boxshelf\'s private storage on this device.'); for (const k of Object.keys(r)) if (Array.isArray(r[k])) walk(r[k]); });
    sections.forEach(sec => sec && walk(sec.rows)); // (Windows encrypts saved keys; here they're plain text in the app's private storage)
    return sections;
  };

  // ---------- one main ROMs folder: its sub folders → consoles ----------
  // Most people keep one ROMs folder with a folder per console (ES-DE, RetroArch, Daijisho and the Thor's own layout all
  // do). One pick of that folder is enough: each sub folder is matched to a console by its name (gc, GameCube, "PS2 ROMs",
  // "Nintendo 64"…) and, when the name says nothing, by the games inside (only when their file types fit one console).
  // Android's permission for the picked folder covers its sub folders, so nothing else has to be picked.
  const fkey = n => String(n || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '').replace(/^(roms?|games?)(?=.)/, '').replace(/(roms?|games?)$/, '');
  let folderNames = null; // built on first use (the alias list further down must exist by then)
  const FOLDER_NAMES_ = () => folderNames || (folderNames = (() => {
    const m = {}, add = (id, ...names) => { if (sysById[id]) for (const n of names) { const k = fkey(n); if (k && !(k in m)) m[k] = id; } };
    add('gc', 'gc', 'gamecube', 'ngc', 'nintendo gamecube'); add('wii', 'wii', 'nintendo wii'); add('wiiu', 'wiiu', 'wii u', 'nintendo wii u');
    add('sw', 'switch', 'nsw', 'sw', 'nintendo switch'); add('n3ds', 'n3ds', '3ds', 'nintendo 3ds'); add('nds', 'nds', 'ds', 'nintendo ds');
    add('psx', 'psx', 'ps1', 'psone', 'playstation', 'playstation 1', 'sony playstation'); add('ps2', 'ps2', 'playstation 2', 'sony playstation 2');
    add('psp', 'psp', 'playstation portable', 'sony psp'); add('n64', 'n64', 'nintendo 64'); add('snes', 'snes', 'sfc', 'super famicom', 'super nintendo', 'super nes');
    add('nes', 'nes', 'fc', 'famicom', 'nintendo entertainment system'); add('gba', 'gba', 'game boy advance', 'gameboy advance'); add('gbc', 'gbc', 'game boy color', 'gameboy color');
    add('gb', 'gb', 'game boy', 'gameboy'); add('megadrive', 'genesis', 'megadrive', 'mega drive', 'md', 'sega genesis', 'sega mega drive', 'megadrive genesis');
    add('saturn', 'saturn', 'sega saturn'); add('dreamcast', 'dreamcast', 'dc', 'sega dreamcast'); add('mastersystem', 'mastersystem', 'master system', 'sms', 'sega master system');
    add('gamegear', 'gamegear', 'game gear', 'gg', 'sega game gear'); add('pcengine', 'pcengine', 'pc engine', 'tg16', 'turbografx', 'turbografx 16', 'pce');
    add('neogeo', 'neogeo', 'neo geo'); add('arcade', 'arcade', 'mame', 'fbneo', 'fba', 'finalburn neo');
    add('segacd', 'segacd', 'sega cd', 'megacd', 'mega cd'); add('sega32x', 'sega32x', '32x', 'sega 32x'); add('atari2600', 'atari2600', 'atari 2600', '2600', 'a2600');
    add('atarilynx', 'atarilynx', 'lynx', 'atari lynx'); add('wonderswan', 'wonderswan', 'wonderswancolor', 'wonderswan color', 'wsc', 'ws'); add('dos', 'dos', 'msdos', 'ms-dos', 'pc dos'); // (beta.9)
    for (const s of SYS) add(s.id, s.id, s.name, ...(ALIASES[s.id] || []));
    return m; })());
  // "Nintendo GameCube ROMs" → gc; null when the name says nothing Boxshelf knows
  const consoleForName = name => { const k = fkey(name), m = FOLDER_NAMES_(); return m[k] || m[k.replace(/^(nintendo|sony|sega|nec|snk)/, '')] || null; };
  // by the games inside: the one console whose file types fit every game here (disc tracks and archives say nothing)
  const NEUTRAL = new Set(['zip', '7z', 'bin', 'img', 'wav', 'ape', 'raw', 'sub', 'mdf', 'm3u', 'txt', 'nfo', 'png', 'jpg', 'jpeg', 'xml', 'dat', 'sav', 'srm', 'state']);
  function consoleForFiles(files) {
    const exts = new Set(files.map(f => f.ext).filter(e => e && !NEUTRAL.has(e))); if (!exts.size) return null;
    const fit = SYS.filter(s => [...exts].every(e => s.extensions.includes(e)));
    return fit.length === 1 ? fit[0].id : null;
  }
  const ALL_EXTS = [...new Set(SYS.flatMap(s => s.extensions))];
  // → { path, found: [{ id, name, dir, folder, games, by: 'name' | 'files' }], other: [{ folder, why }] }
  async function mapRoot(path, counts) {
    const uri = st.folders[path]; if (!uri) throw new Error('Boxshelf has no access to ' + path + ' any more. Pick it again.');
    const dirs = ((await N.listDirs({ uri })) || {}).dirs || [], found = [], other = [], taken = new Set();
    for (const d of dirs) {
      if (fkey(d.name) === 'boxshelfart' || /^(bios|system|saves?|states?|screenshots?)$/i.test(d.name)) continue;
      let id = consoleForName(d.name), by = 'name', files = null;
      if (!id) { try { files = ((await N.listFiles({ uri: d.uri, exts: ALL_EXTS, depth: 2 })) || {}).files || []; } catch { files = []; }
        id = consoleForFiles(files); by = 'files';
        if (!id) { other.push({ folder: d.name, why: files.length ? 'mixed or unknown game types' : 'no games found' }); continue; } }
      if (taken.has(id)) { other.push({ folder: d.name, why: 'another folder is already ' + sysById[id].name }); continue; }
      taken.add(id);
      const dir = idToPath(d.docId); st.folders[dir] = d.uri;
      found.push({ id, name: sysById[id].name, dir, folder: d.name, by, games: 0 });
    }
    store('folders.json', st.folders);
    if (counts) for (const f of found) { try { f.games = (await scanSystem(sysById[f.id], { romDirs: [f.dir] })).length; } catch { f.games = 0; } }
    return { path, found: found.sort((a, b) => SYS.indexOf(sysById[a.id]) - SYS.indexOf(sysById[b.id])), other };
  }

  // (beta.10) a picked folder Android wouldn't let Boxshelf keep reads now but not after a restart: said plainly (on
  // Settings' message line while it's open, else the shelf's) instead of the pick quietly "working"
  const sayNow = m => { try { const t = document.querySelector('#bss.on .bss-toast'); if (t) { t.textContent = m; t.classList.add('on'); clearTimeout(sayNow.t); sayNow.t = setTimeout(() => t.classList.remove('on'), 7000); return; }
    if (window.Shelf && Shelf.toast) Shelf.toast(m); } catch {} };
  async function pickTree() { const r = await N.pickFolder(); if (!r || r.canceled || !r.uri) return null;
    if (r.persisted === false) { log('folder: Android kept no lasting permission', r.persistError || ''); sayNow("Android didn't let Boxshelf keep access to that folder: it works now, but not after a restart. Pick a folder on the device's storage or SD card instead."); }
    const p = idToPath(r.docId || treeIdOf(r.uri)); st.folders[p] = r.uri;
    if (st.foldersOff.includes(p)) { st.foldersOff = st.foldersOff.filter(x => x !== p); store('folders-off.json', st.foldersOff); } // (picked again: wanted again)
    await store('folders.json', st.folders); return p; }
  // (beta.10) games folders removed in Settings: remembered (detect() doesn't add them back) and, once nothing in the settings
  // still uses that folder (or one inside it), Android's lasting permission is given back (it keeps only so many)
  const cfgDirs = c => { const s = new Set(); for (const x of Object.values((c && c.systems) || {})) for (const d of (x && x.romDirs) || []) s.add(d); if (c && c.romRoot) s.add(c.romRoot); return s; };
  function foldersDropped(before, c) {
    const now = cfgDirs(c), gone = [...before].filter(d => !now.has(d)), off = new Set(st.foldersOff.filter(d => !now.has(d)));
    for (const d of gone) off.add(d);
    if (off.size !== st.foldersOff.length || st.foldersOff.some(d => !off.has(d))) { st.foldersOff = [...off].slice(-200); store('folders-off.json', st.foldersOff); }
    if (!gone.length || !N.releaseFolder) return;
    const text = JSON.stringify(c), used = Object.entries(st.folders).filter(([p]) => text.includes(JSON.stringify(p))).map(([, u]) => String(u)); // (any setting: games, videos…)
    for (const u of new Set(gone.map(d => st.folders[d]).filter(u => u && /\/tree\/[^/]+$/.test(u)))) { // (a picked folder itself, never one inside it)
      if (used.some(x => x === u || x.startsWith(u + '/document/'))) continue;
      N.releaseFolder({ uri: u }).then(r => log('folder: permission given back', !!(r && r.released))).catch(e => log('folder: release', e && e.message)); }
  }
  // (beta.10) the start-up "anything new?" check: a few numbers per game compared (shelves, games, files, sizes, dates,
  // names), not the whole library as JSON on the page's thread; the same → { unchanged: true } and the shelf stays as it is
  const libSig = lib => { const p = []; for (const sh of lib || []) { const G = sh.games || [];
    p.push('#' + [sh.id, sh.kind, sh.name, sh.emulator || '', sh.emulatorName || '', sh.hasEmulator ? 1 : 0, sh.bootOnLaunch === false ? 0 : 1, G.length].join('|'));
    for (const g of G) p.push([g.id, g.title, g.fileTitle || '', g.region || '', g.sizeBytes || 0, g.added || 0, (g.discs || []).length, g.appId || '', g.romm && g.romm.cloud ? 'c' : ''].join('|')); } return p.join('\n'); }; // (beta.12: a RomM game downloaded since is a change)
  // ---------- (beta.12) RomM, a self-hosted game library (the Windows build's main/romm.js and main.js, on the device) ----------
  // Its games join their console's shelf at the place they'll have once downloaded (<the console's first games folder>/
  // <RomM's file name>, so favourites and play time carry over), with a cloud badge (g.romm.cloud) until then. Play
  // downloads one first (BoxshelfNative.rommDownload: straight into that folder, resumable, checked, a zip unpacked into a
  // folder of its own), its progress on the boot slide; B stops it (rommCancel, the part kept for the next Play). The
  // library: the saved copy (romm-library.json) at once, and a sync in the background once the shelf is quiet (idleTurn:
  // never during a slide), its pages one after another, later syncs only what changed (updated_after) plus a light id
  // sweep for removed games. Every request goes through the native side (RomM turns the page's own origin away); the
  // sign-in is kept in the settings (keys.rommToken, as the other keys) and added there, only for the saved server's
  // addresses. Box art: the box art job above, by title (a game whose file isn't here yet needs nothing from the file).
  const RM_SLUGS = { gc: ['ngc', 'gamecube', 'gc', 'gcn', 'nintendo-gamecube'], wii: ['wii'], wiiu: ['wiiu', 'wii-u'], sw: ['switch', 'nintendo-switch', 'nsw'],
    sw2: ['switch-2', 'switch2', 'nintendo-switch-2'], psp: ['psp', 'playstation-portable'], ps2: ['ps2', 'playstation-2'], ps3: ['ps3', 'playstation-3'],
    ps4: ['ps4', 'ps4--1', 'playstation-4'], ps5: ['ps5', 'playstation-5'], x360: ['xbox360', 'xbox-360', 'x360'], n3ds: ['3ds', 'n3ds', 'nintendo-3ds', 'new-nintendo-3ds'],
    psx: ['ps', 'psx', 'ps1', 'playstation', 'playstation-1'], nes: ['nes', 'famicom', 'fds', 'famicom-disk-system'], snes: ['snes', 'sfam', 'super-famicom', 'super-nintendo'],
    n64: ['n64', 'nintendo-64'], gb: ['gb', 'gameboy', 'game-boy'], gbc: ['gbc', 'gameboy-color', 'game-boy-color'], gba: ['gba', 'gameboy-advance', 'game-boy-advance'],
    nds: ['nds', 'nintendo-ds', 'nintendo-dsi', 'dsi'], megadrive: ['genesis-slash-megadrive', 'genesis', 'megadrive', 'mega-drive', 'md', 'sega-genesis'],
    mastersystem: ['sms', 'mastersystem', 'master-system', 'sega-master-system'], gamegear: ['gamegear', 'game-gear', 'gg', 'sega-game-gear'], dreamcast: ['dc', 'dreamcast', 'sega-dreamcast'],
    saturn: ['saturn', 'sega-saturn'], pcengine: ['turbografx16--1', 'turbografx-16-slash-pc-engine-cd', 'tg16', 'turbografx16', 'turbografx-16', 'pce', 'pcengine', 'pc-engine', 'pc-engine-cd', 'pcenginecd', 'tg-cd'],
    neogeo: ['neogeoaes', 'neogeomvs', 'neo-geo', 'neogeo', 'neo-geo-aes', 'neo-geo-mvs'], arcade: ['arcade', 'mame', 'fbneo', 'fba', 'cps1', 'cps2', 'cps3'],
    segacd: ['segacd', 'sega-cd', 'mega-cd', 'megacd', 'sega-cd-32x'], sega32x: ['sega32', 'sega32x', 'sega-32x', '32x'], atari2600: ['atari2600', 'atari-2600', 'a2600'],
    atarilynx: ['lynx', 'atari-lynx', 'atarilynx'], wonderswan: ['wonderswan', 'wonderswan-color', 'wonderswancolor', 'wsc', 'ws'], dos: ['dos', 'ms-dos', 'msdos', 'pc-dos'] };
  const RM_PAGE = 250, RM_PAUSE = 40; // (250 a page: each answer is parsed on this thread, in a quiet moment, so each is kept small)
  const RM_CLEAR = "Android won't open plain http:// addresses in this build: use your RomM's https:// address";
  const rm = { lib: null, byCon: null, local: null, pair: null, syncing: null, dl: null, synced: false, devId: null, ix: null, offline: false, say: null, libFns: [] };
  // the server's address as the native side reads it too (BoxshelfNativePlugin.rommBase): http:// when none, no trailing / or /api
  const rmBase = () => { let u = String((st.config && st.config.romm && st.config.romm.server) || '').trim(); if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u; u = u.replace(/\/+$/, ''); if (/\/api$/i.test(u)) u = u.slice(0, -4); return u.replace(/\/+$/, ''); };
  const rmToken = () => String(((st.config && st.config.keys) || {}).rommToken || '').trim();
  const rmOn = () => !!(rmBase() && rmToken());
  const rmErr = (code, msg) => Object.assign(new Error(msg || code), { code });
  const rmWhy = code => code === 'cleartext' ? RM_CLEAR : (code || 'offline');
  const rmNum = v => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? +v : null));
  const rmTs = s => { const t = Date.parse(s); return isFinite(t) ? t : 0; };
  // a file name as the native side keeps it (BoxshelfNativePlugin.safeName leaves this one as it is)
  const rmSafe = n => String(n || 'game').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 150).trim().replace(/[. ]+$/, '') || 'game';
  // one call to RomM: JSON in and out. Throws { code: 'offline' | 'cleartext' } when it can't be reached; an HTTP error
  // comes back as { ok: false, status }. wait: the answer is parsed in a quiet moment (a library page can be big)
  async function rmCall(p, o = {}) {
    const base = rmBase(); if (!base) throw rmErr('no-server');
    const req = { url: base + p, romm: true, headers: { Accept: 'application/json' } };
    if (o.auth === false) req.auth = false;
    if (o.json !== undefined) { req.body = JSON.stringify(o.json); req.contentType = 'application/json'; }
    let r; try { r = await N.httpText(req); } catch (e) { const m = String((e && e.message) || ''); throw rmErr(/cleartext/i.test(m) ? 'cleartext' : 'offline', 'server not reachable'); }
    if (o.wait) await o.wait();
    let json = null; try { json = r && r.text ? JSON.parse(r.text) : null; } catch {}
    const status = +(r && r.status) || 0; return { status, ok: status >= 200 && status < 300, json };
  }
  const rmChanged = () => { for (const f of rm.libFns) try { f({ romm: 1 }); } catch (e) { console.error(e); } };
  // ----- pairing: the device flow (RomM 5.0+: a QR code / address and a code to approve) or an 8-digit code (4.8+) -----
  async function rmDeviceId() { if (rm.devId) return rm.devId;
    const o = await load('romm-device.json', null); if (o && o.id) rm.devId = String(o.id);
    if (!rm.devId) { rm.devId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'bx-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); await store('romm-device.json', { id: rm.devId }); }
    return rm.devId; }
  const rmReason = j => { if (!j || typeof j !== 'object') return ''; const d = j.detail; return String(j.error || (d && typeof d === 'object' ? d.error || d.code || '' : d) || '').toLowerCase(); };
  // (beta.12) the token is kept with the origin of the server it was paired with (keys.rommTokenServer, as on the PC):
  // the native side never sends it anywhere else, and a new server address in Settings drops it (saveConfig)
  const rmOrigin = u => { try { return u ? new URL(u).origin : ''; } catch { return ''; } };
  async function rmSaveToken(t) { st.config.keys = Object.assign({}, st.config.keys || {}, { rommToken: String(t || ''), rommTokenServer: t ? rmOrigin(rmBase()) : '' }); await store('config.json', st.config); }
  // (a sync still running for the old sign-in keeps nothing: a fresh one follows it)
  function rmAfterPair() { rm.lib = null; rm.byCon = null; rm.synced = true; Promise.resolve(rm.syncing).then(() => rmCache()).then(() => rmSync(false)).catch(() => {}); }
  async function rmPairStart() { await ready; const base = rmBase(); if (!base) return { ok: false, error: 'no-server' };
    let r; try { r = await rmCall('/api/auth/device/init', { auth: false, json: { client_device_identifier: await rmDeviceId(), name: 'Boxshelf', client: 'Boxshelf', platform: 'android',
      client_version: String(window.BS_BUILD || '0').split(' ')[0], requested_scopes: ['roms.read', 'platforms.read'] } }); }
    catch (e) { return { ok: false, error: rmWhy(e.code) }; }
    if (r.status === 404 || r.status === 405) return { ok: false, error: 'unsupported', useCode: true };
    if (r.status === 429) return { ok: false, error: 'rate-limited' };
    const j = r.json || {}; if (!r.ok || !j.device_code || !j.user_code) return { ok: false, error: 'http-' + r.status };
    const interval = Math.max(1, rmNum(j.interval) || 5) * 1000, now = Date.now(), vp = String(j.verification_path_complete || j.verification_uri_complete || j.verification_path || j.verification_uri || '');
    rm.pair = { deviceCode: j.device_code, interval, nextAt: now + interval, expiresAt: now + Math.max(30, rmNum(j.expires_in) || 600) * 1000 };
    const qrUrl = /^https?:\/\//i.test(vp) ? vp : base + (vp.startsWith('/') ? vp : '/' + vp);
    let qr = ''; try { qr = qrSvg(qrUrl); } catch (e) { log('RomM: no QR code', e && e.message); } // (the card still shows the address and the code)
    return { ok: true, userCode: j.user_code, qrUrl, qr, expiresAt: rm.pair.expiresAt, interval: interval / 1000 };
  }
  // one poll, never sooner than the server's interval (pending answers carry wait: ms until the next poll is due)
  async function rmPairPoll() {
    const p = rm.pair; if (!p) return { state: 'expired' };
    const now = Date.now(); if (now >= p.expiresAt) { rm.pair = null; return { state: 'expired' }; }
    if (now < p.nextAt) return { state: 'pending', wait: p.nextAt - now };
    let r; try { r = await rmCall('/api/auth/device/token', { auth: false, json: { device_code: p.deviceCode } }); }
    catch (e) { p.nextAt = Date.now() + p.interval; return { state: 'pending', wait: p.interval, error: rmWhy(e.code) }; }
    if (rm.pair !== p) return { state: 'expired' };
    const j = r.json || {}, tok = j.access_token || j.token || j.raw_token;
    if (r.ok && tok) { rm.pair = null; await rmSaveToken(tok); rmAfterPair(); return { state: 'ok' }; } // (the token itself never goes back to the page)
    const why = rmReason(j);
    if (why === 'slow_down' || r.status === 429) p.interval += 5000;
    if (why === 'access_denied') { rm.pair = null; return { state: 'denied' }; }
    if (why === 'expired_token' || why === 'invalid_grant') { rm.pair = null; return { state: 'expired' }; }
    p.nextAt = Date.now() + p.interval; return { state: 'pending', wait: p.interval };
  }
  async function rmPairCode(code) { await ready; if (!rmBase()) return { ok: false, error: 'no-server' };
    const c = String(code || '').replace(/\D/g, '').slice(0, 12); if (!c) return { ok: false, error: 'not accepted' };
    let r; try { r = await rmCall('/api/client-tokens/exchange', { auth: false, json: { code: c } }); } catch (e) { return { ok: false, error: rmWhy(e.code) }; }
    if (r.status === 404 || r.status === 405) return { ok: false, error: 'unsupported' };
    const j = r.json || {}, tok = typeof j === 'string' ? j : j.access_token || j.token || j.raw_token;
    if (!r.ok || !tok) return { ok: false, error: r.status === 429 ? 'rate-limited' : 'not accepted' };
    await rmSaveToken(tok); rmAfterPair(); return { ok: true };
  }
  async function rmTest() { await ready; if (!rmBase()) return { ok: false, error: 'no-server' };
    let version = null;
    try { const h = await rmCall('/api/heartbeat', { auth: false }), j = h.json || {}; version = (j.SYSTEM && j.SYSTEM.VERSION) || j.VERSION || j.version || null; }
    catch (e) { return { ok: false, error: rmWhy(e.code) }; }
    if (!rmToken()) return { ok: false, version, error: 'no-token' };
    try { const r = await rmCall('/api/platforms');
      if (r.status === 401 || r.status === 403) return { ok: false, version, error: 'auth' };
      if (!r.ok) return { ok: false, version, error: 'http-' + r.status };
      return { ok: true, version, platforms: Array.isArray(r.json) ? r.json.length : 0 }; }
    catch (e) { return { ok: false, version, error: rmWhy(e.code) }; }
  }
  // ----- the library -----
  // a RomM platform → the Boxshelf console it belongs to (RomM's own slugs, else the folder names a console goes by), or null
  function rmConsole(p) {
    if (!rm.ix) { rm.ix = new Map(); for (const [id, list] of Object.entries(RM_SLUGS)) for (const s of list) if (!rm.ix.has(s)) rm.ix.set(s, id); }
    if (!p) return null; const a = String(p.slug || '').toLowerCase().trim(), b = String(p.fs_slug || '').toLowerCase().trim();
    const id = rm.ix.get(a) || rm.ix.get(b) || (a && consoleForName(a)) || (b && consoleForName(b)) || null;
    return id && sysById[id] ? id : null;
  }
  function rmGame(it, p, cid) {
    const files = (Array.isArray(it.files) ? it.files : []).map(f => ({ name: String(f.file_name || f.name || ''), size: rmNum(f.file_size_bytes), sha1: f.sha1_hash || null, md5: f.md5_hash || null }));
    const multi = typeof it.has_multiple_files === 'boolean' ? it.has_multiple_files : files.length > 1, one = !multi && files.length === 1 ? files[0] : null;
    const title = String(it.name || String(it.fs_name_no_ext || it.fs_name || '').replace(/\.[a-z0-9]{1,5}$/i, ''));
    return { rommId: it.id, platformId: p.id, consoleId: cid, title, file: String(it.fs_name || ''), size: rmNum(it.fs_size_bytes) || files.reduce((a, f) => a + (f.size || 0), 0) || null, multi,
      sha1: (one && one.sha1) || it.sha1_hash || null, md5: (one && one.md5) || it.md5_hash || null, files: multi ? files : [], updatedAt: it.updated_at || null };
  }
  function rmIndex() { const m = {}; for (const g of Object.values((rm.lib && rm.lib.games) || {})) (m[g.consoleId] || (m[g.consoleId] = [])).push(g); rm.byCon = m; }
  async function rmCache() { const base = rmBase(); if (rm.lib && rm.lib.server === base) return rm.lib;
    const o = await load('romm-library.json', null);
    rm.lib = o && o.v === 1 && o.server === base && o.games && typeof o.games === 'object' ? o : { v: 1, server: base, at: null, platforms: {}, games: {}, skipped: null };
    rmIndex(); return rm.lib; }
  async function rmLocal() { if (!rm.local) { const o = await load('romm-local.json', {}); rm.local = o && typeof o === 'object' ? o : {}; } return rm.local; }
  const rmOut = (c, extra) => Object.assign({ count: Object.keys(c.games || {}).length, at: c.at, skipped: c.skipped || { platforms: 0, games: 0, slugs: [] }, offline: false }, extra);
  // every page of a platform's ROMs (after `since` when given), one after another, each in a quiet moment
  async function rmPages(p, since, wait, take) {
    for (let offset = 0, first = true; ; first = false) {
      const q = new URLSearchParams({ platform_ids: String(p.id), limit: String(RM_PAGE), offset: String(offset), with_char_index: 'false', with_filter_values: 'false', with_rom_id_index: 'false', with_total: first ? 'true' : 'false' });
      if (since) q.set('updated_after', since);
      await wait(); const r = await rmCall('/api/roms?' + q, { wait });
      if (r.status === 401 || r.status === 403) throw rmErr('auth');
      if (!r.ok) throw rmErr('http-' + r.status);
      const items = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.items) ? r.json.items : []);
      take(items); offset += items.length;
      const total = r.json && typeof r.json.total === 'number' ? r.json.total : null;
      if (!items.length || items.length < RM_PAGE || (total != null && offset >= total) || Array.isArray(r.json)) return;
      await sleep(RM_PAUSE);
    }
  }
  // all ROM ids of a platform in one light request (RomM's rom_id_index); null when the server doesn't give it
  async function rmIdSweep(p, wait) {
    const q = new URLSearchParams({ platform_ids: String(p.id), limit: '1', offset: '0', with_char_index: 'false', with_filter_values: 'false', with_rom_id_index: 'true', with_total: 'false' });
    await wait(); const r = await rmCall('/api/roms?' + q, { wait });
    if (r.status === 401 || r.status === 403) throw rmErr('auth');
    if (!r.ok || !r.json || !Array.isArray(r.json.rom_id_index)) return null;
    return new Set(r.json.rom_id_index.map(String));
  }
  async function rmDoSync(c, wait) {
    let plats;
    try { await wait(); const r = await rmCall('/api/platforms', { wait });
      if (r.status === 401 || r.status === 403) return rmOut(c, { error: 'auth' });
      if (!r.ok || !Array.isArray(r.json)) return rmOut(c, { offline: true, error: 'http-' + r.status });
      plats = r.json; }
    catch (e) { return rmOut(c, { offline: true, error: e.code || 'offline' }); }
    const games = Object.assign({}, c.games), platforms = {}, skipped = { platforms: 0, games: 0, slugs: [] }, mapped = [];
    let fetched = 0, removed = 0, changed = false;
    const drop = k => { if (games[k]) { delete games[k]; removed++; } };
    for (const p of plats) { if (!p || p.id == null) continue; if (rmConsole(p)) { mapped.push(p); continue; }
      skipped.platforms++; skipped.games += rmNum(p.rom_count) || 0; skipped.slugs.push(String(p.slug || p.fs_slug || p.id)); }
    try {
      for (const p of mapped) {
        const cid = rmConsole(p), prev = (c.platforms || {})[p.id], full = !prev || prev.consoleId !== cid || !prev.since;
        const mine = () => Object.keys(games).filter(k => games[k].platformId === p.id);
        let since = full ? null : prev.since; const seen = full ? new Set() : null;
        const take = items => { for (const it of items) { if (!it || it.id == null) continue; if (seen) seen.add(String(it.id));
          if (it.missing_from_fs === true) { drop(String(it.id)); continue; }
          const g = rmGame(it, p, cid), old = games[it.id];
          if (!old || old.updatedAt !== g.updatedAt || old.file !== g.file || old.title !== g.title || old.consoleId !== g.consoleId) changed = true;
          games[it.id] = g; fetched++;
          if (it.updated_at && (!since || rmTs(it.updated_at) > rmTs(since))) since = it.updated_at; } };
        if (full && rmNum(p.rom_count) === 0) mine().forEach(drop);
        else {
          await rmPages(p, full ? null : prev.since, wait, take);
          if (full) { for (const k of mine()) if (!seen.has(k)) drop(k); }
          else { await sleep(RM_PAUSE); const ids = await rmIdSweep(p, wait);
            if (ids) { for (const k of mine()) if (!ids.has(k)) drop(k); }
            else if (rmNum(p.rom_count) != null && rmNum(p.rom_count) !== mine().length) { const all = new Set();
              await rmPages(p, null, wait, items => { for (const it of items) if (it && it.id != null) all.add(String(it.id)); take(items); });
              for (const k of mine()) if (!all.has(k)) drop(k); } }
        }
        platforms[p.id] = { id: p.id, slug: p.slug || null, name: p.display_name || p.custom_name || p.name || null, consoleId: cid, since, count: mine().length };
        await sleep(RM_PAUSE);
      }
    } catch (e) { log('RomM: sync stopped:', (e && (e.code || e.message)) || ''); return rmOut(c, { offline: !!e && e.code === 'offline', error: (e && e.code) || 'error' }); }
    for (const k of Object.keys(games)) if (!platforms[games[k].platformId]) drop(k);
    if (rm.lib !== c || !rmOn()) return rmOut(c, { error: 'not paired' }); // (signed out or another server meanwhile: nothing kept)
    c.games = games; c.platforms = platforms; c.skipped = skipped; c.at = new Date().toISOString(); rmIndex();
    await wait(); await store('romm-library.json', c);
    return rmOut(c, { fetched, removed, changed: changed || removed > 0 });
  }
  // a sync (never two at once). Background: each step waits for a quiet shelf; manual (Settings): at most 3 s per step
  function rmSync(manual) {
    if (rm.syncing) return rm.syncing;
    if (!rmOn()) return Promise.resolve(null);
    const wait = () => idleTurn(manual ? 3000 : 0);
    rm.syncing = (async () => { const c = await rmCache(), r = await rmDoSync(c, wait); rm.offline = !!r.offline;
      if (r.error === 'not paired') return r; // (signed out, paired again or another server meanwhile)
      log('RomM sync:', r.count, 'games', r.offline ? '(offline: the saved copy)' : '', r.skipped && r.skipped.platforms ? `(${r.skipped.platforms} platforms Boxshelf has no shelf for)` : '');
      if (r.changed) rmChanged(); return r; })()
      .catch(e => { log('RomM sync', e && e.message); return null; }).finally(() => { rm.syncing = null; });
    return rm.syncing;
  }
  // this console's RomM games not on the shelf yet (not at their place, not where a download went, no game of that title):
  // added to `games` with the cloud badge. Needs the console's first games folder (where Play will put them)
  function rmMerge(s, c, games) {
    if (!rmOn() || (st.config.romm && st.config.romm.cloud === false) || !rm.lib || rm.lib.server !== rmBase() || !rm.byCon) return 0;
    const L = rm.byCon[s.id]; if (!L || !L.length) return 0;
    const dir = (c.romDirs || [])[0], tree = dir && st.folders[dir]; if (!tree) return 0;
    const have = new Set(), titles = new Set(), done = rm.local || {}; let n = 0;
    for (const g of games) { have.add(String(g.file || '').toLowerCase()); for (const d of g.discs || []) have.add(String(d).toLowerCase());
      titles.add(String(g.title || '').toLowerCase()); if (g.fileTitle) titles.add(String(g.fileTitle).toLowerCase()); }
    for (const r of L) {
      const name = rmSafe(r.file || r.title), file = dir + '/' + name, got = done[r.rommId], info = T.cleanTitle(name, { updateWords: s.id === 'sw' }) || {}, title = String(r.title || info.title || name);
      if (have.has(file.toLowerCase()) || (got && got.file && have.has(String(got.file).toLowerCase())) || titles.has(title.toLowerCase()) || (info.title && titles.has(String(info.title).toLowerCase()))) continue;
      have.add(file.toLowerCase()); titles.add(title.toLowerCase());
      games.push({ kind: 'rom', id: s.id + ':' + file, title, region: info.region || '', disc: 0, file, ext: r.multi ? '' : ((/\.([a-z0-9]{1,5})$/i.exec(name) || [])[1] || '').toLowerCase(),
        sizeBytes: r.size || 0, added: rmTs(r.updatedAt), art: {}, romTree: tree, discs: [file], romm: { id: r.rommId, size: r.size || null, multi: !!r.multi, cloud: true } });
      n++;
    }
    if (n) games.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
    return n;
  }
  // ----- Play on a RomM game not downloaded yet: into its console's first games folder (→ the file to start) -----
  const rmMb = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
  const rmSay = t => { try { if (rm.say) rm.say(t); } catch {} };
  if (N.addListener) Promise.resolve().then(() => N.addListener('rommProgress', e => { if (!e || !rm.dl || String(e.id) !== rm.dl) return;
    const t = +e.total || 0, got = +e.received || 0;
    if (e.phase === 'download') rmSay(t > 0 ? `Getting it from RomM… ${Math.min(100, Math.floor(100 * got / t))}% of ${rmMb(t)}` : `Getting it from RomM… ${rmMb(got)}`);
    else if (e.phase === 'verify') rmSay('Checking it…'); else if (e.phase === 'extract') rmSay('Unpacking it…'); })).catch(e => log('RomM listener', e && e.message));
  async function rmFetch(systemId, g) {
    const s = sysById[systemId] || {};
    if (!N.rommDownload) throw new Error("This Boxshelf build can't download games from RomM.");
    if (!rmOn()) throw new Error('RomM isn\'t paired: pair it in Settings → Accounts & services → RomM.');
    const c = await rmCache(), r = c.games[g.romm.id]; if (!r) throw new Error("RomM doesn't have that game any more.");
    const sc = st.config.systems[systemId] || {}, dir = (sc.romDirs || [])[0], tree = dir && st.folders[dir];
    if (!tree) throw new Error(`Boxshelf has no games folder for ${s.name || systemId} to put it in. Pick one in Settings → ${s.name || 'Consoles'}.`);
    const name = rmSafe(r.file || r.title), url = rmBase() + '/api/roms/' + encodeURIComponent(r.rommId) + '/content/' + encodeURIComponent(r.file || name);
    rm.dl = String(r.rommId); rmSay('Getting it from RomM…');
    try {
      const res = await N.rommDownload({ id: String(r.rommId), url, tree, name, size: r.size || 0, multi: !!r.multi, sha1: r.sha1 || '', md5: r.md5 || '',
        files: (r.files || []).map(f => ({ name: String(f.name || ''), size: f.size == null ? -1 : f.size, sha1: f.sha1 || '', md5: f.md5 || '' })) }); // (no nulls: -1 / '' = not known)
      if (!res || !res.uri || !res.docId) throw new Error('error');
      const file = idToPath(res.docId), L = await rmLocal(); L[r.rommId] = { file, uri: res.uri }; store('romm-local.json', L);
      log('RomM download:', res.already ? 'already there' : 'done', res.verified ? '(checked: ' + res.verified + ')' : '');
      return { file, uri: res.uri };
    } catch (e) {
      const code = String((e && e.message) || '').trim();
      const why = { cancelled: 'Download stopped. Press Play again to carry on from where it was.', 'hash-mismatch': "The download didn't match RomM's copy (checked and removed). Press Play to try again.",
        auth: 'RomM turned Boxshelf away: pair it again in Settings → Accounts & services → RomM.', 'no-token': 'RomM isn\'t paired: pair it in Settings → Accounts & services → RomM.',
        'not-found': "RomM doesn't have that game any more.", 'no-space': 'Not enough free space for it on this device.', offline: "RomM can't be reached right now.", cleartext: RM_CLEAR,
        'no-folder': `Boxshelf can't write into ${s.name || 'that console'}'s games folder. Pick it again in Settings → ${s.name || 'Consoles'}.`, 'zip-bad': `${r.title} came as a zip Boxshelf couldn't unpack.`,
        busy: 'Another RomM download is still going.', rename: "The download couldn't be given its name in the games folder." }[code];
      throw new Error(why || ('RomM: ' + (code || 'the download failed')));
    } finally { rm.dl = null; }
  }
  // ----- the pairing QR code (main/companion.js qrMatrix / qrSvg: byte mode, error correction M, versions 1–10) -----
  const QR_FA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], QR_ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const qrMul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; };
  function qrDivisor(n) { const r = new Array(n).fill(0); r[n - 1] = 1; let root = 1; for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { r[j] = qrMul(r[j], root); if (j + 1 < n) r[j] ^= r[j + 1]; } root = qrMul(root, 2); } return r; }
  function qrRemainder(data, div) { const r = div.map(() => 0); for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= qrMul(c, f); }); } return r; }
  const qrRaw = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
  const qrData = v => Math.floor(qrRaw(v) / 8) - QR_ECC[v] * QR_BLOCKS[v];
  function qrAlign(v) { if (v === 1) return []; const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, r = [6]; for (let p = v * 4 + 10; r.length < n; p -= step) r.splice(1, 0, p); return r; }
  function qrMatrix(text) {
    const bytes = [...new TextEncoder().encode(String(text))];
    let v = 1; while (v <= 10 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 > qrData(v) * 8) v++;
    if (v > 10) throw new Error('Too long for a QR code.');
    const bits = [], put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
    const cap = qrData(v) * 8; put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    const nb = QR_BLOCKS[v], ecl = QR_ECC[v], raw = Math.floor(qrRaw(v) / 8), nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = qrDivisor(ecl), blocks = [];
    for (let i = 0, k = 0; i < nb; i++) { const d = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1)); k += d.length; const e = qrRemainder(d, div); if (i < nShort) d.push(0); blocks.push(d.concat(e)); }
    const cw = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) cw.push(b[i]); });
    const size = v * 4 + 17, M = [...Array(size)].map(() => new Array(size).fill(false)), F = [...Array(size)].map(() => new Array(size).fill(false));
    const set = (x, y, d) => { M[y][x] = !!d; F[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy, dist = Math.max(Math.abs(dx), Math.abs(dy)); if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4); }
    const ap = qrAlign(v), na = ap.length;
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) { if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }
    const format = mask => { const d = mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const b = ((d << 10) | r) ^ 0x5412, bit = i => (b >>> i) & 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i)); set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i)); for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i)); set(8, size - 8, true); };
    format(0);
    if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); const b = (v << 12) | r; for (let i = 0; i < 18; i++) { const c = (b >>> i) & 1, a = size - 11 + i % 3, k = Math.floor(i / 3); set(a, k, c); set(k, a, c); } }
    let i = 0; for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5; for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) { const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert; if (!F[y][x] && i < cw.length * 8) { M[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; } } }
    const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
    const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && MASKS[m](x, y)) M[y][x] = !M[y][x]; };
    const penalty = () => { let p = 0, dark = 0; for (let y = 0; y < size; y++) { let rx = 1, ry = 1; for (let x = 0; x < size; x++) { if (M[y][x]) dark++;
      if (x > 0) { if (M[y][x] === M[y][x - 1]) { rx++; if (rx === 5) p += 3; else if (rx > 5) p++; } else rx = 1; if (M[x][y] === M[x - 1][y]) { ry++; if (ry === 5) p += 3; else if (ry > 5) p++; } else ry = 1; }
      if (x > 0 && y > 0 && M[y][x] === M[y][x - 1] && M[y][x] === M[y - 1][x] && M[y][x] === M[y - 1][x - 1]) p += 3; } }
      const fpat = get => { let k = 0; for (let a = 0; a < size; a++) for (let b = 0; b + 10 < size; b++) { let s1 = true, s2 = true; for (let t = 0; t < 11; t++) { const m = get(a, b + t); if (m !== !!QR_FA[t]) s1 = false; if (m !== !!QR_FA[10 - t]) s2 = false; if (!s1 && !s2) break; } if (s1) k++; if (s2) k++; } return k; };
      p += 40 * (fpat((a, b) => M[a][b]) + fpat((a, b) => M[b][a]));
      return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10; };
    let best = 0, bp = Infinity; for (let m = 0; m < 8; m++) { apply(m); format(m); const p = penalty(); if (p < bp) { bp = p; best = m; } apply(m); }
    apply(best); format(best); return M;
  }
  function qrSvg(text) { const M = qrMatrix(text), n = M.length, q = 4; let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (M[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + q * 2} ${n + q * 2}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`; }

  // ---------- the API ----------
  const consoles = () => SYS.map(s => { const e = E[s.emus[0]] || {}; return { id: s.id, name: s.name, emulatorName: e.name || '', exeNames: [e.name || 'emulator app'], extensions: s.extensions, gameArgs: '', android: true }; });
  const over = {
    platform: { os: 'android', caps: { steam: false, power: false, homeMenu: false, emuSettings: false, autostart: false, displays: false, folders: false, companionServer: false, winMode: false, dolphinIpl: false, raAutoConfig: false } },
    getConfig: async () => { await ready; return { config: JSON.parse(JSON.stringify(st.config)), consoles: consoles(), apps: [], appRoot: 'This device', version: 'Android' }; },
    saveConfig: async c => { await ready; const was = st.config.ui && st.config.ui.autoCovers, wasFull = fullOn(), wasSs = ssSig(), dirsWas = cfgDirs(st.config), rmTok = rmToken(), rmWas = rmBase(), rmBound = String(((st.config.keys || {}).rommTokenServer) || '') || rmOrigin(rmWas);
      const games = st.config.games; st.config = JSON.parse(JSON.stringify(c)); // (beta.10) games' own names are renameGame's alone, as on the PC (an older copy of the settings never undoes one)
      if (games) st.config.games = games; else delete st.config.games;
      // (beta.12) RomM's sign-in is the pairing's alone (set by pairing, cleared by Sign out), as on the PC: a screen's copy never changes it
      // (beta.12) ...and it stays only while the address still leads to the server it was paired with (rmBound): another
      // server never gets it (it's dropped, and that server is paired on its own), as on the PC (main.js rommKeysFor)
      { const k = st.config.keys, keep = !!rmTok && !!rmBound && rmOrigin(rmBase()) === rmBound;
        if (rmTok && !keep) log('RomM: the server address changed, so the old sign-in was dropped (it belongs to the other server)');
        if (keep) st.config.keys = Object.assign({}, k || {}, { rommToken: rmTok, rommTokenServer: rmBound });
        else if (k && ('rommToken' in k || 'rommTokenServer' in k)) { st.config.keys = Object.assign({}, k); delete st.config.keys.rommToken; delete st.config.keys.rommTokenServer; } }
      if (rmBase() !== rmWas) { rm.lib = null; rm.byCon = null; rm.pair = null; rm.synced = false; rm.offline = false; } // (another server: its own library, read on the next scan)
      await store('config.json', st.config);
      awakeSync();
      try { foldersDropped(dirsWas, st.config); } catch (e) { log('folders', e && e.message); }
      const on = st.config.ui && st.config.ui.autoCovers !== false, ssNow = ssSig();
      if (ssNow !== wasSs) { ssCredsChanged(); delete apiSt.screenscraper; }
      // just switched on (or full box art, or a new ScreenScraper sign-in): start now, not at the next scan
      if (on && (was === false || (!wasFull && fullOn()) || (ssNow !== wasSs && ssConfigured()))) setTimeout(() => queueArt('setting'), 800);
      return st.config; },
    detect: async () => {
      await ready; const inst = await apps(true), systems = {};
      let granted = []; try { granted = ((await N.folderAccess()).uris || []).map(u => ({ uri: u, path: idToPath(treeIdOf(u)) })); } catch {}
      const off = new Set(st.foldersOff || []); granted = granted.filter(g => !off.has(g.path)); // (beta.10) a folder removed in Settings stays removed
      for (const s of SYS) {
        let emulator = null; for (const id of s.emus) { const p = findInstalled(id, inst); if (p) { emulator = fmtEmu(E[id], p); break; } }
        const names = [s.id, s.name.toLowerCase(), ...(ALIASES[s.id] || [])];
        const romDirs = granted.filter(g => names.includes(g.path.split('/').pop().toLowerCase())).map(g => { st.folders[g.path] = g.uri; return g.path; });
        systems[s.id] = { emulator, romDirs };
      }
      // the main ROMs folder picked before (still allowed): its console folders, found again
      const root = st.config.romRoot; if (root && st.folders[root] && granted.some(g => g.uri === st.folders[root]))
        try { const offW = st.config.romRootOff || []; // folders switched off in the wizard stay off (and those removed in Settings, beta.10)
          for (const f of (await mapRoot(root, false)).found) if (!offW.includes(f.dir) && !off.has(f.dir) && !systems[f.id].romDirs.includes(f.dir)) systems[f.id].romDirs.push(f.dir); } catch (e) { log('main ROMs folder', e && e.message); }
      store('folders.json', st.folders);
      return { systems, steam: { path: null }, apps: {}, appRoot: 'This device' };
    },
    pick: async o => {
      await ready;
      if (o && o.kind === 'folder') return pickTree();
      // an emulator: the known emulator apps for this console first, then every other app
      const inst = await apps(true), want = (o && o.filters && o.filters[0] && o.filters[0].name) || '';
      const sys = SYS.find(s => (E[s.emus[0]] || {}).name === want) || null;
      const known = new Set(); const items = [];
      for (const id of (sys ? sys.emus : Object.keys(E))) { const e = E[id]; for (const [p, label] of inst) if ((e.packages || []).includes(p) || (e.match && e.match.test(p))) if (!known.has(p)) { known.add(p); items.push({ pkg: p, label: `${label} — ${e.name}` }); } }
      // (beta.10) the rest: Boxshelf hands them the game the standard way, which not every app takes; the label says so
      for (const [p, label] of [...inst].sort((a, b) => String(a[1]).localeCompare(String(b[1])))) if (!known.has(p) && p !== 'io.github.boxshelf') items.push({ pkg: p, label: emuFor(p) ? label : `${label} (may open without the game)` });
      const r = await N.chooseApp({ title: o && o.title || 'Choose the emulator app', items }); if (!r || r.canceled) return null;
      const e = emuFor(r.pkg); return e ? fmtEmu(e, r.pkg) : `${String(r.label || r.pkg).replace(/ — .*$/, '').replace(/ \(may open without the game\)$/, '')} (${r.pkg})`;
    },
    checkPaths: async list => { await ready; const inst = await apps();
      return (list || []).map(p => { const pkg = pkgOf(p); return { path: p, file: !!(pkg && inst.has(pkg)), dir: !!st.folders[p] }; }); },
    scan: () => scanAll().then(handOut),
    // (beta.10) the start-up check (app.js treats unchanged as nothing new): the library the page already has, compared by libSig
    scanIfChanged: async () => { await ready; const had = handed[0] || null, sig = had ? libSig(had) : null, fresh = await scanAll();
      if (had && sig === libSig(fresh)) { applyArt(had); applyManuals(had); return { unchanged: true }; } // (its art brought up to date, as the fresh copy's)
      return handOut(fresh); },
    // (beta.9) video previews (app.js PV): a video beside the game (copied once into the app's cache: the page can't open
    // the games folder's documents), else its YouTube trailer (LaunchBox's link) in the Media tab. Details only on Android
    // (no video behind the moving shelf: 60 fps first)
    previewFind: async ({ systemId, file, title, youtube } = {}) => { await ready; const ui = st.config.ui || {}; if ((ui.previews || 'off') === 'off') return null;
      const m = vids.get(systemId); let v = null;
      if (m && file) { const base = String(file).split('/').pop().replace(/\.[^.]+$/, '').toLowerCase(); v = m.get('=' + base) || m.get('=' + base + '-video') || m.get(vkey(base)) || (title ? m.get(vkey(title)) : null); }
      if (v) { const r = await N.copyPreview({ uri: v.uri, name: (systemId + '-' + v.name).replace(/[^\w.-]+/g, '_').slice(0, 120), size: v.size }).catch(() => null);
        if (r && r.ok && r.path) return { type: 'file', url: fileUrl(r.path) }; }
      const y = /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,20})/.exec(String(youtube || ''));
      if (y && ui.previewYoutube !== false) return { type: 'youtube', id: y[1] };
      return null; },
    previewCount: async () => { await ready; const out = []; let total = 0;
      for (const s of SYS) { const m = vids.get(s.id); if (!m || !m.size) continue; const lib = (st.library || []).find(x => x.id === s.id), games = (lib && lib.games) || [];
        const n = games.filter(g => { const base = String(g.file || '').split('/').pop().replace(/\.[^.]+$/, '').toLowerCase(); return m.has('=' + base) || m.has(vkey(base)) || m.has(vkey(g.title)); }).length;
        if (n) { out.push({ id: s.id, name: s.name, n, of: games.length }); total += n; } }
      return { total, systems: out, steamBytes: 0 }; },
    // YouTube in the Media tab: YouTube's own player in a frame laid over the box (the page moves it with the panel)
    previewYt: async (id, rect, muted) => { if (!/^[\w-]{6,20}$/.test(String(id || '')) || !rect) return false; ytOff();
      const f = document.createElement('iframe'); f.id = 'bsYt'; f.setAttribute('allow', 'autoplay; encrypted-media'); f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=${muted === false ? 0 : 1}&controls=0&playsinline=1&loop=1&playlist=${id}&rel=0&iv_load_policy=3&disablekb=1&fs=0`;
      f.style.cssText = 'position:fixed;border:0;z-index:350;pointer-events:none;background:#000;opacity:0;transition:opacity .45s ease'; ytPlace(f, rect, true); document.body.appendChild(f);
      f.addEventListener('load', () => setTimeout(() => { if (document.getElementById('bsYt') !== f) return; f.style.opacity = '1'; ytFns.forEach(fn => { try { fn({ id, state: 'playing' }); } catch {} }); }, 900), { once: true });
      return true; },
    previewYtMove: async (rect, show) => { const f = document.getElementById('bsYt'); if (!f) return; if (rect) ytPlace(f, rect, show !== false); else f.style.visibility = show === false ? 'hidden' : 'visible'; },
    previewYtStop: async () => ytOff(),
    onPreviewYt: fn => { ytFns.push(fn); },
    cachedLibrary: async () => { await ready; return handOut(st.library); },
    launchGame: async (systemId, file) => { await ready; const g = gameByFile(file); if (!g) throw new Error('That game is no longer in its folder. Rescan to update the shelf.');
      if (!(g.romm && g.romm.cloud)) return start(systemId, g);
      // (beta.12) a RomM game not on the device yet: downloaded first (its progress on the boot slide, B stops it), then
      // started like any game; the shelf is read again afterwards (its cloud goes)
      const got = await rmFetch(systemId, g);
      g.romm = Object.assign({}, g.romm, { cloud: false });
      try { return await start(systemId, Object.assign({}, g, { uri: got.uri, file: got.file, id: systemId + ':' + got.file, discs: [got.file] })); }
      finally { setTimeout(rmChanged, 0); } },
    launchEmulator: systemId => start(systemId, null),
    // (0.3.5) the apps on the device with a launcher icon (the bottom screen's Shortcuts: Spotify, a browser, any app)
    androidApps: async () => { await ready; const inst = await apps(true);
      return [...inst].filter(([p]) => p !== 'io.github.boxshelf').map(([pkg, label]) => ({ pkg, label: String(label || pkg) })).sort((a, b) => a.label.localeCompare(b.label)); },
    // (beta.13) o.screen: 'bottom' opens the app on the Thor's second screen (the shelf on top stays as it is), 'top' on the
    // main one. An app on top leaves Boxshelf's bottom screen up, unless it's one that draws on both (DS / 3DS / Wii U emulators)
    launchApp: async (appId, o) => { const screen = o && /^(top|bottom)$/.test(o.screen) ? o.screen : '';
      const req = { pkg: appId, grant: [], keepBottom: !DUAL_APP.test(String(appId || '')) }; if (screen) req.screen = screen;
      if (screen !== 'bottom') running = { at: Date.now() };
      try { await N.launch(req); } catch (err) { running = null; throw new Error((err && err.message) || String(err)); }
      if (screen === 'bottom') { bottomAway = String(appId); try { window.dispatchEvent(new CustomEvent('bs-bottom-away', { detail: { pkg: bottomAway } })); } catch {} }
      return {}; },
    // (beta.13) Boxshelf's bottom screen back after an app was opened there
    bottomBack: async () => { bottomAway = ''; try { if (N.bottomBack) await N.bottomBack(); } finally { try { window.dispatchEvent(new CustomEvent('bs-bottom-away', { detail: { pkg: '' } })); } catch {} } },
    bottomAway: () => bottomAway,
    appInfo: async pkg => { if (!N.appInfo) throw new Error("App info isn't available"); await N.appInfo({ pkg: String(pkg || '') }); },
    // (beta.13) Settings' Paste key: Android's clipboard text
    clipRead: async () => { if (!N.clipRead) return ''; const r = await N.clipRead(); return String((r && r.text) || ''); },
    onExited: fn => { onExit = fn; },
    onRunReady: fn => { window.__bsRunReady = fn; },
    history: async () => { await ready; return st.history; },
    historyTouch: async id => { await ready; const h = histOf(id); h.count++; h.last = Date.now(); store('history.json', st.history); return true; },
    clearHistory: async () => { st.history = {}; await store('history.json', {}); return true; },
    log: m => log(String(m).slice(0, 500)),
    // quick menu → Power, and Settings → System
    powerOptions: () => [['exitHome', 'Exit to ' + ((prevLauncher() || {}).label || 'device home')], ['androidSettings', 'Android settings'],
      ['homeSettings', home.isDefault ? 'Stop using Boxshelf as Home' : 'Use Boxshelf as Home'], ['quit', 'Close Boxshelf']],
    power: async kind => {
      if (kind === 'exitHome') return exitHome();
      if (kind === 'androidSettings') return N.openAndroidSettings();
      if (kind === 'homeSettings') return N.openHomeSettings();
      return true; },
    quit: async () => { await refreshHome(); if (home.isDefault) return exitHome(); return N.closeApp(); }, // as the Home app, closing would just reopen Boxshelf
    homeStatus: async () => { await ready; await refreshHome(); const p = prevLauncher(); return { isDefault: !!home.isDefault, previous: p, previousLabel: p ? p.label : '' }; },
    openHomeSettings: () => N.openHomeSettings(),
    // not on Android yet: return nothing instead of the demo's pretend data
    themes: async () => ({}), raEnabled: async () => ({ enabled: false, systems: [] }), raProfile: async () => null, raShelf: async () => ({}), raProgress: async () => null,
    library: async () => [], tvList: async () => [], songs: async () => [], stremioLibrary: async () => [],
    downloadCovers: async () => ({ systems: [] }), findManuals: async () => [], manualCoverage: async () => [], artCoverage: async () => [], recentManuals: async () => [],
    listDisplays: async () => [{ id: '1', label: 'This screen', primary: true, current: true }],
    apiStatus: async () => JSON.parse(JSON.stringify(apiSt)),
    testApi: s => testApi(String(s || '')),
    // Settings → Art & manuals → "Fetch missing art now" (Android only; the Windows build has its own planner)
    artFetchNow: async () => { await ready; const n = queueArt('now', true); return { queued: n }; },
    artProgress: () => ({ running: art.running, done: art.done, total: art.total, added: art.added }),
    // Settings → Art & manuals → "Download manuals now": the consoles switched on there, games nothing was found for included
    manualsNow: async () => { await ready; return { queued: manQueue('now', true) }; },
    manualProgress: () => ({ running: man.running, done: man.done, total: man.total, added: man.added }),
    // Inspect's "wrong manual": this copy is set aside (never picked again for the game) and the next best is fetched
    rejectManual: async (systemId, file) => { await ready; const g = gameFor(systemId, file); if (!g) return { ok: false };
      const r = man.db.games[g.id] || {}; man.db.games[g.id] = { no: [...(r.no || []), ...(r.id ? [r.id] : [])], rejected: true, want: r.want };
      for (const lib of [st.library, ...handed]) for (const sh of lib || []) for (const x of sh.games || []) if (x.id === g.id && x.art) x.art.manual = [];
      man.looked.delete(g.id); delete man.db.miss[g.id]; saveMan(); return { ok: true, queued: manQueue('wrong', true, new Set([g.id])) }; },
    // the setup wizard's "Pick your main ROMs folder": pick it (or look at the one picked before) → its consoles, with game counts
    romRoot: async o => { await ready; let path = o && o.path;
      if (!path) { path = await pickTree(); if (!path) return null;
        const under = path + '/', keep = st.foldersOff.filter(d => !d.startsWith(under)); // (beta.10) the main folder picked again: its console folders are offered again too
        if (keep.length !== st.foldersOff.length) { st.foldersOff = keep; store('folders-off.json', keep); } }
      return mapRoot(path, true); },
    // (beta.10) Details → Rename, as the PC (main.js game:rename): kept in config.games["<console>:<file>"].title; '' = back to the file's name
    renameGame: async ({ systemId, file, title } = {}) => { await ready;
      const g = gameFor(systemId, file); // (one the scan found: throws "That game isn't on the shelf" otherwise)
      const key = systemId + ':' + g.file, t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120), games = Object.assign({}, st.config.games || {}), cur = Object.assign({}, games[key] || {});
      if (t) cur.title = t; else delete cur.title;
      if (Object.keys(cur).length) games[key] = cur; else delete games[key];
      st.config.games = games; await store('config.json', st.config); log('game renamed:', systemId, t ? 'to a name of its own' : 'back to its file name');
      return { ok: true, title: t }; },
    // (beta.12) Details → Emulator, as the PC (main.js game:emulator): one game in another emulator app than the rest of
    // its shelf, and for RetroArch another core, kept in config.games["<console>:<file>"].emulator / .core. A plain list:
    // the shelf's own first (clears the choice), then the emulator apps for this console that are installed
    gameEmulator: async id => { await ready;
      const m = /^([a-z0-9]+):(.+)$/i.exec(String(id || '')), s = m && sysById[m[1]]; if (!s) throw new Error('Only console games can have their own emulator.');
      const g = gameFor(m[1], m[2]), key = m[1] + ':' + g.file, inst = await apps(true), c = st.config.systems[m[1]] || {};
      const games = Object.assign({}, st.config.games || {}), cur = Object.assign({}, games[key] || {});
      const shelfPkg = pkgOf(c.emulator), shelfE = shelfPkg && emuFor(shelfPkg), items = [{ pkg: '@shelf', label: `The shelf's emulator${shelfE ? ' (' + shelfE.name + ')' : ''}` }], seen = new Set();
      for (const eid of s.emus || []) { const e = E[eid]; if (!e) continue; for (const [p, label] of inst) if (((e.packages || []).includes(p) || (e.match && e.match.test(p))) && !seen.has(p)) { seen.add(p); items.push({ pkg: p, label: label === e.name ? label : `${label} — ${e.name}` }); } }
      if (items.length < 2) throw new Error(`No other emulator for ${s.name} is installed.`);
      const r = await N.chooseApp({ title: `Emulator for ${String(g.title || 'this game').slice(0, 60)}`, items }); if (!r || r.canceled) return { ok: false, games: st.config.games || {} };
      if (r.pkg === '@shelf') { delete cur.emulator; delete cur.core; }
      else { const e = emuFor(r.pkg); cur.emulator = e ? fmtEmu(e, r.pkg) : `${String(r.label || r.pkg).replace(/ — .*$/, '')} (${r.pkg})`; delete cur.core;
        // RetroArch (the game is handed to a core): which core, when this console has more than one
        if (e && /\$CORE/.test(JSON.stringify(e.launch || {})) && (s.cores || []).length > 1) {
          const rc = await N.chooseApp({ title: 'Which core?', items: [{ pkg: '@shelfcore', label: `The shelf's core (${c.core || s.cores[0]})` }, ...s.cores.map(k => ({ pkg: '@core:' + k, label: k }))] });
          const k = rc && !rc.canceled && /^@core:(.+)$/.exec(String(rc.pkg || '')); if (k && s.cores.includes(k[1])) cur.core = k[1]; } }
      if (Object.keys(cur).length) games[key] = cur; else delete games[key];
      st.config.games = games; await store('config.json', st.config); log('game emulator:', m[1], cur.emulator ? 'its own' : 'the shelf\'s', cur.core ? '(its own core)' : '');
      return { ok: true, games }; },
    // (beta.10) Settings' "Open site" links: https addresses only, in the device's browser (the demo's pretend one said "Opened" and opened nothing)
    openExternal: async url => { const u = String(url || '').trim(); if (!/^https:\/\/[^\s/]+/i.test(u)) throw new Error('Only https links can be opened'); await N.openUrl({ url: u }); return true; },
    consoleForFolder: (name, files) => consoleForName(name) || (files ? consoleForFiles(files) : null), // tests
    // (beta.12) RomM (Settings → Accounts & services → RomM; the demo's pretend versions in mock.js must not answer on the device)
    rommStatus: async () => { await ready; const on = rmOn(), c = on ? await rmCache() : null;
      return { server: rmBase(), paired: on, pairing: !!rm.pair, syncing: !!rm.syncing, downloads: rm.dl ? [rm.dl] : [], count: c ? Object.keys(c.games).length : null, at: c ? c.at : null, offline: !!rm.offline, skipped: c ? c.skipped : null }; },
    rommPairStart: () => rmPairStart(),
    rommPairPoll: () => rmPairPoll(),
    rommPairCancel: async () => { rm.pair = null; return true; },
    rommPairCode: code => rmPairCode(code),
    rommTest: () => rmTest(),
    rommSync: async () => { await ready; if (!rmOn()) return { ok: false, error: rmBase() ? 'not paired' : 'no-server' };
      const r = await rmSync(true); return r ? { ok: !r.error, count: r.count, offline: !!r.offline, error: r.error ? rmWhy(r.error) : null } : { ok: false, error: 'busy' }; },
    rommForget: async () => { await ready; rm.pair = null; rm.lib = null; rm.byCon = null; rm.offline = false; rm.synced = false;
      if (st.config.keys && ('rommToken' in st.config.keys || 'rommTokenServer' in st.config.keys)) { st.config.keys = Object.assign({}, st.config.keys); delete st.config.keys.rommToken; delete st.config.keys.rommTokenServer; await store('config.json', st.config); }
      await store('romm-library.json', {}); rmChanged(); return true; }, // (games already downloaded stay where they are)
    rommCancel: async () => { if (!rm.dl) return false; try { await N.rommCancel(); } catch (e) { log('RomM cancel', e && e.message); } return true; },
    // the boot slide's status line (a RomM download's progress), and the shelf told to read the library again
    onLaunchStatus: fn => { rm.say = fn; },
    onLibraryChanged: fn => { if (typeof fn === 'function') rm.libFns.push(fn); }
  };
  // Settings shows these only when they exist; Android doesn't have them (yet)
  for (const k of ['backupSettings', 'restoreSettings', 'reportProblem', 'companionSet', 'companionState', 'getAutostart', 'setAutostart', 'moveToDisplay', 'winMode', 'raEmulators', 'findIpl']) delete api[k];
  // (beta.10) more of the demo's pretend features that Settings would show as real on the device: a "newer beta" to get, a
  // manual check, console trailer clips, custom themes. (openExternal and renameGame are real on Android: in over, below)
  for (const k of ['updateCheck', 'checkManuals', 'onManualCheck', 'clipStatus', 'clipHelper', 'customThemes', 'customThemeCreate', 'customThemesOpen']) delete api[k];
  // Art Studio: the parts Android backs with real pictures (studioApi above). LaunchBox's index, matching sets and console
  // re-fetch jobs are Windows-only: the demo's pretend versions of those must not show up on the device as real choices
  for (const k of ['artSets', 'artUseSet', 'artUndoSet', 'artBuildIndex', 'artRefreshIndex', 'artRefreshCancel', 'artIndexInfo', 'onArtIndex', 'artRelease']) delete api[k];
  // the manual studio (inside Art Studio, and the shelf's "Choose manual…") has no Android backing yet: the demo's pretend
  // manuals must not show up as real ones. Everything that shows it checks for manualStudio
  for (const k of ['manualStudio', 'manualGames', 'manualCands', 'manualUse', 'manualUndo', 'manualLock', 'manualOwn', 'manualPref', 'manualCancel', 'onManualCand', 'onManualJob']) delete api[k];
  Object.assign(api, over, studioApi, { thumbFor }); // (thumbFor: the shelf's smaller copies, 0.3.3)
  const ALIASES = { gc: ['gamecube', 'ngc'], wii: [], wiiu: ['wii u'], sw: ['switch', 'nsw'], n3ds: ['3ds'], nds: ['ds'], ps2: ['playstation 2'], psp: [], psx: ['ps1', 'psx', 'playstation'],
    n64: ['nintendo 64'], dreamcast: ['dc'], saturn: [], megadrive: ['genesis', 'md'], mastersystem: ['sms', 'master system'], gamegear: ['gg', 'game gear'], snes: ['super nintendo', 'sfc'],
    nes: ['famicom', 'fc'], gba: ['game boy advance'], gbc: ['game boy color'], gb: ['game boy'], pcengine: ['tg16', 'turbografx', 'pce'], neogeo: ['neo geo'], arcade: ['mame', 'fbneo'],
    segacd: ['megacd', 'sega cd'], sega32x: ['32x'], atari2600: ['2600', 'a2600'], atarilynx: ['lynx'], wonderswan: ['wsc', 'ws', 'wonderswancolor'], dos: ['msdos'] };
  // Keyboards: Boxshelf has its own on-screen keyboard for the controller, and Android's popping up on top of it fought
  // over the buttons (reading room search on the Thor). A text field focused by the controller keeps Android's keyboard
  // away (inputmode=none); a field you tap with a finger gets it, as you'd expect on a touchscreen.
  let touchedAt = 0;
  addEventListener('touchstart', () => { touchedAt = Date.now(); }, { capture: true, passive: true });
  addEventListener('focusin', e => {
    const t = e.target; if (!t || !t.matches || !t.matches('input, textarea, [contenteditable="true"]')) return;
    if (Date.now() - touchedAt < 800) { if (t.getAttribute('inputmode') === 'none') t.removeAttribute('inputmode'); }
    else t.setAttribute('inputmode', 'none');
  }, true);
  // (0.3.2) what android-reading.js (magazines & guides) shares with the adapter: the plugin, settings, the download gates
  window.BS_ANDROID_CTX = { N, st, ready, gated, slowDown, GATE, idleTurn, quiet, fileUrl, pdfLib, toJpegB64, load, store, log, isNative, idToPath, treeIdOf };
  log('Android adapter ready', isNative ? '(device)' : '(pretend device)'); status.ready = isNative; // (beta.10: for the emulator test's file)
  status(isNative ? 'active' : 'active (pretend device)');
  ready.then(() => status((isNative ? 'active' : 'active (pretend device)') + ' · setup ' + (st.config && st.config.setupDone ? 'done' : 'not done'))).catch(e => status('storage error: ' + (e && e.message)));
  } // setup()

  // ---------- a pretend device for browser testing (?fakeNative=1) ----------
  function fakeNative() {
    const files = {}, listeners = {};
    const lib = { 'primary:ROMs/gc': ['Pikmin (USA).rvz', 'Legend of Zelda, The - The Wind Waker (USA).rvz', 'Metroid Prime (USA) (Disc 1).iso', 'Pikmin (USA).mp4' /* (beta.9: a video beside a game, the way a videos folder is listed) */],
      'primary:ROMs/psx': ['Crash Bandicoot (USA).cue', 'Crash Bandicoot (USA).bin', 'Final Fantasy VII (USA) (Disc 1).chd', 'Final Fantasy VII (USA) (Disc 2).chd'],
      'primary:ROMs/snes': ['Super Metroid (Japan, USA).sfc', 'Chrono Trigger (USA).sfc'],
      // more of the main ROMs folder (only seen when it is picked as a whole): one folder known by name, one by its games,
      // and two that can't be told
      'primary:ROMs/Sega Genesis': ['Sonic the Hedgehog (USA, Europe).md'], 'primary:ROMs/Handheld': ['Metroid Fusion (USA).gba', 'Advance Wars (USA).gba'],
      'primary:ROMs/Discs': ['Something (USA).iso'], 'primary:ROMs/BIOS': ['scph1001.bin'], 'primary:ROMs/Extras': [] };
    // ?fakeMany=1: a bigger library (tests of the art queue's order and its download limits)
    if (/[?&]fakeMany=1\b/.test(location.search)) for (let i = 1; i <= 30; i++) { lib['primary:ROMs/snes'].push(`Snes Game ${i} (USA).sfc`); lib['primary:ROMs/psx'].push(`Psx Game ${i} (USA).chd`); }
    let pickN = 0; const order = Object.keys(lib).slice(0, 3);
    window.__fakeLaunches = [];
    // box art: "downloads" answer with a few local test pictures (__art/0-3.jpg, served by the device test); folders made
    // inside the picked trees are recorded. The SNES folder already has a cover in its "Boxshelf Art", to be re-used.
    // The ROM folders are on the "SD card": what's saved there outlives the app's own storage (fake:dirs), like on a device.
    // (covers: the Windows build's folder, read only)
    let dirs = { 'primary:ROMs/snes/Boxshelf Art': new Set(['Super Metroid (Japan, USA).png']), 'primary:ROMs/snes/covers': new Set(['Chrono Trigger (USA).png']),
      'primary:ROMs/psx/covers': new Set(['Crash Bandicoot (USA)-manual-01.jpg', 'Crash Bandicoot (USA)-manual-02.jpg']) }; // (a manual copied over from the PC, already made into pages there)
    try { const d = JSON.parse(localStorage.getItem('fake:dirs') || 'null'); if (d) dirs = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, new Set(v)])); } catch {}
    const saveDirs = () => { try { localStorage.setItem('fake:dirs', JSON.stringify(Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k, [...v]])))); } catch {} };
    // display copies "in the app's storage" (fake:displays): wiping that is what a reinstall or a cleaner app does
    let shown = new Set(); try { shown = new Set(JSON.parse(localStorage.getItem('fake:displays') || '[]')); } catch {}
    const keep = p => { shown.add(p); try { localStorage.setItem('fake:displays', JSON.stringify([...shown])); } catch {} return p; };
    window.__fakeMan = { fetch: [], search: [], busy: false }; // manuals (0.3.0)
    const fakePdf = n => { // a real n-page PDF (a coloured block on each page), so pdf.js has something to draw (0.3.1)
      const objs = [null, '<< /Type /Catalog /Pages 2 0 R >>', ''], kids = [];
      for (let i = 0; i < n; i++) { const p = 3 + i * 2, s = `${(.2 + .3 * i).toFixed(2)} .4 .6 rg 20 20 260 380 re f`; kids.push(p + ' 0 R');
        objs[p] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 420] /Contents ${p + 1} 0 R >>`; objs[p + 1] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`; }
      objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
      let out = '%PDF-1.4\n'; const off = [];
      for (let k = 1; k < objs.length; k++) { off[k] = out.length; out += `${k} 0 obj\n${objs[k]}\nendobj\n`; }
      const x = out.length;
      return out + `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`; };
    window.__fakeArt = { index: 0, fetch: [], thumb: [], dirs: [], ss: [], cache: [], saved: [], picked: 0, lat: 40, live: {}, peak: {} };
    const fakeParts = (dname, want) => { const o = {}; for (const p of (want && want.length ? want : ['front', 'back', 'spine'])) o[p] = pic(dname + p); return o; };
    // a picked folder, or a folder inside one (…/tree/<picked>/document/<sub folder>), as BoxshelfNativePlugin.startId reads it
    const idOfTree = t => decodeURIComponent((/\/document\/([^/]+)/.exec(t) || /\/tree\/([^/]+)/.exec(t) || [])[1] || '');
    const treeOnly = t => String(t).replace(/\/document\/.*$/, '');
    // a save: into the folder's "Boxshelf Art" (kept), or with no tree into the app's own storage
    const fakeSave = (tree, sub, name) => { if (!tree) return { saved: 'app', file: '/data/app-art-full/' + name + '.png' };
      const d = artDir(tree, sub); if (!dirs[d]) { dirs[d] = new Set(); __fakeArt.dirs.push(d); } const had = dirs[d].has(name + '.png'); dirs[d].add(name + '.png'); saveDirs();
      return { saved: 'folder', had, file: 'content://fake/' + encodeURIComponent(d + '/' + name + '.png') }; };
    const artDir = (t, sub) => idOfTree(t) + '/Boxshelf Art' + (sub ? '/' + sub : '');
    const manDir = (t, sub) => idOfTree(t) + '/Boxshelf Manuals' + (sub ? '/' + sub : '');
    const pic = name => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return keep('__art/' + (h % 4) + '.jpg?n=' + h); }; // one path per picture, like files/art/…
    let bottomOn = true; window.__fakeBottom = [];
    addEventListener('message', e => { if (e.data && typeof e.data.bsBottom === 'string') (listeners.bottom || []).forEach(f => f({ msg: e.data.bsBottom })); });
    if (/[?&]bottomPreview=1/.test(location.search)) addEventListener('DOMContentLoaded', () => {
      const f = document.createElement('iframe'); f.id = 'bsBottomPreview'; f.src = 'bottom.html?demo=0';
      f.style.cssText = 'position:fixed;right:12px;bottom:12px;width:620px;height:540px;border:1px solid #333;border-radius:12px;z-index:2147483646;background:#0b0b14';
      document.body.appendChild(f); });
    return {
      readText: async ({ name }) => { let t = files[name] || null; try { t = localStorage.getItem('fake:' + name) || t; } catch {} return { text: t }; },
      writeText: async ({ name, text }) => { files[name] = text; try { localStorage.setItem('fake:' + name, text); } catch {} },
      apps: async () => ({ apps: [{ pkg: 'org.dolphinemu.dolphinemu', label: 'Dolphin' }, { pkg: 'com.retroarch.aarch64', label: 'RetroArch' }, { pkg: 'com.github.stenzek.duckstation', label: 'DuckStation' }, { pkg: 'org.azahar_emu.azahar', label: 'Azahar' }] }),
      activities: async ({ pkg }) => ({ activities: pkg.includes('azahar') ? ['org.citra.citra_emu.activities.EmulationActivity', 'org.citra.citra_emu.ui.main.MainActivity'] : [] }),
      folderAccess: async () => ({ uris: [] }),
      pickFolder: async () => { const id = window.__fakePickNext || order[pickN++ % order.length]; window.__fakePickNext = null; const keep = !window.__fakePersistFail; window.__fakePersistFail = false;
        return Object.assign({ uri: 'content://com.android.externalstorage.documents/tree/' + encodeURIComponent(id), docId: id, persisted: keep }, keep ? {} : { persistError: 'pretend: no lasting permission' }); }, // (beta.10: __fakePersistFail, the warning's test)
      releaseFolder: async ({ uri }) => { (window.__fakeReleased = window.__fakeReleased || []).push(String(uri)); return { released: true }; }, // (beta.10)
      openUrl: async ({ url }) => { window.__fakeCalls = (window.__fakeCalls || []).concat(['openUrl:' + url]); }, // (beta.10)
      dropPdf: async ({ path }) => { (__fakeMan.dropped = __fakeMan.dropped || []).push(String(path)); return { removed: true }; }, // (beta.10)
      copyPreview: async ({ uri }) => { window.__copied = (window.__copied || []).concat(String(uri)); return { ok: true, path: window.__previewUrl || '/__test/preview.webm' }; }, // (beta.9: the video played from the app's cache)
    listFiles: async ({ uri }) => { if (window.__fakeListFail) throw new Error('pretend: the folder can\'t be reached'); const id = idOfTree(uri); return { files: (lib[id] || []).map(n => ({ name: n, docId: id + '/' + n, dir: '', ext: n.split('.').pop().toLowerCase(), uri: treeOnly(uri) + '/document/' + encodeURIComponent(id + '/' + n), size: 1e8, mtime: 1.7e12 })) }; },
      listDirs: async ({ uri }) => { const id = idOfTree(uri), kids = new Set();
        for (const k of [...Object.keys(lib), ...Object.keys(dirs)]) if (k.startsWith(id + '/')) kids.add(k.slice(id.length + 1).split('/')[0]);
        return { dirs: [...kids].map(n => ({ name: n, docId: id + '/' + n, uri: treeOnly(uri) + '/document/' + encodeURIComponent(id + '/' + n) })) }; },
      artExists: async ({ paths }) => ({ missing: (paths || []).filter(p => !shown.has(p)) }),
      artForget: async ({ paths }) => { (__fakeArt.forgot = __fakeArt.forgot || []).push(...(paths || [])); return { removed: (paths || []).length }; },
      // (the first item; tests can line up picks: window.__fakeChoose = ['part of a label or package', …], one used per list shown)
    chooseApp: async ({ items, title }) => { (window.__fakeLists = window.__fakeLists || []).push({ title, items }); const q = Array.isArray(window.__fakeChoose) && window.__fakeChoose.length ? window.__fakeChoose.shift() : null;
      const it = (q != null && items.find(x => String(x.label).includes(q) || String(x.pkg).includes(q))) || items[0]; return { pkg: it.pkg, label: it.label }; },
      homeStatus: async () => ({ isDefault: !!window.__fakeIsHome, current: window.__fakeIsHome ? { pkg: 'io.github.boxshelf', label: 'Boxshelf' } : { pkg: 'com.cocoon.launcher', label: 'Cocoon' },
        launchers: [{ pkg: 'com.cocoon.launcher', label: 'Cocoon' }, { pkg: 'com.ayn.launcher', label: 'AYN Launcher' }] }),
      openHomeSettings: async () => { window.__fakeCalls = (window.__fakeCalls || []).concat(['openHomeSettings']); },
      openAndroidSettings: async () => { window.__fakeCalls = (window.__fakeCalls || []).concat(['openAndroidSettings']); },
      openSettingsPage: async o => { window.__fakeCalls = (window.__fakeCalls || []).concat(['openSettingsPage:' + (o && o.page)]); },
      // (a coloured square per app, as Android's drawn icon would come back)
      appIcons: async ({ pkgs }) => { const icons = {}; (pkgs || []).slice(0, 40).forEach((p, n) => { icons[p] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="22" fill="hsl(${(n * 47) % 360},60%,48%)"/></svg>`); });
        (window.__fakeIconAsks = window.__fakeIconAsks || []).push((pkgs || []).length); return { icons }; },
      launchHome: async o => { window.__fakeCalls = (window.__fakeCalls || []).concat(['launchHome:' + (o && o.pkg)]); },
      closeApp: async () => { window.__fakeCalls = (window.__fakeCalls || []).concat(['closeApp']); },
      fireHome: () => (listeners.home || []).forEach(f => f({})),
      artIndex: async () => { __fakeArt.index++; return { status: 200, names: Object.values(lib).flat().map(n => n.replace(/\.[^.]+$/, '').replace(/ \(Disc \d+\)/, '')) }; },
      artList: async ({ tree, sub, folder }) => { const d = folder === 'covers' ? idOfTree(tree) + '/covers' : folder === 'pcmanuals' ? idOfTree(tree) + '/manuals' : folder === 'manuals' ? manDir(tree, sub) : artDir(tree, sub), set = dirs[d];
        return { exists: !!set, files: set ? [...set].map(n => ({ name: n, uri: /-manual-\d+\./.test(n) ? pic(d + '/' + n) : 'content://fake/' + encodeURIComponent(d + '/' + n) })) : [] }; }, // (manual pages: a test picture, so the reader can show them)
      // manuals: a page "download" into the folder's "Boxshelf Manuals" (or the app's storage with no tree); __fakeMan.miss: pages that 404
      fetchFile: async ({ tree, sub, folder, name, url, pdf }) => { __fakeMan.fetch.push({ name, url, tree, folder, pdf: !!pdf }); await new Promise(r => setTimeout(r, 20));
        if (__fakeMan.busy) return { ok: false, busy: true };
        if (pdf) return /\/Manual\/Metroid_Prime\.pdf$/.test(url) ? { ok: true, name: name + '.pdf', file: 'data:application/pdf;base64,' + btoa(fakePdf(2)) } : { ok: false, missing: true };
        if (!tree) return { ok: true, name: name + '.jpg', file: pic('/data/manuals/' + name) };
        const d = manDir(tree, sub); if (!dirs[d]) dirs[d] = new Set(); dirs[d].add(name + '.jpg'); saveDirs();
        return { ok: true, name: name + '.jpg', file: pic(d + '/' + name + '.jpg') }; },
      // a PDF manual's pages, drawn in the page and saved beside the games (__fakeMan.saved: their names)
      saveBytes: async ({ tree, sub, name, ext, b64 }) => { (__fakeMan.saved = __fakeMan.saved || []).push({ name, size: (b64 || '').length });
        if (!b64) return { ok: false };
        if (!tree) return { ok: true, name: name + '.' + ext, file: pic('/data/manuals/' + name) };
        const d = manDir(tree, sub); if (!dirs[d]) dirs[d] = new Set(); dirs[d].add(name + '.' + ext); saveDirs();
        return { ok: true, name: name + '.' + ext, file: pic(d + '/' + name + '.' + ext) }; },
      // a full wrap (split): display copies of the faces asked for, as the native side cuts them
      artThumb: async ({ name, split, want, dname }) => { if (/~s\d+$/.test(name)) { (__fakeArt.small = __fakeArt.small || []).push(name); return { display: pic(name) }; } // (the shelf's small copies, 0.3.3: counted apart)
        __fakeArt.thumb.push(name); return split ? { display: pic(name), parts: fakeParts(dname || name, want) } : { display: pic(name) }; },
      // (lat: how long a download takes, as a test sets it; live / peak: downloads at once per host, for the limit checks)
      fetchArt: async ({ tree, sub, name, urls, split, want, dname, ss }) => { __fakeArt.fetch.push({ name, urls, tree, split: !!split, ss: !!ss });
        const host = ss ? 'ss' : (String(urls[0] || '').match(/^https?:\/\/([^/]+)/) || [])[1] || '-', L = __fakeArt.live, P = __fakeArt.peak;
        L[host] = (L[host] || 0) + 1; P[host] = Math.max(P[host] || 0, L[host]); P.all = Math.max(P.all || 0, Object.values(L).reduce((a, b) => a + b, 0));
        try { await new Promise(r => setTimeout(r, __fakeArt.lat || 40)); } finally { L[host]--; }
        if (!urls.length) return { ok: false, missing: true };
        const s = fakeSave(tree, sub, name);
        return Object.assign({ ok: true, from: urls[0].replace(/[?#].*$/, ''), saved: s.saved, name: name + '.png', file: s.file, display: pic(name) }, split ? { parts: fakeParts(dname || name, want) } : {}); },
      discId: async ({ uri }) => (/Pikmin/.test(decodeURIComponent(uri)) ? { id: 'GPIE01' } : {}),
      // ScreenScraper: one game found for any file, with every kind of media (the addresses carry a pretend sign-in, as the
      // real answers do, which must never reach a download); SteamGridDB isn't there
      httpText: async ({ url, ss, romm, ...more }) => {
        // (beta.12) RomM: a pretend server only when a test brings one (window.__fakeRomm, ci/romm-android-pass.js); else unreachable, as offline
        if (romm) { if (!window.__fakeRomm) throw new Error('Offline or blocked: pretend'); return __fakeRomm.http(Object.assign({ url }, more)); }
        // the Internet Archive: a 3-page Pikmin booklet (and a strategy guide, which must lose); nothing for the rest
        if (/archive\.org\/advancedsearch/.test(url)) { __fakeMan.search.push(decodeURIComponent(url)); const pik = /Pikmin/.test(decodeURIComponent(url));
          return { status: 200, text: JSON.stringify({ response: { docs: pik ? [{ identifier: 'pikmin-strategy', title: 'Pikmin Official Strategy Guide (GameCube)', downloads: 900 }, { identifier: 'pikmin-gc-manual', title: 'Pikmin (GameCube) Instruction Booklet', language: 'eng', downloads: 120 }] : [] } }) }; }
        // (as most real items: no imagecount in the metadata; the page count is in the scan's page list)
        if (/archive\.org\/metadata\//.test(url)) return { status: 200, text: JSON.stringify({ metadata: {}, files: /pikmin-gc-manual/.test(url) ? [{ name: 'pikmin_page_numbers.json' }, { name: 'pikmin_jp2.zip' }, { name: 'pikmin.pdf' }] : [] }) };
        if (/archive\.org\/download\/pikmin-gc-manual\/pikmin_page_numbers\.json$/.test(url)) { (__fakeMan.lists = __fakeMan.lists || []).push(url); return { status: 200, text: JSON.stringify({ pages: [{ leafNum: 1 }, { leafNum: 2 }, { leafNum: 3 }] }) }; }
        // GamesDatabase: Metroid Prime's page links its PDF manual (2 pages); any other game isn't there
        if (/gamesdatabase\.org\/game\//.test(url)) { (__fakeMan.gdb = __fakeMan.gdb || []).push(url);
          return /\/nintendo-gamecube\/metroid-prime$/.test(url) ? { status: 200, text: '<a href="/Media/SYSTEM/Nintendo_GameCube/Manual/Metroid_Prime.pdf">Manual</a>' } : { status: 200, text: '<h1>Game Not Found</h1>' }; }
        if (!/screenscraper\.fr/.test(url)) return { status: 404, text: '' };
        __fakeArt.ss.push({ url, ss: !!ss }); const user = { id: 'me', maxthreads: '2', maxrequestspermin: '600', requeststoday: '5', maxrequestsperday: '20000' };
        if (/ssuserInfos/.test(url)) return { status: 200, text: JSON.stringify({ response: { ssuser: user } }) };
        const m = (type, r) => ({ type, parent: 'jeu', region: r, format: 'png', url: `https://neoclone.screenscraper.fr/api2/mediaJeu.php?devid=x&ssid=me&sspassword=secret&systemeid=57&jeuid=1&media=${type}(${r})` });
        return { status: 200, text: JSON.stringify({ response: { ssuser: user, jeu: { id: '1', noms: [{ text: 'Game' }], medias: [m('box-2D', 'us'), m('box-2D-back', 'us'), m('box-2D-side', 'us'), m('box-texture', 'us'), m('support-2D', 'us'), m('box-2D', 'eu')] } } }) }; },
      // Art Studio: every version "downloads" to a local test picture (GameTDB's clean disc artwork never does)
      artCache: async ({ url, id, cut }) => { __fakeArt.cache.push({ url, cut }); await new Promise(r => setTimeout(r, 30));
        if (/discM|sspassword/.test(url)) return { missing: true };
        return { file: '/cache/artc/' + id + '.bin', thumb: pic(id + (cut || '')), w: cut === 'spine' ? 140 : 1000, h: 1400 }; },
      saveArt: async o => { __fakeArt.saved.push({ name: o.name, src: o.src, cut: o.cut || '', dname: o.dname });
        const s = fakeSave(o.tree, o.sub, o.name);
        return Object.assign({ ok: true, display: pic(o.dname || o.name) + '?' + encodeURIComponent(o.dname || ''), saved: s.saved, name: o.name + '.png', file: s.file }, s.had ? { old: '/files/art-old/' + o.name + '.png' } : {}); },
      pickImage: async () => { __fakeArt.picked++; return window.__fakePickCancel ? { canceled: true } : { uri: 'content://fake/picked/photo.jpg' }; },
      launch: async req => { window.__fakeLaunches.push(req); if (req && req.screen === 'bottom') return; setTimeout(() => (listeners.resume || []).forEach(f => f({})), 1500); },
      bottomBack: async () => { window.__fakeCalls = (window.__fakeCalls || []).concat(['bottomBack']); },
      appInfo: async o => { window.__fakeCalls = (window.__fakeCalls || []).concat(['appInfo:' + (o && o.pkg)]); },
      clipRead: async () => ({ text: String(window.__fakeClip || '') }),
      // a pretend bottom screen: what the shelf sends it is kept in __fakeBottom; with &bottomPreview=1 the real
      // bottom.html runs in a small frame in the corner and its buttons work, as on the Thor
      bottomStatus: async () => ({ available: true, enabled: bottomOn, shown: bottomOn, width: 1240, height: 1080, density: 2, name: 'Pretend bottom screen' }),
      bottomShow: async () => { bottomOn = true; },
      bottomHide: async () => { bottomOn = false; },
      bottomPost: async ({ msg }) => { window.__fakeBottom.push(msg); const f = document.getElementById('bsBottomPreview');
        if (f && f.contentWindow) f.contentWindow.postMessage({ bsBottomRecv: JSON.stringify(msg) }, '*'); },
      fireBottom: msg => (listeners.bottom || []).forEach(f => f({ msg: JSON.stringify(msg) })),
      // the LaunchBox database (0.3.3): a pretend 110 MB download and sort, then one small file per console asked for
      // (Pikmin and Metroid Prime on the GameCube, with every kind of picture; Crash Bandicoot on the PlayStation)
      lbIndex: async ({ plats }) => { window.__fakeLb = { plats: plats.slice(), cancelled: false }; const tell = e => (listeners.lbIndex || []).forEach(f => f(e)), T = 115343360;
        for (let i = 1; i <= 4; i++) { await new Promise(r => setTimeout(r, 60)); if (__fakeLb.cancelled) throw new Error('cancelled'); tell({ phase: 'download', pct: i * 25, got: T * i / 4, total: T }); }
        for (let i = 1; i <= 2; i++) { await new Promise(r => setTimeout(r, 60)); tell({ phase: 'read', pct: i * 50, got: i, total: 2 }); }
        const im = (id, type, region, f) => [id, type, region, f], shard = { 'Nintendo GameCube': { games: [['lb1', 'Pikmin', '2001'], ['lb2', 'Metroid Prime', '2002'], ['lb3', 'Pikmin 2', '2004']],
            images: [im('lb1', 'Box - Front', 'North America', 'pik-front-us.jpg'), im('lb1', 'Box - Front', 'Japan', 'pik-front-jp.jpg'), im('lb1', 'Box - Back', 'North America', 'pik-back-us.jpg'),
              im('lb1', 'Box - Spine', 'North America', 'pik-spine-us.jpg'), im('lb1', 'Box - Full', 'North America', 'pik-full-us.jpg'), im('lb1', 'Disc', 'North America', 'pik-disc-us.png'),
              im('lb1', 'Fanart - Box - Front', '', 'pik-fan.jpg'), im('lb2', 'Box - Front', 'North America', 'mp-front-us.jpg'), im('lb3', 'Box - Front', 'North America', 'pik2-front.jpg')] },
          'Sony Playstation': { games: [['lb9', 'Crash Bandicoot', '1996']], images: [im('lb9', 'Box - Front', 'North America', 'crash-front.jpg'), im('lb9', 'Box - Back', 'North America', 'crash-back.jpg')] } };
        const counts = {}, write = (name, o) => { const t = JSON.stringify(o); files[name] = t; try { localStorage.setItem('fake:' + name, t); } catch {} };
        for (const p of plats) { const s = shard[p] || { games: [], images: [] }; counts[p] = s.games.length; write('lb-' + p.replace(/[^A-Za-z0-9]+/g, '_') + '.json', Object.assign({ v: 1, plat: p }, s)); }
        tell({ phase: 'split', pct: 100, got: 2, total: 2 });
        const at = Date.now(); write('lb-meta.json', { v: 1, at, plats, counts, bytes: 4096 }); return { ok: true, at, plats, counts, bytes: 4096 }; },
      lbCancel: async () => { if (window.__fakeLb) __fakeLb.cancelled = true; return { ok: true }; },
      // (beta.12) RomM downloads, through the test's pretend server (its progress as "rommProgress" events); a finished one
      // is a file in that games folder from then on, so the next scan finds it
      rommDownload: async o => { if (!window.__fakeRomm) throw new Error('offline');
        const r = await __fakeRomm.download(o, e => (listeners.rommProgress || []).forEach(f => f(e)));
        if (r && r.ok && r.name && !r.dir) { const id = idOfTree(o.tree); (lib[id] = lib[id] || []).includes(r.name) || lib[id].push(r.name); }
        return r; },
      rommCancel: async () => ({ ok: !!(window.__fakeRomm && __fakeRomm.cancel()) }),
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); }
    };
  }
})();
