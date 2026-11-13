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
// anything a player typed (name, description) may end up in HTML: escape it once, here
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// inside meta attributes the ">" is harmless and Discord needs it literally (block quotes), so keep it
const escAttr = s => String(s == null ? '' : s).replace(/[&"<]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;' }[c]));
const digits = s => String(s || '').replace(/\D/g, '');
const prettyCode = d => (/^\d{12}$/.test(d) ? d.slice(0, 4) + '-' + d.slice(4, 8) + '-' + d.slice(8) : d);
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async v => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v))))].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256Buf = async buf => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(x => x.toString(16).padStart(2, '0')).join('');
const parseArr = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const parseObj = v => { try { const o = JSON.parse(v || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
// how the picture sits in its circle / strip: zoom (1 = fills, 3 = 3×) and pan, capped by the zoom
const cleanFit = v => {
  const one = k => {
    const f = (v && typeof v === 'object' && v[k] && typeof v[k] === 'object') ? v[k] : {};
    const z = Math.min(3, Math.max(1, Math.round((+f.z || 1) * 100) / 100)), lim = (z - 1) * 50;
    const clamp = n => Math.min(lim, Math.max(-lim, Math.round((+n || 0) * 100) / 100));
    return { z, x: clamp(f.x), y: clamp(f.y) };
  };
  return { avatar: one('avatar'), banner: one('banner') };
};
// the same framing the app shows, applied to the web card
const fitCss = (fit, k) => {
  const f = cleanFit(fit)[k] || {};
  return `transform:translate(${f.x}%,${f.y}%) scale(${f.z})`;
};
// what anyone (the owner or a friend) may see about a profile: never the token hash or pending lists
const rowToProfile = r => ({
  code: prettyCode(r.code), name: r.name, description: r.description || '',
  avatar: r.avatar || '', banner: r.banner || '',
  favorites: parseArr(r.favorites).length,
  fit: parseObj(r.fit),
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

  // Web / Discord preview & deep link: /u/<code_or_name>
  if (method === 'GET' && p.startsWith('/u/')) {
    const rawTarget = p.slice(3);
    const targetDigits = digits(rawTarget);
    let u = null;
    if (targetDigits.length === 12) {
      u = await env.DB.prepare('SELECT * FROM users WHERE code=?').bind(targetDigits).first();
    }
    if (!u) {
      u = await env.DB.prepare('SELECT * FROM users WHERE name_lower=?').bind(decodeURIComponent(rawTarget).toLowerCase()).first();
    }
    if (!u) {
      return new Response('<html><body style="background:#050a1e;color:#fff;font-family:sans-serif;text-align:center;padding:50px"><h2>Usuario no encontrado en Boxshelf Together</h2></body></html>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    const prof = rowToProfile(u);
    const srv = url.origin;
    const avatarUrl = prof.avatar ? (prof.avatar.startsWith('http') ? prof.avatar : srv + prof.avatar) : '';
    const bannerUrl = prof.banner ? (prof.banner.startsWith('http') ? prof.banner : srv + prof.banner) : '';
    const ogImage = bannerUrl || avatarUrl;
    const hRaw = (prof.totalMs || 0) / 36e5;
    const hoursText = hRaw >= 100 ? Math.round(hRaw).toLocaleString('es-ES') : String(Math.round(hRaw * 10) / 10);
    const playing = prof.playing ? clean(prof.playing, 80) : '';
    const about = clean(prof.description || 'Jugador en Boxshelf Together', 160);
    const canonical = `${srv}/u/${u.code}`;
    const boxshelfUri = `boxshelf://user/${u.code}`;
    // The preview Discord shows: two tidy lines, the player's own text as a quote and the code as inline code.
    const embedDesc = [
      `🕹️ **${hoursText} h** jugadas  ·  ⭐ **${prof.favorites}** favoritos`,
      about ? `> ${about}` : '',
      playing ? `🎮 Jugando ahora: **${playing}**` : '',
      '🆔 `' + prof.code + '`'
    ].filter(Boolean).join('\n');

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${esc(prof.name)} en Boxshelf Together 🎮</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#5b8dff">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${escAttr(canonical)}">

  <!-- Open Graph / Discord embed -->
  <meta property="og:type" content="profile">
  <meta property="og:site_name" content="Boxshelf Together">
  <meta property="og:url" content="${escAttr(canonical)}">
  <meta property="og:title" content="${escAttr(prof.name)}">
  <meta property="og:description" content="${escAttr(embedDesc)}">
  <meta property="og:locale" content="es_ES">
  ${ogImage ? `<meta property="og:image" content="${escAttr(ogImage)}">
  <meta property="og:image:alt" content="Foto de perfil de ${escAttr(prof.name)}">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escAttr(prof.name)} en Boxshelf Together">
  <meta name="twitter:description" content="${escAttr(embedDesc)}">
  ${ogImage ? `<meta name="twitter:image" content="${escAttr(ogImage)}">` : ''}

  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #050a1e; color: #eaf1ff; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    body::before { content: ""; position: fixed; inset: 0; z-index: -2; background: radial-gradient(60% 50% at 50% 0%, rgba(91,141,255,.30), transparent 70%), radial-gradient(45% 45% at 88% 100%, rgba(139,92,246,.20), transparent 72%), #050a1e; }
    body::after { content: ""; position: fixed; inset: 0; z-index: -1; background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size: 46px 46px; -webkit-mask-image: radial-gradient(70% 60% at 50% 40%, #000 15%, transparent 75%); mask-image: radial-gradient(70% 60% at 50% 40%, #000 15%, transparent 75%); }
    .card { width: 100%; max-width: 460px; border-radius: 26px; overflow: hidden; position: relative; background: linear-gradient(180deg, rgba(22,32,64,.94), rgba(8,13,32,.97)); border: 1px solid rgba(150,180,255,.18); box-shadow: 0 30px 80px -20px rgba(0,0,0,.85), 0 0 0 1px rgba(255,255,255,.04) inset, 0 0 70px rgba(91,141,255,.14); }
    .hero { height: 158px; position: relative; overflow: hidden; background: linear-gradient(135deg, #2a4fb8, #6d3fc4); }
    .hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
    .hero::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(5,9,26,.02), rgba(8,13,32,.55) 62%, rgba(8,13,32,.99)); }
    .avatar-wrap { position: relative; width: 98px; height: 98px; margin: -51px auto 0; z-index: 2; }
    .avatar { width: 98px; height: 98px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; font-size: 38px; font-weight: 800; color: #fff; background: linear-gradient(145deg, #75a4ff, #4735a7); box-shadow: 0 0 0 4px rgba(8,13,32,.96), 0 0 0 5.5px rgba(150,180,255,.34), 0 18px 40px rgba(0,0,0,.55); }
    .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dot { position: absolute; right: 3px; bottom: 3px; width: 19px; height: 19px; border-radius: 50%; background: #34d399; border: 3px solid #0b1126; box-shadow: 0 0 14px rgba(52,211,153,.85); }
    .content { padding: 14px 26px 26px; text-align: center; }
    h1 { margin: 10px 0 8px; font-size: 26px; line-height: 1.15; letter-spacing: -.02em; background: linear-gradient(180deg, #fff, #c3d5ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .code { display: inline-flex; align-items: center; gap: 7px; font: 600 12.5px/1 ui-monospace, Consolas, monospace; letter-spacing: .14em; color: #9dc0ff; background: rgba(120,160,255,.09); border: 1px solid rgba(140,175,255,.2); padding: 8px 12px; border-radius: 999px; }
    .live { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; padding: 5px 11px; border-radius: 999px; font-size: 11.5px; font-weight: 700; color: #6ee7b7; background: rgba(52,211,153,.10); border: 1px solid rgba(52,211,153,.28); }
    .desc { margin: 16px 0 0; font-size: 14px; line-height: 1.5; color: #9fb0cf; min-height: 20px; }
    .stats { display: flex; gap: 12px; margin: 20px 0 22px; }
    .stat { flex: 1; padding: 13px 8px; border-radius: 16px; background: rgba(120,160,255,.07); border: 1px solid rgba(140,175,255,.14); }
    .stat b { display: block; font-size: 21px; letter-spacing: -.02em; color: #fff; }
    .stat span { display: block; margin-top: 4px; font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: #7d8fb3; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 9px; width: 100%; padding: 14px; border-radius: 14px; background: linear-gradient(135deg, #5b8dff, #7b5bff); color: #fff; font-weight: 800; font-size: 14.5px; text-decoration: none; box-shadow: 0 12px 30px -6px rgba(91,141,255,.55), 0 0 0 1px rgba(255,255,255,.12) inset; transition: transform .16s ease, filter .16s ease; }
    .btn:hover { transform: translateY(-2px); filter: brightness(1.08); }
    .foot { margin-top: 14px; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: #55668a; }
  </style>
</head>
<body>
  <div class="card">
    <div class="hero">${bannerUrl ? `<img src="${esc(bannerUrl)}" alt="" style="${fitCss(prof.fit, 'banner')}">` : ''}</div>
    <div class="avatar-wrap">
      <div class="avatar">${avatarUrl ? `<img src="${esc(avatarUrl)}" alt="" style="${fitCss(prof.fit, 'avatar')}">` : esc((prof.name[0] || '?').toUpperCase())}</div>
      ${playing ? '<span class="dot" title="Jugando ahora"></span>' : ''}
    </div>
    <div class="content">
      <h1>${esc(prof.name)}</h1>
      <div class="code">🆔 ${esc(prof.code)}</div>
      ${playing ? `<div class="live">🎮 Jugando ahora · ${esc(playing)}</div>` : ''}
      <p class="desc">${esc(about)}</p>
      <div class="stats">
        <div class="stat"><b>${esc(hoursText)} h</b><span>Tiempo jugado</span></div>
        <div class="stat"><b>${prof.favorites}</b><span>Favoritos</span></div>
      </div>
      <a class="btn" href="${esc(boxshelfUri)}">Abrir en Boxshelf <span>→</span></a>
      <div class="foot">Boxshelf Together</div>
    </div>
  </div>
  <script>
    // Intentar abrir la app automáticamente (la página queda visible si no está instalada)
    setTimeout(() => { try { window.location.href = ${JSON.stringify(boxshelfUri)}; } catch (e) {} }, 700);
  </script>
</body>
</html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
  }

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
    let fit = user.fit || '{}';
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
    if (b.fit != null && typeof b.fit === 'object') fit = JSON.stringify(cleanFit(b.fit));
    await env.DB.prepare('UPDATE users SET name=?,name_lower=?,description=?,totalMs=?,playing=?,favorites=?,fit=? WHERE code=?')
      .bind(name, name.toLowerCase(), description, totalMs, playing, favorites, fit, user.code).run();
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
    if (parseArr(target.outgoing).includes(user.code) || parseArr(user.outgoing).includes(target.code)) { // one asked, the other accepts (or both asked): friends at once
      const myIn = drop(parseArr(user.incoming), target.code), myOut = drop(parseArr(user.outgoing), target.code);
      const tIn = drop(parseArr(target.incoming), user.code), tOut = drop(parseArr(target.outgoing), user.code);
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET friends=?,incoming=?,outgoing=? WHERE code=?').bind(JSON.stringify([...new Set([...myFriends, target.code])]), JSON.stringify(myIn), JSON.stringify(myOut), user.code),
        env.DB.prepare('UPDATE users SET friends=?,incoming=?,outgoing=? WHERE code=?').bind(JSON.stringify([...new Set([...tFriends, user.code])]), JSON.stringify(tIn), JSON.stringify(tOut), target.code)
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
