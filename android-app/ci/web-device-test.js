// Boxshelf fast device test (~1 min), run by the GitHub build on the exact files packed into the APK (android-app/www).
// Chromium (the engine Android's WebView is built on), Thor-like screen (1920x1080 at 2.25x, touch).
//   Pass 1 "device start": Capacitor's real Android bridge script (native-bridge.js) + a stand-in for the native side.
//          Must report "active · setup not done" and show the setup wizard, with no script errors.
//   Pass 2 "Thor flow": the adapter's pretend device (?fakeNative=1): pick folders, scan, launch three emulators, Home key,
//          Exit to the old launcher, Settings rows. Checks the results, not just "no crash".
//          Bottom screen (pretend second display): the settled game is sent to it, its buttons move / start the shelf.
//   Pass 4 "bottom screen page": bottom.html on its own at the Thor's 1240x1080: shows a game it's sent, tabs, case
//          open / disc out, its buttons post the right message, and nothing keeps drawing when idle.
//   Pass 3 "touch": swipe back (edges, plain swipe left, never on the shelf) and pinch to zoom, with real touch input.
//   Pass 3m "museum touch": the top-screen museum by finger (drag / flick along the shelf, tap to choose / pick up, edge swipe).
//   Pass 7 "box art": the progress card (counts, games, fades away), the shelf in front fetched first, download limits.
//   Pass 5 "smoothness": what keeps the shelf, the quick menu and Inspect smooth on the Thor (no case built inside a
//          step, few layers inside case faces, backdrop after the slide, covers decoded first / one per frame / never
//          mid-slide, quick menu without scaling or rebuilding, Inspect's handheld stick speed).
//   Pass 7 "Art Studio": the handheld studio opened from the bottom screen's Box art button (a row per part, pad / keys / touch),
//          as a screen of its own (the shelf behind it not drawn), and the bottom screen showing the case only, turned to
//          the part being edited with the version under the cursor in place. Real-size screenshots.
//   Pass 9 "heat": nothing is drawn while idle (shelf, bottom screen, a sleeping museum), a press wakes it, 3 pooled
//          museum lamps, the shelf not drawn under the museum, the Thor test meter switches off fully.
//   Pass 11 "themes": the extra shelf themes (ci/themes-test.js).
//   Pass 13 "music": the menu music (ci/music-test.js).
//   Pass 14 "box art screens": the Box art page, games grid and game page (ci/artui-test.js).
//   Pass 15 "beta": new-install defaults, beta version order, the update notice and Settings rows (ci/beta-test.js).
//   Pass 16 "pcgames": Epic's installs, Quiver Launcher 3 / 4, games added by hand, the Custom shelf (ci/pcgames-test.js).
//   Pass 17 "screens": the Android build on a 20:9 phone, a small phone and a 16:10 tablet (ci/screens-test.js), then
//          phones, tablets and foldables in portrait and landscape, rotation, the Thor's layout unchanged (ci/portrait-test.js).
//   Pass 18 "retro": the 12 retro shelves (PlayStation … Dreamcast) through RetroArch or a standalone (ci/retro-test.js).
//   Pass 19 "library": Details in Settings' look, filters from the library itself, collections as shelves (ci/library-test.js).
//   Pass 20 "setup": the beta.7 consoles, arcade names, Set up for me, and a tidy first run with RetroArch (ci/setup-test.js).
//   Pass 21 "previews": video previews found, played in Details / over YouTube / behind the shelf, Settings, first run (ci/previews-test.js).
//   Pass 22 "whatsnew": What's new once after updating, the update card with the release's highlights, Settings → What's new (ci/whatsnew-test.js).
//   Pass 23 "addgames": Add games: several programs at once, a scanned folder, the Playnite import (experimental), the Add games tile (ci/addgames-pass.js).
// Writes a table to the GitHub run's Summary and screenshots to out/device-test/. Exit code 1 = failed (APK not published).
// Usage: node ci/web-device-test.js <www dir> <out dir> [--group=thor|screens|windows]
//   (beta.7) --group runs one third of the passes, so GitHub runs the three at once (android.yml): thor = passes 1-9 (the
//   Thor flow on the pretend device), screens = 10-17, windows = 18-24. No group (or all) runs every pass, one after another.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ARGS = process.argv.slice(2).filter(a => !/^--group=/.test(a)), GROUP = ((process.argv.find(a => /^--group=/.test(a)) || '').split('=')[1] || 'all').toLowerCase();
if (!['all', 'thor', 'screens', 'windows'].includes(GROUP)) { console.error('Unknown --group ' + GROUP + ' (thor, screens, windows or all)'); process.exit(2); }
const runs = g => GROUP === 'all' || GROUP === g;
const WWW = path.resolve(ARGS[0] || 'www'), OUT = path.resolve(ARGS[1] || '../out/device-test');
fs.mkdirSync(OUT, { recursive: true });
const SUM = process.env.GITHUB_STEP_SUMMARY;
const lines = []; const say = s => { lines.push(s); console.log(s); };
const BRIDGE = fs.readFileSync(require.resolve('@capacitor/android/capacitor/src/main/assets/native-bridge.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const missing = new Set();
const ART = {}; // the pretend device's "downloaded" box art: __art/0.jpg … 3.jpg, drawn by the browser before the passes
const server = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]);
  if (/^\/__art\/\d\.jpg$/.test(u) && ART[u]) { r.writeHead(200, { 'Content-Type': 'image/jpeg' }); return r.end(ART[u]); }
  const p = path.join(WWW, u === '/' ? 'index.html' : u);
  if (!p.startsWith(WWW)) { r.writeHead(403); return r.end(); }
  fs.readFile(p, (e, d) => { if (e) { missing.add(u); r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); r.end(d); }); });

const checks = []; const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) }); };

// the native side, as far as the page can tell: answers every BoxshelfNative call like a fresh install would
const NATIVE_STANDIN = `window.androidBridge = { postMessage(s) { const m = JSON.parse(s);
  (window.__calls = window.__calls || []).push(m.pluginId + '.' + m.methodName);
  const data = { apps: { apps: [] }, readText: { text: null }, folderAccess: { uris: [] }, homeStatus: { isDefault: false, launchers: [] }, bottomStatus: { available: false, enabled: true, shown: false } }[m.methodName] || {};
  setTimeout(() => window.Capacitor && Capacitor.fromNative && Capacitor.fromNative({ callbackId: m.callbackId, pluginId: m.pluginId, methodName: m.methodName, success: true, data }), 5); } };`;
const HEADERS = `;window.Capacitor.PluginHeaders = [{ name: 'BoxshelfNative', methods: ['readText','writeText','apps','activities','folderAccess','pickFolder','listFiles','launch','chooseApp',
  'homeStatus','openHomeSettings','openAndroidSettings','launchHome','closeApp','artIndex','artList','artThumb','fetchArt','discId','httpText','artCache','saveArt','pickImage','fetchFile','saveBytes','bottomStatus','bottomShow','bottomHide','bottomPost','listDirs','artExists','artForget','releaseFolder','openUrl','dropPdf'].map(n => ({ name: n, rtype: 'promise' })).concat([{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }]) }];`;

async function newPage(browser, init) {
  const ctx = await browser.newContext({ viewport: { width: 853, height: 480 }, deviceScaleFactor: 2.25, isMobile: true, hasTouch: true });
  ctx.setDefaultTimeout(90000); // a busy build machine draws in software: screenshots can take a while (no check is about speed)
  if (init) await ctx.addInitScript({ content: init });
  const page = await ctx.newPage(), errors = [], logs = [];
  page.setDefaultTimeout(120000); // a busy runner (software drawing) can take a while over a screenshot
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { const t = m.text(); logs.push(t); if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push(t.slice(0, 200)); });
  return { ctx, page, errors, logs };
}

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/index.html`;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // Real controllers plugged into the PC running the test are hidden from every page: a pad's button or stick moved them
  // (a game launched by itself mid-check). The GitHub machines have none, so this only makes local runs match them.
  { const noPads = () => { try { Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => [null, null, null, null] }); } catch (e) {} };
    const nc = browser.newContext.bind(browser);
    // (beta.12) BS_SLOW=4 slows every page's processor that much, to see locally what GitHub's slower machines see
    const slow = +process.env.BS_SLOW || 0;
    const throttle = async p => { if (!global.__slowOn) return; try { const s = await p.context().newCDPSession(p); await s.send('Emulation.setCPUThrottlingRate', { rate: slow }); } catch (e) {} };
    // (beta.12) a pretend controller's button pressed for the app's frames, not a fixed time: Boxshelf reads a pad once a
    // drawn frame, and GitHub's software drawing can take most of a second a frame, so a 140 ms tap was never seen and a
    // held button was seen once. A tap is held for exactly one frame; a hold (400 ms and up) for its time and one frame more
    const padHold = () => { window.__padHold = async (pad, i, ms) => {
      const fr = () => new Promise(r => requestAnimationFrame(() => r())), set = p => { pad.buttons[i] = { pressed: p, touched: p, value: p ? 1 : 0 }; pad.timestamp = (pad.timestamp || 0) + 1; };
      ms = ms || 120; set(true); const t0 = performance.now(); await fr(); const left = ms - (performance.now() - t0); if (left > 0) await new Promise(r => setTimeout(r, left));
      if (ms >= 400) await fr(); set(false); await fr(); }; };
    browser.newContext = async o => { const c = await nc(o); await c.addInitScript(noPads); await c.addInitScript(padHold); if (slow > 1) c.on('page', throttle); return c; };
    browser.newPage = async o => { const c = await browser.newContext(o), p = await c.newPage(); const close = p.close.bind(p); p.close = async a => { await close(a); await c.close().catch(() => {}); }; return p; }; }
  try {
    { const p = await browser.newPage({ viewport: { width: 360, height: 512 } }); // four plain test covers (no network in the test)
      for (let i = 0; i < 4; i++) { await p.setContent(`<body style="margin:0;background:hsl(${i * 90 + 20},60%,38%);font:bold 54px sans-serif;color:#fff;display:grid;place-items:center;height:512px">TEST ART ${i}</body>`);
        ART[`/__art/${i}.jpg`] = await p.screenshot({ type: 'jpeg', quality: 80 }); }
      await p.close(); }
    global.__slowOn = true; // (BS_SLOW: the passes from here on; the test covers above are drawn at full speed)
    if (runs('thor')) { // ===== group thor: passes 1-9 =====
    // ---------- pass 1: real bridge, fresh install ----------
    { const { ctx, page, errors, logs } = await newPage(browser, NATIVE_STANDIN + BRIDGE + HEADERS);
      await page.goto(base); await page.waitForTimeout(7000);
      const st = await page.evaluate(() => ({ status: window.__bsAndroid || '', os: window.bsPlatform && bsPlatform.os, wizard: !!document.querySelector('#suTitle'),
        build: window.BS_BUILD || '', w: innerWidth, calls: (window.__calls || []).length }));
      await page.screenshot({ path: path.join(OUT, '1-fresh-install.png') });
      check('Android code starts on the device (real Capacitor bridge)', /^active/.test(st.status), st.status || 'no status');
      check('Fresh install opens the setup wizard', st.wizard && /setup not done/.test(st.status), st.wizard ? 'wizard shown' : 'no wizard');
      check('Platform is android, layout 1280 px wide (beta.12: Automatic text size on a handheld)', st.os === 'android' && st.w === 1280, `${st.os}, ${st.w}px`);
      check('Talks to the native side', st.calls > 0, st.calls + ' calls');
      // this stand-in has no second screen: the shelf must not send the bottom screen anything (no wasted work per game)
      const bpost = await page.evaluate(() => (window.__calls || []).filter(c => /bottomPost/.test(c)).length);
      check('No bottom screen: nothing is sent to it', bpost === 0, bpost + ' bottomPost call(s)');
      check('No script errors at start', !errors.length, errors.slice(0, 3).join(' | '));
      say(`Build under test: ${st.build}`);
      await ctx.close(); }

    // ---------- pass 2: the whole Thor flow on the adapter's pretend device ----------
    { const { ctx, page, errors } = await newPage(browser, null);
      const url = base + '?fakeNative=1';
      await page.goto(url); await page.waitForTimeout(5000);
      const setup = await page.evaluate(async () => {
        const api = window.boxshelf, info = await api.getConfig(), det = await api.detect(), c = info.config;
        const dirs = [await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' })];
        c.systems.gc.romDirs = [dirs[0]]; c.systems.gc.emulator = det.systems.gc.emulator;
        c.systems.psx.romDirs = [dirs[1]]; c.systems.psx.emulator = det.systems.psx.emulator;
        c.systems.snes.romDirs = [dirs[2]]; c.systems.snes.emulator = det.systems.snes.emulator;
        c.setupDone = true; await api.saveConfig(c); const lib = await api.scan();
        return { consoles: info.consoles.length, emus: [c.systems.gc.emulator, c.systems.psx.emulator, c.systems.snes.emulator],
          shelves: lib.map(s => ({ id: s.id, titles: s.games.map(g => g.title + ((g.discs || []).length > 1 ? ` [${g.discs.length} discs]` : '')) })) };
      });
      const shelf = id => (setup.shelves.find(s => s.id === id) || { titles: [] }).titles;
      check('29 systems offered on Android', setup.consoles === 29, setup.consoles); // (beta.9: + Sega CD, 32X, Atari 2600, Lynx, WonderSwan, DOS)
      check('Emulators detected (Dolphin, DuckStation, RetroArch)', /dolphin/i.test(setup.emus[0]) && /duckstation/i.test(setup.emus[1]) && /retroarch/i.test(setup.emus[2]), setup.emus.join(', '));
      check('GameCube scan: clean titles', shelf('gc').includes('The Legend of Zelda - The Wind Waker') && shelf('gc').length === 3, shelf('gc').join(' | '));
      check('PlayStation scan: .bin hidden behind .cue, 2-disc game is one box', shelf('psx').length === 2 && shelf('psx').some(t => /\[2 discs\]/.test(t)), shelf('psx').join(' | '));
      check('Apps shelf listed', setup.shelves.some(s => s.id === 'media' && s.titles.length > 0), (setup.shelves.find(s => s.id === 'media') || { titles: [] }).titles.length + ' apps');

      // box art: the scan above starts the background fetch on its own
      const art = await page.evaluate(async () => {
        const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 60 && !(api.artProgress().total && !api.artProgress().running); i++) await wait(250);
        const lib = await api.cachedLibrary(), games = lib.filter(s => s.kind === 'console').flatMap(s => s.games.map(g => ({ sys: s.id, title: g.title, file: g.file, art: g.art || {} })));
        return { prog: api.artProgress(), games, fetch: __fakeArt.fetch, thumb: __fakeArt.thumb, dirs: __fakeArt.dirs, index: __fakeArt.index, ss: __fakeArt.ss.length };
      });
      const noFront = art.games.filter(g => !g.art.front), pik = art.fetch.find(f => /^Pikmin/.test(f.name)) || { urls: [] }, zel = art.fetch.find(f => /^Legend of Zelda/.test(f.name)) || { urls: [] };
      const pikG = art.games.find(g => /^Pikmin/.test(g.title)) || { art: {} }, wrap = art.fetch.find(f => f.split && /^Pikmin/.test(f.name)) || { urls: [] };
      check('Box art requested after a scan', art.fetch.length > 0 && art.index > 0, `${art.fetch.length} downloads, ${art.index} libretro lists, ${art.prog.done}/${art.prog.total} done`);
      check('Every game gets a front cover (art.front)', art.games.length && !noFront.length, noFront.length ? 'missing: ' + noFront.map(g => g.title).join(', ') : `${art.games.length} games`);
      check('Sources: GameTDB by disc id first, then libretro by name', /art\.gametdb\.com\/wii\/coverHQ\/US\/GPIE01\.png/.test(pik.urls[0] || '') && /thumbnails\.libretro\.com\/Nintendo%20-%20GameCube\/Named_Boxarts\/Legend%20of%20Zelda/.test(zel.urls[0] || '') && pikG.art.disc,
        [pik.urls[0], zel.urls[0]].join(' , ').slice(0, 170));
      check('Full box art: GameTDB full cover kept as "-full", cut into back + spine', wrap.name === 'Pikmin (USA)-full' && /coverfullHQ\/US\/GPIE01/.test(wrap.urls[0] || '') && pikG.art.back && pikG.art.spine && !art.ss,
        `${wrap.name || 'no wrap'} · back ${!!pikG.art.back}, spine ${!!pikG.art.spine} · ScreenScraper calls without an account: ${art.ss}`);
      check('"Boxshelf Art" folder made inside the picked ROM folder', art.dirs.includes('primary:ROMs/gc/Boxshelf Art') && art.dirs.includes('primary:ROMs/psx/Boxshelf Art'), art.dirs.join(', '));
      check('Art already in "Boxshelf Art" (or the PC\'s "covers" folder) is re-used, not downloaded', art.thumb.includes('Super Metroid (Japan, USA)') && art.thumb.includes('Chrono Trigger (USA)') && !art.fetch.some(f => /^(Super Metroid|Chrono Trigger)/.test(f.name)), 're-used: ' + art.thumb.join(', '));

      // a ScreenScraper account: backs, spines and discs for the other consoles, the sign-in only ever added natively
      const ss = await page.evaluate(async () => {
        const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms)), c = (await api.getConfig()).config;
        // (beta.10) an account but no developer login (Boxshelf's own or the player's): the test says so, nothing is sent
        c.keys = Object.assign({}, c.keys, { ssUser: 'me', ssPass: 'secret' }); await api.saveConfig(c);
        const noDev = await api.testApi('screenscraper'), noDevCalls = __fakeArt.ss.length;
        c.keys = Object.assign({}, c.keys, { ssDevId: 'dev', ssDevPass: 'dp' }); await api.saveConfig(c);
        const t = await api.testApi('screenscraper'); await wait(1500); for (let i = 0; i < 80 && api.artProgress().running; i++) await wait(250);
        const psx = (await api.cachedLibrary()).find(s => s.id === 'psx').games.map(g => g.art || {});
        return { noDev, noDevCalls, t, psx, calls: __fakeArt.ss.length, signed: __fakeArt.ss.every(x => x.ss), dl: __fakeArt.fetch.filter(f => f.ss).length,
          leaked: __fakeArt.fetch.some(f => /sspassword|secret/.test(f.urls.join(' '))) || __fakeArt.ss.some(x => /sspassword|secret/.test(x.url)) };
      });
      check('ScreenScraper (account set): test works, PlayStation gets back + spine + disc, sign-in added only natively', ss.t && ss.t.state === 'ok' && ss.psx.every(a => a.back && a.spine && a.disc) && ss.signed && ss.dl > 0 && !ss.leaked,
        `test ${ss.t && ss.t.state}, ${ss.calls} lookups, ${ss.dl} downloads, leaked ${ss.leaked}`);
      check('ScreenScraper without a developer login: the test says so ("Not available yet"), nothing is sent', ss.noDev && ss.noDev.state === 'fail' && /no developer login/.test(ss.noDev.msg) && ss.noDevCalls === 0,
        JSON.stringify({ noDev: ss.noDev, calls: ss.noDevCalls }));

      // (beta.10) review fixes: the demo's pretend features are gone, links really open (https only), the start-up check says
      // "unchanged", Rename works and is undone, a removed folder's permission is given back, a pick Android won't keep says so
      const fx = await page.evaluate(async () => {
        const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        out.gone = ['updateCheck', 'checkManuals', 'onManualCheck', 'clipStatus', 'clipHelper', 'customThemes', 'customThemeCreate', 'customThemesOpen'].filter(k => k in api);
        out.open = await api.openExternal('https://example.com/help').then(() => 'ok', e => e.message);
        out.http = await api.openExternal('http://example.com/').then(() => 'opened', e => (/https/.test(e.message) ? 'refused' : e.message));
        out.urls = (window.__fakeCalls || []).filter(c => /^openUrl:/.test(c));
        await api.scan(); const same = await api.scanIfChanged(); out.same = !!(same && same.unchanged);
        const zel = (await api.cachedLibrary()).find(s => s.id === 'gc').games.find(g => /Wind Waker/.test(g.title)) || {};
        await api.renameGame({ systemId: 'gc', file: zel.file, title: '  My   Zelda ' }); const ren = await api.scanIfChanged();
        const rz = ren && !ren.unchanged ? ren.find(s => s.id === 'gc').games.find(g => g.file === zel.file) : null; out.renamed = rz ? [rz.title, rz.fileTitle] : ren;
        const c0 = (await api.getConfig()).config; delete c0.games; await api.saveConfig(c0); out.kept = ((await api.getConfig()).config.games || {})['gc:' + zel.file]; // (an older copy of the settings doesn't undo it)
        await api.renameGame({ systemId: 'gc', file: zel.file, title: '' }); const back = (await api.scan()).find(s => s.id === 'gc').games.find(g => g.file === zel.file); out.back = [back.title, back.fileTitle || null];
        const c = (await api.getConfig()).config, snes = c.systems.snes.romDirs.slice(), uri = (window.BS_FOLDERS() || {})[snes[0]]; window.__fakeReleased = [];
        c.systems.snes.romDirs = []; await api.saveConfig(c); await wait(50); out.released = (window.__fakeReleased || []).includes(uri);
        c.systems.snes.romDirs = snes; await api.saveConfig(c); await api.scan(); // (put back for the rest of the pass)
        const gcN = lib => ((lib || []).find(s => s.id === 'gc') || { games: [] }).games.length, nGc = gcN(await api.cachedLibrary());
        window.__fakeListFail = true; const lost = await api.scan().catch(() => null); window.__fakeListFail = false;
        out.unread = [nGc, gcN(lost), gcN(await api.cachedLibrary())]; await api.scan();
        const said = [], t0 = Shelf.toast; Shelf.toast = m => { said.push(String(m)); return t0(m); }; // (what the shelf was asked to say, whatever else says something after)
        window.__fakePersistFail = true; window.__fakePickNext = 'primary:ROMs/gc'; out.pick = await api.pick({ kind: 'folder' }); await wait(100);
        Shelf.toast = t0; out.warn = said.join(' | ');
        return out; });
      check('Android: the demo\'s pretend updates, manual check, trailer clips and custom themes are gone; links open in the browser (https only)',
        !fx.gone.length && fx.open === 'ok' && fx.http === 'refused' && fx.urls.join() === 'openUrl:https://example.com/help', JSON.stringify(fx).slice(0, 400));
      check('Android: the start-up check answers "unchanged" when nothing changed (no library compared on the page), and a rename counts as a change',
        fx.same && Array.isArray(fx.renamed) && fx.renamed[0] === 'My Zelda' && /Wind Waker/.test(fx.renamed[1] || ''), JSON.stringify({ same: fx.same, renamed: fx.renamed }));
      check('Android: Rename keeps the name (a later settings save doesn\'t undo it) and "back to the file\'s name" undoes it',
        fx.kept && fx.kept.title === 'My Zelda' && /Wind Waker/.test(fx.back[0]) && fx.back[1] === null, JSON.stringify({ kept: fx.kept, back: fx.back }));
      check('Android: a games folder that can\'t be read (permission lost, SD card out) keeps its games on the shelf and in the saved library',
        Array.isArray(fx.unread) && fx.unread[0] > 0 && fx.unread[1] === fx.unread[0] && fx.unread[2] === fx.unread[0], JSON.stringify(fx.unread));
      check('Android: a games folder removed in Settings gives its permission back; a pick Android won\'t keep says so', fx.released && /keep access to that folder/.test(fx.warn) && !!fx.pick,
        JSON.stringify({ released: fx.released, warn: fx.warn.slice(0, 80), pick: fx.pick }));

      await page.goto(url); await page.waitForTimeout(7000);
      await page.screenshot({ path: path.join(OUT, '2-shelf.png') });
      const shown = await page.evaluate(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        const imgs = () => [...document.querySelectorAll('.slot .f-front img')].filter(i => /__art\/\d\.jpg/.test(i.src));
        out.real = imgs().length; out.loaded = imgs().filter(i => i.complete && i.naturalWidth > 0).length;
        await wait(2500); out.again = __fakeArt.fetch.length + __fakeArt.thumb.length; out.index = __fakeArt.index; // the start-up rescan found nothing missing
        // a picture arriving while the shelf is up: the cases swap their cover in place (same elements, nothing rebuilt)
        const lib = await window.boxshelf.cachedLibrary(), before = [...document.querySelectorAll('.slot')];
        lib.filter(s => s.kind === 'console').forEach(s => s.games.forEach((g, i) => { __bsArtFound(g.id, 'front', `__art/${(i + 1) % 4}.jpg?swap`); __bsArtFound(g.id, 'spine', `__art/${i % 4}.jpg?spine`); }));
        const upd = Shelf.artUpdated; out.swapped = 0; Shelf.artUpdated = ids => (out.swapped += upd(ids)); // count what the adapter hands the shelf
        // (beta.7) covers swap in one per frame once decoded: on a slow or busy machine that takes longer than a fixed 2.5 s, so
        // wait (up to 15 s) until every case handed a new cover shows it
        const fronts = () => [...document.querySelectorAll('.slot .f-front img')].filter(i => /\?swap$/.test(i.src)).length;
        const spinesNow = () => [...document.querySelectorAll('.slot .f-left .spine-img')].filter(i => /\?spine$/.test(i.src)).length; // (full box art: a spine that came later)
        await wait(2500); for (let i = 0; i < 50 && (fronts() < out.swapped || spinesNow() < out.swapped); i++) await wait(250);
        Shelf.artUpdated = upd;
        const after = [...document.querySelectorAll('.slot')];
        out.same = before.length === after.length && before.every((e, i) => e === after[i]);
        out.swapSrc = fronts();
        out.spines = spinesNow();
        return out;
      });
      check('Box art shows on the shelf (after a restart, nothing downloaded again)', shown.real >= 2 && shown.loaded === shown.real && shown.again === 0, `${shown.loaded}/${shown.real} covers loaded, ${shown.again} new downloads`);
      check('Second art run after a restart: 0 downloads, 0 libretro list fetches', shown.again === 0 && shown.index === 0, `${shown.again} downloads / re-reads, ${shown.index} list fetches`);
      const studio = await page.evaluate(() => ({ on: ['artStudio', 'artCandidates', 'artUse', 'artOwn', 'artUndo', 'chooseArt'].filter(k => typeof window.boxshelf[k] === 'function').length,
        off: ['artRelease'].filter(k => typeof window.boxshelf[k] === 'function') }));
      check('Art Studio backed on Android (0.3.3: with the LaunchBox database and sets)', studio.on === 6 && !studio.off.length, `${studio.on}/6 · ${studio.off.join(', ')}`);
      // Art Studio on a game (as the quick menu's "Change art" opens it): its versions as cards; Enter, ← , Enter picks one
      const pkG = await page.evaluate(async () => (await window.boxshelf.cachedLibrary()).find(s => s.id === 'gc').games.find(g => /^Pikmin/.test(g.title)));
      await page.evaluate(g => Setup.open({ page: 'artgame', systemId: 'gc', file: g.file, title: g.title }), pkG); await page.waitForTimeout(3500);
      const sUi = await page.evaluate(() => ({ cards: document.querySelectorAll('.bsa-card').length, pics: [...document.querySelectorAll('.bsa-card img')].filter(i => i.complete && i.naturalWidth).length }));
      await page.screenshot({ path: path.join(OUT, '2-art-studio.png') });
      await page.keyboard.press('Enter'); await page.waitForTimeout(500); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(400); await page.keyboard.press('Enter'); await page.waitForTimeout(1800);
      const sPick = await page.evaluate(async id => { const g = (await window.boxshelf.cachedLibrary()).find(s => s.id === 'gc').games.find(x => x.id === id); return { front: g.art.front, saved: __fakeArt.saved.map(x => x.name) }; }, pkG.id);
      check('Art Studio opens on a game with every version, and saves a pick (Boxshelf Art + shelf)', sUi.cards >= 3 && sUi.pics >= 3 && sPick.saved[0] === 'Pikmin (USA)' && /~/.test(sPick.front || ''),
        `${sUi.cards} cards, ${sUi.pics} pictures · saved ${sPick.saved.join(', ') || 'nothing'}`);
      for (let i = 0; i < 6 && await page.evaluate(() => !!document.querySelector('#bss.on')); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(500); }
      check("New art swaps onto the cases in place (no shelf rebuild), spines too", shown.swapped > 0 && shown.same && shown.swapSrc === shown.swapped && shown.spines === shown.swapped, `${shown.swapped} cases swapped, ${shown.swapSrc} show it, ${shown.spines} new spines, elements kept: ${shown.same} ${shown.dbg||""}`);
      // performance guards (Thor): fixed facts that keep the lag from coming back, not frame timings (this runner draws in
      // software, so its fps would say nothing about the Thor's GPU)
      const pf = await page.evaluate(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        // nothing may keep making WebGL contexts while the shelf runs (0.2.5's Perf bug made one per performance-level read)
        let gl = 0; const og = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (t, ...a) { if (/webgl/.test(t)) gl++; return og.call(this, t, ...a); };
        for (let i = 0; i < 30; i++) { if (window.Perf) Perf.get(); }
        await wait(2000); HTMLCanvasElement.prototype.getContext = og; out.glNew = gl;
        out.dpr = devicePixelRatio; out.real = window.__bsRealDpr ? window.__bsRealDpr() : 0;
        out.level = window.Perf ? Perf.get().level : '?'; out.why = window.Perf ? Perf.detect().why : ''; out.fx = document.body.classList.contains('fx');
        out.cases = document.querySelectorAll('.slot').length; out.qmReady = !!document.getElementById('quickMenu');
        const phys = Math.round(innerWidth * devicePixelRatio) * Math.round(innerHeight * devicePixelRatio);
        out.canvases = [...document.querySelectorAll('canvas')].filter(c => c.width * c.height > 0).map(c => ({ w: c.width, h: c.height, cls: c.className || c.id || 'canvas' }));
        out.oversized = out.canvases.filter(c => c.w * c.h > phys * 1.05); out.phys = phys;
        // a 20-step shelf scroll: worst frame is reported for the log only
        let worst = 0, prev = performance.now(), on = true; (function f(t) { if (!on) return; worst = Math.max(worst, t - prev); prev = t; requestAnimationFrame(f); })(prev);
        for (let i = 0; i < 20; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await wait(120); }
        on = false; out.worst = Math.round(worst); return out;
      });
      check('Pixel ratio matches the scaled layout (1920 / 1280)', Math.abs(pf.dpr - 1920 / 1280) < .02 && pf.real > 2, `page ${pf.dpr}x, device ${pf.real}x`);
      // this runner draws in software, where Automatic correctly picks Low; on the Thor's GPU it picks Handheld
      const want = /software/.test(pf.why) ? 'low' : 'handheld';
      check('Automatic performance level for Android, effects mode off', pf.level === want && !pf.fx, `${pf.level} (${pf.why}), effects ${pf.fx ? 'on' : 'off'}`);
      check('Live cases on the shelf ≤ 11', pf.cases > 0 && pf.cases <= 11, pf.cases + ' cases');
      check('No canvas larger than the screen', !pf.oversized.length, pf.oversized.length ? pf.oversized.map(c => `${c.cls} ${c.w}x${c.h}`).join(', ') : `${pf.canvases.length} canvases, all ≤ screen`);
      check('No WebGL contexts made while idling (performance level is read once)', pf.glNew === 0, pf.glNew + ' new contexts in 2 s');
      check('Quick menu pre-built before first open', pf.qmReady, pf.qmReady ? 'ready' : 'built on first press');
      say(`Shelf scroll worst frame here (software GPU, for reference only): ${pf.worst} ms`);
      // the bottom screen follows the shelf: one message once the shelf rests (not one per step of the scroll above)
      const bs = await page.evaluate(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        await wait(900);
        const msgs = window.__fakeBottom || [], last = msgs[msgs.length - 1], g = last && last.game;
        out.n = msgs.length; out.sent = g && g.title; out.cur = Shelf._qs().g; out.front = !!(g && g.art && g.art.front); out.style = !!(g && g.style && g.style.ratio);
        const n0 = msgs.length; __fakeN.fireBottom({ type: 'cmd', cmd: 'next' }); await wait(1500);
        if (Shelf._qs().g === out.cur) { __fakeN.fireBottom({ type: 'cmd', cmd: 'prev' }); await wait(1500); } // already on the last game
        out.moved = Shelf._qs().g; const m2 = (window.__fakeBottom || [])[window.__fakeBottom.length - 1];
        out.followed = window.__fakeBottom.length > n0 && m2 && m2.game && m2.game.title === out.moved;
        __fakeN.fireBottom({ type: 'cmd', cmd: 'details' }); await wait(500); out.details = Shelf.getMode();
        __fakeN.fireBottom({ type: 'cmd', cmd: 'details' }); await wait(500); out.back = Shelf.getMode();
        __fakeN.fireBottom({ type: 'cmd', cmd: 'rm -rf' }); await wait(100); // unknown commands are ignored
        // a bottom-screen button while the quick menu is open: the menu closes first (the shelf never moves behind it)
        Shelf.quickMenu(); await wait(600); out.qmOpen = Shelf._qs().open; const g0 = Shelf._qs().g;
        __fakeN.fireBottom({ type: 'cmd', cmd: g0 === out.moved ? 'prev' : 'next' }); await wait(900); out.qmAfter = Shelf._qs().open;
        return out;
      });
      check('Bottom screen gets the selected game (once the shelf rests)', bs.n >= 1 && bs.n <= 4 && bs.sent === bs.cur && bs.front && bs.style, `${bs.n} message(s), last "${bs.sent}", shelf on "${bs.cur}", cover ${bs.front ? 'yes' : 'no'}`);
      check('Bottom screen button closes an open quick menu first', bs.qmOpen === true && bs.qmAfter === false, `menu open ${bs.qmOpen} → ${bs.qmAfter}`);
      check('Bottom screen buttons drive the shelf (next / previous, details)', bs.moved !== bs.cur && bs.followed && bs.details === 'details' && bs.back === 'browse', `next → "${bs.moved}" (sent back ${bs.followed ? 'yes' : 'no'}), details ${bs.details} → ${bs.back}`);
      const run = await page.evaluate(async () => {
        const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        const lib = await api.cachedLibrary(), first = id => (lib.find(s => s.id === id) || { games: [] }).games[0];
        out.launch = {};
        for (const id of ['gc', 'psx', 'snes']) { const g = first(id); if (!g) { out.launch[id] = 'no game'; continue; }
          try { await api.launchGame(id, g.file); out.launch[id] = window.__fakeLaunches[window.__fakeLaunches.length - 1]; } catch (e) { out.launch[id] = 'ERROR ' + e.message; } }
        await wait(3600); // past the 1.5 s after a game where Home only brings you back
        __fakeN.fireHome(); await wait(500); out.homeOpens = Shelf.quickMenuOpen();
        __fakeN.fireHome(); await wait(400); out.homeCloses = !Shelf.quickMenuOpen();
        out.power = api.powerOptions().map(o => o[1]);
        await api.power('exitHome'); window.__fakeIsHome = true; await api.quit(); window.__fakeIsHome = false;
        out.calls = window.__fakeCalls || [];
        const g = first('gc'); await api.launchGame('gc', g.file); await wait(1700); __fakeN.fireHome(); await wait(400); out.afterGameMenu = Shelf.quickMenuOpen();
        await wait(600); out.hist = (await api.history())[g.id] || null; // (0.3.2: the PC's shape, so Home / Most played / play time work)
        return out;
      });
      const L = run.launch, ok = (r, pkg, test) => r && typeof r === 'object' && r.pkg === pkg && test(r);
      check('Launch GameCube → Dolphin with the game', ok(L.gc, 'org.dolphinemu.dolphinemu', r => /^content:/.test((r.extras || {}).AutoStartFile || '')), JSON.stringify(L.gc).slice(0, 160));
      check('Launch PlayStation → DuckStation with the game', ok(L.psx, 'com.github.stenzek.duckstation', r => /^content:/.test((r.extras || {}).bootPath || '')), JSON.stringify(L.psx).slice(0, 160));
      check('Launch SNES → RetroArch with the right core', ok(L.snes, 'com.retroarch.aarch64', r => /snes9x_libretro_android\.so$/.test((r.extras || {}).LIBRETRO || '')), JSON.stringify(L.snes).slice(0, 160));
      check('Home key on the shelf opens / closes the quick menu', run.homeOpens && run.homeCloses, `opens ${run.homeOpens}, closes ${run.homeCloses}`);
      check('Home key returning from a game does not open the menu', run.afterGameMenu === false, run.afterGameMenu);
      check('Play history in the PC\'s shape: every start counted, time played in ms, last played in ms', !!run.hist && run.hist.count >= 2 && run.hist.ms > 1000 && run.hist.last > 1e12 && !('minutes' in run.hist), JSON.stringify(run.hist));
      check('Quick menu power options (Android)', /^Exit to /.test(run.power[0] || '') && run.power.includes('Android settings'), run.power.join(', '));
      check('Exit / Close go to the previous launcher', run.calls.filter(c => /^launchHome:/.test(c)).length >= 2, run.calls.join(', '));
      // (0.3.2) the quick menu's order on the Thor: Museum, Art Studio, Trophies first; then Customize, Assets, Sounds (+ volume), Sort
      const qmo = await page.evaluate(async () => { const wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 20 && Shelf.getMode() !== 'browse'; i++) await wait(250);
        Shelf.quickMenu(); for (let i = 0; i < 20 && !Shelf._qs().open; i++) await wait(150); await wait(300);
        const seq = [...document.querySelectorAll('.qm-list > *')].filter(e => !e.classList.contains('qm-hl') && !e.classList.contains('qm-acts')).map(e => e.classList.contains('qm-sep') ? '|' : ((e.querySelector('.qm-lbl') || {}).textContent || '').trim()).filter(Boolean); // (a row's sub-panel has no label of its own)
        const first = Shelf._qs().id; Shelf.homeButton(); await wait(400); return { seq: seq.join(','), first }; });
      check('Quick menu (Thor): Find a game, Museum, Art Studio, Trophies on top; then Customize, Assets, Sounds, Volume, Sort; the highlight starts on Museum',
        /^Find a game,Museum,Art Studio,Trophies,\|,Customize,Assets,Sounds,Volume,Sort & filter,\|,Settings,Power$/.test(qmo.seq) && qmo.first === 'mus', JSON.stringify(qmo));

      await page.keyboard.press('s'); await page.waitForTimeout(2000); await page.keyboard.type('home'); await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: path.join(OUT, '3-settings-home.png') });
      check('Settings: "Use Boxshelf as the Home screen" row', /Use Boxshelf as the Home screen/.test(text));
      check('Settings: Windows-only rows hidden', !/Start Boxshelf with Windows/.test(text));
      for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
      await page.keyboard.type('art'); await page.waitForTimeout(1200);
      const artText = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: path.join(OUT, '4-settings-art.png') });
      check('Settings: box art switches (auto, full box art) and "Fetch missing art now"', /Fetch box art automatically/.test(artText) && /Full box art \(backs & spines\)/.test(artText) && /Fetch missing art now/.test(artText) && !/Download box art now/.test(artText));
      check('Settings: "Where box art is saved" changeable, one full box art switch', /Where box art is saved/.test(artText) && (artText.match(/Full (box|case) art/g) || []).length === 1, (artText.match(/Where box art is saved.{0,40}/) || ['missing'])[0]);
      for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
      await page.keyboard.type('manual'); await page.waitForTimeout(1200);
      const manText = await page.evaluate(() => document.body.innerText);
      // Accounts & services says where backs, spines and discs come from (and that the PC's covers folders work)
      const acctLead = await page.evaluate(() => { const s = window.BS_SETTINGS_PATCH([{ id: 'art', rows: [] }, { id: 'acct', rows: [] }], {}); return s[1].lead || ''; });
      check('Settings: manuals on Android (automatic, per console, "Download manuals now"; no PC-only Manual Studio)', /Fetch manuals automatically/.test(manText) && /Manuals: GameCube/.test(manText) && /Download manuals now/.test(manText) && !/Manuals by console/.test(manText),
        (manText.match(/Fetch manuals automatically|Manuals: \w+|Download manuals now/g) || []).join(', '));
      check('Settings: Accounts & services explains where backs, spines and discs come from', /libretro/.test(acctLead) && /GameTDB/.test(acctLead) && /ScreenScraper/.test(acctLead) && /covers/.test(acctLead), acctLead.slice(0, 120));
      // IGDB (0.3.1): Client ID, Client Secret (hidden) and a Test row, after ScreenScraper
      const igRows = await page.evaluate(() => { const s = window.BS_SETTINGS_PATCH([{ id: 'art', rows: [] }, { id: 'acct', rows: [{ t: 'action', label: 'ScreenScraper', status: 'screenscraper' }] }], {});
        return s[1].rows.map(r => (r.t === 'head' ? '#' + r.text : r.label) + (r.secret ? '*' : '') + (r.t === 'text' && typeof r.set === 'function' ? '=' : '')); });
      check('Settings: IGDB rows on Android (Client ID, hidden Secret, Test), after ScreenScraper', igRows.join('|') === 'ScreenScraper|#IGDB|IGDB Client ID=|IGDB Client Secret*=|Test IGDB|#LaunchBox|LaunchBox art database', igRows.join(' | ')); // (LaunchBox's row: 0.3.3)
      for (let i = 0; i < 3 && await page.evaluate(() => !!document.querySelector('#bss.on')); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(500); }
      await page.keyboard.press('s'); await page.waitForTimeout(1500); await page.keyboard.type('bottom'); await page.waitForTimeout(1200);
      const text2 = await page.evaluate(() => document.body.innerText);
      check('Settings: "Bottom screen" row (device has one)', /Bottom screen/.test(text2));
      // (0.3.4) the handheld Settings, as the mock: seven sections, two columns (no info column), the focused row explains
      // itself, the console-OS look (a solid highlight, no glow); old deep links still land on the right sections and rows
      const hs = await page.evaluate(async () => { const wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        const shut = async () => { if (window.Settings && Settings.isOpen && Settings.isOpen()) { await Settings.close(); await wait(700); } };
        const at = async pg => { await shut(); Setup.open({ page: pg }); for (let i = 0; i < 30 && !document.querySelector('#bss.on'); i++) await wait(150); await wait(700);
          const cur = document.querySelector('.bss-row.cur .nm'); return { title: (document.querySelector('.bss-title') || {}).textContent, row: cur ? cur.textContent.trim() : '' }; };
        out.bottom = await at('bottom');
        out.navs = [...document.querySelectorAll('.bss-nav span:first-of-type')].map(e => e.textContent).join('|');
        out.info = getComputedStyle(document.querySelector('.bss-info')).display;
        const d = document.querySelector('.bss-row.cur .desc'); out.desc = !!d && getComputedStyle(d).display !== 'none' && d.textContent.length > 10;
        out.hl = getComputedStyle(document.querySelector('.bss-hl')).backgroundImage === 'none' && getComputedStyle(document.querySelector('.bss-hl')).boxShadow === 'none';
        out.museum = (await at('museum')).title; out.reading = (await at('reading')).title; out.perf = (await at('perf')).title; out.acct = (await at('acct')).title;
        await at('sound'); out.bootLen = [...document.querySelectorAll('.bss-row .nm')].some(e => e.textContent.trim() === 'Boot screen length'); // (0.3.5)
        await shut(); return out; });
      check('Settings (0.3.5): a "Boot screen length" row (the console boot screens hold longer on the Thor)', hs.bootLen, String(hs.bootLen));
      check('Settings (Thor): seven sections in order, no info column, the focused row explains itself, a solid highlight',
        hs.navs === 'Games|Art Studio|Shelf & museum|Display & sound|Controls & screens|Accounts|System' && hs.info === 'none' && hs.desc && hs.hl, JSON.stringify(hs).slice(0, 300));
      check('Settings (Thor): old links land in the merged sections (bottom → Controls & screens at its row, museum, reading, perf, acct)',
        hs.bottom.title === 'Controls & screens' && hs.bottom.row === 'Bottom screen' && hs.museum === 'Shelf & museum' && hs.reading === 'Games' && hs.perf === 'Display & sound' && hs.acct === 'Accounts', JSON.stringify(hs));
      // the real bottom page in a frame (as on the Thor's second screen): it shows the shelf's game, and its own buttons work
      await page.goto(url + '&bottomPreview=1'); await page.waitForTimeout(6500);
      const fr = page.frame({ url: /bottom\.html/ });
      let e2e = { err: 'no bottom frame' };
      if (fr) {
        const shelfG = await page.evaluate(() => Shelf._qs().g), shown = await fr.evaluate(() => bsBottom.state().title);
        await fr.evaluate(() => document.querySelector('.nav.next').click()); await page.waitForTimeout(1800);
        if (await page.evaluate(() => Shelf._qs().g) === shelfG) { await fr.evaluate(() => document.querySelector('.nav.prev').click()); await page.waitForTimeout(1800); }
        const moved = await page.evaluate(() => Shelf._qs().g), shown2 = await fr.evaluate(() => bsBottom.state().title);
        const before = await page.evaluate(() => window.__fakeLaunches.length);
        await fr.evaluate(() => document.querySelector('.play').click()); await page.waitForTimeout(1200);
        const after = await page.evaluate(() => window.__fakeLaunches.length);
        await page.screenshot({ path: path.join(OUT, '4-bottom-preview.png') });
        e2e = { shelfG, shown, moved, shown2, launched: after - before };
      }
      check('Bottom page shows the shelf\'s game; its ‹ › and Play work', e2e.shown === e2e.shelfG && e2e.moved !== e2e.shelfG && e2e.shown2 === e2e.moved && e2e.launched === 1, JSON.stringify(e2e).slice(0, 180));
      await page.waitForTimeout(1800); // the pretend game "ends"
      // the bottom page's quick ways in: Game details (0.3.2; was Screen settings) opens the game's Details on the big screen,
      // Art Studio this game's art
      let quick = { err: 'no bottom frame' };
      if (fr) {
        const leave = async () => { for (let i = 0; i < 9 && await page.evaluate(() => Shelf.getMode() !== 'browse' || !!(window.BS_STUDIO && BS_STUDIO.isOpen())); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(700); } };
        await fr.evaluate(() => document.getElementById('detBtn').click());
        for (let i = 0; i < 20 && await page.evaluate(() => Shelf.getMode() !== 'details'); i++) await page.waitForTimeout(250);
        quick = await page.evaluate(() => ({ mode: Shelf.getMode() }));
        quick.noSettings = await fr.evaluate(() => !document.getElementById('bsetBtn') && !!document.getElementById('detBtn')); // (on the bottom page itself)
        await leave();
        const g = await page.evaluate(() => { const x = Shelf._qs(); return x.g; });
        await fr.evaluate(() => document.getElementById('artBtn').click()); await page.waitForTimeout(2500);
        quick.art = await page.evaluate(t => ({ mode: Shelf.getMode(), open: !!(window.BS_STUDIO && BS_STUDIO.isOpen()), studio: /Art Studio|Front|Back|Spine/.test(document.body.innerText) && document.body.innerText.includes(t) }), g);
        quick.game = g; await leave(); quick.back = await page.evaluate(() => Shelf.getMode()); quick.closedLeft = await page.evaluate(() => !!(window.BS_STUDIO && BS_STUDIO.isOpen()));
      }
      check('Bottom page: Game details opens the game\'s Details on the big screen; Art Studio (handheld) opens on the big screen', quick.mode === 'details' && quick.noSettings && quick.art && quick.art.open && quick.art.studio && quick.back === 'browse' && !quick.closedLeft, JSON.stringify(quick).slice(0, 200));
      // (0.3.5) your own shortcuts, through the real shelf: Add → An app lists the device's apps and its tile opens that app;
      // Add → A console, and its tile goes to that console's shelf
      let own = { err: 'no bottom frame' };
      if (fr) {
        const addOwn = (kind, notKey) => fr.evaluate(async ([kind, notKey]) => { const w = ms => new Promise(r => setTimeout(r, ms)), q = s => document.querySelector(s);
          bsBottom.setTab('more'); await w(300); if (!bsBottom.state().editing) q('#scEditBtn').click(); await w(200);
          q(`.sc-kind[data-kind="${kind}"]`).click(); let it = []; for (let i = 0; i < 60 && !(it = [...document.querySelectorAll('.sc-item')]).length; i++) await w(150);
          const b = it.find(x => x.dataset.add !== notKey), key = b ? b.dataset.add : null; if (b) b.click(); await w(150); q('#scEditBtn').click(); await w(300);
          return { n: it.length, keys: it.map(x => x.dataset.add).slice(0, 6), key }; }, [kind, notKey]);
        const tap = k => fr.evaluate(k => { const t = document.querySelector(`#more .tile[data-sc="${k}"]`); if (t) t.click(); return !!t; }, k);
        const l0 = await page.evaluate(() => window.__fakeLaunches.length);
        own.app = await addOwn('app', ''); own.appTile = await tap(own.app.key); await page.waitForTimeout(900);
        own.launched = await page.evaluate(n => window.__fakeLaunches.slice(n).map(x => x.pkg).join(), l0); await page.waitForTimeout(1500); // (the pretend app "closes")
        own.from = await page.evaluate(() => Shelf.artFocus(false).sys);
        own.shelf = await addOwn('shelf', 'shelf:' + own.from); own.shelfTile = await tap(own.shelf.key);
        for (let i = 0; i < 24 && await page.evaluate(k => Shelf.artFocus(false).sys !== k, String(own.shelf.key).slice(6)); i++) await page.waitForTimeout(250);
        own.to = await page.evaluate(() => Shelf.artFocus(false).sys);
        await fr.evaluate(() => bsBottom.setTab('case'));
      }
      check('Bottom page (0.3.5): your own shortcuts: an app (its tile opens it) and a console (its tile goes to that shelf)',
        own.app && own.app.n >= 2 && /^app:/.test(own.app.key || '') && own.appTile && own.launched === String(own.app.key).slice(4) && own.shelf && own.shelfTile && own.to === String(own.shelf.key).slice(6) && own.to !== own.from,
        JSON.stringify(own).slice(0, 400));
      // the museum: the bottom page becomes its companion (the row on the wall); a touch there chooses a case on the wall,
      // and unwrapping there unwraps it on the wall too. Leaving the museum brings the usual page back.
      let mus = { err: 'no bottom frame' };
      if (fr) {
        await page.keyboard.press('m'); await page.waitForTimeout(7000);
        // new games arrive in the museum as a parcel first (the pretend game above counts): skip the unpacking, then wait
        // for the bottom screen's message about the wall
        await page.evaluate(async () => { const wait = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 6 && window.Museum && Museum._dv && Museum._dv(); i++) { Museum.skipDelivery(); await wait(800); }
          for (let i = 0; i < 40; i++) { const l = [...(window.__fakeBottom || [])].reverse().find(m => m.type === 'museum'); if (l && l.row.sel >= 0) break; await wait(250); } });
        await page.waitForTimeout(800);
        mus = await page.evaluate(() => { const msgs = window.__fakeBottom || [], last = [...msgs].reverse().find(m => m.type === 'museum'), r = window.Museum && Museum.bottomRow && Museum.bottomRow();
          return { mode: Shelf.getMode(), types: msgs.map(m => m.type[0]).join(''), msg: !!last, games: last ? last.games.length : 0, sel: last ? last.row.sel : null, n: r ? r.boxes.length : 0, title: last && last.game ? last.game.title : '', hud: last && last.hud ? last.hud.title || '' : '' }; });
        Object.assign(mus, await fr.evaluate(() => { const s = bsBottom.state(); return { on: s.museum, items: s.mitems, shown: s.mtitle }; }));
        const to = mus.n > 1 ? (mus.sel === 1 ? 0 : 1) : -1;
        if (to >= 0) { await fr.evaluate(i => { const b = document.querySelector(`.mi[data-i="${i}"]`); const r = b.getBoundingClientRect(), o = { bubbles: true, pointerId: 7, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
            b.dispatchEvent(new PointerEvent('pointerdown', o)); b.dispatchEvent(new PointerEvent('pointerup', o)); }, to); await page.waitForTimeout(1600); }
        mus.picked = await page.evaluate(() => { const r = Museum.bottomRow(); return r ? r.sel : null; });
        mus.wasSealed = await page.evaluate(i => { const r = Museum.bottomRow(); return !!(r && r.boxes[i] && r.boxes[i].sealed); }, mus.picked);
        if (mus.wasSealed) { await fr.evaluate(() => { const b = document.querySelector('[data-m="unwrap"]'); if (b) b.click(); }); await page.waitForTimeout(1800); }
        mus.nowSealed = await page.evaluate(i => { const r = Museum.bottomRow(); return !!(r && r.boxes[i] && r.boxes[i].sealed); }, mus.picked);
        // (the bottom page hears once the unwrap has played on the wall: at ~1 frame a second of software drawing that can take a while)
        for (let i = 0; i < 40 && await fr.evaluate(() => bsBottom.state().msealed); i++) await page.waitForTimeout(300);
        mus.frameSealed = await fr.evaluate(() => bsBottom.state().msealed);
        // racing along the shelf (a held stick: a step every 60 ms): no covers start loading and at most one picture goes to
        // the graphics card a frame while the cases flash past; once you stop, the covers around you load. Then back to the
        // case chosen above (the checks below hold it).
        mus.race = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); window.__musNoDraw = true; /* (software drawing here manages a frame every second or two: time the museum's own work) */
          for (let k = 0, ok = 0; k < 16 && ok < 2; k++) { Museum.move(k % 2 ? -1 : 1, 0); Museum._perf(true); await w(700); ok = Museum._perf(false).n >= 15 ? ok + 1 : 0; } Museum._perf(true); // (until the frames that were already queued have drained)
          for (let i = 0; i < 24; i++) { Museum.move(i < 12 ? 1 : -1, 0); await w(60); } const run = Museum._perf(true);
          for (let k = 0; k < 10; k++) { await w(500); if (k >= 2 && !Museum._perf(false).pending) break; } const rest = Museum._perf(false); window.__musNoDraw = false; return { rn: run.rn, rFr: run.rFr, rUp: run.rUpMax, trimsRacing: run.trim, pending: rest.pending, restCovers: rest.fr }; });
        await page.evaluate(i => Museum.pickCol(i), mus.picked); await page.waitForTimeout(900);
        // A lifts the case into your hands: the bottom page still shows it (so Unwrap / Play there act on the case you hold)
        await page.keyboard.press('Enter'); await page.waitForTimeout(1600);
        mus.held = await page.evaluate(() => { const r = Museum.bottomRow(); return { held: Museum.isHoldingCase(), sel: r ? r.sel : null }; });
        mus.heldCard = await fr.evaluate(() => !!document.querySelector('#mCard .mc-case'));
        // touch on the bottom page: a drag turns the case in your hands, Put back puts it back, Pick up lifts it again
        const pillTap = label => fr.evaluate(async l => { for (let i = 0; i < 30; i++) { const b = [...document.querySelectorAll('.mpill')].find(x => x.textContent.trim() === l); if (b) { b.click(); return true; } await new Promise(r => setTimeout(r, 100)); } return false; }, label);
        await fr.evaluate(async () => { for (let i = 0; i < 30 && !bsBottom.state().mheld; i++) await new Promise(r => setTimeout(r, 100)); });
        mus.turn0 = await page.evaluate(() => Museum._cam && JSON.stringify(Museum._cam()));
        await fr.evaluate(async () => { const wl = document.querySelector('.m-wall'), w = ms => new Promise(r => setTimeout(r, ms)), ev = (t, x) => wl.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 41, clientX: x, clientY: 200 }));
          ev('pointerdown', 300); for (let i = 1; i <= 6; i++) { await w(60); ev('pointermove', 300 + i * 50); } ev('pointerup', 600); });
        await page.waitForTimeout(400);
        mus.turned = await fr.evaluate(() => window.__bsSent.filter(m => m.cmd === 'mturn').length);
        mus.putBack = await pillTap('Put back'); await page.waitForTimeout(1200);
        mus.afterPut = await page.evaluate(() => Museum.isHoldingCase());
        mus.lift = await pillTap('Pick up'); await page.waitForTimeout(1200);
        mus.afterLift = await page.evaluate(() => Museum.isHoldingCase());
        await pillTap('Put back'); await page.waitForTimeout(1000);
        // the Room drawer: a lighting button changes the room on the wall (and is saved)
        const light0 = await page.evaluate(() => Museum.lighting());
        mus.room = await fr.evaluate(async l => { const w = ms => new Promise(r => setTimeout(r, ms)); document.getElementById('roomBtn').click(); await w(400);
          const c = [...document.querySelectorAll('.chip[data-k="light"]')].find(x => x.dataset.v !== l); if (c) c.click(); await w(100); document.querySelector('.mr-x').click(); return c ? c.dataset.v : null; }, light0);
        await page.waitForTimeout(900);
        mus.lightNow = await page.evaluate(() => ({ l: Museum.lighting(), saved: window.Shelf && Shelf._cfg ? null : undefined }));
        // (0.3.5) Box art from the bottom page: the handheld Art Studio on the chosen case, over the museum; closing it comes
        // back to the museum (its wall refreshed), and the bottom page is the companion again
        mus.artBtn = await pillTap('Box art');
        mus.art = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms));
          for (let i = 0; i < 40 && !(window.BS_STUDIO && BS_STUDIO.isOpen()); i++) await w(150);
          const st = BS_STUDIO.isOpen() && BS_STUDIO._state(), c = Museum.current(), r = { open: BS_STUDIO.isOpen(), part: st && st.part, mode: Shelf.getMode(), refresh: typeof Museum.refreshArt === 'function' };
          r.n = Museum.refreshArt([c && c.game && c.game.id], () => null); BS_STUDIO.close(); await w(1200); r.after = Shelf.getMode(); r.studio = BS_STUDIO.isOpen(); return r; });
        mus.artBack = await fr.evaluate(async () => { for (let i = 0; i < 40 && !bsBottom.state().museum; i++) await new Promise(r => setTimeout(r, 150)); return bsBottom.state().museum; });
        // a row down from the bottom page
        const row0 = await page.evaluate(() => (Museum.bottomRow() || {}).row);
        await pillTap('Row down'); await page.waitForTimeout(900);
        mus.rows = [row0, await page.evaluate(() => (Museum.bottomRow() || {}).row), await page.evaluate(() => (Museum.bottomRow() || {}).rows)];
        try { await page.screenshot({ path: path.join(OUT, '4-bottom-museum.png'), timeout: 8000 }); } catch {} // (the museum draws in software here: slow)
        for (let i = 0; i < 4 && await page.evaluate(() => Shelf.getMode() === 'museum'); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(900); }
        await page.waitForTimeout(1500); mus.after = await fr.evaluate(() => bsBottom.state().museum); mus.modeAfter = await page.evaluate(() => Shelf.getMode());
      }
      // (the museum can open on a row with no case chosen yet: then the companion shows the row's own words, as the wall does)
      check('Bottom page becomes the museum\'s companion (its row, the chosen case)', mus.mode === 'museum' && mus.msg && mus.games > 0 && mus.on && mus.items === mus.games && !!mus.shown && mus.shown === (mus.sel >= 0 ? mus.title : mus.hud), JSON.stringify(mus).slice(0, 300));
      check('Museum fast scroll: no cover loads and at most one upload a frame while racing; covers load once it rests', !!mus.race && mus.race.rn > 0 && mus.race.rFr === 0 && mus.race.rUp <= 1 && mus.race.pending === 0, JSON.stringify(mus.race));
      check('Bottom page: a touch chooses a case on the wall; Unwrap unwraps it there too', mus.n > 1 && mus.picked === (mus.sel === 1 ? 0 : 1) && mus.wasSealed && !mus.nowSealed && !mus.frameSealed, `picked ${mus.picked}, sealed ${mus.wasSealed} → ${mus.nowSealed} (bottom ${mus.frameSealed})`);
      check('Bottom page: the case in your hands stays chosen there', mus.held && mus.held.held && mus.held.sel === mus.picked && mus.heldCard, JSON.stringify(mus.held) + ', card ' + mus.heldCard);
      check('Bottom page: in your hands a drag turns the case; Put back / Pick up work on the wall', mus.turned > 0 && mus.putBack && mus.afterPut === false && mus.lift && mus.afterLift === true, `turn msgs ${mus.turned}, put back ${mus.afterPut}, lifted ${mus.afterLift}`);
      check('Bottom page: a Room lighting button changes the room live; Row down steps the wall', mus.room && mus.lightNow && mus.lightNow.l === mus.room && mus.rows && (mus.rows[2] < 2 || mus.rows[1] === mus.rows[0] + 1), `light → ${mus.room} (now ${mus.lightNow && mus.lightNow.l}), rows ${JSON.stringify(mus.rows)}`);
      check('Museum (0.3.5): the bottom page\'s Box art opens the Art Studio on the chosen case; closing it is back in the museum',
        mus.artBtn && mus.art && mus.art.open && mus.art.part === 'front' && mus.art.mode === 'museum' && mus.art.refresh && mus.art.n === 1 && mus.art.after === 'museum' && !mus.art.studio && mus.artBack === true,
        `button ${mus.artBtn}, ${JSON.stringify(mus.art)}, companion again ${mus.artBack}`);
      check('Leaving the museum brings the usual bottom page back', mus.after === false && mus.modeAfter === 'browse', `museum view ${mus.after}, mode ${mus.modeAfter}`);
      // (0.3.3) the LaunchBox database on the device: Settings says the size first; building it reports the download and the
      // sort; the consoles on the shelves are indexed; Art Studio then offers LaunchBox's scans (every region, a spine cut from
      // the full box, fan art marked) and the automatic fetch uses them
      const lbx = await page.evaluate(async () => { const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms)), out = {};
        out.before = (await api.artIndexInfo()).state;
        const row = window.BS_SETTINGS_PATCH([{ id: 'art', rows: [{ t: 'action', label: 'Fetch missing art now' }] }, { id: 'acct', rows: [] }], {})[0].rows.find(r => r.label === 'LaunchBox art database');
        out.btn = row && (typeof row.btn === 'function' ? row.btn() : row.btn); out.sub = row && row.sub().text;
        const prog = []; const off = api.onArtIndex(p => { if (p) prog.push(p.phase); });
        const info = await api.artBuildIndex(); off(); out.info = info; out.phases = [...new Set(prog)].join(',');
        out.plats = (window.__fakeLb || {}).plats || [];
        const lib = await api.cachedLibrary(), pik = lib.find(s => s.id === 'gc').games.find(g => /^Pikmin/.test(g.title));
        const c = async part => (await api.artCandidates({ systemId: 'gc', file: pik.file, part })).list.filter(x => x.source === 'launchbox');
        const f = await c('front'), sp = await c('spine'), d = await c('disc');
        out.front = f.map(x => x.region + (x.label.includes('Fan art') ? '/fan' : '')).join(','); out.spine = sp.length; out.disc = d.length;
        out.fanLast = f.length > 1 && f[f.length - 1].label.includes('Fan art') && f[f.length - 1].score.authentic < f[0].score.authentic;
        out.sub2 = row && row.sub().text;
        const grp = await window.__bsLbGroup('gc', pik.file, 'front'), back = await window.__bsLbGroup('gc', pik.file, 'back');
        out.fetched = grp.urls.length >= 2 && /pik-front-us/.test(grp.urls[0]) && !grp.urls.some(u => /fan/.test(u)) && /pik-back-us/.test(back.urls[0] || '');
        out.grp = grp.urls.map(u => u.split('/').pop()).join(',');
        // (0.3.3) matching sets: LaunchBox has all four of Pikmin's parts in one region → a complete set; putting it in
        // saves all four as picks; Undo set puts them back
        const ss = (await api.artSets({ systemId: 'gc', file: pik.file })).sets; out.sets = ss.map(s => s.id).join(',');
        const usa = ss.find(s => s.id === 'usa-launchbox'); out.setLabel = usa && usa.label; out.setParts = usa ? Object.values(usa.parts).filter(c => c && c.key).length : 0;
        const ex = L => Object.values(L || {}).filter(l => l && l.look === 'exact').length;
        out.beforeLocks = ex(((await api.artGames({ systemId: 'gc' })).find(x => x.file === pik.file) || {}).lock); // (the front picked earlier in this run)
        const n0 = __fakeArt.saved.length; const used = usa ? await api.artUseSet({ systemId: 'gc', file: pik.file, setId: 'usa-launchbox' }) : null;
        out.used = used ? used.changed.length : 0; out.savedSet = __fakeArt.saved.slice(n0).map(x => x.name).join(',');
        out.locks = used ? Object.values(used.lock).filter(l => l && l.look === 'exact').length : 0;
        const undone = used ? await api.artUndoSet({ systemId: 'gc', file: pik.file }) : null; out.undoLocks = undone ? Object.values(undone.lock || {}).filter(l => l && l.look === 'exact').length : -1;
        // a console look applied: Complete sets · USA re-picks the GameCube shelf in the background, with progress (Pikmin's own
        // front pick is let go first, so its whole set can go in: a part you picked yourself is never changed by a look)
        await api.artMix({ systemId: 'gc', file: pik.file, part: 'front', look: 'shelf' });
        const evs = []; const offJ = api.onArtJob(j => evs.push(j));
        const r = await api.artStyle({ systemId: 'gc', style: { preset: 'sets', region: 'usa' } }); out.jobId = !!(r && r.jobId); out.style = r && r.style && r.style.preset;
        for (let i = 0; i < 240 && !evs.some(e => e.id === r.jobId && e.state !== 'run'); i++) await wait(250);
        offJ(); const last = evs.filter(e => e.id === r.jobId).pop() || {}; out.job = { state: last.state, done: last.done, total: last.total, sets: last.sets && last.sets.set };
        return out; });
      check('Matching sets: LaunchBox\'s four Pikmin parts in one region make a complete set; putting it in saves all four as picks; Undo set puts them back',
        /usa-launchbox/.test(lbx.sets) && /\bhd\b/.test(lbx.sets) && lbx.setLabel === 'USA · LaunchBox · complete' && lbx.setParts === 4 && lbx.used === 4 && lbx.savedSet.split(',').length === 4 && lbx.locks === 4 && lbx.undoLocks === lbx.beforeLocks,
        JSON.stringify({ sets: lbx.sets, used: lbx.used, saved: lbx.savedSet, locks: lbx.locks, undo: lbx.undoLocks, before: lbx.beforeLocks }));
      check('A console look applied: Complete sets · USA re-picks the shelf in the background (progress events, complete sets put in)',
        lbx.jobId && lbx.style === 'sets' && lbx.job.state === 'done' && lbx.job.done === lbx.job.total && lbx.job.total > 0 && lbx.job.sets >= 1, JSON.stringify(lbx.job));
      check('LaunchBox database: Settings says the size first; building it reports the download and sort; the shelves\' consoles are indexed',
        lbx.before === 'missing' && /110 MB/.test(lbx.btn || '') && /about 110 MB/.test(lbx.sub || '') && /download/.test(lbx.phases) && /read/.test(lbx.phases) && lbx.info && lbx.info.state === 'ready' && lbx.plats.includes('Nintendo GameCube') && /Ready/.test(lbx.sub2 || ''),
        JSON.stringify(lbx).slice(0, 300));
      check('LaunchBox in Art Studio: every region\'s front (own region first, fan art last and ranked lower), backs / spines / discs', /^usa,jpn/.test(lbx.front) && /fan/.test(lbx.front) && lbx.fanLast && lbx.spine >= 2 && lbx.disc >= 1, JSON.stringify({ front: lbx.front, spine: lbx.spine, disc: lbx.disc, fanLast: lbx.fanLast }));
      check('LaunchBox in the automatic fetch: real scans only, the game\'s own region first (front and back)', lbx.fetched, lbx.grp);
      check('No script errors in the Thor flow', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }
    // ---------- pass 3: touch gestures (android-touch.js): swipe back, pinch to zoom ----------
    // Real touch input through Chromium's DevTools protocol, the same path a finger takes (touch + pointer events).
    // This runner draws in software: Inspect's WebGL case (with the art pictures on it) takes seconds per frame here, which
    // starved the pinch's touch events until the run timed out. The gestures don't depend on how the case is drawn
    // (pinch sets the same zoom either way), so this pass uses Inspect's CSS case (Inspect3D reports itself unavailable).
    { const { ctx, page, errors } = await newPage(browser, "addEventListener('DOMContentLoaded',()=>{if(window.Inspect3D)window.Inspect3D.available=()=>false});");
      const url = base + '?fakeNative=1';
      await page.goto(url); await page.waitForTimeout(4000);
      await page.evaluate(async () => { const api = window.boxshelf, info = await api.getConfig(), det = await api.detect(), c = info.config;
        c.systems.gc.romDirs = [await api.pick({ kind: 'folder' })]; c.systems.gc.emulator = det.systems.gc.emulator; c.setupDone = true; await api.saveConfig(c); await api.scan(); });
      await page.goto(url); await page.waitForTimeout(6000);
      const cdp = await ctx.newCDPSession(page);
      // where a touch lands in page pixels (the layout is 1440 wide): measured once, so the gestures below use page pixels
      await page.evaluate(() => { window.__tp = null; addEventListener('touchstart', e => { window.__tp = window.__tp || [e.touches[0].clientX, e.touches[0].clientY]; }, { capture: true, once: true }); });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 100 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const k = 100 / ((await page.evaluate(() => window.__tp)) || [100])[0];
      await page.waitForTimeout(400);
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q[0] * k, y: q[1] * k, id: i })) });
      const pause = ms => page.waitForTimeout(ms);
      async function swipe(x0, y0, x1, y1, steps = 10, hold) { await touch('touchStart', [[x0, y0]]); for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); await pause(16); }
        if (hold) await hold(); await touch('touchEnd', []); await pause(700); }
      async function pinch(cx, cy, d0, d1, steps = 10) { const P = d => [[cx - d / 2, cy], [cx + d / 2, cy]]; await touch('touchStart', P(d0)); for (let i = 1; i <= steps; i++) { await touch('touchMove', P(d0 + (d1 - d0) * i / steps)); await pause(24); } await touch('touchEnd', []); await pause(600); }
      const st = () => page.evaluate(() => { const z = window.BS_TOUCH && BS_TOUCH.zoom(); return { scr: window.BS_TOUCH ? BS_TOUCH.screen() : '?', zoom: z && z.get ? z.get() : null, title: document.getElementById('gTitle').textContent }; });
      const [W, H] = await page.evaluate(() => [innerWidth, innerHeight]);
      const key = async (k, ms = 900) => { await page.keyboard.press(k); await pause(ms); };

      // the shelf: a sideways swipe browses games, and even one from the screen edge never means Back
      const s0 = await st(); await swipe(W * .7, H * .5, W * .3, H * .5); const s1 = await st();
      await swipe(4, H * .5, 300, H * .5); const s2 = await st(), arrowLive = await page.evaluate(() => { const a = document.getElementById('bsBackSwipe'); return !!a && +getComputedStyle(a).opacity > .05; });
      check('Touch: swiping the shelf browses games, never goes Back', s0.scr === 'shelf' && s1.title !== s0.title && s2.scr === 'shelf' && s2.title !== s1.title && !arrowLive, `${s0.title} → ${s1.title} → ${s2.title}, still ${s2.scr}${arrowLive ? ', back arrow showed' : ''}`);

      // Details: from the right edge (with a look at the arrow mid-swipe), from the left edge, and a plain swipe left
      await key('i'); const d0 = await st(); let arrow = null;
      await swipe(W - 6, H * .45, W - 150, H * .45, 10, async () => { await pause(120); arrow = await page.evaluate(() => { const a = document.getElementById('bsBackSwipe'), cs = a && getComputedStyle(a);
        return a && { on: a.classList.contains('on'), op: +cs.opacity, tf: a.style.transform, other: [...a.style].filter(p => !/^(transform|opacity)$/.test(p)) }; });
        await page.screenshot({ path: path.join(OUT, '4-swipe-back.png') }); });
      const d1 = await st(); await key('i'); await swipe(4, H * .5, 200, H * .5); const d2 = await st();
      check('Touch: edge swipe closes Details (either edge)', d0.scr === 'details' && d1.scr === 'shelf' && d2.scr === 'shelf', `${d0.scr} → ${d1.scr}; again → ${d2.scr}`);
      check('Touch: back arrow follows the finger (transform / opacity only) and lights up', arrow && arrow.on && arrow.op > .9 && /translate3d/.test(arrow.tf) && !arrow.other.length, JSON.stringify(arrow));
      await key('i'); await swipe(W * .6, H * .5, W * .6 + 180, H * .5); const p1 = await st();
      await swipe(W * .6, H * .5, W * .6 - 180, H * .52, 8); const p2 = await st();
      check('Touch: quick swipe left closes Details, swipe right does not', p1.scr === 'details' && p2.scr === 'shelf', `right: ${p1.scr}, left: ${p2.scr}`);

      // the quick menu: a swipe left on the menu itself closes it
      await page.evaluate(() => __fakeN.fireHome()); await pause(700);
      const qr = await page.evaluate(() => { const r = document.getElementById('quickMenu').getBoundingClientRect(); return { open: Shelf.quickMenuOpen(), x: r.left + r.width * .7, y: r.top + r.height * .5 }; });
      await swipe(qr.x, qr.y, qr.x - 170, qr.y + 6, 8); const q1 = await page.evaluate(() => Shelf.quickMenuOpen());
      check('Touch: swipe left closes the quick menu', qr.open && !q1, `open ${qr.open} → ${q1}`);

      // Settings: an edge swipe steps back out
      await key('s', 2000); const g0 = await st(); await swipe(W - 4, H * .4, W - 240, H * .4); await pause(600); const g1 = await st();
      check('Touch: edge swipe closes Settings', g0.scr === 'setup' && g1.scr === 'shelf', `${g0.scr} → ${g1.scr}`);

      // Inspect: two fingers zoom the case (out, back in to the limit); a one-finger drag still turns it, not Back
      await key('ArrowRight', 600); await key('ArrowRight', 600); await key('v', 1500); const i0 = await st();
      await pinch(W / 2, H / 2, 200, 500); const i1 = await st();
      await swipe(W * .6, H * .5, W * .6 - 220, H * .5); const i2 = await st();
      await pinch(W / 2, H / 2, 600, 120); const i3 = await st();
      await swipe(4, H * .5, 260, H * .5); const i4 = await st();
      check('Touch: pinch zooms the case in Inspect', i0.scr === 'inspect' && i1.zoom > i0.zoom * 2 && i2.scr === 'inspect' && i3.zoom <= .9, `${i0.zoom} → ${i1.zoom && i1.zoom.toFixed(2)} → ${i3.zoom && i3.zoom.toFixed(2)}, drag kept ${i2.scr}`);
      check('Touch: edge swipe leaves Inspect', i4.scr !== 'inspect', `${i3.scr} → ${i4.scr}`);

      // the touch that wakes a dimmed screen is used up by the input gate (perf.js): it only wakes, it never goes Back
      await key('i'); await page.evaluate(() => { const g = window.BS_INPUT_GATE; window.__gate = g; let once = true;
        window.BS_INPUT_GATE = e => { if (once && e.type === 'pointerdown') { once = false; return true; } return g(e); }; });
      await swipe(W - 4, H * .5, W - 240, H * .5); const w1 = await st(); await page.evaluate(() => { window.BS_INPUT_GATE = window.__gate; });
      await swipe(W - 4, H * .5, W - 240, H * .5); const w2 = await st();
      check('Touch: the touch that wakes the screen does not go Back', w1.scr === 'details' && w2.scr === 'shelf', `used-up touch: ${w1.scr}; next: ${w2.scr}`);

      // with a controller in use (the Thor's own), a swipe Back keeps the controller's button prompts instead of keyboard keys
      await key('i'); await page.evaluate(() => { const pad = { id: 'Thor pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }; window.__pad = pad;
        Object.defineProperty(navigator, 'getGamepads', { configurable: true, writable: true, value: () => [pad] }); });
      await pause(400);
      // a short press (a tap: under 450 ms) of the d-pad; repeated, since this software-drawn page can run at a few fps and miss one
      // (beta.7: each tap is held until the page has read it, at most 400 ms, and up to 10 taps: four fixed 200 ms taps
      // all fell between the controller reads on a build machine drawing a few frames a second)
      for (let n = 0; n < 10 && !(await page.evaluate(() => document.body.classList.contains('pad-input'))); n++)
        await page.evaluate(async () => { const t0 = performance.now(); __pad.buttons[15] = { pressed: true, value: 1 }; __pad.timestamp++;
          while (performance.now() - t0 < 400 && !document.body.classList.contains('pad-input')) await new Promise(r => setTimeout(r, 20));
          __pad.buttons[15] = { pressed: false, value: 0 }; __pad.timestamp++; await new Promise(r => setTimeout(r, 400)); });
      const padOn = () => page.evaluate(() => document.body.classList.contains('pad-input'));
      const c0 = await padOn(); await swipe(W - 4, H * .5, W - 240, H * .5); const c1 = await st(), c2 = await padOn();
      check('Touch: swipe Back keeps the controller prompts', c0 && c1.scr === 'shelf' && c2, `pad prompts ${c0} → ${c2}, ${c1.scr}`);
      check('No script errors during touch gestures', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }
    // ---------- pass 3m: the museum on the top screen by touch (android-touch.js + BS_TOUCH.museum + Museum.pickAt) ----------
    // Real touch input through DevTools, as in pass 3. The wall isn't drawn (__musNoDraw: software drawing here takes
    // seconds a frame); the camera and cases still move, so taps hit what would be on screen.
    { const { ctx, page, errors } = await newPage(browser, 'window.__musNoDraw = true;');
      const url = base + '?fakeNative=1&fakeMany=1'; // (three consoles, 30+ games each: rows long enough to drag along)
      await page.goto(url); await page.waitForTimeout(4000);
      await page.evaluate(async () => { const api = window.boxshelf, c = (await api.getConfig()).config, det = await api.detect();
        const dirs = [await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' })];
        for (const [i, id] of ['gc', 'psx', 'snes'].entries()) { c.systems[id].romDirs = [dirs[i]]; c.systems[id].emulator = det.systems[id].emulator; }
        c.setupDone = true; await api.saveConfig(c); await api.scan(); });
      await page.goto(url); await page.waitForTimeout(5000);
      const cdp = await ctx.newCDPSession(page);
      await page.evaluate(() => { window.__tp = null; addEventListener('touchstart', e => { window.__tp = window.__tp || [e.touches[0].clientX, e.touches[0].clientY]; }, { capture: true, once: true }); });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 100 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const k = 100 / ((await page.evaluate(() => window.__tp)) || [100])[0];
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q[0] * k, y: q[1] * k, id: i })) });
      const pause = ms => page.waitForTimeout(ms);
      async function drag(x0, y0, x1, y1, steps, quick) { await touch('touchStart', [[x0, y0]]); for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); await pause(quick ? 8 : 30); }
        if (!quick) await pause(250); await touch('touchEnd', []); }
      async function tap(x, y) { await touch('touchStart', [[x, y]]); await pause(60); await touch('touchEnd', []); }
      const [W, H] = await page.evaluate(() => [innerWidth, innerHeight]), STEP = Math.max(40, W * .055); // android-touch.js's finger travel per case
      const ms = () => page.evaluate(() => { const r = Museum.bottomRow() || {}; return { mode: Shelf.getMode(), row: r.row, rows: r.rows, sel: r.sel, n: (r.boxes || []).length, wide: !!r.wide, held: Museum.isHoldingCase() }; });
      // the camera glides slowly in this software-drawn runner: wait for it before aiming a tap
      const settle = () => page.evaluate(async () => { let still = 0, px = null; for (let i = 0; i < 60 && still < 3; i++) { await new Promise(r => setTimeout(r, 250)); const c = Museum._cam(), near = Math.abs(c.x - c.tx) + Math.abs(c.y - c.ty) + Math.abs(c.z - c.tz) < .03; still = near && px != null && Math.abs(c.x - px) < .002 ? still + 1 : 0; px = c.x; } }); // (its target is picked up a frame or two after a move: wait until it's been still a while)
      // into the museum (new games arrive as a parcel: skip it), and up to the first case of a long row
      await page.keyboard.press('m'); await pause(6000);
      await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 6 && Museum._dv && Museum._dv(); i++) { Museum.skipDelivery(); await w(800); } if (Museum.isFilling()) Museum.skipFill(); await w(600); Museum.pickCol(0); await w(600);
        const r = Museum.bottomRow(); if (r && r.boxes.length < 8 && r.rows > 1) { Museum.move(0, 1); await w(600); Museum.pickCol(0); } });
      await settle(); const a = await ms();
      await drag(W * .8, H * .55, W * .8 - STEP * 3.5, H * .55, 12); await pause(900); const b = await ms();          // a slow drag: 3 cases
      await page.evaluate(() => Museum.pickCol(0)); await pause(900);
      await drag(W * .8, H * .55, W * .8 - STEP * 1.6, H * .55, 5, true); await pause(2500); const c = await ms();    // a flick of 1.6 cases' travel
      // a tap on another case on this row chooses it; a tap on the chosen one picks it up
      await page.evaluate(() => Museum.pickCol(0)); await settle();
      const find = want => page.evaluate(([W, H, want]) => { const r = Museum.bottomRow(), by = {}; // every point on each case; aim at the one nearest its middle
        for (let y = H * .25; y < H * .85; y += 12) for (let x = 60; x < W - 60; x += 12) { const p = Museum.pickAt(x, y); if (p && p.row === r.row && (want === 'sel' ? p.sel : !p.sel && p.col > 0)) (by[p.col] = by[p.col] || []).push([x, y]); }
        const col = Object.keys(by).sort((a, b) => by[b].length - by[a].length)[0]; if (col == null) return null; const pts = by[col], mx = pts.reduce((s, q) => s + q[0], 0) / pts.length, my = pts.reduce((s, q) => s + q[1], 0) / pts.length;
        const best = pts.reduce((m, q) => Math.hypot(q[0] - mx, q[1] - my) < Math.hypot(m[0] - mx, m[1] - my) ? q : m); return { x: best[0], y: best[1], col: +col }; }, [W, H, want]);
      // aim, then make sure the point still hits that case a moment later (the slow software camera can still drift a
      // hair after settle(), and a tap on the edge of a case then lands on its neighbour): aim again until it holds
      let tgt = null;
      for (let n = 0; n < 4; n++) { tgt = await find('other'); if (!tgt) break; await pause(700);
        const still = await page.evaluate(([x, y]) => { const p = Museum.pickAt(x, y); return p ? p.col : null; }, [tgt.x, tgt.y]);
        if (still === tgt.col) break; await settle(); }
      let d = null, e = null, f = null, g = null;
      if (tgt) { await tap(tgt.x, tgt.y); await pause(600); await settle(); d = await ms();
        const t2 = await find('sel'); if (t2) { await tap(t2.x, t2.y); await pause(1800); e = await ms();
          await drag(W * .5, H * .5, W * .5 + 200, H * .45, 8); await pause(600); f = await ms();                   // a drag turns the case in your hands
          await drag(W - 4, H * .5, W - 260, H * .5, 10); await pause(1500); g = await ms(); } }                     // the edge swipe puts it back
      const h = await ms(); await drag(W * .5, H * .7, W * .5, H * .7 - 120, 6); await pause(1200); const i = await ms(); // a swipe up: the row below
      let left = null; for (let n = 0; n < 4; n++) { await drag(W - 4, H * .5, W - 260, H * .5, 10); await pause(1500); left = await ms(); if (left.mode !== 'museum') break; }
      const want = Math.min(3, a.n - 1 - a.sel), flickOk = c.n < 5 || c.sel - 0 >= 2;
      check('Museum touch: a drag along the shelf steps the chosen case one per case-width', a.mode === 'museum' && a.sel === 0 && b.sel === a.sel + want, `sel ${a.sel} → ${b.sel} (want +${want} of ${a.n})`);
      check('Museum touch: a flick keeps stepping past the finger\'s travel', flickOk, `flick of 1.6 cases → sel ${c.sel}`);
      check('Museum touch: a tap chooses a case, a tap on the chosen one picks it up (A)', !!tgt && d && d.sel === tgt.col && e && e.held, JSON.stringify({ tgt, d: d && d.sel, held: e && e.held }));
      check('Museum touch: a drag turns the held case; the edge swipe puts it back, then leaves the museum', f && f.held && g && !g.held && g.mode === 'museum' && left && left.mode !== 'museum', JSON.stringify({ turnHeld: f && f.held, back: g && [g.held, g.mode], left: left && left.mode }));
      check('Museum touch: a swipe up goes to the row below', i.row === (h.rows > h.row + 1 ? h.row + 1 : h.row), `row ${h.row} → ${i.row} of ${h.rows}`);
      check('No script errors in museum touch', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }

    // ---------- pass 5: smoothness guards (Thor feedback on 0.2.7: art loading in, stutter between cases, quick menu lag,
    // Inspect turning slowly). The demo shelf (?shelf=1, 15 cases: more than the built window) with picture covers.
    // Facts about what the page does, not frame times (this runner draws in software).
    { const INIT = `(() => { let v; window.__libs = []; let n = 0;
        // who asks for animation frames (only while a test counts): the shelf's controller reader, the theme layer, the rest
        const R0 = window.requestAnimationFrame.bind(window); window.__rafBy = null;
        window.requestAnimationFrame = function (fn) { if (window.__rafBy) { const s = (new Error().stack || '').split('\\n').slice(1).find(l => !/requestAnimationFrame|perf-meter\\.js/.test(l)) || '', k = /^\\s*at poll \\(/.test(s) ? 'poll' : /themefx\\.js/.test(s) ? 'themefx' : 'other'; window.__rafBy[k] = (window.__rafBy[k] || 0) + 1; } return R0(fn); }; // (by the function that asked directly)
        const add = lib => { (lib || []).forEach(sh => (sh.games || []).forEach(g => { g.art = Object.assign({}, g.art, { front: '/__art/' + (n++ % 4) + '.jpg' }); })); window.__libs.push(lib); return lib; };
        Object.defineProperty(window, 'boxshelf', { configurable: true, get() { return v; }, set(x) { v = x; if (x && x.scan && !x.__t) { x.__t = 1; const s = x.scan.bind(x); x.scan = async (...a) => add(await s(...a));
          if (x.cachedLibrary) { const c = x.cachedLibrary.bind(x); x.cachedLibrary = async (...a) => add(await c(...a)); } } } });
        // every cover put on a case face: when, in which frame, mid-slide or not, and whether that picture was decoded first
        window.__frame = 0; (function f() { window.__frame++; requestAnimationFrame(f); })();
        window.__dec = new Set(); const od = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = function () { const u = this.src; return od.call(this).then(r => { window.__dec.add(u); return r; }); };
        const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get() { return d.get.call(this); }, set(val) {
          try { if (window.__sw && this.__t) { const u = new URL(val, location.href).href; window.__sw.push({ f: window.__frame, busy: !!(window.BS_BUSY && BS_BUSY()), dec: window.__dec.has(u) }); } } catch {}
          d.set.call(this, val); } });
        // a pretend controller (Inspect's stick turn): only while a test holds it
        window.__pad = { id: 'Test pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
        const gp = Navigator.prototype.getGamepads; Navigator.prototype.getGamepads = function () { if (window.__padOn && window.__polls) window.__polls.push(performance.now()); return window.__padOn ? [window.__pad, null, null, null] : (gp ? gp.call(this) : []); }; // on the prototype: the phone remote (tv-input.js) wraps that one
        addEventListener('DOMContentLoaded', () => { if (window.Inspect3D) window.Inspect3D.available = () => false; }); })();`;
      const { ctx, page, errors } = await newPage(browser, INIT);
      page.setDefaultTimeout(120000);
      await page.bringToFront(); // the pad is only read while the page has focus (Inspect's stick checks below)
      await page.goto(base + '?platform=android&shelf=1'); await page.waitForTimeout(7000);
      const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      const sm = await page.evaluate(async key => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), out = {}, K = new Function('return ' + key)();
        const slots = () => document.querySelectorAll('#track .slot').length;
        // 1. a step builds no case in its own task; the window is filled in right after
        const mo = new MutationObserver(() => {}); mo.observe(document.getElementById('track'), { childList: true });
        out.before = slots(); K('ArrowRight');
        out.syncAdded = mo.takeRecords().reduce((n, r) => n + [...r.addedNodes].filter(e => e.classList && e.classList.contains('slot')).length, 0);
        await wait(600); out.after = slots(); mo.disconnect();
        // 2. once landed: only the selected case and its neighbours have layers inside their faces (glare band, dark film)
        await wait(900);
        const all = [...document.querySelectorAll('#track .slot')], lay = e => { const g = getComputedStyle(e.querySelector('.glare')), d = getComputedStyle(e.querySelector('.dim')); return g.willChange !== 'auto' || d.willChange !== 'auto'; };
        out.layered = all.filter(lay).length; out.near = all.filter(e => e.classList.contains('near')).length; out.layeredFar = all.filter(e => lay(e) && !e.classList.contains('near')).length;
        // 3. the backdrop changes once the slide has landed, not under the moving cases
        const t0 = performance.now(); let bgAt = 0; const mb = new MutationObserver(() => { if (!bgAt) bgAt = performance.now() - t0; });
        ['bgA', 'bgB'].forEach(id => mb.observe(document.getElementById(id), { attributes: true, attributeFilter: ['class'] }));
        K('ArrowRight'); await wait(1500); mb.disconnect(); out.bgAt = Math.round(bgAt);
        // 4. covers arriving (background box art): decoded first, one per frame, none attached while the shelf slides
        await wait(1200); const ids = new Set();
        (window.__libs || []).forEach(L => (L || []).forEach(sh => (sh.games || []).forEach((g, i) => { if (g.art) { g.art.front = '/__art/' + ((i + 1) % 4) + '.jpg?swap'; ids.add(g.id); } })));
        const faces = [...document.querySelectorAll('#track .slot .f-front img')]; faces.forEach(i => { i.__t = 1; }); // the cases already built
        window.__sw = []; K('ArrowLeft'); out.accepted = Shelf.artUpdated([...ids]);
        await wait(6000); const sw = window.__sw; window.__sw = null;
        const per = {}; sw.forEach(x => per[x.f] = (per[x.f] || 0) + 1);
        out.swaps = sw.length; out.perFrame = Math.max(0, ...Object.values(per)); out.swapBusy = sw.filter(x => x.busy).length; out.swapRaw = sw.filter(x => !x.dec).length;
        out.showing = faces.filter(i => i.isConnected && /\?swap$/.test(i.src)).length;
        // 5. quick menu: the shelf steps aside without scaling (no redraw of every case), and a second open builds no rows
        Shelf.quickMenu(); await wait(900);
        const m = getComputedStyle(document.getElementById('scene')).transform.match(/matrix\(([^)]+)\)/), mv = m ? m[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0];
        out.sceneScale = +Math.hypot(mv[0], mv[1]).toFixed(3); out.sceneX = Math.round(mv[4]);
        K('Escape'); await wait(900);
        const mq = new MutationObserver(() => {}); mq.observe(document.querySelector('#quickMenu .qm-list'), { childList: true, subtree: true });
        Shelf.quickMenu(); out.qmRows = mq.takeRecords().reduce((n, r) => n + r.addedNodes.length, 0); mq.disconnect(); out.qmOpen = Shelf._qs().open;
        await wait(700); K('Escape'); await wait(900);
        // 6. Inspect: a stick pushed all the way turns the case at the handheld speed (per 60 Hz frame: 1.15° on a PC, x2.3 here)
        for (let i = 0; i < 4 && BS_TOUCH.screen() !== 'inspect'; i++) { K('v'); await wait(900); if (BS_TOUCH.screen() !== 'inspect') { K('ArrowRight'); await wait(700); } }
        out.isp = BS_TOUCH.screen();
        if (out.isp === 'inspect') { window.__padOn = true; await wait(300); window.__polls = []; for (let i = 0; i < 60 && window.__polls.length < 3; i++) await wait(50); window.__polls = null; /* (start once the app is reading the pad: a run that begins without focus stalls for the first second) */ const y0 = Shelf._isp().ty; let pf = 0, last = performance.now(), on = true;
          (function f(t) { if (!on) return; pf += Math.min(3, Math.max(.25, (t - last) / 16.667)); last = t; requestAnimationFrame(f); })(last);
          window.__pad.axes[0] = 1; await wait(1000); window.__pad.axes[0] = 0; on = false; out.turn = Shelf._isp().ty - y0; out.turnPerFrame = +(out.turn / Math.max(1, pf)).toFixed(2);
          await wait(300);
          // 7. zoomed in (R2), the right stick turns it just as fast (it used to be divided by the zoom: 2.4x slower at full zoom).
          // Read before letting go (letting go snaps to the nearest side).
          window.__pad.buttons[7] = { pressed: true, touched: true, value: 1 }; for (let i = 0; i < 200 && Shelf._isp().tz < 2.4; i++) await wait(50);
          window.__pad.buttons[7] = { pressed: false, touched: false, value: 0 }; await wait(400); out.zoomTo = +Shelf._isp().tz.toFixed(2);
          // (turn per input frame: each pad read is one, weighted like the app's padF, so a slow software frame here doesn't skew it)
          const frames = () => { const p = window.__polls; let n = 0; for (let i = 1; i < p.length; i++) n += Math.min(3, Math.max(.25, (p[i] - p[i - 1]) / 16.667)); return n; };
          { const y1 = Shelf._isp().ty; window.__polls = [];
            window.__pad.axes[2] = 1; await wait(1000); const y2 = Shelf._isp().ty, pz = frames(); window.__polls = null; window.__pad.axes[2] = 0; out.zoomTurnPerFrame = +((y2 - y1) / Math.max(1, pz)).toFixed(2); }
          window.__pad.buttons[6] = { pressed: true, touched: true, value: 1 }; for (let i = 0; i < 200 && Shelf._isp().tz > .9; i++) await wait(50);
          window.__pad.buttons[6] = { pressed: false, touched: false, value: 0 }; await wait(300); window.__padOn = false;
          // 8. disc out: side to side turns it over in 3D about its own centre (it stays put on screen) instead of swinging it round the case
          for (let i = 0; i < 6 && Shelf._isp().state < 2; i++) { K('Enter'); await wait(1300); } await wait(1200); out.discState = Shelf._isp().state;
          const dc = () => { const r = document.querySelector('.isp-disc-top').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
          const c0 = dc(); K('ArrowRight'); await wait(150); K('ArrowRight'); for (let i = 0; i < 40 && Math.abs(Shelf._isp().ty - Shelf._isp().ry) > 2; i++) await wait(100); await wait(200); const c1 = dc();
          out.discShift = Math.round(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])); out.discSpin = /rotateY\((-?\d+)/.exec(document.getElementById('ispRot').style.transform); out.discSpin = out.discSpin ? +out.discSpin[1] : null;
          K('Escape'); await wait(500); K('Escape'); await wait(500); K('Escape'); await wait(600); }
        return out;
      }, key.toString());
      check('Shelf step builds no case in its own frame (built just after)', sm.syncAdded === 0 && sm.after > sm.before, `${sm.syncAdded} built in the step, cases ${sm.before} → ${sm.after}`);
      check('Only the selected case and its neighbours keep layers inside their faces', sm.layeredFar === 0 && sm.layered <= 3 && sm.near === 3, `${sm.layered} cases with face layers (${sm.layeredFar} outside the 3 near ones)`);
      check('Backdrop changes after the slide lands, not under it', sm.bgAt >= 550, `first backdrop change ${sm.bgAt} ms after the step`);
      check('Arriving covers: decoded first, one per frame, none mid-slide', sm.accepted > 0 && sm.swaps === sm.accepted && sm.showing === sm.accepted && sm.perFrame === 1 && sm.swapBusy === 0 && sm.swapRaw === 0,
        `${sm.swaps}/${sm.accepted} swapped (${sm.showing} showing), max ${sm.perFrame} per frame, ${sm.swapBusy} mid-slide, ${sm.swapRaw} not decoded first`);
      check('Quick menu: the shelf steps aside without scaling', Math.abs(sm.sceneScale - 1) < .002 && sm.sceneX < -100, `scene scale ${sm.sceneScale}, x ${sm.sceneX}px`);
      check('Quick menu: opening it again builds no rows', sm.qmOpen && sm.qmRows === 0, `${sm.qmRows} nodes added on open`);
      // (beta.7) against the speed at rest measured in this same run, not a fixed ceiling: a build machine's uneven frames
      // put one run at 3.31° against a 3.3° limit. The bug this guards against divided the speed by the zoom (~1.1°).
      check('Inspect: zoomed in, the stick turns it as fast as at rest', sm.zoomTo >= 2.3 && sm.zoomTurnPerFrame >= 2 && sm.turnPerFrame > 0 && sm.zoomTurnPerFrame / sm.turnPerFrame >= .7 && sm.zoomTurnPerFrame / sm.turnPerFrame <= 1.45,
        `zoom ${sm.zoomTo}: ${sm.zoomTurnPerFrame}° per frame (at rest ${sm.turnPerFrame}°)`);
      check('Inspect: the disc out turns in 3D about its own centre (side to side turns it over)', sm.discShift <= 12 && sm.discSpin != null && Math.abs(sm.discSpin) >= 60, `state ${sm.discState}: spun ${sm.discSpin}°, centre moved ${sm.discShift}px`);
      check('Inspect: the stick turns the case at the handheld speed', sm.isp === 'inspect' && sm.turnPerFrame >= 2.2, `${sm.isp}: ${Math.round(sm.turn || 0)}° in 1 s, ${sm.turnPerFrame}° per 60 Hz frame`);
      // ---- scroll smoothness (0.3.2): while the shelf slides the page should only make the frames it needs. Facts, not
      // frame times: who asks for animation frames, which animations run on the main thread, what the backdrop does.
      const sc = await page.evaluate(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms)), key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })), out = {};
        for (let i = 0; i < 6 && Shelf.getMode() !== 'browse'; i++) { key('Escape'); await wait(600); } out.mode = Shelf.getMode();
        // 1. the controller held on the shelf is read on a timer: no animation frame asked for every vsync by the reader
        window.__padOn = true; await wait(300); window.__rafBy = {}; const g0 = Shelf._qs().g;
        // (beta.7: held until the shelf has moved, at least 1.5 s and at most 5 s, with the pad's timestamp ticking as a real
        // controller's does; a fixed 1.5 s ended before a slow build machine's reader had acted on it)
        window.__pad.buttons[15] = { pressed: true, touched: true, value: 1 }; window.__pad.timestamp = (window.__pad.timestamp || 0) + 1;
        { const t0 = performance.now(); while (performance.now() - t0 < 5000 && (performance.now() - t0 < 1500 || Shelf._qs().g === g0)) { await wait(100); window.__pad.timestamp++; } }
        window.__pad.buttons[15] = { pressed: false, touched: false, value: 0 }; window.__pad.timestamp++; await wait(400);
        out.padMoved = Shelf._qs().g !== g0; out.pollRaf = window.__rafBy.poll || 0; window.__rafBy = null; window.__padOn = false; await wait(800);
        // 2. 20 steps: a case that stays out of sight (.far, faded out) takes its place at once (.gone): no transform
        // transition on it (Chromium would run that one on the main thread: a restyle and a frame every vsync of the slide)
        out.gone = 0; out.goneSliding = 0; out.goneSeen = 0; out.farFading = 0;
        for (let i = 0; i < 20; i++) { key(i < 10 ? 'ArrowLeft' : 'ArrowRight'); await wait(i % 4 === 3 ? 650 : 130);
          const gone = [...document.querySelectorAll('#track .slot.gone')]; out.gone += gone.length;
          // (one still finishing its fade-out doesn't count: on a slow machine the fade can start late and run past the 0.45 s mark)
          out.goneSeen += gone.filter(e => +getComputedStyle(e).opacity > 0.001 && !e.getAnimations().some(a => a.playState === 'running' && a.transitionProperty === 'opacity')).length;
          out.goneSliding += document.getAnimations().filter(a => a.playState === 'running' && a.transitionProperty === 'transform' && a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('gone')).length;
          out.farFading += document.getAnimations().filter(a => a.playState === 'running' && a.transitionProperty === 'opacity' && a.effect && a.effect.target && a.effect.target.classList && a.effect.target.classList.contains('slot')).length; }
        // 3. the backdrop: the layer fading out stays visible for its fade, then is hidden, with no visibility transition
        const A = document.getElementById('bgA'), B = document.getElementById('bgB'), onNow = () => A.classList.contains('on') ? 'A' : B.classList.contains('on') ? 'B' : '';
        await wait(2500); const was = onNow(); key('ArrowLeft');
        for (let i = 0; i < 80 && onNow() === was; i++) await wait(100); // (the backdrop changes ~0.6 s after the slide, once its tiny blur is made)
        const off = onNow() === 'A' ? B : A; out.bgSwitched = onNow() !== was;
        out.visTrans = document.getAnimations().filter(a => a.transitionProperty === 'visibility' && (a.effect.target === A || a.effect.target === B)).length;
        out.outDuring = off.classList.contains('bg-out') && getComputedStyle(off).visibility === 'visible';
        for (let i = 0; i < 60 && getComputedStyle(off).visibility !== 'hidden'; i++) await wait(100);
        out.hiddenAfter = getComputedStyle(off).visibility === 'hidden' && !off.classList.contains('bg-out');
        // 4. the theme layer at the Handheld level (30 fps) asks only for the frames it draws in (it asked for all 60)
        Perf.set('handheld'); await wait(600); window.BS_METER && BS_METER.input(); window.__rafBy = {}; const t0 = performance.now(), th0 = window.ThemeFx ? ThemeFx._state().t : 0;
        await wait(1500); out.themeRafPerSec = +((window.__rafBy.themefx || 0) / ((performance.now() - t0) / 1000)).toFixed(1); out.themeDrew = window.ThemeFx ? +(ThemeFx._state().t - th0).toFixed(2) : 0;
        out.themeId = window.ThemeFx ? ThemeFx._state().id : null; window.__rafBy = null; Perf.set('auto'); await wait(400);
        // 5. a smaller shelf copy offered by the adapter (boxshelf.thumbFor) is what an arriving cover is drawn from
        window.boxshelf.thumbFor = (u, px) => /__art\//.test(u) ? u + (u.includes('?') ? '&' : '?') + 'shelfpx=' + Math.round(px) : null;
        const ids = new Set(); (window.__libs || []).forEach(L => (L || []).forEach(sh => (sh.games || []).forEach((g, i) => { if (g.art) { g.art.front = '/__art/' + ((i + 2) % 4) + '.jpg?thumbtest'; ids.add(g.id); } })));
        out.thumbAccepted = Shelf.artUpdated([...ids]);
        for (let i = 0; i < 80; i++) { await wait(150); if ([...document.querySelectorAll('#track .slot .f-front img')].some(im => /thumbtest/.test(im.src))) { await wait(1200); break; } }
        const faces = [...document.querySelectorAll('#track .slot .f-front img')].filter(im => /thumbtest/.test(im.src));
        out.thumbFaces = faces.length; out.thumbSized = faces.filter(im => /shelfpx=\d+/.test(im.src)).length; out.thumbPx = faces.length ? +(/shelfpx=(\d+)/.exec(faces[0].src) || [])[1] : 0;
        delete window.boxshelf.thumbFor;
        return out;
      });
      check('Scroll: the controller held on the shelf is read on a timer (no frame asked for every vsync)', sc.mode === 'browse' && sc.padMoved && sc.pollRaf === 0, `${sc.mode}, moved ${sc.padMoved}, ${sc.pollRaf} frames asked for by the pad reader in 1.5 s`);
      check('Scroll: a case that stays out of sight takes its place at once (no hidden slide on the main thread)', sc.gone > 0 && sc.goneSliding === 0 && sc.goneSeen === 0, `${sc.gone} out-of-sight case states over 20 steps, ${sc.goneSliding} sliding, ${sc.goneSeen} visible, ${sc.farFading} edge fades seen`);
      check('Scroll: the faded-out backdrop is hidden by a class, not a visibility transition (still visible during its fade)', sc.bgSwitched && sc.visTrans === 0 && sc.outDuring && sc.hiddenAfter, JSON.stringify({ switched: sc.bgSwitched, visTrans: sc.visTrans, during: sc.outDuring, after: sc.hiddenAfter }));
      check('Scroll: the 30 fps theme layer asks only for the frames it draws (≤ 36 a second)', !sc.themeId || (sc.themeRafPerSec <= 36 && sc.themeDrew > 0), `${sc.themeId}: ${sc.themeRafPerSec} frames asked for a second, drew ${sc.themeDrew} s of motion`);
      check('Scroll: a smaller shelf copy from the adapter (thumbFor) is what an arriving cover is drawn from', sc.thumbAccepted > 0 && sc.thumbFaces > 0 && sc.thumbSized === sc.thumbFaces && sc.thumbPx > 100, `${sc.thumbSized}/${sc.thumbFaces} faces at ${sc.thumbPx} px`);
      // Android ticks: once the pre-rendered tick buffers are ready a tick builds one audio node (it used to build ~20, each
      // taking the audio graph lock on the main thread), and a held direction plays at most one tick per ~70 ms
      const snd = await page.evaluate(async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        if (!window.Sound || !Sound._bake) return { missing: true };
        Sound.set({ theme: 'aero', enabled: true }); Sound.warm();
        for (let k = 0; k < 60; k++) { const b = Sound._bake().banks[0]; if (b && b.ready) break; await wait(250); }
        const bank = Sound._bake().banks[0] || {};
        let n = 0; const P = BaseAudioContext.prototype, saved = {};
        for (const k of Object.getOwnPropertyNames(P)) if (/^create/.test(k)) { const f = saved[k] = P[k]; P[k] = function () { if (!(this instanceof OfflineAudioContext)) n++; return f.apply(this, arguments); }; }
        const one = [], held = [];
        try {
          for (let i = 0; i < 5; i++) { await wait(150); const n0 = n; Sound.play('tick', { dir: 1 }); one.push(n - n0); }
          await wait(150); const t0 = performance.now();
          for (let i = 0; i < 20; i++) { const n0 = n; Sound.play('tick', { dir: 1 }); held.push(n - n0); await wait(30); }
          return { bank: bank.id, ready: !!bank.ready, takes: bank.takes, one, held: held.filter(x => x > 0).length, heldMs: Math.round(performance.now() - t0) };
        } finally { Object.assign(P, saved); }
      });
      check('Android tick: one pre-rendered buffer, at most 2 audio nodes', snd.ready && snd.takes === 21 && Math.max(...snd.one) <= 2 && Math.min(...snd.one) >= 1, `bank ${snd.bank} ready ${snd.ready} (${snd.takes} takes), nodes per tick ${(snd.one || []).join(',')}`);
      check('Android tick: a held direction plays at most one tick per ~70 ms', snd.held >= 4 && snd.held < 20 && snd.held <= Math.ceil(snd.heldMs / 70) + 1, `${snd.held} of 20 ticks played in ${snd.heldMs} ms`);
      check('No script errors in the smoothness pass', !errors.length, errors.slice(0, 3).join(' | '));
      await page.screenshot({ path: path.join(OUT, '6-smooth.png') });
      await ctx.close(); }
    // ---------- pass 4: the bottom screen's own page, at the Thor's bottom screen size ----------
    { const ctx = await browser.newContext({ viewport: { width: 1240, height: 1080 }, deviceScaleFactor: 1, hasTouch: true });
      ctx.setDefaultTimeout(90000);
      // count animation frames the page asks for: none may run while nothing moves
      await ctx.addInitScript({ content: 'window.__raf=0;const _r=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=f=>{window.__raf++;return _r(f)};' });
      const page = await ctx.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
      await page.goto(base.replace('index.html', 'bottom.html?demo=0')); await page.waitForTimeout(800);
      const r = await page.evaluate(async () => {
        const wait = ms => new Promise(res => setTimeout(res, ms)), out = {}, q = s => document.querySelector(s);
        const g = bsBottom.demo(); g.id = 'test-1'; g.title = 'Pikmin <b>&</b> Friends';
        bsBottom.recv(JSON.stringify({ type: 'game', game: g })); await wait(900);
        out.title = (q('.txt.in .title') || {}).textContent; out.cover = !!q('.case .f-front img'); out.sys = q('#sysName').textContent;
        q('#artBtn').click(); await wait(500); // Box art: opens the Art Studio up top, this page stays on the case
        out.art = q('.view.on').dataset.v === 'case' && q('#artBtn').classList.contains('qk') && !q('.tab[data-cmd="art"]') && document.querySelectorAll('.tab').length === 5; // (beta.12: under Play on the Game tab; five tabs)
        q('.tab[data-tab="trophies"]').click(); await wait(400); out.trophies = q('.view.on').dataset.v === 'trophies' && /23\/40/.test(q('#trophies').textContent);
        q('.tab[data-tab="more"]').click(); await wait(400); out.more = q('.view.on').dataset.v === 'more' && document.querySelectorAll('#more .tile:not(.add)').length === 7 && !!q('#more .tile.add');
        q('#more .tile[data-cmd="shuffle"]').click();
        q('.tab[data-tab="case"]').click(); await wait(500);
        q('.play').click();
        out.sent = window.__bsSent.map(m => m.type + (m.cmd ? ':' + m.cmd : ''));
        return out;
      });
      // the case starts closed; a drag turns it both ways
      await page.waitForTimeout(400);
      const closed = await page.evaluate(() => bsBottom.state());
      await page.mouse.move(330, 480); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(330 + i * 22, 480 + i * 12); await page.waitForTimeout(16); } await page.waitForTimeout(150); await page.mouse.up(); await page.waitForTimeout(300);
      const turned = await page.evaluate(() => bsBottom.state());
      // a flick keeps it turning by itself, then it stops
      // (sent from inside the page, so the swipe's timing doesn't depend on how busy this test machine is)
      const flick1 = await page.evaluate(async () => { const sc = document.getElementById('scene'), wait = ms => new Promise(res => setTimeout(res, ms));
        const ev = (t, x) => sc.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 9, clientX: x, clientY: 480 }));
        ev('pointerdown', 250); for (let i = 1; i <= 6; i++) { await wait(10); ev('pointermove', 250 + i * 40); } ev('pointerup', 490);
        await wait(40); return bsBottom.state(); });
      await page.waitForTimeout(2500); const flick2 = await page.evaluate(() => bsBottom.state());
      // (0.3.2) a tap on the closed case only brings it in close (Inspect); a second tap opens it
      // (a point on the case itself: after a flick it can rest at a steep angle, where the middle of its outline falls
      // between two faces, on the scene behind it)
      const caseAt = () => page.evaluate(() => { const c = [...document.querySelectorAll('.case')].pop(), b = c.getBoundingClientRect();
        for (const fx of [.5, .4, .6, .3, .7, .2, .8]) for (const fy of [.5, .4, .6]) { const x = b.x + b.width * fx, y = b.y + b.height * fy, el = document.elementFromPoint(x, y); if (el && el.closest('.case') === c) return [x, y]; }
        return [b.x + b.width / 2, b.y + b.height / 2]; });
      let tapAt = await caseAt();
      await page.mouse.click(tapAt[0], tapAt[1]); await page.waitForTimeout(1100);
      const tapped1 = await page.evaluate(() => bsBottom.state());
      tapAt = await caseAt(); await page.mouse.click(tapAt[0], tapAt[1]); await page.waitForTimeout(1100);
      const tapped = await page.evaluate(() => bsBottom.state());
      // (shut again for the focus view checks; a click from inside the page: if a tap above didn't take, the check says so
      // instead of this waiting 90 s for a button that isn't showing and stopping the whole run)
      await page.evaluate(() => { if (bsBottom.state().open) document.getElementById('openCase').click(); }); await page.waitForTimeout(1100);
      // Inspect's focus view: pinch zooms (within limits), a double-tap resets the zoom
      const fv = await page.evaluate(async () => { const sc = document.getElementById('scene'), wait = ms => new Promise(res => setTimeout(res, ms)), q = s => document.querySelector(s);
        const op = s => +getComputedStyle(q(s)).opacity, o = { inFocus: bsBottom.state().focus, tabs: op('.tabs'), side: op('.side'), close: op('#focusClose'), inspect: op('#inspectBtn') };
        const ev = (t, id, x) => sc.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: id, clientX: x, clientY: 540 }));
        const pinch = async (a0, b0, a1, b1) => { ev('pointerdown', 21, a0); ev('pointerdown', 22, b0); for (let i = 1; i <= 8; i++) { await wait(16); ev('pointermove', 21, a0 + (a1 - a0) * i / 8); ev('pointermove', 22, b0 + (b1 - b0) * i / 8); } ev('pointerup', 21, a1); ev('pointerup', 22, b1); await wait(60); return bsBottom.state().zoom; };
        o.zIn = await pinch(560, 680, 460, 780); o.zMax = await pinch(600, 640, 100, 1140); o.zMin = await pinch(100, 1140, 600, 640);
        o.ryAfterPinch = bsBottom.state().ry; return o; });
      await page.mouse.click(620, 540); await page.waitForTimeout(80); await page.mouse.click(620, 540); await page.waitForTimeout(900);
      fv.reset = await page.evaluate(() => bsBottom.state().zoom);
      // (that double-tap's first tap opened the case) then a tap on the disc takes it out
      if (!(await page.evaluate(() => bsBottom.state().open))) { await page.evaluate(() => document.getElementById('openCase').click()); await page.waitForTimeout(1100); }
      const opened = await page.evaluate(() => bsBottom.state().open);
      const disc = await page.evaluate(() => { const b = document.querySelector('.media .disc').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; });
      await page.screenshot({ path: path.join(OUT, '5-bottom-open.png') });
      // (0.3.2) a tap on the disc shows it on its own, big; a drag turns it right over in 3D; a tap puts it back in the case
      await page.mouse.click(disc[0], disc[1]); await page.waitForTimeout(900);
      const solo = await page.evaluate(async () => { const s0 = bsBottom.state(), ds = document.getElementById('discSolo'), wait = ms => new Promise(res => setTimeout(res, ms));
        const o = { on: s0.solo, shown: getComputedStyle(ds).visibility === 'visible', caseHidden: +getComputedStyle([...document.querySelectorAll('.pos')].pop()).opacity < .5, label: !!document.querySelector('#dsFront img, #dsFront .lab'), btn: getComputedStyle(document.getElementById('discBack')).pointerEvents === 'auto' };
        const r = ds.getBoundingClientRect(), x0 = r.x + r.width / 2, y0 = r.y + r.height / 2, ev = (t, x, y) => ds.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 41, clientX: x, clientY: y }));
        ev('pointerdown', x0, y0); for (let i = 1; i <= 12; i++) { await wait(16); ev('pointermove', x0 + i * 30, y0 - i * 25); } await wait(200); ev('pointerup', x0 + 360, y0 - 300); await wait(100);
        const s1 = bsBottom.state(); o.turned = Math.abs(s1.sry - s0.sry) > 60 && Math.abs(s1.srx - s0.srx) > 60; o.d = [Math.round(s1.sry - s0.sry), Math.round(s1.srx - s0.srx)]; return o; });
      await page.screenshot({ path: path.join(OUT, '5-bottom-disc.png') });
      { const r = await page.evaluate(() => { const b = document.getElementById('discSolo').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }); await page.mouse.click(r[0], r[1]); await page.waitForTimeout(900); }
      solo.back = await page.evaluate(() => { const s = bsBottom.state(); return !s.solo && s.open && +getComputedStyle([...document.querySelectorAll('.pos')].pop()).opacity > .9; });
      const out = solo.on;
      // the open case turned half way round stays on the screen (it turns about its hinge, in the middle), and a
      // double-tap on the screen straightens it again (face on)
      const hinge = await page.evaluate(async () => { const sc = document.getElementById('scene'), wait = ms => new Promise(res => setTimeout(res, ms));
        const lid = document.querySelector('.case.open .lid'), r = lid.getBoundingClientRect(), y = r.y + r.height / 2, x0 = r.x + r.width * .3;
        const ev = (t, x) => sc.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 31, clientX: x, clientY: y }));
        ev('pointerdown', x0); for (let i = 1; i <= 16; i++) { await wait(16); ev('pointermove', x0 + i * 30); } await wait(200); ev('pointermove', x0 + 480); ev('pointerup', x0 + 480); await wait(1200);
        let L = 1e9, R = -1e9; for (const f of document.querySelectorAll('.case.open .face, .case.open .lid .face')) { const b = f.getBoundingClientRect(); if (b.width) { L = Math.min(L, b.left); R = Math.max(R, b.right); } }
        return { ry: Math.round(bsBottom.state().ry), L: Math.round(L), R: Math.round(R), W: innerWidth }; });
      await page.mouse.click(60, 700); await page.waitForTimeout(80); await page.mouse.click(60, 700); await page.waitForTimeout(1100);
      const straight = await page.evaluate(() => bsBottom.state());
      // a tap on the manual inside the open case opens it (on the big screen)
      const bk = await page.evaluate(() => { const e = [...document.querySelectorAll('.case.open .booklet')].pop(); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2, window.__bsSent.length]; });
      if (bk) { await page.mouse.click(bk[0], bk[1]); await page.waitForTimeout(400); }
      const manTap = bk ? await page.evaluate(n => window.__bsSent.slice(n).map(m => m.cmd).filter(Boolean), bk[2]) : null;
      await page.evaluate(() => document.getElementById('focusClose').click()); await page.waitForTimeout(1200);
      fv.after = await page.evaluate(() => { const s = bsBottom.state(); return { focus: s.focus, open: s.open, tabs: +getComputedStyle(document.querySelector('.tabs')).opacity }; });
      // the quick ways in: Art Studio and Game details (both open on the big screen)
      fv.quick = await page.evaluate(() => { document.getElementById('artBtn').click(); document.getElementById('detBtn').click(); return window.__bsSent.slice(-2).map(m => m.cmd).join(','); });
      // (0.3.2) Shortcuts: Edit adds and removes them (kept on this screen), and the tiles follow; the top screen's theme backdrop
      const sc = await page.evaluate(async () => { const wait = ms => new Promise(res => setTimeout(res, ms)), q = s => document.querySelector(s), o = {};
        bsBottom.setTab('more'); await wait(400); o.def = bsBottom.state().shortcuts.join();
        q('#scEditBtn').click(); await wait(200); o.opts = document.querySelectorAll('.sc-opt').length;
        q('.sc-opt[data-k="shuffle"]').click(); q('.sc-opt[data-k="ach"]').click(); q('.sc-opt[data-k="settings"]').click(); await wait(100);
        q('#scEditBtn').click(); await wait(200);
        o.tiles = [...document.querySelectorAll('#more .tile:not(.add)')].map(t => t.dataset.cmd).join(); o.saved = localStorage.getItem('bsBottom:shortcuts');
        const n = window.__bsSent.length; q('#more .tile[data-cmd="settings"]').click(); o.sent = window.__bsSent.slice(n).map(m => m.cmd).join();
        // (0.3.5) your own: Add → A console asks the shelf for the choices, one tap adds it, its tile sends scRun
        q('#scEditBtn').click(); await wait(150); const n2 = window.__bsSent.length;
        q('.sc-kind[data-kind="shelf"]').click(); await wait(100); o.asked = window.__bsSent.slice(n2).map(m => m.cmd + ':' + m.arg).join();
        bsBottom.recv({ type: 'scOpts', kind: 'shelf', items: [{ key: 'shelf:psx', label: 'PlayStation', sub: '3 games' }, { key: 'bad', label: 'x' }] }); await wait(100);
        o.items = document.querySelectorAll('.sc-item').length; q('.sc-item[data-add="shelf:psx"]').click(); await wait(100);
        o.optsNow = document.querySelectorAll('.sc-opt').length; q('#scEditBtn').click(); await wait(200);
        const t = q('#more .tile[data-sc="shelf:psx"]'); o.xTile = t ? t.textContent.trim() : null; const n3 = window.__bsSent.length; if (t) t.click(); o.xSent = window.__bsSent.slice(n3).map(m => m.cmd + ':' + m.arg).join();
        bsBottom.setTab('case'); await wait(300);
        const g = bsBottom.demo(); g.id = 'theme-1'; g.theme = { id: 'arcade', bg: 'linear-gradient(180deg, rgb(4, 2, 12), rgb(28, 8, 56))' }; bsBottom.recv({ type: 'game', game: g }); await wait(1100);
        const on = [...document.querySelectorAll('.tbg.on')]; o.theme = bsBottom.state().theme; o.tbg = on.length === 1 && /linear-gradient/.test(on[0].style.background) && +getComputedStyle(on[0]).opacity > .9;
        return o; });
      // full box art: back and spine pictures on the case, or one whole-sleeve picture cut into back | spine | front
      const art = await page.evaluate(async () => { const wait = ms => new Promise(res => setTimeout(res, ms)), q = s => [...document.querySelectorAll(s)].pop();
        const pic = c => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="${c}"/></svg>`);
        const g = bsBottom.demo(); g.id = 'art-1'; g.art = { front: pic('#a33'), back: pic('#3a3'), spine: pic('#33a') };
        bsBottom.recv({ type: 'game', game: g }); await wait(900);
        const out = { back: (q('.f-back .print img') || {}).src === g.art.back, spine: (q('.f-spine .print img') || {}).src === g.art.spine, open: bsBottom.state().open };
        const w = bsBottom.demo(); w.id = 'art-2'; w.art = { front: null, full: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="660" height="420"><rect width="660" height="420" fill="#555"/></svg>') };
        bsBottom.recv({ type: 'game', game: w }); await wait(1000);
        out.full = [...document.querySelectorAll('.pos:last-child .wrapart.on')].map(e => e.style.backgroundSize).length; return out; });
      // the museum companion: the row as a shelf, a touch chooses a case (tells the wall), shrink-wrap comes off by touch
      const mus = await page.evaluate(async () => { const wait = ms => new Promise(res => setTimeout(res, ms)), q = s => document.querySelector(s);
        const m = bsBottom.demoMuseum(); m.row.sel = 1; m.game.id = 'm1'; m.game.title = m.games[1].title; m.game.sealed = true;
        bsBottom.recv(JSON.stringify(Object.assign({ type: 'museum' }, m))); await wait(900);
        const s0 = bsBottom.state(), out = { on: s0.museum, items: s0.mitems, sel: s0.msel, sealed: s0.msealed, tabsHidden: getComputedStyle(q('.tabs')).pointerEvents === 'none' /* (not opacity: a slow software frame can catch its fade mid-way) */, wrapped: document.querySelectorAll('.mi.sealed').length };
        const b = q('.mi[data-i="6"]'), r = b.getBoundingClientRect(), o = { bubbles: true, pointerId: 3, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        b.dispatchEvent(new PointerEvent('pointerdown', o)); b.dispatchEvent(new PointerEvent('pointerup', o)); await wait(300);
        out.picked = bsBottom.state().msel;
        await wait(1300); bsBottom.recv(JSON.stringify(Object.assign({ type: 'museum' }, m))); await wait(300); // the wall answers later, still on case 1 (in this test)
        q('[data-m="unwrap"]').click(); await wait(1200);
        out.after = bsBottom.state().msealed; out.itemSealed = q('.mi[data-i="1"]').classList.contains('sealed');
        out.sent = window.__bsSent.filter(x => x.cmd === 'mpick' || x.cmd === 'unwrap').map(x => x.cmd + ':' + x.arg);
        // touch controls: a row up / down and Pick up; in your hands Put back / Open case and a drag turns it; the Room drawer
        const n0 = window.__bsSent.length, pills = () => [...document.querySelectorAll('.mpill span')].map(x => x.textContent).join('/');
        out.pills = pills(); document.querySelectorAll('.mpill').forEach(b => b.click());
        m.room = { v: { light: 'gallery', wall: 'plaster', floor: 'stone', shelf: 'walnut', bench: false }, opts: [{ key: 'light', label: 'Lighting', type: 'choice', opts: [['gallery', 'Classic'], ['neon', 'Neon night']] },
          { key: 'wall', label: 'Walls', type: 'choice', opts: [['plaster', 'Dark plaster'], ['brick', 'Brick']] }, { key: 'bench', label: 'Museum bench', type: 'bool' }] };
        m.hand = { held: true }; m.game.sealed = false; m.games[1].sealed = false; bsBottom.recv(Object.assign({ type: 'museum' }, m)); await wait(500);
        out.heldPills = pills(); document.querySelectorAll('.mpill').forEach(b => b.click());
        const wl = q('.m-wall'), ev = (t, x) => wl.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 31, clientX: x, clientY: 200 }));
        ev('pointerdown', 300); for (let i = 1; i <= 6; i++) { await wait(30); ev('pointermove', 300 + i * 40); } ev('pointerup', 540);
        q('#roomBtn').click(); await wait(500); out.roomOpen = bsBottom.state().room;
        q('.chip[data-v="neon"]').click(); q('.chip[data-k="bench"]').click(); out.neonOn = q('.chip[data-v="neon"]').classList.contains('on');
        q('.mr-x').click(); await wait(400);
        out.touch = window.__bsSent.slice(n0).map(x => x.cmd + (x.arg == null ? '' : ':' + (typeof x.arg === 'object' ? (x.arg.key ? x.arg.key + '=' + x.arg.val : 'turn') : x.arg)));
        out.turnRight = window.__bsSent.slice(n0).filter(x => x.cmd === 'mturn').reduce((a, x) => a + x.arg.dx, 0) > 40;
        return out; });
      await page.screenshot({ path: path.join(OUT, '5-bottom-museum.png') });
      await page.evaluate(() => bsBottom.recv({ type: 'game', game: bsBottom.demo() })); await page.waitForTimeout(1500);
      const back = await page.evaluate(() => bsBottom.state());
      // idle: no animation-frame loop, and no animation that runs forever
      const idle = await page.evaluate(async () => { const a = window.__raf; await new Promise(res => setTimeout(res, 1200));
        return { raf: window.__raf - a, endless: document.getAnimations().filter(x => x.effect && x.effect.getTiming().iterations === Infinity).length }; });
      check('Bottom page: shows a game it is sent (text escaped)', r.title === 'Pikmin <b>&</b> Friends' && r.cover && r.sys === 'GameCube', `${r.title} · cover ${r.cover} · ${r.sys}`);
      check('Bottom page: Box art (under Play) / Trophies / Shortcuts (seven, then Add a shortcut)', r.art && r.trophies && r.more, `box art ${r.art}, trophies ${r.trophies}, shortcuts ${r.more}`);
      check('Bottom page: buttons post the right messages', JSON.stringify(r.sent) === JSON.stringify(['ready', 'cmd:art', 'cmd:shuffle', 'cmd:play']), r.sent.join(', '));
      check('Bottom page: the case starts closed; a tap brings it in close (Inspect), a second tap opens it', !closed.open && closed.pack === 'keep' && tapped1.focus && !tapped1.open && tapped.open && tapped.focus,
        `open ${closed.open} → ${tapped1.open} (focus ${tapped1.focus}) → ${tapped.open}, ${closed.pack}`);
      check('Bottom page: focus view: the case alone, everything else faded, only Close (and Open case) left', fv.inFocus && fv.tabs === 0 && fv.side === 0 && fv.inspect === 0 && fv.close === 1, JSON.stringify(fv).slice(0, 160));
      check('Bottom page: focus view: pinch zooms within limits, without turning; double-tap resets', fv.zIn > 1.3 && fv.zMax === 2.1 && fv.zMin === 0.7 && fv.reset === 1, `zoom ${fv.zIn} / max ${fv.zMax} / min ${fv.zMin} → reset ${fv.reset}`);
      check('Bottom page: Close leaves the focus view (case shut, tabs back)', fv.after && !fv.after.focus && !fv.after.open && fv.after.tabs === 1, JSON.stringify(fv.after));
      check('Bottom page: Art Studio and Game details buttons send art / details', fv.quick === 'art,details', fv.quick);
      check('Bottom page: Shortcuts: seven by default (Screen off too; up to twelve, beta.12), Edit adds / removes them (kept), a tile sends its command', sc.def === 'play,fav,museum,manual,shuffle,menu,sleep' && sc.opts === 13 && sc.tiles === 'play,fav,museum,manual,menu,sleep,ach,settings' && /settings/.test(sc.saved || '') && sc.sent === 'settings',
        JSON.stringify(sc));
      check('Bottom page (0.3.5): Shortcuts can be your own (Add → a console): asks the shelf, adds the one tapped, its tile sends scRun',
        sc.asked === 'scOpts:shelf' && sc.items === 1 && sc.optsNow === 14 && /PlayStation/.test(sc.xTile || '') && sc.xSent === 'scRun:shelf:psx', JSON.stringify({ asked: sc.asked, items: sc.items, optsNow: sc.optsNow, tile: sc.xTile, sent: sc.xSent }));
      check('Bottom page: wears the top screen\'s theme (its backdrop, sent with the game)', sc.theme === 'arcade' && sc.tbg, `theme ${sc.theme}, backdrop ${sc.tbg}`);
      check('Bottom page: a tap on the disc shows it on its own (case faded, Put it back), a drag turns it over in 3D, a tap puts it back', solo.on && solo.shown && solo.caseHidden && solo.label && solo.btn && solo.turned && solo.back, JSON.stringify(solo));
      check('Bottom page: drag turns the case both ways; double-tap straightens an open case (face on)', Math.abs(turned.ry - 30) > 30 && Math.abs(turned.rx + 7) > 10 && straight.open && ((straight.ry - 8) % 360 + 360) % 360 < 1 && straight.rx === -4,
        `turned ${turned.ry.toFixed(0)}° / ${turned.rx.toFixed(0)}°, straightened ${straight.ry.toFixed(0)}° / ${straight.rx.toFixed(0)}° (open ${straight.open})`);
      check('Bottom page: a tap on the manual in the open case opens it', !!manTap && manTap.includes('manual'), JSON.stringify(manTap));
      check('Bottom page: an open case turned half way round stays on the screen (it turns about its hinge)', Math.abs(hinge.ry - 8) > 90 && hinge.L >= 0 && hinge.R <= hinge.W, JSON.stringify(hinge));
      check('Bottom page: a flick keeps it spinning, then it stops by itself', flick1.spinning && !flick2.spinning && flick2.ry !== flick1.ry, `spinning ${flick1.spinning} → ${flick2.spinning}, ${flick1.ry.toFixed(0)}° → ${flick2.ry.toFixed(0)}°`);
      check('Bottom page: Open case opens it (in the focus view), a tap on the disc shows it', opened && out, `open ${opened}, disc shown ${out}`);
      check('Bottom page: back and spine art on the case (and a whole-sleeve picture cut to fit)', art.back && art.spine && !art.open && art.full === 3, JSON.stringify(art));
      check('Bottom page: museum view (row shelf, chosen case, shrink-wrap)', mus.on && mus.items === 12 && mus.sel === 1 && mus.sealed && mus.tabsHidden && mus.wrapped === 4, JSON.stringify(mus).slice(0, 160));
      check('Bottom page: museum touches tell the wall (choose, unwrap) and the plastic comes off', mus.picked === 6 && !mus.after && !mus.itemSealed && mus.sent.join(',') === 'mpick:6,unwrap:1' && !back.museum && back.title === 'Starlight Courier',
        `${mus.sent.join(', ')}; sealed after ${mus.after}; back to the game ${!back.museum}`);
      check('Bottom page: museum touch: row up / Pick up / row down, in your hands Put back / Open case and a drag turns it',
        mus.pills === 'Row up/Pick up/Row down' && mus.heldPills === 'Put back/Open case' && ['mrow:1', 'mact', 'mback', 'mact'].every(c => mus.touch.includes(c)) && mus.touch.includes('mturn:turn') && mus.turnRight,
        `${mus.pills} | ${mus.heldPills} | ${(mus.touch || []).join(', ').slice(0, 120)}`);
      check('Bottom page: Room buttons send the room choice (lighting, bench) and mark it at once', mus.roomOpen && mus.neonOn && mus.touch.includes('room:light=neon') && mus.touch.includes('room:bench=true'), (mus.touch || []).filter(t => /^room/.test(t)).join(', '));
      check('Bottom page: nothing redraws when idle', idle.raf === 0 && idle.endless === 0, `${idle.raf} animation frames in 1.2 s, ${idle.endless} endless animations`);
      check('Bottom page: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }
    // ---------- pass 5: the Android setup wizard, one main ROMs folder, and box art that's never fetched twice ----------
    { const { ctx, page, errors } = await newPage(browser, null);
      const url = base + '?fakeNative=1';
      await ctx.addInitScript({ content: "try{localStorage.setItem('bsThorHud','hidden')}catch(e){}" }); // (the test meter sits in the corner over the wizard's buttons; a tap hides it on the device)
      await page.goto(url); await page.waitForTimeout(4500);
      const W = () => page.evaluate(() => ({ title: (document.querySelector('#suTitle') || {}).textContent || '', lead: (document.querySelector('#suBody .su-lead') || {}).textContent || '',
        nav: [...document.querySelectorAll('#suNav .su-step')].map(e => e.textContent.trim()) }));
      const shot5 = f => page.screenshot({ path: path.join(OUT, f), scale: 'css', timeout: 90000 }); // 1440x810: the layout's own size
      const tap = async t => { await page.click(`#suBody .wz-choice:has-text("${t}"), #suBody button:has-text("${t}")`, { timeout: 10000 }); await page.waitForTimeout(350); };
      const w0 = await W();
      check('Wizard: feature questions in order after Welcome', w0.nav.slice(0, 8).join(' > ') === 'Welcome > Your games > Box art > Full case art > Where art goes > Manuals > Bottom screen > Home screen', w0.nav.slice(0, 9).join(' > '));
      await shot5('5-wizard-welcome.png');
      await tap('Get started'); await page.waitForTimeout(800);
      const w1 = await W(); await shot5('5-wizard-games.png');
      await page.evaluate(() => { window.__fakePickNext = 'primary:ROMs'; });
      await tap('Pick your main ROMs folder'); await page.waitForTimeout(1500);
      const w2 = await W(); await shot5('5-wizard-found.png');
      const names = await page.evaluate(() => { const f = boxshelf.consoleForFolder, x = e => [{ ext: e }];
        const want = { GC: 'gc', gamecube: 'gc', 'Nintendo GameCube': 'gc', 'PS2 ROMs': 'ps2', ps1: 'psx', PlayStation: 'psx', 'Nintendo 64': 'n64', 'Mega-Drive': 'megadrive', genesis: 'megadrive', SFC: 'snes',
          FBNeo: 'arcade', tg16: 'pcengine', '3ds': 'n3ds', Switch: 'sw', 'Wii U': 'wiiu', wii: 'wii', nds: 'nds', gb: 'gb', gbc: 'gbc', gba: 'gba', dc: 'dreamcast', sms: 'mastersystem', gg: 'gamegear', psp: 'psp', neogeo: 'neogeo', Discs: null, xbox360: null };
        const bad = Object.entries(want).filter(([n, id]) => f(n) !== id).map(([n, id]) => `${n}→${f(n)} (want ${id})`);
        if (f('Stuff', x('gba')) !== 'gba') bad.push('.gba files → ' + f('Stuff', x('gba')));
        if (f('Stuff', x('iso')) !== null) bad.push('.iso files (many consoles) → ' + f('Stuff', x('iso')));
        if (f('Stuff', [{ ext: 'cue' }, { ext: 'bin' }]) !== null) bad.push('.cue/.bin → ' + f('Stuff', [{ ext: 'cue' }, { ext: 'bin' }]));
        return bad; });
      check('Main ROMs folder: console folder names (ES-DE / RetroArch / common) map to consoles', !names.length, names.join(', ') || 'all names matched');
      check('Main ROMs folder: consoles found by name and by the games inside, with game counts', w1.title === 'Where are your games?' && w2.title === 'Found 5 consoles' && /GameCube \(3 games\)/.test(w2.lead) && /PlayStation \(2 games\)/.test(w2.lead) && /Genesis \(1 game\)/.test(w2.lead) && /Game Boy Advance \(2 games\)/.test(w2.lead),
        `${w2.title}: ${w2.lead.slice(0, 150)}`);
      await tap('Continue'); const w3 = await W(); await shot5('5-wizard-art.png');
      // the controller: the answer in effect has focus; right / left move between the choices, A picks
      const fx = () => page.evaluate(() => ((document.activeElement || {}).textContent || '').replace('Recommended', '').slice(0, 12));
      const padF = [await fx()]; for (const a of ['right', 'left']) { await page.evaluate(a => Setup.pad(a), a); padF.push(await fx()); }
      await page.evaluate(() => Setup.pad('ok')); await page.waitForTimeout(400);
      const w4 = await W(); await shot5('5-wizard-full.png');
      await tap('Yes, full cases'); const w5 = await W(); await shot5('5-wizard-where.png');
      await tap('Next to my ROMs'); const w6m = await W(); await shot5('5-wizard-manuals.png');
      await tap('Yes, get manuals'); const w6 = await W(); await shot5('5-wizard-bottom.png');
      await tap('Yes, use it'); const w7 = await W(); await shot5('5-wizard-home.png');
      await tap('Yes, choose Boxshelf'); const w8 = await W();
      check('Wizard: one question per page, in order', [w3, w4, w5, w6m, w6, w7].map(w => w.title).join(' / ') === 'Download box art automatically? / Full case art (backs and spines) too? / Where should art be saved? / Download game manuals too? / Use the bottom screen? / Use Boxshelf as the Home screen?' && w8.title !== w7.title,
        [w3, w4, w5, w6m, w6, w7, w8].map(w => w.title).join(' / '));
      check('Wizard: controller moves between the big choices and picks one', /^Yes, get/.test(padF[0]) && /^No thanks/.test(padF[1]) && /^Yes, get/.test(padF[2]) && w4.title === 'Full case art (backs and spines) too?', padF.join(' → ') + ' → A → ' + w4.title);
      const ans = await page.evaluate(async () => { await new Promise(r => setTimeout(r, 800)); const c = (await boxshelf.getConfig()).config;
        return { ui: c.ui, root: c.romRoot, dirs: Object.fromEntries(Object.entries(c.systems).filter(([, v]) => v.romDirs.length).map(([k, v]) => [k, v.romDirs.join()])), calls: window.__fakeCalls || [], bottom: __fakeBottom !== undefined }; });
      check('Wizard: answers stored (autoCovers, fullArt, artWhere, manuals per console, bottom screen, Home chooser opened)', ans.ui.autoCovers === true && ans.ui.fullArt === true && ans.ui.artWhere === 'roms' && ans.ui.autoManuals === true && ans.ui.manual_gc === true && ans.ui.manual_psx === true && ans.ui.bottomScreen === 'on' && ans.calls.includes('openHomeSettings'), JSON.stringify(ans.ui) + ' ' + ans.calls.join());
      check('Main ROMs folder: each console gets its own sub folder (one pick)', ans.root === '/storage/emulated/0/ROMs' && ans.dirs.gc === '/storage/emulated/0/ROMs/gc' && ans.dirs.megadrive === '/storage/emulated/0/ROMs/Sega Genesis' && ans.dirs.gba === '/storage/emulated/0/ROMs/Handheld' && !ans.dirs.wii, JSON.stringify(ans.dirs).slice(0, 170));
      // finish: the done page scans; box art then comes on its own
      const fin = await page.evaluate(async () => { const f = [...document.querySelectorAll('#suNav .su-step')].find(e => /Finish/.test(e.textContent)); if (!f) return 'no Finish step'; f.click();
        await new Promise(r => setTimeout(r, 400)); const o = [...document.querySelectorAll('#suFoot button')].find(e => /Open Boxshelf/.test(e.textContent)); if (!o) return 'no Open button'; o.click(); return 'ok'; });
      if (fin !== 'ok') check('Wizard: Finish reached', false, fin); await page.waitForTimeout(1000);
      const artRun = () => page.evaluate(async () => { const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 80 && !(api.artProgress().total && !api.artProgress().running); i++) await wait(250);
        await wait(300); const lib = await api.cachedLibrary() || [];
        const games = lib.filter(s => s.kind === 'console').flatMap(s => s.games.map(g => ({ sys: s.id, title: g.title, front: !!(g.art && g.art.front) })));
        let dirs = {}; try { dirs = JSON.parse(localStorage.getItem('fake:dirs') || '{}'); } catch {}
        return { games, fetch: __fakeArt.fetch.map(f => ({ name: f.name, tree: f.tree })), thumb: __fakeArt.thumb.slice(), index: __fakeArt.index, made: __fakeArt.dirs.slice(), dirs }; });
      const a1 = await artRun();
      check('Main ROMs folder: games scanned from every found console, "Boxshelf Art" made inside each console folder', a1.games.length === 10 && a1.games.every(g => g.front) && a1.made.includes('primary:ROMs/gc/Boxshelf Art') && a1.made.includes('primary:ROMs/Handheld/Boxshelf Art'),
        `${a1.games.filter(g => g.front).length}/${a1.games.length} covers; folders: ${a1.made.join(', ')}`);
      // manuals (the wizard said yes, for every console): Pikmin's 3 pages from the Internet Archive into the GameCube folder's
      // "Boxshelf Manuals"; Crash Bandicoot's pages copied over from the PC's covers folder are used as they are
      const m1 = await page.evaluate(async () => { const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 160 && !(api.manualProgress().total && !api.manualProgress().running); i++) await wait(250);
        await wait(300); const lib = await api.cachedLibrary() || [], g = t => lib.flatMap(s => s.games || []).find(x => new RegExp(t).test(x.title)) || {};
        let dirs = {}; try { dirs = JSON.parse(localStorage.getItem('fake:dirs') || '{}'); } catch {}
        return { prog: api.manualProgress(), pik: ((g('^Pikmin').art || {}).manual || []).length, crash: ((g('^Crash').art || {}).manual || []).length, metroid: ((g('^Metroid').art || {}).manual || []).length,
          fetch: __fakeMan.fetch.filter(f => !f.pdf).map(f => f.name), pdfs: __fakeMan.fetch.filter(f => f.pdf).map(f => f.url), made: (__fakeMan.saved || []).map(s => s.name), gdb: (__fakeMan.gdb || []).length,
          search: __fakeMan.search.length, lists: (__fakeMan.lists || []).length, saved: dirs['primary:ROMs/gc/Boxshelf Manuals'] || [] }; });
      // (0.3.2: the item has no page count in its metadata, as most real ones: the count comes from its page list, and the
      // pages come down as pictures, not through the PDF)
      check('Manuals: a console\'s manuals come down as pages into "Boxshelf Manuals" (the booklet, not the strategy guide; page count from the scan\'s page list)', m1.pik === 3 && m1.saved.filter(n => /^Pikmin/.test(n)).length === 3 && m1.fetch.length === 3 && m1.fetch.every(n => /^Pikmin \(USA\)-manual-0[1-3]$/.test(n)) && m1.lists >= 1 && !m1.pdfs.some(u => /pikmin/i.test(u)),
        JSON.stringify(m1).slice(0, 300));
      check('Manuals: a PDF-only manual (GamesDatabase) is turned into pages, saved beside the games', m1.metroid === 2 && m1.pdfs.length === 1 && /Metroid_Prime\.pdf$/.test(m1.pdfs[0]) && m1.made.length === 2 && m1.made.every((n, i) => n.startsWith('Metroid Prime') && n.endsWith('-manual-0' + (i + 1))) && m1.saved.filter(n => /^Metroid/.test(n)).length === 2,
        JSON.stringify({ metroid: m1.metroid, pdfs: m1.pdfs, made: m1.made, gdb: m1.gdb }));
      check('Manuals: pages copied over from the PC are used as they are (nothing downloaded for them)', m1.crash === 2 && !m1.fetch.some(n => /Crash/.test(n)), `Crash Bandicoot: ${m1.crash} pages`);
      // (0.3.5) the manuals of the console on screen go first
      const mNext = await page.evaluate(() => { const f = Shelf.artFocus(false), other = f && f.sys === 'gc' ? 'psx' : 'gc';
        const q = [{ net: true, sysId: other, g: { id: 'a' } }, { net: true, sysId: other, g: { id: 'b' } }, { net: true, sysId: f && f.sys, g: { id: 'c' } }];
        const [j, rest] = window.__bsManNext(q); return { sys: f && f.sys, next: j && j.g.id, rest: rest.map(x => x.g.id).join(',') }; });
      check('Manuals (0.3.5): the console on screen gets its manuals first', !!mNext.sys && mNext.next === 'c' && mNext.rest === 'a,b', JSON.stringify(mNext));
      // a reinstall: the app's own storage is emptied (settings, art.json, cached lists, display copies); the ROM folders stay
      const wipe = keep => page.evaluate(keep => { for (const k of Object.keys(localStorage)) if (k.startsWith('fake:') && !keep.includes(k)) localStorage.removeItem(k); }, keep);
      const setupAgain = (where) => page.evaluate(async where => { const api = window.boxshelf; window.__fakePickNext = 'primary:ROMs'; const r = await api.romRoot(), c = (await api.getConfig()).config;
        for (const f of r.found) c.systems[f.id].romDirs = [f.dir]; c.romRoot = r.path; c.setupDone = true; c.ui.artWhere = where; await api.saveConfig(c); await api.scan(); }, where);
      await wipe(['fake:dirs']); await page.goto(url); await page.waitForTimeout(3500); await setupAgain('roms');
      const a2 = await artRun();
      check('Reinstall (empty app storage): all art comes back from "Boxshelf Art", 0 downloads, 0 list fetches', a2.games.length === 10 && a2.games.every(g => g.front) && a2.fetch.length === 0 && a2.index === 0 && a2.thumb.length >= 10,
        `${a2.games.filter(g => g.front).length}/${a2.games.length} covers, ${a2.thumb.length} re-read, ${a2.fetch.length} downloads, ${a2.index} list fetches`);
      const m2 = await page.evaluate(async () => { const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms)); let pik = 0;
        for (let i = 0; i < 100 && !pik; i++) { await wait(250); const lib = await api.cachedLibrary() || [], g = lib.flatMap(s => s.games || []).find(x => /^Pikmin/.test(x.title)); pik = g && g.art && g.art.manual ? g.art.manual.length : 0; }
        return { pik, fetch: __fakeMan.fetch.length, search: __fakeMan.search.length }; });
      check('Manuals: after a reinstall they come back from "Boxshelf Manuals" (0 downloads, 0 searches)', m2.pik === 3 && m2.fetch === 0 && m2.search === 0, JSON.stringify(m2));
      // a restart: nothing is looked up again
      await page.goto(url); await page.waitForTimeout(5000);
      const a3 = await page.evaluate(() => ({ fetch: __fakeArt.fetch.length, thumb: __fakeArt.thumb.length, index: __fakeArt.index }));
      check('Restart after that: 0 downloads, 0 re-reads, 0 list fetches', a3.fetch + a3.thumb + a3.index === 0, JSON.stringify(a3));
      // (0.3.2) display copies made at the old 512 px are made again at 1024 from the saved originals (0 downloads), and the old
      // copies are deleted at the next start
      await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('fake:art.json')); delete a.dispH; delete a.trash;
        for (const rec of Object.values(a.games)) for (const v of Object.values(rec)) if (v) delete v.h; localStorage.setItem('fake:art.json', JSON.stringify(a));
        localStorage.setItem('fake:history.json', JSON.stringify({ old1: { launches: 0, minutes: 95, last: 1761300000 } })); }); // (0.3.1's history shape)
      await page.goto(url);
      const oldHist = await page.evaluate(async () => (await window.boxshelf.history()).old1);
      check('Play history from 0.3.1 (minutes, seconds) becomes the PC\'s shape', !!oldHist && oldHist.count === 1 && oldHist.ms === 95 * 60000 && oldHist.last === 1761300000000, JSON.stringify(oldHist));
      const sh = await page.evaluate(async () => { const wait = ms => new Promise(r => setTimeout(r, ms)), get = () => JSON.parse(localStorage.getItem('fake:art.json') || '{}');
        for (let i = 0; i < 240 && get().dispH !== 1024; i++) await wait(250);
        const a = get(), recs = Object.values(a.games).flatMap(r => Object.values(r)).filter(v => v && v.d && v.f);
        return { dispH: a.dispH, recs: recs.length, sharp: recs.filter(v => v.h === 1024).length, hd: __fakeArt.thumb.filter(n => /~hd$/.test(n)).length, fetch: __fakeArt.fetch.length, trash: (a.trash || []).length }; });
      // (0.3.3) the shelf's smaller copies (576 px for a case, 128 px for the backdrop), made from the 1024 px one in quiet
      // moments; thumbFor hands the shelf the smallest big enough, the full copy above 600 px
      const sm = await page.evaluate(async () => { const api = window.boxshelf, wait = ms => new Promise(r => setTimeout(r, ms)), get = () => JSON.parse(localStorage.getItem('fake:art.json') || '{}');
        const all = () => Object.values(get().games || {}).flatMap(r => Object.values(r)).filter(v => v && v.d);
        for (let i = 0; i < 240 && !(all().length && all().every(v => v.s && v.s[576] && v.s[128])); i++) await wait(250);
        const lib = await api.cachedLibrary(), g = lib.flatMap(s => s.games || []).find(x => x.art && x.art.front) || {}, f = (g.art || {}).front;
        return { made: all().filter(v => v.s && v.s[576] && v.s[128]).length, recs: all().length, small: api.thumbFor(f, 400), tiny: api.thumbFor(f, 150), big: api.thumbFor(f, 900), f }; });
      check('Smaller copies for the shelf: 576 px for a case, 128 px for the backdrop; the full copy above 600 px',
        sm.recs > 0 && sm.made === sm.recs && !!sm.small && sm.small !== sm.f && !!sm.tiny && sm.tiny !== sm.small && sm.big === null, JSON.stringify(sm).slice(0, 260));
      await page.goto(url); await page.waitForTimeout(4000);
      const sh2 = await page.evaluate(() => ({ forgot: (__fakeArt.forgot || []).length, thumb: __fakeArt.thumb.length }));
      check('Old 512 px display copies are made again at 1024 from the originals (0 downloads); the old ones are deleted next start',
        sh.dispH === 1024 && sh.recs > 0 && sh.sharp === sh.recs && sh.hd >= sh.recs && sh.fetch === 0 && sh.trash >= sh.recs && sh2.forgot === sh.trash && sh2.thumb === 0,
        JSON.stringify({ ...sh, ...sh2 }));
      // the display copies vanish (Android cleared them): made again from the originals, nothing downloaded
      await wipe(['fake:dirs', 'fake:config.json', 'fake:folders.json', 'fake:library.json', 'fake:art.json', 'fake:history.json', 'fake:home.json']);
      await page.goto(url); await page.waitForTimeout(3000);
      const a4 = await artRun();
      check('Missing display copies are re-made from the saved originals (0 downloads)', a4.games.every(g => g.front) && a4.thumb.length >= 10 && a4.fetch.length === 0, `${a4.thumb.length} re-made, ${a4.fetch.length} downloads, ${a4.games.filter(g => g.front).length}/${a4.games.length} covers`);
      // "Inside Boxshelf": a fresh device with an untouched ROM folder; new art never goes into the ROM tree
      await wipe([]); await page.goto(url); await page.waitForTimeout(3500); await setupAgain('app');
      const a5 = await artRun(), romWrites = Object.keys(a5.dirs).filter(d => d !== 'primary:ROMs/snes/Boxshelf Art').concat((a5.dirs['primary:ROMs/snes/Boxshelf Art'] || []).filter(n => !/^Super Metroid/.test(n)));
      check('artWhere "app": art saved in the app only, nothing written into the ROM folders (existing art still re-used)', a5.fetch.length > 0 && a5.fetch.every(f => !f.tree) && !a5.made.length && !romWrites.length && a5.thumb.some(n => /^Super Metroid/.test(n)) && a5.games.every(g => g.front),
        `${a5.fetch.length} downloads (tree: ${[...new Set(a5.fetch.map(f => f.tree || 'none'))].join()}), new ROM-side files: ${romWrites.length}, re-used: ${a5.thumb.join(', ')}`);
      check('No script errors in the wizard / art passes', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }
    // ---------- pass 6: less clutter on the Thor (setup wizard's Consoles page, the console bar) ----------
    // The wizard shows the consoles this device can already play first (an emulator app found / games folders) and folds
    // the rest under "More consoles"; the bar on the shelf lists only shelves with games, keeps the current one centred
    // with a transform (no scrolling, no layout on a switch) and can be dragged with a finger.
    { const { ctx, page, errors } = await newPage(browser, null);
      const url = base + '?fakeNative=1';
      await page.goto(url); await page.waitForTimeout(4000);
      const auto = await page.$('#suBody >> text=Find automatically'); if (auto) { await auto.click(); await page.waitForTimeout(1500); }
      // the Android wizard asks its feature questions first (Your games, Box art…): go straight to its Consoles page
      const gs = await page.$('#suBody .wz-choice:has-text("Get started")'); if (gs) { await gs.click(); await page.waitForTimeout(2500); } // (finds the emulators, as Find automatically did)
      const conStep = await page.$('#suNav .su-step:has-text("Consoles")'); if (conStep) { await conStep.click(); await page.waitForTimeout(1200); }
      const hub = () => page.evaluate(() => ({ title: (document.getElementById('suTitle') || {}).textContent || '',
        nav: document.querySelectorAll('#suNav .su-step').length, big: [...document.querySelectorAll('.con-card.big')].map(e => e.dataset.con),
        small: document.querySelectorAll('.con-grid.small .con-card').length, more: ((document.querySelector('.con-more') || {}).textContent || ''),
        fits: document.getElementById('suBody').scrollHeight <= document.getElementById('suBody').clientHeight + 2, focus: document.activeElement && (document.activeElement.dataset.con || document.activeElement.textContent) }));
      const h0 = await hub();
      await page.screenshot({ path: path.join(OUT, '6-wizard-consoles.png') });
      check('Wizard: consoles found on the device first, the rest under More',
        h0.title === 'Your consoles' && h0.big.join() === 'gc,wii,n3ds,psx' && /More consoles \(25\)/.test(h0.more) && h0.small === 0 && h0.fits && h0.nav >= 3, // (Android: the feature questions are steps of their own before Consoles)
        `${h0.title}: ${h0.big.join(', ')} · "${h0.more}" · ${h0.small} folded · fits ${h0.fits} · ${h0.nav} steps`);
      // controller: down onto the first card, A opens its page, B comes back; A on More shows every other console
      const pad = a => page.evaluate(a => window.Setup.pad(a), a);
      await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()); // (the Consoles step was clicked in the side list: the pad starts in the page)
      await pad('down'); await page.waitForTimeout(150); const f1 = (await hub()).focus;
      await pad('ok'); await page.waitForTimeout(500); const pg = (await hub()).title;
      await pad('back'); await page.waitForTimeout(500); const h1 = await hub();
      await page.click('.con-more'); await page.waitForTimeout(600); const h2 = await hub();
      check('Wizard: controller opens a console and comes back; More shows the rest (every console reachable)',
        f1 === 'gc' && pg === 'GameCube' && h1.title === 'Your consoles' && h2.small === 25 && h2.big.length + h2.small === 29,
        `focus ${f1} → ${pg} → ${h1.title}; More: ${h2.small} + ${h2.big.length} = ${h2.small + h2.big.length}`);
      // a console deep in More: B comes back to its card (focused, on screen), not to the top of the list
      const last = await page.evaluate(() => { const c = [...document.querySelectorAll('.con-grid.small .con-card')].pop(); c.scrollIntoView(); c.click(); return c.dataset.con; });
      await page.waitForTimeout(400); await pad('back'); await page.waitForTimeout(500);
      const back = await page.evaluate(() => { const a = document.activeElement, r = a.getBoundingClientRect(), b = document.getElementById('suBody').getBoundingClientRect();
        return { id: a.dataset.con, seen: r.top >= b.top - 1 && r.bottom <= b.bottom + 1, more: document.querySelectorAll('.con-grid.small .con-card').length }; });
      check('Wizard: back from a console in More lands on its card, still in view', back.id === last && back.seen && back.more === 25, `${last} → focus ${back.id}, in view ${back.seen}, ${back.more} folded open`);
      // set three consoles up (gc, psx, snes) and go to the shelf: RetroArch also gave a dozen consoles an emulator, but
      // only shelves with games get a tab
      await page.evaluate(async () => { const api = window.boxshelf, info = await api.getConfig(), det = await api.detect(), c = info.config;
        for (const id of ['gc', 'psx', 'snes']) { c.systems[id].romDirs = [await api.pick({ kind: 'folder' })]; c.systems[id].emulator = det.systems[id].emulator; }
        c.setupDone = true; await api.saveConfig(c); });
      await page.goto(url); await page.waitForTimeout(6000);
      const t3 = await page.evaluate(() => { const t = document.getElementById('tabs'); return { names: [...t.querySelectorAll('.tab')].map(b => b.textContent), x: t.classList.contains('tabs-x') }; });
      check('Console bar: only shelves with games (plus Home / Apps)', t3.x && t3.names.join() === 'GameCube,PS1,SNES,Apps', t3.names.join(', '));
      // 23 consoles with games: the bar keeps the current one in the middle, and a switch doesn't lay the bar out again
      const big = await page.evaluate(async () => { const wait = ms => new Promise(r => setTimeout(r, ms)), lib = JSON.parse(JSON.stringify(await window.boxshelf.cachedLibrary()));
        const gc = lib.find(s => s.id === 'gc'), out = BS_ANDROID.SYSTEMS.map(s => ({ ...JSON.parse(JSON.stringify(gc)), id: s.id, name: s.name, games: gc.games.map(g => ({ ...g, file: g.file + '#' + s.id })) }));
        await Shelf.refresh(false, out.concat(lib.filter(s => s.kind === 'apps'))); await wait(800);
        const t = document.getElementById('tabs'), r0 = t.getBoundingClientRect(), hud = document.querySelector('.hud-top .right').getBoundingClientRect();
        let reads = 0; const od = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft');
        Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { if (this.classList && this.classList.contains('tab')) reads++; return od.get.call(this); } });
        for (let i = 0; i < 12; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(450); }
        Object.defineProperty(HTMLElement.prototype, 'offsetLeft', od); await wait(1200);
        // where the strip is headed (its transition may still be waiting for a frame in this software-drawn runner)
        const on = t.querySelector('.tab.on'), r1 = t.getBoundingClientRect(), x = -parseFloat((/translate3d\((-?[\d.]+)px/.exec(t.querySelector('.tab-strip').style.transform) || [0, 0])[1]);
        return { n: t.querySelectorAll('.tab').length, off: Math.round(4 + on.offsetLeft - x + on.offsetWidth / 2 - r1.width / 2), same: Math.abs(r0.width - r1.width) < 1 && Math.abs(r0.left - r1.left) < 1,
          clear: r1.right <= hud.left, edges: t.className, reads, strip: t.querySelector('.tab-strip').style.transform };
      });
      await page.screenshot({ path: path.join(OUT, '6-console-bar-23.png'), clip: { x: 0, y: 0, width: 853, height: 80 } });
      check('Console bar with 29 consoles: current one centred, edges fade, bar never moves or re-measures',
        big.n === 30 && Math.abs(big.off) <= 3 && big.same && big.clear && /more-l/.test(big.edges) && /more-r/.test(big.edges) && big.reads === 0,
        `${big.n} tabs, ${big.off}px off centre, bar still ${big.same}, clear of the clock ${big.clear}, ${big.edges}, ${big.reads} layout reads`);
      // touch: drag the strip sideways, then a tap on a tab picks that shelf
      const cdp = await ctx.newCDPSession(page);
      await page.evaluate(() => { window.__tp = null; addEventListener('touchstart', e => { window.__tp = window.__tp || [e.touches[0].clientX]; }, { capture: true, once: true }); });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 10, y: 400 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const k = 10 / ((await page.evaluate(() => window.__tp)) || [10])[0];
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: x * k, y: y * k }] });
      const bar = await page.evaluate(() => { const r = document.getElementById('tabs').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, s: document.querySelector('.tab-strip').style.transform }; });
      const on0 = await page.evaluate(() => document.querySelector('#tabs .tab.on').textContent);
      await touch('touchStart', bar.x, bar.y); for (let i = 1; i <= 10; i++) { await touch('touchMove', bar.x + 30 * i, bar.y); await page.waitForTimeout(16); } await touch('touchEnd');
      // (beta.7) wait until the strip has stopped (the same position three reads in a row) before aiming the tap. The drag is a
      // quick flick on purpose: Chromium makes no click for the first tap after a flick (it takes it as "stop the fling"),
      // and the tap only works because android-touch.js clicks it then ("tapped Switch → Genesis" = that tap did nothing)
      await page.waitForTimeout(300);
      for (let i = 0, last = '', same = 0; i < 60 && same < 3; i++) { const s = await page.evaluate(() => document.querySelector('.tab-strip').style.transform + '|' + [...document.querySelectorAll('#tabs .tab')].map(e => Math.round(e.getBoundingClientRect().left)).join(','));
        same = s === last ? same + 1 : 0; last = s; await page.waitForTimeout(100); }
      const dragged = await page.evaluate(() => ({ s: document.querySelector('.tab-strip').style.transform, on: document.querySelector('#tabs .tab.on').textContent }));
      const tgt = await page.evaluate(() => { const r = document.getElementById('tabs').getBoundingClientRect(); const b = [...document.querySelectorAll('#tabs .tab')].find(e => { const q = e.getBoundingClientRect(); return !e.classList.contains('on') && q.left > r.left + 60 && q.right < r.right - 60; }); const q = b.getBoundingClientRect(); return { name: b.textContent, x: q.left + q.width / 2, y: q.top + q.height / 2 }; });
      await touch('touchStart', tgt.x, tgt.y); await touch('touchEnd'); await page.waitForTimeout(1500);
      const picked = await page.evaluate(() => document.querySelector('#tabs .tab.on').textContent);
      check('Console bar: a finger drags it, a tap picks a shelf (the drag picked nothing)', dragged.s !== bar.s && dragged.on === on0 && picked === tgt.name,
        `strip ${bar.s} → ${dragged.s}; tapped ${tgt.name} → ${picked}`);
      // (beta.7) the same on the shelf: a quick flick, then one tap on the case beside the chosen one picks it (exactly once:
      // a second click would open it). Before the fix that first tap did nothing on Android.
      { await page.waitForTimeout(600);
        const st = await page.evaluate(() => ({ x: innerWidth / 2, y: innerHeight * .55, cur: (Shelf._lib.cur() || {}).title }));
        await touch('touchStart', st.x, st.y); for (let i = 1; i <= 8; i++) { await touch('touchMove', st.x - 25 * i, st.y); await page.waitForTimeout(16); } await touch('touchEnd');
        await page.waitForTimeout(1500);
        const before = await page.evaluate(() => (Shelf._lib.cur() || {}).title);
        const nb = await page.evaluate(() => { const ss = [...document.querySelectorAll('.slot')].map(e => e.getBoundingClientRect()).filter(r => r.width > 20 && r.left > 40 && r.right < innerWidth - 40)
          .sort((a, b) => Math.abs(a.left + a.width / 2 - innerWidth / 2) - Math.abs(b.left + b.width / 2 - innerWidth / 2)); const r = ss[1]; return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; });
        let after = null, clicks = -1;
        if (nb) { await page.evaluate(() => { window.__slotClicks = 0; document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.slot')) window.__slotClicks++; }); });
          await touch('touchStart', nb.x, nb.y); await touch('touchEnd'); await page.waitForTimeout(1500);
          after = await page.evaluate(() => (Shelf._lib.cur() || {}).title); clicks = await page.evaluate(() => window.__slotClicks); }
        check('Shelf: after a quick flick, one tap on the next case picks it (Chromium drops that tap; android-touch.js clicks it once)',
          !!nb && !!before && !!after && after !== before && clicks === 1, `${st.cur} → flick → ${before} → tap the case beside it → ${after} (${clicks} click${clicks === 1 ? '' : 's'})`); }
      check('Less clutter pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }
    // ---------- pass 7: the handheld Art Studio (top screen) and its bottom-screen companion ----------
    // Opened from the bottom screen's Box art button (0.3.5: the quick menu's row opens the console's whole studio): a row per part with the versions side by side, the controller moves
    // (part, version) and A puts one in; the bottom screen shows the parts as tabs and the versions as a grid, and a tap
    // there puts one in too. Drawn at the real sizes (top 1440 x 810, bottom 1240 x 1080) for the screenshots.
    { const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, hasTouch: true });
      ctx.setDefaultTimeout(90000); const page = await ctx.newPage(), errors = []; page.setDefaultTimeout(120000);
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
      const url = base + '?fakeNative=1';
      await page.goto(url); await page.waitForTimeout(4000);
      await page.evaluate(async () => {
        const api = window.boxshelf, info = await api.getConfig(), det = await api.detect(), c = info.config;
        const d0 = await api.pick({ kind: 'folder' }); c.systems.gc.romDirs = [d0]; c.systems.gc.emulator = det.systems.gc.emulator;
        c.setupDone = true; await api.saveConfig(c); await api.scan(); });
      await page.goto(url + '&bottomPreview=1'); await page.waitForTimeout(6500);
      // onto Pikmin, then the quick menu's Art Studio row
      for (let i = 0; i < 6 && !/^Pikmin/.test(await page.evaluate(() => Shelf._qs().g || '')); i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(700); }
      await page.addStyleTag({ content: '#thorHud,#bsBottomPreview{visibility:hidden!important}' }); // (test overlays: the screenshots show the studio alone)
      // the handheld studio on the game: the bottom screen's Box art button (0.3.5; the quick menu's row is checked at the end)
      const row = await page.evaluate(() => Shelf.bottomCmd('art') !== false);
      await page.waitForTimeout(3500);
      const top = await page.evaluate(() => { const s = window.BS_STUDIO && BS_STUDIO._state(), el = document.getElementById('bsStudio');
        const small = [...document.querySelectorAll('#bsStudio *')].filter(e => e.childElementCount === 0 && e.textContent.trim() && e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 13.5 && !e.closest('.bst-row:not(.on) .cap')).map(e => e.textContent.trim().slice(0, 20));
        const r = el && el.getBoundingClientRect(), over = [...document.querySelectorAll('#bsStudio .bst-head,#bsStudio .bst-body,#bsStudio .bst-foot')].some(e => { const q = e.getBoundingClientRect(); return q.right > innerWidth + 1 || q.bottom > innerHeight + 1; });
        return { s, on: !!(el && el.classList.contains('on')), cards: document.querySelectorAll('#bsStudio .bst-row.on .bst-card:not(.act)').length, pics: [...document.querySelectorAll('#bsStudio .bst-row.on .bst-card img')].filter(i => i.complete && i.naturalWidth).length,
          ring: !!document.querySelector('#bsStudio .bst-row.on .bst-ring.on'), small, over, w: r && r.width, h: r && r.height, game: Shelf._qs().g,
          // (0.3.5) the full set beside the rows, with the bottom screen on too: the case (front, spine, back) and the disc out
          pv: getComputedStyle(document.querySelector('#bsStudio .bst-pv')).display !== 'none' && document.querySelector('#bsStudio .bst-pv').getBoundingClientRect().width > 300,
          faces: ['.bst-box .f', '.bst-box .s', '.bst-box .b', '.bst-dsk'].every(q => !!document.querySelector('#bsStudio ' + q)),
          dimmed: (() => { const c = [...document.querySelectorAll('#bsStudio .bst-row.on .bst-card')]; const o = c.map(e => +getComputedStyle(e).opacity); const k = c.findIndex(e => e.classList.contains('cur')); return k >= 0 && o[k] === 1 && o.some((v, i) => i !== k && v < 0.9); })(),
          rowsRight: Math.round(document.querySelector('#bsStudio .bst-rows').getBoundingClientRect().right), dual: !!(window.BS_BOTTOM_STUDIO && BS_BOTTOM_STUDIO.on()) }; });
      await page.screenshot({ path: path.join(OUT, '7-art-studio-top.png') });
      check('Bottom screen Box art: opens the handheld studio on the game', row && top.on && top.s && top.s.part === 'front' && top.w === 1440 && top.h === 810 && !top.over,
        `row ${row}, open ${top.on}, part ${top.s && top.s.part}, ${top.w}x${top.h}, overflow ${top.over}, game ${top.game}`);
      check('Art Studio: the front row shows every version big, with a focus ring; no tiny text', top.cards >= 3 && top.pics >= 3 && top.ring && !top.small.length,
        `${top.cards} versions, ${top.pics} pictures, ring ${top.ring}, small text: ${top.small.join(' / ') || 'none'}`);
      check('Art Studio (0.3.5): the full set beside the rows (case and disc, with the version under the cursor), bottom screen on too; the other versions dimmed',
        top.pv && top.faces && top.s.view === 'front' && !!top.s.faces.front && top.rowsRight < 1100 && top.dimmed, `set column ${top.pv}, faces ${top.faces}, view ${top.s.view}, front ${!!top.s.faces.front}, rows end at ${top.rowsRight}px, bottom ${top.dual}, dimmed ${top.dimmed}`);
      // (0.3.1) no SteamGridDB key or IGDB sign-in here: the front row ends with a "More art sources" card naming both
      // (0.3.3: and LaunchBox, whose database isn't on this pretend device yet)
      // (beta.12: a card of its own for each, saying what it brings; LaunchBox's downloads right there)
      const more = await page.evaluate(() => [...document.querySelectorAll('#bsStudio .bst-row.on .bst-card.act')].map(c => c.querySelector('.cap b').textContent + ' | ' + c.querySelector('.cap span').textContent));
      check('Art Studio: the front row ends with a card for each art source not set up (LaunchBox art to download, SteamGridDB, IGDB), each saying what it brings',
        more.some(t => /^LaunchBox art \| .*110 MB/.test(t)) && more.some(t => /^SteamGridDB \| /.test(t)) && more.some(t => /^IGDB \| /.test(t)) && !more.some(t => /More art sources/.test(t)), JSON.stringify(more));
      // controller (keyboard here: the same actions): down to Back, right, A puts that version in; L/R-style Tab wraps
      await page.keyboard.press('ArrowDown'); await page.waitForTimeout(2500);
      const s1 = await page.evaluate(() => BS_STUDIO._state()); await page.screenshot({ path: path.join(OUT, '7-art-studio-top-back.png') });
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300); const s2 = await page.evaluate(() => BS_STUDIO._state());
      const saved0 = await page.evaluate(() => __fakeArt.saved.length);
      await page.keyboard.press('Enter'); await page.waitForTimeout(1800);
      const s3 = await page.evaluate(() => ({ st: BS_STUDIO._state(), saved: __fakeArt.saved.slice(-1)[0], n: __fakeArt.saved.length, shelfStill: Shelf._qs().g }));
      const backRow = s3.st.rows.find(r => r.part === 'back');
      check('Art Studio controller: down = next part, right = next version, A puts it in (saved, marked in use)',
        s1.part === 'back' && s1.view === 'back' && s2.i === s1.i + 1 && s3.n === saved0 + 1 && /Pikmin/.test(s3.saved && s3.saved.name || '') && backRow.inUse && backRow.inUse !== 'current' && /^Pikmin/.test(s3.shelfStill),
        `part ${s1.part} (set turned to ${s1.view}), cursor ${s1.i}→${s2.i}, saved ${s3.saved && s3.saved.name} (${saved0}→${s3.n}), in use ${backRow.inUse}, shelf still on ${s3.shelfStill}`);
      // a screen of its own: once faded in, the shelf under it is skipped (no styling, layout or drawing)
      const full = await page.evaluate(() => { const t = document.getElementById('track'); let top = t; while (top && top.parentElement !== document.body) top = top.parentElement;
        return { full: document.body.classList.contains('bst-full'), shelf: top ? getComputedStyle(top).contentVisibility : 'none', studio: getComputedStyle(document.getElementById('bsStudio')).contentVisibility }; });
      check('Art Studio is a screen of its own: the shelf behind it is not drawn while it is up', full.full && full.shelf === 'hidden' && full.studio !== 'hidden', JSON.stringify(full));
      // the bottom screen: the case only (no menu), turned to the part being edited, with the version under the cursor in
      // place; on to the spine, then the disc (the case opens on its tray)
      const fr = page.frame({ url: /bottom\.html/ });
      let bot = { err: 'no bottom frame' };
      if (fr) {
        const look = async () => { const m = await page.evaluate(() => [...__fakeBottom].reverse().find(x => x.type === 'studio')); const b = await fr.evaluate(() => {
            const s = bsBottom.state(), op = q => { const e = document.querySelector(q); return e ? +getComputedStyle(e).opacity : -1; }, im = q => { const e = document.querySelector(q); return e ? e.getAttribute('src') : null; };
            return { studio: s.studio, focus: s.focus, ry: Math.round(((s.ry % 360) + 360) % 360), open: s.open, close: op('#focusClose'), chips: op('.v-case .open-bar'), tabs: op('.tabs'), back: im('.case .f-back .print img'), spine: im('.case .f-spine .print img'), disc: im('.case .media .disc img') }; });
          return { m: m && { open: m.open, part: m.part, back: m.art && m.art.back, spine: m.art && m.art.spine, game: !!m.game }, b }; };
        const back = await look();
        // the next versions along show on the case too, each one a picture that really loaded (0.3.0 showed them blank)
        const vers = [];
        for (let k = 0; k < 2; k++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(1000); const v = await look();
          const ok = await fr.evaluate(() => { const e = document.querySelector('.case .f-back .print img'); return !!e && e.complete && e.naturalWidth > 0; });
          vers.push({ sent: v.m && v.m.back, shown: v.b.back, ok }); }
        await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(1000);
        bot.vers = vers;
        await page.keyboard.press('ArrowDown'); await page.waitForTimeout(1600); const spine = await look();
        await page.keyboard.press('ArrowDown'); await page.waitForTimeout(1600); const disc = await look();
        bot = { back, spine, disc, vers: bot.vers };
      }
      const V_ = bot.vers || [], javaBs = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'io', 'github', 'boxshelf', 'BottomScreen.java'), 'utf8'); } catch { return ''; } })();
      const fileResp = (javaBs.match(/private WebResourceResponse fileResponse[\s\S]*?\n    \}/) || [''])[0];
      check('Bottom screen during Art Studio: the 2nd and 3rd versions show on the case too (and the bottom screen may open the app cache they live in)',
        V_.length === 2 && V_.every(v => v.ok && v.sent && v.shown === v.sent) && V_[0].sent !== V_[1].sent && !!bot.back && V_[0].sent !== bot.back.m.back && /getCacheDir\(\)/.test(fileResp),
        JSON.stringify({ vers: V_.map(v => ({ ok: v.ok, same: v.shown === v.sent, sent: String(v.sent).slice(0, 40) })), cacheServed: /getCacheDir\(\)/.test(fileResp) }));
      const B_ = bot.back && bot.back.b;
      check('Bottom screen during Art Studio: the case only (no menu, no buttons), turned to the back, showing the version under the cursor',
        !!B_ && B_.studio && !B_.studio.menu && B_.focus && B_.close === 0 && B_.chips === 0 && B_.tabs === 0 && bot.back.m.part === 'back' && bot.back.m.game && Math.abs(B_.ry - 200) <= 2 && !!B_.back && B_.back === bot.back.m.back,
        JSON.stringify(B_ ? Object.assign({}, B_, { studio: B_.studio && { menu: B_.studio.menu }, back: B_.back === (bot.back.m && bot.back.m.back) ? 'same as sent' : B_.back, part: bot.back.m && bot.back.m.part }) : bot.back));
      check('Bottom screen during Art Studio: the spine turns into view, the disc opens the case on its tray',
        !!bot.spine && bot.spine.m.part === 'spine' && Math.abs(bot.spine.b.ry - 80) <= 2 && bot.spine.b.spine === bot.spine.m.spine && !bot.spine.b.open && bot.disc.m.part === 'disc' && bot.disc.b.open,
        JSON.stringify({ spine: bot.spine && { part: bot.spine.m.part, ry: bot.spine.b.ry, same: bot.spine.b.spine === bot.spine.m.spine }, disc: bot.disc && { part: bot.disc.m.part, open: bot.disc.b.open } }));      // the controller itself (app.js hands the pad over through BS_MODAL): the first read only notes what's held, then RB
      // steps to the next part (Disc wraps round to Front) and holding right repeats along the versions
      const padT = await page.evaluate(() => { const gp = on => ({ axes: [on.x || 0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!on[i], value: on[i] ? 1 : 0 })) });
        const was = BS_STUDIO._state().part, t = performance.now();
        const took = BS_MODAL(gp({}), t); BS_MODAL(gp({ 5: 1 }), t + 20); const p1 = BS_STUDIO._state().part; BS_MODAL(gp({}), t + 40);
        BS_MODAL(gp({ 5: 1 }), t + 50); const p2 = BS_STUDIO._state().part; BS_MODAL(gp({}), t + 55); // (0.3.5: Disc wraps round to Sets, then Front)
        const i0 = BS_STUDIO._state().i; for (let k = 0; k < 40; k++) BS_MODAL(gp({ x: 0.9 }), t + 60 + k * 20); BS_MODAL(gp({}), t + 900);
        return { took, was, p1, p2, i0, i1: BS_STUDIO._state().i }; });
      check('Art Studio controller (pad): RB changes part (wraps), a held stick repeats along the versions',
        padT.took && padT.was === 'disc' && padT.p1 === 'sets' && padT.p2 === 'front' && padT.i1 >= padT.i0 + 2, JSON.stringify(padT));
      // (0.3.5) Sets, one up from Front: whole matching sets and the looks; the set column shows the case with it put in, and
      // A puts a set (or, with none here, a look) in
      await page.keyboard.press('ArrowUp');
      const setsA = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); let s = BS_STUDIO._state();
        for (let i = 0; i < 300 && !(s.part === 'sets' && s.rows[0].state === 'ready'); i++) { await w(200); s = BS_STUDIO._state(); } return s; });
      await page.screenshot({ path: path.join(OUT, '7-art-studio-sets.png') });
      const pickAt = (k => k >= 0 ? k : setsA.keys.indexOf('look:region:usa'))(setsA.keys.findIndex(k => /^set:/.test(k)));
      for (let k = setsA.i; k < pickAt; k++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150); }
      const savedS = await page.evaluate(() => __fakeArt.saved.length);
      await page.keyboard.press('Enter');
      const setsB = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); await w(400); let s = BS_STUDIO._state();
        for (let i = 0; i < 300 && s.busy; i++) { await w(200); s = BS_STUDIO._state(); } return Object.assign(s, { saved: __fakeArt.saved.length }); });
      check('Art Studio (0.3.5): a Sets row above Front (sets, then the HD and region looks); A puts the whole set (or look) in',
        setsA.part === 'sets' && setsA.view === 'front' && ['look:hd', 'look:region:usa', 'look:region:eur', 'look:region:jpn'].every(k => setsA.keys.includes(k)) && pickAt >= 0 && setsB.i === pickAt && setsB.saved > savedS && !setsB.busy,
        `row ${setsA.part}, view ${setsA.view}, items ${setsA.keys.join(',')}, picked ${setsA.keys[pickAt]}, saved ${savedS}→${setsB.saved}, "${setsB.msg}"`);
      await page.keyboard.press('ArrowDown'); await page.waitForTimeout(600); // (back on Front)
      // the bottom screen at its real size, from the last message the shelf sent it
      const last = await page.evaluate(() => [...__fakeBottom].reverse().find(m => m.type === 'studio' && m.open));
      const bp = await ctx.newPage(); await bp.setViewportSize({ width: 1240, height: 1080 });
      await bp.goto(base.replace('index.html', 'bottom.html?demo=0')); await bp.waitForTimeout(800);
      await bp.evaluate(m => bsBottom.recv(m), last); await bp.waitForTimeout(1500);
      await bp.screenshot({ path: path.join(OUT, '7-art-studio-bottom.png') }); await bp.close();
      // B closes it: back on the shelf on the same game, the bottom screen gets the game again, the press didn't reach the shelf
      const swipeScr = await page.evaluate(() => window.BS_TOUCH && BS_TOUCH.screen()); // an edge swipe is Back here, not shelf browsing
      await page.keyboard.press('Escape'); await page.waitForTimeout(1500);
      const end = await page.evaluate(sw => ({ swipeScr: sw, open: BS_STUDIO.isOpen(), mode: Shelf._qs().mode, g: Shelf._qs().g, lastMsg: (__fakeBottom.slice(-1)[0] || {}).type, full: document.body.classList.contains('bst-full') }), swipeScr);
      check('Art Studio: B / Back closes it onto the shelf (same game), the bottom screen shows the game again',
        !end.full && !end.open && end.swipeScr === 'studio' && end.mode === 'browse' && /^Pikmin/.test(end.g) && end.lastMsg === 'game', JSON.stringify(end));
      // (0.3.5) the quick menu's Art Studio row opens the console's whole studio (its games, shelf look and sets) in Settings
      await page.evaluate(() => Shelf.quickMenu()); await page.waitForTimeout(900);
      await page.evaluate(() => { const r = [...document.querySelectorAll('#quickMenu .qm-row')].find(e => /Art Studio/.test(e.textContent)); if (r) r.click(); });
      const qsStudio = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 60 && !(window.Settings && Settings.isOpen() && Settings._state().studio); i++) await w(200);
        const st = window.Settings && Settings.isOpen() ? Settings._state() : null, r = { st: st && st.studio, handheld: !!(window.BS_STUDIO && BS_STUDIO.isOpen()) };
        if (window.Settings && Settings.isOpen()) { await Settings.close(); } for (let i = 0; i < 30 && document.querySelector('#bss.on'); i++) await w(150); await w(600); return r; });
      check('Quick menu (0.3.5): Art Studio opens the console\'s whole studio, not the one game', qsStudio.st && qsStudio.st.v === 'games' && qsStudio.st.sys === 'gc' && !qsStudio.handheld, JSON.stringify(qsStudio));
      check('Art Studio pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }

    // ---------- pass 8: box art progress card, queue order, download limits (a bigger pretend library: ?fakeMany=1) ----------
    { const { ctx, page, errors } = await newPage(browser, null);
      const url = base + '?fakeNative=1&fakeMany=1';
      await page.goto(url); await page.waitForTimeout(4000);
      await page.evaluate(async () => { const api = window.boxshelf, c = (await api.getConfig()).config, det = await api.detect();
        const dirs = [await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' })];
        for (const [i, id] of ['gc', 'psx', 'snes'].entries()) { c.systems[id].romDirs = [dirs[i]]; c.systems[id].emulator = det.systems[id].emulator; }
        c.setupDone = true; await api.saveConfig(c); await api.scan();
        for (let i = 0; i < 600 && !(api.artProgress().total && !api.artProgress().running); i++) await new Promise(r => setTimeout(r, 100));
        // forget the art again (keep the setup): the next start fetches it all, with the shelf up
        for (const k of Object.keys(localStorage)) if (/^fake:(art\.json|dirs|displays|library\.json|lr-)/.test(k)) localStorage.removeItem(k);
        localStorage.setItem('boxshelf-ui', JSON.stringify({ sys: 'psx', sel: 6 })); }); // (the shelf opens on PlayStation, not the first console)
      await page.addInitScript(() => { window.__artLat = 900; });
      await page.goto(url);
      await page.waitForFunction(() => window.__fakeArt && window.Shelf && Shelf.artFocus && Shelf.artFocus() && __fakeArt.fetch.length > 0, null, { timeout: 60000 });
      const a = await page.evaluate(async () => { __fakeArt.lat = window.__artLat; await new Promise(r => setTimeout(r, 1500));
        const f = Shelf.artFocus(true), el = document.querySelector('.bs-artcard');
        return { sys: f.sys, first: __fakeArt.fetch.slice(0, 4).map(x => x.name), show: !!el && el.classList.contains('show'), fixed: !!el && getComputedStyle(el).position === 'fixed',
          text: el ? el.innerText.replace(/\n/g, ' | ') : '' }; });
      await page.screenshot({ path: path.join(OUT, '8-art-progress.png') });
      check('Art progress card: shows "Fetching art" with counts and the games being looked up', a.show && a.fixed && /Fetching art \| \d+\/\d+ \| \S/.test(a.text), a.text);
      check('Art queue: the shelf in front is fetched first', a.sys === 'psx' && a.first.length && a.first.every(n => /^(Psx Game|Crash|Final Fantasy)/.test(n)), `${a.sys}: ${a.first.join(', ')}`);
      // on to the next shelf (PlayStation → SNES): the next downloads follow
      await page.keyboard.press('ArrowDown'); await page.waitForTimeout(400);
      // (up to 4 jobs were already under way when you moved: those finish first, then the new shelf's games come)
      const b = await page.evaluate(async () => { const sys = Shelf.artFocus().sys, n0 = __fakeArt.fetch.length; await new Promise(r => setTimeout(r, 4500));
        const after = __fakeArt.fetch.slice(n0).map(x => x.name); let k = 0; while (k < 4 && k < after.length && !/^Snes Game/.test(after[k])) k++;
        // (beta.7) the new shelf's games come first, then the queue moves on: a fast run can finish the shelf inside the window
        // (the last SNES games, then another shelf's) and that's still right; only an SNES game after another shelf's is wrong
        const rest = after.slice(k), firstOther = rest.findIndex(n => !/^Snes Game/.test(n)), snesLater = firstOther >= 0 && rest.slice(firstOther).some(n => /^Snes Game/.test(n));
        return { sys, was: after.slice(0, k), next: after.slice(k, k + 4), snesFirst: firstOther === -1 ? rest.length : firstOther, snesLater }; });
      check('Art queue: moving to another shelf puts its games next', b.sys === 'snes' && b.snesFirst >= 2 && !b.snesLater, `${b.sys}: ${b.was.length} already under way, then ${b.next.join(', ')}`);
      await page.evaluate(() => { __fakeArt.lat = 40; });
      await page.waitForFunction(() => !window.boxshelf.artProgress().running, null, { timeout: 120000, polling: 100 });
      const c = await page.evaluate(async () => { const el = document.querySelector('.bs-artcard'), done = { show: el.classList.contains('show'), text: el.innerText.replace(/\n/g, ' | ') };
        await new Promise(r => setTimeout(r, 2800)); return { done, gone: !el.classList.contains('show'), peak: __fakeArt.peak, prog: window.boxshelf.artProgress() }; });
      check('Art progress card: says what was added, then fades away', c.done.show && /Added art for \d+ games/.test(c.done.text) && c.gone, `${c.done.text} → ${c.gone ? 'hidden' : 'still shown'}`);
      check('Art downloads: 4 at once at most, libretro ≤ 3, GameTDB ≤ 2', c.peak.all <= 4 && c.peak.all >= 3 && (c.peak['thumbnails.libretro.com'] || 0) <= 3 && (c.peak['art.gametdb.com'] || 0) <= 2 && c.prog.done === c.prog.total,
        JSON.stringify(c.peak) + ` · ${c.prog.done}/${c.prog.total}`);
      check('Art progress pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }
    // ---------- pass 9: heat (perf-meter.js counts the work): nothing drawn while idle, on either screen ----------
    // The pretend Thor with its controller plugged in (connected, untouched) and the bottom page in its preview frame.
    // Counts, not timings: frames the page asked for, WebGL draw calls, running animations.
    { const PAD = `(() => { const pad = window.__pad = { id: 'Thor pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
        window.__gpReads = 0; Navigator.prototype.getGamepads = function () { window.__gpReads++; return [pad, null, null, null]; }; })();`;
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, hasTouch: true });
      ctx.setDefaultTimeout(120000); await ctx.addInitScript({ content: PAD });
      const page = await ctx.newPage(), errors = []; page.setDefaultTimeout(120000);
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
      const url = base + '?fakeNative=1';
      await page.goto(url); await page.waitForTimeout(4000);
      await page.evaluate(async () => { const api = window.boxshelf, c = (await api.getConfig()).config, det = await api.detect();
        const d = [await api.pick({ kind: 'folder' }), await api.pick({ kind: 'folder' })];
        c.systems.gc.romDirs = [d[0]]; c.systems.gc.emulator = det.systems.gc.emulator; c.systems.psx.romDirs = [d[1]]; c.systems.psx.emulator = det.systems.psx.emulator;
        c.setupDone = true; await api.saveConfig(c); await api.scan(); });
      await page.goto(url + '&bottomPreview=1'); await page.bringToFront();
      const bot = () => page.frames().find(f => /bottom\.html/.test(f.url()));
      const quiet = async ms => { await page.evaluate(() => BS_METER.reset()); const fr = bot(); if (fr) await fr.evaluate(() => BS_METER.reset()).catch(() => {});
        await page.waitForTimeout(ms);
        return { top: await page.evaluate(() => BS_METER.snap(true)), bottom: fr ? await fr.evaluate(() => BS_METER.snap(true)).catch(() => null) : null }; };
      // the shelf, left alone (after the first 20 s, when the start-up watch stops by itself)
      await page.waitForFunction(() => performance.now() > 21500 && window.BS_METER && BS_METER.idleFor() > 5500, null, { timeout: 60000, polling: 250 });
      // (the bottom case's one slow sway, 12 s after it was last touched, ends by itself: on a slow machine it can still be
      // under way here, so its end is waited for, up to 20 s; then nothing may move at all)
      { const fr = bot(); if (fr) await fr.waitForFunction(() => !document.getAnimations().some(a => a.playState === 'running'), null, { timeout: 20000, polling: 250 }).catch(() => {}); }
      const shelf = await quiet(3000); shelf.still = await page.evaluate(() => document.body.classList.contains('bs-still'));
      check('Heat: an idle shelf draws nothing (top screen asks for no frames; decoration paused)', shelf.top.framesPerSec === 0 && shelf.top.idleFrames === 0 && shelf.still, JSON.stringify(shelf.top) + ' still ' + shelf.still);
      check('Heat: an idle bottom screen is completely still (no frames, no running animations)', !!shelf.bottom && shelf.bottom.framesPerSec === 0 && shelf.bottom.anims === 0, JSON.stringify(shelf.bottom));
      // a press on the controller wakes it at once: the pad is read at the full rate again (~60 a second; on the shelf from a
      // timer since 0.3.2, so it no longer asks for a frame every vsync), decoration moves again
      const woke = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); BS_METER.reset();
        window.__pad.buttons[15].pressed = true; window.__pad.buttons[15].value = 1; await w(120); window.__pad.buttons[15].pressed = false; window.__pad.buttons[15].value = 0; await w(300);
        const r0 = window.__gpReads, t0 = performance.now(); await w(500); const reads = +((window.__gpReads - r0) / ((performance.now() - t0) / 1000)).toFixed(1);
        return Object.assign(BS_METER.snap(), { still: document.body.classList.contains('bs-still'), padReadsPerSec: reads }); });
      check('Heat: a controller press wakes the shelf straight away (pad read at the full rate)', woke.padReadsPerSec >= 35 && !woke.still && !woke.idle, JSON.stringify(woke));
      // the museum: it goes to sleep (no frames, no draw calls) once left alone, with a pool of 3 row lamps; a press wakes it
      await page.keyboard.press('m'); await page.waitForTimeout(5000);
      await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 6 && window.Museum && Museum._dv && Museum._dv(); i++) { Museum.skipDelivery(); await w(800); } });
      const lights = await page.evaluate(() => Museum._lights());
      // (it only sleeps once every cover is in: on a slow software-drawing machine that can take a couple of minutes)
      const t0 = Date.now(); await page.waitForFunction(() => Museum.sleeping(), null, { timeout: 150000, polling: 500 }).catch(() => {}); const sleptAfter = Math.round((Date.now() - t0) / 1000);
      const mus = await quiet(2500); mus.sleeping = await page.evaluate(() => Museum.sleeping());
      check('Heat: an idle museum sleeps (no frames, no draw calls)', mus.sleeping && mus.top.framesPerSec === 0 && mus.top.drawsPerSec === 0, JSON.stringify(mus.top) + ' sleeping ' + mus.sleeping + ' (after ' + sleptAfter + ' s)');
      check('Heat: museum lamps are a pool of 3 spot lights (plus the selection spot), not one per row', lights.spots <= 4, JSON.stringify(lights));
      // a Room change from the bottom screen wakes a sleeping museum and keeps it awake to show the change (0.3.0 drew one
      // frame and fell straight back asleep, so the room never changed)
      if (mus.sleeping) {
        const rm = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); BS_METER.reset();
          const ok = Shelf.bottomCmd('room', { key: 'light', val: 'daylight' }); await w(1500);
          // (CI draws in software: the first frame after a room change can take several seconds; wait for it, up to 10 s)
          let s = BS_METER.snap(); for (let i = 0; i < 17 && !(s.framesPerSec > 0 && s.drawsPerSec > 0); i++) { await w(500); s = BS_METER.snap(); }
          return Object.assign(s, { ok, sleeping: Museum.sleeping() }); });
        check('Heat: a Room change from the bottom screen wakes the sleeping museum (and it stays awake to show it)', rm.ok && !rm.sleeping && rm.framesPerSec > 0 && rm.drawsPerSec > 0, JSON.stringify(rm));
      }
      // (no frame rate threshold: software drawing can be ~1 frame a second; woken and drawing is what counts)
      const mw = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); BS_METER.reset(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await w(1500);
        // (CI draws in software: the first frame after a step can take seconds; wait for it, up to 10 s)
        let s = BS_METER.snap(); for (let i = 0; i < 17 && !(s.framesPerSec > 0 && s.drawsPerSec > 0); i++) { await w(500); s = BS_METER.snap(); }
        return Object.assign(s, { sleeping: Museum.sleeping(), mode: Shelf.getMode() }); });
      check('Heat: a press wakes the museum and it draws again', !mw.sleeping && mw.mode === 'museum' && mw.framesPerSec > 0 && mw.drawsPerSec > 0, JSON.stringify(mw));
      // the shelf under the museum isn't drawn once the room has faded in
      const under = await page.evaluate(() => getComputedStyle(document.getElementById('scene')).visibility);
      check('Heat: the shelf under the museum is not drawn', under === 'hidden', under);
      // the Thor test meter (0.4.0): off by default (nothing shown, no loop); turned on, tap to small, tap to hidden (its loop
      // stopped), tap back to big
      const hud = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), el = document.getElementById('thorHud'), tap = () => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const off = Object.assign(__thorHud(), { shown: getComputedStyle(el).display !== 'none' }); __thorHudSet('big'); await w(200);
        const a = __thorHud(); tap(); await w(100); const b = __thorHud(); tap(); await w(300); const c = __thorHud(); tap(); await w(100); const back = __thorHud(); __thorHudSet('off'); return { off, a, b, c, back }; });
      check('Heat: the Thor test meter starts off (not shown, no loop); on, it taps big → small → hidden (its loop stopped) → big',
        hud.off.view === 'off' && !hud.off.looping && !hud.off.shown && hud.a.view === 'big' && hud.b.view === 'small' && hud.c.view === 'hidden' && !hud.c.looping && hud.back.view === 'big' && hud.back.looping, JSON.stringify(hud));
      check('Heat pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
      await ctx.close(); }
    // ---------- (beta.12) RomM on the pretend Thor: pairing, the library merged into the shelves, Play downloads first, B stops it (ci/romm-android-pass.js) ----------
    await require('./romm-android-pass')({ browser, base, check, newPage, OUT });
    // (beta.12) readable on the Thor: Automatic text size, Largest, the shelf / Details labels, the bottom screen's buttons (ci/textsize-test.js)
    await require('./textsize-test')({ browser, base, check, newPage, OUT });
    // (beta.12) the bottom screen's companions (reading, Find, Details), Consoles, Apps and Screen off (ci/bottom-companion-test.js)
    await require('./bottom-companion-test')({ browser, base, check, newPage, OUT });
    // (beta.12) Thor touch: a double tap picks the case up, a swipe up opens Details, down closes it (ci/touch-gestures-test.js)
    await require('./touch-gestures-test')({ browser, base, check, newPage, OUT });
    // (beta.13) Settings by touch on Android: a text setting opens Boxshelf's keyboard, its keys and Paste type (ci/settings-touch-test.js)
    await require('./settings-touch-test')({ browser, base, check, newPage, OUT });
    } // ===== end of group thor =====
    if (runs('screens')) { // ===== group screens: passes 10-17 =====
    // ---------- pass 10: magazines & guides (0.3.2): the store, downloads, the reading corner (ci/reading-test.js) ----------
    await require('./reading-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 11: RetroAchievements (0.3.5): sign-in, matching (titles, ROM hashes), badges, unlocks (ci/ra-test.js) ----------
    await require('./ra-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 12: the extra shelf themes (0.3.5; Windows too since 1.75): each applies, the bottom screen wears
    // it, no frame loop at the Handheld level (ci/themes-test.js) ----------
    await require('./themes-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 13: menu music (1.75): on by default, the three tracks, quick menu and Settings (ci/music-test.js) ----------
    await require('./music-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 14: the box art screens (1.80): the Box art page, the games grid, a game's page with tabs (ci/artui-test.js) ----------
    await require('./artui-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 15: the public beta (1.82): new-install defaults, version order, update notice and Settings rows (ci/beta-test.js) ----------
    await require('./beta-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 16: PC games beyond Steam (beta.4): Epic, Quiver Launcher, the Custom shelf (ci/pcgames-test.js) ----------
    await require('./pcgames-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 17: other Android screens (0.4.0): a 20:9 phone, a small phone, a 16:10 tablet (ci/screens-test.js) ----------
    await require('./screens-test')({ browser, base, check, newPage, OUT });
    // (0.5) phones, tablets and foldables upright and on their side, the Thor unchanged; a rotation relays out once (ci/portrait-test.js)
    await require('./portrait-test')({ browser, base, check, newPage, OUT });
    // (beta.12) manuals and guides readable on small screens: zoom, pan, one page, the page kept, pinch (ci/reader-zoom-test.js)
    await require('./reader-zoom-test')({ browser, base, check, newPage, OUT });
    // (beta.12) Android Details: the trailer's sound button and the screenshot viewer (ci/android-media-test.js)
    await require('./android-media-test')({ browser, base, check, newPage, OUT });
    // (beta.12) a game's own emulator and core on Android (ci/gameemu-test.js)
    await require('./gameemu-test')({ browser, base, check, newPage, OUT });
    } // ===== end of group screens =====
    if (runs('windows')) { // ===== group windows: passes 18-24 =====
    // ---------- pass 18: the retro shelves (beta.6): PlayStation, NES … Dreamcast through RetroArch (ci/retro-test.js) ----------
    await require('./retro-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 19: the library (beta.7): Details redone, filters by decade / genre / players, collections (ci/library-test.js) ----------
    await require('./library-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 20: beta.7 consoles, the arcade list, Set up for me, the tidy first run (ci/setup-test.js) ----------
    await require('./setup-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 21: video previews (beta.7): finding them, Details, YouTube, behind the shelf, Settings, first run (ci/previews-test.js) ----------
    await require('./previews-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 22: What's new after updating, the update card with its highlights, the notes in Settings (ci/whatsnew-test.js) ----------
    await require('./whatsnew-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 23: Add games: several programs, a folder, Playnite (experimental), the Custom shelf's tile (ci/addgames-pass.js) ----------
    await require('./addgames-pass')({ browser, base, check, newPage, OUT });
    // ---------- pass 24: beta testers' reports (beta.10): 8BitDo prompts, ARMSX2 and unknown emulator apps on Android, custom games on the PC shelf, the Switch's emulator name (ci/issues-test.js) ----------
    await require('./issues-test')({ browser, base, check, newPage, OUT });
    // ---------- pass 25 (beta.11): DuckStation under any of its names, DeSmuME, mGBA and VisualBoyAdvance-M found and started with their own options (ci/emu-names-test.js, plain Node) ----------
    { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, 'emu-names-test.js')], { encoding: 'utf8', timeout: 60000 });
      check('Other emulators (DuckStation builds, DeSmuME, mGBA, VisualBoyAdvance-M) are found and get their own launch options', r.status === 0, ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 4).join(' | ')); }
    // ---------- (beta.12) RocketLauncher: its systems, names, command line, log and launch (ci/rocket-test.js, plain Node) ----------
    { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, 'rocket-test.js')], { encoding: 'utf8', timeout: 60000 });
      check('RocketLauncher: its systems and ROM folders are read, each console gets its name, the command line is right (by name or full path, never -f), a run\'s error is read from its log', r.status === 0, ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 4).join(' | ')); }
    // ---------- (beta.12) RomM: the client against a pretend RomM server (ci/romm-test.js, plain Node), then Settings and the shelf (ci/romm-ui-test.js) ----------
    { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, 'romm-test.js')], { encoding: 'utf8', timeout: 240000 });
      check('RomM client: pairing (QR device flow and code), the library first and then only what changed, offline from the saved copy, covers once, resumable checked downloads, multi-file games unpacked safely', r.status === 0, ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 4).join(' | ')); }
    await require('./romm-ui-test')({ browser, base, check, newPage, OUT });
    // (beta.12) Minus / View: Details on Windows (held: the museum), Settings on the Thor (ci/minus-test.js)
    await require('./minus-test')({ browser, base, check, newPage, OUT });
    // (beta.12) the Art Studio's Spine page: an "Up close" strip, short wide cards, the neighbours shelf bigger (ci/spinepage-test.js)
    await require('./spinepage-test')({ browser, base, check, newPage, OUT });
    // (beta.12) the Art Studio shows what it has while a slow source is still answering; the late version joins (ci/artlate-test.js)
    await require('./artlate-test')({ browser, base, check, newPage, OUT });
    // (beta.12) attract mode unfocused / pace / one shelf, and a controller's stale first press (ci/attract-test.js)
    await require('./attract-test')({ browser, base, check, newPage, OUT });
    // (beta.12) the quick menu's start-up warm-up is never seen sliding away (ci/qmwarm-test.js)
    await require('./qmwarm-test')({ browser, base, check, newPage, OUT });
    // (beta.12) Linux / Steam Deck: the "Leaving a game" card, Start at login, Power through systemctl (ci/linuxqol-test.js)
    await require('./linuxqol-test')({ browser, base, check, newPage, OUT });
    // (beta.12) Details' screenshot viewer: A opens one full screen, left / right go through them, B back (ci/shotview-test.js)
    await require('./shotview-test')({ browser, base, check, newPage, OUT });
    // (beta.12) Reduce motion: the system's animation switch no longer stops the shelf sliding (ci/motion-test.js)
    await require('./motion-test')({ browser, base, check, newPage, OUT });
    // (beta.12) the achievements screen: a badge wall with rarity rims and a card for the one you're on (ci/achwall-test.js)
    await require('./achwall-test')({ browser, base, check, newPage, OUT });
    // (beta.12) Linux Game Mode's own file / folder browser, and the Linux tour's "Leaving a game" (ci/picker-test.js)
    await require('./picker-test')({ browser, base, check, newPage, OUT });
    // (beta.12, every platform) Find a game: the Search button, the quick menu's first row, typing, the letter grid (ci/find-test.js)
    await require('./find-test')({ browser, base, check, newPage, OUT });
    { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, 'artlate-main-test.js')], { encoding: 'utf8', timeout: 60000 });
      check('Art Studio sources (main): the list goes back after 1.2 s with what answered, slow sources join as late cards then listDone, a reopen reuses the list, fresh asks again', r.status === 0, ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 4).join(' | ')); }
    // ---------- pass 26 (beta.11): the shelf tour on Windows, from Settings → Shelf; never on Android (ci/tour-test.js) ----------
    await require('./tour-test')({ browser, base, check, newPage, OUT });
    // (beta.11) console trailers: a dead or missing trailer link gets YouTube searched for one (ci/ytsearch-test.js, plain Node)
    { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, 'ytsearch-test.js')], { encoding: 'utf8', timeout: 60000 });
      check('Console trailers: a game with no trailer link, or a dead one, gets its trailer found by a YouTube search (remembered)', r.status === 0, ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 4).join(' | ')); }
    // (beta.11) magazine downloads: a crawling connection is picked up again from where it got to (ci/archive-speed-test.js, plain Node)
    { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, 'archive-speed-test.js')], { encoding: 'utf8', timeout: 90000 });
      check('Magazine downloads: a crawling connection is dropped and carries on from where it got to; the file arrives whole', r.status === 0, ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 4).join(' | ')); }
    // (beta.12) Seamless play: Steam and store games watched, never a launcher closed, the 90 s give-up, nothing polled when idle (ci/gamewatch-test.js, plain Node)
    { const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, 'gamewatch-test.js')], { encoding: 'utf8', timeout: 60000 });
      check('Seamless play: Steam / store games are watched (started, ended, launcher hand-over, 90 s give-up), close() never touches a launcher, nothing polls when idle', r.status === 0, ((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 4).join(' | ')); }
    // ---------- pass 27 (beta.12): Seamless play on the Windows page: a watched Steam game, Settings rows, the Home menu's Go to desktop (ci/seamless-pass.js) ----------
    await require('./seamless-pass')({ browser, base, check, newPage, OUT });
    } // ===== end of group windows =====
    check('Every file the page loads is in the APK', !missing.size, [...missing].join(', '));
  } catch (e) { check('Test ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : e); }
  await browser.close(); server.close();

  const failed = checks.filter(c => !c.ok);
  say(`### Boxshelf device test${GROUP === 'all' ? '' : ' (' + GROUP + ')'}: ${failed.length ? 'FAILED' : 'PASSED'} (${checks.length - failed.length}/${checks.length})`);
  say(''); say('| | check | detail |'); say('|---|---|---|');
  for (const c of checks) say(`| ${c.ok ? '✅' : '❌'} | ${c.name} | ${c.detail.replace(/\|/g, '/').slice(0, 180)} |`);
  say(''); say(failed.length ? '**No APK is published for this run.** Screenshots are in the "device-test" artifact.' : '**The APK below passed and is safe to install.**');
  if (SUM) fs.appendFileSync(SUM, lines.join('\n') + '\n');
  process.exit(failed.length ? 1 : 0);
});
