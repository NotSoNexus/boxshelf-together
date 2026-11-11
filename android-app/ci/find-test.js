// Device test (beta.12): Find a game (renderer/find.js), the search across every shelf.
// Windows 1280x720, keyboard and mouse: the Search button and the "Find" hint are on the shelf; / opens it on the field;
// typing lists the matches best first (starts with, then a word that starts with, then anywhere; capitals, accents and
// punctuation don't matter); no key reaches the shelf meanwhile; Esc closes without moving; Ctrl+F opens it too (and
// doesn't flip the case); Enter goes to the chosen game on another console's shelf; with nothing typed it lists what was
// played last; a click on the Search button opens it and a click on a result goes there.
// Windows 1920x1080, a pretend controller: the left stick's click held opens it on the letter grid (a tap is still
// Shuffle); the d-pad and A type, X deletes, Y is a space, RB goes to the results, A goes to the game; B closes without
// moving; the quick menu's first row opens it too.
// The Thor (853x480 @2.25) and a phone held upright (390x844): the Search button opens it on the field by touch, text is
// 20 px and up, rows and buttons are 48 dp and up, nothing spills sideways; the letter grid only with a controller.
// The Thor with its bottom screen on: a slim bar along the top (the matches in one row, nothing over the middle), the shelf
// under it steps to the highlighted match on the shelf in view and goes back when Find closes without a choice.
// Checks results, never speed. Screenshots (when the runner gives an OUT folder): find-*.png.
'use strict';
const path = require('path');
module.exports = async function findPass({ browser, base, check, OUT }) {
  const errors = [], o = {};
  const PAD = `(() => { const pad = window.__pad = { id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) }; Navigator.prototype.getGamepads = function () { return [pad, null, null, null]; }; })();`;
  const watch = page => { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); }); };
  const shot = async (page, name) => { if (OUT) await page.screenshot({ path: path.join(OUT, name) }).catch(() => {}); };
  const ready = async (page, q) => { await page.goto(base + q); await page.waitForFunction(() => window.Shelf && Shelf._qs && Shelf._qs().g && Shelf.getMode() === 'browse' && window.BS_FIND, null, { timeout: 90000, polling: 250 }); await page.waitForTimeout(4000); }; // (the start-up splash gone)
  const st = page => page.evaluate(() => { const s = BS_FIND._st(), e = document.getElementById('bsFind'), a = document.activeElement, f = Shelf.artFocus() || {};
    return Object.assign(s, { mode: Shelf.getMode(), shown: !!(e && getComputedStyle(e).display !== 'none'), field: !!(a && a.classList && a.classList.contains('fg-in')), value: e ? e.querySelector('.fg-in').value : '', cap: e ? e.querySelector('.fg-cap').textContent : '',
      g: Shelf._qs().g, sys: f.sys, gridOn: !!(e && getComputedStyle(e.querySelector('.fg-keys')).display !== 'none') }); });
  const loaded = page => page.waitForFunction(() => BS_FIND._st().loaded, null, { timeout: 8000, polling: 100 }).catch(() => {});
  // what's on screen: nothing past the edges, the smallest text, the heights of the things you press (dp: CSS px times k)
  const fit = (page, k) => page.evaluate(k => { const e = document.getElementById('bsFind'), vw = innerWidth, vh = innerHeight, vis = x => x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden';
    const parts = [...e.querySelectorAll('.fg-head,.fg-title,.fg-x,.fg-field,.fg-keys,.fg-key,.fg-res,.fg-list,.fg-hints,.fg-hint,.fg-cap')].filter(vis);
    const out = parts.filter(x => { const r = x.getBoundingClientRect(); return r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1; }).map(x => x.className);
    let font = 99, what = ''; for (const x of e.querySelectorAll('*')) { if (!vis(x) || x.closest('svg') || x.closest('.g') || x.closest('.fg-kc')) continue; if (![...x.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && x.tagName !== 'INPUT') continue; const f = parseFloat(getComputedStyle(x).fontSize); if (f < font) { font = f; what = x.className; } }
    const h = sel => { const L = [...e.querySelectorAll(sel)].filter(vis); return L.length ? Math.round(Math.min(...L.map(x => Math.min(x.getBoundingClientRect().height, sel === '.fg-row' ? 1e9 : x.getBoundingClientRect().width))) * k * 10) / 10 : null; };
    const list = e.querySelector('.fg-list'), field = e.querySelector('.fg-field').getBoundingClientRect(), res = e.querySelector('.fg-res').getBoundingClientRect(), keys = e.querySelector('.fg-keys').getBoundingClientRect();
    return { vw, vh, sw: document.scrollingElement.scrollWidth, out, font, what, row: h('.fg-row'), key: h('.fg-key'), x: h('.fg-x'), fieldH: Math.round(field.height * k * 10) / 10, listFits: list.scrollWidth <= list.clientWidth + 1,
      under: res.top >= field.bottom - 1, beside: res.left >= field.right - 1, keysUnderField: keys.height ? keys.top >= field.bottom - 1 : null, rows: e.querySelectorAll('.fg-row').length,
      titleCut: [...e.querySelectorAll('.fg-row .fg-t')].filter(t => t.getBoundingClientRect().width < 60).length, panelH: Math.round(e.getBoundingClientRect().height / vh * 100) / 100 }; }, k);

  // ---------- Windows 1280x720: keyboard and mouse ----------
  { const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } }); const page = await ctx.newPage(); watch(page);
    try {
      await ready(page, '?platform=windows&shelf=1&pcx=1'); // (pcx: a PC shelf too)
      o.s0 = await st(page);
      o.shelf = await page.evaluate(() => { const b = document.getElementById('findBtn'), r = b.getBoundingClientRect(), m = document.getElementById('menuBtn').getBoundingClientRect(), hb = document.querySelector('.hud-top').getBoundingClientRect();
        const hint = [...document.querySelectorAll('#hints .hint')].find(h => /Find/.test(h.textContent)), hr = hint && hint.getBoundingClientRect(), bar = document.getElementById('hints').getBoundingClientRect();
        return { btn: r.width > 16 && r.height > 16, title: b.title, left: r.right <= m.left + 1, inBar: r.left >= hb.left && r.right <= innerWidth && r.top >= 0, hint: hint ? hint.textContent.trim() : null, hintShown: !!hr && hr.width > 0 && hr.left >= 0 && hr.right <= innerWidth + 1,
          barFits: bar.right <= innerWidth + 1 && bar.left >= -1, barW: Math.round(bar.width), sw: document.scrollingElement.scrollWidth, vw: innerWidth }; });
      await shot(page, 'find-shelf-1280.png');
      // / opens it on the field; typing lists the matches, best first
      await page.keyboard.press('/'); await page.waitForTimeout(350); await loaded(page); o.open = await st(page);
      await page.keyboard.type('hollow', { delay: 30 }); await page.waitForTimeout(250); o.hollow = await st(page);
      await shot(page, 'find-keyboard-1280.png'); o.fitK = await fit(page, 1);
      // keys the shelf would act on do nothing to it
      for (const k of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(k);
      await page.waitForTimeout(300); o.quiet = await st(page);
      // capitals, accents and punctuation don't matter
      await page.keyboard.press('Control+a'); await page.keyboard.type('ÉCHO-hol', { delay: 30 }); await page.waitForTimeout(250); o.accent = await st(page);
      await page.keyboard.press('Control+a'); await page.keyboard.type('zzqx', { delay: 30 }); await page.waitForTimeout(250); o.none = await st(page); o.noneText = await page.evaluate(() => document.querySelector('#bsFind .fg-empty').textContent);
      await page.keyboard.press('Escape'); await page.waitForTimeout(500); o.esc = await st(page);
      // Ctrl+F opens it too; down and Enter go to the second match, on another console's shelf
      await page.keyboard.press('Control+f'); await page.waitForTimeout(350); await loaded(page); o.ctrlF = await st(page);
      await page.keyboard.type('pilot', { delay: 30 }); await page.waitForTimeout(250); o.pilot = await st(page);
      await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); o.pilotSel = await st(page);
      await page.keyboard.press('Enter'); await page.waitForTimeout(1500); o.went = await st(page);
      await shot(page, 'find-went-1280.png');
      o.wentBrand = await page.evaluate(() => ({ tab: (document.querySelector('#tabs .tab.on') || {}).textContent || '', cur: Shelf._lib.cur() }));
      // nothing typed: what was played last (two games given a play each)
      await page.evaluate(() => { const all = Shelf._mus.games(), a = all.find(g => g.title === 'Saltwind'), b = all.find(g => g.title === 'Kitebound'); Shelf._mus.hist({ [a.id]: { count: 1, ms: 6e5, last: Date.now() - 864e5 }, [b.id]: { count: 2, ms: 9e5, last: Date.now() - 36e5 } }); });
      // the mouse: the Search button opens it, a click on a result goes there
      await page.click('#findBtn'); await page.waitForTimeout(350); await loaded(page); await page.waitForTimeout(200); o.recent = await st(page);
      await shot(page, 'find-recent-1280.png');
      await page.keyboard.type('tide', { delay: 30 }); await page.waitForTimeout(250); o.tide = await st(page);
      await page.click('#bsFind .fg-row'); await page.waitForTimeout(1500); o.clicked = await st(page);
      // a PC game is found like any other, and Enter on the first match goes to the PC shelf
      await page.keyboard.press('/'); await page.waitForTimeout(350); await loaded(page); await page.keyboard.type('lantern', { delay: 30 }); await page.waitForTimeout(250); o.lantern = await st(page);
      await page.keyboard.press('Enter'); await page.waitForTimeout(1500); o.pc = await st(page);
      // a filter that hides the game (Favorites: none yet) is lifted so the shelf can show it
      o.filter = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); Shelf._lib.filter('fav'); await w(600); const left = Shelf._lib.games().length;
        const opened = BS_FIND.open('kbd'); for (let i = 0; i < 40 && !BS_FIND._st().loaded; i++) await w(50); return { left, opened }; });
      await page.keyboard.type('gridlock', { delay: 30 }); await page.waitForTimeout(250); await page.keyboard.press('Enter'); await page.waitForTimeout(1500); o.unfiltered = await st(page);
      // the tour's Find a game step opens it, and Skip (Esc) there closes it with the tour
      o.tour = await page.evaluate(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); if (!window.BS_TOUR || !BS_TOUR.start()) return { started: false };
        for (let i = 0; i < 12 && BS_TOUR._step() !== 'Find a game'; i++) { await w(1300); BS_TOUR._go(1); } await w(1800);
        const c = document.querySelector('#bsTour .bt-card').getBoundingClientRect(), sp = document.querySelector('#bsTour .bt-spot');
        return { started: true, step: BS_TOUR._step(), open: BS_FIND.isOpen(), mode: Shelf.getMode(), spot: !sp.classList.contains('none'), card: c.left >= 0 && c.right <= innerWidth + 1 && c.top >= 0 && c.bottom <= innerHeight + 1, keys: document.querySelector('#bsTour .bt-keys').textContent.trim() }; });
      await shot(page, 'find-tour-1280.png');
      await page.keyboard.press('Escape'); await page.waitForTimeout(1500); o.tourEnd = await page.evaluate(() => ({ on: BS_TOUR.on(), open: BS_FIND.isOpen(), mode: Shelf.getMode(), shown: getComputedStyle(document.getElementById('bsFind')).display !== 'none' }));
      // the letter grid at this size (as a controller would show it): everything on screen
      await page.evaluate(() => BS_FIND.open('pad')); await page.waitForTimeout(350); await loaded(page); await page.waitForTimeout(200); o.fitP = await fit(page, 1); await shot(page, 'find-pad-1280.png');
      await page.evaluate(() => BS_FIND.close()); await page.waitForTimeout(300);
    } catch (e) { o.err = e.message; }
    await ctx.close(); }

  // ---------- Windows 1920x1080: a controller ----------
  { const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); await ctx.addInitScript(PAD); const page = await ctx.newPage(); watch(page);
    const press = (b, ms) => page.evaluate(async ([b, ms]) => { const w = t => new Promise(r => setTimeout(r, t)); if (window.__padHold) { await __padHold(__pad, b, ms || 120); await w(260); return; } __pad.buttons[b] = { pressed: true, touched: true, value: 1 }; __pad.timestamp++; await w(ms || 120); __pad.buttons[b] = { pressed: false, touched: false, value: 0 }; __pad.timestamp++; await w(260); }, [b, ms]);
    try {
      await ready(page, '?platform=windows&shelf=1'); await press(15); await press(14); await page.waitForTimeout(600); // (the shelf has seen the controller)
      o.p0 = await st(page);
      o.padHint = await page.evaluate(() => { const h = [...document.querySelectorAll('#hints .hint')].find(x => /Find/.test(x.textContent)), r = h && h.getBoundingClientRect(), bar = document.getElementById('hints').getBoundingClientRect();
        return { text: h ? h.textContent.replace(/\s+/g, ' ').trim() : null, shown: !!r && r.width > 0, glyph: !!(h && h.querySelector('.g')), barFits: bar.left >= -1 && bar.right <= innerWidth + 1 }; });
      await shot(page, 'find-shelf-pad-1920.png');
      // a tap of the left stick's click is still Shuffle (never this); held, it opens on the letter grid
      await press(10, 120); await page.waitForTimeout(900); o.tap = await st(page);
      await page.waitForFunction(() => Shelf.getMode() === 'browse' && !Shelf._tour.busy(), null, { timeout: 8000, polling: 150 }).catch(() => {}); await page.waitForTimeout(500);
      o.p1 = await st(page);
      await press(10, 900); await page.waitForTimeout(300); await loaded(page); o.held = await st(page);
      // "Mo": down to I, right four to M, A; right two to O, A
      await press(13); for (let i = 0; i < 4; i++) await press(15); o.onM = (await st(page)).key; await press(0);
      await press(15); await press(15); await press(0); o.mo = await st(page);
      await press(2); o.del = await st(page); await press(0); await press(3); o.space = await st(page);
      await shot(page, 'find-pad-1920.png'); o.fitP2 = await fit(page, 1);
      o.hints = await page.evaluate(() => document.querySelector('#bsFind .fg-hints').textContent.replace(/\s+/g, ' ').trim());
      // RB to the results, down to the second, A: that game's shelf
      await press(5); o.zone = await st(page); await press(13); o.second = await st(page); await shot(page, 'find-pad-results-1920.png');
      await press(0); await page.waitForTimeout(1500); o.padWent = await st(page);
      // B closes without moving; the d-pad meanwhile moved the grid, not the shelf
      await press(10, 900); await page.waitForTimeout(300); await loaded(page); await press(15); await press(15); await press(13); o.padQuiet = await st(page);
      await press(1); await page.waitForTimeout(500); o.padB = await st(page);
      // the quick menu's first row
      await press(9); await page.waitForFunction(() => Shelf.quickMenuOpen(), null, { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(500);
      o.qmFirst = await page.evaluate(() => (document.querySelector('#quickMenu .qm-row') || {}).textContent || '');
      for (let i = 0; i < 10 && (await page.evaluate(() => Shelf._qs().id)) !== 'find'; i++) await press(12);
      await shot(page, 'find-quickmenu-1920.png');
      o.qmOn = await page.evaluate(() => Shelf._qs().id); await press(0); await page.waitForTimeout(400); await loaded(page); o.qm = await st(page);
      await press(1); await page.waitForTimeout(400); o.qmClosed = await st(page);
    } catch (e) { o.perr = e.message; }
    await ctx.close(); }

  // ---------- Android: the Thor (853x480 @2.25) and a phone held upright (390x844 @3), by touch ----------
  const android = async (vp, dpr, name) => { const r = {}; const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, isMobile: true, hasTouch: true }); const page = await ctx.newPage(); watch(page);
    try {
      await ready(page, '?platform=android&shelf=1');
      const k = await page.evaluate(w => w / innerWidth, vp.width); r.k = Math.round(k * 1000) / 1000; // dp per CSS px
      r.btn = await page.evaluate(k => { const b = document.getElementById('findBtn'), q = b.getBoundingClientRect(), cx = q.left + q.width / 2, cy = q.top + q.height / 2, hit = (dx, dy) => { const e = document.elementFromPoint(cx + dx, cy + dy); return !!e && (e === b || b.contains(e)); };
        const a = getComputedStyle(b, '::after'), aw = parseFloat(a.width) || q.width, ah = parseFloat(a.height) || q.height;
        return { shown: q.width > 0 && q.left >= 0 && q.right <= innerWidth && q.top >= 0, dpW: Math.round(Math.max(q.width, aw) * k), dpH: Math.round(Math.max(q.height, ah) * k), up: hit(0, -ah / 2 + 3), down: hit(0, ah / 2 - 3), menuStillMenu: (() => { const m = document.getElementById('menuBtn').getBoundingClientRect(), e = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2); return !!e && !!e.closest('#menuBtn'); })(), sw: document.scrollingElement.scrollWidth, vw: innerWidth }; }, k);
      r.s0 = await st(page); await shot(page, `find-shelf-${name}.png`);
      await page.tap('#findBtn'); await page.waitForTimeout(400); await loaded(page); r.open = await st(page);
      await page.keyboard.type('light', { delay: 30 }); await page.waitForTimeout(300); r.typed = await st(page); r.fit = await fit(page, k); await shot(page, `find-touch-${name}.png`);
      await page.tap('#bsFind .fg-row:nth-child(2)'); await page.waitForTimeout(1500); r.went = await st(page);
      // with a controller: the letter grid
      await page.evaluate(() => BS_FIND.open('pad')); await page.waitForTimeout(400); await loaded(page);
      await page.tap('#bsFind .fg-key[data-k="K"]'); await page.tap('#bsFind .fg-key[data-k="I"]'); await page.waitForTimeout(300); r.pad = await st(page); r.fitP = await fit(page, k); await shot(page, `find-pad-${name}.png`);
      await page.tap('#bsFind .fg-x'); await page.waitForTimeout(400); r.closed = await st(page);
      // (beta.12) the Thor with its bottom screen on (its status stood in for): the bottom screen is the keyboard, and up here
      // a slim bar along the top with the shelf in view under it; the highlighted match, when it's on the shelf in view, is
      // shown there; closed without choosing, the shelf goes back; a touch on the shelf under the bar only closes it
      if (name === 'thor') {
        const at = () => page.evaluate(() => ({ cur: String((Shelf._lib.cur() || {}).id), mode: Shelf.getMode(), open: BS_FIND.isOpen(), sys: (Shelf.artFocus() || {}).sys, res0: BS_FIND._st().res[0] || '' }));
        const typeOn = t => page.evaluate(async t => { const w = ms => new Promise(res => setTimeout(res, ms)); BS_FIND.remote('clear'); for (const ch of t) { if (/[\p{L}\p{N}]/u.test(ch)) BS_FIND.remote('k', ch); else BS_FIND.remote('space'); await w(20); } }, t);
        const settle = () => page.waitForFunction(() => !Shelf._tour.busy(), null, { timeout: 8000, polling: 150 }).catch(() => {});
        await settle();
        r.kbSet = await page.evaluate(() => { const api = window.boxshelf; if (!api) return 'no api'; window.__bsWas = api.bottomScreen;
          api.bottomScreen = Object.assign({}, api.bottomScreen || {}, { available: () => true, status: () => ({ available: true, enabled: true, shown: true }) }); return 'ok'; });
        // a game on the shelf in view, the farthest from the case showing, and one on another console's shelf (titles no other game has)
        r.kbPick = await page.evaluate(() => { const f = Shelf.artFocus(true), c = Shelf.bottomShelves().find(s => s.cur) || {}, cur = Shelf._lib.cur() || {}, L = Shelf._find.games(), ids = (f.ids || []).map(String);
          const one = g => !L.some(h => h !== g && h.title.toLowerCase() === g.title.toLowerCase()), far = g => Math.abs(ids.indexOf(String(g.id)) - f.sel);
          const here = L.filter(g => g.sys === c.name && ids.includes(String(g.id)) && String(g.id) !== String(cur.id) && one(g)).sort((a, b) => far(b) - far(a))[0], away = L.find(g => g.sys !== c.name && one(g));
          return { sys: f.sys, name: c.name, from: String(cur.id), here: here ? { id: String(here.id), title: here.title } : null, away: away ? { id: String(away.id), title: away.title } : null }; });
        const P = r.kbPick;
        await page.evaluate(() => BS_FIND.open('ptr')); await page.waitForTimeout(400); await loaded(page);
        await typeOn(P.here.title); await page.waitForTimeout(250);
        r.kbLook = await page.evaluate(k => { const e = document.getElementById('bsFind'), vw = innerWidth, vh = innerHeight, b = e.getBoundingClientRect(), rows = [...e.querySelectorAll('.fg-row')], list = e.querySelector('.fg-list');
          const tops = new Set(rows.map(x => Math.round(x.getBoundingClientRect().top))), mid = document.elementFromPoint(vw / 2, vh / 2), x = e.querySelector('.fg-x').getBoundingClientRect(), row = rows[0] && rows[0].getBoundingClientRect();
          let font = 99; for (const n of e.querySelectorAll('*')) { if (!n.getClientRects().length || n.closest('svg')) continue; if (![...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim()) && n.tagName !== 'INPUT') continue; font = Math.min(font, parseFloat(getComputedStyle(n).fontSize)); }
          return { kb: e.classList.contains('bottomkb'), h: Math.round(b.height / vh * 100) / 100, top: Math.round(b.top), rows: rows.length, lines: tops.size, oneRow: list.scrollHeight <= list.clientHeight + 1, midIn: !!(mid && e.contains(mid)),
            mid: mid ? (mid.id || String(mid.className) || mid.tagName).slice(0, 40) : '', grid: getComputedStyle(e.querySelector('.fg-keys')).display, ph: e.querySelector('.fg-in').placeholder, focused: document.activeElement === e.querySelector('.fg-in'),
            cur: (e.querySelector('.fg-row.cur .fg-t') || {}).textContent || '', font, xDp: Math.round(Math.min(x.width, x.height) * k), rowDp: row ? Math.round(row.height * k) : 0, sw: document.scrollingElement.scrollWidth, vw }; }, k);
        await shot(page, 'find-bottomkb-thor.png');
        await page.waitForTimeout(1600); r.kbFollow = await at(); await shot(page, 'find-bottomkb-follow-thor.png');
        // a match on another console's shelf: the shelf stays where it is
        await typeOn(P.away.title); await page.waitForTimeout(1400); r.kbAway = await at();
        // a controller: right steps along the row of matches, and its hints show in the bar (the shelf's own hint bar is hidden meanwhile); the arrow keys too
        await typeOn('a'); await page.waitForTimeout(300);
        r.kbPad = await page.evaluate(() => { const gp = b => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === b, value: i === b ? 1 : 0 })), axes: [0, 0, 0, 0] }), t = performance.now();
          const s0 = BS_FIND._st().sel; BS_FIND.pad(gp(-1), t); BS_FIND.pad(gp(15), t + 16); BS_FIND.pad(gp(-1), t + 32); const s1 = BS_FIND._st().sel;
          const f = document.getElementById('bsFind'), h = f.querySelector('.fg-hints'), hr = h.getBoundingClientRect(), fr = f.getBoundingClientRect(), list = f.querySelector('.fg-list');
          return { s0, s1, n: BS_FIND._st().res.length, hints: h.textContent.replace(/\s+/g, ' ').trim(), hintsIn: hr.height > 0 && hr.bottom <= fr.bottom, h: Math.round(fr.height / innerHeight * 100) / 100, oneRow: list.scrollHeight <= list.clientHeight + 1,
            shelfHints: getComputedStyle(document.getElementById('hints')).visibility }; });
        await page.keyboard.press('ArrowRight'); await page.waitForTimeout(100); r.kbPad.s2 = (await at()).open && (await page.evaluate(() => BS_FIND._st().sel));
        await shot(page, 'find-bottomkb-pad-thor.png');
        await page.evaluate(() => BS_FIND.close()); await page.waitForTimeout(1200); r.kbBack = await at(); r.kbHintsBack = await page.evaluate(() => getComputedStyle(document.getElementById('hints')).visibility);
        await settle();
        // a touch on the shelf under the bar: Find closes, the shelf doesn't move or open anything
        await page.evaluate(() => BS_FIND.open('ptr')); await page.waitForTimeout(400); await loaded(page);
        await page.touchscreen.tap(Math.round(vp.width / 2), Math.round(vp.height / 2)); await page.waitForTimeout(1000); r.kbTap = await at();
        await settle();
        // A on a match (the bottom screen's pick): that game, and the shelf stays on it
        await page.evaluate(() => BS_FIND.open('ptr')); await page.waitForTimeout(400); await loaded(page);
        await typeOn(P.here.title); await page.waitForTimeout(1600); await page.evaluate(() => BS_FIND.remote('pick', 0)); await page.waitForTimeout(1200); r.kbPicked = await at();
        await page.evaluate(() => { window.boxshelf.bottomScreen = window.__bsWas; });
      }
    } catch (e) { r.err = e.message; }
    await ctx.close(); return r; };
  o.thor = await android({ width: 853, height: 480 }, 2.25, 'thor');
  o.phone = await android({ width: 390, height: 844 }, 3, 'phone');

  // ---------- the checks ----------
  const J = (...a) => JSON.stringify(a).slice(0, 900), s0 = o.s0 || {}, sh = o.shelf || {};
  check('Find a game (beta.12): the Search button sits beside Menu on the shelf ("Find a game (/)"), and the bar shows Find with its key; nothing spills at 1280x720',
    sh.btn && sh.title === 'Find a game (/)' && sh.left && sh.inBar && /Find/.test(sh.hint || '') && /\//.test(sh.hint || '') && sh.hintShown && sh.barFits && sh.sw <= sh.vw + 1, J(sh, o.err));
  const op = o.open || {}, ho = o.hollow || {};
  check('Find a game: / opens it on the field (its own mode), and typing lists the matches best first: starts with, then a word that starts with it',
    op.open && op.mode === 'find' && op.shown && op.field && !op.pad && !op.gridOn && ho.value === 'hollow' && ho.q === 'hollow' && JSON.stringify(ho.res) === JSON.stringify(['Hollow Harbor Heroes · Wii U', 'Echo Hollow · GameCube', 'Ember Hollow · Switch']) && ho.cap === '3 games', J(op, ho));
  const ac = o.accent || {}, no = o.none || {};
  check('Find a game: capitals, accents and punctuation don\'t matter ("ÉCHO-hol" finds Echo Hollow); nothing found says so',
    JSON.stringify(ac.res) === JSON.stringify(['Echo Hollow · GameCube']) && no.res && !no.res.length && /Nothing called .zzqx/.test(o.noneText || ''), J(ac, no, o.noneText));
  const qu = o.quiet || {}, es = o.esc || {};
  check('Find a game: the shelf underneath hears no key while it\'s up, and Esc closes it without moving',
    qu.open && qu.mode === 'find' && qu.g === s0.g && qu.sys === s0.sys && !es.open && !es.shown && es.mode === 'browse' && es.g === s0.g && es.sys === s0.sys, J(s0.g, s0.sys, qu.g, qu.mode, es));
  const cf = o.ctrlF || {}, pi = o.pilot || {}, we = o.went || {};
  check('Find a game: Ctrl+F opens it too; down and Enter go to that game on another console\'s shelf (Pocket Pilots, 3DS), that case selected',
    cf.open && cf.mode === 'find' && JSON.stringify(pi.res) === JSON.stringify(['Paper Pilots · Wii', 'Pocket Pilots · 3DS']) && (o.pilotSel || {}).sel === 1 && !we.open && we.mode === 'browse' && we.g === 'Pocket Pilots' && we.sys === 'n3ds' && we.sys !== s0.sys && /3DS/.test((o.wentBrand || {}).tab || ''),
    J(cf.mode, pi.res, we.g, we.sys, s0.sys, o.wentBrand));
  const re = o.recent || {}, ti = o.tide || {}, cl = o.clicked || {};
  check('Find a game: with nothing typed it lists what was played last, newest first; the Search button opens it and a click on a result goes there',
    re.open && re.cap === 'Recently played' && JSON.stringify(re.res) === JSON.stringify(['Kitebound · Switch', 'Saltwind · PS3']) && re.field && JSON.stringify(ti.res) === JSON.stringify(['Tidewalker · GameCube']) && !cl.open && cl.mode === 'browse' && cl.g === 'Tidewalker' && cl.sys === 'gc', J(re, ti.res, cl.g, cl.sys));
  const la = o.lantern || {}, pc = o.pc || {}, un = o.unfiltered || {};
  check('Find a game: PC games are searched with the consoles\' (Lantern Keep, PC, before Lanternfall, PS3), and Enter goes to the PC shelf',
    JSON.stringify(la.res) === JSON.stringify(['Lantern Keep · PC', 'Lanternfall · PS3']) && !pc.open && pc.g === 'Lantern Keep' && pc.sys === 'pc', J(la.res, pc.g, pc.sys));
  check('Find a game: a game the shelf\'s filter hides is still found, and going to it shows all games again',
    (o.filter || {}).left === 0 && (o.filter || {}).opened && !un.open && un.mode === 'browse' && un.g === 'Gridlock GP' && un.sys === 'psp', J(o.filter, un.g, un.sys, un.mode));
  const tu = o.tour || {}, te = o.tourEnd || {};
  check('Find a game: the tour\'s step opens it (its key shown), and Skip there closes it along with the tour',
    tu.started && tu.step === 'Find a game' && tu.open && tu.mode === 'find' && tu.spot && tu.card && /Find a game/.test(tu.keys || '') && !te.on && !te.open && te.mode === 'browse' && !te.shown, J(tu, te));
  const fk = o.fitK || {}, fp = o.fitP || {};
  check('Find a game (Windows 1280x720): the field with the results under it, and the letter grid beside the results, all on screen and readable',
    fk.under && !fk.out.length && fk.sw <= fk.vw + 1 && fk.listFits && fk.font >= 11.5 && fk.rows === 3 && fp.beside && !fp.out.length && fp.sw <= fp.vw + 1 && fp.font >= 11.5 && fp.key >= 36, J(fk, fp));

  const he = o.held || {}, mo = o.mo || {};
  check('Find a game (controller): a tap of the left stick\'s click is still Shuffle; held, it opens on the letter grid; the bar shows it',
    (o.tap || {}).open === false && he.open && he.pad && he.gridOn && he.zone === 'keys' && he.q === '' && !he.field && (o.padHint || {}).shown && /Find/.test((o.padHint || {}).text || '') && (o.padHint || {}).glyph && (o.padHint || {}).barFits, J(o.tap && o.tap.open, he, o.padHint, o.perr));
  check('Find a game (controller): the d-pad and A type on the grid, X deletes, Y is a space; the matches follow',
    o.onM === 'M' && mo.q === 'Mo' && mo.value === 'Mo' && JSON.stringify(mo.res) === JSON.stringify(['Moonmallow · GameCube', 'Mosslight · Switch']) && (o.del || {}).q === 'M' && (o.space || {}).q === 'Mo ' && /Type/.test(o.hints || '') && /Close/.test(o.hints || ''), J(o.onM, mo, o.del && o.del.q, o.space && o.space.q, o.hints));
  const pw = o.padWent || {}, p1 = o.p1 || {};
  check('Find a game (controller): RB goes to the results, down and A go to that game on its shelf (Mosslight, Switch)',
    (o.zone || {}).zone === 'list' && (o.second || {}).sel === 1 && !pw.open && pw.mode === 'browse' && pw.g === 'Mosslight' && pw.sys === 'sw', J(o.zone && o.zone.zone, o.second && o.second.sel, pw.g, pw.sys, pw.mode));
  const pq = o.padQuiet || {}, pb = o.padB || {};
  check('Find a game (controller): the d-pad moves the grid, never the shelf; B closes without moving',
    pq.open && pq.key === 'K' && pq.g === pw.g && !pb.open && pb.mode === 'browse' && pb.g === pw.g && pb.sys === pw.sys, J(pq.key, pq.g, pb));
  const qm = o.qm || {};
  check('Find a game: it\'s the quick menu\'s first row, and A on it opens the search on the letter grid (the press isn\'t typed)',
    /^\s*Find a game/.test(o.qmFirst || '') && o.qmOn === 'find' && qm.open && qm.pad && qm.q === '' && !(o.qmClosed || {}).open && (o.qmClosed || {}).mode === 'browse', J(o.qmFirst, o.qmOn, qm, o.qmClosed));
  const f2 = o.fitP2 || {};
  check('Find a game (Windows 1920x1080): the letter grid beside the results, all on screen', f2.beside && !f2.out.length && f2.sw <= f2.vw + 1 && f2.font >= 16 && f2.key >= 48, J(f2));

  for (const [name, r, narrow] of [['the Thor, 853x480', o.thor || {}, false], ['a phone held upright, 390x844', o.phone || {}, true]]) {
    const b = r.btn || {}, t = r.typed || {}, f = r.fit || {}, w = r.went || {}, p = r.pad || {}, g = r.fitP || {};
    check(`Find a game (${name}): the Search button is on the shelf with a 48 dp place to press, and Menu is still Menu`,
      b.shown && b.dpW >= 48 && b.dpH >= 48 && b.up && b.down && b.menuStillMenu && b.sw <= b.vw + 1, J(b, r.err));
    check(`Find a game (${name}): a tap opens it on the real field (the system keyboard's), results under it; a tap on one goes there`,
      (r.open || {}).open && (r.open || {}).field && !(r.open || {}).pad && !(r.open || {}).gridOn && JSON.stringify(t.res) === JSON.stringify(['Driftlight · Switch', 'Mosslight · Switch']) && f.under && !w.open && w.mode === 'browse' && w.g === 'Mosslight' && w.sys === 'sw', J(r.open, t.res, w.g, w.sys, r.err));
    check(`Find a game (${name}): text 20 px and up, rows and buttons 48 dp and up, nothing spills sideways`,
      f.font >= 20 && f.row >= 48 && f.fieldH >= 48 && f.x >= 48 && !f.out.length && f.sw <= f.vw + 1 && f.listFits && !f.titleCut, J(f));
    check(`Find a game (${name}): with a controller the letter grid shows (${narrow ? 'between the field and the results' : 'beside the results'}), on screen, and its letters type`,
      p.open && p.pad && p.gridOn && p.q === 'Ki' && JSON.stringify(p.res) === JSON.stringify(['Kitebound · Switch', 'Coral Kingdom · GameCube', 'Tanuki Trail · Switch']) && (narrow ? g.under && g.keysUnderField : g.beside) && !g.out.length && g.sw <= g.vw + 1 && g.font >= 20 && g.key >= (narrow ? 40 : 44) && !(r.closed || {}).open && (r.closed || {}).mode === 'browse', J(p, g, r.closed));
  }
  const th = o.thor || {}, ph = o.phone || {}, kl = th.kbLook || {}, kp = th.kbPick || {}, kh = kp.here || {}, kf = th.kbFollow || {}, ka = th.kbAway || {}, kb = th.kbBack || {}, kt = th.kbTap || {}, kk = th.kbPicked || {};
  check('Find a game without the bottom screen: still the full screen as before (Windows, the Thor and a phone by touch, the letter grid with a controller)',
    (o.fitK || {}).panelH >= .98 && (o.fitP || {}).panelH >= .98 && (th.fit || {}).panelH >= .98 && (th.fitP || {}).panelH >= .98 && (ph.fit || {}).panelH >= .98 && (th.pad || {}).gridOn,
    J((o.fitK || {}).panelH, (o.fitP || {}).panelH, (th.fit || {}).panelH, (th.fitP || {}).panelH, (ph.fit || {}).panelH));
  check('Find a game (the Thor, bottom screen on): a slim bar along the top (35% of the screen at most), the matches in one row, nothing of it over the middle of the screen, no letter grid, the highlight on the match typed below',
    th.kbSet === 'ok' && kl.kb && kl.h <= .35 && kl.top === 0 && kl.rows >= 1 && kl.lines === 1 && kl.oneRow && !kl.midIn && kl.grid === 'none' && kl.ph === 'Type on the bottom screen' && !kl.focused && kl.cur === kh.title && kl.font >= 20 && kl.xDp >= 48 && kl.rowDp >= 48 && kl.sw <= kl.vw + 1,
    J(th.kbSet, kl, kp, th.err));
  check('Find a game (the Thor, bottom screen on): the shelf under the bar steps to the highlighted match on the shelf in view; one on another shelf leaves it there; closed without choosing, it goes back',
    !!kh.id && kf.open && kf.mode === 'find' && kf.cur === kh.id && kf.sys === kp.sys && ka.open && ka.cur === kh.id && ka.sys === kp.sys && ka.res0.startsWith((kp.away || {}).title + ' · ') && !kb.open && kb.mode === 'browse' && kb.cur === kp.from && kb.sys === kp.sys,
    J(kp, kf, ka, kb));
  const kq = th.kbPad || {};
  check('Find a game (the Thor, bottom screen on): a controller\'s right (and the arrow keys) step along the row of matches; its hints show in the bar, the shelf\'s own hint bar is hidden until Find closes',
    kq.n >= 3 && kq.s0 === 0 && kq.s1 === 1 && kq.s2 === 2 && /Choose/.test(kq.hints || '') && /Go to game/.test(kq.hints || '') && /Close/.test(kq.hints || '') && kq.hintsIn && kq.h <= .35 && kq.oneRow && kq.shelfHints === 'hidden' && th.kbHintsBack === 'visible',
    J(kq, th.kbHintsBack));
  check('Find a game (the Thor, bottom screen on): a touch on the shelf under the bar only closes it; a match picked below goes to that game and the shelf stays there',
    !kt.open && kt.mode === 'browse' && kt.cur === kp.from && kt.sys === kp.sys && !kk.open && kk.mode === 'browse' && kk.cur === kh.id && kk.sys === kp.sys, J(kt, kk));
  check('Find a game pass: no script errors', !errors.length, errors.slice(0, 3).join(' | '));
};
