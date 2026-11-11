// Boxshelf Online · client side (main process). The page's CSP has no https in connect-src on purpose,
// so the network goes through here: the page asks over IPC and never talks to the internet itself.
// Everything is local-first: the account lives in the player profile's own folder (online.json) and the
// server only ever holds the synced copy. If the server is unreachable, Boxshelf works exactly as always.
'use strict';
const fs = require('fs'), path = require('path');

const DEFAULT_SERVER = process.env.BOXSHELF_ONLINE_SERVER || 'https://boxshelf-online.boxshelf-justniko.workers.dev';
let dataFile = null, ui = null, log = () => {};

function init(profiles, config, logger) {
  dataFile = () => profiles.dataFile('online.json');
  ui = () => (config && config.load && config.load().ui) || {};
  log = logger || log;
}
const server = () => (read() && read().server) || (ui().onlineServer) || DEFAULT_SERVER;
function read() { let v = null; try { v = JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch {} return v && typeof v === 'object' ? v : null; }
function write(o) {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    const tmp = dataFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
    fs.renameSync(tmp, dataFile());
  } catch (e) { log('online save', e.message); }
}

async function call(pathname, { method = 'GET', token, body, raw } = {}) {
  let r;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    r = await fetch(server() + pathname, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(raw ? { 'Content-Type': raw.type } : body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: raw ? raw.buf : body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    return { ok: false, offline: true, error: 'No se pudo contactar el servidor. Revisa tu conexión o la dirección en Ajustes.' };
  }
  let j = null; try { j = await r.json(); } catch {}
  if (!j || typeof j !== 'object') return { ok: false, status: r.status, error: 'El servidor contestó algo inesperado (' + r.status + ').' };
  return j;
}

const account = () => { const d = read(); return d && d.token ? d : null; };

function status() {
  const d = read();
  return { server: server(), registered: !!(d && d.token), friendCode: d && d.code, name: d && d.name, lastSync: d && d.lastSync };
}
function setServer(url) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[a-z0-9.-]+/i.test(url)) throw new Error('La dirección debe empezar por http:// o https://');
  const d = read() || {};
  write({ ...d, server: url || '' });
  return status();
}
async function register(name) {
  name = String(name || '').trim().slice(0, 32);
  if (!name) throw new Error('Escribe un nombre.');
  const r = await call('/v1/register', { method: 'POST', body: { name } });
  if (!r.ok) throw new Error(r.error || 'No se pudo crear la cuenta.');
  write({ ...(read() || {}), token: r.data.token, code: r.data.friendCode, name, lastSync: 0 });
  return status();
}
// the account follows the player profile: rename it here and the server follows on the next sync.
// The local picture and banner come along too: they are shrunk here and uploaded only when the file changed,
// so the local profile is the one place where the picture is picked and the online copy mirrors it.
function shrink(file, kind) {
  try {
    let im = require('electron').nativeImage.createFromPath(file);
    if (im.isEmpty()) return null;
    if (kind === 'avatar') {
      const s = im.getSize(), side = Math.min(s.width, s.height);
      im = im.crop({ x: Math.round((s.width - side) / 2), y: Math.round((s.height - side) / 2), width: side, height: side }).resize({ width: 256, height: 256, resizeQuality: 'good' });
    } else {
      const s0 = im.getSize();
      if (s0.width > 1024) im = im.resize({ width: 1024, resizeQuality: 'good' });
      const s1 = im.getSize(), H = Math.min(576, s1.height);
      if (s1.height > H) im = im.crop({ x: 0, y: Math.round((s1.height - H) / 2), width: s1.width, height: H });
    }
    return { buf: im.toJPEG(85), type: 'image/jpeg' };
  } catch { return null; }
}
async function sync({ totalMs, favorites, name, playing, avatar, banner } = {}) {
  const d = read();
  if (!d || !d.token) return { ok: false, registered: false };
  const patch = { totalMs: Math.max(0, Math.round(+totalMs) || 0), favorites: Array.isArray(favorites) ? favorites.slice(0, 500) : [] };
  if (name) patch.name = String(name).slice(0, 32);
  if (playing != null) patch.playing = playing;
  const r = await call('/v1/me', { method: 'PUT', token: d.token, body: patch });
  if (r.ok) {
    d.name = r.data.name; d.lastSync = Date.now();
    for (const [kind, file, key] of [['avatar', avatar, 'avSha'], ['banner', banner, 'bnSha']]) { // mirror the local pictures
      if (!file) continue;
      let hash = null; try { hash = require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch {}
      if (!hash || d[key] === hash) continue;
      const small = shrink(file, kind);
      const up = small && await call('/v1/me/' + kind, { method: 'POST', token: d.token, raw: small });
      if (up && up.ok) d[key] = hash; else log('online', kind, 'sync failed');
    }
    write(d);
    return { ok: true, at: d.lastSync };
  }
  return r;
}
async function friends() {
  const d = account();
  if (!d) throw new Error('No tienes cuenta online todavía.');
  const r = await call('/v1/friends', { token: d.token });
  if (!r.ok) throw new Error(r.error || 'No se pudo leer la lista.');
  return r.data; // {friends:[...], incoming:[...], outgoing:[...]} with /img/... paths
}
async function add(code) {
  const d = account();
  if (!d) throw new Error('No tienes cuenta online todavía.');
  const r = await call('/v1/friends', { method: 'POST', token: d.token, body: { code } });
  if (!r.ok) throw new Error(r.error || 'No se pudo enviar la solicitud.');
  return r.data;
}
async function remove(code) {
  const d = account();
  if (!d) throw new Error('No tienes cuenta online todavía.');
  const r = await call('/v1/friends/' + encodeURIComponent(String(code || '')), { method: 'DELETE', token: d.token });
  if (!r.ok) throw new Error(r.error || 'No se pudo quitar.');
  return r.data;
}
async function view(code) {
  const d = account();
  if (!d) throw new Error('No tienes cuenta online todavía.');
  const r = await call('/v1/profile/' + encodeURIComponent(String(code || '')), { token: d.token });
  if (!r.ok) throw new Error(r.error || 'No se pudo abrir el perfil.');
  return r.data;
}
async function upload(kind, data) {
  const d = account();
  if (!d) throw new Error('No tienes cuenta online todavía.');
  const buf = Buffer.from(String(data && data.base64 || ''), 'base64');
  const r = await call('/v1/me/' + (kind === 'banner' ? 'banner' : 'avatar'), { method: 'POST', token: d.token, raw: { buf, type: (data && data.type) || 'image/jpeg' } });
  if (!r.ok) throw new Error(r.error || 'No se pudo subir la imagen.');
  return r.data;
}
module.exports = { init, status, setServer, register, sync, friends, add, remove, view, upload, server };
