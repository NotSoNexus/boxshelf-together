// Box art downloader.
//  1. Front covers from the libretro thumbnail library (no account; names match No-Intro file names).
//  2. Backs, spines (and fronts libretro missed) from the LaunchBox Games Database (no account).
// Images are saved next to your games in <games folder>\covers\ as
//   <game file name>.png, <game file name>-back.jpg, <game file name>-spine.jpg
// Existing images are kept, except when HD art finds a sharper scan or the user asks for a kind of art again (redo).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { net } = require('electron');
const https = require('https');
const { scanSystem, scanSystemAsync, cleanTitle } = require('./scanner');
const { isFile, artBase, artDirFor } = require('./paths');

const LIBRETRO = { gc: 'Nintendo - GameCube', wii: 'Nintendo - Wii', psp: 'Sony - PlayStation Portable', wiiu: 'Nintendo - Wii U', sw: 'Nintendo - Switch', ps3: 'Sony - PlayStation 3', ps4: 'Sony - PlayStation 4', ps2: 'Sony - PlayStation 2', x360: 'Microsoft - Xbox 360', n3ds: 'Nintendo - Nintendo 3DS',
  // (beta.6) the retro shelves (folder names checked on thumbnails.libretro.com)
  psx: 'Sony - PlayStation', nes: 'Nintendo - Nintendo Entertainment System', snes: 'Nintendo - Super Nintendo Entertainment System', n64: 'Nintendo - Nintendo 64', gb: 'Nintendo - Game Boy', gbc: 'Nintendo - Game Boy Color', gba: 'Nintendo - Game Boy Advance', nds: 'Nintendo - Nintendo DS', megadrive: 'Sega - Mega Drive - Genesis', mastersystem: 'Sega - Master System - Mark III', gamegear: 'Sega - Game Gear', dreamcast: 'Sega - Dreamcast', saturn: 'Sega - Saturn', pcengine: 'NEC - PC Engine - TurboGrafx 16', neogeo: 'SNK - Neo Geo', arcade: 'FBNeo - Arcade Games', segacd: 'Sega - Mega-CD - Sega CD', sega32x: 'Sega - 32X', atari2600: 'Atari - 2600', atarilynx: 'Atari - Lynx', wonderswan: 'Bandai - WonderSwan', ngpc: 'SNK - Neo Geo Pocket Color', dos: 'DOS' };
const LAUNCHBOX = { gc: 'Nintendo GameCube', wii: 'Nintendo Wii', psp: 'Sony PSP', wiiu: 'Nintendo Wii U', sw: 'Nintendo Switch', sw2: 'Nintendo Switch 2', ps3: 'Sony Playstation 3', ps4: 'Sony Playstation 4', ps5: 'Sony Playstation 5', ps2: 'Sony Playstation 2', x360: 'Microsoft Xbox 360', n3ds: 'Nintendo 3DS',
  // (beta.6) the retro shelves: LaunchBox's own platform names (the index rebuilds once to take them in)
  psx: 'Sony Playstation', nes: 'Nintendo Entertainment System', snes: 'Super Nintendo Entertainment System', n64: 'Nintendo 64', gb: 'Nintendo Game Boy', gbc: 'Nintendo Game Boy Color', gba: 'Nintendo Game Boy Advance', nds: 'Nintendo DS', megadrive: 'Sega Genesis', mastersystem: 'Sega Master System', gamegear: 'Sega Game Gear', dreamcast: 'Sega Dreamcast', saturn: 'Sega Saturn', pcengine: 'NEC TurboGrafx-16', neogeo: 'SNK Neo Geo AES', arcade: 'Arcade', segacd: 'Sega CD', sega32x: 'Sega 32X', atari2600: 'Atari 2600', atarilynx: 'Atari Lynx', wonderswan: 'WonderSwan', ngpc: 'SNK Neo Geo Pocket Color', dos: 'MS-DOS' };
const IDX_V = 8; // 8: full box wraps (Box - Full) indexed too, to cut spines from
const LB_ZIP = 'https://gamesdb.launchbox-app.com/Metadata.zip';
const LB_IMG = 'https://images.launchbox-app.com/';
const ART_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const IDX_DAYS = 60; // the XML is deleted once indexed, so a rebuild means the ~110 MB download again: don't do that every fortnight
// one descriptive User-Agent for every request from here (GameTDB and the others like to know who's calling)
const UA = `Boxshelf/${(() => { try { return require('../package.json').version; } catch { return '0'; } })()}`;
const REGION_PREF = ['North America', 'United States', 'World', '', 'Canada', 'Europe', 'United Kingdom', 'Japan'];

// Settings → Box art region (cfg.ui.artRegion): 'usa' | 'eur' | 'jpn' puts that region's scans first wherever a game
// has several; 'auto' (or anything else) keeps the order below (the game's own region / North America first)
const ART_REGIONS = {
  usa: { lb: /^(north america|united states|usa|canada)$/i, lr: /\((?:[^)]*[ ,])?(USA|U\.S\.A\.|Canada|North America)(?:[ ,][^)]*)?\)/i, tdb: ['US'] },
  eur: { lb: /^(europe|pal|united kingdom|uk|germany|france|spain|italy|netherlands|sweden|australia|scandinavia|oceania)$/i, lr: /\((?:[^)]*[ ,])?(Europe|UK|PAL|Germany|France|Spain|Italy|Netherlands|Sweden|Australia|Scandinavia)(?:[ ,][^)]*)?\)/i, tdb: ['EN', 'FR', 'DE', 'ES', 'IT', 'NL', 'AU'] },
  jpn: { lb: /^(japan)$/i, lr: /\((?:[^)]*[ ,])?(Japan)(?:[ ,][^)]*)?\)/i, tdb: ['JA'] }
};
const artRegion = r => Object.prototype.hasOwnProperty.call(ART_REGIONS, r) ? ART_REGIONS[r] : null;
// stable: keeps each group's own order, the wanted region's entries first
const regionFirst = (list, test) => { const a = [], b = []; for (const x of list) (test(x) ? a : b).push(x); return a.concat(b); };

let cacheDir = null, spineCutter = null;
let log = () => {};
// cutter(file, systemId) -> JPEG Buffer of the spine strip of a full box wrap (back | spine | front), or null
function setSpineCutter(fn) { spineCutter = fn; }
const gametdb = require('./gametdb'); // Switch / 3DS full covers by title (GameCube / Wii: by disc id, below)
// consoles whose games come on a cartridge (their "disc" part is the cartridge), and the maker that draws one from the cover
const CART_SYS = new Set(['sw', 'sw2', 'n3ds']); let cartMaker = null;
function setCartMaker(fn) { cartMaker = fn; }
async function makeCart(front, sysId) { if (!cartMaker || !CART_SYS.has(sysId) || !isFile(front)) return null; try { const b = await cartMaker(front, sysId); return b && b.length > 2000 ? b : null; } catch (e) { log('cartridge from cover', e.message); return null; } }
function init(dataDir, logger) {
  if (logger) log = logger;
  cacheDir = path.join(dataDir, 'boxart-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  gametdb.init({ dir: cacheDir, log, download: (u, d) => download(u, d, { zip: true }), norm }); // (beta.10: its databases are zips, not pictures)
  try { require('./wikiart').init({ dir: cacheDir, log, norm }); } catch (e) { log('Mario Wiki art unavailable', e.message); }
  { const t = setTimeout(() => { if (isFile(path.join(cacheDir, 'launchbox-index.json')) && !shardMeta()) splitShards(); }, 25000); if (t.unref) t.unref(); } // an older single-file index: split it in the background, before anything needs it
  // Earlier versions used data\\cache, which Chromium also uses. Move a finished download over.
  const old = path.join(dataDir, 'cache');
  for (const f of ['Metadata.xml', 'libretro-gc.json', 'libretro-wii.json', 'libretro-psp.json', 'libretro-sw.json']) {
    try { if (isFile(path.join(old, f)) && !isFile(path.join(cacheDir, f))) fs.renameSync(path.join(old, f), path.join(cacheDir, f)); } catch {}
  }
  try { fs.unlinkSync(path.join(old, 'Metadata.zip')); } catch {}
}

// ---------- GameTDB full covers (GameCube / Wii) ----------
// The 6-character game id at the start of the disc header: plain images (.iso/.gcm/NKit), RVZ/WIA keep a copy of the
// header at 0x58, CISO stores the disc from 0x8000, WBFS from 0x200. GCZ is compressed throughout: no id.
function discId(file) {
  let fd; try {
    fd = fs.openSync(file, 'r'); const h = Buffer.alloc(0x8010); const n = fs.readSync(fd, h, 0, h.length, 0);
    const at = o => o + 6 <= n ? h.toString('latin1', o, o + 6) : '';
    const magic = h.toString('latin1', 0, 4);
    const id = magic === 'RVZ\x01' || magic === 'WIA\x01' ? at(0x58) : magic === 'CISO' ? at(0x8000) : magic === 'WBFS' ? at(0x200) : at(0);
    return /^[A-Z0-9]{6}$/.test(id) && /^[GDRS]/.test(id) ? id : null;
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}
const TDB_REGIONS = { E: ['US'], N: ['US'], J: ['JA'], K: ['KO'], P: ['EN', 'FR', 'DE', 'ES', 'IT', 'NL'], D: ['DE', 'EN'], F: ['FR', 'EN'], S: ['ES', 'EN'], I: ['IT', 'EN'], H: ['NL', 'EN'], U: ['EN', 'AU'], X: ['EN', 'US'], Y: ['EN', 'US'], Z: ['EN', 'US'] };
const tdbRegions = (id, region) => { const pref = artRegion(region), own = TDB_REGIONS[id[3]] || ['US', 'EN'];
  // a region chosen in Settings goes first only where the disc was sold there too (GameTDB keys scans by disc id)
  return [...(pref ? pref.tdb.filter(r => own.includes(r)) : []), ...own, 'US', 'EN'].filter((r, i, a) => a.indexOf(r) === i); };
async function gametdbSpine(sysId, file, dir, base, old, region) {
  const id = discId(file); if (!id) return false;
  for (const r of tdbRegions(id, region)) for (const kind of ['coverfullHQ', 'coverfull']) {
    const tmp = path.join(cacheDir, `.tdb-${process.pid}-${id}-${r}-${kind}.png`), inc = path.join(dir, `${base}-spine.incoming-tdb.jpg`);
    try {
      if (!await download(`https://art.gametdb.com/wii/${kind}/${r}/${id}.png`, tmp)) continue;
      const buf = await spineCutter(tmp, sysId);
      if (buf && buf.length > 1500) { await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(inc, buf); // (beta.10: async, art on a NAS)
        if (old) { const a = await sizeOfAsync(old), b = await sizeOfAsync(inc); if (!b || (a && Math.max(...b) < Math.max(...a) * 1.15)) { await fs.promises.unlink(inc).catch(() => {}); continue; } }
        await placeArt(dir, base, '-spine', inc, '.jpg'); log('Spine from GameTDB', id, r, kind, path.basename(file)); return true; }
    } catch (e) { log('GameTDB spine', id, e.message); try { fs.unlinkSync(inc); } catch {} }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  return false;
}

// ---------- putting a picture in place (never deleting one) ----------
// The new picture is already on disk (src, a temp name the scanner ignores, in the same folder). Every older picture of
// that kind (<base><suffix>.png/.jpg/…) moves to replaced\ as "<base><suffix> (<stamp>).<ext>", then src is renamed in.
// If any step fails the moved ones go back, so a game is never left without its picture. Returns { dest, moved }.
const REPLACED = 'replaced';
const artStamp = () => new Date().toISOString().slice(0, 23).replace(/[:T.]/g, '-');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
// every picture Boxshelf puts in place is reported here (main/artstudio.js keeps the record): what Boxshelf wrote vs a picture
// the user put in the folder by hand, which nothing automatic may replace. origin: 'auto' (a cover download), 'studio',
// 'own' (a picture the user chose), 'restored' (Undo / an earlier one)
let onPlaced = null;
function setOnPlaced(fn) { onPlaced = typeof fn === 'function' ? fn : null; }
async function placeArt(dir, base, suffix, src, ext, origin = 'auto') {
  const dest = path.join(dir, base + suffix + ext), old = path.join(dir, REPLACED), moved = [], st = artStamp();
  try {
    for (const e of EXT_FORMS) { // (beta.10: "Game.PNG" too, which is another file on Linux; on Windows the same one, already moved)
      const f = path.join(dir, `${base}${suffix}.${e}`); if (!await isFileA(f) || samePath(f, src)) continue; // (beta.10: async checks, art on a NAS)
      let to = path.join(old, `${base}${suffix} (${st}).${e}`); for (let i = 2; await existsA(to); i++) to = path.join(old, `${base}${suffix} (${st}-${i}).${e}`); // two in one millisecond: never over an earlier one
      await fs.promises.mkdir(old, { recursive: true }); await fs.promises.rename(f, to); moved.push([f, to]);
    }
    if (!samePath(src, dest)) await fs.promises.rename(src, dest);
  } catch (e) { for (const [f, to] of moved.reverse()) await fs.promises.rename(to, f).catch(() => {}); throw e; }
  const now = new Date(); try { await fs.promises.utimes(dest, now, now); } catch {} // a fresh date: cached shelf thumbnails of the old one aren't reused
  for (const t of live) if (t.ls) t.ls.placed(dir, dest, moved.map(m => m[0])); // (beta.10) a running art download's folder listings see it
  if (onPlaced) { try { onPlaced(dest, origin); } catch {} }
  // replaced\ never loses a picture (the user's own covers end up here too). It holds each distinct picture once: when the
  // file just moved there has a byte-identical older copy (restyling back and forth, the same pick twice), the older copy
  // goes, so the stamps keep saying what was in use most recently (Undo restores the newest)
  if (moved.length) { let names = null; try { names = await fs.promises.readdir(path.join(dir, REPLACED)); } catch {} // (beta.10: listed async)
    const others = replacedFor(dir, base, suffix, names || []).filter(r => !moved.some(m => samePath(m[1], r.file)));
    for (const [, to] of moved) { const twin = await identicalIn(to, others); if (twin) await fs.promises.unlink(twin).catch(() => {}); } }
  return { dest, moved: moved.map(m => m[1]) };
}
// the file in list (replaced\ entries) with exactly the bytes of f, or null
async function identicalIn(f, list) {
  let st; try { st = await fs.promises.stat(f); } catch { return null; } let buf = null;
  for (const r of list) { let s2; try { s2 = await fs.promises.stat(r.file); } catch { continue; } if (s2.size !== st.size) continue;
    try { if (!buf) buf = await fs.promises.readFile(f); if (buf.equals(await fs.promises.readFile(r.file))) return r.file; } catch {} }
  return null;
}
// the pictures replaced\ holds for one kind of one game, newest first: [{ file, stamp }]
function replacedFor(dir, base, suffix, listed) { // listed: replaced\'s names, already read (placeArt)
  const pre = (base + suffix + ' (').toLowerCase(), out = [];
  let names = listed || []; if (!listed) try { names = fs.readdirSync(path.join(dir, REPLACED)); } catch { return out; }
  for (const n of names) { if (!n.toLowerCase().startsWith(pre)) continue; const m = /^(\d{4}(?:-\d+){6}(?:-\d+)?)\)\.(png|jpe?g|webp)$/i.exec(n.slice(pre.length)); if (m) out.push({ file: path.join(dir, REPLACED, n), stamp: m[1] }); }
  const k = s => s.stamp.split('-').map(x => x.padStart(4, '0')).join('-'); // "-2" (same millisecond) sorts after the plain one
  return out.sort((a, b) => k(b) < k(a) ? -1 : k(b) > k(a) ? 1 : 0);
}

// ---------- helpers ----------
const { norm, tag, buildLaunchboxIndex, buildInWorker, splitInWorker, writeShards: writeShardFiles, shardName: shardFile } = require('./lbindex');
const libretroSafe = s => s.replace(/[&*/:`<>?\\|"]/g, '_');

async function getText(url) {
  const r = await net.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000), cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}
// → 'ok' | 'missing' (404 / not a picture: it isn't there) | 'busy' (5xx / 429 twice: try another day). A timeout or a dropped
// connection, or a 5xx, is tried once more after a moment; a second network error throws (offline), as download() always did
async function downloadEx(url, dest, opt) { // opt.zip (beta.10): a .zip is wanted (GameTDB's databases), not a picture
  for (let i = 0; ; i++) {
    let r; try { r = await net.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000), cache: 'no-store' }); } // saved to the covers folder: no second copy in Chromium's cache
    catch (e) { if (i === 0) { await new Promise(z => setTimeout(z, 1200)); continue; } throw e; }
    if (r.ok) { const s = await saveBody(r, dest, !!(opt && opt.zip)); return s === true ? 'ok' : s === 'notimage' ? 'busy' : 'missing'; }
    if (r.status >= 500 || r.status === 429) { if (i === 0) { await new Promise(z => setTimeout(z, 1200)); continue; } return 'busy'; }
    return r.status === 404 || r.status === 410 ? 'missing' : 'busy'; // (a 403 / 401 is often a CDN's passing block: not remembered as "not there")
  }
}
async function download(url, dest, opt) { return (await downloadEx(url, dest, opt)) === 'ok'; }
const { isImageBuf } = require('./imgcheck'); // (beta.8) PNG, JPEG, WebP, GIF, BMP or AVIF/HEIF by its first bytes (beta.10: shared with stremio / archive / pccovers)
async function saveBody(r, dest, zip) {
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1024) return false; // not a real image
  // (beta.8) a 200 that isn't a picture (a Wi-Fi sign-in page, a CDN error page) is never saved as the cover: art that's
  // there is never fetched again, so it would stay broken. Asked again later. (beta.10) zip: a zip's own first bytes instead
  // (GameTDB's switchtdb.zip / 3dstdb.zip were turned down as "not a picture" every day since beta.8)
  if (zip ? buf.readUInt32LE(0) !== 0x04034b50 : !isImageBuf(buf)) return 'notimage';
  await fs.promises.mkdir(path.dirname(dest), { recursive: true }); // (beta.10: async, art on a NAS held the app up)
  try { await fs.promises.writeFile(dest + '.part', buf); await fs.promises.rename(dest + '.part', dest); } catch (e) { await fs.promises.unlink(dest + '.part').catch(() => {}); throw e; } // disk full: no half-written .part left in the covers folder
  return true;
}
function hasArt(dir, base, suffix) {
  return ART_EXT.some(e => isFile(path.join(dir, `${base}${suffix}.${e}`)) || (process.platform === 'linux' && isFile(path.join(dir, `${base}${suffix}.${e.toUpperCase()}`))));
}
const isFileA = p => fs.promises.stat(p).then(s => s.isFile(), () => false), existsA = p => fs.promises.access(p).then(() => true, () => false);
// (beta.10) a download run's art folders, one listing each (a few thousand games on a NAS were up to 16 file checks each,
// on the main process). What the run puts in place, and any placeArt while it runs (the Art Studio's too), goes into them
const CI_FS = process.platform === 'win32' || process.platform === 'darwin', nk = n => CI_FS ? n.toLowerCase() : n;
function artLister() {
  const m = new Map(), key = d => nk(path.resolve(d));
  return {
    // (beta.10) name as compared → the file's real name (a case-sensitive folder: "Game.PNG" is found as it really is)
    get(dir) { const k = key(dir); let p = m.get(k); if (!p) { p = fs.promises.readdir(dir).then(ns => new Map(ns.map(n => [nk(n), n])), () => new Map()); m.set(k, p); } return p; },
    placed(dir, add, gone) { const k = key(dir), p = m.get(k); if (p) m.set(k, p.then(s => { for (const f of gone) s.delete(nk(path.basename(f))); s.set(nk(path.basename(add)), path.basename(add)); return s; })); }
  };
}
// artFile, from the run's listing: the same file (the first type found, named as artFile names it)
// (beta.10) the type in either case: on Linux "Game.PNG" isn't "Game.png", and the scanner (which ignores case) shows it, so
// a low-res one named that way was never found here and never replaced by a sharper one
const EXT_FORMS = ART_EXT.flatMap(e => [e, e.toUpperCase()]);
async function artFileA(ls, dir, base, suffix) { const s = await ls.get(dir); for (const e of EXT_FORMS) { const real = s.get(nk(`${base}${suffix}.${e}`)); if (real) return path.join(dir, real); } return null; }
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } });
  await Promise.all(workers);
}

// ---------- libretro ----------
const lrFlight = new Map(); // one fetch of a console's list at a time (the picker, a restyle and auto-fetch can all ask at once)
function libretroIndex(sysId) { if (lrFlight.has(sysId)) return lrFlight.get(sysId); const p = libretroIndex0(sysId).finally(() => lrFlight.delete(sysId)); lrFlight.set(sysId, p); return p; }
async function libretroIndex0(sysId) {
  const sys = LIBRETRO[sysId];
  if (!sys) return null;
  const file = path.join(cacheDir, `libretro-${sysId}.json`);
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (Date.now() - c.at < 7 * 864e5) return c.names; } catch {}
  let html;
  try { html = await getText(`https://thumbnails.libretro.com/${encodeURIComponent(sys)}/Named_Boxarts/`); } catch { return null; }
  const names = [];
  const re = /href="([^"]+?\.png)"/gi; let m;
  while ((m = re.exec(html))) { try { names.push(decodeURIComponent(m[1]).replace(/\.png$/i, '')); } catch {} }
  if (names.length) fs.writeFileSync(file, JSON.stringify({ at: Date.now(), names })); // an empty page (layout change, error page) isn't worth remembering for a week
  return names;
}
const normCache = new WeakMap(); // names array -> Map(normalised title -> [names])
function libretroMatch(names, game, region) {
  if (!names || !names.length) return null;
  const base = artBase(game.file), pref = artRegion(region);
  const set = new Set(names);
  for (const c of [base, libretroSafe(base)]) if (set.has(c) && (!pref || pref.lr.test(c))) return c;
  // Fuzzy: same clean title, prefer the same region. Normalised once per list, not once per game.
  let idx = normCache.get(names);
  if (!idx) { idx = new Map(); for (const n of names) { const k = norm(cleanTitle(n + '.png').title); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(n); } normCache.set(names, idx); }
  let hits = []; for (const t of lookupNames(game.title)) { hits = idx.get(norm(t)) || []; if (hits.length) break; } // (its other names: exact only)
  if (!hits.length) { for (const c of [base, libretroSafe(base)]) if (set.has(c)) return c; return null; }
  if (pref) { const h = hits.find(x => pref.lr.test(x)); if (h) return h; for (const c of [base, libretroSafe(base)]) if (set.has(c)) return c; } // no scan for that region: the file's own, as before
  const reg = (game.region || 'USA').toLowerCase();
  return hits.find(h => h.toLowerCase().includes(`(${reg}`)) || hits.find(h => /\(usa/i.test(h)) || hits[0];
}

// Streams a large file to disk with progress (follows redirects). Whole download (all hops) must finish by `until`;
// on any failure the half-written .part file is removed.
// signal (1.71, Refresh art database): aborting it stops the download and removes the partial file
function downloadFile(url, dest, onPct, hops = 0, until = Date.now() + 10 * 60e3, signal = null) {
  return new Promise((resolve, reject) => {
    const part = dest + '.part'; let out = null, settled = false;
    const onAbort = () => fail(cancelled());
    const fail = e => {
      if (settled) return; settled = true; clearTimeout(hard); if (signal) signal.removeEventListener('abort', onAbort); try { req.destroy(); } catch {}
      if (out) { const rm = () => fs.unlink(part, () => {}); if (out.closed) rm(); else { out.once('close', rm); out.destroy(); } } // Windows can't delete it while it's open
      reject(e);
    };
    const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume(); settled = true; clearTimeout(hard); if (signal) signal.removeEventListener('abort', onAbort);
        return resolve(downloadFile(new URL(res.headers.location, url).toString(), dest, onPct, hops + 1, until, signal));
      }
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`LaunchBox database: HTTP ${res.statusCode}`)); }
      const total = +res.headers['content-length'] || 0; let got = 0, last = -1;
      out = fs.createWriteStream(part);
      res.on('data', c => { got += c.length; const pct = total ? Math.floor(got / total * 100) : 0; if (pct !== last) { last = pct; onPct(pct, got, total); } }); // (each 1%, with the bytes: the Refresh row shows MB)
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        if (settled) return;
        if (total && got < total) return fail(new Error('LaunchBox database: download cut short'));
        try { fs.renameSync(part, dest); settled = true; clearTimeout(hard); if (signal) signal.removeEventListener('abort', onAbort); resolve(); } catch (e) { fail(e); }
      }));
      out.on('error', fail); res.on('error', fail); res.on('aborted', () => fail(new Error('LaunchBox database: connection lost')));
    });
    const hard = setTimeout(() => fail(new Error('LaunchBox database: download took too long')), Math.max(1, until - Date.now()));
    req.on('error', fail);
    req.setTimeout(60000, () => fail(new Error('LaunchBox database: connection timed out')));
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
}

// ---------- LaunchBox ----------
const cancelled = () => Object.assign(new Error('Refresh cancelled'), { code: 'cancelled' });
// (beta.10) unpacked into a folder of its own and moved in only when complete: a cut-off unpack (the app closed, the disk
// full) left a short Metadata.xml in place, later trusted as a fresh one. A failed unpack leaves nothing behind
function untar(zip, dir, signal) {
  const tmp = path.join(dir, `.unpack-${process.pid}`), from = path.join(tmp, 'Metadata.xml'), clean = () => fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (signal && signal.aborted) return Promise.reject(cancelled()); // (execFile with a signal already aborted never calls back)
  return clean().then(() => fs.promises.mkdir(tmp, { recursive: true })).then(() => untar0(zip, tmp, signal))
    .then(async () => { if (signal && signal.aborted) throw cancelled(); if (!await isFileA(from)) throw new Error("Couldn't unpack the LaunchBox database."); await fs.promises.rename(from, path.join(dir, 'Metadata.xml')); })
    .finally(clean);
}
// a Metadata.xml that's all there (it ends with </LaunchBox>): one cut off before beta.10's temp folder is never read
function xmlWhole(xml) { let fd; try { fd = fs.openSync(xml, 'r'); const n = fs.fstatSync(fd).size, b = Buffer.alloc(Math.min(n, 512)); fs.readSync(fd, b, 0, b.length, n - b.length); return /<\/LaunchBox>\s*$/.test(b.toString('latin1')); } catch { return false; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} } }
function untar0(zip, dir, signal) {
  // (Linux: GNU tar can't read a .zip and there's no PowerShell: bsdtar / unzip / Python, see main/linux.js)
  if (process.platform === 'linux') return require('./linux').unzipAsync(zip, dir, 'Metadata.xml', signal).then(ok => { if (signal && signal.aborted) throw cancelled(); if (!ok) throw new Error("Couldn't unpack LaunchBox's Metadata.zip: install unzip (or bsdtar) and try again."); });
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zip, '-C', dir, 'Metadata.xml'], { windowsHide: true, ...(signal ? { signal } : {}) }, err => {
      if (signal && signal.aborted) return reject(cancelled());
      if (!err) return resolve();
      // paths go in through the environment, never into the command text (PowerShell also ends a '…' string at ‘ ’ ‚ ‛)
      execFile('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:BS_ZIP -DestinationPath $env:BS_DIR -Force'], { windowsHide: true, env: { ...process.env, BS_ZIP: zip, BS_DIR: dir } }, e2 => e2 ? reject(e2) : resolve());
    });
  });
}
// Stream the big XML (500+ MB) and keep only the platforms we use.
// Walks each chunk with a cursor so it stays fast on huge files.
// The index is also kept split by console (launchbox-<platform>.json, a few MB each). Reading the single 45 MB file
// froze the app for most of a second on every art run and whenever new games were scanned; now only the consoles
// being looked at are read. The single file stays as the source (and its date as the version stamp).
const shardName = plat => shardFile(cacheDir, plat), shardMetaFile = () => path.join(cacheDir, 'launchbox-shards.json');
let shardCache = new Map(), shardImages = Object.create(null), dropShardsT = null, splitting = null, splitFailed = false;
function writeShards(idx) { writeShardFiles(idx, cacheDir, idxStamp()); metaMemo = null; }
let metaMemo = null; function shardMeta() { if (metaMemo && Date.now() - metaMemo.t < 10000) return metaMemo.m; const m = shardMeta0(); metaMemo = { t: Date.now(), m }; return m; }
function shardMeta0() { try { const m = JSON.parse(fs.readFileSync(shardMetaFile(), 'utf8')); return m && m.stamp && m.stamp === idxStamp() ? m : null; } catch { return null; } }
// an index from before the split: split it once, on a worker thread. Resolves to the split's details (or null)
function splitShards() {
  if (splitting) return splitting; if (splitFailed) return Promise.resolve(null); // failed once this session: the single file is used as before
  const idxFile = path.join(cacheDir, 'launchbox-index.json'); if (!isFile(idxFile)) return Promise.resolve(null);
  splitting = splitInWorker(idxFile, cacheDir).then(() => { metaMemo = null; log('LaunchBox: index split by console for quicker lookups'); return shardMeta(); }, e => {
    if (!e || !e.workerUnavailable) { splitFailed = true; log('LaunchBox: could not split the index', e && e.message); return null; }
    try { writeShards(JSON.parse(fs.readFileSync(idxFile, 'utf8'))); return shardMeta(); } catch (e2) { splitFailed = true; log('LaunchBox: could not split the index', e2.message); return null; } // no worker threads here: once, on this thread
  }).finally(() => { setTimeout(() => { splitting = null; }, 0); });
  return splitting;
}
function ensureShards() { const m = shardMeta(); if (m || !cacheDir || splitFailed) return m;
  const f = path.join(cacheDir, 'launchbox-index.json'); let size = 0; try { size = fs.statSync(f).size; } catch { return null; }
  if (size < 4e6 && !splitting) { try { writeShards(JSON.parse(fs.readFileSync(f, 'utf8'))); return shardMeta(); } catch { splitFailed = true; return null; } } // small: split right here
  splitShards(); return null; } // not split yet: starts the split and says so (null)
function loadShard(plat) { clearTimeout(dropShardsT); dropShardsT = setTimeout(dropShards, 120000); if (dropShardsT.unref) dropShardsT.unref(); /* let them go two minutes after the last use */ if (shardCache.has(plat)) return shardCache.get(plat); let s = null; try { s = JSON.parse(fs.readFileSync(shardName(plat), 'utf8')); } catch {} if (s && s.images) Object.assign(shardImages, s.images); shardCache.set(plat, s); return s; }
// the game-info maps point into these shards' pictures: they go too, so info is never matched without its screenshots
function dropShards() { shardCache = new Map(); shardImages = Object.create(null); if (infoIdx && infoIdx.lazy) { infoIdx = null; infoMaps = null; infoMemo.clear(); } }
// an index object that reads each console's part only when it's asked for (same shape as the full one)
function lazyIndex(m) { return { v: m.v, at: m.at, games: new Proxy({}, { get: (t, p) => typeof p === 'string' ? ((loadShard(p) || {}).games) : undefined }), get images() { return shardImages; }, lazy: true }; }
// one build at a time: Art Studio's "Build the LaunchBox index" and Download box art now would otherwise both download
// and unpack the same 110 MB Metadata.zip into the same files (the second caller shares the first one's result)
// (beta.10) signal: a download run's Cancel. That caller stops waiting at once (its progress stops too); the build itself
// stops only when every caller that waits on it has cancelled (a caller without a signal always keeps it going)
let lbFlight = null, lbProgress = [], lbWait = null;
function launchboxIndex(progress, signal) {
  if (signal && signal.aborted) return Promise.reject(cancelled());
  if (progress) lbProgress.push(progress);
  if (!lbFlight) { const w = lbWait = { n: 0, ac: new AbortController() }; lbFlight = launchboxIndex0(info => { for (const f of lbProgress) try { f(info); } catch {} }, w.ac.signal).finally(() => { lbFlight = null; lbProgress = []; if (lbWait === w) lbWait = null; }); }
  const w = lbWait; if (!signal || !w) { if (w) w.n = Infinity; return lbFlight; } // (!w: Refresh art database's flight, which keeps going)
  w.n++; const flight = lbFlight;
  return new Promise((res, rej) => {
    const onAbort = () => { const i = lbProgress.indexOf(progress); if (i >= 0) lbProgress.splice(i, 1); if (--w.n <= 0 && !w.ac.signal.aborted) { w.ac.abort(); log('LaunchBox: index build cancelled'); } rej(cancelled()); };
    signal.addEventListener('abort', onAbort, { once: true });
    flight.then(v => { signal.removeEventListener('abort', onAbort); res(v); }, e => { signal.removeEventListener('abort', onAbort); rej(e); });
  });
}
async function launchboxIndex0(progress, signal) {
  const idxFile = path.join(cacheDir, 'launchbox-index.json');
  { const m = shardMeta() || (isFile(idxFile) ? await splitShards() : null);
    if (m && m.v === IDX_V && Date.now() - m.at < IDX_DAYS * 864e5 && Object.values(LAUNCHBOX).every(p => m.plats.includes(p))) { const x = path.join(cacheDir, 'Metadata.xml'); if (isFile(x)) removeXml(x); return lazyIndex(m); } }
  try { const c = JSON.parse(fs.readFileSync(idxFile, 'utf8')); if (c.v === IDX_V && Date.now() - c.at < IDX_DAYS * 864e5 && Object.values(LAUNCHBOX).every(p => Array.isArray(c.games[p]))) { const x = path.join(cacheDir, 'Metadata.xml'); if (isFile(x)) removeXml(x); return c; } if (c.v === IDX_V) log('LaunchBox: index is missing a platform, rebuilding'); else log('LaunchBox: index format changed, rebuilding'); } catch {}
  const zip = path.join(cacheDir, 'Metadata.zip');
  const xml = path.join(cacheDir, 'Metadata.xml');
  if (isFile(xml) && Date.now() - fs.statSync(xml).mtimeMs < 30 * 864e5) { if (xmlWhole(xml)) return finishIndex(xml, idxFile, progress, signal); log('LaunchBox: Metadata.xml is cut off, downloading it again'); } // (beta.10: a cut-off one isn't trusted)
  progress({ stage: 'Downloading the LaunchBox game database (one time, about a minute)…' });
  log('LaunchBox: downloading', LB_ZIP);
  await downloadFile(LB_ZIP, zip, pct => progress({ stage: `Downloading the LaunchBox game database… ${pct}%` }), 0, Date.now() + 10 * 60e3, signal); // (beta.10: a download run's Cancel stops it)
  log('LaunchBox: downloaded', fs.statSync(zip).size, 'bytes, unpacking');
  progress({ stage: 'Unpacking the game database…' });
  try { await untar(zip, cacheDir, signal); } catch (e) { try { fs.unlinkSync(zip); } catch {} throw e; }
  log('LaunchBox: unpacked', isFile(xml) ? fs.statSync(xml).size : 'missing', 'bytes');
  if (!isFile(xml)) throw new Error("Couldn't unpack the LaunchBox database.");
  try { fs.unlinkSync(zip); } catch {}
  return finishIndex(xml, idxFile, progress, signal);
}
// the 500 MB XML is only needed while the index is built; Windows can refuse the delete for a moment after reading
function removeXml(xml) { let n = 0; const go = () => fs.promises.unlink(xml).then(() => log('LaunchBox: removed', path.basename(xml)), e => { if (e.code !== 'ENOENT' && ++n < 6) setTimeout(go, 2000); else if (e.code !== 'ENOENT') log('LaunchBox: could not remove', xml, e.message); }); go(); }
async function finishIndex(xml, idxFile, progress, signal) {
  log('LaunchBox: reading', xml);
  progress({ stage: 'Reading the game database… 0%', phase: 'read', pct: 0 });
  const onPct = pct => progress({ stage: `Reading the game database… ${pct}%`, phase: 'read', pct });
  let counts;
  try { counts = await buildInWorker(xml, idxFile, Object.values(LAUNCHBOX), IDX_V, onPct, signal); }
  catch (e) {
    if (e && e.code === 'cancelled') { removeXml(xml); throw e; } // the index file on disk is still the old one: the worker only renames when done
    // only when there's no worker at all (e.g. inside a packed build) is this thread worth a try: after a worker
    // error (out of memory above all) the same job here would take the whole app down with it
    if (!e || !e.workerUnavailable) throw e;
    log('LaunchBox: index worker unavailable (' + e.message + '), reading here');
    const idx0 = await buildLaunchboxIndex(xml, onPct, Object.values(LAUNCHBOX), IDX_V);
    fs.writeFileSync(idxFile, JSON.stringify(idx0)); counts = Object.entries(idx0.games).map(([k, v]) => `${k}=${v.length}`).join(', ');
  }
  log('LaunchBox: index built', counts);
  removeXml(xml);
  invalidateInfo(); dropShards(); metaMemo = null; splitFailed = false;
  // split by console on a worker thread too: reading the whole ~45 MB index here froze the shelf for a second or more
  progress({ stage: 'Sorting the game database by console…', phase: 'split', pct: 100 });
  const m = await splitShards(); if (m && m.v >= 8) return lazyIndex(m);
  const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')); // (no split: the single file, as before)
  try { writeShards(idx); } catch (e) { log('LaunchBox: could not split the index', e.message); }
  return idx;
}
// Refresh art database (1.71): download Metadata.zip again and rebuild the index even though the one there is fresh, so picture
// types an older index left out (the "- Reconstructed" fronts and backs above all) appear. One build at a time: it waits for
// a build already running (lbFlight, the guard Download box art now and Build the LaunchBox index share), then becomes that
// flight itself, so they wait for it in turn. The old index keeps serving until the new one is written; cancelRefresh()
// stops the download / unpacking / reading and leaves it in place. progress: { phase: download|unpack|read|split, pct, got, total, stage }
let lbForce = null, refreshStop = false;
async function refreshIndex(progress) {
  if (lbOverride) return true; if (!cacheDir) throw new Error('Not ready yet.');
  if (lbForce) { if (progress) lbProgress.push(progress); return lbFlight; }
  refreshStop = false; const send = progress || (() => {});
  while (lbFlight) { send({ phase: 'wait', stage: 'Waiting for the build already running…' }); await lbFlight.catch(() => {}); if (refreshStop) throw cancelled(); }
  if (refreshStop) throw cancelled();
  const ac = lbForce = new AbortController(); if (progress) lbProgress.push(progress);
  lbFlight = refresh0(info => { for (const f of lbProgress) try { f(info); } catch {} }, ac.signal).finally(() => { lbFlight = null; lbProgress = []; lbForce = null; });
  return lbFlight;
}
async function refresh0(progress, signal) {
  const idxFile = path.join(cacheDir, 'launchbox-index.json'), zip = path.join(cacheDir, 'Metadata.zip'), xml = path.join(cacheDir, 'Metadata.xml');
  log('LaunchBox: refreshing the index on request');
  progress({ phase: 'download', pct: 0, got: 0, total: 0, stage: 'Downloading the LaunchBox game database…' });
  await downloadFile(LB_ZIP, zip, (pct, got, total) => progress({ phase: 'download', pct, got, total, stage: `Downloading the LaunchBox game database… ${pct}%` }), 0, Date.now() + 15 * 60e3, signal);
  if (signal.aborted) { try { fs.unlinkSync(zip); } catch {} throw cancelled(); }
  progress({ phase: 'unpack', stage: 'Unpacking the game database…' });
  try { await untar(zip, cacheDir, signal); } finally { try { fs.unlinkSync(zip); } catch {} }
  if (signal.aborted) { if (isFile(xml)) removeXml(xml); throw cancelled(); }
  if (!isFile(xml)) throw new Error("Couldn't unpack the LaunchBox database.");
  const idx = await finishIndex(xml, idxFile, progress, signal);
  progress({ phase: 'split', stage: 'Finishing…' }); metaMemo = null; log('LaunchBox: index refreshed');
  return idx;
}
function cancelRefresh() { refreshStop = true; if (lbForce && !lbForce.signal.aborted) { lbForce.abort(); log('LaunchBox: refresh cancelled'); return true; } return false; }
// what the Refresh row shows: { state, at (built), bytes (the index file) }
function indexInfo() { if (lbOverride) return { state: 'ready', at: lbOverride.at || 0, bytes: 0 }; if (!cacheDir) return { state: 'missing', at: 0, bytes: 0 };
  const f = path.join(cacheDir, 'launchbox-index.json'); let bytes = 0, at = 0; try { const st = fs.statSync(f); bytes = st.size; at = st.mtimeMs; } catch {} const m = shardMeta(); if (m && m.at) at = m.at;
  // (local) plats: how many platforms the index covers, for the LaunchBox page in Settings
  return { state: indexState(), at, bytes, plats: m && Array.isArray(m.plats) ? m.plats.length : 0, busy: !!lbFlight, refreshing: !!lbForce }; }
// the index if it's on disk already (never downloads or builds it: the Art Studio picker must answer at once). An older
// one past its 60 days still serves (better than nothing); null while there is none, or while it's being split
function readyIndex() { if (lbOverride) return lbOverride; if (!cacheDir) return null; const m = ensureShards(); return m && m.v >= 8 ? lazyIndex(m) : null; }
function indexState() { if (lbOverride) return 'ready'; if (!cacheDir) return 'missing'; const m = shardMeta(); return m && m.v >= 8 ? 'ready' : splitting ? 'preparing' : isFile(path.join(cacheDir, 'launchbox-index.json')) ? 'preparing' : 'missing'; }
// The names a game may be listed under, most specific first: its own title, then without edition words a dump or a
// rename added ("… – Nintendo Switch 2 Edition", "Definitive Edition", "+ DLC", "GOTY"). Only the title itself gets the
// close-call matching below; the shorter names must match a listing exactly ("Super Mario Bros. Wonder" alone, never
// "Super Mario Bros." for "Super Mario Bros. Wonder"). Subtitles are never cut: "Fire Emblem" would find another Fire Emblem.
const EDITION_RE = /\s*(?:[-–—:+&]\s*)?\b(?:nintendo switch 2 edition|switch 2 edition|ns2 edition|definitive edition|complete edition|deluxe edition|game of the year(?: edition)?|goty(?: edition)?|dlc|all dlc|with dlc)\b.*$/i;
function lookupNames(title) {
  const out = [], add = t => { t = String(t || '').replace(/[\s\-–—:+&]+$/, '').trim(); if (t && !out.some(x => norm(x) === norm(t))) out.push(t); };
  add(title);
  let t = String(title || '');
  for (let i = 0; i < 3; i++) { const u = t.replace(EDITION_RE, ''); if (u === t || !u.trim()) break; t = u; add(t); }
  return out;
}
// the best entry of list for a title or, when nothing is close, the first of its other names that's listed exactly
function matchName(list, title, art) {
  const names = lookupNames(title); let hit = matchTitle(list, names[0], art);
  for (let i = 1; !hit && i < names.length; i++) hit = matchTitle(list, names[i], art, true);
  return hit;
}
// SteamGridDB's search answers checked the same way (exact: one of a game's other names, see steamgrid.gameId)
const sgMatch = (list, g, exact) => matchTitle(list.map(x => ({ ...x, n: norm(x.name) })), g.title, undefined, !!exact);
function launchboxMatch(idx, sysId, game) {
  const list = idx && idx.games[LAUNCHBOX[sysId]];
  if (!list) return null;
  /* duplicates share a name (a bare user-added "paper mario color splash" next to the real one): take the one with the most box art */
  return matchName(list, game.title, g => ((idx.images && idx.images[g.id]) || []).filter(i => /^(Box - |Disc$)/.test(i.type)).length);
}
// the best entry of list ([{ n: normalised name, … }]) for a title: exact, then the close calls below, else null. art(entry) =
// how much art it has (a tie-breaker; SteamGridDB's matcher gives every entry 1). exactOnly: no close calls.
function matchTitle(list, title, art = () => 1, exactOnly = false) {
  if (!list || !list.length || !title) return null;
  if (/^(dvd|disc|game|image|iso|default)$/i.test(title) || /^xbox 360 game [0-9a-f]{8}$/i.test(title)) return null; // a generic file name matches nothing honestly
  const want = norm(title), tight = want.replace(/ /g, '');
  if (!want) return null;
  const richest = arr => arr.length ? arr.reduce((a, b) => art(b) > art(a) ? b : a) : null;
  const exact = richest(list.filter(g => g.n === want)) || richest(list.filter(g => g.n.replace(/ /g, '') === tight));
  if (exact || exactOnly) return exact;
  // Brand prefixes that dumps carry and the database usually doesn't ("Disney-Pixar Finding Nemo" vs "Finding Nemo")
  const BRAND = /^(disney s|disneys|disney pixar|disney|pixar|nickelodeon|nick|mtv|cartoon network|dreamworks|activision|ea sports|ea|sega|capcom|konami|ubisoft|thq|namco)\s+/;
  const unbrand = x => { let y = x; for (let i = 0; i < 2; i++) y = y.replace(BRAND, ''); return y; };
  const want2 = unbrand(want);
  if (want2 !== want) { const e2 = richest(list.filter(g => g.n === want2 || unbrand(g.n) === want2)); if (e2) return e2; }
  // "A and B" vs "A / B" ("Ocarina of Time & Master Quest")
  const noAnd = want.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (noAnd !== want) { const e3 = richest(list.filter(g => g.n.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim() === noAnd)); if (e3) return e3; }
  // Close calls: one name is the other plus a few words ("Metroid Prime 4 Beyond" vs "Metroid Prime 4: Beyond - Deluxe"), or the same words in a different order.
  const W = new Set(want2.split(' ').filter(Boolean)), wantW = want2.split(' ').filter(Boolean);
  let best = null, bestScore = 0;
  for (const g of list) {
    let score = 0;
    if (g.n.startsWith(want2 + ' ') || want2.startsWith(g.n + ' ')) { const extra = g.n.length > want2.length ? g.n.slice(want2.length) : want2.slice(g.n.length); if (!/\b(\d+|[ivx]+)\b/.test(extra)) score = .9 - Math.abs(g.n.length - want2.length) / 200; } // "Pikmin" must not stand in for "Pikmin 2"
    else { const G = g.n.split(' ').filter(Boolean); if (G.length) { let hit = 0; for (const w of G) if (W.has(w)) hit++; const j = hit / new Set([...W, ...G]).size; if (j >= .75) score = j;
      /* ours is theirs minus a few filler words, in the same order ("Mario and Sonic Rio 2016" = "Mario & Sonic at the Rio 2016 Olympic Games") */
      else if (W.size >= 3) { const extra = G.filter(w => !W.has(w)); let k = 0; for (const w of G) if (k < wantW.length && w === wantW[k]) k++;
        if (k === wantW.length && extra.length <= 3 && !extra.some(w => /^(\d+|[ivx]+)$/.test(w))) score = .8 - extra.length * .03; } } }
    if (score && !art(g)) score -= .05; /* an entry without pictures only wins when nothing else is close */
    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best;
}
// Backs: North American boxes print English/French/Spanish side by side, so English-only regions come first for the back.
const BACK_PREF = ['United Kingdom', 'Australia', 'North America', 'United States', 'World', '', 'Canada', 'Europe', 'Japan'];
function pickImages(imgs, type, region) {
  const c = (imgs || []).filter(i => i.type === type && i.file);
  const pref = /Back/.test(type) ? BACK_PREF : REGION_PREF;
  c.sort((a, b) => { const ra = pref.indexOf(a.region), rb = pref.indexOf(b.region); return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb); });
  const want = artRegion(region);
  return want ? regionFirst(c, i => want.lb.test(String(i.region || '').trim())) : c;
}

// ---------- every version of a part (Art Studio candidates; auto-fetch ranks the same objects) ----------
// (OLD_FALLBACK: auto-fetch's list before Art Studio, still used while a console has no style of its own)
const OLD_FALLBACK = { 'Box - Front': ['Fanart - Box - Front', 'Steam Poster'], 'Box - Back': ['Fanart - Box - Back'], 'Disc': ['Cart - Front', 'Fanart - Cart - Front', 'Fanart - Disc'], 'Box - Spine': [] };
const LB_FALLBACK = { 'Box - Front': ['Box - Front - Reconstructed', 'Fanart - Box - Front', 'Steam Poster'], 'Box - Back': ['Box - Back - Reconstructed', 'Fanart - Box - Back'], 'Disc': ['Cart - Front', 'Fanart - Cart - Front', 'Fanart - Disc'], 'Box - Spine': [] };
// region words of each source → 'usa' | 'eur' | 'jpn' | 'world' | ''
const lbRegion = s => { s = String(s || '').trim(); for (const r of ['usa', 'eur', 'jpn']) if (ART_REGIONS[r].lb.test(s)) return r; return /^world$/i.test(s) ? 'world' : ''; };
const lrRegion = n => { for (const r of ['usa', 'eur', 'jpn']) if (ART_REGIONS[r].lr.test(n)) return r; return /\((?:[^)]*[ ,])?World(?:[ ,][^)]*)?\)/i.test(n) ? 'world' : ''; };
const tdbRegion = r => r === 'US' ? 'usa' : r === 'JA' ? 'jpn' : r === 'KO' ? '' : 'eur';
// Editions, from the release's own words (libretro's "(Player's Choice)" tags, any edition text a source gives)
const REPRINT_RE = /\b(player'?s choice|greatest hits|platinum|nintendo selects|essentials|classics|best price|hits)\b/i;
const SPECIAL_RE = /\b(collector'?s|limited|special|premium|deluxe|steelbook|signature)\b/i;
function edition(text) { const t = String(text || ''); const r = REPRINT_RE.exec(t); if (r) return { edition: 'reprint', name: r[0] }; const s = SPECIAL_RE.exec(t); if (s) return { edition: 'special', name: s[0] }; return { edition: 'original', name: '' }; }
const tagsOf = n => (String(n).match(/\(([^)]*)\)|\[([^\]]*)\]/g) || []).join(' '); // only the bracketed tags: "Mario Kart 8 Deluxe" is a title, not an edition
const REGION_WORD = { usa: 'USA', eur: 'Europe', jpn: 'Japan', world: 'World', '': '' };
const titleCase = s => s.replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/'S\b/g, "'s");
const label = (...bits) => bits.filter(Boolean).join(' · ');
const extOf = f => /^\.(png|jpe?g|webp)$/i.test(path.extname(f)) ? path.extname(f).toLowerCase() : '.jpg';
function lbCand(im) {
  const fan = /^Fanart|^Steam Poster/.test(im.type), recon = /Reconstructed/.test(im.type), region = lbRegion(im.region), ed = edition(im.edition || '');
  const what = im.type === 'Box - Full' ? 'Cut from full box' : fan ? 'Fan art' : recon ? 'Clean rebuild' : /^(Cart|Fanart - Cart)/.test(im.type) ? 'Cartridge' : 'Box scan';
  return { url: LB_IMG + encodeURI(im.file), ext: im.type === 'Box - Full' ? '.jpg' : extOf(im.file), source: 'launchbox', type: im.type, region, regionName: im.region || '', edition: ed.edition,
    kind: recon || fan ? 'clean' : 'scan', fan, cut: im.type === 'Box - Full' ? 'spine' : null, src: im.type === 'Box - Full' ? extOf(im.file) : null, label: label(ed.name ? titleCase(ed.name) : what, REGION_WORD[region] || im.region || '') };
}
function lrCand(sysId, name, game) {
  const ed = edition(tagsOf(name)), region = lrRegion(name), base = game ? artBase(game.file) : '';
  return { url: `https://thumbnails.libretro.com/${encodeURIComponent(LIBRETRO[sysId])}/Named_Boxarts/${encodeURIComponent(name + '.png')}`, ext: '.png', source: 'libretro', type: 'Named_Boxarts', name,
    region, edition: ed.edition, kind: 'clean', exact: !!base && (name === base || name === libretroSafe(base)), label: label(ed.name ? titleCase(ed.name) : 'Clean cover', REGION_WORD[region]) };
}
// every libretro name for this game (all regions and editions), the file's own name first
function libretroAll(names, game) {
  if (!names || !names.length) return [];
  let idx = normCache.get(names);
  if (!idx) { idx = new Map(); for (const n of names) { const k = norm(cleanTitle(n + '.png').title); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(n); } normCache.set(names, idx); }
  const base = artBase(game.file), set = new Set(names), out = [];
  for (const c of [base, libretroSafe(base)]) if (set.has(c) && !out.includes(c)) out.push(c);
  for (const t of lookupNames(game.title)) { const l = idx.get(norm(t)) || []; for (const n of l) if (!out.includes(n)) out.push(n); if (l.length) break; }
  return out;
}
const TDB_SYS = { gc: 'wii', wii: 'wii', wiiu: 'wiiu' }; // GameTDB keeps GameCube under its Wii art
// For one part of one game: [{ url, ext, source, type, region, edition, kind, label, cut? ('spine': cut from a full wrap), exact? }]
// Reads only cached indexes (the LaunchBox index is never built from here: opts.index / readyIndex()); libretro's list
// is fetched once a week and waited for at most opts.lrWait ms.
async function candidates(sysId, game, part, opts = {}) {
  const out = [], idx = opts.index !== undefined ? opts.index : readyIndex();
  if (idx && LAUNCHBOX[sysId]) {
    let g0 = null; try { g0 = launchboxMatch(idx, sysId, game); } catch {}
    if (!g0 && /\s(\+|&|and)\s/i.test(game.title)) { try { g0 = launchboxMatch(idx, sysId, { title: game.title.split(/\s(?:\+|&|and)\s/i)[0] }); } catch {} }
    const imgs = g0 ? (idx.images[g0.id] || []) : [];
    const types = { front: ['Box - Front', ...LB_FALLBACK['Box - Front']], back: ['Box - Back', ...LB_FALLBACK['Box - Back']], spine: ['Box - Spine', ...(spineCutter ? ['Box - Full'] : [])], disc: ['Disc', ...LB_FALLBACK.Disc] }[part] || [];
    for (const t of types) for (const im of imgs) if (im.type === t && im.file) out.push(lbCand(im));
  }
  if (part === 'front' && LIBRETRO[sysId] && opts.libretro !== false) {
    let names = null; const wait = opts.lrWait || 8000; let t;
    try { names = await Promise.race([libretroIndex(sysId), new Promise(r => { t = setTimeout(() => r(null), wait); })]); } catch {} finally { clearTimeout(t); }
    for (const n of libretroAll(names, game)) out.push(lrCand(sysId, n, game));
  }
  const id = TDB_SYS[sysId] && opts.tdb !== false ? (opts.discId !== undefined ? opts.discId : discId(game.file)) : null;
  if (id) {
    const root = `https://art.gametdb.com/${TDB_SYS[sysId]}`, own = TDB_REGIONS[id[3]] || ['US', 'EN'];
    // GameTDB addresses are built, not listed: the disc's own region(s) are real for the cover, full cover and disc; another
    // region, and the clean disc artwork (discM, often missing), are guesses (guess: true). The Art Studio shows a guess only
    // once it has really downloaded, and remembers the ones that 404
    for (const r of tdbRegions(id, opts.region)) {
      const region = tdbRegion(r), rw = REGION_WORD[region] || r, guess = !own.includes(r);
      if (part === 'front') { out.push({ url: `${root}/coverHQ/${r}/${id}.png`, ext: '.png', source: 'gametdb', type: 'coverHQ', region, edition: 'original', kind: 'hd', label: label('HD cover', rw), guess });
        out.push({ url: `${root}/cover/${r}/${id}.png`, ext: '.png', source: 'gametdb', type: 'cover', region, edition: 'original', kind: 'scan', label: label('Cover', rw), guess }); }
      // the back (1.71): the left part of the same full cover scan (back | spine | front), cut by the spine's geometry
      if (part === 'back' && spineCutter) for (const k of ['coverfullHQ', 'coverfull']) out.push({ url: `${root}/${k}/${r}/${id}.png`, ext: '.jpg', src: '.png', source: 'gametdb', type: k, region, edition: 'original', kind: k === 'coverfullHQ' ? 'hd' : 'scan', cut: 'back', label: label("From GameTDB's full cover", rw), guess });
      if (part === 'spine' && spineCutter) for (const k of ['coverfullHQ', 'coverfull']) out.push({ url: `${root}/${k}/${r}/${id}.png`, ext: '.jpg', src: '.png', source: 'gametdb', type: k, region, edition: 'original', kind: k === 'coverfullHQ' ? 'hd' : 'scan', cut: 'spine', label: label('Cut from full cover', rw), guess });
      if (part === 'disc') { out.push({ url: `${root}/disc/${r}/${id}.png`, ext: '.png', source: 'gametdb', type: 'disc', region, edition: 'original', kind: 'scan', label: label('Disc', rw), guess });
        out.push({ url: `${root}/discM/${r}/${id}.png`, ext: '.png', source: 'gametdb', type: 'discM', region, edition: 'original', kind: 'clean', label: label('Disc artwork', rw), guess: true }); }
    }
  }
  // Switch / 3DS: GameTDB's scans found by title (the front, and the back and spine cut from its full cover). Its weekly
  // list is read from disk; the first fetch ever is waited for a few seconds at most (the next opening has it)
  if (gametdb.has(sysId) && opts.tdb !== false && part !== 'disc') {
    let t; const late = new Promise(r => { t = setTimeout(() => r([]), opts.lrWait || 4000); });
    const pref = artRegion(opts.region), fulls = await Promise.race([gametdb.fullCovers(sysId, lookupNames(game.title), pref && pref.tdb ? pref.tdb : []).catch(() => []), late]); clearTimeout(t);
    for (const f of fulls) {
      const region = tdbRegion(f.region), rw = REGION_WORD[region] || f.region, hq = f.kind === 'coverfullHQ';
      if (part === 'front') out.push({ url: f.url.replace('/coverfullHQ/', '/coverHQ/').replace('/coverfull/', '/cover/'), ext: '.jpg', source: 'gametdb', type: hq ? 'coverHQ' : 'cover', region, edition: 'original', kind: hq ? 'hd' : 'scan', label: label(hq ? 'HD cover' : 'Cover', rw) });
      else if (spineCutter) out.push({ url: f.url, ext: '.jpg', src: '.jpg', source: 'gametdb', type: f.kind, region, edition: 'original', kind: hq ? 'hd' : 'scan', cut: part, label: label(part === 'back' ? "From GameTDB's full cover" : 'Cut from full cover', rw) });
    }
  }
  // Switch 2: the Super Mario Wiki's official box scans (Nintendo's own games)
  if ((part === 'front' || part === 'back') && opts.wiki !== false) {
    try { const wa = require('./wikiart'); if (wa.has(sysId)) { const w = await wa.find(sysId, lookupNames(game.title), part, 'usa'); if (w) out.push({ url: w.url, ext: '.' + w.ext, source: 'mariowiki', type: part === 'back' ? 'Box - Back' : 'Box - Front', region: '', edition: 'original', kind: 'scan', label: label('Super Mario Wiki', w.name.replace(/\.[a-z]+$/i, '')) }); } } catch {}
  }
  const seen = new Set(); return out.filter(c => { const k = c.url + '|' + (c.cut || ''); if (seen.has(k)) return false; seen.add(k); return true; }); // same address twice (two fallback types): once
}
// the back panel of a downloaded full wrap / full cover (back | spine | front), or null: the spine's fold search finds where it ends
async function cutBack(file, sysId) { if (!spineCutter) return null; const z = sizeOf(file); if (z && z[0] < z[1] * 1.2) return null; const b = await spineCutter(file, sysId, 'back'); return b && b.length > 3000 ? b : null; }
// a spine strip cut from a downloaded full wrap / full cover, or null (the hidden image window does the work)
async function cutSpine(file, sysId) { if (!spineCutter) return null; const z = sizeOf(file); if (z && z[0] < z[1] * 1.2) return null; /* not a wrap: wider than tall is expected */ const b = await spineCutter(file, sysId); return b && b.length > 1500 ? b : null; }

// ---------- main entry ----------
// What's there already, and how sharp: an image is "low-res" when its longest side is under these (pixels)
const HD_MIN = { front: 900, back: 900, spine: 700, disc: 480 };
const KINDS = [['front', ''], ['back', '-back'], ['spine', '-spine'], ['disc', '-disc']];
const { sizeOf, sizeOfAsync } = require('./spreads');
// cut the spine out of LaunchBox's full box wraps; keep it only if it beats what's there (when replacing)
async function wrapSpine(sysId, imgs, dir, base, old, compare, region) {
  const wraps = pickImages(imgs, 'Box - Full', region).slice(0, 3); if (!wraps.length) return false;
  for (const im of wraps) {
    const tmp = path.join(cacheDir, `.wrap-${process.pid}-${require('crypto').randomUUID()}${path.extname(im.file) || '.jpg'}`);
    try {
      if (!await download(LB_IMG + encodeURI(im.file), tmp)) continue;
      const z = sizeOf(tmp); if (z && z[0] < z[1] * 1.2) continue; // not a wrap (wider than tall is expected)
      const buf = await spineCutter(tmp, sysId); if (!buf || buf.length < 1500) continue;
      const inc = path.join(dir, base + '-spine.incoming.jpg');
      await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(inc, buf); // (beta.10: async, art on a NAS)
      if (old && compare) { const a = await sizeOfAsync(old), b = await sizeOfAsync(inc); if (!b || (a && Math.max(...b) < Math.max(...a) * 1.15)) { await fs.promises.unlink(inc).catch(() => {}); return false; } }
      try { await placeArt(dir, base, '-spine', inc, '.jpg'); } catch (e) { try { fs.unlinkSync(inc); } catch {} throw e; } // the old spine moves to replaced\, never deleted
      log('Spine from LaunchBox wrap', base, z ? z.join('x') : ''); return true;
    } catch (e) { log('wrap spine', e.message); } finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  return false;
}
function artFile(dir, base, suffix) { for (const e of (process.platform === 'linux' ? EXT_FORMS : ART_EXT)) { const f = path.join(dir, `${base}${suffix}.${e}`); if (isFile(f)) return f; } return null; } // (beta.10: Linux, "Game.PNG" too)
function isLow(file, key) { const z = sizeOf(file); return !!z && Math.max(z[0], z[1]) < HD_MIN[key]; } // unknown formats (webp) count as fine
async function isLowA(file, key) { const z = await sizeOfAsync(file); return !!z && Math.max(z[0], z[1]) < HD_MIN[key]; } // (beta.10: the download run's)
// per console: how many games, and for each kind how many have it / how many of those are low-res (header reads only)
// (beta.10) async: the art folders listed once (artLister) instead of up to 16 stats per game, header reads with
// fs.promises, and a breath every 25 ms inside a console (a big library or a NAS held the main process up here)
async function coverage(systems) {
  const out = [], ls = artLister(); let t0 = Date.now();
  for (const { def, cfg } of systems) {
    const games = await scanSystemAsync(def, cfg), r = { id: def.id, name: def.name, total: games.length };
    KINDS.forEach(([k]) => { r[k] = 0; r[k + 'Low'] = 0; });
    for (const g of games) { if (Date.now() - t0 > 25) { await new Promise(res => setImmediate(res)); t0 = Date.now(); }
      const dir = artDirFor(cfg, g.file), base = artBase(g.file);
      for (const [k, suf] of KINDS) { const f = await artFileA(ls, dir, base, suf); if (f) { r[k]++; if (await isLowA(f, k)) r[k + 'Low']++; } } }
    out.push(r);
  }
  return out;
}
let lbOverride = null; // tests hand in an index
// each run has its own cancel flag: a run ending (the background one) never clears a Cancel meant for another
const live = new Set();
function cancel(tag) { for (const t of live) if (!tag || t.tag === tag) { t.c = true; if (t.ac && !t.ac.signal.aborted) t.ac.abort(); } } // (beta.10) tag 'auto': only the background run (the shelf's art card); ac: its wait for the LaunchBox index
// (beta.10) Pause / Resume (the shelf's art card): the games being fetched finish, the next ones wait (Cancel still stops
// a paused run). true when there was a run to pause or resume. Resumed, the run lists its art folders again (pictures
// dropped in while it was paused are seen, never taken for missing and moved to replaced\)
function pause(tag, on) { let n = 0; for (const t of live) if (!tag || t.tag === tag) { if (!on && t.p) t.ls = artLister(); t.p = !!on; n++; } return n > 0; }
// (beta.10) a run (tag 'auto': the background one) is paused right now: main's waiters resume it or don't wait on it
function isPaused(tag) { for (const t of live) if ((!tag || t.tag === tag) && t.p && !t.c) return true; return false; }
const held = async tok => { while (tok.p && !tok.c) await new Promise(r => setTimeout(r, 250)); };
// download into a temp name, keep it only if it's an image and (when replacing) clearly sharper than the old one
async function fetchInto(url, dir, base, suffix, ext, old, compare, origin = 'auto') {
  const tmp = path.join(dir, `${base}${suffix}.incoming${ext}`);
  try {
    if (!await download(url, tmp)) return false;
    if (old && compare) { const a = await sizeOfAsync(old), b = await sizeOfAsync(tmp); if (!b || (a && Math.max(...b) < Math.max(...a) * 1.15)) { await fs.promises.unlink(tmp).catch(() => {}); return 'same'; } }
    await placeArt(dir, base, suffix, tmp, ext, origin); // one picture per kind: the one it replaces (any type) moves to replaced\, never deleted
    return true;
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} log('art download', url, e.message); return false; }
}

// systems: [{def, cfg}]. plan: an array of kinds for every console (['front','back',…], 'redo-<kind>' fetches again),
// or { <systemId>: [kinds] } per console. opts.hd: look for the sharpest scans first and replace low-res pictures.
// progress(info) is called often; cancel() stops after the games in flight.
async function downloadCovers(systems, progress, plan, opts = {}) {
  const tok = { c: false, p: false, tag: opts.tag || '', ls: artLister(), ac: new AbortController() }; live.add(tok); // (beta.10: p paused, tag 'auto' for the background run, ls its art folders' listings, ac aborted by its Cancel)
  try { return await coversRun(systems, progress, plan, opts, tok); } finally { live.delete(tok); }
}
async function coversRun(systems, progress, plan, opts, tok) {
  const hd = !!opts.hd, region = artRegion(opts.region) ? opts.region : 'auto';
  const kindsFor = id => Array.isArray(plan) ? plan : plan && typeof plan === 'object' ? (plan[id] || []) : ['front', 'back', 'spine', 'disc'];
  const report = { systems: [], hd, cancelled: false };
  let lb = null, lbError = null;
  const active = systems.filter(({ def }) => kindsFor(def.id).length);
  for (const { def, cfg } of active) {
    if (tok.c) break;
    await new Promise(r => setImmediate(r)); // (beta.9: a breath between consoles)
    await held(tok); if (tok.c) break; // (beta.10: paused)
    const kinds = kindsFor(def.id), want = k => kinds.includes(k) || kinds.includes('redo-' + k), redo = k => kinds.includes('redo-' + k);
    const scanned = await scanSystemAsync(def, cfg), games = opts.only ? scanned.filter(g => opts.only.has(g.id)) : scanned; // opts.only: just these game ids (beta.10: scanned async)
    const rep = { id: def.id, name: def.name, total: games.length, front: 0, back: 0, spine: 0, disc: 0, upgraded: 0, had: 0, missed: [], missedKinds: {}, got: [], up: [] };
    report.systems.push(rep);
    if (!games.length) continue;
    progress({ system: def.name, systemId: def.id, stage: `Looking up ${def.name} art…`, done: 0, total: games.length });
    const names = want('front') ? await libretroIndex(def.id) : null;
    if (!lb && !lbError) { try { lb = lbOverride || await launchboxIndex(info => { if (!tok.c) progress(info); }, tok.ac.signal); } catch (e) { if (tok.c) break; lbError = e.message; log('LaunchBox ERROR', e.stack || e); } } // (beta.10: Cancel stops the wait for the index)
    await held(tok); if (tok.c) break; // (beta.10) paused while the index was built: wait here, not in the first games
    let done = 0;
    await pool(games, 4, async game => {
      if (tok.c) return; await held(tok); if (tok.c) return; // (beta.10) Pause: the next game waits
      const dir = artDirFor(cfg, game.file), base = artBase(game.file);
      let touched = false, lg, lgDone = false; const missing = [];
      // Switch / 3DS: GameTDB's full cover scan, downloaded once per game for both its back and its spine (deleted after)
      let tdbTmp, tdbDone = false;
      const tdbWrap = async reg => {
        if (tdbDone) return tdbTmp; tdbDone = true; if (!gametdb.has(def.id) || !spineCutter) return null;
        const pref = artRegion(reg), list = await gametdb.fullCovers(def.id, lookupNames(game.title), pref && pref.tdb ? pref.tdb : []);
        for (const c of list) { if (tok.c) break; const tmp = path.join(cacheDir, `.tdbfull-${process.pid}-${require('crypto').randomUUID()}.jpg`);
          if (await download(c.url, tmp)) { const z = sizeOf(tmp); if (z && z[0] >= z[1] * 1.2) { tdbTmp = tmp; log('GameTDB full cover for', game.title, c.id, c.region, c.kind); return tmp; } }
          fs.promises.unlink(tmp).catch(() => {}); }
        return null;
      };
      const lbFor = () => { if (!lgDone) { lgDone = true; lg = lb ? launchboxMatch(lb, def.id, game) : null; } return lg; };
      // Art Studio: the console's shelf style says which look each part follows; parts locked for this game are never touched
      const style = opts.styleFor ? opts.styleFor(def.id) : null, locked = opts.lockedFor ? (opts.lockedFor(def.id, game.file) || {}) : {};
      const lbCands = (type, reg) => {
        const g0 = lbFor(); if (!g0) return [];
        const fb = style ? LB_FALLBACK : OLD_FALLBACK;
        let c = [type, ...(fb[type] || [])].flatMap(t => pickImages(lb.images[g0.id], t, reg));
        // compilations ("Wii Sports + Wii Sports Resort"): borrow from the first game in the bundle
        if (!c.length && /\s(\+|&|and)\s/i.test(game.title)) { const lg2 = launchboxMatch(lb, def.id, { title: game.title.split(/\s(?:\+|&|and)\s/i)[0] }); if (lg2 && lg2 !== g0) c = [type, ...(fb[type] || [])].flatMap(t => pickImages(lb.images[lg2.id], t, reg)); }
        return c.slice(0, 6).map(lbCand);
      };
      try {
        for (const [key, suffix] of KINDS) {
          if (!want(key) || tok.c || locked[key]) continue;
          // one part at a time per game with Art Studio (opts.serial): a pick made there while this part downloads waits, and a
          // part the user picked or locked meanwhile is left alone (it was read before the download started)
          const part = async () => {
          if (opts.lockedFor && (opts.lockedFor(def.id, game.file) || {})[key]) return;
          const look = style ? require('./artstudio').lookFor(style, key) : null;
          // "sharper" (the old Prefer HD scans, kept inside the default style) and the HD look both mean: sharpest first, low-res replaced
          const sharp = hd || look === 'hd' || !!(style && style.sharper && look !== 'special' && !/^region:/.test(look || ''));
          const reg = look ? require('./artstudio').regionForLook(style, look, game) : region;
          const old = await artFileA(tok.ls, dir, base, suffix); // (beta.10: the run's folder listing, not up to 4 file checks)
          // an HD upgrade replaces only a picture Boxshelf may replace (opts.mayReplace: one it downloaded itself, never one the
          // user put there by hand); a redo is the user's own request for that part
          const upgrade = !!old && !redo(key) && sharp && await isLowA(old, key) && (!opts.mayReplace || !!opts.mayReplace(old));
          // a SteamGridDB poster standing in for a front no source had: a real scan replaces it whenever one is found
          const posterOld = key === 'front' && !!old && !redo(key) && !upgrade && !!opts.isPoster && opts.isPoster(old);
          if (old && !redo(key) && !upgrade && !posterOld) return;
          const type = { front: 'Box - Front', back: 'Box - Back', spine: 'Box - Spine', disc: 'Disc' }[key];
          let cands;
          if (look) { // every version the sources have, in the order the look ranks them (the same ranking the Art Studio picker shows)
            const lr = key === 'front' && names ? libretroAll(names, game).map(n => lrCand(def.id, n, game)) : [];
            cands = require('./artstudio').rankList([...lbCands(type, reg), ...lr], look, { style, game, sharp });
          } else {
            const lr = key === 'front' && names ? (() => { const hit = libretroMatch(names, game, region); return hit ? [lrCand(def.id, hit, game)] : []; })() : [];
            // HD: the LaunchBox scans first (usually 1000–2500 px), libretro's smaller thumbnails last; otherwise libretro first (they match file names best)
            cands = key === 'front' ? (hd ? [...lbCands(type, reg), ...lr] : [...lr, ...lbCands(type, reg)]) : lbCands(type, reg);
          }
          // spines: a full box wrap (back | spine | front, usually 2000 px+ tall) gives a far sharper spine than most spine
          // scans; tried before the spine scans when looking for HD, after them otherwise (never both: a wrap turned down here
          // would only be downloaded and turned down again, up to 3 multi-MB files per game)
          const wrapFirst = key === 'spine' && sharp && !!spineCutter;
          if (wrapFirst && await wrapSpine(def.id, lbFor() ? lb.images[lbFor().id] : null, dir, base, old, !!old, reg)) { touched = true; if (upgrade) { rep.upgraded++; rep.up.push([game.title, key]); } else { rep.spine++; rep.got.push([game.title, key]); } return; }
          let ok = false;
          for (const c of cands) { if (tok.c) break; const r = await fetchInto(c.url, dir, base, suffix, c.ext, old, upgrade); if (r === true) { ok = true; break; } }
          // nothing from the databases: the Super Mario Wiki's official box scans (Switch 2 only; fronts and some backs)
          if (!ok && (!old || posterOld) && (key === 'front' || key === 'back') && !tok.c) {
            let wk = null; try { const wa = require('./wikiart'); if (wa.has(def.id)) wk = await wa.find(def.id, lookupNames(game.title), key, /eur/i.test(reg || '') ? 'eur' : /jpn|japan/i.test(reg || '') ? 'jpn' : 'usa'); } catch {}
            if (wk && await fetchInto(wk.url, dir, base, suffix, '.' + wk.ext, old, false) === true) { ok = true; log('art: Mario Wiki', key, 'for', game.title, '(' + wk.name + ')'); }
          }
          // no box scan anywhere: SteamGridDB's best-voted poster (only with the user's key), on record as a poster so a real
          // scan found by a later check replaces it
          if (!ok && !old && key === 'front' && !tok.c && opts.sgdb !== false) {
            const sg = require('./steamgrid');
            if (sg.enabled()) { const ps = await sg.posters({ ...game, names: lookupNames(game.title) }, sgMatch);
              for (const p of ps.slice(0, 3)) { if (tok.c) break; if (await fetchInto(p.url, dir, base, suffix, p.ext, null, false, 'poster') === true) { ok = true; log('art: SteamGridDB poster as the front of', game.title, '(no box scan found)'); break; } } }
          }
          if (posterOld && !ok) return; // still no real scan: the poster stays
          if (key === 'spine' && spineCutter && !ok && !wrapFirst) { const r = await wrapSpine(def.id, lbFor() ? lb.images[lbFor().id] : null, dir, base, old, upgrade || redo(key), reg); if (r) ok = true; }
          // GameCube / Wii spines: GameTDB keeps a full cover scan (back | spine | front) for nearly every disc, found by its game id
          if (!ok && (!old || upgrade) && key === 'spine' && spineCutter && (def.id === 'gc' || def.id === 'wii')) ok = await gametdbSpine(def.id, game.file, dir, base, upgrade ? old : null, reg);
          // Switch / 3DS: the spine and the back cut from GameTDB's full cover (a real scan, found by the game's title)
          if (!ok && (!old || upgrade) && (key === 'spine' || key === 'back') && gametdb.has(def.id) && !tok.c) {
            const full = await tdbWrap(reg), buf = full ? (key === 'spine' ? await cutSpine(full, def.id) : await cutBack(full, def.id)) : null;
            if (buf) { const inc = path.join(dir, `${base}${suffix}.incoming-tdb.jpg`);
              try { await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(inc, buf); // (beta.10: async)
                const a = upgrade && old ? await sizeOfAsync(old) : null, b = await sizeOfAsync(inc);
                if (!b || (a && Math.max(...b) < Math.max(...a) * 1.15)) await fs.promises.unlink(inc);
                else { await placeArt(dir, base, suffix, inc, '.jpg'); ok = true; log(key === 'spine' ? 'Spine' : 'Back', 'from GameTDB full cover:', game.title); }
              } catch (e) { log('GameTDB', key, game.title, e.message); try { fs.unlinkSync(inc); } catch {} } }
          }
          // a Switch / 3DS game no source has a cartridge photo of: one drawn from its front cover (1.73.5)
          if (!ok && !old && key === 'disc' && CART_SYS.has(def.id)) { const fr = await artFileA(tok.ls, dir, base, ''), buf = fr ? await makeCart(fr, def.id) : null;
            if (buf) { const tmp = path.join(dir, `${base}${suffix}.incoming.png`); try { await fs.promises.writeFile(tmp, buf); await placeArt(dir, base, suffix, tmp, '.png'); ok = true; } catch (e) { fs.promises.unlink(tmp).catch(() => {}); log('cartridge from cover', game.title, e.message); } } }
          if (ok) { touched = true; if (upgrade) { rep.upgraded++; rep.up.push([game.title, key]); } else { rep[key]++; rep.got.push([game.title, key]); } }
          else if (!old) missing.push(key);
          };
          if (opts.serial) await opts.serial(def.id, game.file, part); else await part();
        }
      } catch (e) { log('art', game.title, e.message); }
      finally { if (tdbTmp) fs.promises.unlink(tdbTmp).catch(() => {}); }
      if (!touched && !missing.length) rep.had++;
      if (missing.length) { rep.missed.push(game.title); missing.forEach(k => { rep.missedKinds[k] = (rep.missedKinds[k] || 0) + 1; }); }
      done++;
      progress({ system: def.name, systemId: def.id, stage: `${def.name}: ${done} of ${games.length}`, game: game.title, done, total: games.length, counts: { got: rep.front + rep.back + rep.spine + rep.disc, upgraded: rep.upgraded } });
    });
  }
  report.cancelled = tok.c;
  report.launchboxError = lbError;
  log('Art done', JSON.stringify(report.systems.map(r => ({ s: r.id, f: r.front, b: r.back, sp: r.spine, d: r.disc, up: r.upgraded, had: r.had, missed: r.missed.length }))), report.cancelled ? '(cancelled)' : '');
  return report;
}

// ---------- game info (from the cached LaunchBox index, no network) ----------
let infoIdx = null, infoMaps = null;
function loadInfo(plat) {
  // one console at a time, from its part of the index (the whole 45 MB file used to be read here, on the main thread)
  const m = ensureShards();
  if (!m && splitting) return null; // being split right now (a few seconds, once): asked again on the next scan
  if (m) { if (!infoIdx || !infoIdx.lazy) { infoIdx = lazyIndex(m); infoMaps = {}; } if (!infoMaps) infoMaps = {};
    if (plat && !infoMaps[plat] && infoIdx.v >= 3) { const list = infoIdx.games[plat] || [], artN = g => ((shardImages[g.id]) || []).length, better = (a, b) => !a || artN(b) > artN(a) ? b : a, mp = new Map(); for (const g of list) { mp.set(g.n, better(mp.get(g.n), g)); const t = g.n.replace(/ /g, ''); mp.set(t, better(mp.get(t), g)); } infoMaps[plat] = mp; }
    return infoMaps; }
  if (infoMaps) return infoMaps;
  try { infoIdx = JSON.parse(fs.readFileSync(path.join(cacheDir, 'launchbox-index.json'), 'utf8')); } catch { infoIdx = null; }
  infoMaps = {};
  const artN = g => ((infoIdx.images && infoIdx.images[g.id]) || []).length, better = (a, b) => !a || artN(b) > artN(a) ? b : a; /* duplicates: the entry with pictures (and usually the description) */
  if (infoIdx && infoIdx.v >= 3) for (const [plat, list] of Object.entries(infoIdx.games)) { const m = new Map(); for (const g of list) { m.set(g.n, better(m.get(g.n), g)); const t = g.n.replace(/ /g, ''); m.set(t, better(m.get(t), g)); } infoMaps[plat] = m; }
  return infoMaps;
}
const infoMemo = new Map();
// the parsed index (~60 MB) is only needed while titles are looked up: let it go a minute after the last scan
let dropInfoT = null;
function releaseInfoSoon() { clearTimeout(dropInfoT); dropInfoT = setTimeout(() => { infoIdx = null; infoMaps = null; infoMemo.clear(); dropShards(); }, 60000); if (dropInfoT.unref) dropInfoT.unref(); }
function invalidateInfo() { infoMaps = null; infoIdx = null; infoMemo.clear(); gcache = null; dropShards(); }
// Per-game results are kept in data\boxart-cache\gameinfo-cache.json (tied to the index file's date), so a normal
// launch never parses the big LaunchBox index on the main thread: only new or renamed games do.
let gcache = null, gcacheDirty = false, gcacheStamp = 0;
const MATCH_V = 2; // the title matching changed (other names, lookupNames): answers remembered by the old one are asked again
const idxStamp = () => { try { return Math.floor(fs.statSync(path.join(cacheDir, 'launchbox-index.json')).mtimeMs); } catch { return 0; } };
function infoCache() {
  if (gcache) return gcache; gcacheStamp = idxStamp();
  try { const j = JSON.parse(fs.readFileSync(path.join(cacheDir, 'gameinfo-cache.json'), 'utf8')); gcache = j.stamp === gcacheStamp && j.v === MATCH_V ? j.map : {}; } catch { gcache = {}; }
  return gcache;
}
function gameInfo(sysId, title) {
  if (!cacheDir) return null; const c = infoCache(), k = sysId + '|' + title;
  if (Object.prototype.hasOwnProperty.call(c, k)) return c[k];
  const v = gameInfoRaw(sysId, title); if (v === undefined) return null; /* not ready yet: don't remember it as 'nothing found' */ c[k] = v; gcacheDirty = true; return v;
}
function flushInfoCache() { if (infoMaps || infoIdx) releaseInfoSoon(); if (!gcacheDirty || !gcache) return; gcacheDirty = false; fs.promises.writeFile(path.join(cacheDir, 'gameinfo-cache.json'), JSON.stringify({ stamp: gcacheStamp, v: MATCH_V, map: gcache })).catch(() => {}); }
function gameInfoRaw(sysId, title) {
  const L = loadInfo(LAUNCHBOX[sysId]); if (!L) return undefined; const m = L[LAUNCHBOX[sysId]]; if (!m) return null;
  const n = norm(title); let g = m.get(n) || m.get(n.replace(/ /g, ''));
  if (!g) { const k = sysId + '|' + n; if (infoMemo.has(k)) g = infoMemo.get(k); else { try { g = launchboxMatch(infoIdx, sysId, { title }) || null; } catch { g = null; } infoMemo.set(k, g); } } // same fuzzy matching the art uses (memoised: it's a linear scan)
  if (!g) return null;
  const { overview, release, year, dev, pub, genres, esrb, players, coop, rating, wiki, video } = g;
  const imgs = (infoIdx && infoIdx.images && infoIdx.images[g.id]) || [];
  const urls = re => imgs.filter(x => re.test(x.type)).map(x => 'https://images.launchbox-app.com/' + x.file);
  return { overview, release, year, dev, pub, genres, esrb, players, coop, rating: rating ? Math.round(+rating * 10) / 10 : undefined, wiki, video, name: g.name, shots: urls(/^Screenshot - Gameplay/).concat(urls(/^Screenshot - (Game Title|Game Select)/)).slice(0, 8), bg: urls(/^Fanart - Background/)[0] || null, logo: urls(/^Clear Logo$/)[0] || null };
}
function hasInfo() { return idxStamp() > 0; } // cheap: never parses the index just to answer this

// the index, built (downloaded) if it has to be: Art Studio's "build the LaunchBox index" button
async function buildIndex(progress) { if (lbOverride) return true; await launchboxIndex(progress || (() => {})); return true; }
module.exports = { _setIndex: x => { lbOverride = x; }, LAUNCHBOX, init, matchTitle, matchName, lookupNames, sgMatch, setSpineCutter, setCartMaker, makeCart, CART_SYS, discId, downloadCovers, coverage, cancel, pause, isPaused, isImageBuf, HD_MIN, gameInfo, flushInfoCache, hasInfo, invalidateInfo, norm, launchboxMatch, libretroMatch, pickImages,
  // Art Studio (main/artstudio.js) reuses these rather than keeping its own copies
  candidates, libretroAll, libretroIndex, readyIndex, indexState, buildIndex, refreshIndex, cancelRefresh, indexInfo, edition, lbRegion, lrRegion, tdbRegion, download, downloadEx, sizeOf, artFile, isLow, placeArt, setOnPlaced, replacedFor, cutSpine, cutBack, canCut: () => !!spineCutter, pool, KINDS, ART_EXT, REPLACED };
