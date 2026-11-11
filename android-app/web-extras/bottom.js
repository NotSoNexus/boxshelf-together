// Boxshelf bottom screen (AYN Thor's second display; Android build only). Shows the game the shelf on the top screen has
// settled on: its case in 3D (closed at first: turn it any way with a finger, flick it, then open it and take the disc
// out), a few facts, trophies and a few big touch buttons that act on the shelf. In the museum it becomes the museum's
// companion: the row on the wall as a shelf of cases, the chosen one, and shrink-wrap you can tear off by touch.
//   in:  window.bsBottom.recv(json) — from android-bottom.js through BottomScreen.java ({ type: 'game', game } /
//        { type: 'museum', row, games, game, hud })
//   out: window.BoxshelfBottom.post(json) — BottomScreen.java's bridge ({ type: 'ready' } / { type: 'cmd', cmd, arg })
// Opened on its own in a browser it shows a demo game, so it can be looked at and tested without a phone.
// On the Case tab, Inspect (or a tap on the case) brings the case into a focus view: it alone, big, in the middle, with
// only a Close button left; drag turns it, a flick spins it, two fingers zoom, a double-tap resets, and only in there can
// it be opened (the Open case chip, or a tap on its opening edge). Box art (in the tab bar) opens the Art Studio and a
// quick button this screen's settings, both on the big screen. While the Art Studio is up this page shows the case only. In the museum: buttons step rows and cases, pick a case up and put it back, a drag turns
// the case in your hands, and a Room drawer changes the room's lighting, walls, floor, shelves and pieces live.
// Cheap when nothing moves: no animation frame loop runs unless a finger is dragging (or a flick is slowing down); the idle sway is a CSS animation
// that stops by itself after one slow swing.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const stage = $('stage'), scene = $('scene'), caseView = document.querySelector('.v-case');
  const sent = window.__bsSent = []; // what this page asked the shelf to do (tests read it)
  const store = { get: k => { try { return localStorage.getItem('bsBottom:' + k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem('bsBottom:' + k, v); } catch {} } };

  // ---------- talking to the shelf ----------
  function send(obj) {
    sent.push(obj);
    const s = JSON.stringify(obj);
    try {
      if (window.BoxshelfBottom && BoxshelfBottom.post) BoxshelfBottom.post(s); // the device
      else if (window.parent !== window) parent.postMessage({ bsBottom: s }, '*'); // a preview inside the main page (browser tests)
    } catch (e) { console.warn('bottom: send failed', e); }
  }
  const cmd = (c, arg) => send(arg === undefined ? { type: 'cmd', cmd: c } : { type: 'cmd', cmd: c, arg });

  // ---------- fitting the 620 x 540 stage to the screen ----------
  // (zoomed to fit, then grown to the screen's own shape in the direction it has room, so no band of the panel is ever
  // left black; CX() is the stage's middle, where the chosen museum case and an opened case sit)
  function fit() { const z = Math.min(innerWidth / 620, innerHeight / 540) || 1; stage.style.zoom = z; fit.z = z;
    fit.w = Math.max(620, Math.floor(innerWidth / z)); fit.h = Math.max(540, Math.floor(innerHeight / z));
    stage.style.width = fit.w + 'px'; stage.style.height = fit.h + 'px'; }
  const CX = () => (fit.w || 620) / 2;
  fit.z = 1; fit.w = 620; fit.h = 540; fit();
  addEventListener('resize', () => { fit(); if (MU && MU.sel >= 0) setSel(MU.sel); placePos(false); });

  // ---------- state ----------
  let game = null, tab = 'case', idleT = 0, hintT = 0;
  const stale = { more: true, trophies: true }; // (tabs out of sight that a newer game hasn't been painted into yet)
  let V = null; // the case on screen: { wrap, sway, spin, box, media, flat }
  let focus = false, zoom = 1; // Inspect's focus view, and how far two fingers have zoomed it
  const ZOOM = { min: 0.7, max: 2.1 }, FOCUS_Y = 226; // zoom limits; the middle of the whole screen (in the views' own coordinates)
  const P = { ry: 30, rx: -7 }; // the turn the finger gave it; at rest it shows a little of the spine
  const REST = { ry: 30, rx: -7 }, FLAT = { ry: -12, rx: -3 }; // a flat card (an app) only leans a little

  // ---------- tabs ----------
  const TABS = ['apps', 'case', 'trophies', 'sys', 'more']; // (beta.12: Apps first, then the Game tab, whose Box art sits under Play; Consoles and Apps are new)
  function setTab(t, quiet) {
    if (!TABS.includes(t)) t = 'case';
    if (t === 'apps') askApps();
    if (t === 'sys') paintSys();
    tab = t; store.set('tab', t);
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $('tabs').style.setProperty('--i', TABS.indexOf(t));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.dataset.v === t));
    if (focus) exitFocus(true); else if (isOpen()) closeCase(true); // the Case tab always starts with the case closed, in its usual place
    if (t !== 'more' && scEdit) setEdit(false);
    if (t === 'more') { stale.more = false; paintMore(); } // (always: a shortcut held on the Apps tab, an icon that came in meanwhile)
    if (t === 'trophies') { stale.trophies = false; paintTrophies(true); } // the ring fills each time it comes into view
    if (!quiet) poke();
  }
  $('tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b && b.dataset.tab) setTab(b.dataset.tab); });

  // every [data-cmd] button anywhere on the page goes to the shelf
  stage.addEventListener('click', e => {
    const b = e.target.closest('[data-cmd]'); if (!b || b.disabled) return;
    const c = b.dataset.cmd;
    if (c === 'sleep') { sleep(true); return; } // (this screen's own: nothing for the shelf to do)
    if (c === 'fav' && game) { game.fav = !game.fav; paintFav(); } // answer the finger at once; the shelf's reply confirms it
    cmd(c);
  });

  // ---------- receiving a game ----------
  function recv(m) {
    try { if (typeof m === 'string') m = JSON.parse(m); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (asleep && m.type !== 'scOpts') { keepAsleep(m); return; }
    if (m.type === 'game' && tab === 'apps' && !apps) { appsAt = 0; askApps(); } // (the top screen is listening now)
    if (m.type === 'game') { const back = leaveMuseum(); if (Array.isArray(m.shelves)) { shelvesNow = m.shelves; if (tab === 'sys') paintSys(); } show(m.game || null, back); }
    else if (m.type === 'ctx') showCtx(m.ctx || null);
    else if (m.type === 'apps') recvApps(m);
    else if (m.type === 'appIcons') recvIcons(m.icons);
    else if (m.type === 'museum') showMuseum(m);
    else if (m.type === 'studio') showStudio(m);
    else if (m.type === 'scOpts') recvOpts(m); // (0.3.5) the Shortcuts editor's Add list
    else if (m.type === 'unlocks') { fresh = { list: Array.isArray(m.list) ? m.list : [], until: Date.now() + 90000 }; if (!isMuseum()) setTab('trophies', true); paintTrophies(true); } // (beta.12) just unlocked in the game you came back from
  }
  // (beta.12) the achievements unlocked in the last game: shown above the ring on the Trophies tab for a minute and a half
  let fresh = null;
  function freshHtml() {
    if (!fresh || Date.now() > fresh.until || !fresh.list.length) return '';
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    return `<div class="just"><div class="just-h">Just unlocked</div>${fresh.list.map(a => `<div class="just-a">${a.badge ? `<img src="${esc(a.badge)}" alt="">` : '<span class="just-nob"></span>'}<div><b>${esc(a.title)}</b>${a.points ? `<small>${a.points} pts</small>` : ''}</div></div>`).join('')}</div>`;
  }

  // (beta.12) games arriving close together (racing through a shelf up top): the cross-fades shrink to almost nothing for
  // a moment (body.brisk), so this screen never spends a second fading whole-panel layers while the top screen slides
  let lastShowAt = 0, briskT = 0;
  function brisk() { const now = performance.now(), quick = now - lastShowAt < 2200; lastShowAt = now;
    if (!quick) return; document.body.classList.add('brisk'); clearTimeout(briskT); briskT = setTimeout(() => document.body.classList.remove('brisk'), 2400); }
  function show(g, fromMuseum) {
    const same = !!(game && g && game.id === g.id);
    if (!same) brisk();
    const prevSys = fromMuseum ? null : game && game.system && game.system.id; // back from the museum: the console's colour again
    game = g;
    paintTheme(g && g.theme);
    paintGlow(g, prevSys);
    $('sysName').textContent = g ? (g.system && g.system.name) || '' : '';
    paintSide(same);
    paintFav();
    // (beta.12) the other tabs are painted when they're shown (setTab), not with every game that passes
    if (tab === 'trophies') paintTrophies(false); else stale.trophies = true;
    if (tab === 'more') paintMore(); else stale.more = true;
    if (!same) buildCase(g);
  }

  // the top screen's theme (0.3.2): the same backdrop the shelf draws behind itself (the shelf sends it with the game),
  // cross-faded when it changes; the console's glow sits softer on top of it
  let tbgFlip = false, tbgNow = '';
  function paintTheme(t) {
    const bg = t && typeof t.bg === 'string' && t.bg.length < 4000 ? t.bg : '';
    document.body.classList.toggle('themed', !!bg); document.body.dataset.theme = (t && t.id) || '';
    if (bg === tbgNow) return; tbgNow = bg;
    tbgFlip = !tbgFlip; const on = $(tbgFlip ? 'tbgA' : 'tbgB'), off = $(tbgFlip ? 'tbgB' : 'tbgA');
    if (bg) { on.style.background = bg; on.classList.add('on'); } else on.classList.remove('on');
    off.classList.remove('on');
  }
  // the console's colour behind everything (cross-fades only when the console changes)
  let glowFlip = false;
  function paintGlow(g, prevSys) {
    const st = g && g.style || {}, accent = st.glow || '#9d8cff';
    document.documentElement.style.setProperty('--accent', accent);
    const sys = g && g.system && g.system.id;
    if (sys === prevSys && document.querySelector('.glow.on')) return;
    glowFlip = !glowFlip;
    const on = $(glowFlip ? 'glowA' : 'glowB'), off = $(glowFlip ? 'glowB' : 'glowA');
    const t = st.tint || ['#2a2350', '#120d2c'];
    on.style.setProperty('--g1', t[0]); on.style.setProperty('--g2', t[1]);
    on.classList.add('on'); off.classList.remove('on');
  }

  // ---------- the side text ----------
  function facts(g) {
    const f = [];
    if (g.year) f.push(String(g.year));
    if (g.genre) f.push(g.genre);
    if (g.players) f.push(/^\d+$/.test(String(g.players)) ? (+g.players === 1 ? '1 player' : g.players + ' players') : String(g.players).replace(/\bplayers?\b/i, '').trim() + ' players');
    if (g.region) f.push(g.region);
    if (g.discs > 1) f.push(g.discs + ' discs');
    return f;
  }
  const short = t => t && String(t).replace(/(\d+) h (\d+) min/, '$1h $2m').replace(/^under a minute$/, '< 1 min'); // fits the small box
  function paintSide(same) {
    const box = $('sideTxt'), g = game;
    // (beta.12) calmer: one quiet line above the title (genre · year), then a line of play time and one of trophies; the
    // rest of the facts are in Details
    const boxed = !!g && (g.kind === 'rom' || g.kind === 'steam');
    const kick = !g ? 'Boxshelf' : [g.genre, g.year].filter(Boolean).join(' · ') || (g.system && g.system.name) || '';
    const playLine = !boxed ? '' : g.played ? `${esc(short(g.played))} played${g.last ? ' · ' + esc(String(g.last).toLowerCase() === 'today' || String(g.last).toLowerCase() === 'yesterday' ? String(g.last).toLowerCase() : g.last) : ''}` : 'Not played yet';
    const achLine = !boxed || !g.ach || !g.ach.total ? '' : g.ach.mastered ? 'Mastered · every trophy' : `${g.ach.earned} of ${g.ach.total} trophies`;
    const html = !g ? '<div class="kick">Boxshelf</div><h1 class="title">Nothing selected</h1>' :
      `<div class="kick">${esc(kick)}</div>
       <h1 class="title${g.title.length > 38 ? ' long' : ''}">${esc(g.title)}</h1>
       ${boxed ? `<p class="line">${playLine}</p>${achLine ? `<p class="line ach">${svg('trophy')}<span>${esc(achLine)}</span></p>` : ''}`
        : g.desc ? `<p class="note">${esc(g.desc.length > 120 ? g.desc.slice(0, 118).replace(/\s+\S*$/, '') + '…' : g.desc)}</p>` : ''}`;
    const old = box.querySelector('.txt.in');
    if (same && old) { old.innerHTML = html; return; } // the same game again (a favourite, new play time): no fade
    const el = document.createElement('div'); el.className = 'txt'; el.innerHTML = html; box.appendChild(el);
    if (old) { old.classList.remove('in'); old.classList.add('out'); setTimeout(() => old.remove(), 300); }
    el.getBoundingClientRect(); // start from its hidden state so it fades in (one small layout, only on a new game)
    el.classList.add('in');
    const play = document.querySelector('.play span'); if (play) play.textContent = !g ? 'Play' : g.kind === 'app' || g.kind === 'emulator' ? 'Open' : g.kind === 'random' ? 'Shuffle' : g.kind === 'setup' ? 'Set up' : 'Play';
  }
  function paintFav() {
    const on = !!(game && game.fav), canFav = !!(game && (game.kind === 'rom' || game.kind === 'steam'));
    const f = document.querySelector('.fav'); f.classList.toggle('on', on); f.style.visibility = canFav ? '' : 'hidden';
    const t = document.querySelector('.tile[data-cmd="fav"]'); if (t) { t.classList.toggle('on', on); t.querySelector('span').textContent = on ? 'Favourite' : 'Add to favourites'; t.disabled = !canFav; }
  }

  // ---------- Trophies ----------
  const ICON = {
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v3.5M8.5 20h7M10 16.5h4l.5 3.5h-5z"/>',
    tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 20h8"/>',
    play: '<path class="fill" d="M8 5.5v13l10.5-6.5z"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>',
    cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
    shuffle: '<path d="M3 7h3.5c4 0 6 10 10 10H21M3 17h3.5c1.6 0 2.8-1.6 3.9-3.6M14 9.6C15 7.6 16 7 17.5 7H21M18 4l3 3-3 3M18 14l3 3-3 3"/>',
    menu: '<circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="7" r="2.2"/><circle cx="7" cy="17" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    museum: '<path d="M3 9l9-5 9 5M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"/>',
    art: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-1 .8-1.7 1.9-1.7h2.1a3.7 3.7 0 0 0 3.7-3.7C20.5 6.8 16.7 3.5 12 3.5z"/><circle class="fill" cx="7.6" cy="11" r="1.3"/><circle class="fill" cx="10.4" cy="7.4" r="1.3"/><circle class="fill" cx="14.8" cy="7.6" r="1.3"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    screen: '<rect x="4.5" y="3" width="15" height="18" rx="2.5"/><path d="M4.5 12h15"/><circle cx="12" cy="16.5" r="1.6"/>',
    app: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
    shelf: '<path d="M3 20h18M4 20V8h3v12M8.5 20V5h3v15M13 20l2.4-12 2.9.6L16 20"/>',
    pad: '<path d="M7 9h10a4 4 0 0 1 4 4.4l-.5 3.3A2.2 2.2 0 0 1 16.6 18l-2-2.2H9.4L7.4 18a2.2 2.2 0 0 1-3.9-1.3L3 13.4A4 4 0 0 1 7 9z"/><path d="M8 11.5v3M6.5 13h3"/><circle class="fill" cx="16" cy="12.2" r="1"/><circle class="fill" cx="17.6" cy="14" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', back: '<path d="M15 5l-7 7 7 7"/>', moon: '<path d="M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z"/>'
  };
  const svg = k => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
  function paintTrophies(animate) {
    const box = $('trophies'), g = game, a = g && g.ach;
    if (!g || !(g.kind === 'rom')) { box.innerHTML = `${svg('trophy').replace('<svg', '<svg class="big-ic"')}<p>Trophies show here for games on a console shelf.</p>`; return; }
    if (!g.achOn) { box.innerHTML = `${svg('trophy').replace('<svg', '<svg class="big-ic"')}<p>RetroAchievements isn't connected on this device yet. Once it is, this game's unlocks show up here.</p>`; return; }
    if (!a || !a.total) { box.innerHTML = freshHtml() + `${svg('trophy').replace('<svg', '<svg class="big-ic"')}<p>No achievements found for this game.</p>`; return; }
    const pct = Math.max(0, Math.min(1, a.earned / a.total)), fh = freshHtml();
    if (!box.querySelector('.ringbox') || box.dataset.id !== g.id || box.dataset.fresh !== String(fh.length)) {
      box.dataset.id = g.id; box.dataset.fresh = String(fh.length);
      box.innerHTML = fh + `<div class="ringbox"><svg viewBox="0 0 160 160"><circle class="bgc" cx="80" cy="80" r="70"/><circle class="fg" cx="80" cy="80" r="70"/></svg>
        <div class="num"><b></b><small></small></div></div><div class="badge" hidden>Mastered</div>
        <button class="big" type="button" data-cmd="ach">${svg('tv')}<span>See them all on the big screen</span></button>`;
    }
    box.querySelector('.num b').textContent = `${a.earned}/${a.total}`;
    box.querySelector('.num small').textContent = Math.round(pct * 100) + '% unlocked';
    box.querySelector('.badge').hidden = !a.mastered;
    const fg = box.querySelector('.fg');
    if (animate) { fg.style.transition = 'none'; fg.style.strokeDashoffset = '440'; fg.getBoundingClientRect(); fg.style.transition = ''; }
    fg.style.strokeDashoffset = String(440 * (1 - pct));
  }

  // ---------- Shortcuts (0.3.2; was Controls) ----------
  // Big buttons for what you reach for most. Edit chooses which (up to six, in the order picked); kept on this screen.
  const SC = {
    play: ['Play', 'play', ''], fav: ['Add to favourites', 'heart', ''], details: ['Game details', 'info', 'on the big screen'], inspect: ['Inspect', 'cube', 'on the big screen'],
    manual: ['Manual', 'book', ''], museum: ['Museum', 'museum', 'walk your collection'], art: ['Art Studio', 'art', "this game's box art"], ach: ['Trophies', 'trophy', 'on the big screen'],
    shuffle: ['Shuffle', 'shuffle', 'a random game'], menu: ['Quick menu', 'menu', 'on the big screen'], settings: ['Settings', 'gear', 'on the big screen'], bsettings: ['Screen settings', 'screen', 'this screen'],
    sleep: ['Screen off', 'moon', 'tap it to wake'] // (beta.12) this screen goes dark: black on the Thor's OLED panel, its pixels are off
  };
  const SC_DEF = ['play', 'fav', 'museum', 'manual', 'shuffle', 'menu', 'sleep'], SC_MAX = 12; // (beta.12: twelve, in pages of six; was six)
  // (0.3.5) your own shortcuts too: an app on the device (Spotify, a browser…), a console's shelf, a favourite game. Kept
  // as "app:<package>", "shelf:<console>", "game:<id>" in the same list, with their names beside it (scx)
  // (beta.12) Screen off is new: added once to a list already chosen, where there's room (Edit can take it away again)
  try { if (!store.get('sc-sleep')) { store.set('sc-sleep', '1'); const L0 = JSON.parse(store.get('shortcuts') || 'null'); if (Array.isArray(L0) && !L0.includes('sleep') && L0.length < SC_MAX) { L0.push('sleep'); store.set('shortcuts', JSON.stringify(L0)); } } } catch {}
  const SCX_KIND = { app: ['An app', 'app', 'Spotify, a browser, any app'], shelf: ['A console', 'shelf', 'straight to its shelf'], game: ['A game', 'pad', 'favourites first'] };
  let scEdit = false, scPick = null; // scPick: the Add list open in the editor { kind, items (null while asked for) }
  const scx = () => { try { const o = JSON.parse(store.get('scx') || 'null'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const isX = k => /^(app|shelf|game):./.test(String(k));
  const scList = () => { const X = scx(); try { const L = JSON.parse(store.get('shortcuts') || 'null'); if (Array.isArray(L)) { const ok = L.filter((k, i) => (SC[k] || (isX(k) && X[k])) && L.indexOf(k) === i).slice(0, SC_MAX); if (ok.length) return ok; } } catch {} return SC_DEF.slice(); };
  const xIcon = k => SCX_KIND[String(k).split(':')[0]][1];
  function paintMore() {
    const g = game, rom = !!(g && g.kind === 'rom'), X = scx();
    const off = c => (!g && /^(play|fav|details|inspect|manual|art|ach)$/.test(c)) || (!rom && /^(inspect|manual|art|ach)$/.test(c)) || (c === 'fav' && !(g && (g.kind === 'rom' || g.kind === 'steam')));
    const L = scList(), tiles = L.map(c => { if (isX(c)) { const x = X[c] || {}, ic = c.startsWith('app:') && icons.get(c.slice(4));
        return `<button class="tile mine" type="button" data-sc="${esc(c)}">${ic ? `<img class="ap-ic" src="${esc(ic)}" alt="">` : svg(xIcon(c))}<span>${esc(x.label || c)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</button>`; }
      const [l0, ic, sub0] = SC[c], l = c === 'play' && g && g.kind === 'app' ? 'Open' : l0, sub = c === 'manual' ? (g && g.manual ? 'on the big screen' : 'a booklet is made') : sub0;
      return `<button class="tile${c === 'play' ? ' primary' : ''}" type="button" data-cmd="${c}"${off(c) ? ' disabled' : ''}>${svg(ic)}<span>${esc(l)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`; });
    if (L.length < SC_MAX) tiles.push(`<button class="tile add" type="button" data-add-sc>${svg('plus')}<span>Add a shortcut</span><small>an app, a console, a game</small></button>`);
    const pages = []; for (let i = 0; i < tiles.length; i += 6) pages.push(`<div class="sc-page">${tiles.slice(i, i + 6).join('')}</div>`);
    const keep = $('more').scrollLeft; $('more').innerHTML = pages.join(''); $('more').scrollLeft = keep;
    $('scDots').innerHTML = pages.length > 1 ? pages.map((_, i) => `<i${i === scPage() ? ' class="on"' : ''}></i>`).join('') : '';
    paintFav(); if (scEdit) paintEdit();
  }
  const scPage = () => { const m = $('more'); return m.clientWidth ? Math.round(m.scrollLeft / m.clientWidth) : 0; };
  $('more').addEventListener('scroll', () => { const k = scPage(); $('scDots').querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i === k)); }, { passive: true });
  $('more').addEventListener('click', e => { const b = e.target.closest('[data-sc]'); if (b) { cmd('scRun', b.dataset.sc); return; } if (e.target.closest('[data-add-sc]')) setEdit(true); });
  function paintEdit() {
    const L = scList(), X = scx(), opt = (k, ic, label, i) => `<button class="sc-opt${i >= 0 ? ' on' : ''}" type="button" data-k="${esc(k)}">${svg(ic)}<span>${esc(label)}</span>${i >= 0 ? `<i>${i + 1}</i>` : ''}</button>`;
    if (scPick) { // the Add list: every app (console, game) to choose from, one tap adds it
      const K = SCX_KIND[scPick.kind], items = scPick.items;
      $('scEdit').innerHTML = `<div class="sc-head"><button class="sc-back" type="button" data-back>${svg('back')}</button><b>${esc(K[0])}</b><small>${items ? `${items.length} to choose from · tap one to add it` : 'Looking…'}</small></div>
        <div class="sc-list">${items ? (items.length ? items.map(x => `<button class="sc-item${L.includes(x.key) ? ' on' : ''}" type="button" data-add="${esc(x.key)}">${svg(K[1])}<span>${esc(x.label)}</span><small>${esc(x.sub || '')}</small></button>`).join('') : '<p class="sc-none">Nothing to add here yet.</p>') : ''}</div>`;
      return;
    }
    const mine = L.filter(isX);
    $('scEdit').innerHTML = `<div class="sc-head"><b>Choose your shortcuts</b><small>${L.length} of ${SC_MAX} · tap to add or remove</small></div><div class="sc-grid">` +
      Object.keys(SC).map(k => opt(k, SC[k][1], SC[k][0], L.indexOf(k))).join('') + mine.map(k => opt(k, xIcon(k), (X[k] || {}).label || k, L.indexOf(k))).join('') + '</div>' +
      `<div class="sc-add"><small>Add your own</small>${Object.keys(SCX_KIND).map(k => `<button class="sc-kind" type="button" data-kind="${k}">${svg('plus')}<span>${esc(SCX_KIND[k][0])}</span><small>${esc(SCX_KIND[k][2])}</small></button>`).join('')}</div>`;
  }
  function setEdit(on) {
    scEdit = !!on; scPick = null; $('scEdit').hidden = !scEdit; $('more').hidden = scEdit;
    const b = $('scEditBtn'); b.querySelector('span').textContent = scEdit ? 'Done' : 'Edit'; b.classList.toggle('on', scEdit);
    if (scEdit) paintEdit(); else paintMore();
  }
  function scToggle(k, info) { let L = scList();
    if (L.includes(k)) { if (L.length > 1) L = L.filter(x => x !== k); } else { if (L.length >= SC_MAX) L.shift(); L.push(k); } // full: the first one picked makes room
    if (info) { const X = scx(); X[k] = { label: String(info.label || '').slice(0, 60), sub: String(info.sub || '').slice(0, 60) }; store.set('scx', JSON.stringify(X)); }
    store.set('shortcuts', JSON.stringify(L)); }
  $('scEditBtn').addEventListener('click', () => setEdit(!scEdit));
  $('scEdit').addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-back')) { scPick = null; paintEdit(); return; }
    if (t.dataset.kind) { scPick = { kind: t.dataset.kind, items: null }; paintEdit(); cmd('scOpts', t.dataset.kind); return; }
    if (t.dataset.add) { const x = scPick && scPick.items && scPick.items.find(y => y.key === t.dataset.add); scToggle(t.dataset.add, x); scPick = null; paintEdit(); return; }
    if (t.dataset.k) { scToggle(t.dataset.k); paintEdit(); }
  });
  function recvOpts(m) { if (!scPick || m.kind !== scPick.kind) return; scPick.items = (Array.isArray(m.items) ? m.items : []).filter(x => x && isX(x.key)); if (scEdit) paintEdit(); }

  // ---------- Consoles (beta.12) ----------
  // Every shelf with something on it (the shelf sends the list with each game), the one in view lit; a touch takes the big
  // screen there. Painted only while the tab is open.
  let shelvesNow = [];
  function paintSys() {
    const box = $('sysList'), L = shelvesNow || [];
    if (!L.length) { box.innerHTML = '<p class="sys-none">Your consoles show here once the shelf has games on it.</p>'; return; }
    const key = L.map(s => s.id + (s.cur ? '*' : '') + s.n).join(',');
    if (box.dataset.key === key) return; box.dataset.key = key;
    box.innerHTML = L.map(s => `<button class="sys-it${s.cur ? ' on' : ''}" type="button" data-sys="${esc(s.id)}" style="--sg:${esc(/^#[0-9a-f]{3,8}$/i.test(s.glow || '') ? s.glow : '#9d8cff')}"><i></i><b>${esc(s.name)}</b><small>${s.n} ${s.kind === 'console' ? (s.n === 1 ? 'game' : 'games') : (s.n === 1 ? 'item' : 'items')}</small></button>`).join('');
    const on = box.querySelector('.sys-it.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  $('sysList').addEventListener('click', e => { const b = e.target.closest('[data-sys]'); if (!b) return;
    box0(b); cmd('sys', { key: b.dataset.sys }); });
  const box0 = b => { $('sysList').querySelectorAll('.sys-it').forEach(x => x.classList.toggle('on', x === b)); $('sysList').dataset.key = ''; }; // (lit at once; the shelf's next game confirms it, or puts the light back if the switch was refused)

  // ---------- Apps (beta.12) ----------
  // The rest of the device: Android's own places (the home screen you had before, Settings, Wi-Fi, Bluetooth), then every
  // app with an icon. Names come first; icons follow a few at a time, only for this tab, kept for as long as this page
  // lives. A tap opens the app on the big screen; holding one adds it to Shortcuts.
  const icons = new Map(); let apps = null, appsAt = 0;
  const AP_SYS = [['home', 'Android home', '<path d="M4 11l8-6.5 8 6.5M6.5 9.5V19h11V9.5"/>'], ['settings', 'Settings', ICON.gear],
    ['wifi', 'Wi-Fi', '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"/><circle class="fill" cx="12" cy="19.5" r="1.3"/>'],
    ['bluetooth', 'Bluetooth', '<path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9"/>']];
  $('apSys').innerHTML = AP_SYS.map(([k, l, p]) => `<button class="ap-s" type="button" data-sa="${k}"><svg viewBox="0 0 24 24">${p}</svg><span>${l}</span></button>`).join('');
  $('apSys').addEventListener('click', e => { const b = e.target.closest('[data-sa]'); if (b) cmd('sysAct', b.dataset.sa); });
  // (asked again until the list comes: the Apps tab can be the first thing this page shows, before the top screen is
  // listening, and that first ask was lost until the tab was left and opened again)
  function askApps() { if (!apps) paintApps(); clearTimeout(askApps.t);
    if (!apps) askApps.t = setTimeout(() => { if (!apps && tab === 'apps' && (askApps.n = (askApps.n || 0) + 1) <= 4) { appsAt = 0; askApps(); } }, 2500);
    if (!apps || Date.now() - appsAt > 60000) { appsAt = Date.now(); cmd('apps');
    if (!window.BoxshelfBottom && window.parent === window) setTimeout(() => recvApps({ items: ['RetroArch', 'Dolphin', 'AetherSX2', 'PPSSPP', 'Spotify', 'YouTube', 'Chrome', 'Discord', 'Steam Link', 'Moonlight', 'Camera', 'Gallery', 'Files', 'Clock']
      .map(l => ({ pkg: 'demo.' + l.toLowerCase().replace(/\W/g, ''), label: l })) }), 150); } } // (opened on its own: a few made-up apps)
  function recvApps(m) {
    apps = (Array.isArray(m.items) ? m.items : []).filter(a => a && a.pkg).map(a => ({ pkg: String(a.pkg), label: String(a.label || a.pkg) }));
    for (const a of m.items || []) if (a && a.icon) icons.set(String(a.pkg), String(a.icon));
    paintApps();
    const need = apps.filter(a => !icons.has(a.pkg)).map(a => a.pkg); if (need.length) cmd('appIcons', need);
  }
  function recvIcons(o) {
    if (!o || typeof o !== 'object') return;
    for (const p of Object.keys(o)) { const u = String(o[p] || ''); if (!/^data:image\//.test(u)) continue; icons.set(p, u);
      const el = $('apGrid').querySelector(`.ap[data-pkg="${CSS.escape(p)}"] .ap-ic`); if (el && el.tagName !== 'IMG') el.outerHTML = `<img class="ap-ic" src="${esc(u)}" alt="">`; }
    if (tab === 'more') paintMore();
  }
  function paintApps() {
    const box = $('apGrid');
    if (!apps) { box.innerHTML = '<p class="ap-none">Looking for your apps…</p>'; return; }
    if (!apps.length) { box.innerHTML = '<p class="ap-none">No apps found.</p>'; return; }
    box.innerHTML = apps.map(a => { const u = icons.get(a.pkg), h = [...a.pkg].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
      return `<button class="ap" type="button" data-pkg="${esc(a.pkg)}">${u ? `<img class="ap-ic" src="${esc(u)}" alt="">` : `<i class="ap-ic" style="--h:${h}">${esc((a.label.trim()[0] || '?').toUpperCase())}</i>`}<span>${esc(a.label)}</span></button>`; }).join('');
  }
  // a tap opens it (on the top screen); holding it (half a second, without moving) opens its menu, as the Thor's own
  // launcher does: open it on the top or the bottom screen, add it to Shortcuts (or take it out), App info
  // (beta.13: the hold used to add it to Shortcuts straight away). The same hold works on an app in Shortcuts.
  function holdable(box, sel, onHold, onTap) { let hold = null;
    box.addEventListener('pointerdown', e => { const b = e.target.closest(sel); if (!b) return; clearTimeout(hold && hold.t);
      hold = { b, x: e.clientX, y: e.clientY, done: false, t: setTimeout(() => { if (!hold || hold.b !== b) return; hold.done = true; b.classList.add('held'); setTimeout(() => b.classList.remove('held'), 500); onHold(b); }, 500) }; });
    box.addEventListener('pointermove', e => { if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10 * (fit.z || 1)) { clearTimeout(hold.t); hold = null; } }, { passive: true });
    const up = () => { if (hold) clearTimeout(hold.t); };
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', () => { up(); hold = null; });
    box.addEventListener('click', e => { const b = e.target.closest(sel); if (!b) return; const h = hold; hold = null; if (h && h.done && h.b === b) { e.stopPropagation(); e.preventDefault(); return; } if (onTap) onTap(b, e); }, true);
    box.addEventListener('contextmenu', e => { if (e.target.closest(sel)) e.preventDefault(); }); }
  holdable($('apGrid'), '.ap', b => { const a = (apps || []).find(x => x.pkg === b.dataset.pkg); if (a) appMenu(a.pkg, a.label); },
    b => cmd('appRun', { pkg: b.dataset.pkg, screen: 'top' }));
  holdable($('more'), '.tile.mine[data-sc^="app:"]', b => { const k = b.dataset.sc, x = scx()[k] || {}; appMenu(k.slice(4), x.label || k.slice(4)); });

  // the app menu: a sheet over this screen; a tap outside it, or Cancel, closes it
  let apm = null;
  function appMenu(pkg, label) {
    if (!apm) { apm = document.createElement('div'); apm.id = 'apMenu'; apm.className = 'apm'; apm.hidden = true; (document.getElementById('stage') || document.body).appendChild(apm);
      apm.addEventListener('click', e => { const t = e.target.closest('[data-am]'); if (!t) { if (e.target === apm) closeAppMenu(); return; } const a = t.dataset.am, p = apm.dataset.pkg, l = apm.dataset.label;
        closeAppMenu();
        if (a === 'top' || a === 'bottom') cmd('appRun', { pkg: p, screen: a });
        else if (a === 'info') cmd('appInfo', { pkg: p });
        else if (a === 'sc') { const k = 'app:' + p, had = scList().includes(k); scToggle(k, had ? null : { label: l, sub: 'App' }); say(had ? `${l} taken out of Shortcuts` : `${l} added to Shortcuts`); if (tab === 'more') paintMore(); }
      }); }
    const u = icons.get(pkg), inSc = scList().includes('app:' + pkg), h = [...pkg].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
    apm.dataset.pkg = pkg; apm.dataset.label = label;
    apm.innerHTML = `<div class="apm-card" role="menu"><div class="apm-head">${u ? `<img class="ap-ic" src="${esc(u)}" alt="">` : `<i class="ap-ic" style="--h:${h}">${esc((String(label).trim()[0] || '?').toUpperCase())}</i>`}<b>${esc(label)}</b></div>
      <button type="button" data-am="top"><span>Open on top screen</span></button>
      <button type="button" data-am="bottom"><span>Open on bottom screen</span><small>The shelf stays on top</small></button>
      <button type="button" data-am="sc"><span>${inSc ? 'Remove from Shortcuts' : 'Add to Shortcuts'}</span></button>
      <button type="button" data-am="info"><span>App info</span><small>Storage, permissions, force stop</small></button>
      <button type="button" class="apm-x" data-am="x"><span>Cancel</span></button></div>`;
    apm.hidden = false;
  }
  function closeAppMenu() { if (apm) apm.hidden = true; }

  // ---------- a swipe up on the Game card: Details on the big screen (beta.12) ----------
  { const side = $('side'); let sw = null;
    side.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; sw = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    side.addEventListener('pointerup', e => { const s = sw; sw = null; if (!s || !game) return; const z = fit.z || 1, dx = (e.clientX - s.x) / z, dy = (e.clientY - s.y) / z;
      if (dy < -50 && Math.abs(dy) > Math.abs(dx) * 1.5 && performance.now() - s.t < 600) cmd('details'); });
    side.addEventListener('pointercancel', () => { sw = null; }); }

  // ---------- the companions (beta.12) ----------
  // While the big screen shows a manual or a guide, Find a game or a game's Details, this page shows a panel for it over
  // everything else: big page and zoom buttons for reading, a keyboard and the first matches for Find, the pictures and
  // the main buttons for Details. The shelf sends what's up ({ type: 'ctx', ctx }); null hands the page back.
  const ctxEl = $('ctx'); let CX0 = null, findQ = null;
  const CI = { prev: ICON.back, next: '<path d="M9 5l7 7-7 7"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', zin: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M11 8v6M8 11h6"/>', zout: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8 11h6"/>',
    fit: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M9 8h6M9 12h6M9 16h4"/>', one: '<rect x="7" y="4" width="10" height="16" rx="1.5"/>', two: '<rect x="3" y="5" width="8.5" height="14" rx="1.2"/><rect x="12.5" y="5" width="8.5" height="14" rx="1.2"/>',
    snd: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>', mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>', bksp: '<path d="M9 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-6-6z"/><path d="M12 10l4 4M16 10l-4 4"/>' };
  const ci = (k, cls) => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''}>${CI[k] || ICON[k] || ''}</svg>`;
  const isCtx = () => !!CX0;
  function showCtx(c) {
    const ok = c && /^(reader|find|details)$/.test(c.kind) ? c : null, was = CX0;
    if (!ok) { if (!was) return; CX0 = null; findQ = null; document.body.classList.remove('ctx-on'); ctxEl.setAttribute('aria-hidden', 'true'); ctxEl.dataset.k = ''; return; }
    if (!was) { if (focus) exitFocus(true); else if (isOpen()) closeCase(true); if (roomOpen) toggleRoom(false); hint(''); }
    CX0 = ok; document.body.classList.add('ctx-on'); ctxEl.setAttribute('aria-hidden', 'false');
    if (ok.kind === 'find') findQ = null; // (the shelf's answer: what was typed really is this)
    if (ctxEl.dataset.k !== ok.kind) { ctxEl.dataset.k = ok.kind; ctxEl.innerHTML = ok.kind === 'reader' ? READER_HTML : ok.kind === 'find' ? findHtml() : DET_HTML; }
    if (ok.kind === 'reader') paintReader(ok); else if (ok.kind === 'find') paintFind(ok); else paintDet(ok);
  }
  // reading: the page counter and a slider to any page, big turn buttons either side, zoom and one / two pages
  const READER_HTML = `<div class="cx-head"><div class="cx-t"><small class="cx-kind"></small><b class="cx-title"></b></div><button class="cx-done" type="button" data-rd="close">${ci('x')}<span>Done</span></button></div>
    <div class="rd-turn"><button class="rd-big" type="button" data-rd="prev" aria-label="Previous page">${ci('prev')}</button>
      <div class="rd-mid"><div class="rd-label"></div><input class="rd-scrub" type="range" min="1" max="1" step="1" value="1" aria-label="Go to page"><div class="rd-ends"><span>1</span><span class="rd-n"></span></div></div>
      <button class="rd-big" type="button" data-rd="next" aria-label="Next page">${ci('next')}</button></div>
    <div class="rd-tools"><button class="cx-b" type="button" data-rd="zout">${ci('zout')}<span>Smaller</span></button><button class="cx-b" type="button" data-rd="fit">${ci('fit')}<span>Whole page</span></button>
      <button class="cx-b" type="button" data-rd="zin">${ci('zin')}<span>Closer</span></button><button class="cx-b rd-pg" type="button" data-rd="one"></button></div>`;
  function paintReader(c) {
    const q = s => ctxEl.querySelector(s);
    q('.cx-kind').textContent = c.src === 'guide' ? 'Reading' : 'Manual'; q('.cx-title').textContent = c.title || '';
    q('.rd-label').textContent = c.label || ''; q('.rd-n').textContent = c.pages ? String(c.pages) : '';
    const sc = q('.rd-scrub'); sc.max = String(Math.max(1, c.pages || 1)); sc.disabled = !(c.pages > 1); if (!sc._drag) sc.value = String(Math.max(1, c.page || 1));
    q('[data-rd="fit"]').classList.toggle('off', !c.zoom);
    const pg = q('.rd-pg'); pg.hidden = c.src === 'guide'; pg.dataset.rd = c.one ? 'two' : 'one'; pg.innerHTML = c.one ? `${ci('two')}<span>Two pages</span>` : `${ci('one')}<span>One page</span>`;
  }
  // Find: what's typed, the first matches (a touch goes there), and a keyboard
  const KB = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  const findHtml = () => `<div class="cx-head"><div class="fd-field"><svg class="fd-ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><span class="fd-q"></span><small class="fd-n"></small></div><button class="cx-done" type="button" data-fd="close">${ci('x')}<span>Close</span></button></div>
    <div class="fd-res"></div>
    <div class="fd-kb">${KB.map((r, i) => `<div class="fd-r">${[...r].map(k => `<button class="fd-k" type="button" data-k="${k}">${k}</button>`).join('')}${i === 3 ? `<button class="fd-k fd-w" type="button" data-fd="back" aria-label="Delete">${ci('bksp')}</button>` : ''}</div>`).join('')}
      <div class="fd-r"><button class="fd-k fd-w" type="button" data-fd="clear">Clear</button><button class="fd-k fd-sp" type="button" data-fd="space">Space</button></div></div>`;
  function paintFind(c) {
    const q = ctxEl.querySelector('.fd-q'), shown = findQ != null ? findQ : c.q || '';
    q.textContent = shown || 'Type a title'; q.classList.toggle('ph', !shown);
    ctxEl.querySelector('.fd-n').textContent = !c.loaded ? '' : shown ? (c.total ? `${c.total} ${c.total === 1 ? 'match' : 'matches'}` : 'No match') : 'Recently played';
    const res = (c.res || []).slice(0, 4);
    ctxEl.querySelector('.fd-res').innerHTML = res.map(r => `<button class="fd-row${r.i === c.sel ? ' on' : ''}" type="button" data-pick="${r.i}"><b>${esc(r.title)}</b><small>${esc(r.sys || '')}</small></button>`).join('') || (c.loaded && shown ? `<p class="fd-none">Nothing called “${esc(shown.trim())}”</p>` : '');
  }
  // Details: the screenshots (a touch shows one big), Play, the trailer's sound, Inspect, the heart, back to the shelf
  const DET_HTML = `<div class="cx-head"><div class="cx-t"><small>Details</small><b class="cx-title"></b></div><button class="cx-done" type="button" data-dt="close">${ci('prev')}<span>Back</span></button></div>
    <div class="dt-shots"></div><p class="dt-tip">Tap a picture to see it big on the top screen</p>
    <div class="dt-acts"><button class="dt-play" type="button" data-cmd="play">${svg('play')}<span>Play</span></button>
      <button class="cx-b dt-snd" type="button" data-dt="sound"></button><button class="cx-b dt-isp" type="button" data-cmd="inspect">${svg('cube')}<span>Inspect</span></button>
      <button class="cx-b dt-fav" type="button" data-cmd="fav">${svg('heart')}<span>Favourite</span></button></div>`;
  function paintDet(c) {
    const q = s => ctxEl.querySelector(s);
    q('.cx-title').textContent = c.title || '';
    const sh = Array.isArray(c.shots) ? c.shots : [], box = q('.dt-shots'), key = c.id + '|' + sh.length;
    if (box.dataset.key !== key) { box.dataset.key = key;
      box.innerHTML = sh.length ? sh.map((u, i) => `<button class="dt-shot" type="button" data-shot="${i}"><img src="${esc(u)}" alt="" decoding="async" loading="lazy"></button>`).join('') : '<p class="dt-none">No screenshots for this game yet.</p>'; }
    box.querySelectorAll('.dt-shot').forEach((b, i) => b.classList.toggle('on', i === c.shot));
    q('.dt-tip').hidden = !sh.length; q('.dt-tip').textContent = c.shot >= 0 ? 'Tap another picture to switch · swipe it on the top screen' : 'Tap a picture to see it big on the top screen';
    const snd = q('.dt-snd'); snd.hidden = !c.sound; snd.innerHTML = c.sound === 'on' ? `${ci('snd')}<span>Sound on</span>` : `${ci('mute')}<span>Sound off</span>`;
    q('.dt-isp').hidden = !c.inspect; const f = q('.dt-fav'); f.hidden = c.fav == null; f.classList.toggle('on', !!c.fav);
    q('[data-dt="close"] span').textContent = c.shot >= 0 ? 'Close picture' : 'Back';
  }
  ctxEl.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t || !CX0) return;
    if (t.dataset.rd) { cmd('rd', { key: t.dataset.rd }); return; }
    if (t.dataset.k) { findQ = (findQ != null ? findQ : CX0.q || ''); findQ += !findQ || findQ.endsWith(' ') ? t.dataset.k : t.dataset.k.toLowerCase(); paintFind(CX0); cmd('find', { key: 'k', val: t.dataset.k }); return; }
    if (t.dataset.fd) { const k = t.dataset.fd, q0 = findQ != null ? findQ : CX0.q || '';
      if (k === 'back') findQ = q0.slice(0, -1); else if (k === 'clear') findQ = ''; else if (k === 'space' && q0 && !q0.endsWith(' ')) findQ = q0 + ' ';
      if (k !== 'close') paintFind(CX0); cmd('find', { key: k }); return; }
    if (t.dataset.pick != null) { cmd('find', { key: 'pick', val: +t.dataset.pick }); return; }
    if (t.dataset.shot != null) { cmd('det', { key: 'shot', val: +t.dataset.shot }); return; }
    if (t.dataset.dt) { cmd('det', { key: t.dataset.dt === 'close' ? (CX0.shot >= 0 ? 'shotClose' : 'close') : t.dataset.dt }); return; }
  });
  // the page slider: the page number follows the finger, the big screen turns there once it's let go
  ctxEl.addEventListener('input', e => { const s = e.target; if (!s.classList || !s.classList.contains('rd-scrub') || !CX0) return; s._drag = true;
    ctxEl.querySelector('.rd-label').textContent = `Page ${s.value} of ${CX0.pages}`; });
  ctxEl.addEventListener('change', e => { const s = e.target; if (!s.classList || !s.classList.contains('rd-scrub')) return; s._drag = false; cmd('rd', { key: 'goto', val: +s.value }); });
  // (let go where it started, no change event comes: the slider follows the pages again all the same)
  const scrubUp = e => { const s = e.target; if (s && s.classList && s.classList.contains('rd-scrub')) setTimeout(() => { s._drag = false; if (CX0 && CX0.kind === 'reader') paintReader(CX0); }, 0); };
  ctxEl.addEventListener('pointerup', scrubUp); ctxEl.addEventListener('pointercancel', scrubUp);

  // ---------- the case ----------
  // Built the way the shelf builds its cases on the top screen (style.css): real thickness from the console's style
  // (depth × width), rounded corners on the opening side (rc), a frame of case plastic round the printed sleeve (edge),
  // clear plastic over the print with a band of light that moves as it turns, and the right kind of box for the console:
  // a moulded keep case, a CD jewel case (clear, square, a dark hinge) or a printed card box (sharp, matte, a top flap).
  // The print uses the game's real art where it has it (front, back, spine, or one whole wrap image) and a made-up
  // sleeve where it doesn't.
  const isOpen = () => !!(V && V.box && V.box.classList.contains('open'));
  // (beta.12) what the case holds, in a word: the shelf sends it (Disc / Cartridge / UMD / Floppy disk), else from the kind
  const mWord = g => { const m = (g && g.media) || {}; return String(m.word || (m.kind === 'cart' ? 'Cartridge' : m.kind === 'umd' ? 'UMD' : 'Disc')).replace(' disk', ''); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function sizeFor(g) {
    const st = g.style || {}, ratio = clamp(+st.ratio || 0.71, 0.45, 1.6), pack = /^(keep|jewel|box)$/.test(st.pack) ? st.pack : 'keep';
    let h = 292, w = h * ratio;
    if (w > 262) { w = 262; h = w / ratio; }
    const d = clamp(w * (+st.depth || 0.1), 10, 58);
    const rc = pack === 'keep' ? Math.max(3, w * (+st.rc || 0.03)) : pack === 'jewel' ? 2 : 1.2;
    const e = pack === 'box' ? 0 : pack === 'jewel' ? Math.max(2, w * 0.012) : Math.max(2.5, w * (+st.edge || 0.025));
    const kind = (g.media && g.media.kind) || 'disc';
    const m = w * Math.min(0.9, (g.media && +g.media.size) || 0.62) * (kind === 'disc' ? 1.1 : 1.15);
    return { w, h, d, rc, e, m: pack === 'box' ? Math.min(m, h * 0.62) : m, pack };
  }
  function div(cls, html) { const d = document.createElement('div'); d.className = cls; if (html) d.innerHTML = html; return d; }
  function img(src, cls) { const im = new Image(); im.decoding = 'async'; im.draggable = false; im.alt = ''; if (cls) im.className = cls; im.src = src; return im; }
  const cssUrl = u => `url("${String(u).replace(/["\\\n]/g, c => encodeURIComponent(c))}")`;
  // a decoded image or a short wait, whichever comes first: a new case never fades in half-painted, nor waits long
  const ready = ims => Promise.race([Promise.all(ims.map(i => i.decode ? i.decode().catch(() => {}) : Promise.resolve())), new Promise(r => setTimeout(r, 650))]);

  // the made-up print for a game without that piece of art: a back with "screenshots", blurb lines and a barcode, and
  // a spine with the console's band and the title
  function genBack(g, front) {
    const sb = (g.style && (g.style.band || g.style.spineBand)) || null;
    return `<div class="gback"><b class="gb-t">${esc(g.title)}</b>
      <div class="gb-shots"><i${front ? ` style="background-image:${esc(cssUrl(front))};background-position:20% 30%"` : ''}></i><i${front ? ` style="background-image:${esc(cssUrl(front))};background-position:80% 75%"` : ''}></i></div>
      <div class="gb-txt"><i></i><i style="right:18%"></i><i></i><i style="right:34%"></i></div>
      <div class="gb-ft">${sb ? `<span class="gb-brand" style="background:${esc(sb.bg)};color:${esc(sb.fg)}">${esc(sb.label)}</span>` : '<span></span>'}<span class="gb-bar"></span></div></div>`;
  }
  function genSpine(g) {
    const sb = g.style && g.style.spineBand;
    return `<div class="lbl">${sb ? `<div class="band" style="background:${esc(sb.bg)};color:${esc(sb.fg)}">${esc(sb.label)}</div>` : ''}<div class="ttl">${esc(g.title)}</div></div>`;
  }
  // one picture of the whole sleeve (back | spine | front, as scanned): each face shows its own slice of it
  function wrapSlices(url, s, faces, ims) {
    const im = img(url); ims.push(im);
    const place = () => {
      const W = im.naturalWidth, H = im.naturalHeight; if (!W || !H) return;
      let f = (H * (s.w / s.h)) / W, sp = 1 - 2 * f; // the front's share of the width, from its height and the box's shape
      if (sp < 0.015 || sp > 0.3) { sp = s.d / (2 * s.w + s.d); f = (1 - sp) / 2; } // not a plain scan: share it out by the box's own size
      const part = (el, a, k) => { if (!el) return; el.style.backgroundImage = cssUrl(url); el.style.backgroundSize = `${(100 / k).toFixed(3)}% 100%`; el.style.backgroundPosition = `${(a / (1 - k) * 100).toFixed(3)}% 50%`; el.classList.add('on'); };
      part(faces.back, 0, f); part(faces.spine, f, sp); part(faces.front, f + sp, f);
    };
    (im.decode ? im.decode() : Promise.reject()).then(place, () => { if (im.complete) place(); else im.onload = place; });
  }

  function buildCase(g) {
    discSolo(false);
    const old = V; V = null;
    clearTimeout(idleT); stopFlick();
    caseView.classList.remove('opened');
    if (old) { old.wrap.classList.remove('in'); old.wrap.classList.add('out'); setTimeout(() => old.pos.remove(), 340); }
    caseView.classList.toggle('can-open', !!(g && (g.kind === 'rom' || g.kind === 'steam')));
    $('openManual').hidden = !(g && g.kind === 'rom');
    $('artBtn').disabled = !(g && g.kind === 'rom'); // the Art Studio is for games on a console shelf
    zoom = 1; paintOpenChip();
    if (!g || (focus && !(g.kind === 'rom' || g.kind === 'steam'))) { if (focus) exitFocus(true); if (!g) return; } // nothing to look at closely any more
    const st = g.style || {}, s = sizeFor(g), media = (g.media && g.media.kind) || 'disc';
    const boxed = g.kind === 'rom' || g.kind === 'steam';
    const pos = div('pos');
    // open: a keep / jewel case moves so its hinge is in the middle (cover and tray both fit); a card box stays put
    pos.style.setProperty('--ox', Math.round(boxed && s.pack !== 'box' ? CX() + s.w * 0.86 / 2 : CX()) + 'px');
    const wrap = div('wrap');
    for (const [k, v] of [['--w', s.w], ['--h', s.h], ['--d', s.d], ['--m', s.m], ['--rc', s.rc], ['--e', s.e]]) wrap.style.setProperty(k, v.toFixed(1) + 'px');
    wrap.style.setProperty('--case', st.caseColor || '#16161b'); wrap.style.setProperty('--side', st.caseSide || '#0b0b0e');
    wrap.style.setProperty('--case-in', shade(st.caseSide || '#0b0b0e', -0.25)); wrap.style.setProperty('--spine-ink', st.spineInk || '#e8e8f0');
    const t = st.tint || ['#3a2a86', '#120d2c']; wrap.style.setProperty('--g1', t[0]); wrap.style.setProperty('--g2', t[1]);
    const shadow = div('shadow'), sway = div('sway'), spin = div('spin');
    const ims = [], art = g.art || {}, front = art.front, full = art.full;
    let box, mediaEl = null;
    if (boxed) {
      box = div(`case ${s.pack} ${media}`);
      const lidIn = s.pack === 'box' ? '' : `<div class="face f-in"><div class="clip" style="left:44%;top:3%"></div><div class="clip" style="left:44%;bottom:3%"></div>
          <div class="booklet"><span>${g.manual ? 'Manual' : 'Booklet'}</span></div></div>`;
      box.innerHTML = `<div class="face f-back"><div class="print"></div><i class="gl"></i></div>
        <div class="face f-spine"><div class="print"></div></div>
        <div class="face f-edge"><i class="notch"></i></div>
        ${s.pack === 'box' ? '<div class="flap"><div class="face f-top"></div><div class="face f-top-in"></div></div>' : '<div class="face f-top"></div>'}<div class="face f-bot"></div>
        ${s.pack === 'box' ? '' : '<div class="face tray"><div class="ring"></div><div class="hub"></div></div>'}
        <div class="media"><div class="disc${art.disc ? ' art' : ''}"></div></div>
        <div class="lid"><div class="face f-front"><div class="print"></div><i class="gl"></i><div class="grip"></div></div>${lidIn}</div>`;
      const P_ = sel => box.querySelector(sel + ' .print');
      const pf = P_('.f-front'), pb = P_('.f-back'), ps = P_('.f-spine');
      // the front: its own cover, else its slice of the whole sleeve, else a made-up one
      if (front) { const im = img(front); pf.appendChild(im); ims.push(im); } else pf.innerHTML = `<div class="gencov">${esc(g.title)}</div>`;
      if (art.back) { const im = img(art.back); pb.appendChild(im); ims.push(im); } else pb.innerHTML = genBack(g, front);
      if (art.spine) { const im = img(art.spine, 'sp'); ps.appendChild(im); ims.push(im); } else ps.innerHTML = genSpine(g);
      if (full) { // one picture of the whole sleeve: it fills whichever of the three has no picture of its own
        const slot = el => { const a = div('wrapart'); el.appendChild(a); return a; };
        wrapSlices(full, s, { front: front ? null : slot(pf), back: art.back ? null : slot(pb), spine: art.spine ? null : slot(ps) }, ims);
      }
      const disc = box.querySelector('.media .disc');
      // its own picture (a disc, or a whole cartridge / UMD photographed: drawn as it is, beta.12), else the cover as a label
      if (art.disc) { const im = img(art.disc); disc.appendChild(im); ims.push(im); }
      else if (front) disc.appendChild(img(front)); else disc.innerHTML = '<div class="lab"></div>';
      const bk = box.querySelector('.booklet'); if (bk && front) bk.prepend(img(front));
      mediaEl = box.querySelector('.media');
    } else { // apps, Shuffle, the "add games" tile: a flat card, nothing to open
      box = div('card' + (g.kind === 'app' ? ' icon' : ''));
      if (front) { const im = img(front); box.appendChild(im); ims.push(im); } else box.innerHTML = `<b>${esc(g.title)}</b>`;
    }
    spin.appendChild(box); sway.appendChild(spin); wrap.append(shadow, sway); pos.appendChild(wrap); scene.appendChild(pos);
    V = { pos, wrap, sway, spin, box, media: mediaEl, boxed, pack: s.pack, w: s.w, gl: [...box.querySelectorAll('.gl')], rest: boxed ? REST : FLAT };
    Object.assign(P, V.rest);
    applySpin(false);
    if (focus) placePos(false); // still in the focus view: the next case arrives in the middle, at its plain size
    const mine = V;
    ready(ims).then(() => {
      if (V !== mine) return; // another game came first
      wrap.getBoundingClientRect();
      wrap.classList.add('in');
      startIdle();
      if (mine.boxed && !buildCase.hinted && !focus) { buildCase.hinted = true; setTimeout(() => hint('Drag to turn it · tap it to look closer', 'turn'), 900); }
    });
  }
  function shade(hex, k) { // darker (k < 0) or lighter version of a #rrggbb colour
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return hex;
    const n = parseInt(m[1], 16), f = c => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(c => f(c).toString(16).padStart(2, '0')).join('');
  }
  // the turn, and the band of light on the plastic sliding across as it turns (both transforms: the compositor's job)
  function applySpin(anim) {
    if (!V) return;
    const tr = anim ? 'transform .9s cubic-bezier(.16,.84,.24,1)' : 'none';
    V.spin.style.transition = tr;
    // an open keep / jewel case turns about its hinge (which sits in the middle of the screen), so the open lid swings
    // round it instead of flying off the side; a closed case (and a card box) turns about its middle
    const hx = isOpen() && V.pack !== 'box' ? -(V.w / 2) : 0;
    V.spin.style.transform = `translateX(${hx}px) rotateX(${P.rx.toFixed(2)}deg) rotateY(${P.ry.toFixed(2)}deg) translateX(${-hx}px)`;
    if (V.gl.length) {
      const s = Math.sin(P.ry * Math.PI / 180) + Math.sin(P.rx * Math.PI / 180) * 0.35, x = (s * V.w * 0.75).toFixed(1);
      V.gl.forEach((el, i) => { el.style.transition = tr; el.style.transform = `translate3d(${i ? x : -x}px,0,0)`; });
    }
  }
  // the slow sway when the case is left alone: one swing, then it rests (nothing redraws after that)
  function startIdle() { if (!V || isOpen() || focus) return; V.sway.style.transition = ''; V.sway.style.transform = ''; V.sway.classList.remove('idle'); V.sway.getBoundingClientRect(); V.sway.classList.add('idle'); }
  function stopIdle() {
    if (!V || !V.sway.classList.contains('idle')) return;
    const m = getComputedStyle(V.sway).transform; // hold it where the sway had got to, then ease back: no jump
    V.sway.classList.remove('idle'); V.sway.style.transition = 'none'; V.sway.style.transform = m && m !== 'none' ? m : '';
    const sw = V.sway; requestAnimationFrame(() => { sw.style.transition = 'transform .6s cubic-bezier(.2,.8,.2,1)'; sw.style.transform = 'none'; });
  }
  const restTurn = () => { const R = V.rest; P.ry = Math.round((P.ry - R.ry) / 360) * 360 + R.ry; P.rx = R.rx; };
  // after a while untouched, a closed case drifts back to its resting turn and sways again
  function poke() {
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (!V || isOpen() || focus || drag || flick) return; restTurn(); applySpin(true); setTimeout(startIdle, 950); }, 12000);
  }
  // double-tap: straight back to how it rests (open: face on)
  function straighten() {
    if (!V) return; stopFlick(); stopIdle();
    if (isOpen()) facing(); else restTurn();
    applySpin(true); hint('', 'turn');
    if (focus && zoom !== 1) { zoom = 1; placePos(true); } // in the focus view it also comes back to its plain size
    poke();
  }
  function facing() { P.ry = Math.round(P.ry / 360) * 360 + (V.pack === 'box' ? 0 : 8); P.rx = V.pack === 'box' ? -16 : -4; }

  // Opening only ever starts from the closed case: the Open button, or a tap on its opening edge (the side away from
  // the spine; a card box's top flap). It turns face on first, then the lid swings open (or the flap lifts and the
  // cartridge rises out of the box).
  function openCase() {
    if (!V || !V.boxed || isOpen()) return;
    stopIdle(); stopFlick();
    V.box.classList.add('open'); caseView.classList.add('opened'); openCase.at = performance.now();
    facing(); applySpin(true); // (after the class: an open case turns about its hinge)
    placePos(true); paintOpenChip();
    hint('Tap the ' + (mWord(game) === 'UMD' ? 'UMD' : mWord(game).toLowerCase()) + ' to look at it' + (V.box.querySelector('.booklet') ? ' · tap the manual to read it' : ''), 'disc');
    poke();
  }
  function closeCase(now) {
    discSolo(false);
    if (!V || !isOpen()) return;
    const box = V.box;
    const shut = () => { box.classList.remove('open'); caseView.classList.remove('opened'); if (focus) facing(); else restTurn(); applySpin(true); placePos(true); paintOpenChip(); };
    if (box.classList.contains('out') && !now) { setOut(false); setTimeout(shut, 420); } else { setOut(false); shut(); }
    poke();
  }
  function setOut(on) {
    if (!V || !V.media) return;
    V.box.classList.toggle('out', on);
    V.media.classList.toggle('spinning', on);
  }

  // ---------- the disc on its own (0.3.2) ----------
  // A tap on the disc in the open case: the case fades back and the disc (or cartridge) comes up big in the middle, to be
  // turned right over any way with a finger (a flick keeps it turning, then it slows to a stop); a tap on it, or Put it
  // back, returns it to the case. Frames run only while a finger moves or a flick slows, as for the case.
  const solo = { on: false, rx: 0, ry: 0, drag: null, raf: 0, flick: 0 };
  const dsEl = $('discSolo'), dsSpin = $('dsSpin');
  function discSolo(on) {
    if (!!on === solo.on) return;
    stopSoloFlick();
    if (on) {
      if (!V || !V.media || !isOpen()) return;
      const src = V.media.querySelector('.disc');
      $('dsFront').innerHTML = src ? src.innerHTML : '';
      dsEl.className = 'disc-solo ' + (V.box.classList.contains('disc') ? 'disc' : V.box.classList.contains('umd') ? 'umd' : 'cart') + (src && src.classList.contains('art') ? ' art' : '');
      solo.rx = -10; solo.ry = -20; dsTurn(false); stopFlick();
      caseView.classList.add('solo'); dsEl.getBoundingClientRect(); dsEl.classList.add('on');
      hint('Drag to turn it over · tap it to put it back', 'solo');
    } else { dsEl.classList.remove('on'); caseView.classList.remove('solo'); solo.drag = null; }
    solo.on = !!on; poke();
  }
  function dsTurn(anim) { dsSpin.style.transition = anim ? 'transform .8s cubic-bezier(.16,.84,.24,1)' : 'none'; dsSpin.style.transform = `rotateX(${solo.rx.toFixed(2)}deg) rotateY(${solo.ry.toFixed(2)}deg)`; }
  function stopSoloFlick() { if (solo.flick) { cancelAnimationFrame(solo.flick); solo.flick = 0; } if (solo.raf) { cancelAnimationFrame(solo.raf); solo.raf = 0; } }
  dsEl.addEventListener('pointerdown', e => { if (!solo.on || solo.drag) return; stopSoloFlick();
    solo.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, rx: solo.rx, ry: solo.ry, moved: false, hist: [[e.clientX, e.clientY, performance.now()]] };
    try { dsEl.setPointerCapture(e.pointerId); } catch {} });
  dsEl.addEventListener('pointermove', e => { const d = solo.drag; if (!d || e.pointerId !== d.id) return;
    const z = fit.z || 1, dx = (e.clientX - d.x) / z, dy = (e.clientY - d.y) / z;
    if (!d.moved && Math.hypot(dx, dy) < 8) return;
    d.moved = true; d.hist.push([e.clientX, e.clientY, performance.now()]); if (d.hist.length > 8) d.hist.shift();
    solo.ry = d.ry + dx * 0.6; solo.rx = d.rx - dy * 0.6; // no tilt limit: it turns right over, both ways
    if (!solo.raf) solo.raf = requestAnimationFrame(() => { solo.raf = 0; dsTurn(false); }); });
  const dsEnd = e => { const d = solo.drag; if (!d || e.pointerId !== d.id) return; solo.drag = null;
    if (solo.raf) { cancelAnimationFrame(solo.raf); solo.raf = 0; }
    if (!d.moved) { if (e.type !== 'pointercancel') discSolo(false); return; }
    const h = d.hist, b = h[h.length - 1], now = performance.now(); let a = h[0]; for (const p of h) if (b[2] - p[2] <= 90) { a = p; break; }
    const dt = Math.max(16, b[2] - a[2]), z = fit.z || 1, vx = (b[0] - a[0]) / z / dt, vy = (b[1] - a[1]) / z / dt;
    if (now - b[2] < 90 && Math.hypot(vx, vy) > 0.25) soloFlick(clamp(vx * 0.6, -2.4, 2.4), clamp(-vy * 0.6, -2.4, 2.4)); else dsTurn(false);
    hint('', 'solo'); poke(); };
  dsEl.addEventListener('pointerup', dsEnd); dsEl.addEventListener('pointercancel', dsEnd);
  function soloFlick(vy, vx) { let last = performance.now();
    const step = now => { solo.flick = 0; if (!solo.on) return; const dt = Math.min(40, now - last), k = Math.exp(-dt / 400); last = now;
      solo.ry += vy * dt; solo.rx += vx * dt; vy *= k; vx *= k; dsTurn(false);
      if (Math.abs(vy) + Math.abs(vx) >= 0.012) solo.flick = requestAnimationFrame(step); };
    solo.flick = requestAnimationFrame(step); }
  $('discBack').addEventListener('click', () => discSolo(false));
  $('inspectBtn').addEventListener('click', () => enterFocus());
  $('focusClose').addEventListener('click', () => exitFocus());
  $('openCase').addEventListener('click', () => { if (isOpen()) closeCase(); else openCase(); });
  $('openManual').addEventListener('click', () => cmd('manual'));
  function paintOpenChip() { const o = isOpen(); $('openCase').querySelector('span').textContent = o ? 'Close case' : 'Open case'; $('openBar').classList.toggle('is-open', o); }

  // ---------- Inspect: the focus view ----------
  // The case moves to the middle of the whole screen and grows; the words, buttons, tabs and arrows fade away (opacity
  // and transforms only). Where it sits is one transform on its .pos holder: the middle, or (open) with the hinge in the
  // middle so cover and tray both fit, times the pinch zoom. Outside the focus view the stylesheet places it.
  function placePos(anim) {
    if (!V) return;
    const p = V.pos;
    if (!focus) { p.style.transition = ''; p.style.transform = ''; return; }
    const open = isOpen(), x = open ? parseFloat(p.style.getPropertyValue('--ox')) || CX() : CX();
    const base = open ? (V.pack === 'box' ? 1.04 : 0.94) : V.boxed ? 1.2 : 1.1;
    p.style.transition = anim ? '' : 'none';
    p.style.transform = `translate3d(${x.toFixed(1)}px,${FOCUS_Y}px,0) scale(${(base * zoom).toFixed(3)})`;
  }
  function enterFocus() {
    if (!V || !V.boxed || focus || isMuseum()) return;
    focus = true; zoom = 1;
    stopIdle(); stopFlick(); clearTimeout(idleT);
    document.body.classList.add('focus');
    placePos(true);
    hint('Drag to turn · pinch to zoom · double-tap to reset · tap it to open', 'focus');
  }
  function exitFocus(now) {
    if (!focus) return;
    if (isOpen()) closeCase(true);
    focus = false; zoom = 1; pinch = null; pts.clear();
    document.body.classList.remove('focus');
    if (V) { V.pos.style.transition = now ? 'none' : ''; V.pos.style.transform = ''; restTurn(); applySpin(!now); if (now) { V.pos.getBoundingClientRect(); V.pos.style.transition = ''; } }
    hint('');
    poke(); setTimeout(startIdle, 950);
  }

  // ---------- touch: turn it any way, flick it to spin, double-tap to straighten, open it from its edge ----------
  // Dragging turns the case on both axes; let go mid-swipe and it keeps spinning, slowing down by itself. The only
  // animation-frame loop on this page runs while a finger moves or a flick is still slowing: nothing runs at rest.
  let drag = null, raf = 0, flick = 0, lastTap = null;
  const pts = new Map(); let pinch = null, zRaf = 0; // the fingers down on the case; two of them in the focus view zoom it
  const TURN = { x: 0.5, y: 0.42 }, TILT = 80; // degrees per stage pixel; how far over the top / underneath it goes
  const spread = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  scene.addEventListener('pointerdown', e => {
    if (!drag && !pinch) pts.clear(); // a first finger: forget any finger whose lift never reached us (it would fake a pinch, or block turning)
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (focus && pts.size === 2 && V) { // a second finger: zoom, not turn (the first finger's drag is dropped where it is)
      if (drag) { if (raf) { cancelAnimationFrame(raf); raf = 0; } applySpin(false); drag = null; }
      stopFlick(); lastTap = null;
      pinch = { d0: spread(), z0: zoom };
      try { scene.setPointerCapture(e.pointerId); } catch {}
      hint('', 'focus'); return;
    }
    if (!V || drag || pinch || pts.size > 1) return;
    stopFlick();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ry: P.ry, rx: P.rx, moved: false, t: e.target,
      onMedia: !!(V.media && e.target.closest('.media')), hist: [[e.clientX, e.clientY, performance.now()]] };
    try { scene.setPointerCapture(e.pointerId); } catch {}
    stopIdle(); clearTimeout(idleT);
  });
  scene.addEventListener('pointermove', e => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) {
      if (pts.size < 2) return;
      zoom = clamp(pinch.z0 * spread() / pinch.d0, ZOOM.min, ZOOM.max);
      if (!zRaf) zRaf = requestAnimationFrame(() => { zRaf = 0; placePos(false); }); // one transform per frame, only while fingers move
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const z = fit.z || 1, dx = (e.clientX - drag.x) / z, dy = (e.clientY - drag.y) / z;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    drag.hist.push([e.clientX, e.clientY, performance.now()]); if (drag.hist.length > 8) drag.hist.shift();
    if (drag.onMedia && isOpen()) { drag.dy = dy; return; } // a disc drag: decided on release
    P.ry = drag.ry + dx * TURN.x; P.rx = clamp(drag.rx - dy * TURN.y, -TILT, TILT);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; applySpin(false); }); // one style write per frame, only while a finger moves
  });
  const endDrag = e => {
    pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) { pinch = null; if (zRaf) { cancelAnimationFrame(zRaf); zRaf = 0; } placePos(false); } return; } // the finger left behind doesn't turn it
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (d.onMedia && isOpen()) { // the disc: a tap shows it on its own (0.3.2), a flick up takes it out, down puts it back
      if (!d.moved) { if (e.type !== 'pointercancel') discSolo(true); return; }
      if ((d.dy || 0) < -24) setOut(true);
      else if ((d.dy || 0) > 24) setOut(false);
      hint('', 'disc'); poke(); return;
    }
    if (!d.moved) {
      if (e.type === 'pointercancel') { poke(); return; }
      const now = performance.now(), z = fit.z || 1;
      if (lastTap && now - lastTap.t < 340 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 44 * z) { lastTap = null; straighten(); return; }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      // open: a tap on the manual opens it on the big screen (not the tap that opened the case landing on it)
      if (isOpen()) { if (d.t.closest('.booklet') && now - (openCase.at || 0) > 500) cmd('manual'); poke(); return; }
      // closed (0.3.2): the first tap on the case brings it in close (Inspect); a tap in there opens it
      // (beta.12: a tap inside the case's outline counts too: a case left edge-on shows only its thin spine, and a finger
      // just beside it meant nothing)
      const onCase = !!d.t.closest('.case') || (() => { const r = V.box.getBoundingClientRect(); return e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && e.clientY >= r.top && e.clientY <= r.bottom; })();
      if (V.boxed && onCase) { if (!focus) enterFocus(); else openCase(); return; }
      poke(); return;
    }
    // a flick keeps it turning, both ways, and it slows to a stop by itself
    const h = d.hist, b = h[h.length - 1], now = performance.now();
    let a = h[0]; for (const p of h) if (b[2] - p[2] <= 90) { a = p; break; }
    const dt = Math.max(16, b[2] - a[2]), z = fit.z || 1, vx = (b[0] - a[0]) / z / dt, vy = (b[1] - a[1]) / z / dt;
    if (now - b[2] < 90 && Math.hypot(vx, vy) > 0.25) startFlick(clamp(vx * TURN.x, -2.4, 2.4), clamp(-vy * TURN.y, -2, 2));
    else { applySpin(false); poke(); }
    hint('', 'turn');
  };
  scene.addEventListener('pointerup', endDrag);
  scene.addEventListener('pointercancel', endDrag);
  function startFlick(vy, vx) { // degrees per millisecond, around the upright axis and across
    let last = performance.now();
    const step = now => {
      flick = 0; if (!V) return;
      const dt = Math.min(40, now - last), k = Math.exp(-dt / 330); last = now;
      P.ry += vy * dt; P.rx += vx * dt;
      if (Math.abs(P.rx) >= TILT) { P.rx = clamp(P.rx, -TILT, TILT); vx = -vx * 0.35; } // it bumps off straight up / down
      vy *= k; vx *= k;
      applySpin(false);
      if (Math.abs(vy) + Math.abs(vx) < 0.012) { poke(); return; }
      flick = requestAnimationFrame(step);
    };
    flick = requestAnimationFrame(step);
  }
  function stopFlick() { if (flick) { cancelAnimationFrame(flick); flick = 0; } }

  // a one-line hint, shown the first few times only
  function hint(text, key) {
    const el = $('hint');
    if (!text) { if (key) store.set('hint-' + key, '9'); el.classList.remove('on'); return; }
    const n = +(store.get('hint-' + key) || 0); if (n >= 3) return;
    store.set('hint-' + key, String(n + 1));
    el.textContent = text; el.classList.add('on');
    clearTimeout(hintT); hintT = setTimeout(() => el.classList.remove('on'), 5000);
  }
  // ---------- Screen off (beta.12) ----------
  // The Shortcuts tile turns this screen dark: everything fades to black (black on an OLED panel is pixels off) and
  // stops drawing; messages from the shelf meanwhile are only kept (the newest of each kind) and shown on waking. A tap
  // anywhere wakes it. Nothing runs while it's dark.
  let asleep = false; const slept = new Map();
  const sleepEl = document.createElement('div'); sleepEl.id = 'sleep'; sleepEl.innerHTML = '<span>Tap to wake</span>'; stage.appendChild(sleepEl);
  function sleep(on) {
    on = !!on; if (on === asleep) return; asleep = on;
    if (on) { if (focus) exitFocus(true); else if (isOpen()) closeCase(true); stopFlick(); clearTimeout(idleT); if (V) V.sway.classList.remove('idle'); hint(''); }
    document.body.classList.toggle('asleep', on);
    if (!on) { const L = [...slept.values()]; slept.clear(); for (const m of L) recv(m); poke(); }
  }
  // dark: the newest message of each kind is kept (in the order they came), icon batches all merged, and shown on waking.
  // Back from a game (or a while later), "Tap to wake" shows again, so a black panel never looks broken
  function keepAsleep(m) {
    const k = m.type === 'museum' ? 'game' : m.type, was = slept.get(k);
    if (k === 'appIcons' && was) m = { type: 'appIcons', icons: Object.assign({}, was.icons, m.icons) };
    slept.delete(k); slept.set(k, m);
    if (performance.now() - (keepAsleep.at || 0) > 30000) note(); keepAsleep.at = performance.now();
  }
  const note = () => { const sp = sleepEl.firstChild; if (!sp || !asleep) return; sp.style.animation = 'none'; void sp.offsetWidth; sp.style.animation = ''; };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) note(); });
  // (pointerdown, so the touch that wakes it never also presses whatever is under it once it's lit again)
  sleepEl.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); sleepEl._t = performance.now(); sleep(false); });
  sleepEl.addEventListener('click', e => { e.stopPropagation(); });

  // a short note on the top line, every time (what a hold just did)
  function say(text) { const el = $('hint'); el.textContent = text; el.classList.add('on'); clearTimeout(hintT); hintT = setTimeout(() => el.classList.remove('on'), 2600); }

  // ---------- the museum's companion ----------
  // While the top screen is in the museum, this page shows the row you're on as a wooden shelf of cases (the chosen one
  // lifted under a lamp, in the middle), and that case below: touch a case to walk the museum to it, drag the shelf to
  // scrub along the row. Games still in their shrink-wrap show it here too; swipe across the plastic (or press Unwrap)
  // to tear it off: it peels away here, and the same unwrap plays on the wall above. Leaving the museum brings the
  // usual page back.
  const mTrack = $('mTrack'), mCard = $('mCard'), mWall = document.querySelector('.m-wall');
  let MU = null, mMsg = null;
  const peeled = new Map(); // unwrapped here a moment ago: a message that left the shelf before that can't seal it again
  const isMuseum = () => document.body.classList.contains('museum');
  const sealedNow = x => !!(x && x.sealed) && !(peeled.has(String(x.id)) && performance.now() - peeled.get(String(x.id)) < 4000);
  function genCover(title) { return `<div class="gen"><b>${esc(title)}</b></div>`; }

  function showMuseum(m) {
    if (!m || !m.row) return;
    if (!isMuseum()) { if (focus) exitFocus(true); else if (isOpen()) closeCase(true); stopFlick(); document.body.classList.add('museum'); $('hint').classList.remove('on'); paintTheme(null); } // (the museum has its own light)
    const r = m.row;
    paintGlow({ style: r.style || {}, system: { id: 'museum:' + r.id } }, mMsg ? 'museum:' + mMsg.row.id : null);
    $('sysName').textContent = 'Museum · ' + (r.name || '');
    mMsg = m;
    document.body.classList.toggle('m-held', !!(m.hand && m.hand.held));
    if (roomOpen) paintRoom();
    const at = paintShelf(m);
    // a case touched here a moment ago, which the wall hasn't caught up with yet: keep showing that one
    paintMCard(at !== r.sel && at >= 0 ? Object.assign({}, m, { game: null, pick: m.games.find(x => x.i === at) }) : m);
  }
  function leaveMuseum() {
    if (!isMuseum()) return false;
    if (roomOpen) toggleRoom(false);
    document.body.classList.remove('museum', 'm-held'); MU = null; mMsg = null; mTrack.innerHTML = ''; mCard.innerHTML = ''; mCard.dataset.key = '';
    return true;
  }

  function paintShelf(m) {
    const r = m.row, ratio = clamp(r.style && +r.style.ratio || 0.71, 0.5, 1.45);
    const ih = ratio > 1 ? 72 : 98, iw = Math.round(ih * ratio), pitch = iw + 14;
    const key = r.id + '|' + m.games.map(x => x.id).join(',');
    if (!MU || MU.key !== key) {
      const fresh = !MU || MU.row !== r.id;
      MU = { key, row: r.id, pitch, iw, ih, els: new Map(), sel: -1, x: 0, first: m.games.length ? m.games[0].i : 0, last: m.games.length ? m.games[m.games.length - 1].i : -1, pend: null };
      const t = (r.style && r.style.tint) || ['#3a2a86', '#120d2c'];
      mTrack.style.setProperty('--g1', t[0]); mTrack.style.setProperty('--g2', t[1]);
      mTrack.style.setProperty('--iw', iw + 'px'); mTrack.style.setProperty('--ih', ih + 'px');
      const frag = document.createDocumentFragment();
      for (const x of m.games) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'mi'; b.dataset.i = x.i; b.style.left = (x.i * pitch) + 'px';
        b.setAttribute('aria-label', x.title || 'Game');
        if (x.cover) b.appendChild(img(x.cover)); else b.innerHTML = genCover(x.title);
        b.appendChild(div('film'));
        frag.appendChild(b); MU.els.set(x.i, b);
      }
      mTrack.innerHTML = ''; mTrack.appendChild(frag);
      if (fresh) mTrack.classList.add('snap');
    }
    for (const x of m.games) { const b = MU.els.get(x.i); if (b) b.classList.toggle('sealed', sealedNow(x)); }
    const p = MU.pend && performance.now() - MU.pend.t < 1200 ? MU.pend.i : r.sel; // a touch just now wins over a message from before it
    setSel(p);
    if (mTrack.classList.contains('snap')) { mTrack.getBoundingClientRect(); mTrack.classList.remove('snap'); }
    return p;
  }
  function trackX(i) { return CX() -(i * MU.pitch + MU.iw / 2); }
  function setSel(i) {
    if (!MU) return;
    if (MU.sel !== i) { const o = MU.els.get(MU.sel); if (o) o.classList.remove('on'); const n = MU.els.get(i); if (n) n.classList.add('on'); MU.sel = i; }
    if (i >= 0) { MU.x = trackX(i); mTrack.style.transform = `translate3d(${MU.x.toFixed(1)}px,0,0)`; }
  }
  function mPick(i) {
    if (!MU) return;
    i = clamp(i, MU.first, MU.last);
    MU.pend = { i, t: performance.now() };
    if (i === MU.sel) { setSel(i); return; }
    setSel(i);
    const x = mMsg && mMsg.games.find(g => g.i === i);
    if (x) paintMCard(Object.assign({}, mMsg, { game: null, pick: x })); // show it at once; its details follow from the shelf
    send({ type: 'cmd', cmd: 'mpick', arg: i });
  }
  // touch on the shelf: tap a case to choose it, drag to scrub along the row (lands on the nearest case)
  let mDrag = null, mRaf = 0;
  const held = () => !!(mMsg && mMsg.hand && mMsg.hand.held);
  mWall.addEventListener('pointerdown', e => {
    if (!MU || mDrag) return;
    if (held()) { turnStart(e, mWall); return; }
    mDrag = { id: e.pointerId, x: e.clientX, x0: MU.x, moved: false, t: e.target };
    try { mWall.setPointerCapture(e.pointerId); } catch {}
  });
  mWall.addEventListener('pointermove', e => {
    if (!mDrag || e.pointerId !== mDrag.id) return;
    const dx = (e.clientX - mDrag.x) / (fit.z || 1);
    if (!mDrag.moved && Math.abs(dx) < 8) return;
    if (!mDrag.moved) { mDrag.moved = true; mTrack.classList.add('drag'); }
    mDrag.cur = mDrag.x0 + dx;
    if (!mRaf) mRaf = requestAnimationFrame(() => { mRaf = 0; if (mDrag) mTrack.style.transform = `translate3d(${mDrag.cur.toFixed(1)}px,0,0)`; });
  });
  const mEnd = e => {
    if (!mDrag || e.pointerId !== mDrag.id) return;
    const d = mDrag; mDrag = null;
    if (mRaf) { cancelAnimationFrame(mRaf); mRaf = 0; }
    mTrack.classList.remove('drag');
    if (!d.moved) { const b = d.t.closest && d.t.closest('.mi'); if (b && e.type !== 'pointercancel') mPick(+b.dataset.i); return; }
    const x = d.cur == null ? d.x0 : d.cur;
    mPick(Math.round((CX() - MU.iw / 2 - x) / MU.pitch));
  };
  mWall.addEventListener('pointerup', mEnd);
  mWall.addEventListener('pointercancel', mEnd);

  // the chosen case, big, with what's known about it
  function paintMCard(m) {
    const g = m.game, x = m.pick || (m.row.sel >= 0 ? m.games.find(y => y.i === m.row.sel) : null);
    const id = g ? String(g.id) : x ? x.id : '', title = g ? g.title : x ? x.title : (m.hud && m.hud.title) || '';
    const sealed = g ? sealedNow({ id: g.id, sealed: g.sealed }) : x ? sealedNow(x) : false;
    const cover = (g && g.art && g.art.front) || (x && x.cover) || null; // (the shelf's own cover if the details came without one)
    const hd = m.hand || {}, hk = hd.held ? 'H' + (hd.open ? 'o' : '') + (hd.discOut ? 'd' : '') : '';
    const artOk = !!(g && g.artOk);
    const key = [id, title, sealed, !!cover, g ? 'g' : x ? 'x' : 'h', g && g.fav, g && g.played, hk, m.row.wide ? 'w' : '', artOk ? 'a' : ''].join('|');
    const was = mCard.dataset.key ? mCard.dataset.key.split('|') : null;
    if (mCard.dataset.key === key) return;
    // the same game going from sealed to open without a touch here (hold A on the controller): peel it here too
    if (was && was[0] === id && id && was[2] === 'true' && !sealed && was[7] === hk && mCard.querySelector('.mc-case.sealed')) { mCard.dataset.key = key; unwrapAnim(1, false); return; }
    mCard.dataset.key = key; mCard.dataset.id = id;
    const ratio = clamp(m.row.style && +m.row.style.ratio || 0.71, 0.5, 1.45);
    const ch = ratio > 1 ? 150 : 206, cw = Math.round(Math.min(196, ch * ratio));
    const chips = [];
    if (g) { if (g.year) chips.push(String(g.year)); if (g.genre) chips.push(g.genre); chips.push(g.played ? short(g.played) + ' played' : 'Not played yet'); if (g.fav) chips.push('♥ Favourite'); }
    if (sealed) chips.unshift('Still sealed');
    const meta = !g && !x && m.hud ? m.hud.meta : '';
    const has = !!(g || x);
    mCard.innerHTML = `${has ? `<div class="mc-case${sealed ? ' sealed' : ''}" style="width:${cw}px;height:${ch}px">
        <div class="mc-cover">${cover ? '' : genCover(title)}</div>
        ${sealed ? '<div class="film"><i class="tape"></i></div>' : ''}<div class="rainbow"></div><div class="sparks">${'<i></i>'.repeat(14)}</div></div>` : ''}
      <div class="mc-info">
        <div class="kick">${esc(m.hud && m.hud.row || m.row.name || '')}</div>
        <h2 class="title${title.length > 34 ? ' long' : ''}">${esc(title)}</h2>
        ${chips.length ? `<div class="meta">${chips.slice(0, 4).map((c, i) => `<span${sealed && !i ? ' class="seal"' : ''}>${esc(c)}</span>`).join('')}</div>` : meta ? `<p class="note">${esc(meta)}</p>` : ''}
        ${sealed ? `<p class="mc-hint">${hd.held ? 'Drag on the wall to turn it · swipe the plastic to tear it off' : 'Swipe across the plastic to tear it off'}</p>` : hd.held ? '<p class="mc-hint">In your hands: drag here or on the wall to turn it</p>' : ''}
        <div class="mc-acts">
          ${hd.held ? '' : '<button class="mnav" type="button" data-cmd="prev" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>'}
          ${has ? (sealed ? `<button class="mbig unwrap" type="button" data-m="unwrap"><svg viewBox="0 0 24 24"><path d="M4 7l4-3 4 3 4-3 4 3v13H4z"/><path d="M4 12h16"/></svg><span>Unwrap</span></button>`
            : `<button class="mbig play" type="button" data-cmd="play"><svg viewBox="0 0 24 24"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg><span>Play</span></button>`) : '<span class="mbig ghost"></span>'}
          ${hd.held ? '' : '<button class="mnav" type="button" data-cmd="next" aria-label="Next"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>'}
        </div>
        <div class="mc-pills">${pills(hd, has, sealed, m.row, artOk)}</div>
      </div>`;
    if (cover) mCard.querySelector('.mc-cover').appendChild(img(cover));
  }
  // the second line of buttons: a row up / down and Pick up on the wall; in your hands, put it back (or first the disc
  // back / the case shut, as B does) and open it / take the disc out (as A does)
  const PI = {
    up: '<path d="M6 15l6-6 6 6"/>', down: '<path d="M6 9l6 6 6-6"/>',
    lift: '<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11M10 10V5a1.5 1.5 0 0 1 3 0v5M13 10V6a1.5 1.5 0 0 1 3 0v6c0 4-2.2 7-5.5 7S5 17 5 14.5V11a1.5 1.5 0 0 1 3 0"/>',
    back: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9a5 5 0 0 1 0 10h-2"/>',
    open: '<path d="M5 4.5h9.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5zM15.5 7l3.5-1.5v13L15.5 17"/>',
    disc: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/>',
    art: '<rect x="4" y="4.5" width="16" height="15" rx="2"/><circle cx="9.5" cy="9.5" r="1.6"/><path d="M5 17.5l4.5-4.5 3 3 2.5-2.5 4 4"/>'
  };
  const pill = (m, arg, ic, label, extra) => `<button class="mpill${extra || ''}" type="button" data-m="${m}"${arg != null ? ` data-a="${arg}"` : ''}><svg viewBox="0 0 24 24">${PI[ic]}</svg><span>${label}</span></button>`;
  function pills(hd, has, sealed, row, artOk) {
    if (hd.held) {
      const w = esc(String(hd.word || 'Disc').replace(' disk', ''));
      const back = hd.discOut ? pill('mback', null, 'disc', w + ' back') : hd.open ? pill('mback', null, 'open', 'Close case') : pill('mback', null, 'back', 'Put back');
      const act = sealed || hd.discOut ? '' : hd.open ? pill('mact', null, 'disc', w + ' out', ' hi') : pill('mact', null, 'open', 'Open case', ' hi');
      return back + act;
    }
    const top = row && row.i <= 0, bot = row && row.n != null && row.i >= row.n - 1;
    return pill('mrow', -1, 'up', 'Row up', top ? ' off' : '') + (has && !row.wide ? pill('mact', null, 'lift', 'Pick up', ' hi') : '') +
      (has && !row.wide && artOk ? pill('mart', null, 'art', 'Box art') : '') + pill('mrow', 1, 'down', 'Row down', bot ? ' off' : ''); // (0.3.5) Box art: the Art Studio on this case
  }
  mCard.addEventListener('click', e => {
    const b = e.target.closest('.mpill'); if (!b || b.classList.contains('off')) return;
    const m = b.dataset.m;
    if (m === 'mrow') cmd('mrow', +b.dataset.a); else if (m === 'mart') cmd('art'); else cmd(m);
  });

  // ---------- the case in your hands: a drag turns it on the big screen ----------
  // The turn travels as small steps (degrees), a few times a second at most while the finger moves; the museum eases the
  // case to them itself. Here the cover only leans a little toward the finger, then springs back.
  let turn = null;
  function turnStart(e, el) {
    if (turn) return;
    turn = { id: e.pointerId, el, x: e.clientX, y: e.clientY, sx: 0, sy: 0, qx: 0, qy: 0, t: 0, raf: 0 };
    try { el.setPointerCapture(e.pointerId); } catch {}
  }
  function turnMove(e) {
    const t = turn; if (!t || e.pointerId !== t.id) return false;
    const z = fit.z || 1, dx = (e.clientX - t.x) / z, dy = (e.clientY - t.y) / z; t.x = e.clientX; t.y = e.clientY;
    t.qx += dx * 0.9; t.qy -= dy * 0.6; t.sx += dx; t.sy += dy;
    const now = performance.now();
    if (now - t.t > 50 && (Math.abs(t.qx) + Math.abs(t.qy) > 0.5)) { t.t = now; cmd('mturn', { dx: +t.qx.toFixed(1), dy: +t.qy.toFixed(1) }); t.qx = t.qy = 0; }
    if (!t.raf) t.raf = requestAnimationFrame(() => { t.raf = 0; const c = mCard.querySelector('.mc-case'); if (c && turn === t) { c.style.transition = 'none'; c.style.transform = `perspective(700px) rotateY(${clamp(t.sx * 0.35, -32, 32).toFixed(1)}deg) rotateX(${clamp(-t.sy * 0.3, -20, 20).toFixed(1)}deg)`; } });
    return true;
  }
  function turnEnd(e) {
    const t = turn; if (!t || e.pointerId !== t.id) return false;
    turn = null; if (t.raf) cancelAnimationFrame(t.raf);
    if (Math.abs(t.qx) + Math.abs(t.qy) > 0.5) cmd('mturn', { dx: +t.qx.toFixed(1), dy: +t.qy.toFixed(1) }); // the last bit of the turn
    const c = mCard.querySelector('.mc-case'); if (c) { c.style.transition = 'transform .5s cubic-bezier(.3,1.4,.5,1)'; c.style.transform = ''; }
    return true;
  }
  mWall.addEventListener('pointermove', e => { turnMove(e); });
  mWall.addEventListener('pointerup', e => { turnEnd(e); });
  mWall.addEventListener('pointercancel', e => { turnEnd(e); });

  // ---------- the Room drawer: the room's looks as buttons ----------
  // Lighting, walls, floor, shelves and the gallery pieces (the shelf sends the lists and what's chosen with the wall). A
  // touch marks the choice here at once and the room on the big screen changes; the shelf's next message confirms it.
  const mRoom = $('mRoom'); let roomOpen = false; const roomPend = new Map();
  const SW = { // a little swatch for each choice, so the buttons show what they do
    light: { gallery: 'linear-gradient(135deg,#ffe0b0,#6a5a3a)', daylight: 'linear-gradient(135deg,#f4f7ff,#9fb6e0)', night: 'linear-gradient(135deg,#ffa860,#3a2a5a)', neon: 'linear-gradient(135deg,#ff2fb4,#22d8ff)', spotlit: 'radial-gradient(circle at 50% 30%,#fff 0,#fff0d6 30%,#1a1a22 70%)', lightsout: 'linear-gradient(135deg,#2a3050,#05060c)' },
    wall: { plaster: '#2a2e3c', wood: 'linear-gradient(90deg,#6b4526,#4a2e18 50%,#6b4526)', brick: 'linear-gradient(#8a3f2c 0 45%,#c9b7a0 45% 55%,#8a3f2c 55%)', wallpaper: 'repeating-linear-gradient(45deg,#3d3550 0 4px,#5a4f72 4px 8px)', green: '#1f3a2b', burgundy: '#4a1c28', navy: '#1a2a4a' },
    floor: { stone: 'linear-gradient(135deg,#6a6d78,#3a3c44)', wood: 'repeating-linear-gradient(90deg,#8a5a30 0 6px,#6e4524 6px 7px)', carpet: '#6a1f2a', checker: 'conic-gradient(#ddd 0 25%,#222 0 50%,#ddd 0 75%,#222 0) 0 0/10px 10px' },
    shelf: { walnut: '#3b2719', oak: '#86603c', black: '#141417', white: '#d6d0c4' }
  };
  function roomVal(k) { const p = roomPend.get(k); if (p && performance.now() - p.t < 2500) return p.v; return mMsg && mMsg.room && mMsg.room.v ? mMsg.room.v[k] : undefined; }
  function paintRoom() {
    const R = mMsg && mMsg.room;
    if (!R || !R.opts) { mRoom.innerHTML = '<div class="mr-head"><b>Room</b><span>Not available right now</span><button class="mr-x" type="button" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>'; return; }
    const keep = [...mRoom.querySelectorAll('.mr-chips')].map(el => el.scrollLeft);
    const lines = R.opts.filter(o => o.type === 'choice').map(o => `<div class="mr-line"><small>${esc(o.label)}</small><div class="mr-chips">${(o.opts || []).map(([v, l]) =>
      `<button class="chip${roomVal(o.key) === v ? ' on' : ''}" type="button" data-k="${esc(o.key)}" data-v="${esc(v)}"><i${SW[o.key] && SW[o.key][v] ? ` style="background:${esc(SW[o.key][v])}"` : ''}></i>${esc(l)}</button>`).join('')}</div></div>`);
    const bools = R.opts.filter(o => o.type === 'bool');
    if (bools.length) lines.push(`<div class="mr-line"><small>Gallery pieces</small><div class="mr-chips">${bools.map(o => `<button class="chip tog${roomVal(o.key) ? ' on' : ''}" type="button" data-k="${esc(o.key)}" data-b="1"><i></i>${esc(o.label)}</button>`).join('')}</div></div>`);
    mRoom.innerHTML = `<div class="mr-head"><b>Room</b><span>${R.v && R.v.timeOfDay ? 'Lighting follows the time of day until you pick one' : 'Changes show on the big screen'}</span>
      <button class="mr-x" type="button" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="mr-body">${lines.join('')}</div>`;
    mRoom.querySelectorAll('.mr-chips').forEach((el, i) => { if (keep[i]) el.scrollLeft = keep[i]; });
  }
  function toggleRoom(on) {
    roomOpen = on == null ? !roomOpen : !!on;
    if (roomOpen) paintRoom();
    document.body.classList.toggle('room', roomOpen); mRoom.setAttribute('aria-hidden', String(!roomOpen));
  }
  $('roomBtn').addEventListener('click', () => toggleRoom());
  mRoom.addEventListener('click', e => {
    if (e.target.closest('.mr-x')) { toggleRoom(false); return; }
    const c = e.target.closest('.chip'); if (!c) return;
    const k = c.dataset.k, v = c.dataset.b ? !c.classList.contains('on') : c.dataset.v;
    roomPend.set(k, { v, t: performance.now() });
    if (c.dataset.b) c.classList.toggle('on', v); else c.parentNode.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b === c));
    cmd('room', { key: k, val: v });
  });
  // tearing the plastic: drag across it, past about half way it comes off; less and it springs back
  let tear = null, tRaf = 0;
  mCard.addEventListener('click', e => { const b = e.target.closest('[data-m="unwrap"]'); if (b) unwrapAnim(1, true); });
  mCard.addEventListener('pointerdown', e => {
    if (held() && !e.target.closest('button') && !e.target.closest('.film')) { turnStart(e, mCard); return; }
    const f = e.target.closest('.film'); if (!f || tear || !f.closest('.mc-case.sealed')) return;
    tear = { id: e.pointerId, x: e.clientX, f, w: f.offsetWidth || 150, p: 0, dx: 0, moved: false };
    f.style.transition = 'none';
    try { mCard.setPointerCapture(e.pointerId); } catch {}
  });
  mCard.addEventListener('pointermove', e => {
    if (turnMove(e)) return;
    if (!tear || e.pointerId !== tear.id) return;
    const dx = (e.clientX - tear.x) / (fit.z || 1);
    if (!tear.moved && Math.abs(dx) < 6) return;
    tear.moved = true; tear.dx = dx; tear.p = clamp(Math.abs(dx) / (tear.w * 0.8), 0, 1);
    if (!tRaf) tRaf = requestAnimationFrame(() => { tRaf = 0; if (!tear) return; const t = tear;
      t.f.style.transform = `translate3d(${(t.dx * 0.8).toFixed(1)}px,${(-Math.abs(t.dx) * 0.08).toFixed(1)}px,0) rotate(${(t.dx * 0.035).toFixed(2)}deg)`; t.f.style.opacity = String(1 - t.p * 0.3); });
  });
  const tEnd = e => {
    if (turnEnd(e)) return;
    if (!tear || e.pointerId !== tear.id) return;
    const t = tear; tear = null;
    if (tRaf) { cancelAnimationFrame(tRaf); tRaf = 0; }
    if (t.moved && t.p >= 0.45 && e.type !== 'pointercancel') { unwrapAnim(Math.sign(t.dx) || 1, true); return; }
    t.f.style.transition = 'transform .45s cubic-bezier(.3,1.5,.5,1),opacity .3s'; t.f.style.transform = ''; t.f.style.opacity = '';
    if (!t.moved) { const c = t.f.closest('.mc-case'); c.classList.remove('nudge'); void c.offsetWidth; c.classList.add('nudge'); }
  };
  mCard.addEventListener('pointerup', tEnd);
  mCard.addEventListener('pointercancel', tEnd);
  // the plastic peels off and flies away, a rainbow sweeps across the bare cover, a little glitter; tell the wall (once)
  function unwrapAnim(dir, tell) {
    const c = mCard.querySelector('.mc-case.sealed'); if (!c || c.classList.contains('peeling')) return;
    const f = c.querySelector('.film'), sel = MU ? MU.sel : -1, id = mCard.dataset.id || '';
    c.classList.add('peeling');
    if (f) { f.getBoundingClientRect(); f.style.transition = 'transform .75s cubic-bezier(.3,.55,.2,1),opacity .5s ease .2s'; f.style.transform = `translate3d(${dir * 240}px,-130px,0) rotate(${dir * 26}deg) scale(1.08)`; f.style.opacity = '0'; }
    c.classList.add('shine');
    setTimeout(() => { if (f) f.remove(); c.classList.remove('sealed', 'peeling'); }, 820);
    setTimeout(() => c.classList.remove('shine'), 1700);
    if (id) peeled.set(id, performance.now());
    const b = MU && MU.els.get(sel); if (b) b.classList.remove('sealed');
    const chip = mCard.querySelector('.meta .seal'); if (chip) chip.remove();
    const h = mCard.querySelector('.mc-hint'); if (h) h.remove();
    const ub = mCard.querySelector('[data-m="unwrap"]');
    if (ub) { ub.outerHTML = '<button class="mbig play" type="button" data-cmd="play"><svg viewBox="0 0 24 24"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg><span>Play</span></button>'; }
    mCard.dataset.key = mCard.dataset.key.replace('|true|', '|false|');
    if (tell && sel >= 0) send({ type: 'cmd', cmd: 'unwrap', arg: sel });
  }

  // ---------- the Art Studio (body.studio: while the top screen's Art Studio is up) ----------
  // The case only, big in the middle (the focus view's place, without its buttons): the studio sends the game and, for
  // each part, the picture under its cursor; a new picture goes into its own face (decoded first, no rebuild) and the
  // case turns to the part being edited (the back, the spine; open on its tray for the disc). Transitions only, no loop
  // and no sway, so it is still whenever the cursor is. Closing it hands the page back to the shelf's game.
  let SD = null; // { id, art, tab }
  const SD_TURN = { front: { ry: 22, rx: -6 }, back: { ry: 200, rx: -6 }, spine: { ry: 80, rx: -4 } };
  const isStudio = () => document.body.classList.contains('studio');
  function showStudio(m) {
    if (!m.open || !m.game) {
      if (!isStudio()) return;
      const t = SD && SD.tab; SD = null; document.body.classList.remove('studio'); exitFocus(true);
      game = null; // the shelf's game comes next and is built again with the pictures really in use
      if (t && t !== 'case') setTab(t, true);
      return;
    }
    const g = m.game, art = Object.assign({}, g.art || {}, m.art || {});
    if (!isStudio()) {
      const t = tab; if (isMuseum()) leaveMuseum(); if (tab !== 'case') setTab('case', true); else if (focus) exitFocus(true); else if (isOpen()) closeCase(true);
      stopFlick(); document.body.classList.add('studio'); SD = { id: null, art: {}, tab: t };
    }
    if (SD.id !== g.id || !V) {
      SD.id = g.id; SD.art = art; const prevSys = game && game.system && game.system.id;
      game = Object.assign({}, g, { art }); paintGlow(game, prevSys); $('sysName').textContent = (g.system && g.system.name) || '';
      focus = true; zoom = 1; document.body.classList.add('focus'); buildCase(game);
      if (V) placePos(false);
    } else {
      for (const p of ['front', 'back', 'spine', 'disc']) if (art[p] !== SD.art[p]) setFace(p, art[p]);
      SD.art = art;
    }
    turnTo(m.part);
  }
  function setFace(p, u) {
    if (!V || !V.boxed) return;
    if (!u) { game = Object.assign({}, game, { art: Object.assign({}, SD.art, { [p]: null }) }); buildCase(game); placePos(false); return; } // back to the made-up one: built again
    const host = p === 'disc' ? V.box.querySelector('.media .disc') : V.box.querySelector(`.f-${p} .print`); if (!host) return;
    host._u = u; const im = img(u, p === 'spine' ? 'sp' : '');
    im.decode().catch(() => {}).then(() => { if (host._u !== u || !host.isConnected) return; host.textContent = ''; host.appendChild(im); if (p === 'disc') host.classList.add('art'); });
  }
  function turnTo(part) {
    if (!V || !V.boxed) return;
    if (part === 'disc') { if (!isOpen()) openCase(); return; }
    if (isOpen()) closeCase(true);
    const t = SD_TURN[part] || SD_TURN.front;
    P.ry = Math.round((P.ry - t.ry) / 360) * 360 + t.ry; P.rx = t.rx; applySpin(true);
  }
  // ---------- start ----------
  window.bsBottom = { recv, demo: () => demoGame(), demoMuseum: () => demoMuseum(), setTab,
    state: () => ({ id: game && game.id, title: game && game.title, tab, open: isOpen(), out: !!(V && V.box && V.box.classList.contains('out')), sent: sent.slice(),
      rx: P.rx, ry: P.ry, pack: V && V.pack, spinning: !!flick, museum: isMuseum(), msel: MU ? MU.sel : null, mitems: MU ? MU.els.size : 0,
      msealed: !!mCard.querySelector('.mc-case.sealed'), mtitle: (mCard.querySelector('.title') || {}).textContent || '',
      focus, zoom, room: roomOpen, mheld: held(), pills: [...mCard.querySelectorAll('.mpill span')].map(x => x.textContent),
      solo: solo.on, srx: solo.rx, sry: solo.ry, shortcuts: scList(), editing: scEdit, theme: document.body.dataset.theme || '', themed: document.body.classList.contains('themed'),
      ctx: CX0 ? CX0.kind : null, apps: apps ? apps.length : null, icons: icons.size, shelves: shelvesNow.length,
      studio: isStudio() ? { id: SD && SD.id, open: isOpen(), art: Object.assign({}, SD && SD.art), menu: !!document.querySelector('.sd, .sd-grid') } : null }) };
  addEventListener('message', e => { if (e.source === window.parent && e.data && e.data.bsBottomRecv) recv(e.data.bsBottomRecv); }); // a preview inside the main page
  setTab(store.get('tab') || 'case', true);
  show(null);
  send({ type: 'ready' });

  // opened directly in a browser (no shelf talking to it): a demo game, so the page can be seen and tested
  // (?demo=museum shows the museum companion instead)
  const alone = !window.BoxshelfBottom && window.parent === window && !/[?&]demo=0/.test(location.search);
  if (alone) setTimeout(() => { if (!game && !isMuseum()) { if (/[?&]demo=museum/.test(location.search)) recv({ type: 'museum', ...demoMuseum() }); else recv({ type: 'game', game: demoGame(),
    shelves: [['gc', 'GameCube', 15, '#9d8cff', 1], ['ps2', 'PlayStation 2', 42, '#5aa0ff'], ['nds', 'DS', 23, '#c9d1ff'], ['psp', 'PSP', 8, '#ff9f6b'], ['snes', 'Super Nintendo', 31, '#b48cff'], ['media', 'Apps', 12, '#b9a6ff']]
      .map(([id, name, n, glow, cur]) => ({ id, name, n, glow, kind: id === 'media' ? 'apps' : 'console', cur: !!cur })) }); } }, 250);
  const svgUrl = s => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  function demoCover(a, b, title, sub) {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="420" height="590" viewBox="0 0 420 590">
      <defs><linearGradient id="a" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="#140c33"/></linearGradient>
      <radialGradient id="s" cx=".7" cy=".32" r=".3"><stop offset="0" stop-color="#fff6c8"/><stop offset="1" stop-color="#fff6c8" stop-opacity="0"/></radialGradient></defs>
      <rect width="420" height="590" fill="url(#a)"/><circle cx="294" cy="190" r="130" fill="url(#s)"/><circle cx="294" cy="190" r="44" fill="#fff3c4"/>
      <path d="M0 430 Q110 360 210 410 T420 390 V590 H0z" fill="#0f0a26" opacity=".85"/><path d="M0 470 Q140 420 260 460 T420 450 V590 H0z" fill="#07051a"/>
      <rect width="420" height="44" fill="#26262e"/><text x="210" y="29" font-family="Lexend,sans-serif" font-size="17" font-weight="700" fill="#c3c3cf" text-anchor="middle" letter-spacing="3">GAMECUBE</text>
      <text x="34" y="112" font-family="Lexend,sans-serif" font-size="52" font-weight="800" fill="#fff">${title}</text>
      <text x="36" y="156" font-family="Lexend,sans-serif" font-size="30" font-weight="600" fill="#ffe2c4" letter-spacing="6">${sub}</text></svg>`);
  }
  function demoGame() {
    return { id: 'demo', kind: 'rom', title: 'Starlight Courier', system: { id: 'gc', name: 'GameCube' }, hue: 258,
      style: { ratio: 0.712, depth: 0.105, rc: 0.03, re: 0.2, edge: 0.022, pack: 'keep', caseColor: '#16161b', caseSide: '#0b0b0e', spineInk: '#e8e8f0', band: { bg: '#26262e', fg: '#c3c3cf', label: 'GAMECUBE' },
        spineBand: { bg: '#2c2c35', fg: '#c3c3cf', label: 'GCN' }, glow: '#9d8cff', tint: ['#3a2a86', '#120d2c'] },
      media: { kind: 'disc', size: 0.62 }, art: { front: demoCover('#ff9f6b', '#7a3fd1', 'STARLIGHT', 'COURIER'), back: null, spine: null, disc: null },
      year: 2003, genre: 'Adventure', dev: 'Lantern Works', pub: 'Boxshelf Demo', players: '1', rating: 4.4, region: 'USA', size: '1.3 GB', discs: 0,
      desc: 'Deliver the last letters of a fading kingdom by glider, across islands that drift a little further apart every night. A demo game, shown when this page is opened on its own.',
      played: '6 h 20 min', plays: 9, last: 'Yesterday', fav: true, manual: true, ach: { earned: 23, total: 40, mastered: false }, achOn: true };
  }
  function demoMuseum() {
    const cols = [['#ff9f6b', '#7a3fd1'], ['#6bd3ff', '#1d4fa3'], ['#9cff8a', '#1a7f1a'], ['#ffd36b', '#b8461a'], ['#ff7aa8', '#5a1d6e'], ['#c9d1ff', '#39407a']];
    const names = ['STARLIGHT', 'TIDEBOUND', 'MOSSWORK', 'EMBERFALL', 'PETALS', 'ORBIT', 'HOLLOW', 'RIVETS', 'LANTERN', 'NIMBUS', 'QUARRY', 'SKYLARK'];
    const games = names.map((n, i) => ({ i, id: 'm' + i, title: n[0] + n.slice(1).toLowerCase() + (i % 3 ? '' : ' Deluxe'), cover: i % 5 === 4 ? null : demoCover(cols[i % 6][0], cols[i % 6][1], n, 'DEMO'), sealed: i % 3 === 1 }));
    const sel = 4, g = Object.assign(demoGame(), { id: games[sel].id, title: games[sel].title, art: { front: games[sel].cover }, sealed: games[sel].sealed, played: null, fav: false });
    return { row: { id: 'gc', name: 'GameCube', i: 0, n: 3, count: games.length, from: 0, sel, held: false, style: { glow: '#9d8cff', tint: ['#3a2a86', '#120d2c'], ratio: 0.712 } },
      games, game: g, hud: { row: 'GameCube', title: g.title, meta: '', sealed: g.sealed } };
  }
})();
