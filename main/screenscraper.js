// ScreenScraper (screenscraper.fr, API v2): box fronts, backs, spines, full wraps and disc / cartridge art by region, for the
// Art Studio. Optional: nothing happens without the user's own ScreenScraper account (Settings → Accounts & services).
// ScreenScraper also wants a developer login (devid / devpassword) on every call; Boxshelf has none of its own to ship, so the
// user may enter one, and without it the calls are tried as they are (the Test says plainly when the developer login is what's missing).
// Credentials: read only through creds(), put into the address at the moment of the request and never stored with it. The media
// addresses ScreenScraper answers with carry every credential in their query: they're kept and cached WITHOUT them (clean()),
// and signed again only for the download. Nothing here logs an address, a body or a raw error (they can echo the request).
// Matching: by the ROM's own hashes (CRC32 / MD5 / SHA1) only for files up to HASH_MAX, read in chunks off the main thread's way;
// otherwise by the cheap facts the API accepts (romnom = file name, romtaille = size, systemeid, romtype, the GameCube / Wii
// disc id as serialnum), then by title through jeuRecherche, accepted only on an exact or near match (covers.matchTitle).
// Limits: as many requests at once as the account's maxthreads (1 until it says), spaced to its maxrequestspermin; 429 pauses a
// minute, the daily quota (430, or requeststoday at the max) pauses until the next UTC day, a refused login (403) stops calls until
// the sign-in changes. Lookups are cached on disk (a game: a week; no match: a day).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const BASE = 'https://api.screenscraper.fr/api2';
const SOFT = 'Boxshelf';
const UA = `Boxshelf/${(() => { try { return require('../package.json').version; } catch { return '0'; } })()}`;
const HIT_TTL = 7 * 864e5, MISS_TTL = 864e5, HASH_MAX = 64 * 1048576, TIMEOUT = 15000, DL_TIMEOUT = 45000, MAX_GAMES = 20000, MAX_HASH = 20000;
// ScreenScraper's console numbers (systemesListe.php) for the shelves Boxshelf has; PS4 and Steam aren't covered
const SYS = { gc: 13, wii: 16, wiiu: 18, sw: 225, n3ds: 17, psp: 61, ps2: 58, ps3: 59, x360: 33, megadrive: 1, mastersystem: 2, nes: 3, snes: 4, gb: 9, gbc: 10, gba: 12, n64: 14, nds: 15, gamegear: 21, dreamcast: 23, saturn: 22, pcengine: 31, neogeo: 142, arcade: 75, segacd: 20, sega32x: 19, atari2600: 26, atarilynx: 28, wonderswan: 45, ngpc: 82, dos: 135, psx: 57 }; // (beta.6: the retro shelves)
// media type → Art Studio part. box-texture is the whole wrap (back | spine | front): the spine is cut from it. (box-3D is a
// rendered 3D box, not flat art: not offered, the same as LaunchBox's "Box - 3D")
const PART_MEDIA = { front: ['box-2D'], back: ['box-2D-back'], spine: ['box-2D-side', 'box-texture'], disc: ['support-2D'] };
const REGION = r => { r = String(r || '').toLowerCase(); return r === 'us' || r === 'cus' ? 'usa' : r === 'jp' ? 'jpn' : r === 'wor' ? 'world' : /^(eu|fr|de|es|it|uk|nl|pt|se|dk|fi|no|pl|gr|ru|au|nz)$/.test(r) ? 'eur' : ''; };
const REGION_WORD = { usa: 'USA', eur: 'Europe', jpn: 'Japan', world: 'World' };
const CART = new Set(['n3ds', 'sw', 'sw2', 'nes', 'snes', 'n64', 'gb', 'gbc', 'gba', 'nds', 'megadrive', 'mastersystem', 'gamegear', 'pcengine', 'neogeo', 'arcade', 'sega32x', 'atari2600', 'atarilynx', 'wonderswan', 'ngpc']);
const CRED_PARAM = /^(devid|devpassword|softname|ssid|sspassword|output)$/i;

let creds = () => ({}), log = () => {}, cacheFile = null, cache = null, saveT = null, fetchFn = null, matchFn = null, discIdFn = null;
let pausedUntil = 0, pauseWhy = '', badSig = '', maxThreads = 1, spacing = 0, lastAt = 0, active = 0; const queue = [];
function init(o = {}) { creds = o.creds || creds; log = o.log || log; cacheFile = o.dataDir ? path.join(o.dataDir, 'ss-cache.json') : null; cache = null; fetchFn = o.fetch || null; matchFn = o.match || null; discIdFn = o.discId || null; pausedUntil = 0; pauseWhy = ''; badSig = ''; maxThreads = 1; spacing = 0; }
// (beta.7) Boxshelf's own developer login, when this build has one: main/ss-dev.json { "devId", "devPass" }, put there for the
// app builds only. It's never in git (the .gitignore lists it) and so never in the public source. One the player enters wins.
// (beta.12: the file's placeholders, "YOUR-…", count as no login: a file not filled in yet must not look like a wrong one)
// (read as text, tabs and line breaks typed into a value taken out first: they made the file unreadable JSON)
const OWN_DEV = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'ss-dev.json'), 'utf8').replace(/^﻿/, '').replace(/[\u0000-\u001f]+/g, ' ')); const t = v => String(v || '').trim(), ok = v => t(v) && !/^YOUR-/i.test(t(v)); return j && ok(j.devId) && ok(j.devPass) ? { devId: t(j.devId), devPass: t(j.devPass) } : null; /* (trimmed: a space or tab typed into the file is never part of the login) */ } catch { return null; } })();
const hasDevLogin = () => { const c = C(); return !!(c.devId && c.devPass); };
const C = () => { const c = creds() || {}, own = !String(c.devId || '').trim() && OWN_DEV;
  return { user: String(c.user || '').trim(), pass: String(c.pass || ''), devId: own ? OWN_DEV.devId : String(c.devId || '').trim(), devPass: own ? OWN_DEV.devPass : String(c.devPass || '') }; };
const sigOf = c => crypto.createHash('sha256').update([c.user, c.pass, c.devId, c.devPass].join('\0')).digest('hex').slice(0, 16); // (a fingerprint, never the values)
const configured = () => { const c = C(); return !!(c.user && c.pass); };
const enabled = () => configured() && sigOf(C()) !== badSig; // a sign-in the server refused isn't sent again until it changes
function credsChanged() { badSig = ''; if (pauseWhy === 'auth') { pausedUntil = 0; pauseWhy = ''; } }

// ---------- addresses: credentials only ever in the copy that's sent ----------
function credParams(c = C()) { const p = { softname: SOFT, output: 'json', ssid: c.user, sspassword: c.pass }; if (c.devId) { p.devid = c.devId; p.devpassword = c.devPass; } return p; }
function apiUrl(file, q, c) { const u = new URL(BASE + '/' + file); for (const [k, v] of Object.entries({ ...credParams(c), ...q })) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v)); return u.toString(); }
// a media address from an answer, without its credentials; null when it isn't ScreenScraper's
function clean(u) {
  let x; try { x = new URL(String(u || '')); } catch { return null; }
  if (!/^https?:$/.test(x.protocol) || !/(^|\.)screenscraper\.fr$/i.test(x.hostname) || String(u).length > 1500) return null;
  for (const k of [...x.searchParams.keys()]) if (CRED_PARAM.test(k)) x.searchParams.delete(k);
  x.protocol = 'https:'; return x.toString();
}
const isMedia = u => { try { const x = new URL(String(u)); return /(^|\.)screenscraper\.fr$/i.test(x.hostname) && /mediaJeu\.php$/i.test(x.pathname); } catch { return false; } };
function sign(u) { const x = new URL(u); const p = credParams(); delete p.output; for (const [k, v] of Object.entries(p)) if (v) x.searchParams.set(k, v); return x.toString(); }

// ---------- cache: { games: { "<sys>|<file>|<size>": [jeuId|0, at, [media]] }, hashes: { "<file>|<size>|<mtime>": [crc, md5, sha1] } } ----------
function cacheGet() {
  if (cache) return cache;
  try { const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (j && j.games && j.hashes && typeof j.games === 'object' && typeof j.hashes === 'object') cache = { games: j.games, hashes: j.hashes }; } catch {}
  return cache || (cache = { games: {}, hashes: {} });
}
function cacheSave() {
  if (!cacheFile) return; clearTimeout(saveT);
  saveT = setTimeout(() => { saveT = null; const c = cacheGet(), now = Date.now();
    for (const [k, v] of Object.entries(c.games)) if (now - v[1] > (v[0] ? HIT_TTL : MISS_TTL)) delete c.games[k];
    const trim = (m, n) => { const ks = Object.keys(m); if (ks.length > n) ks.slice(0, ks.length - n).forEach(k => delete m[k]); }; trim(c.games, MAX_GAMES); trim(c.hashes, MAX_HASH);
    const tmp = cacheFile + '.tmp'; fs.promises.writeFile(tmp, JSON.stringify(c)).then(() => fs.promises.rename(tmp, cacheFile)).catch(e => log('ScreenScraper: cache not saved', e.code || '')); }, 2000);
  if (saveT.unref) saveT.unref();
}

// ---------- requests ----------
class SsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function pause(ms, why) { pausedUntil = Math.max(pausedUntil, Date.now() + ms); pauseWhy = why; }
const nextUtcDay = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - Date.now() + 60e3; };
const PAUSE_MSG = { rate: 'ScreenScraper asked us to slow down', quota: "Today's ScreenScraper lookups are used up", closed: 'ScreenScraper is closed to apps right now', auth: 'The ScreenScraper login was not accepted', blocked: 'ScreenScraper has blocked this version of Boxshelf' };
async function limited(fn) { // the account's maxthreads at once, every request spaced to its per-minute rate
  while (active >= maxThreads) await new Promise(r => queue.push(r));
  active++;
  try { const at = Math.max(Date.now(), lastAt + spacing); lastAt = at; const wait = at - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); return await fn(); } // (the slot is taken before the wait: two callers never share one)
  finally { active--; const n = queue.shift(); if (n) n(); }
}
// the account's limits, as each answer reports them (numbers arrive as strings)
function learn(u) {
  if (!u || typeof u !== 'object') return null;
  const n = k => { const v = parseInt(u[k], 10); return Number.isFinite(v) ? v : null; };
  const th = n('maxthreads'); if (th) maxThreads = Math.max(1, Math.min(th, 8));
  const pm = n('maxrequestspermin'); if (pm) spacing = Math.ceil(60000 / pm);
  const today = n('requeststoday'), max = n('maxrequestsperday');
  if (today != null && max && today >= max) { pause(nextUtcDay(), 'quota'); log("ScreenScraper: today's lookups are used up, pausing until tomorrow"); }
  return { left: today != null && max ? Math.max(0, max - today) : null, threads: maxThreads };
}
const devWord = t => /d[ée]veloppeur|developer|devid/i.test(t);
// the HTTP status / body → an SsError (or null = answer is fine). Bodies are read only for the words that matter, never kept
function failure(status, text, c) {
  const t = String(text || '').slice(0, 400);
  if (status === 401) { pause(10 * 60e3, 'closed'); return new SsError('closed', PAUSE_MSG.closed); }
  if (status === 403 || /erreur de login|identifiants|login error/i.test(t)) { if (c && sigOf(c) === sigOf(C())) { badSig = sigOf(c); } return new SsError('auth', devWord(t) ? 'The ScreenScraper developer login was not accepted' : PAUSE_MSG.auth); }
  if (status === 423) { pause(10 * 60e3, 'closed'); return new SsError('closed', 'ScreenScraper is down for now'); }
  if (status === 426) { pause(864e5, 'blocked'); return new SsError('blocked', PAUSE_MSG.blocked); }
  if (status === 429) { pause(60e3, 'rate'); log('ScreenScraper: rate limited, pausing a minute'); return new SsError('rate', PAUSE_MSG.rate); }
  if (status === 430 || /quota/i.test(t)) { pause(nextUtcDay(), 'quota'); log("ScreenScraper: today's lookups are used up, pausing until tomorrow"); return new SsError('quota', PAUSE_MSG.quota); }
  if (status === 431) { pause(60 * 60e3, 'quota'); return new SsError('quota', 'ScreenScraper: too many unknown games today'); }
  if (status >= 500) return new SsError('net', 'ScreenScraper answered ' + status);
  return null;
}
// GET one API file → the parsed "response", null on 404 / not found. Throws SsError: nocreds | auth | rate | quota | closed | blocked | net
async function api(file, q, c = C()) {
  if (!c.user || !c.pass) throw new SsError('nocreds', 'No ScreenScraper account');
  if (Date.now() < pausedUntil) throw new SsError(pauseWhy || 'rate', PAUSE_MSG[pauseWhy] || PAUSE_MSG.rate);
  return limited(async () => {
    let r; try { r = await (fetchFn || require('electron').net.fetch)(apiUrl(file, q, c), { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT), cache: 'no-store' }); }
    catch (e) { throw new SsError('net', /abort|timeout/i.test(e && e.name + ' ' + e.message) ? 'ScreenScraper took too long to answer' : "Couldn't reach ScreenScraper"); }
    if (r.status === 404) return null;
    let text = ''; try { text = await r.text(); } catch { throw new SsError('net', 'ScreenScraper sent something unexpected'); }
    const f = failure(r.status, r.ok ? (/^\s*\{/.test(text) ? '' : text) : text, c); if (f) throw f;
    if (r.status === 400) return null; // (a request it couldn't use, e.g. a name with nothing to go on)
    if (!r.ok) throw new SsError('net', 'ScreenScraper answered ' + r.status);
    if (/non trouv|not found/i.test(text.slice(0, 200)) && !/^\s*\{/.test(text)) return null; // "Erreur : Rom/Iso/Dossier non trouvée !"
    let j; try { j = JSON.parse(text); } catch { throw new SsError('net', 'ScreenScraper sent something unexpected'); }
    const resp = j && j.response; if (!resp || typeof resp !== 'object') return null;
    resp.limits = learn(resp.ssuser); return resp;
  });
}

// ---------- the ROM's identity ----------
const romType = (file, isDir) => isDir ? 'dossier' : /\.(iso|gcm|gcz|rvz|wbfs|wia|ciso|cso|chd|cue|bin|img|nkit\.iso)$/i.test(file) ? 'iso' : 'rom';
// CRC32 / MD5 / SHA1 of a file up to HASH_MAX, streamed in 1 MB pieces (each piece hashed, then the event loop gets a turn);
// remembered by path + size + date. Bigger files (disc images): none, the API matches those on name + size
async function hashes(file, st) {
  if (!st || !st.isFile() || st.size > HASH_MAX || st.size < 1) return null;
  const c = cacheGet(), k = file.toLowerCase() + '|' + st.size + '|' + Math.floor(st.mtimeMs), hit = c.hashes[k]; if (hit) return { crc: hit[0], md5: hit[1], sha1: hit[2] };
  const md5 = crypto.createHash('md5'), sha1 = crypto.createHash('sha1'); let crc = 0; const crcOk = typeof zlib.crc32 === 'function';
  await new Promise((res, rej) => { const s = fs.createReadStream(file, { highWaterMark: 1 << 20 }); s.on('data', b => { md5.update(b); sha1.update(b); if (crcOk) crc = zlib.crc32(b, crc); }); s.on('end', res); s.on('error', rej); });
  const out = { crc: crcOk ? (crc >>> 0).toString(16).toUpperCase().padStart(8, '0') : '', md5: md5.digest('hex').toUpperCase(), sha1: sha1.digest('hex').toUpperCase() };
  c.hashes[k] = [out.crc, out.md5, out.sha1]; cacheSave(); return out;
}
// the media an answer lists → [{ type, region, url (clean), ext }]: only the types Art Studio uses, only ScreenScraper's own addresses
function mediaOf(jeu) {
  const want = new Set(Object.values(PART_MEDIA).flat()), out = [];
  for (const m of Array.isArray(jeu && jeu.medias) ? jeu.medias : []) {
    if (!m || !want.has(String(m.type))) continue; if (m.parent && m.parent !== 'jeu') continue;
    const url = clean(m.url); if (!url) continue;
    const f = String(m.format || '').toLowerCase(); out.push({ type: String(m.type), region: String(m.region || '').toLowerCase().slice(0, 8), url, ext: f === 'jpg' || f === 'jpeg' ? '.jpg' : f === 'webp' ? '.webp' : '.png' });
    if (out.length >= 80) break;
  }
  return out;
}
// which ScreenScraper game a file is, and its media. cacheOnly: no requests (a restyle job uses only what the picker looked up)
async function lookup(sysId, game, { cacheOnly = false, match = matchFn, discId = discIdFn } = {}) {
  const sys = SYS[sysId], file = String((game && game.file) || ''); if (!sys || !file) return null;
  let st = null; try { st = await fs.promises.stat(file); } catch {}
  const size = st && st.isFile() ? st.size : +(game && game.sizeBytes) || 0;
  const c = cacheGet(), ck = sysId + '|' + file.toLowerCase() + '|' + size, hit = c.games[ck];
  // (media addresses from the disk cache are cleaned again: a hand-edited or older file never carries a credential onward)
  if (hit && Date.now() - hit[1] < (hit[0] ? HIT_TTL : MISS_TTL)) return hit[0] ? { id: hit[0], media: (Array.isArray(hit[2]) ? hit[2] : []).map(m => m && { ...m, url: clean(m.url) }).filter(m => m && m.url) } : null;
  if (cacheOnly || !enabled()) return null;
  const name = path.basename(file), q = { systemeid: sys, romtype: romType(file, st && st.isDirectory()), romnom: name, romtaille: size || undefined };
  try { const h = await hashes(file, st); if (h) Object.assign(q, h.crc ? { crc: h.crc } : {}, { md5: h.md5, sha1: h.sha1 }); } catch {} // (a file that can't be read: matched by name)
  if ((sysId === 'gc' || sysId === 'wii') && discId) { try { const id = discId(file); if (id) q.serialnum = id; } catch {} }
  let jeu = null, resp = await api('jeuInfos.php', q);
  if (resp && resp.jeu && resp.jeu.id && String(resp.jeu.id) !== '0') jeu = resp.jeu;
  if (!jeu && game.title && match) { // by title: the API's own search, then only an exact / near title match counts ("Pikmin" isn't "Pikmin 2")
    const s = await api('jeuRecherche.php', { systemeid: sys, recherche: String(game.title).slice(0, 120) });
    const list = (s && Array.isArray(s.jeux) ? s.jeux : []).filter(x => x && x.id && Array.isArray(x.noms)).slice(0, 30);
    const flat = []; for (const x of list) for (const n of x.noms) if (n && n.text) flat.push({ id: x.id, name: String(n.text), jeu: x });
    const m = flat.length ? match(flat, game) : null;
    if (m) { jeu = m.jeu; if (!Array.isArray(jeu.medias) || !jeu.medias.length) { const r2 = await api('jeuInfos.php', { systemeid: sys, gameid: m.id }); if (r2 && r2.jeu) jeu = r2.jeu; } }
  }
  const out = jeu ? { id: +jeu.id || String(jeu.id), media: mediaOf(jeu) } : null;
  c.games[ck] = out ? [out.id, Date.now(), out.media] : [0, Date.now()]; cacheSave(); return out;
}
// Art Studio candidates for one part: [{ url (clean), ext, src?, cut?, source:'screenscraper', type, region, edition, kind, label }].
// Never throws: no account, no match, offline, a quota or a refused login all mean "nothing from ScreenScraper this time".
async function candidates(sysId, game, part, opts = {}) {
  const types = PART_MEDIA[part]; if (!types || !configured()) return [];
  try {
    const hit = await lookup(sysId, game, { cacheOnly: !!opts.cacheOnly, match: opts.match || matchFn, discId: opts.discId || discIdFn }); if (!hit) return [];
    const out = [];
    for (const m of hit.media) {
      if (!types.includes(m.type)) continue;
      const region = REGION(m.region), rw = REGION_WORD[region] || (m.region && m.region !== 'ss' ? m.region.toUpperCase() : '');
      const what = m.type === 'box-2D' ? 'Box front' : m.type === 'box-2D-back' ? 'Box back' : m.type === 'box-2D-side' ? 'Spine' : m.type === 'box-texture' ? 'Cut from full wrap' : CART.has(sysId) ? 'Cartridge' : 'Disc';
      const c = { url: m.url, ext: m.ext, source: 'screenscraper', type: m.type, region, edition: 'original', kind: 'scan', label: [what, rw].filter(Boolean).join(' · ') };
      if (m.type === 'box-texture') { if (!opts.canCut) continue; c.cut = 'spine'; c.src = m.ext; c.ext = '.jpg'; }
      // (beta.12) the picker shows ScreenScraper's own small copy (its media address takes maxwidth / maxheight): full scans,
      // one at a time on a free account, made the page fill in slowly. The full scan is fetched only for the one used.
      // (A full wrap stays whole: its spine is cut from the real picture.)
      // A spine is narrow, so its copy may be tall (still a small file): the Spine page shows it lying flat across the page.
      else { try { const u = new URL(m.url); u.searchParams.set('maxwidth', '420'); u.searchParams.set('maxheight', m.type === 'box-2D-side' ? '1400' : '420'); c.thumbUrl = u.toString(); } catch {} }
      out.push(c);
    }
    return out;
  } catch (e) { if (e.code !== 'nocreds') log('ScreenScraper:', e.message); return []; }
}
// a media file (a clean address from candidates()) → dest: 'ok' | 'missing' | 'busy'; throws when offline (as covers.downloadEx)
async function download(url, dest) {
  if (!isMedia(url)) return 'missing';
  if (!enabled()) return 'busy'; // no account (or a refused one) right now: not "missing" (that would hide the picture for a week)
  if (Date.now() < pausedUntil) return 'busy';
  return limited(async () => {
    let r; try { r = await (fetchFn || require('electron').net.fetch)(sign(url), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(DL_TIMEOUT), cache: 'no-store' }); }
    catch (e) { throw new Error(/abort|timeout/i.test(e && e.name + ' ' + e.message) ? 'ScreenScraper took too long to answer' : "Couldn't reach ScreenScraper"); }
    if (r.status === 404) return 'missing';
    if (!r.ok) { failure(r.status, '', null); return 'busy'; }
    const b = Buffer.from(await r.arrayBuffer());
    // a picture, by its first bytes: ScreenScraper answers a missing media with a short text ("NOMEDIA") and status 200
    const pic = (b.length > 64 && ((b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')));
    if (!pic) return 'missing';
    await fs.promises.writeFile(dest + '.part', b); await fs.promises.rename(dest + '.part', dest); return 'ok';
  });
}
// Settings → Test: { ok, left } or { ok:false, error } (words for the screen; never a credential)
async function test() {
  const c = C(); if (!c.user || !c.pass) return { ok: false, error: 'no account' };
  if (pauseWhy !== 'quota' && pauseWhy !== 'blocked') { pausedUntil = 0; pauseWhy = ''; } // a test is a fresh try (a used-up day stays used up)
  // (beta.7) refused with no developer login at all (the usual case until Boxshelf has its own): say that, not "not accepted"
  const noDev = !hasDevLogin();
  try { const r = await api('ssuserInfos.php', {}, c); if (!r || !r.ssuser) return { ok: false, error: noDev ? 'no developer login' : 'not accepted' }; if (sigOf(c) === badSig) badSig = ''; return { ok: true, left: r.limits ? r.limits.left : null }; }
  catch (e) { return { ok: false, error: e.code === 'auth' ? (noDev ? 'no developer login' : /developer/.test(e.message) ? 'developer login not accepted' : 'not accepted') : e.message }; }
}
const state = () => ({ configured: configured(), enabled: enabled(), paused: Date.now() < pausedUntil ? pauseWhy : '', threads: maxThreads, devLogin: hasDevLogin() });

module.exports = { init, candidates, download, test, configured, enabled, credsChanged, isMedia, clean, state, SYS, HASH_MAX, 
  _t: { cacheGet, apiUrl, lookup, hashes, mediaOf, reset: () => { cache = null; pausedUntil = 0; pauseWhy = ''; badSig = ''; maxThreads = 1; spacing = 0; lastAt = 0; }, paused: () => pausedUntil, why: () => pauseWhy, threads: () => maxThreads } };
