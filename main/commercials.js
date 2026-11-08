// The museum's retro TV: vintage TV commercials from the Internet Archive. For each game on your shelves Boxshelf looks
// for an ad uploaded there (once; a miss is looked at again after a month), plus a few ads for each console as the
// fallback. Nothing is bundled with Boxshelf: an ad is fetched only when the TV plays it, kept in data\commercials
// (up to a set size, oldest first out) and played from there. Off unless you turn the TV on in the museum's Room menu.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let log = () => {}, dir = null, fetchBuf = null, fetchFile = null, memoFile = null, memo = null;
function init(opts) { log = opts.log || log; dir = opts.dir; fetchBuf = opts.fetchBuf; fetchFile = opts.fetchFile || null; memoFile = opts.memoFile; }
const CAP = 600 * 1024 * 1024; // the cache's size
const CONSOLE = { gc: ['Nintendo GameCube', 'GameCube'], wii: ['Nintendo Wii', 'Wii'], wiiu: ['Wii U'], sw: ['Nintendo Switch'], sw2: ['Nintendo Switch 2', 'Switch 2'], psp: ['PSP', 'PlayStation Portable'], ps2: ['PlayStation 2', 'PS2'], ps3: ['PlayStation 3', 'PS3'], ps4: ['PlayStation 4', 'PS4'], ps5: ['PlayStation 5', 'PS5'], x360: ['Xbox 360'], n3ds: ['Nintendo 3DS', '3DS'], psx: ['PlayStation', 'PS1', 'PSX'], nes: ['Nintendo Entertainment System', 'NES'], snes: ['Super Nintendo', 'SNES'], n64: ['Nintendo 64', 'N64'], gb: ['Game Boy'], gbc: ['Game Boy Color'], gba: ['Game Boy Advance', 'GBA'], nds: ['Nintendo DS'], megadrive: ['Sega Genesis', 'Mega Drive'], mastersystem: ['Master System'], gamegear: ['Game Gear'], dreamcast: ['Dreamcast'], saturn: ['Sega Saturn', 'Saturn'], pcengine: ['TurboGrafx-16', 'PC Engine'], neogeo: ['Neo Geo', 'Neo-Geo'], arcade: ['arcade'], segacd: ['Sega CD', 'Mega-CD'], sega32x: ['Sega 32X', '32X'], atari2600: ['Atari 2600'], atarilynx: ['Atari Lynx'], wonderswan: ['WonderSwan'], ngpc: ['Neo Geo Pocket Color', 'Neo Geo Pocket', 'NGPC'], dos: ['MS-DOS', 'DOS'] };
const AD = /\b(commercials?|tv spots?|tv ads?|television (ad|commercial)s?|adverts?|advertisements?|ad)\b/i;
const NOT_AD = /\b(trailer|review|gameplay|walkthrough|let'?s play|longplay|speedrun|soundtrack|ost|unboxing)\b/i;

function load() { if (memo) return memo; try { memo = JSON.parse(fs.readFileSync(memoFile, 'utf8')); } catch { memo = {}; } memo.games = memo.games || {}; memo.consoles = memo.consoles || {}; return memo; }
let saveT = 0; function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(memoFile + '.tmp', JSON.stringify(memo)); fs.renameSync(memoFile + '.tmp', memoFile); } catch {} }, 1500); }
const words = s => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1 && !/^(the|of|and|for|a|an|edition|usa|europe|en|fr|de|es|it|rev|v\d.*)$/.test(w));
const q = s => encodeURIComponent(s);

async function search(query, rows) {
  const url = `https://archive.org/advancedsearch.php?q=${q(query)}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=downloads&fl[]=date&rows=${rows || 15}&output=json&sort[]=downloads+desc`;
  const b = await fetchBuf(url); if (!b) return []; let j; try { j = JSON.parse(b.toString('utf8')); } catch { return []; } return (j.response && j.response.docs) || [];
}
// the item's video: the smallest proper MP4 (the archive's own small copies first)
async function videoOf(id) {
  const b = await fetchBuf(`https://archive.org/metadata/${q(id)}`); if (!b) return null; let j; try { j = JSON.parse(b.toString('utf8')); } catch { return null; }
  const files = (j.files || []).filter(f => /\.mp4$/i.test(f.name) && +f.size > 50000 && +f.size < 120 * 1024 * 1024);
  if (!files.length) return null;
  const rank = f => (/512kb/i.test(f.format || f.name) ? 0 : /h\.264/i.test(f.format || '') ? 1 : 2) * 1e10 + (+f.size || 0);
  const f = files.sort((a, b) => rank(a) - rank(b))[0];
  return { file: f.name, size: +f.size || 0, length: +f.length || 0 };
}
// one game's ad: all of its title's words in the item's title, which says it's an ad
async function forGame(sysId, title) {
  const w = words(title).slice(0, 6); if (!w.length) return null;
  const docs = await search(`title:(${w.map(x => `"${x}"`).join(' AND ')}) AND mediatype:(movies)`, 20);
  const plat = CONSOLE[sysId] || [];
  const scored = docs.map(d => { const t = String(d.title || ''), tw = new Set(words(t)); const hit = w.filter(x => tw.has(x)).length / w.length;
      return { d, s: hit + (AD.test(t) ? 1 : 0) - (NOT_AD.test(t) ? 2 : 0) + (plat.some(p => t.toLowerCase().includes(p.toLowerCase())) ? .3 : 0) + Math.min(.2, (+d.downloads || 0) / 50000) }; })
    .filter(x => x.s >= 1.95 && AD.test(String(x.d.title || ''))).sort((a, b) => b.s - a.s);
  for (const { d } of scored.slice(0, 3)) { const v = await videoOf(d.identifier).catch(() => null); if (v) return { id: d.identifier, title: String(d.title || ''), year: String(d.year || d.date || '').slice(0, 4), ...v }; }
  return null;
}
async function forConsole(sysId) {
  const names = CONSOLE[sysId]; if (!names) return [];
  const docs = await search(`title:("${names[0]}") AND title:(commercial OR commercials OR ad OR ads OR advert OR "tv spot") AND mediatype:(movies)`, 12);
  const out = [];
  for (const d of docs.filter(d => AD.test(String(d.title || '')) && !NOT_AD.test(String(d.title || ''))).slice(0, 4)) { const v = await videoOf(d.identifier).catch(() => null); if (v) out.push({ id: d.identifier, title: String(d.title || ''), year: String(d.year || d.date || '').slice(0, 4), ...v }); }
  return out;
}
const keyOf = (sysId, file) => sysId + '|' + String(file || '').toLowerCase();
// look up ads for games not looked at yet (paced: one game at a time, waiting while you use the app or play)
async function scan(games, opts = {}) {
  const m = load(), now = Date.now(); let found = 0, looked = 0, fails = 0;
  for (const { sysId, file, title } of games) {
    if (opts.cancelled && opts.cancelled()) break;
    const k = keyOf(sysId, file), e = m.games[k]; if (e && (e.hit || now - e.at < 30 * 864e5)) continue;
    if (opts.idle) await opts.idle();
    // offline / the archive down: three failures in a row end this round with one log line (it used to log every game, unpaced)
    let hit = null; try { hit = await forGame(sysId, title); fails = 0; } catch (e2) { if (++fails === 1) log('TV ads', title, e2.message); if (fails >= 3) { log('TV ads: the archive is not answering, trying again next time'); return found; } await new Promise(r => setTimeout(r, 1200)); continue; }
    m.games[k] = { at: Date.now(), title, hit }; looked++; if (hit) { found++; log('TV ad found:', title, '->', hit.title); } save();
    await new Promise(r => setTimeout(r, 1200)); // gentle on the archive
  }
  const sys = [...new Set(games.map(g => g.sysId))];
  for (const s of sys) { const c = m.consoles[s]; if (c && now - c.at < 30 * 864e5) continue; if (opts.idle) await opts.idle(); try { m.consoles[s] = { at: Date.now(), hits: await forConsole(s) }; save(); } catch (e2) { log('TV console ads', s, e2.message); } }
  if (looked) log('TV ads: looked at', looked, 'games, found', found);
  return found;
}
// every ad known: per game first, then the consoles'
function list() {
  const m = load(), out = [];
  for (const [k, e] of Object.entries(m.games)) if (e.hit) { const i = k.indexOf('|'); out.push({ ...e.hit, key: 'g:' + k, sysId: k.slice(0, i), rom: k.slice(i + 1), game: e.title }); } // file: the video; rom: your game
  for (const [s, c] of Object.entries(m.consoles)) (c.hits || []).forEach((h, n) => out.push({ key: `c:${s}:${n}`, sysId: s, console: true, ...h }));
  return out;
}
function adFor(sysId, file) { const e = load().games[keyOf(sysId, file)]; return e && e.hit ? { ...e.hit, key: 'g:' + keyOf(sysId, file), sysId, rom: String(file || '').toLowerCase(), game: e.title } : null; }
// the ad on disk (fetched the first time it plays); the cache keeps to its size, oldest first out
const busy = new Map();
async function local(ad) {
  if (!ad || !ad.id || !ad.file || !dir) return null;
  const f = path.join(dir, crypto.createHash('sha1').update(ad.id + '/' + ad.file).digest('hex').slice(0, 20) + '.mp4');
  try { await fs.promises.access(f); const t = new Date(); fs.promises.utimes(f, t, t).catch(() => {}); return f; } catch {}
  if (busy.has(f)) return busy.get(f);
  const url = `https://archive.org/download/${q(ad.id)}/${ad.file.split('/').map(q).join('/')}`, part = f + '.part';
  // streamed to disk (fetchFile) rather than held whole in memory: an ad can be up to 120 MB
  const p = (async () => { await fs.promises.mkdir(dir, { recursive: true });
    if (fetchFile) { const n = await fetchFile(url, part, 120 * 1024 * 1024); if (!n || n < 50000) { fs.promises.unlink(part).catch(() => {}); return null; } }
    else { const b = await fetchBuf(url); if (!b || b.length < 50000) return null; await fs.promises.writeFile(part, b); }
    await fs.promises.rename(part, f); trim().catch(() => {}); return f; })().catch(e => { log('TV ad download', ad.id, e.message); fs.promises.unlink(part).catch(() => {}); return null; }).finally(() => busy.delete(f));
  busy.set(f, p); return p;
}
async function trim() { let ents = []; try { ents = await Promise.all((await fs.promises.readdir(dir)).filter(n => /\.mp4$/i.test(n)).map(async n => { const s = await fs.promises.stat(path.join(dir, n)); return { n, s: s.size, t: s.mtimeMs }; })); } catch { return; }
  let tot = ents.reduce((a, e) => a + e.s, 0); for (const e of ents.sort((a, b) => a.t - b.t)) { if (tot <= CAP) break; try { await fs.promises.unlink(path.join(dir, e.n)); tot -= e.s; } catch {} } }
module.exports = { init, scan, list, adFor, local, _test: { words, forGame, AD, NOT_AD } };
