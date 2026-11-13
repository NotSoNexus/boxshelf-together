/* Boxshelf Online · v1 en Cloudflare Workers — the same API as server.js, living on Cloudflare's edge.
   Database: D1 (SQLite). Pictures: KV. Free plan, no card: 100k requests/day, 5 GB database, 1 GB pictures.
   The shelf stays local-first: what lives here is a synced copy of each player's profile, nothing more.

   Deploy (from online/worker/):
     npx wrangler@latest d1 create boxshelf-online      → paste database_id into wrangler.toml
     npx wrangler@latest kv namespace create IMG        → paste id into wrangler.toml
     npx wrangler@latest d1 execute boxshelf-online --remote --file=schema.sql
     npx wrangler@latest deploy                          → your URL: https://boxshelf-online.<tu-subdominio>.workers.dev */

'use strict';

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
    const rawName = u.searchParams.get('name') || '';
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

  if (method === 'POST' && p === '/v1/login') {
    const b = await readJson(req);
    const id = clean(b.identifier, 32);
    const password = String(b.password || '').trim();
    if (!id || !password) return failR('Escribe tu usuario y contraseña.', 400);
    const idDigits = digits(id);
    let target = null;
    if (idDigits.length === 12) {
      target = await env.DB.prepare('SELECT * FROM users WHERE code=?').bind(idDigits).first();
    }
    if (!target) {
      target = await env.DB.prepare('SELECT * FROM users WHERE name_lower=?').bind(id.toLowerCase()).first();
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

  if (method === 'GET' && p === '/v1/me') return okR({ ...rowToProfile(user), favoritesList: parseArr(user.favorites) });

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
