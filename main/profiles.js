// Local-only player profiles. The registry is deliberately separate from a
// profile's settings so an optional cloud sync can later sync one profile at a time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let root = '', file = '', state = null, log = () => {};
const staged = new Set(); // just-picked pictures, allowed through before the profile is saved (the editor's live preview)
const cleanName = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 32);
const profileId = () => 'p-' + crypto.randomBytes(6).toString('hex');
const write = () => {
  fs.mkdirSync(root, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const cleanText = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanPath = value => { const p = String(value || '').trim(); return p && p.length <= 2048 && fs.existsSync(p) ? p : ''; };
// How the picture sits in its circle and the banner in its strip: zoom (1 = fills, 3 = 3×) and pan, as a % of the
// picture. The pan is capped by the zoom, so sliding can never show an empty edge.
const cleanNum = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : fallback; };
const cleanFit = v => {
  const src = v && typeof v === 'object' ? v : {};
  const one = k => { const f = src[k] && typeof src[k] === 'object' ? src[k] : {}, z = cleanNum(f.z, 1, 3, 1), lim = (z - 1) * 50;
    return { z, x: cleanNum(f.x, -lim, lim, 0), y: cleanNum(f.y, -lim, lim, 0) }; };
  return { avatar: one('avatar'), banner: one('banner') };
};
function statsFor(p) {
  let favorites = 0, totalMs = 0;
  try { const c = JSON.parse(fs.readFileSync(configFile(p.id), 'utf8')); favorites = Array.isArray(c && c.ui && c.ui.favorites) ? c.ui.favorites.length : 0; } catch {}
  try { const h = JSON.parse(fs.readFileSync(dataFile('history.json', p.id), 'utf8')); if (h && typeof h === 'object') for (const v of Object.values(h)) totalMs += Math.max(0, +((v && v.ms) || 0)); } catch {}
  return { favorites, totalMs };
}
const record = p => ({ id: p.id, name: p.name, description: p.description || '', avatar: p.avatar || '', banner: p.banner || '', fit: cleanFit(p.fit), createdAt: p.createdAt, ...statsFor(p) });
function init(dataDir, logger) {
  root = path.join(dataDir, 'profiles'); file = path.join(dataDir, 'profiles.json'); log = logger || log;
  let saved = null; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (saved && Array.isArray(saved.profiles) && saved.profiles.length) {
    const profiles = saved.profiles.filter(p => p && /^[a-z0-9-]{3,40}$/i.test(p.id) && cleanName(p.name)).slice(0, 32)
      .map(p => ({ id: p.id, name: cleanName(p.name), description: cleanText(p.description, 160), avatar: cleanPath(p.avatar), banner: cleanPath(p.banner), fit: cleanFit(p.fit), createdAt: +p.createdAt || Date.now() }));
    const active = profiles.some(p => p.id === saved.active) ? saved.active : profiles[0].id;
    state = { version: 1, active, profiles }; migrateHistory(dataDir); write(); return;
  }
  const first = { id: 'default', name: 'Jugador 1', description: '', avatar: '', banner: '', createdAt: Date.now() };
  state = { version: 1, active: first.id, profiles: [first] };
  fs.mkdirSync(path.join(root, first.id), { recursive: true });
  // Keep the former shared file in place as a recoverable legacy copy.
  const old = path.join(dataDir, 'config.json'), target = configFile(first.id);
  try { if (fs.existsSync(old) && !fs.existsSync(target)) fs.copyFileSync(old, target); } catch (e) { log('profiles migration', e.message); }
  migrateHistory(dataDir); write();
}
// The hours played before profiles existed lived in the shared data\history.json; they are merged into the first
// profile's own history (the greater of each value, so nothing is counted twice) and the old file kept as a copy.
function migrateHistory(dataDir) {
  const old = path.join(dataDir, 'history.json'), done = old + '.migrated';
  if (!fs.existsSync(old)) return;
  try {
    const merged = new Map();
    for (const src of [dataFile('history.json', state.active), old]) {
      let raw = null; try { raw = JSON.parse(fs.readFileSync(src, 'utf8')); } catch {}
      if (!raw || typeof raw !== 'object') continue;
      for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        const e = merged.get(k) || { count: 0, ms: 0, last: 0 };
        e.count = Math.max(e.count, +v.count || 0); e.ms = Math.max(e.ms, +v.ms || 0); e.last = Math.max(e.last, +v.last || 0);
        merged.set(k, e);
      }
    }
    const out = {}; for (const [k, v] of merged) out[k] = v;
    const target = dataFile('history.json', state.active), tmp = target + '.tmp';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out)); fs.renameSync(tmp, target);
    try { fs.renameSync(old, done); } catch {}
    log('play history migrated into the profile');
  } catch (e) { log('history migration', e.message); }
}
// The profile's own picture and banner are picked from anywhere on the PC (Pictures, a downloads folder…), outside
// every library folder bsfile:// serves, so the protocol asks here whether a path belongs to a profile.
function isImage(file) {
  if (!state) return false;
  try { const f = path.resolve(String(file || '')).toLowerCase();
    if (staged.has(f)) return true;
    return state.profiles.some(p => (p.avatar && path.resolve(p.avatar).toLowerCase() === f) || (p.banner && path.resolve(p.banner).toLowerCase() === f)); }
  catch { return false; }
}
// A picture picked in the editor is shown in the live preview before the profile is saved; it must pass bsfile:// now.
function stage(file) {
  try { const f = path.resolve(String(file || '')); if (f && /\.(jpe?g|png|webp|gif|bmp)$/i.test(f)) { staged.add(f.toLowerCase()); return true; } } catch {}
  return false;
}
function configFile(id = state.active) { return path.join(root, id, 'config.json'); }
function dataFile(name, id = state.active) { return path.join(root, id, name); }
function current() { const p = state.profiles.find(x => x.id === state.active) || state.profiles[0]; return record(p); }
function list() { return { active: state.active, profiles: state.profiles.map(record) }; }
function create(name, sourceConfig) {
  name = cleanName(name); if (!name) throw new Error('Escribe un nombre para el perfil.');
  if (state.profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Ya existe un perfil con ese nombre.');
  const p = { id: profileId(), name, description: '', avatar: '', banner: '', createdAt: Date.now() };
  state.profiles.push(p); fs.mkdirSync(path.join(root, p.id), { recursive: true });
  try { if (sourceConfig && fs.existsSync(sourceConfig)) fs.copyFileSync(sourceConfig, configFile(p.id)); } catch (e) { log('profiles copy', e.message); }
  write(); return record(p);
}
function select(id) { if (!state.profiles.some(p => p.id === id)) throw new Error('Perfil no encontrado.'); state.active = id; write(); return current(); }
function update(id, patch) {
  const p = state.profiles.find(x => x.id === id); if (!p) throw new Error('Perfil no encontrado.');
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) { const name = cleanName(patch.name); if (!name) throw new Error('Escribe un nombre para el perfil.'); if (state.profiles.some(x => x !== p && x.name.toLowerCase() === name.toLowerCase())) throw new Error('Ya existe un perfil con ese nombre.'); p.name = name; }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'description')) p.description = cleanText(patch.description, 160);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'avatar')) p.avatar = cleanPath(patch.avatar);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'banner')) p.banner = cleanPath(patch.banner);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'fit')) p.fit = cleanFit(patch.fit);
  write(); return record(p);
}
module.exports = { init, list, current, create, select, update, configFile, dataFile, isImage, stage };
