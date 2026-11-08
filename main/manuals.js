// Game manuals from the Internet Archive (archive.org): search per game, let the
// user pick, then save pages as <games folder>\covers\<game file>-manual-01.jpg …
const fs = require('fs');
const path = require('path');
const https = require('https');
const { scanSystem } = require('./scanner');
const { isFile, artBase, manualDirFor } = require('./paths');

const SYSTEM_WORDS = { gc: ['gamecube', 'game cube', 'gcn', 'ngc'], wii: ['wii'], wiiu: ['wii u', 'wiiu'], psp: ['psp', 'playstation portable'], sw: ['switch'], sw2: ['switch 2', 'switch'], ps3: ['ps3', 'playstation 3'], ps4: ['ps4', 'playstation 4'], ps5: ['ps5', 'playstation 5'], ps2: ['ps2', 'playstation 2'], x360: ['xbox 360', 'xbox360', 'x360'], n3ds: ['3ds', 'nintendo 3ds'], psx: ['playstation', 'psx', 'ps1'], nes: ['nes', 'nintendo entertainment system', 'famicom'], snes: ['snes', 'super nintendo', 'super famicom'], n64: ['n64', 'nintendo 64'], gb: ['game boy', 'gameboy'], gbc: ['game boy color', 'gameboy color', 'gbc'], gba: ['game boy advance', 'gba'], nds: ['nintendo ds', 'nds'], megadrive: ['genesis', 'mega drive', 'megadrive'], mastersystem: ['master system', 'sms'], gamegear: ['game gear'], dreamcast: ['dreamcast'], saturn: ['saturn', 'sega saturn'], pcengine: ['turbografx', 'turbografx-16', 'pc engine', 'pc-engine', 'tg-16', 'tg16'], neogeo: ['neo geo', 'neo-geo', 'neogeo'], arcade: ['arcade'], segacd: ['sega cd', 'mega cd', 'mega-cd'], sega32x: ['32x', 'sega 32x'], atari2600: ['atari 2600', '2600'], atarilynx: ['lynx', 'atari lynx'], wonderswan: ['wonderswan'], ngpc: ['neo geo pocket', 'neogeo pocket', 'ngpc', 'ngp'], dos: ['dos', 'ms-dos', 'msdos'] };
const MAX_PAGES = 60, PAGE_WIDTH = 1600, PARALLEL = 4; /* page images from archive.org: 1600 px wide keeps small print readable (was 800) */
let log = () => {};
function init(logger) { if (logger) log = logger; }

// HTTP helpers. Every request has an idle timeout (no bytes for `stall` ms) AND a hard deadline,
// so a slow or silent server can never leave the Settings panel stuck on "Downloading…".
function withTimers(req, res, reject, stall, deadline) {
  let idle = setTimeout(() => req.destroy(new Error('timed out')), stall);
  const hard = setTimeout(() => req.destroy(new Error('took too long')), deadline);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => req.destroy(new Error('timed out')), stall); };
  const clear = () => { clearTimeout(idle); clearTimeout(hard); };
  if (res) { res.on('data', touch); res.on('error', e => { clear(); reject(e); }); res.on('end', clear); res.on('close', clear); }
  return { clear, touch };
}
// One descriptive User-Agent, and at most HOST_MAX requests in flight per host across everything that uses these helpers
// (manualcoll runs 2 games × 4 pages at once; archive.org answers bursts like that with 429s and temporary blocks).
const UA = `Boxshelf/${(() => { try { return require('../package.json').version; } catch { return '0'; } })()}`;
const HOST_MAX = 4, hostBusy = new Map(), hostWait = new Map(), REDIR = Symbol('redirect');
function hostSlot(url) {
  let h = ''; try { h = new URL(url).host.toLowerCase(); } catch {}
  return new Promise(ok => {
    const go = () => {
      hostBusy.set(h, (hostBusy.get(h) || 0) + 1); let freed = false;
      ok(() => { if (freed) return; freed = true; const n = hostBusy.get(h) - 1; if (n > 0) hostBusy.set(h, n); else hostBusy.delete(h);
        const q = hostWait.get(h); if (q) { const next = q.shift(); if (!q.length) hostWait.delete(h); next(); } });
    };
    if ((hostBusy.get(h) || 0) < HOST_MAX) go(); else { if (!hostWait.has(h)) hostWait.set(h, []); hostWait.get(h).push(go); }
  });
}
// once(url) does a single request holding a slot; a redirect gives its slot back before the next hop (which may need one
// on the same host: holding it there could deadlock a full host)
async function limited(url, hops, once, again) {
  const free = await hostSlot(url), dog = setTimeout(free, 15 * 60e3); // every request has its own deadline; this is only a backstop against a leaked slot
  if (dog.unref) dog.unref();
  let r; try { r = await once(url); } finally { clearTimeout(dog); free(); }
  return r && r[REDIR] ? again(r[REDIR], hops + 1) : r;
}
function getJson(url, hops = 0) {
  return limited(url, hops, url => new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve({ [REDIR]: new URL(res.headers.location, url).toString() }); }
      // the status and Retry-After travel with the error: archive.org's 429 / 503 ("slow down") is retried by the caller, a 404 isn't
      if (res.statusCode !== 200) { res.resume(); const ra = String(res.headers['retry-after'] || '').trim(); return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, retryAfter: /^\d+$/.test(ra) ? +ra : ra ? Math.max(0, (Date.parse(ra) - Date.now()) / 1000) || 0 : 0 })); }
      withTimers(req, res, reject, 20000, 60000);
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('timed out')));
  }), getJson);
}
// Downloads to dest.part then renames. onBytes(n) reports progress. Resolves false for a missing/tiny file.
function getFile(url, dest, hops = 0, opts = {}) {
  const { stall = 30000, deadline = 300000, onBytes } = opts;
  return limited(url, hops, url => new Promise((resolve, reject) => {
    let fail = reject; // once writing: also takes the .part away (a connection error left it behind, and it read as a manual page)
    const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve({ [REDIR]: new URL(res.headers.location, url).toString() }); }
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      const total = +res.headers['content-length'] || 0;
      const part = dest + '.part';
      const out = fs.createWriteStream(part); let n = 0, failed = false;
      fail = e => { if (failed) return; failed = true; try { out.destroy(); } catch {} try { fs.unlinkSync(part); } catch {} reject(e); };
      withTimers(req, res, fail, stall, deadline);
      res.on('data', c => { n += c.length; if (onBytes) onBytes(n, total); }); res.pipe(out);
      out.on('finish', () => out.close(() => { if (failed) return; if (n < 2048 || (total && n < total)) { try { fs.unlinkSync(part); } catch {} return resolve(false); } try { fs.renameSync(part, dest); resolve(true); } catch (e) { reject(e); } }));
      out.on('error', fail);
    });
    req.on('error', e => fail(e)); req.setTimeout(stall, () => req.destroy(new Error('timed out')));
  }), (u, h) => getFile(u, dest, h, opts));
}
// Runs fn over items with at most n in flight.
async function pool(items, n, fn) {
  let i = 0; const run = async () => { for (;;) { const k = i++; if (k >= items.length) return; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}
const fmtMB = n => (n / 1048576).toFixed(1) + ' MB';

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20 };
const ROMAN_RE = new RegExp('\\b(' + Object.keys(ROMAN).sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');
const norm = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an|of)\b/g, ' ').replace(ROMAN_RE, r => ROMAN[r]).replace(/\s+/g, ' ').trim();
const words = s => new Set(norm(s).split(' ').filter(w => w.length > 1 || /\d/.test(w))); /* keep sequel numbers: Black Ops 3 is not Black Ops II */
// How much of the game's title the archive item covers, penalised when the item is about something much broader or different
// (beta.9) words a manual's title may carry besides the game's name without counting as "something else"
const GENERIC = /^(manual|manuals|instruction|instructions|booklet|user|users|owner|owners|nintendo|sony|sega|wii|gamecube|psp|switch|ps1|ps2|ps3|ps4|ps5|psx|playstation|xbox|360|x360|microsoft|eng|english|usa|us|eu|europe|pal|ntsc|scan|scans|game|games|ds|nds|3ds|gba|snes|nes|n64|genesis|dreamcast|saturn|en)$/;
// (beta.9) a sequel number ends the name, or a part of it ("Black Ops 3", "Galaxy 2: …", "Mario Party 9 (USA)"): the manual
// must have it too. A number inside a name ("Call of Duty 7 Black Ops") isn't one, so its manual still matches without it.
function seqNums(t) { const out = new Set(); for (const part of String(t || '').split(/\s+[-–:]\s*|:\s*|\(/)) { const w = norm(part).split(' '), last = w[w.length - 1]; if (/^\d{1,2}$/.test(last)) out.add(last); } return out; }
function simParts(a, b) { const A = words(a), B = words(b); if (!A.size) return { recall: 0, noise: 0, wrongSequel: false };
  let hit = 0; for (const w of A) if (B.has(w)) hit++;
  const noise = [...B].filter(w => !A.has(w) && !GENERIC.test(w) && !/^\d{3,}$/.test(w)).length, /* (a year or a catalogue number isn't another game) */ got = [...B].filter(w => /^\d{1,2}$/.test(w)), want = [...A].filter(w => /^\d{1,2}$/.test(w));
  const wrongSequel = got.some(n => !A.has(n)) || (want.length && !want.every(n => B.has(n)) && got.length) || [...seqNums(a)].some(n => !B.has(n)); /* a different (or a missing) number = a different game */
  return { recall: hit / A.size, noise, wrongSequel }; }
function similarity(a, b) { const p = simParts(a, b); return p.recall * (p.noise >= 4 ? .45 : p.noise === 3 ? .6 : p.noise === 2 ? .8 : 1) * (p.wrongSequel ? .4 : 1); }

const PLATFORM_RE = { gc: /\b(game ?cube|gcn|ngc)\b/i, wii: /\bwii\b(?! ?u)/i, wiiu: /\bwii ?u\b/i, sw: /\bswitch\b/i, sw2: /\bswitch ?2\b/i, psp: /\b(psp|playstation portable)\b/i, ps2: /\b(ps2|playstation 2)\b/i, ps3: /\b(ps3|playstation 3)\b/i, ps4: /\b(ps4|playstation 4)\b/i, ps5: /\b(ps5|playstation 5)\b/i, x360: /\b(xbox ?360|x360)\b/i, pc: /\b(pc|windows|dos|mac)\b/i, xone: /\bxbox one\b/i, xbox: /\bxbox\b(?! ?(360|one))/i, ds: /\b(nds|nintendo ds)\b/i, n3ds: /\b(3ds|nintendo 3ds)\b/i,
  // (beta.6) the retro shelves (nds is the DS shelf's id; ds stays for uploads that name it)
  nds: /\b(nds|nintendo ds)\b/i, psx: /\b(playstation|psx|ps1)\b(?! ?[2-5])(?! portable)/i, nes: /\b(nes|famicom)\b/i, snes: /\b(snes|super nintendo|super famicom)\b/i,
  n64: /\b(n64|nintendo 64)\b/i, gb: /\bgame ?boy\b(?! ?(colou?r|advance))/i, gbc: /\b(game ?boy colou?r|gbc)\b/i, gba: /\b(game ?boy advance|gba)\b/i,
  megadrive: /\b(genesis|mega ?drive)\b/i, mastersystem: /\bmaster system\b/i, gamegear: /\bgame gear\b/i, dreamcast: /\bdreamcast\b/i, saturn: /\b(sega )?saturn\b/i, pcengine: /\b(turbografx(-16)?|pc[ -]?engine|tg-?16)\b/i, neogeo: /\bneo[ -]?geo\b/i, arcade: /\barcade\b/i, segacd: /\b(sega|mega)[ -]?cd\b/i, sega32x: /\b(sega )?32x\b/i, atari2600: /\batari 2600\b|\b2600\b/i, atarilynx: /\b(atari )?lynx\b/i, wonderswan: /\bwonderswan\b/i, ngpc: /\bneo[ -]?geo pocket( color)?\b|\bngp ?c?\b/i, dos: /\b(ms-?dos|dos)\b/i };
/* the title names a console and it isn't ours (Xbox 360's sibling "Xbox One" counts as other) */
function otherPlatform(sysId, t) { const own = PLATFORM_RE[sysId]; if (own && own.test(t)) return false; return Object.entries(PLATFORM_RE).some(([k, re]) => k !== sysId && re.test(t)); }
// (beta.9) the last resort's "same game on a sibling console": consoles of the same generation that shared releases. A
// manual naming any other console (the SNES All-Stars for the Wii one, a PC or handheld edition) isn't the same game's.
const SIBLINGS = { gc: ['ps2', 'xbox', 'wii'], wii: ['ps3', 'x360', 'ps2', 'gc'], ps2: ['gc', 'xbox'], ps3: ['x360', 'wii', 'ps4'], x360: ['ps3', 'wii', 'xone'], ps4: ['xone', 'ps5', 'ps3'] };
const ownName = (sysId, k) => k === sysId || (sysId === 'nds' && k === 'ds') || (sysId === 'ds' && k === 'nds');
function foreignPlatform(sysId, t, anyPlatform) { const own = PLATFORM_RE[sysId]; if (own && own.test(t)) return false; const ok = anyPlatform ? (SIBLINGS[sysId] || []) : [];
  return Object.entries(PLATFORM_RE).some(([k, re]) => !ownName(sysId, k) && !ok.includes(k) && re.test(t)); }
// (beta.9) uploads that aren't a game's manual at all: promotional booklets, posters, catalogues, a declassified report
const NOT_MANUAL = /promotional|\bpromo\b|poster|flyer|leaflet|catalog(ue)?|brochure|advert|press kit|newsletter|price ?list|reading room|cia-rdp|declassified|compliance|policy|for site|service manual|repair|schematic|walkthrough|cheat/i;
// One candidate's score for a game (searchArchive, and the re-check of manuals picked before): title match, language,
// console, what kind of upload it is
function scoreHit(sysId, title, t, o = {}) {
  const p = simParts(title, t), english = !o.lang || /^(eng|en|english)/.test(o.lang);
  let score = similarity(title, t) * 10;
  if (/mode d.emploi|spielanleitung|manuale|manual de|bedienungsanleitung/i.test(t)) score -= 3;
  if (!english) score -= 4;
  if (/manual|instruction|booklet/i.test(t)) score += 1;
  if (/guide|strategy|magazine|catalog|price/i.test(t)) score -= 3;
  if (NOT_MANUAL.test(t)) score -= 5;
  if (foreignPlatform(sysId, t, o.anyPlatform)) score -= 6; /* the PS3 or PC booklet is not this game's manual (a sibling console only as the last resort) */
  if (words(title).size <= 1 && p.noise >= 2) score -= 4; /* a one-word name ("Bloodborne") inside a longer, different title */
  score += Math.min(1, (+o.downloads || 0) / 500);
  return score;
}
const GDB_SYSTEM = { gc: 'nintendo-gamecube', wii: 'nintendo-wii', wiiu: 'nintendo-wii-u', psp: 'sony-psp', sw: 'nintendo-switch', ps3: 'sony-playstation-3', ps4: 'sony-playstation-4', ps2: 'sony-playstation-2', x360: 'microsoft-xbox-360', n3ds: 'nintendo-3ds', psx: 'sony-playstation', nes: 'nintendo-nes', snes: 'nintendo-snes', n64: 'nintendo-n64', gb: 'nintendo-game-boy', gbc: 'nintendo-game-boy-color', gba: 'nintendo-game-boy-advance', nds: 'nintendo-ds', megadrive: 'sega-genesis', mastersystem: 'sega-master-system', gamegear: 'sega-game-gear', dreamcast: 'sega-dreamcast', saturn: 'sega-saturn', pcengine: 'nec-turbografx-16', neogeo: 'snk-neo-geo-cd', arcade: 'arcade', segacd: 'sega-cd', sega32x: 'sega-32x', atari2600: 'atari-2600', atarilynx: 'atari-lynx', wonderswan: 'bandai-wonderswan', ngpc: 'snk-neo-geo-pocket-color', dos: 'microsoft-dos' }; // (beta.6: the retro shelves, each checked on gamesdatabase.org)
const LANG_NAMES = { eng: 'English', en: 'English', fre: 'French', fra: 'French', fr: 'French', ger: 'German', deu: 'German', de: 'German', spa: 'Spanish', es: 'Spanish', ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese', por: 'Portuguese', dut: 'Dutch', nld: 'Dutch' };
function getText(url, hops = 0) {
  return limited(url, hops, url => new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve({ [REDIR]: new URL(res.headers.location, url).toString() }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      withTimers(req, res, () => resolve(''), 15000, 40000);
      let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); }); res.on('end', () => resolve(b)); res.on('close', () => resolve(b));
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timed out')));
  }), getText);
}
// GamesDatabase.org keeps one English PDF manual per game. Its page addresses come from the title,
// so we try a few spellings until one exists.
function gdbSlugs(title) {
  const t = title.replace(/\s*\(.*?\)/g, '');
  const base = t.toLowerCase().replace(/&/g, 'and').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');
  const out = new Set([base.replace(/-+$/, ''), base.replace(/-+$/, '') + '-', base]);
  const dash = t.toLowerCase().replace(/&/g, 'and').replace(/['’]/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''); out.add(dash); /* GamesDatabase writes Assassin's as assassin-s */
  const m = t.match(/^(The|A)\s+(.*)$/i); if (m) { out.add(gdbSlugs(m[2]).values().next().value); const parts = m[2].split(/\s+-\s+/); out.add(gdbSlugs(`${parts[0]} the${parts.length > 1 ? ' - ' + parts.slice(1).join(' - ') : ''}`).values().next().value); }
  const m2 = t.match(/^(.*?),\s*(The|A)(\s*-\s*.*)?$/i); if (m2) out.add(gdbSlugs(`${m2[2]} ${m2[1]}${m2[3] || ''}`).values().next().value);
  return [...out].filter(Boolean);
}
async function searchGamesDatabase(sysId, title) {
  const sys = GDB_SYSTEM[sysId]; if (!sys) return null;
  const slugs = gdbSlugs(title);
  const pages = await Promise.all(slugs.map(slug => getText(`https://www.gamesdatabase.org/game/${sys}/${slug}`).then(html => ({ slug, html })).catch(() => null)));
  for (const p of pages) {
    if (!p || !p.html || /Game Not Found/i.test(p.html)) continue;
    const m = p.html.match(/href="([^"]*\/Manual\/[^"]+\.pdf)"/i);
    if (!m) return null;
    const url = m[1].startsWith('http') ? m[1] : 'https://www.gamesdatabase.org' + m[1];
    const name = decodeURIComponent(path.basename(url)).replace(/\.pdf$/i, '').replace(/_/g, ' ');
    // (beta.9) the page is this console's, but the PDF on it can be another edition's ("…GOTY PC Game Manual" on an Xbox 360
    // page): still offered to pick by hand, never taken automatically
    const foreign = foreignPlatform(sysId, name, false) || NOT_MANUAL.test(name);
    return { id: 'gdb:' + url, title: name, language: 'eng', pages: 0, score: foreign ? 5 : 9.5, source: 'GamesDatabase (PDF)', thumb: '', url: `https://www.gamesdatabase.org/game/${sys}/${p.slug}` };
  }
  return null;
}

// Search archive.org for one game's manual. Returns up to 5 candidates, best first.
const ROMAN_OUT = { 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X', 11: 'XI', 12: 'XII', 13: 'XIII' };
function altNumbers(t) {
  const roman = t.replace(/\b(XIII|XII|XI|IX|VIII|VII|VI|IV|V|III|II)\b/g, r => String(ROMAN[r.toLowerCase()] || r));
  if (roman !== t) return roman.replace(/\s*:\s*/g, ' ');
  const dig = t.replace(/\b([2-9]|1[0-3])\b/g, d => ROMAN_OUT[d] || d); return dig !== t ? dig : null;
}
async function search(sysId, title, opts = {}) {
  let iaErr = null;
  const [gdb, ia] = await Promise.all([searchGamesDatabase(sysId, title).catch(e => { log('GDB search error', title, e.message); return null; }), searchArchive(sysId, title).catch(e => { iaErr = e; return []; })]);
  if (iaErr && !gdb) throw iaErr; /* couldn't ask: not the same as 'nothing found' */
  log('Manual candidates', sysId, title, '→ gdb:', gdb ? 'yes' : 'no', 'archive:', ia.length);
  let all = gdb ? [gdb, ...ia] : ia;
  // nothing: try the number the other way round once ("Black Ops III" <-> "Black Ops 3")
  if (!all.length && !opts.alt) { const alt = altNumbers(title); if (alt && alt !== title) { log('Manual: trying', alt); return search(sysId, alt, { alt: true }); } }
  // bundles ("Wii Sports + Wii Sports Resort"): fall back to the first game's manual. (beta.9) Only "+": "&" is part of
  // most names ("Gallop & Ride!" was looked up as "Gallop" and got Gallop Racer's manual)
  if (!all.length && /\s\+\s/.test(title)) { const first = title.split(/\s\+\s/)[0]; if (words(first).size >= 2) { log('Manual: trying bundle part', first); return search(sysId, first, opts); } }
  return all.map(c => ({ ...c, languageName: LANG_NAMES[c.language] || (c.language ? c.language : (c.source ? 'English' : 'unknown')), english: !c.language || /^(eng|en)/.test(c.language) })).slice(0, 6);
}
async function searchArchive(sysId, title, opts = {}) {
  const sysWords = SYSTEM_WORDS[sysId] || [];
  // (beta.3) a console without words (Switch 2 and PS5 had none) searches every upload: "AND ()" was a broken query that
  // archive.org answered without a results list, so every one of those games failed and was retried daily for ever
  const q = `(${JSON.stringify(title.replace(/"/g, ''))}) AND mediatype:texts AND (manual OR instruction OR booklet)` + (opts.anyPlatform || !sysWords.length ? '' : ` AND (${sysWords.map(w => JSON.stringify(w)).join(' OR ')})`);
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=language&fl[]=imagecount&fl[]=downloads&rows=12&output=json`;
  let docs = [];
  try { const j = await getJson(url); docs = (j && j.response && j.response.docs) || []; } catch (e) { log('Manual search failed', title, e.message); if (e instanceof TypeError || e instanceof SyntaxError) return []; /* (beta.9) an answer that wasn't a results list: nothing found, not "offline" (it was retried every day for ever) */ if (!/^HTTP 4\d\d$/.test(e.message) || /429/.test(e.message)) throw e; return []; } /* offline / busy: a retry tomorrow, not 'no manual' for a month */
  if (!docs.length) {
    // Second try: uploads that don't mention the console, matched on the title alone.
    const q2 = `title:(${JSON.stringify(title.replace(/"/g, ''))}) AND mediatype:texts AND (manual OR instruction OR booklet)`;
    try { docs = (await getJson(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q2)}&fl[]=identifier&fl[]=title&fl[]=language&fl[]=imagecount&fl[]=downloads&rows=12&output=json`)).response.docs || []; } catch {}
  }
  if (!docs.length) {
    // Third try: plain words, any media type that holds page images
    const q3 = `${title.replace(/[^\w\s]/g, ' ')} ${sysWords[0] || ''} manual AND (mediatype:texts OR mediatype:image)`;
    try { docs = (await getJson(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q3)}&fl[]=identifier&fl[]=title&fl[]=language&fl[]=imagecount&fl[]=downloads&rows=12&output=json`)).response.docs || []; } catch {}
  }
  const lang = l => String(Array.isArray(l) ? l[0] : l || '').toLowerCase();
  if (docs.length) log('Archive raw hits', title, docs.length, docs.slice(0, 3).map(d => d.title).join(' | '));
  return docs.map(d => {
    const t = String(d.title || ''), lg = lang(d.language);
    const score = scoreHit(sysId, title, t, { lang: lg, anyPlatform: !!opts.anyPlatform, downloads: d.downloads });
    return { id: d.identifier, title: t, language: lg || '', pages: +d.imagecount || 0, score, source: 'Internet Archive', thumb: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`, url: `https://archive.org/details/${encodeURIComponent(d.identifier)}` };
  }).filter(c => c.score >= 4).sort((a, b) => b.score - a.score).slice(0, 5);
}

// Find candidates for every game on the shelves given. progress({done,total,stage}).
async function findAll(systems, progress, token) {
  let done = 0; const all = [];
  for (const { def, cfg } of systems) { await new Promise(r => setImmediate(r)); for (const g of scanSystem(def, cfg)) all.push({ def, cfg, g }); } // (beta.9: a breath between consoles)
  const out = new Array(all.length), per = {}, perDone = {}; all.forEach(x => { per[x.def.id] = (per[x.def.id] || 0) + 1; perDone[x.def.id] = 0; });
  const ls = require('./dircache').lister(); // each folder listed once for the whole search, not once per game
  await pool(all, 3, async ({ def, cfg, g }, k) => {
    if (token && token.cancelled) { out[k] = null; return; }
    if (k && k % 25 === 0) await new Promise(r => setImmediate(r));
    const dir = artDir(cfg, g.file), base = artBase(g.file);
    const have = hasManual(dir, base, ls); // a downloaded PDF waiting to be turned into pages counts too
    let candidates = [];
    if (!have) { try { candidates = await search(def.id, g.title); } catch (e) { log('Manual search error', g.title, e.message); } await new Promise(r => setTimeout(r, 200)); }
    out[k] = { systemId: def.id, system: def.name, title: g.title, file: g.file, have, candidates };
    done++; perDone[def.id]++; progress({ stage: `Searching manuals… ${done} of ${all.length}`, done, total: all.length, systemId: def.id, system: def.name, sysDone: perDone[def.id], sysTotal: per[def.id], game: g.title });
  });
  return out.filter(Boolean);
}

const artDir = manualDirFor; // manuals: Art\<console>\manuals with an art library, else beside the box art

// (beta.9) a loose image in an upload that is one of its pages: an original file (not archive.org's own derivative), not a
// thumbnail or tile, more than a thumbnail's few KB, and small enough to show
const PAGE_MAX_BYTES = 80 * 1048576;
function isPageImage(f) {
  if (!f || !/\.(jpe?g|png)$/i.test(f.name)) return false;
  if (/__ia_thumb|_thumb\.|\.thumbs\/|_itemimage|(^|\/)thumb/i.test(f.name)) return false;
  if (f.source && f.source !== 'original') return false;
  if (/thumbnail|item tile|spectrogram/i.test(String(f.format || ''))) return false;
  const size = +f.size || 0; if (size && (size < 15000 || size > PAGE_MAX_BYTES)) return false;
  return true;
}
// (beta.9) pages wider than this are made smaller after downloading (in the background image window: decoding a huge scan
// on the main process froze the app), so the reader never holds a 500 MB picture
const PAGE_MAX_W = 3000;
let shrinker = null; // (file, width) -> JPEG Buffer, set by main.js
function setShrink(fn) { shrinker = typeof fn === 'function' ? fn : null; }
async function shrinkPages(dir, base) {
  if (!shrinker) return 0; const pre = (base + '-manual-').toLowerCase(); let n = 0, names = [];
  try { names = (await fs.promises.readdir(dir)).filter(f => f.toLowerCase().startsWith(pre) && /-manual-\d+\.(jpe?g|png)$/i.test(f)); } catch { return 0; }
  for (const f of names) {
    const full = path.join(dir, f), z = require('./spreads').sizeOf(full); if (!z || z[0] <= PAGE_MAX_W) continue;
    let buf = null; try { buf = await shrinker(full, PAGE_MAX_W); } catch {} if (!buf || buf.length < 1000) continue;
    const out = full.replace(/\.(jpe?g|png)$/i, '.jpg'), tmp = out + '.tmp';
    try { await fs.promises.writeFile(tmp, buf); await fs.promises.rename(tmp, out); if (out !== full) await fs.promises.unlink(full).catch(() => {}); n++; }
    catch { fs.promises.unlink(tmp).catch(() => {}); }
    await breath();
  }
  if (n) log('Manual', base, 'made', n, 'oversized pages smaller');
  return n;
}
// Download one chosen manual as page images.
async function fetchManual(id, dir, base, progress) {
  const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  const files = meta.files || [];
  const jp2 = files.find(f => /_jp2\.zip$/i.test(f.name));
  fs.mkdirSync(dir, { recursive: true });
  let saved = 0; const made = [];
  // A manual with pages missing in the middle isn't kept: saved, it counted as "has a manual" and was never fetched again.
  // This run's pages go, and the error is remembered like any failed download (tried again a day later).
  const gaps = (n, of) => { for (const f of made) { try { fs.unlinkSync(f); } catch {} } throw new Error(`only ${n} of ${of} pages came down`); };
  if (jp2) {
    const stem = jp2.name.replace(/_jp2\.zip$/i, '');
    let pages = +(meta.metadata && meta.metadata.imagecount) || 0;
    if (!pages) { const pn = files.find(f => /_page_numbers\.json$/i.test(f.name)); if (pn) { try { pages = ((await getJson(`https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(pn.name)}`)).pages || []).length; } catch {} } }
    if (!pages) { const sd = files.find(f => /_scandata\.xml$/i.test(f.name)); if (sd) { try { const tmp = path.join(dir, `.${base}-scandata.tmp`); if (await getFile(`https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(sd.name)}`, tmp)) { pages = (fs.readFileSync(tmp, 'utf8').match(/<page\s/g) || []).length; fs.unlinkSync(tmp); } } catch {} } }
    const total = Math.min(pages || 40, MAX_PAGES);
    log('Manual', base, id, 'pages:', pages || 'unknown', '-> fetching', total);
    const results = new Array(total).fill(false);
    let next = 0, todo = [...results.keys()];
    const worker = async () => {
      for (;;) {
        const k = next++; if (k >= todo.length) return; const i = todo[k];
        const dest = path.join(dir, `${base}-manual-${String(i + 1).padStart(2, '0')}.jpg`);
        if (isFile(dest)) { results[i] = true; continue; }
        made.push(dest);
        let ok = false;
        try { ok = await getFile(`https://archive.org/download/${encodeURIComponent(id)}/page/n${i}_w${PAGE_WIDTH}.jpg`, dest, 0, { stall: 20000, deadline: 60000 }); } catch {}
        if (!ok) {
          const inner = `${stem}_jp2/${stem}_${String(i).padStart(4, '0')}.jp2`;
          try { ok = await getFile(`https://${meta.server}/BookReader/BookReaderImages.php?zip=${encodeURIComponent(meta.dir + '/' + jp2.name)}&file=${encodeURIComponent(inner)}&id=${encodeURIComponent(id)}&scale=2&rotate=0`, dest, 0, { stall: 20000, deadline: 60000 }); } catch {}
        }
        results[i] = ok;
        const done = results.filter(Boolean).length;
        progress({ stage: `${base}: page ${done} of ${total}` });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    // pages that didn't come down (archive.org's 429s / 5xx, timeouts) get one more go, a few seconds later
    if (pages && results.some(r => !r)) { await new Promise(r => setTimeout(r, 3000)); todo = [...results.keys()].filter(i => !results[i]); next = 0; await Promise.all(Array.from({ length: 2 }, worker)); }
    // When the page count was a guess, drop repeated trailing pages (the server repeats the last page past the end).
    if (!pages) {
      const crypto = require('crypto');
      let lastHash = null;
      for (let i = 0; i < total; i++) {
        const f = path.join(dir, `${base}-manual-${String(i + 1).padStart(2, '0')}.jpg`);
        if (!isFile(f)) continue;
        const h = crypto.createHash('md5').update(await fs.promises.readFile(f)).digest('hex');
        if (h === lastHash) { fs.unlinkSync(f); results[i] = false; } else lastHash = h;
      }
    }
    saved = results.filter(Boolean).length;
    if (pages && saved < total) gaps(saved, total);
  } else {
    // Some uploads are loose images. (beta.9) Only the uploader's own scans: archive.org adds thumbnails and tiles of its
    // own (a 96 px "page" opened a manual), and a scan too big to show (a 186 MB, 13000 px board) is left out
    const imgs = files.filter(isPageImage).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, MAX_PAGES);
    const skipped = files.filter(f => /\.(jpe?g|png)$/i.test(f.name) && !isPageImage(f)).length; if (skipped) log('Manual', base, id, 'left out', skipped, 'thumbnails or oversized images');
    for (let i = 0; i < imgs.length; i++) {
      const dest = path.join(dir, `${base}-manual-${String(i + 1).padStart(2, '0')}${path.extname(imgs[i].name).toLowerCase()}`);
      if (isFile(dest)) { saved++; continue; } made.push(dest);
      let ok = false; for (let t = 0; t < 2 && !ok; t++) { if (t) await new Promise(r => setTimeout(r, 3000)); try { ok = await getFile(`https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(imgs[i].name)}`, dest); } catch {} }
      if (ok) saved++;
      progress({ stage: `${base}: page ${i + 1} of ${imgs.length}` });
    }
    if (saved < imgs.length) gaps(saved, imgs.length);
  }
  return saved;
}

// choices: [{systemId, file, id}]
async function downloadChosen(systems, choices, progress) {
  const report = [];
  const active = new Map(); let finished = 0;
  const say = () => progress({ stage: `${finished} of ${choices.length} done · ` + [...active.values()].join(' · ') });
  await pool(choices, 3, async c => {
    const sys = systems.find(s => s.def.id === c.systemId); if (!sys) { finished++; return; }
    const base = artBase(c.file), dir = artDir(sys.cfg, c.file);
    active.set(c.file, `${base}: starting…`); say();
    const sub = ({ stage }) => { active.set(c.file, stage); say(); };
    try {
      if (c.id.startsWith('gdb:')) {
        // only a PDF on GamesDatabase (what searchGamesDatabase offers): the id comes from the screen, so never any other address
        let u = null; try { u = new URL(c.id.slice(4)); } catch {}
        if (!u || !/^https?:$/.test(u.protocol) || !/^(www\.)?gamesdatabase\.org$/i.test(u.hostname) || !/\.pdf$/i.test(u.pathname)) throw new Error('Not a GamesDatabase manual.');
        fs.mkdirSync(dir, { recursive: true });
        const pdf = path.join(dir, `${base}-manual.pdf`);
        let last = 0;
        const ok = await getFile(c.id.slice(4), pdf, 0, { stall: 30000, deadline: 600000, onBytes: (n, t) => { if (n - last > 262144) { last = n; sub({ stage: `${base}: ${fmtMB(n)}${t ? ' of ' + fmtMB(t) : ''}` }); } } });
        report.push({ file: c.file, pages: ok ? -1 : 0, pdf: ok ? pdf : null, error: ok ? undefined : 'download failed' });
        log('Manual PDF', base, c.id.slice(4), ok ? 'saved' : 'failed');
      } else {
        const n = await fetchManual(c.id, dir, base, sub); if (n) await shrinkPages(dir, base); report.push({ file: c.file, pages: n }); log('Manual', base, c.id, n, 'pages');
      }
    }
    catch (e) { report.push({ file: c.file, pages: 0, error: e.message }); log('Manual ERROR', base, c.id, e.message); }
    active.delete(c.file); finished++; say();
  });
  return report;
}

// Pages rendered from a PDF by the app (JPEG data URLs) -> <base>-manual-NN.jpg
// done: the conversion is over and the PDF may go. complete says whether every page of the PDF was drawn: false (or a
// page count higher than what was saved) keeps the PDF, so a renderer that stopped early doesn't cost the rest of the
// manual; left out, the PDF goes as before.
// pages are written one at a time, letting everything else run in between (a whole manual written in one go held the
// app up for up to a second while manuals came in)
const breath = () => new Promise(r => setImmediate(r));
// a write that fails half-way (disk full) takes this run's pages back out: a partial manual would look finished and its
// PDF would never be converted again
async function writePages(dir, base, pages) { let n = 0; const made = [];
  try { for (let i = 0; i < (pages || []).length; i++) { const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(pages[i]); if (!m) continue; const f = path.join(dir, `${base}-manual-${String(i + 1).padStart(2, '0')}.${m[1] === 'png' ? 'png' : 'jpg'}`); made.push(f); const tmp = f + '.part'; try { await fs.promises.writeFile(tmp, Buffer.from(m[2], 'base64')); await fs.promises.rename(tmp, f); } catch (e) { await fs.promises.unlink(tmp).catch(() => {}); throw e; } n++; await breath(); } } // (beta.12) temp + rename: a crash mid-page leaves no cut-off page that counts as a manual
  catch (e) { for (const f of made) await fs.promises.unlink(f).catch(() => {}); throw e; }
  return n; }
async function savePages(cfg, file, pages, done, complete) {
  const dir = artDir(cfg, file), base = artBase(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const n = await writePages(dir, base, pages);
  const whole = complete === undefined || complete === true || (typeof complete === 'number' && n >= complete);
  if (done && n && whole) { try { fs.unlinkSync(path.join(dir, `${base}-manual.pdf`)); } catch {} }
  return n;
}

// ---------- automatic: confident English matches only, misses remembered for a month ----------
const AUTO_MIN = 7, AUTO_RETRY = 30 * 864e5, AUTO_MAX = 40, AUTO_V = 4; /* (beta.9: 4, the stricter matching) */
const LAST_RESORT = new Set(['gc', 'wii', 'ps2', 'ps3', 'x360', 'ps4']); /* home consoles share multi-platform releases (AUTO_V: bump when matching improves, so earlier misses get another look) */
let autoFile = null, autoMemo = null;
function setStore(file) { autoFile = file; autoMemo = null; }
function memo() { if (autoMemo) return autoMemo; try { autoMemo = JSON.parse(fs.readFileSync(autoFile, 'utf8')); } catch { autoMemo = {}; } return autoMemo; }
function saveMemo() { if (!autoFile || !autoMemo) return; try { fs.writeFileSync(autoFile + '.tmp', JSON.stringify(autoMemo)); fs.renameSync(autoFile + '.tmp', autoFile); } catch {} }
// per console: games, how many have a manual, and how many of those are small scans (first page under 1200 px wide)
// (beta.10) async, and each folder indexed once (manualIndex): filtering the whole shared covers folder for every game was
// games x files on the main process, seconds for a big console
async function coverage(systems) {
  const { scanSystemAsync } = require('./scanner'), { artBase, manualDirFor: artDirFor } = require('./paths'), { sizeOfAsync } = require('./spreads');
  const out = []; let t0 = Date.now(); const breath = async () => { if (Date.now() - t0 > 25) { await new Promise(r => setImmediate(r)); t0 = Date.now(); } };
  for (const { def, cfg } of systems) {
    const games = await scanSystemAsync(def, cfg), r = { id: def.id, name: def.name, total: games.length, have: 0, low: 0 };
    const index = new Map();
    for (const g of games) { await breath(); const dir = artDirFor(cfg, g.file), base = artBase(g.file).toLowerCase(); if (!index.has(dir)) { let names = []; try { names = await fs.promises.readdir(dir); } catch {} index.set(dir, manualIndex(names)); }
      const files = index.get(dir).get(base) || [];
      if (!files.length) continue; r.have++;
      const first = files.filter(f => /\.(jpe?g|png)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
      const z = first && await sizeOfAsync(path.join(dir, first)); if (z && z[0] < 1200) r.low++; }
    out.push(r);
  }
  return out;
}
// (beta.10) a folder's manual files by lowercase game base, in listing order: exactly the names isManualFile(f, base + '-manual')
// accepts. An image counts for every base it starts with "<base>-manual-" for (each "-manual-" in the name), a pdf for one.
function manualIndex(names) {
  const m = new Map(), add = (b, f) => { const a = m.get(b); if (a) a.push(f); else m.set(b, [f]); };
  for (const f of names) { const l = f.toLowerCase();
    if (l.endsWith('-manual.pdf')) add(l.slice(0, -11), f);
    else if (/\.(jpe?g|png|webp)$/.test(l)) for (let i = l.indexOf('-manual-'); i >= 0; i = l.indexOf('-manual-', i + 1)) add(l.slice(0, i), f); }
  return m;
}
// <base>-manual-NN.jpg / .png / .webp pages (the image types the scanner shows as manual pages), or <base>-manual.pdf. Only
// finished files: a page still downloading (or left by one that broke off) is a .part, and counted as a manual it kept the
// game from ever getting one. pre: lowercase "<base>-manual"
const isManualFile = (f, pre) => { const l = f.toLowerCase(); return (l.startsWith(pre + '-') && /\.(jpe?g|png|webp)$/.test(l)) || l === pre + '.pdf'; };
function hasManual(dir, base, ls) {
  if (ls && ls.derived) return ls.derived(dir, 'manuals', manualIndex).has(base.toLowerCase()); // (beta.10) a run's lister: the folder's index, built once
  const pre = (base + '-manual').toLowerCase();
  return (ls || require('./dircache').fresh).names(dir).some(f => isManualFile(f, pre));
}
// systems: [{def,cfg}] · skip(def) leaves out shelves that get manuals another way (Wii U reads its own)
async function autoFetch(systems, opts = {}) {
  const m = memo(), now = Date.now(), todo = [], ls = require('./dircache').lister(); let nG = 0;
  for (const { def, cfg } of systems) {
    if (opts.skip && opts.skip(def)) continue;
    await new Promise(r => setImmediate(r)); // (beta.9) a breath between consoles: every console's scan in one go held up the main process
    for (const g of scanSystem(def, cfg)) {
      if (g.extra) continue;
      if (++nG % 25 === 0) await new Promise(r => setImmediate(r));
      const dir = artDir(cfg, g.file), base = artBase(g.file), key = def.id + '|' + g.file.toLowerCase();
      if (hasManual(dir, base, ls)) continue;
      if (opts.locked && opts.locked(def.id, g.file)) continue; // Manual Studio: a game whose manual was chosen by hand (or set to none) is left alone
      const seen = m[key]; if (seen && seen.v === AUTO_V && now - seen.at < (seen.err ? 864e5 : AUTO_RETRY)) continue;
      todo.push({ def, cfg, g, key });
    }
  }
  if (!todo.length) return { searched: 0, got: 0 };
  const batch = todo.slice(0, AUTO_MAX), picks = [];
  log('Auto manuals: searching', batch.length, 'of', todo.length, 'games without one');
  await pool(batch, 2, async ({ def, g, key }) => {
    if (opts.idle) await opts.idle();
    if (opts.cancelled && opts.cancelled()) return;
    let c = [];
    try { c = await search(def.id, g.title); } catch (e) { m[key] = { v: AUTO_V, at: Date.now(), err: e.message }; return; }
    let best = prefPick(c, opts.prefFor ? opts.prefFor(def.id) : 'best', key); // Manual Studio: the console's language / region choice (default: best English, as before)
    // last resort: nothing for this console anywhere. A multi-platform game's manual from a sibling console (same
    // game, only the controls page differs) beats having none; exact title matches only, brand prefix dropped
    if (!(best && best.score >= AUTO_MIN) && LAST_RESORT.has(def.id)) {
      const t2 = g.title.replace(/^(nickelodeon|disney[- ]pixar|disney's|disney|pixar|dreamworks|cartoon network|mtv)\s+/i, '');
      try { const alt = (await searchArchive(def.id, t2, { anyPlatform: true })).filter(x => !/^(eng|en|english|)$/i.test(x.language) ? false : similarity(t2, x.title) >= .95 && !isRejected(key, x.id));
        if (alt.length && alt[0].score >= AUTO_MIN) { best = alt[0]; log('Auto manuals: no', def.id, 'manual for', g.title, '- using the same game\'s manual from another console:', best.title); } } catch {}
    }
    if (best && best.score >= AUTO_MIN) picks.push({ systemId: def.id, file: g.file, id: best.id, key, title: best.title });
    else m[key] = { v: AUTO_V, at: Date.now(), none: true, best: best ? best.title + ' (' + best.score.toFixed(1) + ')' : '' };
    await new Promise(r => setTimeout(r, 300));
  });
  saveMemo();
  let got = 0;
  if (picks.length && !(opts.cancelled && opts.cancelled())) {
    picks.forEach(p => log('Auto manuals: picked', p.file.split(/[\\/]/).pop(), '->', p.title));
    if (opts.idle) await opts.idle();
    const rep = await downloadChosen(systems, picks, opts.progress || (() => {}));
    for (const r of rep) { const p = picks.find(x => x.file === r.file); if (!p) continue; if (r.pages) { got++; m[p.key] = { v: AUTO_V, at: Date.now(), got: p.id, title: p.title }; } else m[p.key] = { v: AUTO_V, at: Date.now(), err: r.error || 'no pages' }; }
    saveMemo();
  }
  log('Auto manuals done: searched', batch.length, 'downloaded', got);
  return { searched: batch.length, got };
}

// ---------- (beta.9) one look over the manuals already on the shelves, with the stricter rules ----------
// A manual the automatic search picked that the new rules wouldn't (another game, another console, not a manual), or one
// with thumbnail "pages" in it, is moved aside into .manual-originals (never deleted), and the game is looked up again. A
// wrong match is remembered so it's never picked again. Left alone: manuals chosen by hand (Manual Studio, or picked
// from the search), from a scan collection (opts.collInfo), and Wii U's own e-manuals. Runs once per RECHECK_V.
const RECHECK_V = 1;
async function recheck(systems, opts = {}) {
  // (beta.9) opts.force: again on demand (Settings → Get manuals → Check my manuals); opts.progress({ system, sysDone,
  // sysTotal, checked, moved, shrunk }) once per console
  const m = memo(); if (m.__recheck === RECHECK_V && !opts.force) return { checked: 0, moved: 0, shrunk: 0 };
  const ls = require('./dircache').lister(), { backupDir, sizeOf } = require('./spreads'); let checked = 0, moved = 0, shrunk = 0, sysDone = 0; const list = []; // (list: the games set aside, { sysId, file })
  for (const { def, cfg } of systems) {
    sysDone++; if (def.id === 'wiiu') continue;
    await breath(); if (opts.idle) await opts.idle(); if (opts.cancelled && opts.cancelled()) return { checked, moved, shrunk, list, cancelled: true };
    if (opts.progress) { try { opts.progress({ system: def.name || def.id, sysDone, sysTotal: systems.length, checked, moved, shrunk }); } catch {} }
    let games = []; try { games = scanSystem(def, cfg); } catch { continue; }
    for (const g of games) {
      const key = def.id + '|' + g.file.toLowerCase(), seen = m[key], dir = artDir(cfg, g.file), base = artBase(g.file);
      if (!hasManual(dir, base, ls)) continue;
      if (opts.locked && opts.locked(def.id, g.file)) continue;
      // pages too big to show (a 13000 px scan) are made smaller, whatever the manual's source (two pages tell)
      if (shrinker) { const pre0 = (base + '-manual-').toLowerCase(), first = ls.names(dir).filter(f => f.toLowerCase().startsWith(pre0) && /\.(jpe?g|png)$/i.test(f)).slice(0, 2);
        if (first.some(f => { const z = sizeOf(path.join(dir, f)); return z && z[0] > PAGE_MAX_W; })) { await shrinkPages(dir, base); ls.forget(dir); shrunk++; } }
      const coll = opts.collInfo ? opts.collInfo(key) : null; if (coll && coll.src) continue;
      if (seen && seen.hand) continue;
      checked++; let why = '', wrong = false;
      if (seen && seen.got && seen.title) {
        const gdb = String(seen.got).startsWith('gdb:');
        if (gdb) { if (foreignPlatform(def.id, seen.title, false) || NOT_MANUAL.test(seen.title)) { why = `"${seen.title}" is another edition's`; wrong = true; } }
        else {
          // the score the search would give it now; a last-resort pick (the same game on a sibling console) as the last resort scores it
          let s = scoreHit(def.id, g.title, seen.title, {});
          if (LAST_RESORT.has(def.id)) { const t2 = g.title.replace(/^(nickelodeon|disney[- ]pixar|disney's|disney|pixar|dreamworks|cartoon network|mtv)\s+/i, ''); if (similarity(t2, seen.title) >= .95) s = Math.max(s, scoreHit(def.id, t2, seen.title, { anyPlatform: true })); }
          if (s < AUTO_MIN - 1) { why = `"${seen.title}" doesn't match (${s.toFixed(1)})`; wrong = true; } // (a point of leeway: a borderline match that was fine stays)
        }
      }
      if (!why) { const pre = (base + '-manual-').toLowerCase(), pages = ls.names(dir).filter(f => f.toLowerCase().startsWith(pre) && /\.(jpe?g|png|webp)$/i.test(f));
        const tiny = pages.filter(f => { const z = sizeOf(path.join(dir, f)); return z && z[0] < 300; }).length;
        if (tiny) why = `${tiny} thumbnail page${tiny === 1 ? '' : 's'}`; }
      if (!why) continue;
      const pre = base.toLowerCase() + '-manual', files = ls.names(dir).filter(f => { const l = f.toLowerCase(); return l.startsWith(pre + '-') || l === pre + '.pdf'; });
      if (!files.length) continue;
      let keep = null; const done = [];
      try { keep = backupDir(dir, base); for (const f of files) { fs.renameSync(path.join(dir, f), path.join(keep, f)); done.push(f); } }
      catch (e) { for (const d of done) { try { fs.renameSync(path.join(keep, d), path.join(dir, d)); } catch {} } log('Manual re-check:', g.title, '- could not move it aside:', e.code || e.message); continue; }
      ls.forget(dir);
      if (wrong && seen && seen.got && rejFile) { const rj = rejects(); rj[key] = [...new Set([...(rj[key] || []), String(seen.got)])]; try { fs.writeFileSync(rejFile + '.tmp', JSON.stringify(rj)); fs.renameSync(rejFile + '.tmp', rejFile); } catch {} }
      delete m[key]; moved++; list.push({ sysId: def.id, file: g.file });
      log('Manual re-check:', g.title, '-', why, '- set aside in .manual-originals, looking again');
      await breath();
    }
  }
  m.__recheck = RECHECK_V; saveMemo();
  if (checked) log('Manual re-check: looked at', checked, 'manuals, set aside', moved, shrunk ? `, made ${shrunk} smaller` : '');
  return { checked, moved, shrunk, list };
}

// ---------- language and region (Manual Studio): what a candidate is, and what a console asked for ----------
// codes: en fr de es it ja pt nl. From archive.org's language field (eng / English / "eng;fre"), else the title's own words
const LANG2 = { eng: 'en', en: 'en', english: 'en', fre: 'fr', fra: 'fr', fr: 'fr', french: 'fr', francais: 'fr', ger: 'de', deu: 'de', de: 'de', german: 'de', deutsch: 'de', spa: 'es', es: 'es', spanish: 'es', espanol: 'es', ita: 'it', it: 'it', italian: 'it', italiano: 'it', jpn: 'ja', ja: 'ja', jp: 'ja', japanese: 'ja', por: 'pt', pt: 'pt', portuguese: 'pt', dut: 'nl', nld: 'nl', nl: 'nl', dutch: 'nl' };
function langCode(raw, title) {
  for (const w of String(Array.isArray(raw) ? raw.join(';') : raw || '').toLowerCase().split(/[^a-z]+/)) if (LANG2[w]) return LANG2[w];
  const t = String(title || '');
  if (/mode d.emploi|notice|livret/i.test(t)) return 'fr'; if (/spielanleitung|bedienungsanleitung|anleitung/i.test(t)) return 'de';
  if (/manuale|istruzioni/i.test(t)) return 'it'; if (/manual de instrucciones|instrucciones/i.test(t)) return 'es'; if (/取扱説明書|説明書/.test(t)) return 'ja';
  return '';
}
function regionOf(text) {
  const t = String(text || '');
  if (/\b(pal|eur|europe|european|uk|australia|aus)\b/i.test(t)) return 'eur';
  if (/\b(jpn|japan|japanese|ntsc[- ]?j)\b/i.test(t)) return 'jpn';
  if (/\b(usa|us|ntsc[- ]?u|ntsc|north america|canada)\b/i.test(t)) return 'usa';
  return '';
}
// does a candidate ({lang, region}, or a search hit with language/title) give what the console's choice asks for?
// 'best' = English (unknown language counts as English, as the search always did); 'lang:xx'; 'region:eur' = English from
// Europe (PAL); 'region:jpn' = Japanese
function prefMatch(c, pref) {
  const lang = c.lang != null ? c.lang : langCode(c.language, c.title), region = c.region != null ? c.region : regionOf(c.title), en = !lang || lang === 'en';
  if (!pref || pref === 'best') return en;
  const m = /^lang:([a-z]{2})$/.exec(pref); if (m) return lang === m[1];
  if (pref === 'region:eur') return en && region === 'eur';
  if (pref === 'region:jpn') return lang === 'ja' || region === 'jpn';
  return en;
}
// the automatic pick for a console's choice: the best match that gives it (a non-English match gets back the search's
// language penalty, so a good French copy can pass AUTO_MIN for a French shelf); none → the best English one, so a game
// still gets a manual. 'best' is exactly the old rule.
function prefPick(list, pref, key) {
  const ok = x => !isRejected(key, x.id);
  if (!pref || pref === 'best') return list.find(x => x.english !== false && ok(x));
  const hit = list.filter(x => ok(x) && prefMatch(x, pref)).map(x => ({ ...x, score: x.score + (x.english === false ? 4 : 0) })).sort((a, b) => b.score - a.score)[0];
  return hit && hit.score >= AUTO_MIN ? hit : list.find(x => x.english !== false && ok(x));
}
// a console's choice changed: games that found nothing for the old one are looked up again on the next pass
function forgetMisses(sysId) { const m = memo(), pre = sysId + '|'; let n = 0; for (const k of Object.keys(m)) if (k.startsWith(pre) && !m[k].got) { delete m[k]; n++; } if (n) saveMemo(); return n; }
const autoInfo = key => memo()[key] || null; // what the automatic search did for a game ({got: id, title} when it downloaded one)

// ---------- "wrong manual": the user says the pages belong to another game ----------
// The rejected copy is moved aside (into .manual-originals, so nothing is lost), its source is remembered so neither
// the automatic search nor the collections ever pick it for this game again, and the next-best match is fetched.
let rejFile = null, rejMemo = null;
function setRejectStore(file) { rejFile = file; rejMemo = null; }
function rejects() { if (rejMemo) return rejMemo; try { rejMemo = JSON.parse(fs.readFileSync(rejFile, 'utf8')); } catch { rejMemo = {}; } return rejMemo; }
function isRejected(key, id) { const r = rejFile ? rejects()[key] : null; return !!(r && id && r.includes(String(id))); }
async function rejectManual(systems, systemId, file, opts = {}) {
  const sys = systems.find(x => x.def.id === systemId); if (!sys) throw new Error('Unknown system.');
  const { scanSystemAsync } = require('./scanner'), spreads = require('./spreads');
  const g = (await scanSystemAsync(sys.def, sys.cfg)).find(x => x.file.toLowerCase() === String(file).toLowerCase()); if (!g) throw new Error('Game not found.'); // (beta.10: async, the Wrong game press held main up)
  const key = systemId + '|' + g.file.toLowerCase(), m = memo(), dir = artDir(sys.cfg, g.file), base = artBase(g.file);
  // which copy this was: the collections' record, our own record, or (older downloads) the match the search makes now
  const bad = []; if (opts.collSrc) { bad.push('coll:' + opts.collSrc); if (opts.collSrc.startsWith('gdb/')) bad.push('gdb:' + opts.collSrc.slice(4)); } if (m[key] && m[key].got) bad.push(String(m[key].got));
  let cands = [], searchErr = null; try { cands = await search(systemId, g.title); } catch (e) { searchErr = e; }
  if (!bad.length) { const top = cands.find(x => x.english !== false && x.score >= AUTO_MIN && !isRejected(key, x.id)); if (top) bad.push(String(top.id)); }
  const rj = rejects(); rj[key] = [...new Set([...(rj[key] || []), ...bad])]; try { fs.writeFileSync(rejFile + '.tmp', JSON.stringify(rj)); fs.renameSync(rejFile + '.tmp', rejFile); } catch {}
  // move the pages aside
  const pre = base.toLowerCase() + '-manual'; let moved = 0;
  try { const files = fs.readdirSync(dir).filter(f => { const l = f.toLowerCase(); return l.startsWith(pre + '-') || l === pre + '.pdf'; });
    if (files.length) { const keep = spreads.backupDir(dir, base); fs.mkdirSync(keep, { recursive: true }); const done = [];
      for (const f of files) { try { fs.renameSync(path.join(dir, f), path.join(keep, f)); done.push(f); } catch (e) {
        for (const d of done) { try { fs.renameSync(path.join(keep, d), path.join(dir, d)); } catch {} } // put back what moved, so the manual isn't left half there
        throw new Error('Couldn\'t move the manual aside (' + (e.code || e.message) + '). Is a page open in another program?'); } }
      moved = done.length; } } catch (e) { if (/move the manual/.test(e.message)) throw e; }
  log('Wrong manual:', g.title, '- set aside', moved, 'files; never again from', bad.join(', ') || '(unknown source)');
  // (beta.9) a scan collection's copy first (the cleanest, with its cover), then the search's next best
  if (opts.tryFirst) { let c = null; try { c = await opts.tryFirst(sys.def, sys.cfg, g); } catch (e) { log('Wrong manual:', g.title, '- collections:', e.message); }
    if (c && c.got) { delete m[key]; saveMemo(); log('Wrong manual:', g.title, '- got the scan from', c.from); return { moved, title: g.title, got: c.got, from: c.from }; } }
  const next = cands.find(x => x.english !== false && x.score >= AUTO_MIN && !isRejected(key, x.id));
  if (!next) { m[key] = searchErr ? { v: AUTO_V, at: Date.now(), err: searchErr.message, rejected: true } : { v: AUTO_V, at: Date.now(), none: true, rejected: true }; saveMemo(); return { moved, title: g.title, got: 0, offline: !!searchErr }; }
  log('Wrong manual:', g.title, '- trying', next.title);
  const rep = await downloadChosen(systems, [{ systemId, file: g.file, id: next.id, key, title: next.title }], opts.progress || (() => {}));
  const r = rep[0] || {}; m[key] = r.pages ? { v: AUTO_V, at: Date.now(), got: next.id, title: next.title } : { v: AUTO_V, at: Date.now(), err: r.error || 'no pages' }; saveMemo();
  return { moved, title: g.title, got: r.pages || 0, from: next.title, pdf: r.pages === -1 };
}

// ---------- (beta.9) "Repair": the right game's manual, put right where it is ----------
// The pages as they are go to .manual-originals first (undo = put them back). Then: thumbnail "pages" out, oversized
// pages made smaller, gaps in the numbering closed, booklet pages scanned open cut in two (never a digital manual's
// screens), and when the manual doesn't open on a cover, the game's box front goes in as its first page.
// opts: { crop(file, side), front: the box front's file, sysId }. Returns { changed, what }.
const pageSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });
function manualPages(dir, base) { const pre = (base + '-manual-').toLowerCase(); try { return fs.readdirSync(dir).filter(f => f.toLowerCase().startsWith(pre) && /-manual-\d+\.(jpe?g|png|webp)$/i.test(f)).sort(pageSort); } catch { return []; } }
// pages renamed 01, 02, 03… in order, with `first` (a file to copy in) as page 01 when given; through temporary names, so
// nothing is ever overwritten half-way
function renumber(dir, base, first) {
  const files = manualPages(dir, base), tmp = [];
  files.forEach((f, i) => { const t = path.join(dir, `.${base}-renum-${i}${path.extname(f).toLowerCase()}`); fs.renameSync(path.join(dir, f), t); tmp.push(t); });
  let n = 0; const name = ext => path.join(dir, `${base}-manual-${String(++n).padStart(2, '0')}${ext}`);
  if (first) fs.copyFileSync(first, name(path.extname(first).toLowerCase() === '.jpeg' ? '.jpg' : path.extname(first).toLowerCase()));
  for (const t of tmp) fs.renameSync(t, name(path.extname(t)));
  return n;
}
async function repairInPlace(cfg, g, opts = {}) {
  const dir = artDir(cfg, g.file), base = artBase(g.file), sp = require('./spreads'), what = [];
  let files = manualPages(dir, base); if (!files.length) return { changed: false, what: 'no pages to repair' };
  const keep = sp.backupDir(dir, base); for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(keep, f));
  const size = f => sp.sizeOf(path.join(dir, f));
  // thumbnails out
  const tiny = files.filter(f => { const z = size(f); return z && z[0] < 300; });
  if (tiny.length < files.length) { for (const f of tiny) fs.unlinkSync(path.join(dir, f)); if (tiny.length) what.push(`${tiny.length} thumbnail page${tiny.length === 1 ? '' : 's'} taken out`); }
  const shrunk = await shrinkPages(dir, base); if (shrunk) what.push(`${shrunk} oversized page${shrunk === 1 ? '' : 's'} made smaller`);
  renumber(dir, base);
  // booklet pages scanned open: cut, the outside's front cover first (pages narrower than a scan are screens: left whole)
  if (opts.crop && opts.sysId !== 'wiiu') { let n = 0; try { n = await sp.splitManual(dir, base, opts.crop, { scan: true, minW: 1100 }); } catch (e) { log('Repair', base, 'spreads:', e.message); } if (n) what.push('two-page scans cut into single pages'); }
  // the cover: a Wii U e-manual opens on the box front by itself; anything else gets the box front as page 1, unless page 1
  // already is it (a second Repair never adds a second one). (beta.9: it used to be added only when nothing else needed
  // fixing or page 1 wasn't cover-shaped, and any upright page counts as that: so a manual with thumbnails or huge pages
  // needed Repair twice before its cover showed)
  files = manualPages(dir, base);
  if (opts.sysId !== 'wiiu' && opts.front && isFile(opts.front) && files.length) {
    let same = false; try { same = fs.statSync(opts.front).size === fs.statSync(path.join(dir, files[0])).size; } catch {}
    if (!same) { renumber(dir, base, opts.front); what.push('the box front added as its cover'); }
  }
  if (!what.length) { try { fs.rmSync(keep, { recursive: true, force: true }); fs.rmdirSync(path.dirname(keep)); } catch {} } // (nothing changed: no backup needed)
  log('Repair manual:', g.title, '-', what.length ? what.join(', ') : 'nothing to change');
  return { changed: what.length > 0, what: what.join(', ') };
}
// a manual picked by hand from the search: remember which copy it was, so "wrong manual" can block exactly that one
function noteChosen(choices, rep) { if (!autoFile) return; const m = memo(); let n = 0;
  for (const r of rep || []) { const c = choices.find(x => x.file === r.file); if (c && r.pages) { m[c.systemId + '|' + String(c.file).toLowerCase()] = { v: AUTO_V, at: Date.now(), got: c.id, title: c.title || '', hand: true /* (beta.9) picked by hand: the re-check leaves it */ }; n++; } }
  if (n) saveMemo(); }
module.exports = { repairInPlace, renumber, manualPages, recheck, setShrink, shrinkPages, isPageImage, scoreHit, simParts, seqNums, foreignPlatform, langCode, regionOf, prefMatch, prefPick, forgetMisses, autoInfo, searchArchive, fetchManual, LANG_NAMES, isManualFile, noteChosen, words, setRejectStore, isRejected, rejectManual, AUTO_MIN, coverage, init, searchGamesDatabase, search, findAll, downloadChosen, savePages, writePages, autoFetch, setStore, altNumbers, gdbSlugs, getJson, getText, getFile, similarity, norm, pool, hasManual };
