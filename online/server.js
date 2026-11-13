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

/* ---------- email verification helper (Resend API or local simulation) ---------- */
const pendingVerifications = new Map();
function cleanExpiredVerifications() {
  const now = Date.now();
  for (const [key, v] of pendingVerifications.entries()) {
    if (v.expiresAt < now) pendingVerifications.delete(key);
  }
}
setInterval(cleanExpiredVerifications, 60000);

async function sendVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    try {
      const from = process.env.EMAIL_FROM || 'Boxshelf Together <onboarding@resend.dev>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [email],
          subject: `${code} es tu código de verificación - Boxshelf Together`,
          html: `
            <div style="background:#050a1e;color:#eef3ff;padding:32px;font-family:system-ui,-apple-system,sans-serif;border-radius:14px;max-width:480px;margin:0 auto;border:1px solid #1e293b;">
              <h2 style="color:#60a5fa;margin-top:0;">Boxshelf Together 🎮</h2>
              <p style="font-size:15px;color:#cbd5e1;">Tu código de verificación para activar tu cuenta es:</p>
              <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;margin:24px 0;">
                <span style="font-size:32px;font-weight:800;letter-spacing:8px;color:#38bdf8;font-family:monospace;">${code}</span>
              </div>
              <p style="font-size:13px;color:#94a3b8;margin-bottom:0;">Este código vence en 10 minutos. Si tú no solicitaste este código, puedes ignorar este mensaje.</p>
            </div>`
        })
      });
      if (r.ok) { console.log(`[email] Código enviado a ${email} vía Resend`); return true; }
      else { const txt = await r.text(); console.warn(`[email] Error Resend: ${r.status} ${txt}`); }
    } catch (e) { console.warn(`[email] Excepción correo: ${e.message}`); }
  }
  console.log(`\n======================================================`);
  console.log(`[VERIFICACIÓN] Código para ${email}: >>> ${code} <<<`);
  console.log(`======================================================\n`);
  return true;
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

  if (method === 'GET' && p === '/v1/check-name') {
    const rawName = u.searchParams.get('name') || '';
    const name = clean(rawName, 32);
    if (name.length < 3) return ok(res, { available: false, reason: 'Mínimo 3 caracteres' });
    const exists = Object.values(db.users).some(u => u.name.toLowerCase() === name.toLowerCase());
    return ok(res, { available: !exists, name });
  }

  if (method === 'POST' && p === '/v1/register') {
    const ip = ipOf(req);
    if (!registerAllowed(ip)) return fail(res, 429, 'Demasiados registros desde esta conexión. Prueba más tarde.');
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    const name = clean(b.name, 32);
    if (name.length < 3) return fail(res, 400, 'El nombre debe tener al menos 3 caracteres.');
    const password = String(b.password || '').trim();
    if (password.length < 4) return fail(res, 400, 'La contraseña debe tener al menos 4 caracteres.');
    if (Object.values(db.users).some(u => u.name.toLowerCase() === name.toLowerCase())) return fail(res, 409, 'Ya existe alguien con ese nombre. Elige otro.');
    
    const emailRaw = String(b.email || '').trim().toLowerCase();
    if (emailRaw) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) return fail(res, 400, 'El formato del correo electrónico no es válido.');
      if (Object.values(db.users).some(u => u.email_lower === emailRaw)) return fail(res, 409, 'Ese correo electrónico ya está registrado.');
      const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
      pendingVerifications.set(emailRaw, { code: verifyCode, name, password, email: emailRaw, expiresAt: Date.now() + 600000 });
      await sendVerificationEmail(emailRaw, verifyCode);
      return ok(res, { pendingVerification: true, email: emailRaw });
    }

    // Registro directo sin correo
    const code = newCode(), token = crypto.randomBytes(32).toString('hex');
    const passwordHash = sha256(password + ':' + code);
    db.users[code] = { code, name, email: '', email_lower: '', emailVerified: false, passwordHash, description: '', avatar: '', banner: '', favorites: [], totalMs: 0, tokenHash: sha256(token), createdAt: Date.now(), updatedAt: Date.now(), friends: [], incoming: [], outgoing: [] };
    save();
    console.log(`[register] ${prettyCode(code)} ${name} (ip ${ip})`);
    return ok(res, { friendCode: prettyCode(code), token, name });
  }

  if (method === 'POST' && p === '/v1/verify-email') {
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    const emailRaw = String(b.email || '').trim().toLowerCase();
    const inputCode = String(b.code || '').replace(/\D/g, '');
    const pending = pendingVerifications.get(emailRaw);
    if (!pending) return fail(res, 400, 'No hay ninguna verificación pendiente para este correo o ya expiró.');
    if (Date.now() > pending.expiresAt) {
      pendingVerifications.delete(emailRaw);
      return fail(res, 400, 'El código ha expirado. Solicita uno nuevo.');
    }
    if (inputCode !== pending.code) return fail(res, 400, 'Código de verificación incorrecto.');

    pendingVerifications.delete(emailRaw);
    const code = newCode(), token = crypto.randomBytes(32).toString('hex');
    const passwordHash = sha256(pending.password + ':' + code);
    db.users[code] = {
      code, name: pending.name, email: pending.email, email_lower: pending.email, emailVerified: true,
      passwordHash, description: '', avatar: '', banner: '', favorites: [], totalMs: 0,
      tokenHash: sha256(token), createdAt: Date.now(), updatedAt: Date.now(),
      friends: [], incoming: [], outgoing: []
    };
    save();
    console.log(`[verify-email] ${prettyCode(code)} ${pending.name} (${pending.email})`);
    return ok(res, { friendCode: prettyCode(code), token, name: pending.name, email: pending.email });
  }

  if (method === 'POST' && p === '/v1/resend-code') {
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    const emailRaw = String(b.email || '').trim().toLowerCase();
    const pending = pendingVerifications.get(emailRaw);
    if (!pending) return fail(res, 400, 'No hay ninguna verificación pendiente para este correo.');
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
    pending.code = verifyCode;
    pending.expiresAt = Date.now() + 600000;
    await sendVerificationEmail(emailRaw, verifyCode);
    return ok(res, { sent: true });
  }

  if (method === 'POST' && p === '/v1/login') {
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    const id = clean(b.identifier, 64);
    const password = String(b.password || '').trim();
    if (!id || !password) return fail(res, 400, 'Escribe tu usuario, correo o código.');
    const idDigits = digits(id);
    const idLower = id.toLowerCase();
    const target = Object.values(db.users).find(u => 
      u.name.toLowerCase() === idLower ||
      (u.email_lower && u.email_lower === idLower) ||
      (idDigits.length === 12 && u.code === idDigits)
    );
    if (!target) return fail(res, 401, 'Usuario o contraseña incorrectos.');
    if (target.passwordHash) {
      if (sha256(password + ':' + target.code) !== target.passwordHash) {
        return fail(res, 401, 'Usuario o contraseña incorrectos.');
      }
    } else {
      target.passwordHash = sha256(password + ':' + target.code);
    }
    const token = crypto.randomBytes(32).toString('hex');
    target.tokenHash = sha256(token);
    target.updatedAt = Date.now();
    save();
    console.log(`[login] ${prettyCode(target.code)} ${target.name}`);
    return ok(res, { friendCode: prettyCode(target.code), token, name: target.name });
  }

  const user = me(req);
  if (!user) return fail(res, 401, 'Sesión no válida. Vuelve a entrar con tu código de amigo.');

  if (method === 'GET' && p === '/v1/me') return ok(res, { ...publicProfile(user), email: user.email || '', emailVerified: !!user.emailVerified, favoritesList: user.favorites || [] });

  if (method === 'POST' && p === '/v1/me/link-email') {
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    const emailRaw = String(b.email || '').trim().toLowerCase();
    if (!emailRaw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) return fail(res, 400, 'El formato del correo electrónico no es válido.');
    if (Object.values(db.users).some(u => u !== user && u.email_lower === emailRaw)) return fail(res, 409, 'Ese correo electrónico ya está registrado en otra cuenta.');
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
    pendingVerifications.set(emailRaw, { code: verifyCode, userCode: user.code, email: emailRaw, expiresAt: Date.now() + 600000 });
    await sendVerificationEmail(emailRaw, verifyCode);
    return ok(res, { pendingVerification: true, email: emailRaw });
  }

  if (method === 'POST' && p === '/v1/me/confirm-email') {
    let b = {}; try { b = JSON.parse((await body(req, JSON_MAX)).toString('utf8') || '{}'); } catch { return fail(res, 400, 'Cuerpo inválido.'); }
    const emailRaw = String(b.email || '').trim().toLowerCase();
    const inputCode = String(b.code || '').replace(/\D/g, '');
    const pending = pendingVerifications.get(emailRaw);
    if (!pending || pending.userCode !== user.code) return fail(res, 400, 'No hay ninguna verificación pendiente para este correo.');
    if (Date.now() > pending.expiresAt) {
      pendingVerifications.delete(emailRaw);
      return fail(res, 400, 'El código ha expirado. Solicita uno nuevo.');
    }
    if (inputCode !== pending.code) return fail(res, 400, 'Código de verificación incorrecto.');

    pendingVerifications.delete(emailRaw);
    user.email = pending.email;
    user.email_lower = pending.email;
    user.emailVerified = true;
    user.updatedAt = Date.now();
    save();
    console.log(`[link-email] ${prettyCode(user.code)} ${user.name} vinculó ${user.email}`);
    return ok(res, { email: user.email, emailVerified: true });
  }

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
