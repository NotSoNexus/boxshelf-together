#!/usr/bin/env node
/* Boxshelf Online · v1 — profiles, friend codes and friends.
   Zero dependencies (node's own http and crypto only): one process, one JSON database, images as plain
   files — sized for an old home PC or a small VPS. The shelf stays local-first: what lives here is a
   synced copy of each player's profile, nothing more; if this server is down, Boxshelf works as always.

   Run:  BS_PORT=8787 BS_DATA=./data node server.js
   TLS is not handled here: put Cloudflare Tunnel (or a reverse proxy) in front and it stays plain HTTP
   on localhost, never exposed directly. */

'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +(process.env.BS_PORT || 8787);
const DATA = path.resolve(process.env.BS_DATA || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA, 'online.json');
const IMG_DIR = path.join(DATA, 'img');
const IMG_MAX = 400 * 1024;                                  // avatar/banner: small compressed pictures
const IMG_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const JSON_MAX = 64 * 1024;

/* ---------- the database: one JSON file, written the way Boxshelf writes its own (temp + rename) ---------- */
let db = null;
function loadDb() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = null; }
  if (!db || typeof db !== 'object' || !db.users || typeof db.users !== 'object') db = { version: 1, users: {} };
}
let seq = 0, saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(saveNow, 250); } // bursts share one write
function saveNow() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = `${DB_FILE}.${process.pid}-${++seq}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('[save]', e.message); }
}

/* ---------- small shared helpers, named like the app does it ---------- */
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const digits = s => String(s || '').replace(/\D/g, '');
const prettyCode = d => (/^\d{12}$/.test(d) ? d.slice(0, 4) + '-' + d.slice(4, 8) + '-' + d.slice(8) : d);
function newCode() { // 12 digits, unique among the users there are
  for (;;) {
    const d = Array.from({ length: 12 }, () => crypto.randomInt(0, 10)).join('');
    if (!db.users[d]) return d;
  }
}
// what anyone (the owner or a friend) may see about a profile: never the token hash or pending lists
const publicProfile = u => ({
  code: prettyCode(u.code), name: u.name, description: u.description || '',
  avatar: u.avatar || '', banner: u.banner || '',
  favorites: Array.isArray(u.favorites) ? u.favorites.length : 0,
  totalMs: Math.max(0, +u.totalMs || 0), playing: clean(u.playing, 80) || null, createdAt: u.createdAt
});

/* ---------- answers ---------- */
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const ok = (res, data) => json(res, 200, { ok: true, data });
const fail = (res, status, error) => json(res, status, { ok: false, error });

function body(req, max) {
  return new Promise((done, bad) => {
    const parts = []; let n = 0;
    req.on('data', ch => {
      n += ch.length;
      if (n > max) { bad(Object.assign(new Error('Too big'), { status: 413 })); req.destroy(); return; }
      parts.push(ch);
    });
    req.on('end', () => done(Buffer.concat(parts)));
    req.on('error', bad);
  });
}
// behind Cloudflare Tunnel every connection comes from localhost; the tunnel says who the client really is
const ipOf = req => (req.socket.remoteAddress === '127.0.0.1' && req.headers['cf-connecting-ip']) || req.socket.remoteAddress || '?';

/* sign-ups are the one open door: a handful per IP and hour, so a bot can't farm codes */
const regHits = new Map();
function registerAllowed(ip) {
  const now = Date.now(), list = (regHits.get(ip) || []).filter(t => now - t < 36e5);
  if (list.length >= 6) { regHits.set(ip, list); return false; }
  list.push(now); regHits.set(ip, list); return true;
}

/* ---------- auth: the token is the account's key, only its hash is ever stored ---------- */
function me(req) {
  const m = /^Bearer ([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = sha256(m[1]);
  for (const u of Object.values(db.users)) if (u.tokenHash === h) return u;
  return null;
}

/* ---------- the routes ---------- */
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  if (method === 'GET' && (p === '/v1/ping' || p === '/')) return ok(res, { pong: true, service: 'boxshelf-online', version: 1 });

  if (method === 'GET' && p.startsWith('/img/')) return serveImg(res, p.slice(5));

  if (method === 'POST' && p === '/v1/register') {
    const ip = ipOf(req);
    if (!registerAllowed(ip)) return fail(res, 429, 'Demasiados registros desde esta conexión. Prueba más tarde.');
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    const name = clean(b.name, 32);
    if (name.length < 1) return fail(res, 400, 'Escribe un nombre.');
    if (Object.values(db.users).some(u => u.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Ya existe alguien con ese nombre. Elige otro.');
    const code = newCode(), token = crypto.randomBytes(32).toString('hex');
    db.users[code] = { code, name, description: '', avatar: '', banner: '', favorites: [], totalMs: 0, tokenHash: sha256(token), createdAt: Date.now(), friends: [], incoming: [], outgoing: [] };
    save();
    console.log(`[register] ${prettyCode(code)} ${name} (ip ${ip})`);
    // the token is shown once: the app keeps it in the player's own folder (export it to move the account)
    return ok(res, { friendCode: prettyCode(code), token });
  }

  const user = me(req);
  if (!user) return fail(res, 401, 'Sesión no válida. Vuelve a entrar con tu código de amigo.');

  if (method === 'GET' && p === '/v1/me') return ok(res, { ...publicProfile(user), favoritesList: user.favorites || [] });

  if (method === 'PUT' && p === '/v1/me') {
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    if (b.name != null) {
      const name = clean(b.name, 32);
      if (name.length < 1) return fail(res, 400, 'Escribe un nombre.');
      if (Object.values(db.users).some(u => u !== user && u.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Ya existe alguien con ese nombre. Elige otro.');
      user.name = name;
    }
    if (b.description != null) user.description = clean(b.description, 160);
    if (b.totalMs != null) user.totalMs = Math.max(0, Math.round(+b.totalMs) || 0);
    if (b.playing !== undefined) user.playing = clean(b.playing, 80) || '';
    if (Array.isArray(b.favorites)) user.favorites = [...new Set(b.favorites.map(v => clean(v, 120)).filter(Boolean))].slice(0, 500);
    save();
    return ok(res, { ...publicProfile(user), favoritesList: user.favorites || [] });
  }

  if (method === 'POST' && (p === '/v1/me/avatar' || p === '/v1/me/banner')) {
    const kind = p === '/v1/me/avatar' ? 'avatar' : 'banner';
    const buf = await body(req, IMG_MAX).catch(e => { throw Object.assign(e, { handled: true }); });
    const ext = IMG_TYPES[(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext) return fail(res, 415, 'La imagen debe ser JPG, PNG o WebP.');
    if (!buf.length) return fail(res, 400, 'Imagen vacía.');
    const name = sha256(buf) + ext;
    fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.writeFileSync(path.join(IMG_DIR, name), buf);
    const old = user[kind];
    user[kind] = `/img/${name}`;
    save();
    if (old && old !== user[kind]) { try { fs.unlinkSync(path.join(IMG_DIR, path.basename(old))); } catch {} }
    return ok(res, { [kind]: user[kind] });
  }

  if (method === 'GET' && p.startsWith('/v1/profile/')) {
    const target = db.users[digits(p.slice(12))];
    if (!target) return fail(res, 404, 'No hay nadie con ese código de amigo.');
    return ok(res, { ...publicProfile(target), isFriend: user.friends.includes(target.code) });
  }

  if (method === 'GET' && p === '/v1/friends') {
    const list = codes => codes.map(c => db.users[c]).filter(Boolean).map(publicProfile);
    return ok(res, { friends: list(user.friends), incoming: list(user.incoming), outgoing: list(user.outgoing) });
  }

  if (method === 'POST' && p === '/v1/friends') {
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    const target = db.users[digits(b.code)];
    if (!target) return fail(res, 404, 'No hay nadie con ese código de amigo.');
    if (target === user) return fail(res, 400, 'Ese eres tú.');
    const drop = (u, list, c) => { u[list] = (u[list] || []).filter(x => x !== c); };
    if (user.friends.includes(target.code)) return ok(res, { status: 'friends' });
    if ((target.outgoing || []).includes(user.code)) { // both asked: friends at once
      user.friends.push(target.code); target.friends.push(user.code);
      drop(user, 'outgoing', target.code); drop(target, 'incoming', user.code);
      save();
      return ok(res, { status: 'friends' });
    }
    user.outgoing = user.outgoing || []; target.incoming = target.incoming || [];
    if (!user.outgoing.includes(target.code)) user.outgoing.push(target.code);
    if (!target.incoming.includes(user.code)) target.incoming.push(user.code);
    save();
    return ok(res, { status: 'requested' });
  }

  if (method === 'DELETE' && p.startsWith('/v1/friends/')) {
    const target = db.users[digits(p.slice(12))];
    if (target) { // leaves friendship and any pending request between the two, both sides
      for (const [a, b2] of [[user, target], [target, user]]) {
        a.friends = (a.friends || []).filter(x => x !== b2.code);
        a.incoming = (a.incoming || []).filter(x => x !== b2.code);
        a.outgoing = (a.outgoing || []).filter(x => x !== b2.code);
      }
      save();
    }
    return ok(res, { removed: true });
  }

  return fail(res, 404, 'Ruta desconocida.');
}

/* ---------- pictures: content-addressed files, immutable for the browser ---------- */
function serveImg(res, name) {
  if (!/^[0-9a-f]{40}\.(jpg|png|webp)$/.test(name)) return fail(res, 404, 'Imagen desconocida.');
  const file = path.join(IMG_DIR, name);
  fs.readFile(file, (e, buf) => {
    if (e) return fail(res, 404, 'Imagen desconocida.');
    res.writeHead(200, { 'Content-Type': 'image/' + (path.extname(name) === '.jpg' ? 'jpeg' : path.extname(name).slice(1)), 'Cache-Control': 'public, max-age=2592000, immutable', 'Content-Length': buf.length });
    res.end(buf);
  });
}

/* ---------- start ---------- */
loadDb();
fs.mkdirSync(IMG_DIR, { recursive: true });
const server = http.createServer((req, res) => {
  route(req, res).catch(e => {
    if (e && e.handled) return fail(res, e.status || 400, e.message);
    console.error('[error]', req.method, req.url, e.message);
    fail(res, 500, 'Error interno.');
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`Boxshelf Online v1 · http://127.0.0.1:${PORT} · ${Object.keys(db.users).length} perfiles · ${DATA}`));
function closing() { saveNow(); process.exit(0); }
process.on('SIGINT', closing); process.on('SIGTERM', closing);
process.on('uncaughtException', e => { console.error('[fatal]', e); saveNow(); });
