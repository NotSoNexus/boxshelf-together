/* Boxshelf Online · v1 en Cloudflare Workers — the same API as server.js, living on Cloudflare's edge.
   Database: D1 (SQLite). Pictures: KV. Free plan, no card: 100k requests/day, 5 GB database, 1 GB pictures.
   The shelf stays local-first: what lives here is a synced copy of each player's profile, nothing more.

   Deploy (from online/worker/):
     npx wrangler@latest d1 create boxshelf-online      → paste database_id into wrangler.toml
     npx wrangler@latest kv namespace create IMG        → paste id into wrangler.toml
     npx wrangler@latest d1 execute boxshelf-online --remote --file=schema.sql
     npx wrangler@latest deploy                          → your URL: https://boxshelf-online.<tu-subdominio>.workers.dev */

'use strict';

async function sendWorkerEmail(env, email, code) {
  if (env.RESEND_API_KEY) {
    try {
      const from = env.EMAIL_FROM || 'Boxshelf Together <onboarding@resend.dev>';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
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
      return r.ok;
    } catch {}
  }
  return true;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Max-Age': '86400' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
const okR = data => json({ ok: true, data });
const failR = (error, status = 400) => json({ ok: false, error }, status);
const boom = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };

/* ---------- small shared helpers, named like the app does it ---------- */
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const digits = s => String(s || '').replace(/\D/g, '');
const prettyCode = d => (/^\d{12}$/.test(d) ? d.slice(0, 4) + '-' + d.slice(4, 8) + '-' + d.slice(8) : d);
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async v => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v))))].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256Buf = async buf => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(x => x.toString(16).padStart(2, '0')).join('');
const parseArr = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
// what anyone (the owner or a friend) may see about a profile: never the token hash or pending lists
const rowToProfile = r => ({
  code: prettyCode(r.code), name: r.name, description: r.description || '',
  avatar: r.avatar || '', banner: r.banner || '',
  favorites: parseArr(r.favorites).length,
  totalMs: Math.max(0, +r.totalMs || 0), playing: clean(r.playing, 80) || null, createdAt: r.createdAt
});
const readJson = async req => { try { return await req.json(); } catch { boom('Cuerpo inválido.'); } };

async function newCode(env) { // 12 digits, unique among the users there are
  for (;;) {
    const d = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x % 10).join('');
    if (!(await env.DB.prepare('SELECT 1 FROM users WHERE code=?').bind(d).first())) return d;
  }
}

/* ---------- auth: the token is the account's key, only its hash is ever stored ---------- */
const me = async (req, env) => {
  const m = /^Bearer ([0-9a-f]{64})$/i.exec(req.headers.get('Authorization') || '');
  if (!m) return null;
  return env.DB.prepare('SELECT * FROM users WHERE tokenHash=?').bind(await sha256Hex(m[1])).first();
};

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  if (method === 'GET' && (p === '/v1/ping' || p === '/')) return okR({ pong: true, service: 'boxshelf-online', version: 1 });

  if (method === 'GET' && p.startsWith('/img/')) return serveImg(env, p.slice(5));

  if (method === 'GET' && p === '/v1/check-name') {
    const rawName = url.searchParams.get('name') || '';
    const name = clean(rawName, 32);
    if (name.length < 3) return okR({ available: false, reason: 'Mínimo 3 caracteres' });
    const seen = await env.DB.prepare('SELECT 1 FROM users WHERE name_lower=?').bind(name.toLowerCase()).first();
    return okR({ available: !seen, name });
  }

  if (method === 'POST' && p === '/v1/register') {
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const hourAgo = Date.now() - 36e5;
    const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM reglog WHERE ip=? AND at>?').bind(ip, hourAgo).first();
    if ((seen && seen.n) >= 6) return failR('Demasiados registros desde esta conexión. Prueba más tarde.', 429);
    const b = await readJson(req);
    const name = clean(b.name, 32);
    if (name.length < 3) return failR('El nombre debe tener al menos 3 caracteres.');
    const password = String(b.password || '').trim();
    if (password.length < 4) return failR('La contraseña debe tener al menos 4 caracteres.');
    if (await env.DB.prepare('SELECT 1 FROM users WHERE name_lower=?').bind(name.toLowerCase()).first())
      return failR('Ya existe alguien con ese nombre. Elige otro.', 409);
    
    const emailRaw = String(b.email || '').trim().toLowerCase();
    if (emailRaw) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) return failR('El formato del correo electrónico no es válido.', 400);
      try {
        if (await env.DB.prepare('SELECT 1 FROM users WHERE email_lower=?').bind(emailRaw).first())
          return failR('Ese correo electrónico ya está registrado.', 409);
      } catch {}
      const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
      try {
        await env.DB.prepare('INSERT OR REPLACE INTO pending_verifications (email,code,name,password,expiresAt) VALUES (?,?,?,?,?)')
          .bind(emailRaw, verifyCode, name, password, Date.now() + 600000).run();
      } catch {}
      await sendWorkerEmail(env, emailRaw, verifyCode);
      return okR({ pendingVerification: true, email: emailRaw, devCode: env.RESEND_API_KEY ? undefined : verifyCode });
    }

    const code = await newCode(env), token = hex(32);
    const pHash = await sha256Hex(password + ':' + code);
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM reglog WHERE at<?').bind(hourAgo),
        env.DB.prepare('INSERT INTO reglog (ip,at) VALUES (?,?)').bind(ip, now),
        env.DB.prepare('INSERT INTO users (code,name,name_lower,passwordHash,tokenHash,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)').bind(code, name, name.toLowerCase(), pHash, await sha256Hex(token), now, now)
      ]);
    } catch {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM reglog WHERE at<?').bind(hourAgo),
        env.DB.prepare('INSERT INTO reglog (ip,at) VALUES (?,?)').bind(ip, now),
        env.DB.prepare('INSERT INTO users (code,name,name_lower,tokenHash,createdAt) VALUES (?,?,?,?,?)').bind(code, name, name.toLowerCase(), await sha256Hex(token), now)
      ]);
    }
    return okR({ friendCode: prettyCode(code), token, name });
  }

  if (method === 'POST' && p === '/v1/verify-email') {
    const b = await readJson(req);
    const emailRaw = String(b.email || '').trim().toLowerCase();
    const inputCode = String(b.code || '').replace(/\D/g, '');
    let pending = null;
    try {
      pending = await env.DB.prepare('SELECT * FROM pending_verifications WHERE email=?').bind(emailRaw).first();
    } catch {}
    if (!pending) return failR('No hay ninguna verificación pendiente para este correo o ya expiró.', 400);
    if (Date.now() > pending.expiresAt) {
      try { await env.DB.prepare('DELETE FROM pending_verifications WHERE email=?').bind(emailRaw).run(); } catch {}
      return failR('El código ha expirado. Solicita uno nuevo.', 400);
    }
    if (inputCode !== pending.code) return failR('Código de verificación incorrecto.', 400);

    try { await env.DB.prepare('DELETE FROM pending_verifications WHERE email=?').bind(emailRaw).run(); } catch {}
    const code = await newCode(env), token = hex(32);
    const pHash = await sha256Hex(pending.password + ':' + code);
    const now = Date.now();
    try {
      await env.DB.prepare('INSERT INTO users (code,name,name_lower,email,email_lower,emailVerified,passwordHash,tokenHash,createdAt,updatedAt) VALUES (?,?,?,?,?,1,?,?,?,?)')
        .bind(code, pending.name, pending.name.toLowerCase(), pending.email, pending.email, pHash, await sha256Hex(token), now, now).run();
    } catch {
      await env.DB.prepare('INSERT INTO users (code,name,name_lower,passwordHash,tokenHash,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
        .bind(code, pending.name, pending.name.toLowerCase(), pHash, await sha256Hex(token), now, now).run();
    }
    return okR({ friendCode: prettyCode(code), token, name: pending.name, email: pending.email });
  }

  if (method === 'POST' && p === '/v1/resend-code') {
    const b = await readJson(req);
    const emailRaw = String(b.email || '').trim().toLowerCase();
    let pending = null;
    try {
      pending = await env.DB.prepare('SELECT * FROM pending_verifications WHERE email=?').bind(emailRaw).first();
    } catch {}
    if (!pending) return failR('No hay ninguna verificación pendiente para este correo.', 400);
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
    try {
      await env.DB.prepare('UPDATE pending_verifications SET code=?, expiresAt=? WHERE email=?')
        .bind(verifyCode, Date.now() + 600000, emailRaw).run();
    } catch {}
    await sendWorkerEmail(env, emailRaw, verifyCode);
    return okR({ sent: true });
  }

  if (method === 'POST' && p === '/v1/login') {
    const b = await readJson(req);
    const id = clean(b.identifier, 64);
    const password = String(b.password || '').trim();
    if (!id || !password) return failR('Escribe tu usuario, correo o código.', 400);
    const idDigits = digits(id);
    const idLower = id.toLowerCase();
    let target = null;
    if (idDigits.length === 12) {
      target = await env.DB.prepare('SELECT * FROM users WHERE code=?').bind(idDigits).first();
    }
    if (!target) {
      try {
        target = await env.DB.prepare('SELECT * FROM users WHERE email_lower=?').bind(idLower).first();
      } catch {}
    }
    if (!target) {
      target = await env.DB.prepare('SELECT * FROM users WHERE name_lower=?').bind(idLower).first();
    }
    if (!target) return failR('Usuario o contraseña incorrectos.', 401);
    if (target.passwordHash) {
      const pHash = await sha256Hex(password + ':' + target.code);
      if (pHash !== target.passwordHash) return failR('Usuario o contraseña incorrectos.', 401);
    }
    const token = hex(32);
    const tokenHash = await sha256Hex(token);
    try {
      await env.DB.prepare('UPDATE users SET tokenHash=?, updatedAt=? WHERE code=?').bind(tokenHash, Date.now(), target.code).run();
    } catch {
      await env.DB.prepare('UPDATE users SET tokenHash=? WHERE code=?').bind(tokenHash, target.code).run();
    }
    return okR({ friendCode: prettyCode(target.code), token, name: target.name });
  }

  const user = await me(req, env);
  if (!user) return failR('Sesión no válida. Vuelve a entrar con tu código de amigo.', 401);

  if (method === 'GET' && p === '/v1/me') return okR({ ...rowToProfile(user), email: user.email || '', emailVerified: !!user.emailVerified, hasPassword: !!user.passwordHash, favoritesList: parseArr(user.favorites) });

  if (method === 'POST' && p === '/v1/me/password') {
    const b = await readJson(req);
    const newPassword = String(b.newPassword || '').trim();
    const currentPassword = String(b.currentPassword || '').trim();
    if (newPassword.length < 4) return failR('La nueva contraseña debe tener al menos 4 caracteres.', 400);

    if (user.passwordHash) {
      if (!currentPassword) return failR('Escribe tu contraseña actual.', 400);
      const currHash = await sha256Hex(currentPassword + ':' + user.code);
      if (currHash !== user.passwordHash) return failR('La contraseña actual es incorrecta.', 401);
    }

    const newHash = await sha256Hex(newPassword + ':' + user.code);
    try {
      await env.DB.prepare('UPDATE users SET passwordHash=?, updatedAt=? WHERE code=?').bind(newHash, Date.now(), user.code).run();
    } catch {
      await env.DB.prepare('UPDATE users SET passwordHash=? WHERE code=?').bind(newHash, user.code).run();
    }
    return okR({ hasPassword: true });
  }

  if (method === 'POST' && p === '/v1/me/link-email') {
    const b = await readJson(req);
    const emailRaw = String(b.email || '').trim().toLowerCase();
    if (!emailRaw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) return failR('El formato del correo electrónico no es válido.', 400);
    try {
      if (await env.DB.prepare('SELECT 1 FROM users WHERE email_lower=? AND code<>?').bind(emailRaw, user.code).first())
        return failR('Ese correo electrónico ya está registrado en otra cuenta.', 409);
    } catch {}
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
    try {
      await env.DB.prepare('INSERT OR REPLACE INTO pending_verifications (email,code,name,password,expiresAt) VALUES (?,?,?,?,?)')
        .bind(emailRaw, verifyCode, user.code, '', Date.now() + 600000).run();
    } catch {}
    await sendWorkerEmail(env, emailRaw, verifyCode);
    return okR({ pendingVerification: true, email: emailRaw, devCode: env.RESEND_API_KEY ? undefined : verifyCode });
  }

  if (method === 'POST' && p === '/v1/me/confirm-email') {
    const b = await readJson(req);
    const emailRaw = String(b.email || '').trim().toLowerCase();
    const inputCode = String(b.code || '').replace(/\D/g, '');
    let pending = null;
    try {
      pending = await env.DB.prepare('SELECT * FROM pending_verifications WHERE email=?').bind(emailRaw).first();
    } catch {}
    if (!pending || pending.name !== user.code) return failR('No hay ninguna verificación pendiente para este correo o ya expiró.', 400);
    if (Date.now() > pending.expiresAt) {
      try { await env.DB.prepare('DELETE FROM pending_verifications WHERE email=?').bind(emailRaw).run(); } catch {}
      return failR('El código ha expirado. Solicita uno nuevo.', 400);
    }
    if (inputCode !== pending.code) return failR('Código de verificación incorrecto.', 400);

    try { await env.DB.prepare('DELETE FROM pending_verifications WHERE email=?').bind(emailRaw).run(); } catch {}
    try {
      await env.DB.prepare('UPDATE users SET email=?, email_lower=?, emailVerified=1, updatedAt=? WHERE code=?')
        .bind(emailRaw, emailRaw, Date.now(), user.code).run();
    } catch {}
    return okR({ email: emailRaw, emailVerified: true });
  }

  if (method === 'PUT' && p === '/v1/me') {
    const b = await readJson(req);
    let { name, description, totalMs, playing, favorites } = user;
    if (b.name != null) {
      name = clean(b.name, 32);
      if (name.length < 1) return failR('Escribe un nombre.');
      if (await env.DB.prepare('SELECT 1 FROM users WHERE name_lower=? AND code<>?').bind(name.toLowerCase(), user.code).first())
        return failR('Ya existe alguien con ese nombre. Elige otro.', 409);
    }
    if (b.description != null) description = clean(b.description, 160);
    if (b.totalMs != null) totalMs = Math.max(0, Math.round(+b.totalMs) || 0);
    if (b.playing !== undefined) playing = clean(b.playing, 80) || '';
    if (Array.isArray(b.favorites)) favorites = JSON.stringify([...new Set(b.favorites.map(v => clean(v, 120)).filter(Boolean))].slice(0, 500));
    await env.DB.prepare('UPDATE users SET name=?,name_lower=?,description=?,totalMs=?,playing=?,favorites=? WHERE code=?')
      .bind(name, name.toLowerCase(), description, totalMs, playing, favorites, user.code).run();
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE code=?').bind(user.code).first();
    return okR({ ...rowToProfile(fresh), favoritesList: parseArr(fresh.favorites) });
  }

  if (method === 'POST' && (p === '/v1/me/avatar' || p === '/v1/me/banner')) {
    const kind = p.endsWith('avatar') ? 'avatar' : 'banner';
    const buf = await req.arrayBuffer();
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[(req.headers.get('Content-Type') || '').split(';')[0].trim()];
    if (!ext) return failR('La imagen debe ser JPG, PNG o WebP.', 415);
    if (!buf.byteLength) return failR('Imagen vacía.');
    if (buf.byteLength > 400 * 1024) return failR('La imagen pesa más de 400 KB. Guárdala un poco más pequeña.', 413);
    const name = await sha256Buf(buf) + ext; // content-addressed: same picture, same file, KV cached by the browser
    await env.IMG.put(name, buf);
    await env.DB.prepare(`UPDATE users SET ${kind}=? WHERE code=?`).bind('/img/' + name, user.code).run();
    const old = user[kind];
    if (old && old !== '/img/' + name) await env.IMG.delete(old.slice(5));
    return okR({ [kind]: '/img/' + name });
  }

  if (method === 'GET' && p.startsWith('/v1/profile/')) {
    const target = await env.DB.prepare('SELECT * FROM users WHERE code=?').bind(digits(p.slice(12))).first();
    if (!target) return failR('No hay nadie con ese código de amigo.', 404);
    return okR({ ...rowToProfile(target), isFriend: parseArr(user.friends).includes(target.code) });
  }

  if (method === 'GET' && p === '/v1/friends') {
    const list = async codes => {
      if (!codes.length) return [];
      const rows = await env.DB.prepare(`SELECT * FROM users WHERE code IN (${codes.map(() => '?').join(',')})`).bind(...codes).all();
      return (rows.results || []).map(rowToProfile);
    };
    return okR({ friends: await list(parseArr(user.friends)), incoming: await list(parseArr(user.incoming)), outgoing: await list(parseArr(user.outgoing)) });
  }

  if (method === 'POST' && p === '/v1/friends') {
    const b = await readJson(req);
    const target = await env.DB.prepare('SELECT * FROM users WHERE code=?').bind(digits(b.code)).first();
    if (!target) return failR('No hay nadie con ese código de amigo.', 404);
    if (target.code === user.code) return failR('Ese eres tú.');
    const myFriends = parseArr(user.friends), tFriends = parseArr(target.friends);
    const drop = (arr, c) => arr.filter(x => x !== c);
    if (myFriends.includes(target.code)) return okR({ status: 'friends' });
    if (parseArr(target.outgoing).includes(user.code)) { // both asked: friends at once
      const myNew = { friends: [...myFriends, target.code], outgoing: drop(parseArr(user.outgoing), target.code) };
      const tNew = { friends: [...tFriends, user.code], incoming: drop(parseArr(target.incoming), user.code) };
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET friends=?,outgoing=? WHERE code=?').bind(JSON.stringify(myNew.friends), JSON.stringify(myNew.outgoing), user.code),
        env.DB.prepare('UPDATE users SET friends=?,incoming=? WHERE code=?').bind(JSON.stringify(tNew.friends), JSON.stringify(tNew.incoming), target.code)
      ]);
      return okR({ status: 'friends' });
    }
    const myOut = [...new Set([...parseArr(user.outgoing), target.code])];
    const tIn = [...new Set([...parseArr(target.incoming), user.code])];
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET outgoing=? WHERE code=?').bind(JSON.stringify(myOut), user.code),
      env.DB.prepare('UPDATE users SET incoming=? WHERE code=?').bind(JSON.stringify(tIn), target.code)
    ]);
    return okR({ status: 'requested' });
  }

  if (method === 'DELETE' && p.startsWith('/v1/friends/')) {
    const target = await env.DB.prepare('SELECT * FROM users WHERE code=?').bind(digits(p.slice(12))).first();
    if (target) { // leaves friendship and any pending request between the two, both sides
      const strip = arr => { const a = parseArr(arr); return JSON.stringify(a.filter(x => x !== target.code)); };
      const stripT = arr => { const a = parseArr(arr); return JSON.stringify(a.filter(x => x !== user.code)); };
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET friends=?,incoming=?,outgoing=? WHERE code=?').bind(strip(user.friends), strip(user.incoming), strip(user.outgoing), user.code),
        env.DB.prepare('UPDATE users SET friends=?,incoming=?,outgoing=? WHERE code=?').bind(stripT(target.friends), stripT(target.incoming), stripT(target.outgoing), target.code)
      ]);
    }
    return okR({ removed: true });
  }

  return failR('Ruta desconocida.', 404);
}

/* ---------- pictures: content-addressed, immutable for the browser ---------- */
async function serveImg(env, name) {
  if (!/^[0-9a-f]{64}\.(jpg|png|webp)$/.test(name)) return failR('Imagen desconocida.', 404);
  const buf = await env.IMG.get(name, { type: 'arrayBuffer' });
  if (!buf) return failR('Imagen desconocida.', 404);
  const ext = name.split('.')[1];
  return new Response(buf, { headers: { 'Content-Type': 'image/' + (ext === 'jpg' ? 'jpeg' : ext), 'Cache-Control': 'public, max-age=2592000, immutable', ...CORS } });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS }); // the page asks first (CORS)
    try { return await route(req, env); }
    catch (e) { return e && e.status ? failR(e.message, e.status) : failR('Error interno.', 500); }
  }
};
