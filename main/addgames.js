// (beta.7) Add games: many PC games at once (Settings → Custom games → Add games).
//   scanFolder(root): a folder of games (D:\Games): one game per folder in it, its main program picked (the one named like
//     its folder, else the biggest), helpers (uninstallers, redistributables, crash reporters) left out.
//   Playnite (experimental: built from Playnite's documented library layout, not tried against every Playnite version):
//     find() looks for Playnite (installed: %LOCALAPPDATA%\Playnite + its data in %APPDATA%\Playnite; portable: one folder
//     holding Playnite.DesktopApp.exe and library\). read() copies the library's database files to a temp folder (Playnite
//     may be running, and its files are never touched) and reads the copies with Playnite's own LiteDB.dll through
//     PowerShell (paths passed in the environment, never spliced into the script); plan() turns the games into what
//     Boxshelf adds: PC games (a program to start) for the Custom shelf, emulated games as games folders for their
//     console, with counts of what's left out (store games Boxshelf reads itself, hidden ones, ones started by a link).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let log = () => {};
function init(o) { if (o && o.log) log = o.log; }
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const isDir = f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };
const HELPER = /^(unins.*|uninstall.*|setup.*|install.*|vc_?redist.*|dxsetup.*|dotnet.*|crash.*|.*crashhandler.*|.*crashreport.*|.*updater.*|update\.exe|unitycrashhandler.*|ue4prereq.*|ueprereq.*|easyanticheat.*|beservice.*|.*_launcher_setup.*|7z.*|cmd\.exe|notification_helper.*|cefsharp.*|.*webhelper.*|quicksfv.*|dxwebsetup.*|oalinst.*|physx.*)$/i;
const SKIP_DIR = /^(redist|_commonredist|commonredist|directx|vcredist|support|tools?|mods?|saves?|config|logs?|__installer|_redist|prereqs?|dotnet|easyanticheat|battleye)$/i;
const key = s => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, '');
const clean = s => String(s || '').replace(/[_.]+/g, ' ').replace(/\s*[([](gog|repack|www\.[^)\]]*|v?\d[\d.]*[a-z]?)[)\]]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
const GENERIC = /^(bin|binaries|win32|win64|x64|x86|game|release|retail|shipping|windows(noeditor)?|app|exe)$/i;

// the main program of one game's folder: named like the folder wins, then the biggest
function mainExe(dir, depth = 3) {
  const want = key(path.basename(dir)), found = [];
  const walk = (d, left) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && /\.exe$/i.test(e.name) && !HELPER.test(e.name)) { let s = 0; try { s = fs.statSync(p).size; } catch { continue; } found.push({ p, s, k: key(e.name), deep: depth - left }); }
      else if (e.isDirectory() && left > 0 && !SKIP_DIR.test(e.name)) walk(p, left - 1);
    }
  };
  walk(dir, depth);
  if (!found.length) return null;
  const score = x => (x.k && want && (x.k === want ? 3 : want.includes(x.k) || x.k.includes(want) ? 2 : 0)) * 1e12 + x.s - x.deep * 1e6;
  found.sort((a, b) => score(b) - score(a));
  return { exe: found[0].p, others: found.slice(1, 4).map(x => x.p) };
}
// a game's name from its program: the nearest folder that isn't generic ("bin", "x64"…), else the program's own name
function titleFor(exe, root) {
  let d = path.dirname(exe); const stop = root ? path.resolve(root) : null;
  while (d && GENERIC.test(path.basename(d)) && path.dirname(d) !== d && (!stop || path.resolve(path.dirname(d)) !== stop)) d = path.dirname(d);
  const f = clean(path.basename(d));
  return (f && !(stop && path.resolve(d) === stop) ? f : clean(path.basename(exe, path.extname(exe)))) || 'Game';
}
// a folder of games: one per folder in it (a program right in the folder counts as one game too)
function scanFolder(root, limit = 400) {
  if (!isDir(root)) return { root, games: [], error: 'That folder isn\'t there' };
  const games = []; let ents = []; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return { root, games, error: e.code || e.message }; }
  for (const e of ents) {
    if (games.length >= limit) break;
    if (e.isDirectory() && !SKIP_DIR.test(e.name)) { const m = mainExe(path.join(root, e.name)); if (m) games.push({ folder: path.join(root, e.name), title: clean(e.name) || titleFor(m.exe, root), exe: m.exe, others: m.others }); }
  }
  const loose = ents.filter(e => e.isFile() && /\.exe$/i.test(e.name) && !HELPER.test(e.name));
  for (const e of loose) games.push({ folder: root, title: clean(path.basename(e.name, '.exe')), exe: path.join(root, e.name), others: [] });
  games.sort((a, b) => a.title.localeCompare(b.title));
  return { root, games };
}

// ---------- Playnite ----------
const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const localData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
// { app: the folder with Playnite's programs (and LiteDB.dll), library: the folder with games.db } or null
function find(extra) {
  const tryOne = (app, lib) => isFile(path.join(app, 'LiteDB.dll')) && isFile(path.join(lib, 'games.db')) ? { app, library: lib, portable: path.resolve(path.dirname(lib)) === path.resolve(app) } : null;
  const dirs = [extra, path.join(localData(), 'Playnite'), 'C:\\Program Files\\Playnite', 'C:\\Playnite', 'D:\\Playnite', path.join(os.homedir(), 'Playnite')].filter(Boolean);
  for (const d of dirs) { const r = tryOne(d, path.join(d, 'library')) || tryOne(d, path.join(appData(), 'Playnite', 'library')); if (r) return r; }
  return null;
}
const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $env:BS_PN_APP 'LiteDB.dll')
foreach ($f in (Get-ChildItem -LiteralPath $env:BS_PN_COPY -Filter '*.db')) {
  $db = New-Object LiteDB.LiteDatabase ("Filename=" + $f.FullName)
  try { foreach ($c in $db.GetCollectionNames()) { foreach ($d in $db.GetCollection($c).FindAll()) { [Console]::Out.WriteLine($f.BaseName + '|' + $c + '|' + [LiteDB.JsonSerializer]::Serialize($d)) } } }
  finally { $db.Dispose() }
}`;
// the library's documents: { games: [], platforms: [], emulators: [] } (LiteDB's JSON: $guid, $date and $numberLong unwrapped)
function read(found) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Playnite runs on Windows'));
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-playnite-'));
    try { for (const n of ['games.db', 'platforms.db', 'emulators.db']) { const f = path.join(found.library, n); if (isFile(f)) fs.copyFileSync(f, path.join(copy, n)); } }
    catch (e) { fs.rmSync(copy, { recursive: true, force: true }); return reject(new Error('Playnite\'s library couldn\'t be copied (' + (e.code || e.message) + ')')); }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, timeout: 120e3, maxBuffer: 256 << 20, env: { ...process.env, BS_PN_APP: found.app, BS_PN_COPY: copy } }, (err, out, errOut) => {
      fs.rmSync(copy, { recursive: true, force: true });
      if (err) { log('Playnite read failed:', (errOut || err.message).toString().split('\n')[0]); return reject(new Error('Playnite\'s library couldn\'t be read with this Playnite version')); }
      const lib = { games: [], platforms: [], emulators: [] }, unwrap = v => Array.isArray(v) ? v.map(unwrap) : v && typeof v === 'object' ? (v.$guid || v.$date || v.$numberLong || v.$oid ? (v.$guid || v.$date || +v.$numberLong || v.$oid) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]))) : v;
      for (const line of String(out).split(/\r?\n/)) {
        const m = /^([^|]+)\|([^|]+)\|(.*)$/.exec(line); if (!m) continue; let d; try { d = unwrap(JSON.parse(m[3])); } catch { continue; }
        const db = m[1].toLowerCase(); if (db === 'games') lib.games.push(d); else if (db === 'platforms') lib.platforms.push(d); else if (db === 'emulators') lib.emulators.push(d);
      }
      log('Playnite library read:', lib.games.length, 'games,', lib.platforms.length, 'platforms,', lib.emulators.length, 'emulators');
      resolve(lib);
    });
  });
}
// Playnite's platform ids (SpecificationId) to Boxshelf's consoles; a platform without one is matched by its name
const SPEC = { nintendo_gamecube: 'gc', nintendo_wii: 'wii', nintendo_wiiu: 'wiiu', nintendo_switch: 'sw', sony_psp: 'psp', sony_playstation: 'psx', sony_playstation2: 'ps2', sony_playstation3: 'ps3', sony_playstation4: 'ps4', sony_playstation5: 'ps5',
  xbox360: 'x360', nintendo_3ds: 'n3ds', nintendo_nes: 'nes', nintendo_super_nes: 'snes', nintendo_64: 'n64', nintendo_gameboy: 'gb', nintendo_gameboycolor: 'gbc', nintendo_gameboyadvance: 'gba', nintendo_ds: 'nds',
  sega_genesis: 'megadrive', sega_mastersystem: 'mastersystem', sega_gamegear: 'gamegear', sega_dreamcast: 'dreamcast', sega_saturn: 'saturn', nec_turbografx_16: 'pcengine', nec_pcengine: 'pcengine', snk_neogeo_aes: 'neogeo', snk_neogeo: 'neogeo', snk_neogeo_pocket: 'ngpc', snk_neogeo_pocket_color: 'ngpc',
  sega_cd: 'segacd', sega_32x: 'sega32x', atari_2600: 'atari2600', atari_lynx: 'atarilynx', bandai_wonderswan: 'wonderswan', bandai_wonderswan_color: 'wonderswan', pc_dos: 'dos', pc_windows: 'pc', arcade: 'arcade' };
const BY_NAME = [[/gamecube/i, 'gc'], [/wii ?u/i, 'wiiu'], [/\bwii\b/i, 'wii'], [/switch/i, 'sw'], [/\bpsp\b|portable/i, 'psp'], [/playstation 5|ps5/i, 'ps5'], [/playstation 4|ps4/i, 'ps4'], [/playstation 3|ps3/i, 'ps3'], [/playstation 2|ps2/i, 'ps2'], [/playstation|psx|ps1/i, 'psx'],
  [/xbox 360/i, 'x360'], [/3ds/i, 'n3ds'], [/\bds\b/i, 'nds'], [/game ?boy advance|gba/i, 'gba'], [/game ?boy color|gbc/i, 'gbc'], [/game ?boy/i, 'gb'], [/super n|snes|super famicom/i, 'snes'], [/nintendo 64|n64/i, 'n64'], [/\bnes\b|famicom|nintendo entertainment/i, 'nes'],
  [/genesis|mega ?drive/i, 'megadrive'], [/master system/i, 'mastersystem'], [/game ?gear/i, 'gamegear'], [/dreamcast/i, 'dreamcast'], [/saturn/i, 'saturn'], [/turbografx|pc engine/i, 'pcengine'], [/neo ?geo pocket/i, 'ngpc'], [/neo ?geo/i, 'neogeo'], [/sega cd|mega cd/i, 'segacd'], [/32x/i, 'sega32x'],
  [/2600/i, 'atari2600'], [/lynx/i, 'atarilynx'], [/wonderswan/i, 'wonderswan'], [/dos/i, 'dos'], [/arcade|mame/i, 'arcade'], [/windows|\bpc\b/i, 'pc']];
const EMPTY = '00000000-0000-0000-0000-000000000000';
function plan(lib, found) {
  const plat = new Map(lib.platforms.map(p => [String(p.Id || p._id || '').toLowerCase(), p]));
  const sysOf = g => { for (const id of g.PlatformIds || []) { const p = plat.get(String(id).toLowerCase()); if (!p) continue; const s = SPEC[p.SpecificationId] || (BY_NAME.find(([re]) => re.test(p.Name || '')) || [])[1]; if (s) return s; } return null; };
  const vars = (s, g) => String(s || '').replace(/\{InstallDir\}/gi, g.InstallDirectory || '').replace(/\{PlayniteDir\}/gi, found.app).replace(/\{InstallDirName\}/gi, path.win32.basename(g.InstallDirectory || '')).replace(/\//g, '\\');
  const media = v => { if (!v || /^https?:/i.test(v)) return null; const f = path.win32.isAbsolute(v) ? v : path.join(found.library, 'files', ...String(v).split(/[\\/]/)); return isFile(f) ? f : null; };
  const out = { pc: [], consoles: {}, skipped: { store: 0, hidden: 0, link: 0, nothing: 0 }, total: lib.games.length };
  for (const g of lib.games) {
    if (!g || !g.Name) continue;
    if (g.Hidden) { out.skipped.hidden++; continue; }
    const store = g.PluginId && String(g.PluginId).toLowerCase() !== EMPTY;
    const acts = (g.GameActions || []).filter(a => a && (a.IsPlayAction || (g.GameActions || []).length === 1));
    const file = acts.find(a => a.Type === 0 || a.Type === 'File'), emu = acts.find(a => a.Type === 2 || a.Type === 'Emulator'), link = acts.find(a => a.Type === 1 || a.Type === 'URL');
    const sys = sysOf(g);
    if (emu || (sys && sys !== 'pc' && (g.Roms || []).length)) {
      const rom = (g.Roms || [])[0]; const p = rom && vars(rom.Path, g); if (!p || !sys || sys === 'pc') { out.skipped.nothing++; continue; } // (Playnite's paths are Windows ones: path.win32, the same on the Linux test machine)
      const c = out.consoles[sys] || (out.consoles[sys] = { dirs: [], count: 0, emulatorDir: '' }); c.count++; const d = path.win32.dirname(p); if (!c.dirs.some(x => x.toLowerCase() === d.toLowerCase())) c.dirs.push(d);
      if (!c.emulatorDir && emu && emu.EmulatorId) { const e = lib.emulators.find(x => String(x.Id || x._id).toLowerCase() === String(emu.EmulatorId).toLowerCase()); if (e && e.InstallDir) c.emulatorDir = vars(e.InstallDir, g); }
      continue;
    }
    if (file && file.Path) {
      if (store) { out.skipped.store++; continue; } // (Steam, GOG Galaxy, Epic…: Boxshelf reads those stores itself)
      const exe = vars(file.Path, g), abs = path.win32.isAbsolute(exe) ? exe : path.win32.join(g.InstallDirectory || '', exe);
      out.pc.push({ key: String(g.Id || g._id || g.Name), title: String(g.Name).slice(0, 120), exe: abs, args: vars(file.Arguments, g).slice(0, 1000), cover: media(g.CoverImage), bg: media(g.BackgroundImage), favorite: !!g.Favorite, there: isFile(abs) });
      continue;
    }
    if (link || store) { out.skipped[store ? 'store' : 'link']++; continue; }
    out.skipped.nothing++;
  }
  out.pc.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

module.exports = { init, scanFolder, mainExe, titleFor, clean, find, read, plan, SPEC, HELPER };
