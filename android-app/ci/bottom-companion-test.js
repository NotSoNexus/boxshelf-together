// Device test (beta.12, Android): the Thor bottom screen's new parts, on the pretend Thor with the real bottom page in its
// frame. Consoles: a touch takes the big screen to that shelf. Find a game: the bottom keyboard types into the search up
// top, and a match there goes to the game. Details: the companion shows while it's open, and Back closes it. A manual:
// the reading companion turns pages, switches one / two pages and closes the reader. Apps: the device's apps (icons
// asked for in small batches), a touch opens one; Wi-Fi opens Android's page. Screen off: the page goes dark, keeps what
// the shelf sends for later, and a tap wakes it.
'use strict';
module.exports = async function bottomCompanionPass({ browser, base, check }) {
  const errors = [], o = {};
  const ctx = await browser.newContext({ viewport: { width: 853, height: 480 }, deviceScaleFactor: 2.25, hasTouch: true, isMobile: true });
  const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
  const until = async (fn, ms = 6000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = await fn(); } catch {} if (v) return v; if (Date.now() - t0 > ms) return v; await p.waitForTimeout(150); } };
  try {
    // set up as the main pass does (three consoles from the pretend folders), then the page again with the bottom frame
    await p.goto(base + '?fakeNative=1'); await p.waitForTimeout(4000);
    await p.evaluate(async () => { const api = window.boxshelf, info = await api.getConfig(), det = await api.detect(), c = info.config;
      for (const id of ['gc', 'psx', 'snes']) { c.systems[id].romDirs = [await api.pick({ kind: 'folder' })]; c.systems[id].emulator = det.systems[id].emulator; }
      c.setupDone = true; await api.saveConfig(c); await api.scan(); });
    await p.goto(base + '?fakeNative=1&bottomPreview=1'); await p.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && Shelf.getMode() === 'browse', null, { timeout: 90000, polling: 250 });
    await p.waitForTimeout(2500);
    const fr = p.frame({ url: /bottom\.html/ }); if (!fr) throw new Error('no bottom frame');
    const bs = () => fr.evaluate(() => bsBottom.state());
    o.tabs = await fr.evaluate(() => [...document.querySelectorAll('.tabs .tab')].map(t => t.dataset.tab).join());
    // ----- Consoles -----
    await fr.evaluate(() => bsBottom.setTab('sys')); await p.waitForTimeout(500);
    o.sys = await fr.evaluate(() => ({ n: document.querySelectorAll('.sys-it').length, on: (document.querySelector('.sys-it.on') || {}).dataset ? document.querySelector('.sys-it.on').dataset.sys : null, other: ([...document.querySelectorAll('.sys-it:not(.on)')][0] || {}).dataset }));
    o.sys.want = o.sys.other && o.sys.other.sys;
    if (o.sys.want) { await fr.evaluate(id => document.querySelector(`.sys-it[data-sys="${id}"]`).click(), o.sys.want); await until(() => p.evaluate(id => (Shelf.bottomShelves().find(s => s.cur) || {}).id === id, o.sys.want)); }
    o.sys.now = await p.evaluate(() => (Shelf.bottomShelves().find(s => s.cur) || {}).id);
    await p.waitForTimeout(1200);
    // ----- racing through a shelf: one bottom-screen update, after a longer rest; the bottom page's fades go brisk -----
    await p.evaluate(() => { window.__sel = []; addEventListener('bs-select', () => __sel.push(performance.now())); }); await p.waitForTimeout(1200);
    await p.evaluate(() => { __sel.length = 0; });
    for (let k = 0; k < 5; k++) { await p.keyboard.press(k % 2 ? 'ArrowLeft' : 'ArrowRight'); await p.evaluate(() => { window.__lastMove = performance.now(); }); await p.waitForTimeout(160); }
    await p.waitForTimeout(1800);
    o.race = await p.evaluate(() => ({ n: __sel.length, after: __sel.length ? Math.round(__sel[__sel.length - 1] - __lastMove) : -1 }));
    o.race.brisk = await fr.evaluate(() => { const s = document.body.classList; bsBottom.recv({ type: 'game', game: Object.assign(bsBottom.demo(), { id: 'r1' }) }); bsBottom.recv({ type: 'game', game: Object.assign(bsBottom.demo(), { id: 'r2' }) }); return s.contains('brisk'); });
    await p.waitForTimeout(1500);
    // ----- the moving backdrop holds still while the shelf slides, and carries on once it has landed -----
    // (the Handheld level, as on the Thor: software drawing here would otherwise pick Low, whose backdrop is a still picture)
    o.fx = await p.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); Perf.set('handheld'); Shelf.setTheme('spectrum'); await w(2500);
      if (window.BS_METER) BS_METER.input(); const id = ThemeFx._state().id, t0 = ThemeFx._state().t; await w(400); const t1 = ThemeFx._state().t; return { id, moving: t1 > t0 }; });
    await p.keyboard.press('ArrowRight'); if (!(await p.evaluate(() => BS_SLIDING()))) await p.keyboard.press('ArrowLeft'); // (at the end of the shelf: the other way)
    o.fx.busy = await p.evaluate(() => BS_SLIDING()); await p.waitForTimeout(80);
    o.fx.slide0 = await p.evaluate(() => ThemeFx._state().t); await p.waitForTimeout(380);
    o.fx.slide1 = await p.evaluate(() => ThemeFx._state().t); await p.evaluate(() => window.BS_METER && BS_METER.input()); await p.waitForTimeout(2200);
    o.fx.after = await p.evaluate(() => { const t = ThemeFx._state().t; Perf.set('auto'); return t; });
    // ----- Find a game -----
    await p.evaluate(() => BS_FIND.open('ptr')); await until(async () => (await bs()).ctx === 'find');
    o.find = { ctx: (await bs()).ctx };
    // (the top screen: just the field and the matches; the bottom screen is the keyboard)
    o.find.top = await p.evaluate(() => { const f = document.getElementById('bsFind'), i = f.querySelector('.fg-in');
      return { kb: f.classList.contains('bottomkb'), grid: getComputedStyle(f.querySelector('.fg-keys')).display, focused: document.activeElement === i, ph: i.placeholder }; });
    await until(() => p.evaluate(() => BS_FIND._st().loaded));
    const first = await p.evaluate(() => { const L = Shelf._find.games(); return L.length ? L[0].title : ''; });
    const two = first.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
    for (const ch of two) { await fr.evaluate(k => document.querySelector(`.fd-k[data-k="${k}"]`).click(), ch); await p.waitForTimeout(250); }
    await until(async () => (await fr.evaluate(() => document.querySelectorAll('.fd-row').length)) > 0);
    // (Find types a capital to start, then small letters)
    o.find.q = await p.evaluate(() => BS_FIND._st().q); o.find.want = two.slice(0, 1) + two.slice(1).toLowerCase(); o.find.pad = await p.evaluate(() => BS_FIND._st().pad);
    o.find.rows = await fr.evaluate(() => document.querySelectorAll('.fd-row').length); o.find.field = await fr.evaluate(() => document.querySelector('.fd-q').textContent);
    await fr.evaluate(() => document.querySelector('.fd-k[data-fd="back"]').click()); await p.waitForTimeout(300); o.find.back = await p.evaluate(() => BS_FIND._st().q);
    await fr.evaluate(k => document.querySelector(`.fd-k[data-k="${k}"]`).click(), two[1]); await p.waitForTimeout(400);
    await until(async () => (await fr.evaluate(() => document.querySelectorAll('.fd-row').length)) > 0);
    const pick = await fr.evaluate(() => document.querySelector('.fd-row b').textContent);
    await fr.evaluate(() => document.querySelector('.fd-row').click());
    await until(async () => (await p.evaluate(() => Shelf.getMode())) === 'browse' && (await bs()).ctx === null);
    o.find.after = { mode: await p.evaluate(() => Shelf.getMode()), g: await p.evaluate(() => Shelf._qs().g), pick, ctx: (await bs()).ctx };
    await p.waitForTimeout(1500);
    // ----- Details -----
    await p.evaluate(() => Shelf.bottomCmd('details')); await until(async () => (await bs()).ctx === 'details');
    o.det = { ctx: (await bs()).ctx, title: await fr.evaluate(() => document.querySelector('.ctx .cx-title').textContent), g: await p.evaluate(() => Shelf._qs().g) };
    await fr.evaluate(() => document.querySelector('[data-dt="close"]').click());
    await until(async () => (await p.evaluate(() => Shelf.getMode())) === 'browse' && (await bs()).ctx === null);
    o.det.after = { mode: await p.evaluate(() => Shelf.getMode()), ctx: (await bs()).ctx };
    await p.waitForTimeout(1200);
    // ----- a manual: the reading companion -----
    for (let i = 0; i < 10; i++) { if (await p.evaluate(() => { const g = Shelf._lib.cur(); return !!(g && g.kind === 'rom'); })) break; await p.keyboard.press('ArrowRight'); await p.waitForTimeout(400); }
    await p.waitForTimeout(800);
    await p.evaluate(() => Shelf.bottomCmd('manual')); await until(() => p.evaluate(() => Shelf._rd().open), 45000); // (a made-up booklet takes a while on a slow machine)
    await until(async () => (await bs()).ctx === 'reader', 10000);
    const pg = () => p.evaluate(() => (Shelf.bottomCtx() || {}).page);
    o.rd = { ctx: (await bs()).ctx, p0: await pg(), one0: await p.evaluate(() => (Shelf.bottomCtx() || {}).one) };
    await fr.evaluate(() => document.querySelector('[data-rd="next"]').click()); await p.waitForTimeout(700); o.rd.p1 = await pg();
    o.rd.label = await fr.evaluate(() => document.querySelector('.rd-label').textContent);
    await fr.evaluate(() => document.querySelector('.rd-pg').click()); await p.waitForTimeout(700); o.rd.one1 = await p.evaluate(() => (Shelf.bottomCtx() || {}).one);
    await fr.evaluate(() => document.querySelector('[data-rd="zin"]').click()); await p.waitForTimeout(600); o.rd.zoom = await p.evaluate(() => (Shelf.bottomCtx() || {}).zoom);
    await fr.evaluate(() => document.querySelector('[data-rd="fit"]').click()); await p.waitForTimeout(600); o.rd.fit = await p.evaluate(() => (Shelf.bottomCtx() || {}).zoom);
    await fr.evaluate(() => document.querySelector('[data-rd="close"]').click()); await until(async () => !(await p.evaluate(() => Shelf._rd().open)) && (await bs()).ctx === null);
    o.rd.after = { open: await p.evaluate(() => Shelf._rd().open), ctx: (await bs()).ctx };
    for (let k = 0; k < 3 && (await p.evaluate(() => Shelf.getMode())) !== 'browse'; k++) { await p.keyboard.press('Escape'); await p.waitForTimeout(900); }
    // ----- Apps -----
    await fr.evaluate(() => bsBottom.setTab('apps')); await until(async () => (await bs()).apps > 0);
    await until(async () => (await fr.evaluate(() => document.querySelectorAll('img.ap-ic').length)) > 0);
    o.apps = { n: (await bs()).apps, imgs: await fr.evaluate(() => document.querySelectorAll('img.ap-ic').length), asks: await p.evaluate(() => (window.__fakeIconAsks || []).slice()) };
    const l0 = await p.evaluate(() => window.__fakeLaunches.length);
    // (an app that draws on one screen: a DS / 3DS emulator takes both, checked next)
    const DUAL = '(melonds|drastic|citra|azahar|lime3ds|borked3ds|mandarine|panda3ds|cemu)';
    await fr.evaluate(re => ([...document.querySelectorAll('.ap')].find(b => !new RegExp(re, 'i').test(b.dataset.pkg)) || document.querySelector('.ap')).click(), DUAL); await p.waitForTimeout(900);
    o.apps.launched = (await p.evaluate(() => window.__fakeLaunches.length)) - l0;
    o.apps.keep = await p.evaluate(() => { const r = window.__fakeLaunches[window.__fakeLaunches.length - 1] || {}; return { pkg: r.pkg, keepBottom: r.keepBottom, screen: r.screen || '' }; });
    await p.waitForTimeout(1800);
    o.apps.dual = await fr.evaluate(re => { const b = [...document.querySelectorAll('.ap')].find(b => new RegExp(re, 'i').test(b.dataset.pkg)); if (b) b.click(); return b ? b.dataset.pkg : null; }, DUAL); await p.waitForTimeout(900);
    if (o.apps.dual) o.apps.dualKeep = await p.evaluate(() => (window.__fakeLaunches[window.__fakeLaunches.length - 1] || {}).keepBottom);
    await p.waitForTimeout(1800); // (the pretend app "closes")
    // ----- (beta.13) holding an app: its menu (top / bottom screen, Shortcuts, App info) -----
    const hold = () => fr.evaluate(async () => { const b = document.querySelector('.ap'), r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, clientX: x, clientY: y })); await new Promise(f => setTimeout(f, 750));
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5, clientX: x, clientY: y })); b.click(); await new Promise(f => setTimeout(f, 200));
      const m = document.getElementById('apMenu'); return { pkg: b.dataset.pkg, shown: !!m && !m.hidden, items: m ? [...m.querySelectorAll('[data-am]')].map(x => x.dataset.am).join() : '' }; });
    const hm = { l0: await p.evaluate(() => window.__fakeLaunches.length) };
    hm.menu = await hold(); hm.noLaunch = (await p.evaluate(() => window.__fakeLaunches.length)) === hm.l0; // (the hold's own tap opens nothing)
    await fr.evaluate(() => document.querySelector('#apMenu [data-am="bottom"]').click()); await p.waitForTimeout(800);
    hm.bottom = await p.evaluate(() => { const r = window.__fakeLaunches[window.__fakeLaunches.length - 1] || {}; return { screen: r.screen, pkg: r.pkg, chip: !!document.getElementById('bsAwayChip'), away: boxshelf.bottomAway && boxshelf.bottomAway() }; });
    hm.closed = await fr.evaluate(() => document.getElementById('apMenu').hidden);
    await p.evaluate(() => document.getElementById('bsAwayChip').click()); await p.waitForTimeout(500);
    hm.back = await p.evaluate(() => ({ called: (window.__fakeCalls || []).includes('bottomBack'), chip: !!document.getElementById('bsAwayChip'), away: boxshelf.bottomAway() }));
    await hold(); await fr.evaluate(() => document.querySelector('#apMenu [data-am="info"]').click()); await p.waitForTimeout(500);
    hm.info = await p.evaluate(pkg => (window.__fakeCalls || []).includes('appInfo:' + pkg), hm.menu.pkg);
    await hold(); await fr.evaluate(() => document.querySelector('#apMenu [data-am="sc"]').click()); await p.waitForTimeout(300);
    hm.sc = await fr.evaluate(pkg => JSON.parse(localStorage.getItem('bs-bottom:shortcuts') || localStorage.getItem('shortcuts') || '[]').includes('app:' + pkg) || [...document.querySelectorAll('#more [data-sc]')].some(b => b.dataset.sc === 'app:' + pkg), hm.menu.pkg);
    await fr.evaluate(() => bsBottom.setTab('more')); await p.waitForTimeout(400);
    hm.scTile = await fr.evaluate(pkg => !!document.querySelector(`#more [data-sc="app:${pkg}"]`), hm.menu.pkg);
    await fr.evaluate(() => bsBottom.setTab('apps')); await p.waitForTimeout(400);
    o.hold = hm;
    o.clip = await p.evaluate(async () => { window.__fakeClip = 'KEY-42'; return typeof boxshelf.clipRead === 'function' ? await boxshelf.clipRead() : null; });
    await fr.evaluate(() => document.querySelector('.ap-s[data-sa="wifi"]').click()); await p.waitForTimeout(500);
    o.apps.wifi = await p.evaluate(() => (window.__fakeCalls || []).includes('openSettingsPage:wifi'));
    // ----- Screen off -----
    await fr.evaluate(() => bsBottom.setTab('more')); await p.waitForTimeout(400);
    o.sleep = { tile: await fr.evaluate(() => !!document.querySelector('#more .tile[data-cmd="sleep"]')) };
    await fr.evaluate(() => { document.getElementById('more').scrollLeft = 99999; document.querySelector('#more .tile[data-cmd="sleep"]').click(); }); await p.waitForTimeout(800);
    await fr.waitForFunction(() => getComputedStyle(document.getElementById('sleep')).opacity === '1', null, { timeout: 6000, polling: 150 }).catch(() => {}); // (its fade to black finished: slower on a slow machine)
    o.sleep.dark = await fr.evaluate(() => document.body.classList.contains('asleep') && getComputedStyle(document.getElementById('sleep')).opacity === '1');
    const n0 = await p.evaluate(() => window.__fakeBottom.length);
    await p.keyboard.press('ArrowRight'); await p.waitForTimeout(1800); // (the shelf moves: its message waits)
    o.sleep.sent = (await p.evaluate(() => window.__fakeBottom.length)) > n0;
    o.sleep.kept = await fr.evaluate(() => bsBottom.state().title) !== await p.evaluate(() => Shelf._qs().g);
    await fr.evaluate(() => { const s = document.getElementById('sleep'); s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 })); }); await p.waitForTimeout(900);
    o.sleep.awake = await fr.evaluate(() => !document.body.classList.contains('asleep'));
    o.sleep.caught = (await fr.evaluate(() => bsBottom.state().title)) === (await p.evaluate(() => Shelf._qs().g));
  } catch (e) { o.err = e.message; }
  await ctx.close();
  const S = o.sys || {}, F = o.find || {}, D = o.det || {}, R = o.rd || {}, A = o.apps || {}, Z = o.sleep || {};
  check('Bottom screen (beta.12): Consoles lists the shelves, the one in view lit; a touch takes the big screen to another', S.n >= 2 && !!S.on && !!S.want && S.now === S.want, JSON.stringify({ S, err: o.err }));
  const FT = (o.find || {}).top || {};
  check('Bottom screen (beta.12): the tabs are Apps, Game, Trophies, Consoles, Shortcuts', o.tabs === 'apps,case,trophies,sys,more', String(o.tabs));
  check('Find on the Thor with the bottom screen on: the top screen shows only the field and the matches (no letter grid, no Android keyboard); the bottom screen is the keyboard',
    FT.kb === true && FT.grid === 'none' && FT.focused === false && /bottom screen/.test(FT.ph || ''), JSON.stringify(FT));
  const FX = o.fx || {};
  check('Speed (beta.12, Android): the moving backdrop holds still while the shelf slides and carries on once it has landed',
    FX.id === 'spectrum' && FX.moving && FX.busy && FX.slide1 === FX.slide0 && FX.after > FX.slide1, JSON.stringify(FX));
  const RC = o.race || {};
  check('Bottom screen (beta.12, speed): racing through a shelf sends the bottom screen one update, after a longer rest (0.9 s); quick updates make its fades brisk',
    RC.n === 1 && RC.after >= 800 && RC.after < 1600 && RC.brisk === true, JSON.stringify(RC));
  check('Bottom screen: Find a game shows its keyboard; letters type into the search up top (no letter grid, no Android keyboard), Delete works, a match goes to the game',
    F.ctx === 'find' && F.q === F.want && F.pad === false && F.rows > 0 && F.field === F.want && F.back === (F.want || '').slice(0, 1) && F.after && F.after.mode === 'browse' && F.after.g === F.after.pick && F.after.ctx === null, JSON.stringify(F));
  check('Bottom screen: the Details companion shows while Details is open (its title), Back closes Details', D.ctx === 'details' && D.title === D.g && D.after && D.after.mode === 'browse' && D.after.ctx === null, JSON.stringify(D));
  check('Bottom screen: the reading companion turns the page, switches one / two pages, zooms and back, Done closes the reader',
    R.ctx === 'reader' && R.p1 > R.p0 && /Page|Pages/.test(R.label || '') && R.one1 === !R.one0 && R.zoom === true && R.fit === false && R.after && !R.after.open && R.after.ctx === null, JSON.stringify(R));
  check('Bottom screen: Apps lists the device\'s apps with their icons (asked for 12 at a time at most), a touch opens one, Wi-Fi opens Android\'s page',
    A.n > 0 && A.imgs > 0 && Array.isArray(A.asks) && A.asks.length > 0 && A.asks.every(n => n <= 12) && A.launched === 1 && A.wifi, JSON.stringify(A));
  check('Bottom screen (beta.13): an app opened with a tap goes to the top screen and leaves Boxshelf\'s bottom screen up; a DS / 3DS emulator gets both screens',
    (A.keep || {}).keepBottom === true && (A.keep || {}).screen === '' && (!A.dual || A.dualKeep === false), JSON.stringify({ keep: A.keep, dual: A.dual, dualKeep: A.dualKeep }));
  const H = o.hold || {};
  check('Bottom screen (beta.13): holding an app opens its menu (top screen, bottom screen, Shortcuts, App info, Cancel) and opens nothing itself',
    !!H.menu && H.menu.shown && H.menu.items === 'top,bottom,sc,info,x' && H.noLaunch, JSON.stringify(H));
  check('Bottom screen (beta.13): "Open on bottom screen" opens the app there; the top screen shows a button that brings Boxshelf\'s bottom screen back',
    !!H.bottom && H.bottom.screen === 'bottom' && H.bottom.pkg === (H.menu || {}).pkg && H.bottom.chip && H.bottom.away === H.bottom.pkg && H.closed && !!H.back && H.back.called && !H.back.chip && H.back.away === '', JSON.stringify(H));
  check('Bottom screen (beta.13): the app menu opens Android\'s App info and adds the app to Shortcuts', H.info === true && H.scTile === true, JSON.stringify({ info: H.info, sc: H.sc, scTile: H.scTile }));
  check('Android (beta.13): the clipboard is read through the plugin (Settings\' Paste key)', o.clip === 'KEY-42', String(o.clip));
  check('Bottom screen: Screen off goes dark, keeps what the shelf sends meanwhile, and a tap wakes it showing the game now in view',
    Z.tile && Z.dark && Z.sent && Z.kept && Z.awake && Z.caught, JSON.stringify(Z));
  check('Bottom companion pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
};
