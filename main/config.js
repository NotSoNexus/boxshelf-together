const fs = require('fs');
const path = require('path');
const { CONSOLES, APPS } = require('./systems');

let FILE = null, log = () => {};
function init(userDataDir, logger) { FILE = path.join(userDataDir, 'config.json'); if (logger) log = logger; }
function useFile(file) { FILE = file; readBlocked = false; }

function defaults() {
  const systems = {};
  for (const s of CONSOLES) {
    systems[s.id] = {
      enabled: true,
      emulator: '',
      gameArgs: s.gameArgs,
      emulatorArgs: s.emulatorArgs,
      coverSeconds: s.coverSeconds,
      romDirs: [],
      artDir: '',
      bootOnLaunch: true,
      useIpl: false,
      iplCoverSeconds: 2.5,
      hideDolphinWarnings: false,
      insertAnim: true
    };
  }
  const apps = {};
  for (const a of APPS) apps[a.id] = { enabled: true, path: '' };
  return {
    setupDone: false,
    systems,
    steam: { enabled: true, path: '', hideTools: true },
    // (beta.4) PC games beyond Steam (main/pcgames.js): Epic's installs on the PC shelf; Quiver Launcher's apps and games
    // added by hand ({ id, title, exe, args }) on the Custom shelf. quiverPath: a portable Quiver's folder, chosen or found
    pc: { epic: true, quiver: true, quiverPath: '', custom: [], gog: true, ubisoft: true, ea: true, xbox: true },
    games: {}, // per-game choices keyed by game id ("<console>:<file>"): { emulator } = this game runs in its own emulator build
    emuSeen: [], // emulator builds used before (newest first): offered for a game a build was made for
    // (beta.7) Set up for me (main/emusetup.js): auto = the first run sets up emulators that look new; graphics = the preset
    // (auto: picked for this PC); resume = RetroArch carries on where you left off; pending = emulators to set up at their
    // next launch (not opened yet when setup ran: their settings file comes with the first run)
    emuSetup: { auto: true, graphics: 'auto', resume: false, pending: [] },
    apps,
    ra: { user: '', key: '', enabled: true },
    // (beta.12, Windows) RocketLauncher (main/rocket.js): its program, which consoles start through it (off · all · some:
    // the consoles whose systems.<id>.viaRocket is on) and the front end name it's told (-p; '' leaves -p out)
    rocket: { exe: '', mode: 'off', frontend: '' },
    // autoCovers / autoManuals: downloads from the Internet are opt-in for new installs; load() keeps them on for a config
    // saved before the keys existed, so nothing changes for people already using Boxshelf
    // (beta.12) RomM (main/romm.js): the server's address, its HTTPS check skipped for a home server's own certificate,
    // and whether games not on this device show (with a cloud badge). Its sign-in token is keys.rommToken (kept by main)
    romm: { server: '', skipTls: false, cloud: true },
    keys: { fanart: '', steamgriddb: '', ssUser: '', ssPass: '', ssDevId: '', ssDevPass: '', rommToken: '', rommTokenServer: '' }, // Settings → Accounts & services: personal API keys, kept encrypted on disk (steamgriddb: Art Studio posters; ss*: the ScreenScraper sign-in, 1.71)
    // Art Studio: styles = per console shelf style (a console without one follows defaultArtStyle(ui), i.e. the old Box art
    // region / Prefer HD settings, so nothing changes until a style is chosen); locks = per game parts auto-fetch never touches
    art: { styles: {}, locks: {} },
    ui: { sound: true, startFullscreen: true, buttons: 'auto', performance: 'auto', quitCombo: true, quitComboKeys: 'l3+r3', soundTheme: 'aero', volume: .7, ambient: false, ambientLevel: .02, music: 'off', musicLevel: .4, musicFile: '', rumble: true, soundRev: 4, autoCovers: false, autoManuals: false, artLibrary: '', attract: true, attractMinutes: 3, attractPace: 'normal', attractWander: true,shuffleAll: true, favorites: [], collections: [], background: 'blur', theme: 'spectrum', sort: 'az', filter: 'all', museumLight: 'gallery', homeMenu: true, homeLayout: 'side', hideTaskbar: true, seamless: true, screenMode: '', windowBounds: null, uiScale: 1, previews: 'off', previewSound: false, previewYoutube: true, previewClips: true, previewDirs: [], previewDelay: 1.5, previewHint: false, clipHint: false, deckHint: false, leaveHint: false, lastSeenVersion: '', // (beta.7) video previews; lastSeenVersion: the version whose What's new was shown: off / details / shelf (Details and behind the shelf); the first run asks
      // 1.55 Settings
      updateCheck: true, // (1.82) Settings → System → Check for new betas
      openInto: 'last', display: '', safeArea: 100, clock: 'full', clock24: false, reduceMotion: false, dimMinutes: 0, confirmButton: 'auto', scrollSpeed: 'normal', artRegion: 'auto', audioOut: '', hidden: [], museumStyle: { walkIn: true } }
  };
}

// Merge saved values over defaults so new options appear after updates. Where the default is an object (a section like
// ui, or one system) or an array (favorites, romDirs), a saved value of another shape ("ui": null, a hand-edited string)
// is dropped for the default: the app reads cfg.ui.x everywhere and would crash on startup.
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// (beta.12) Details' Status per game (cfg.games[id].status): the words the shelf can sort and filter by later
const GAME_STATUS = ['playing', 'finished', 'notstarted', 'abandoned'];
function merge(base, saved) {
  if (!isObj(saved)) return saved === undefined ? base : saved;
  const out = Array.isArray(base) ? [] : { ...base };
  for (const k of Object.keys(saved)) {
    const b = base ? base[k] : undefined;
    out[k] = isObj(b) ? (isObj(saved[k]) ? merge(b, saved[k]) : b) : Array.isArray(b) && !Array.isArray(saved[k]) ? b : saved[k];
  }
  return out;
}

// Older default launch options that should move to the new defaults automatically.
const OLD_DEFAULTS = { gc: ['-b -e "{rom}"'], wii: ['-b -e "{rom}"'] };

function upgrade(cfg) {
  if (cfg.ui && cfg.ui.quitComboKeys === 'start+back' && !cfg.ui.quitComboChosen) cfg.ui.quitComboKeys = 'l3+r3';
  // 0.7.3 turned the whole mix down and the ambient bed way down; carry saved configs over to the new quiet defaults once
  if (cfg.ui && (cfg.ui.soundRev || 1) < 2) { if (cfg.ui.ambientLevel == null || cfg.ui.ambientLevel >= .05) cfg.ui.ambientLevel = .02; cfg.ui.soundRev = 2; }
  // 0.7.4: the ambient bed is opt-in
  if (cfg.ui && cfg.ui.soundRev < 3) { cfg.ui.ambient = false; cfg.ui.soundRev = 3; }
  // 1.75: menu music replaced the ambient bed; whoever had the bed on gets the Calm track at about the same loudness, the rest keep quiet
  if (cfg.ui && cfg.ui.soundRev < 4) { const on = cfg.ui.ambient === true, lv = +cfg.ui.ambientLevel; cfg.ui.music = on ? 'calm' : 'off'; cfg.ui.musicLevel = on && Number.isFinite(lv) && lv > 0 ? Math.min(1, Math.round(lv / .02 * .4 * 20) / 20) : .4; cfg.ui.soundRev = 4; }
  // 1.28: five themes and three sounds; older picks move to their nearest new one
  if (cfg.ui) {
    const TH = { sunset: 'spectrum', gallery: 'midnight', synthwave: 'arcade' }, SN = { glass: 'aero', wood: 'aero', pulse: 'musicbox', arcade: 'musicbox', xylo: 'melody', jazz: 'melody' };
    if (TH[cfg.ui.theme]) cfg.ui.theme = TH[cfg.ui.theme];
    if (SN[cfg.ui.soundTheme]) cfg.ui.soundTheme = SN[cfg.ui.soundTheme];
    // 1.76: Background → Game artwork became the Artwork theme (and Soft blur the default under every theme, or the Blur theme)
    if (cfg.ui.background === 'art') { cfg.ui.theme = 'artwork'; cfg.ui.background = 'blur'; }
    // 1.75: the ten extra themes (themes-extra.js) on Windows too; 1.76: Artwork and Blur
    if (!['spectrum', 'classic', 'keys', 'arcade', 'aurora', 'midnight', 'artwork', 'blur', 'cube', 'blueshift', 'swirl', 'pocket', 'oled', 'walnut', 'forest', 'crt', 'vhs', 'synth'].includes(cfg.ui.theme || 'spectrum') && !/^custom-[a-z0-9-]{1,48}$/.test(String(cfg.ui.theme))) cfg.ui.theme = 'spectrum'; // (custom-…: a picture theme from Custom themes\, 1.76; the shelf falls back to Spectrum itself if its folder is gone)
    if (!['aero', 'melody', 'musicbox'].includes(cfg.ui.soundTheme || 'aero')) cfg.ui.soundTheme = 'aero';
    // 1.77: the ambient tracks (Drift / Night / Glow) took over from Calm / Lounge / Chime. (1.82: new installs start with
    // the music off; a saved config always has ui.music, so existing choices are kept)
    const MU = { calm: 'drift', lounge: 'night', chime: 'glow' }; if (MU[cfg.ui.music]) cfg.ui.music = MU[cfg.ui.music];
    if (!['drift', 'night', 'glow', 'custom', 'off'].includes(cfg.ui.music || 'drift')) cfg.ui.music = 'drift';
    if (typeof cfg.ui.musicFile !== 'string') cfg.ui.musicFile = '';
    if (!['chime', 'crystal', 'pulse', 'horizon', 'keys'].includes(cfg.ui.bootSound || 'chime')) cfg.ui.bootSound = 'chime';
  }
  for (const s of CONSOLES) {
    const c = cfg.systems[s.id];
    if (c && (OLD_DEFAULTS[s.id] || []).includes(c.gameArgs)) c.gameArgs = s.gameArgs;
  }
  return cfg;
}

// Defaults for a config file that exists but predates a key (merge alone would give it today's new-install default)
function existingUser(cfg, saved) {
  const ui = saved && isObj(saved.ui) ? saved.ui : {};
  for (const k of ['autoCovers', 'autoManuals']) if (ui[k] === undefined) cfg.ui[k] = true;
  return cfg;
}
// A file that is there but can't be read right now (EBUSY / EPERM: antivirus or OneDrive holding it) isn't damaged: try
// again for a moment, and if it stays locked run on defaults WITHOUT ever saving over it (readBlocked) until restart
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
let readBlocked = false;
function load() {
  let text = null;
  for (let i = 0; ; i++) {
    try { text = fs.readFileSync(FILE, 'utf8'); readBlocked = false; break; } catch (e) {
      if (e.code === 'ENOENT') { readBlocked = false; return defaults(); }
      if (i < 5 && e.code !== 'EISDIR') { sleepSync(50); continue; }
      if (e.code !== 'EISDIR') { readBlocked = true; log('Settings file could not be read (' + (e.code || e.message) + '): running on defaults, and not saving over it');
        // (1.82) the file is there, only locked (antivirus, a sync tool): this is an existing user, so no first-run wizard; the
        // shelf says to restart instead (blocked())
        const c = existingUser(defaults(), null); c.setupDone = true; return c; }
      log('Settings file could not be read:', e.message); break;
    }
  }
  try {
    if (text == null) throw new Error('unreadable');
    const saved = JSON.parse(text); if (!isObj(saved)) throw new Error('not a settings object');
    const cfg = existingUser(merge(defaults(), saved), saved);
    // merge fills soundRev with today's default, which would hide a pre-0.7.3 config from the sound migrations: a file without the key is rev 1
    if (!isObj(saved.ui) || saved.ui.soundRev == null) cfg.ui.soundRev = 1;
    return sanitize(upgrade(cfg));
  } catch (e) {
    // a truncated or broken file: keep a copy before running on defaults, or the next save would overwrite the only one
    const keep = `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(FILE, keep); log('Settings file is damaged (' + e.message + '), copied to', keep, '- starting from defaults'); } catch (e2) { log('Settings file is damaged and could not be copied aside:', e2.message); }
    return existingUser(defaults(), null);
  }
}

// temp + fsync + rename: a crash or power cut leaves the old file or the new one, never a truncated config
function writeNow(json, tmpName) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + (tmpName || '.tmp'); let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600); fs.writeSync(fd, json); fs.fsyncSync(fd); fs.closeSync(fd); fd = null; // (beta.10: 0600, readable by this user only, on Linux; Windows ignores it)
    // Windows: antivirus / indexing can hold the file for a moment; retry for up to about a second
    for (let i = 0; ; i++) { try { fs.renameSync(tmp, FILE); break; } catch (e) { if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; sleepSync(50); } }
  } catch (e) { if (fd != null) { try { fs.closeSync(fd); } catch {} } try { fs.unlinkSync(tmp); } catch {} throw e; }
}
// the same, without holding up the main process (a slow disk, antivirus scanning the file): the write, its fsync and the
// rename retries all wait in the background
// (beta.12) flushGen: flush() at quit writes the newest settings itself; a background write started before it (older
// settings) must not rename over that afterwards, so it checks the generation it began in and stands down
let flushGen = 0;
async function writeLater(json) {
  const g = flushGen;
  await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp'; let fh = null;
  try {
    fh = await fs.promises.open(tmp, 'w', 0o600); await fh.writeFile(json); await fh.sync(); await fh.close(); fh = null;
    if (g !== flushGen) { await fs.promises.unlink(tmp).catch(() => {}); return; }
    for (let i = 0; ; i++) { if (g !== flushGen) { await fs.promises.unlink(tmp).catch(() => {}); return; } try { await fs.promises.rename(tmp, FILE); break; } catch (e) { if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; await new Promise(r => setTimeout(r, 50)); } }
  } catch (e) { if (fh) { try { await fh.close(); } catch {} } try { await fs.promises.unlink(tmp); } catch {} throw e; }
}
// (beta.9) save(): checked and turned into text at once (so a bad object or a blocked file is said straight away, as
// before), then written in the background: one write at a time, the newest settings always the ones written. flush()
// (Boxshelf quitting) writes anything still waiting, the old way, so nothing is lost.
let waiting = null, writing = false, lastJson = null;
async function pump() {
  if (writing) return; writing = true;
  try { while (waiting != null) { const json = waiting; waiting = null; try { await writeLater(json); } catch (e) { log('Settings: saving failed (' + (e.code || e.message) + '), trying again with the next change'); if (waiting == null) waiting = json; break; } } }
  finally { writing = false; }
}
function save(cfg) {
  if (!isObj(cfg)) throw new Error('Not a settings object.');
  if (readBlocked) throw new Error('Your settings file couldn\'t be read when Boxshelf started (another program had it locked), so it won\'t be overwritten. Restart Boxshelf to load it.');
  lastJson = waiting = JSON.stringify(cfg, null, 2);
  pump();
  return cfg;
}
function flush() {
  if (waiting == null && !writing) return;
  const json = lastJson; waiting = null; flushGen++;
  try { writeNow(json, '.tmp-quit'); } catch (e) { log('Settings: last save at quit failed:', e.message); }
}

// Values the settings screen chooses from: anything else (a hand-edited file, an older or newer version) falls back to
// the default, so the screen never has to cope with a value it can't show
const ONE_OF = { openInto: ['last', 'home', 'museum'], clock: ['full', 'time', 'off'], confirmButton: ['auto', 'a', 'b'], scrollSpeed: ['relaxed', 'normal', 'fast'], artRegion: ['auto', 'usa', 'eur', 'jpn'],
  // also the ones the shelf, the quit combo (padwatch COMBOS / Dolphin's Hotkeys.ini) and the Home menu read: a value none of
  // them knows lit no choice in Settings and, for the combo, armed L3+R3 for the pad while Dolphin got no hotkey at all
  buttons: ['auto', 'xbox', 'ps', 'nintendo'], quitComboKeys: ['l3+r3', 'lb+rb+start', 'back+b', 'start+back'], performance: ['auto', 'high', 'balanced', 'low'], background: ['blur', 'art'], homeLayout: ['side', 'center'] };
function sanitize(cfg) {
  if (!isObj(cfg) || !isObj(cfg.ui)) return cfg;
  const ui = cfg.ui, d = defaults().ui;
  // per-game emulator overrides: plain paths only, a sane number of them
  // (beta.5: title = the name the player gave it) (beta.12: status = Details' Status, one of GAME_STATUS)
  const games = {}; if (isObj(cfg.games)) for (const [id, v] of Object.entries(cfg.games).slice(0, 5000)) { if (typeof id !== 'string' || id.length > 2048 || !isObj(v)) continue; const e = typeof v.emulator === 'string' ? v.emulator.trim().slice(0, 1024) : '', t = typeof v.title === 'string' ? v.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '', st = GAME_STATUS.includes(v.status) ? v.status : ''; if (e || t || st) games[id] = { ...(e ? { emulator: e } : {}), ...(t ? { title: t } : {}), ...(st ? { status: st } : {}) }; }
  cfg.games = games;
  // (beta.7) your collections (shelves of your own): [{ id, name, ids: [game ids] }], a sane number and size
  ui.lastSeenVersion = typeof ui.lastSeenVersion === 'string' ? ui.lastSeenVersion.slice(0, 40) : '';
  if (!['off', 'details', 'shelf'].includes(ui.previews)) ui.previews = 'off'; for (const k of ['previewSound', 'previewYoutube', 'previewClips']) if (typeof ui[k] !== 'boolean') ui[k] = d[k];
  { const n = +ui.previewDelay; ui.previewDelay = [0.5, 1, 1.5, 2, 3, 5, 8, 10, 15].includes(n) ? n : 1.5; } // (beta.8: more choices, half a second to 15 seconds)
  { if (typeof ui.clipHint !== 'boolean') ui.clipHint = false; if (typeof ui.deckHint !== 'boolean') ui.deckHint = false; if (typeof ui.leaveHint !== 'boolean') ui.leaveHint = false; if (typeof ui.deckScaled !== 'boolean') ui.deckScaled = false; }
  ui.previewDirs = [...new Set((Array.isArray(ui.previewDirs) ? ui.previewDirs : []).filter(x => typeof x === 'string' && x && x.length <= 1024))].slice(0, 20);
  ui.collections = (Array.isArray(ui.collections) ? ui.collections : []).filter(c => isObj(c) && typeof c.id === 'string' && c.id && typeof c.name === 'string').slice(0, 50)
    .map(c => ({ id: c.id.slice(0, 40), name: c.name.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Collection', ids: [...new Set((Array.isArray(c.ids) ? c.ids : []).filter(x => typeof x === 'string' && x && x.length <= 1024))].slice(0, 5000) }));
  // (beta.4) games added by hand: plain paths and names only, a sane number of them
  if (isObj(cfg.pc)) { const s = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
    cfg.pc.custom = (Array.isArray(cfg.pc.custom) ? cfg.pc.custom : []).filter(c => isObj(c) && s(c.exe, 1024)).slice(0, 2000).map(c => ({ id: s(c.id, 80) || s(c.title, 80) || s(c.exe, 80), title: s(c.title, 120), exe: s(c.exe, 1024), args: s(c.args, 1000), ...(s(c.src, 20) ? { src: s(c.src, 20) } : {}), ...(c.shelf === 'pc' ? { shelf: 'pc' } : {}) })); // (beta.7: src 'playnite' marks an import, for Remove what was imported; up to 2000 games) (beta.10: shelf 'pc' = on the PC shelf instead of Custom)
    cfg.pc.pnDirs = isObj(cfg.pc.pnDirs) ? Object.fromEntries(Object.entries(cfg.pc.pnDirs).slice(0, 60).map(([k, v]) => [String(k).slice(0, 20), (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.length <= 1024).slice(0, 50)])) : {}; // (the games folders a Playnite import added)
    cfg.pc.quiverPath = s(cfg.pc.quiverPath, 1024); for (const k of ['epic', 'quiver', 'gog', 'ubisoft', 'ea', 'xbox']) if (typeof cfg.pc[k] !== 'boolean') cfg.pc[k] = true; } // (beta.7: the four new stores)
  { const e = isObj(cfg.emuSetup) ? cfg.emuSetup : {}; cfg.emuSetup = { auto: e.auto !== false, graphics: ['auto', 'fast', 'balanced', 'pretty'].includes(e.graphics) ? e.graphics : 'auto', resume: e.resume === true,
    pending: [...new Set((Array.isArray(e.pending) ? e.pending : []).filter(x => typeof x === 'string' && x && x.length <= 1024))].slice(0, 40) }; }
  cfg.emuSeen = Array.isArray(cfg.emuSeen) ? [...new Set(cfg.emuSeen.filter(x => typeof x === 'string' && x && x.length <= 1024))].slice(0, 20) : [];
  for (const [k, list] of Object.entries(ONE_OF)) if (!list.includes(ui[k])) ui[k] = d[k];
  if (typeof ui.clock24 !== 'boolean') ui.clock24 = d.clock24;
  // (beta.12) Reduce motion: false Off (every effect, whatever the system says), true On, 'system' Follow Windows
  if (typeof ui.reduceMotion !== 'boolean' && ui.reduceMotion !== 'system') ui.reduceMotion = d.reduceMotion;
  // (beta.12) Seamless play (main/seamless.js): on unless turned off; the screen mode ('' = never chosen: Start in
  // fullscreen decides); Window mode's last place and size
  if (typeof ui.seamless !== 'boolean') ui.seamless = true;
  if (!['', 'full', 'window'].includes(ui.screenMode)) ui.screenMode = '';
  { const b = ui.windowBounds; ui.windowBounds = isObj(b) && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k]) && Math.abs(b[k]) < 100000) && b.width >= 200 && b.height >= 150 ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null; }
  ui.display =typeof ui.display === 'string' || typeof ui.display === 'number' ? String(ui.display).slice(0, 64) : '';
  ui.audioOut = typeof ui.audioOut === 'string' ? ui.audioOut.slice(0, 512) : '';
  { const n = +ui.safeArea; ui.safeArea = Number.isFinite(n) && ui.safeArea !== null && ui.safeArea !== '' ? Math.min(100, Math.max(90, Math.round(n))) : 100; }
  { const n = +ui.attractMinutes; ui.attractMinutes = Number.isFinite(n) && n >= 1 && n <= 60 ? n : d.attractMinutes; }
  // (beta.12) attract mode's pace (how long each box stays) and whether it wanders to other shelves
  if (!['slow', 'normal', 'fast'].includes(ui.attractPace)) ui.attractPace = 'normal';
  // (beta.12) Details' trailer box volume, 0-1 (its sound is turned on there each time)
  { const n = +ui.trailerVol; ui.trailerVol = Number.isFinite(n) && n >= 0 && n <= 1 && ui.trailerVol !== null && ui.trailerVol !== '' ? n : .7; }
  if (typeof ui.attractWander !== 'boolean') ui.attractWander = true;
  { const n = +ui.dimMinutes; ui.dimMinutes = [0, 10, 20, 30].includes(n) && ui.dimMinutes !== null && ui.dimMinutes !== '' ? n : 0; }
  // numbers the sliders and the zoom use directly (a string or null here showed NaN% and played at the wrong level)
  { const n = +ui.uiScale; ui.uiScale = [1, 1.15, 1.3].includes(n) ? n : 1; }
  // Switch 2: the build each game was last started in ({ 'sw2:<file>': exe }), offered first at the next Play
  // the Wii remote (Settings → Controller): on unless turned off, held upright or sideways, pointer speed .8–3
  if ('wiimote' in ui && typeof ui.wiimote !== 'boolean') delete ui.wiimote;
  if ('makeBacks' in ui && typeof ui.makeBacks !== 'boolean') delete ui.makeBacks; // (Settings → Box art: made backs, on unless turned off)
  if ('wmHold' in ui && !['upright', 'sideways'].includes(ui.wmHold)) delete ui.wmHold;
  if ('wmSpeed' in ui) { const n = +ui.wmSpeed; if (Number.isFinite(n) && n >= .8 && n <= 3) ui.wmSpeed = Math.round(n * 10) / 10; else delete ui.wmSpeed; }
  if ('sw2Last' in ui) { const o = {}; if (isObj(ui.sw2Last)) for (const [k, v] of Object.entries(ui.sw2Last).slice(-300)) if (typeof v === 'string' && v.length <= 600 && k.length <= 900) o[k] = v; ui.sw2Last = o; }
  for (const [k, lo, hi] of [['volume', 0, 1], ['ambientLevel', 0, .06], ['musicLevel', 0, 1]]) { const n = +ui[k]; ui[k] = typeof ui[k] === 'number' || (typeof ui[k] === 'string' && ui[k].trim() !== '') ? (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d[k]) : d[k]; }
  ui.museumStyle = isObj(ui.museumStyle) ? ui.museumStyle : {};
  if (typeof ui.museumStyle.walkIn !== 'boolean') ui.museumStyle.walkIn = true;
  // the lighting scene (the old moods' ids carry over: gallery is Classic, night Evening, neon Neon night) and the Retro TV's
  // choices: anything unknown is dropped so the room falls back to its default (the Room menu and Settings never show a blank)
  if (ui.museumLight !== undefined && !['gallery', 'daylight', 'night', 'neon', 'spotlit', 'lightsout'].includes(ui.museumLight)) ui.museumLight = 'gallery';
  { const ms = ui.museumStyle, one = { tvStand: ['cart', 'cabinet', 'floor', 'wall'], tvSize: ['s', 'm', 'l'], tvPos: ['left', 'centre', 'right'], tvCh: ['ads', 'trailers', 'recent', 'mix'] };
    for (const [k, list] of Object.entries(one)) if (k in ms && !list.includes(ms[k])) delete ms[k];
    for (const k of ['tv', 'tvMute', 'tvNear', 'tvAnim']) if (k in ms && typeof ms[k] !== 'boolean') delete ms[k];
    for (const k of ['tvVol', 'tvCrt']) if (k in ms) { const n = +ms[k]; if (typeof ms[k] !== 'number' || !Number.isFinite(n)) delete ms[k]; else ms[k] = Math.min(1, Math.max(0, n)); } }
  // the TV guide: favourites (item keys) and the last thing on per channel. Strings only, capped; anything else is dropped
  if ('tvFavs' in ui) { const seen = new Set(); ui.tvFavs = (Array.isArray(ui.tvFavs) ? ui.tvFavs : []).filter(v => typeof v === 'string' && v && v.length <= 600 && !seen.has(v) && seen.add(v)).slice(0, 500); }
  if ('tvLast' in ui) { const t = isObj(ui.tvLast) ? ui.tvLast : {}, o = {}; for (const k of ['ads', 'trailers', 'recent', 'mix']) if (typeof t[k] === 'string' && t[k] && t[k].length <= 600) o[k] = t[k]; ui.tvLast = o; }
  { const seen = new Set(), out = []; for (const v of Array.isArray(ui.hidden) ? ui.hidden : []) { if (typeof v !== 'string' && typeof v !== 'number') continue; const s = String(v).slice(0, 2048); if (!s || seen.has(s)) continue; seen.add(s); out.push(s); if (out.length >= 5000) break; } ui.hidden = out; }
  if (isObj(cfg.steam) && typeof cfg.steam.hideTools !== 'boolean') cfg.steam.hideTools = true;
  cfg.art = sanitizeArt(cfg.art, ui);
  return cfg;
}

// ---------- Art Studio (shared with main/artstudio.js) ----------
const ART = { PARTS: ['front', 'back', 'spine', 'disc'], LOOKS: ['authentic', 'hd', 'region:usa', 'region:eur', 'region:jpn', 'special'], PRESETS: ['authentic', 'hd', 'region', 'special', 'sets', 'mix'], REGIONS: ['usa', 'eur', 'jpn'] };
// The style a console has before anyone picks one: 'authentic', in the region the old "Box art region" chose (auto → usa).
// sharper: the old "Prefer HD scans" (on unless switched off, as Settings showed it) stays a tie-breaker inside authentic.
// regionFirst: an explicit old region choice keeps beating each game's own region, as it did before.
function defaultArtStyle(ui) {
  ui = isObj(ui) ? ui : {}; const r = ART.REGIONS.includes(ui.artRegion) ? ui.artRegion : '';
  const s = { preset: 'authentic', region: r || 'usa', parts: {}, sharper: ui.artHD !== false }; if (r) s.regionFirst = true; return s;
}
// a part's look in a style: an Art Studio look, or 'region' (= the style's own region); anything else means "not set"
const partLook = v => ART.LOOKS.includes(v) || v === 'region' ? v : null;
function cleanArtStyle(s, base) {
  base = base || defaultArtStyle({}); if (!isObj(s)) return { ...base, parts: { ...base.parts } };
  const out = { preset: ART.PRESETS.includes(s.preset) ? s.preset : base.preset, region: ART.REGIONS.includes(s.region) ? s.region : base.region, parts: {} };
  if (isObj(s.parts)) for (const p of ART.PARTS) { const l = partLook(s.parts[p]); if (l) out.parts[p] = l; }
  const sh = typeof s.sharper === 'boolean' ? s.sharper : base.sharper; if (typeof sh === 'boolean') out.sharper = sh;
  if (typeof s.regionFirst === 'boolean' ? s.regionFirst : (base.regionFirst && out.region === base.region)) out.regionFirst = true;
  if (out.preset === 'sets' && s.setsHd === true) out.setsHd = true; // Complete sets (1.72): the HD sets rather than one region's
  return out;
}
const LOCK_LOOKS = new Set([...ART.LOOKS, 'exact']);
function sanitizeArt(a, ui) {
  a = isObj(a) ? a : {}; const styles = {}, locks = {}, ids = new Set(CONSOLES.map(c => c.id));
  if (isObj(a.styles)) for (const [id, s] of Object.entries(a.styles)) if (ids.has(id) && isObj(s)) styles[id] = cleanArtStyle(s, defaultArtStyle(ui));
  let n = 0;
  if (isObj(a.locks)) for (const [k, v] of Object.entries(a.locks)) {
    if (n >= 20000) break; if (typeof k !== 'string' || k.length > 4200 || !/^[a-z0-9]+\|./.test(k) || !isObj(v)) continue;
    const e = {}; for (const p of ART.PARTS) { const l = v[p]; if (!isObj(l) || !LOCK_LOOKS.has(l.look)) continue; e[p] = { look: l.look }; if (typeof l.key === 'string' && l.key && l.key.length <= 64) e[p].key = l.key; if (Number.isFinite(+l.at) && +l.at > 0) e[p].at = +l.at; } // (a part entry is a pick since 1.73, not a lock: only `all` locks)
    // all: the whole game locked as it was (at: when; sig: the look each part followed then, so unlocking re-picks only what differs)
    if (isObj(v.all)) { const sig = {}; if (isObj(v.all.sig)) for (const p of ART.PARTS) if (typeof v.all.sig[p] === 'string' && v.all.sig[p].length <= 120) sig[p] = v.all.sig[p]; e.all = { at: Number.isFinite(+v.all.at) ? +v.all.at : 0, sig }; }
    if (Object.keys(e).length) { locks[k] = e; n++; }
  }
  return { styles, locks };
}

// settings coming back from the screen: same shape rules as a loaded file (a missing or broken section gets its defaults)
function normalize(c) { if (!isObj(c)) throw new Error('Not a settings object.'); return sanitize(merge(defaults(), c)); }

module.exports = { init, useFile, load, save, flush, defaults, normalize, sanitize, GAME_STATUS, file: () => FILE, blocked: () => readBlocked, ART, defaultArtStyle, cleanArtStyle, sanitizeArt };
