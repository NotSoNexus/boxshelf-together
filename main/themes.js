// Your logo images and boot videos live in <Boxshelf folder>\themes\<system>\
//   logo.png / logo.svg / logo.webp,  boot.mp4 / boot.webm,  console.png (for the 3D start-up animation, which is switched off: unused for now),
//   console.glb (a 3D model of the console, shown instead of the built-in one) + optional console.json tweaks
const fs = require('fs');
const path = require('path');
const { appRoot, isFile } = require('./paths');

const LOGO_EXT = ['png', 'svg', 'webp', 'jpg'];
const BOOT_EXT = ['mp4', 'webm', 'mov'];
const MODEL_EXT = ['glb', 'gltf'];
const MEDIA_NAME = { sw: 'cart', pcengine: 'cart', neogeo: 'cart', arcade: 'cart', sega32x: 'cart', atari2600: 'cart', atarilynx: 'cart', wonderswan: 'cart', ngpc: 'cart', sw2: 'cart', n3ds: 'cart', psp: 'umd', nes: 'cart', snes: 'cart', n64: 'cart', gb: 'cart', gbc: 'cart', gba: 'cart', nds: 'cart', megadrive: 'cart', mastersystem: 'cart', gamegear: 'cart' }; // everything else: disc

const KINDS = ['logo', 'boot', 'console', 'model', 'media', 'controller'];
// the console's own media name first; a hand-placed disc.glb on a cart console (or the reverse) still shows, and Remove takes it too
const mediaNames = id => [...new Set([MEDIA_NAME[id] || 'disc', 'cart', 'disc', 'umd'])];
// Both ids come over IPC: a bare folder name and a known kind, nothing that could point outside themes\
function dir(sysId) { if (!/^[a-z0-9_-]{1,32}$/i.test(String(sysId))) throw new Error('Unknown system.'); return path.join(appRoot(), 'themes', sysId); }
function checkKind(kind) { if (!KINDS.includes(kind)) throw new Error('Unknown theme item.'); }

function find(sysId, base, exts) {
  for (const e of exts) { const f = path.join(dir(sysId), `${base}.${e}`); if (isFile(f)) return f; }
  return null;
}

function list(ids) {
  const out = {};
  for (const id of ids) out[id] = { logo: find(id, 'logo', LOGO_EXT), boot: find(id, 'boot', BOOT_EXT), console: find(id, 'console', LOGO_EXT), model: find(id, 'console', MODEL_EXT), modelOpts: readOpts(id), controller: find(id, 'controller', MODEL_EXT), media: mediaNames(id).reduce((f, b) => f || find(id, b, MODEL_EXT), null), mediaOpts: readOpts(id, MEDIA_NAME[id] || 'disc') };
  return out;
}

// console.json: {"yaw":0,"pitch":0,"scale":1,"lift":0,"lid":"lid","lidAxis":"x","lidAngle":-70,"discHeight":0,"discScale":1}
function readOpts(sysId, base = 'console') {
  const f = path.join(dir(sysId), `${base}.json`);
  if (!isFile(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { error: 'console.json is not valid JSON' }; }
}
// keep: the file just put in place (set() drops only the other extensions of the same item)
function remove(sysId, kind, keep) {
  checkKind(kind);
  const exts = kind === 'boot' ? BOOT_EXT : (kind === 'model' || kind === 'media' || kind === 'controller') ? MODEL_EXT : LOGO_EXT;
  const bases = kind === 'model' ? ['console'] : kind === 'media' ? mediaNames(sysId) : [kind];
  for (const base of bases) for (const e of exts) { const f = path.join(dir(sysId), `${base}.${e}`); if (f !== keep) try { fs.unlinkSync(f); } catch {} }
  if (kind === 'model') resetModelOpts(sysId);
}
// A new (or no) console model: its fit, part choices and insert tweaks belong to the old model and go. The controller
// choice stays (controller.glb is its own file), unless it named a part of the old model ("p12").
function resetModelOpts(sysId) {
  const f = path.join(dir(sysId), 'console.json'); let cur = null;
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const keep = {}; if (cur && typeof cur === 'object' && !Array.isArray(cur) && !/^p\d/.test(String(cur.controller || ''))) { if (cur.controller != null) keep.controller = cur.controller; if (cur.controllerYaw != null) keep.controllerYaw = cur.controllerYaw; }
  try { if (!Object.keys(keep).length) fs.unlinkSync(f); else { const tmp = f + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(keep, null, 2)); fs.renameSync(tmp, f); } } catch {}
}

function set(sysId, kind, src) {
  checkKind(kind); src = String(src || '');
  const ext = path.extname(src).slice(1).toLowerCase();
  const allowed = kind === 'boot' ? BOOT_EXT : (kind === 'model' || kind === 'media' || kind === 'controller') ? MODEL_EXT : LOGO_EXT;
  if (!allowed.includes(ext)) throw new Error((kind === 'model' || kind === 'media' || kind === 'controller') ? 'Use a .glb (or .gltf) model.' : kind !== 'boot' ? 'Use a PNG, SVG, WebP or JPG image.' : 'Use an MP4, WebM or MOV video.');
  fs.mkdirSync(dir(sysId), { recursive: true });
  const already = path.join(dir(sysId), `${kind === 'model' ? 'console' : kind === 'media' ? (MEDIA_NAME[sysId] || 'disc') : kind}.${ext}`);
  if (path.resolve(src).toLowerCase() === already.toLowerCase()) return already; // picked the file that's already in place
  // copy under a temp name, then rename over: a failed copy (disk full, file gone, video in use) leaves the old theme as it was
  const dest = already, tmp = path.join(dir(sysId), `.${path.basename(dest)}.${process.pid}.tmp`);
  try { fs.copyFileSync(src, tmp); fs.renameSync(tmp, dest); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  remove(sysId, kind, dest);
  return dest;
}

// The console fit panel saves its choices into console.json, next to whatever was there (yaw, lid… for the insert
// animation). Only these keys, with sane values; null removes one.
function saveFit(sysId, patch) {
  const f = path.join(dir(sysId), 'console.json');
  let cur = {}; if (isFile(f)) { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) cur = j; } catch {} }
  const p = patch && typeof patch === 'object' ? patch : {}, num = (v, lo, hi) => { const n = +v; return isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n * 1000) / 1000)) : undefined; };
  const set = (k, v) => { if (v === null) delete cur[k]; else if (v !== undefined) cur[k] = v; };
  if ('museumYaw' in p) set('museumYaw', p.museumYaw === null ? null : num(((+p.museumYaw % 360) + 360) % 360, 0, 359));
  if ('museumScale' in p) set('museumScale', p.museumScale === null ? null : num(p.museumScale, .3, 2));
  if ('controllerYaw' in p) set('controllerYaw', p.controllerYaw === null ? null : num(((+p.controllerYaw % 360) + 360) % 360, 0, 359));
  if ('controller' in p) set('controller', p.controller === null ? null : /^(none|file|p\d{1,4})$/.test(String(p.controller)) ? String(p.controller) : undefined);
  if ('parts' in p) { if (p.parts === null) delete cur.parts; else if (p.parts && typeof p.parts === 'object') { const o = {}; Object.entries(p.parts).slice(0, 400).forEach(([k, v]) => { if (/^p\d{1,4}$/.test(k) && (v === 'show' || v === 'hide')) o[k] = v; }); cur.parts = o; } }
  fs.mkdirSync(dir(sysId), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cur, null, 2)); fs.renameSync(tmp, f);
  return cur;
}

// A logo put in by Boxshelf itself (ScreenScraper's "Find a logo"): the one it replaces is moved aside into
// themes\<system>\.replaced\ (never deleted), and Restore swaps the two back. Only the newest moved-aside logo counts; older ones
// stay in the folder for the user. The new file goes through set(), so the same extension check applies.
const REPLACED = '.replaced';
function prevLogo(sysId) {
  const d = path.join(dir(sysId), REPLACED); let best = null, bt = -1;
  try { for (const f of fs.readdirSync(d)) { const m = /^logo-(\d{10,16})\.([a-z]+)$/.exec(f); if (m && LOGO_EXT.includes(m[2]) && +m[1] > bt && isFile(path.join(d, f))) { best = path.join(d, f); bt = +m[1]; } } } catch {}
  return best;
}
// the current logo (if any) → .replaced\logo-<time>.<ext>; returns where it went
function moveLogoAside(sysId) {
  const cur = find(sysId, 'logo', LOGO_EXT); if (!cur) return null;
  const d = path.join(dir(sysId), REPLACED); fs.mkdirSync(d, { recursive: true });
  let t = Date.now(); const prev = prevLogo(sysId); if (prev) t = Math.max(t, +/logo-(\d+)/.exec(path.basename(prev))[1] + 1); // (always the newest, even within one millisecond)
  const to = path.join(d, `logo-${t}${path.extname(cur).toLowerCase()}`); fs.renameSync(cur, to);
  for (let i = 0, o; i < LOGO_EXT.length && (o = find(sysId, 'logo', LOGO_EXT)); i++) fs.renameSync(o, path.join(d, `logo-${t - 1 - i}${path.extname(o).toLowerCase()}`)); // a stray second logo.* (it'd be deleted by set()): kept too, as older
  return to;
}
function setLogoKeepingOld(sysId, src) {
  src = String(src || ''); const ext = path.extname(src).slice(1).toLowerCase();
  if (!LOGO_EXT.includes(ext)) throw new Error('Use a PNG, SVG, WebP or JPG image.');
  const aside = moveLogoAside(sysId);
  try { return set(sysId, 'logo', src); } catch (e) { if (aside) try { fs.renameSync(aside, path.join(dir(sysId), 'logo' + path.extname(aside))); } catch {} throw e; } // (a failed copy puts the old one back)
}
// Restore: the newest moved-aside logo comes back; the one in use (if any) is moved aside in its place, so Restore can be undone
function restoreLogo(sysId) {
  const prev = prevLogo(sysId); if (!prev) throw new Error('No earlier logo to bring back.');
  const tmp = path.join(dir(sysId), `.restore-${process.pid}${path.extname(prev)}`); fs.renameSync(prev, tmp);
  try { moveLogoAside(sysId); } catch (e) { try { fs.renameSync(tmp, prev); } catch {} throw e; }
  const dest = path.join(dir(sysId), 'logo' + path.extname(prev).toLowerCase()); fs.renameSync(tmp, dest); return dest;
}

module.exports = { list, set, remove: (sysId, kind) => remove(sysId, kind), dir, saveFit, prevLogo, setLogoKeepingOld, restoreLogo };
