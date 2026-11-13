/* Boxshelf Online · its own full screen, rebuilt from zero for the controller.
   The network never happens here (the page's CSP has no https connect-src): every call goes through
   main over IPC (api.online*). Server pictures do load here (the CSP allows *.workers.dev in img-src).
   While this screen is up nothing else answers: app.js steps its pad poll and keys aside, and this
   screen reads the pad itself. D-pad/stick moves the focus, A confirms, B goes back. */
(function () { "use strict";
const api = window.boxshelf;
const esc = s => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = ms => { ms = +ms || 0; const m = Math.round(ms / 6e4); if (m < 1) return "0 min"; if (m < 60) return m + " min"; const h = Math.floor(m / 60); return h >= 100 ? Math.floor(h / 24) + " d " + (h % 24) + " h" : h + " h"; };
const ago = t => { if (!t) return "nunca"; const s = (Date.now() - t) / 1e3; return s < 90 ? "hace un momento" : s < 3600 ? "hace " + Math.round(s / 60) + " min" : s < 86400 ? "hace " + Math.round(s / 3600) + " h" : "hace " + Math.round(s / 86400) + " d"; };
const img = (u, srv) => { u = String(u || ""); if (!u) return ""; return /^https?:/.test(u) ? u : String(srv || "").replace(/\/+$/, "") + u; }; // srv is always a string
const digits = s => String(s || "").replace(/\D/g, "");
const pretty = d => /^\d{12}$/.test(d) ? d.slice(0, 4) + "-" + d.slice(4, 8) + "-" + d.slice(8) : "";

let el = null, busy = false, mode = "home", view = null, focusEl = null, raf = 0, prev = {}, held = null, heldAt = 0, srv = "", returnTarget = "shelf", isClosing = false, authTab = "register", checkNameT = null, pendingEmail = "", regDraft = { name: "", email: "", pass: "" };

/* ---------- screen ---------- */
function ensure() {
  if (el) return;
  const st = document.createElement("style"); st.textContent = `
#onlinePanel{position:fixed;z-index:430;inset:0;display:none;color:#eef3ff;font:600 14px var(--ui,system-ui);overflow-y:auto;overflow-x:hidden;
  background:radial-gradient(1100px 520px at 18% -8%,rgba(64,116,255,.28),transparent 60%),radial-gradient(900px 480px at 88% 4%,rgba(146,74,246,.22),transparent 60%),linear-gradient(160deg,#050a1e 0%,#0a1130 48%,#060b20 100%)}
#onlinePanel.on{display:block}
.ol-wrap{width:min(980px,92vw);margin:0 auto;padding:30px 0 70px}
.ol-top{display:flex;align-items:center;gap:14px}
.ol-brand{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#8fc6ff;font-weight:800}
.ol-top .ol-title{font-size:clamp(26px,3.4vw,40px);font-weight:800;letter-spacing:-.01em;line-height:1;margin:0}
.ol-x{margin-left:auto;width:40px;height:40px;border:1px solid rgba(190,214,255,.25);border-radius:12px;background:rgba(255,255,255,.06);color:#fff;font:800 15px inherit;cursor:pointer;transition:background .15s}
.ol-x:hover,.ol-x.nav-focus{background:#ff5d5d;border-color:transparent;color:#fff}
.ol-sub{margin:10px 2px 0;font-size:12.5px;color:rgba(198,214,255,.66)}
.ol-grid{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);gap:18px;margin-top:22px;align-items:start}
.ol-card{padding:16px;border:1px solid rgba(190,214,255,.18);border-radius:18px;background:linear-gradient(165deg,rgba(44,72,150,.42),rgba(10,16,40,.78));box-shadow:0 18px 46px rgba(0,0,0,.38)}
.ol-lab{display:block;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#9fb4e6;font-weight:800}
.ol-sec{display:flex;align-items:baseline;gap:10px;margin:20px 2px 4px}
.ol-sec b{font-size:15px;font-weight:800}.ol-sec span{font-size:11.5px;color:rgba(198,214,255,.6)}
.ol-btn{padding:10px 14px;border:0;border-radius:11px;background:#4f83f4;color:#fff;font:700 13px inherit;cursor:pointer;transition:transform .12s,background .15s}
.ol-btn:hover,.ol-btn.nav-focus{background:#6f9dff}.ol-btn:active{transform:scale(.96)}.ol-btn:disabled{opacity:.5;cursor:default}
.ol-btn.alt{background:rgba(255,255,255,.12)}.ol-btn.alt:hover,.ol-btn.alt.nav-focus{background:rgba(255,255,255,.24)}
.ol-btn.mini{padding:7px 11px;font-size:12px;border-radius:9px}
.ol-input{width:100%;box-sizing:border-box;margin-top:8px;padding:12px 13px;border:1px solid rgba(210,223,255,.28);border-radius:11px;background:rgba(255,255,255,.08);color:#fff;font:600 14px inherit;outline:none;transition:border-color .15s,background .15s}
.ol-input:focus{border-color:#9ec1ff;background:rgba(255,255,255,.12)}
.ol-input::placeholder{color:rgba(200,214,245,.4)}
.ol-row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.ol-note{font-size:12px;color:rgba(198,214,255,.66);line-height:1.45}
/* my card */
.ol-me{display:flex;gap:14px;align-items:center}
.ol-av{width:66px;height:66px;flex:none;display:grid;place-items:center;overflow:hidden;border-radius:50%;background:linear-gradient(145deg,#75a4ff,#4735a7);color:#fff;font-weight:800;font-size:26px;box-shadow:0 8px 22px rgba(0,0,0,.45),0 0 0 3px rgba(255,255,255,.14)}
.ol-av img{width:100%;height:100%;object-fit:cover}
.ol-av.sm{width:46px;height:46px;font-size:18px}
.ol-me .ol-name{font-size:19px;font-weight:800}
.ol-code{display:flex;align-items:center;gap:8px;margin-top:4px}
.ol-code b{font-family:ui-monospace,Consolas,monospace;font-size:15px;letter-spacing:.1em;color:#cfe0ff;font-weight:700}
.ol-stats{display:flex;gap:10px;margin-top:14px}
.ol-stat{flex:1;padding:10px 12px;border-radius:12px;background:rgba(8,13,34,.55);border:1px solid rgba(190,214,255,.12)}
.ol-stat b{display:block;font-size:17px;font-weight:800;color:#fff}.ol-stat span{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#93a8d8}
/* friend rows */
.ol-friend{display:flex;align-items:center;gap:12px;width:100%;padding:11px 12px;margin-top:9px;text-align:left;color:inherit;font:inherit;cursor:pointer;
  border:1px solid rgba(190,214,255,.16);border-radius:14px;background:rgba(6,10,28,.5);transition:transform .14s,background .14s,border-color .14s}
.ol-friend:hover,.ol-friend.nav-focus{transform:translateY(-2px);background:rgba(82,124,230,.22);border-color:rgba(158,193,255,.55)}
.ol-info{min-width:0;flex:1}.ol-name{font-size:14.5px;font-weight:800}.ol-desc{margin-top:2px;font-size:11.5px;color:rgba(235,240,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ol-meta{margin-left:auto;text-align:right;font-size:10.5px;color:#9db1e2;flex:none}.ol-meta b{display:block;color:#fff;font-size:14.5px;font-weight:800}
.ol-xsmall{width:30px;height:30px;flex:none;display:grid;place-items:center;border:0;border-radius:9px;background:rgba(255,255,255,.1);color:#e8f0ff;font:800 12px inherit;cursor:pointer;transition:background .14s}
.ol-xsmall:hover,.ol-xsmall.nav-focus{background:#ff5d5d;color:#fff}
.ol-xsmall.sure{background:#ff5d5d;color:#fff;width:auto;padding:0 9px}
/* pending requests: a little banner on top, the avatar leaning over its edge */
.ol-pend{position:relative;display:block;width:100%;box-sizing:border-box;margin-top:10px;padding:0 0 12px;border:1px solid rgba(190,214,255,.16);border-radius:14px;background:rgba(6,10,28,.5);overflow:hidden;text-align:left;color:inherit;font:inherit;cursor:pointer;transition:transform .14s,background .14s,border-color .14s}
.ol-pend:hover,.ol-pend.nav-focus{transform:translateY(-2px);background:rgba(82,124,230,.22);border-color:rgba(158,193,255,.55)}
.ol-pban{display:block;height:70px;background:linear-gradient(130deg,#3263cb,#7445b4)}
.ol-pban img{width:100%;height:100%;object-fit:cover;object-position:center;display:block} /* cropped, never stretched */
.ol-prow{display:flex;align-items:center;gap:11px;padding:0 12px}
.ol-pend .ol-av{width:48px;height:48px;margin-top:-24px;border:2px solid rgba(255,255,255,.9);font-size:18px;box-shadow:0 4px 12px rgba(0,0,0,.45)}
.ol-tag{flex:none;padding:4px 10px;border-radius:99px;background:rgba(159,230,169,.14);color:#9fe6a9;font-size:10.5px;font-weight:800;letter-spacing:.05em}
.ol-tag.wait{background:rgba(255,209,120,.13);color:#ffd178}
.ol-empty{margin-top:10px;padding:16px;border:1px dashed rgba(190,214,255,.22);border-radius:14px;text-align:center;font-size:12.5px;color:rgba(198,214,255,.6)}
/* friend profile view */
.ol-hero{position:relative;height:190px;border-radius:16px;overflow:hidden;background:linear-gradient(130deg,#3263cb,#7445b4)}
.ol-hero img{width:100%;height:100%;object-fit:cover;display:block}
.ol-hero .ol-back{position:absolute;left:12px;top:12px;background:rgba(5,9,26,.6);backdrop-filter:blur(4px)}
.ol-view .ol-av{width:78px;height:78px;margin:-40px 0 0 18px;border:3px solid rgba(255,255,255,.92);position:relative}
.ol-view .ol-name{font-size:23px}.ol-code-s{font-size:11px;color:#9fb4e6;letter-spacing:.1em;font-family:ui-monospace,Consolas,monospace}
.ol-desc-big{margin-top:12px;font-size:13.5px;color:rgba(235,242,255,.85);line-height:1.5}
.ol-badge{display:inline-block;padding:4px 10px;border-radius:99px;background:rgba(159,230,169,.16);color:#9fe6a9;font-size:11px;font-weight:800;letter-spacing:.06em}
.ol-toast{margin-top:16px;min-height:20px;font-size:13px;font-weight:700;color:#ffb4b4}.ol-toast.good{color:#9fe6a9}
/* create account */
.ol-create{max-width:520px;margin:26px auto 0}
.ol-kicker{display:flex;align-items:center;gap:12px;margin-top:26px}
.ol-kicker .ol-line{flex:1;height:1px;background:linear-gradient(90deg,rgba(158,193,255,.35),transparent)}
.ol-foot{margin-top:26px;font-size:11px;color:rgba(155,175,220,.5);text-align:center}
@keyframes olPulse{0%,100%{opacity:.55}50%{opacity:1}}
.ol-loading{margin-top:40px;font-size:13px;color:#9ec1ff;animation:olPulse 1.4s ease-in-out infinite}
/* motion: everything slides in softly, staggered; the background breathes */
@keyframes olRise{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}
@keyframes olFade{from{opacity:0}to{opacity:1}}
@keyframes olDrift1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(70px,40px) scale(1.12)}}
@keyframes olDrift2{0%,100%{transform:translate(0,0) scale(1.06)}50%{transform:translate(-80px,-34px) scale(.94)}}
#onlinePanel.on{animation:olFade .28s ease both}
#onlinePanel.closing{animation:olFadeOut .22s cubic-bezier(.16,1,.3,1) forwards;pointer-events:none}
#onlinePanel.closing .ol-wrap{animation:olFall .22s cubic-bezier(.16,1,.3,1) forwards}
@keyframes olFadeOut{from{opacity:1}to{opacity:0}}
@keyframes olFall{from{opacity:1;transform:none}to{opacity:0;transform:translateY(16px) scale(.985)}}
#onlinePanel::before,#onlinePanel::after{content:"";position:fixed;inset:-18%;pointer-events:none;opacity:.5}
#onlinePanel::before{background:radial-gradient(620px 320px at 30% 32%,rgba(64,116,255,.16),transparent 70%);animation:olDrift1 26s ease-in-out infinite}
#onlinePanel::after{background:radial-gradient(560px 300px at 72% 58%,rgba(146,74,246,.14),transparent 70%);animation:olDrift2 34s ease-in-out infinite}
.ol-in{animation:olRise .55s cubic-bezier(.22,.9,.32,1) backwards} /* backwards fill: hover transforms work again once it lands */
.ol-friend,.ol-pend,.ol-btn,.ol-x,.ol-xsmall,.ol-stat,.ol-av{will-change:transform}
@media(prefers-reduced-motion:reduce){#onlinePanel,#onlinePanel *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
@media(max-width:780px){.ol-grid{grid-template-columns:1fr}.ol-hero{height:140px}}
.ol-av-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none}
.ol-status-dot{position:absolute;bottom:0;right:0;width:13px;height:13px;border-radius:50%;border:2.5px solid #060a1c;box-sizing:border-box}
.ol-status-dot.playing{background:#10b981;box-shadow:0 0 8px rgba(16,185,129,.9);animation:olPulseDot 1.8s infinite ease-in-out}
.ol-status-dot.online{background:#38bdf8;box-shadow:0 0 6px rgba(56,189,248,.8)}
.ol-status-dot.offline{background:#64748b}
@keyframes olPulseDot{0%{transform:scale(.95);box-shadow:0 0 0 0 rgba(16,185,129,.7)}70%{transform:scale(1.15);box-shadow:0 0 0 6px rgba(16,185,129,0)}100%{transform:scale(.95);box-shadow:0 0 0 0 rgba(16,185,129,0)}}
.ol-friend.is-playing{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.32)}
.ol-friend.is-playing:hover,.ol-friend.is-playing.nav-focus{background:rgba(16,185,129,.18);border-color:rgba(52,211,153,.65)}
.ol-name-row{display:flex;align-items:center;gap:7px}
.ol-live-pill{font-size:9px;font-weight:800;letter-spacing:.08em;padding:1px 6px;border-radius:99px;background:rgba(16,185,129,.22);color:#34d399;border:1px solid rgba(52,211,153,.45);text-transform:uppercase}
.ol-playing-text{display:flex;align-items:center;gap:5px;margin-top:2px;font-size:11.5px;color:#a7f3d0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ol-game-icon{font-size:11px}
.ol-game-name{overflow:hidden;text-overflow:ellipsis}
.ol-status-label{font-size:11px;font-weight:700}
.ol-status-label.playing{color:#34d399}
.ol-status-label.online{color:#38bdf8}
.ol-presence-hero{display:flex;align-items:center;gap:12px;margin:14px 0 10px;padding:12px 14px;background:linear-gradient(135deg,rgba(16,185,129,.15),rgba(6,78,59,.3));border:1px solid rgba(52,211,153,.4);border-radius:12px}
.ol-ph-dot{width:12px;height:12px;border-radius:50%;background:#10b981;box-shadow:0 0 10px #10b981;animation:olPulseDot 1.8s infinite ease-in-out;flex:none}
.ol-ph-body{min-width:0}
.ol-ph-badge{font-size:9.5px;font-weight:800;letter-spacing:.1em;color:#6ee7b7;text-transform:uppercase}
.ol-ph-title{font-size:15px;font-weight:800;color:#fff;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ol-presence-status{display:inline-flex;align-items:center;gap:7px;margin:12px 0 8px;font-size:12px;color:rgba(220,235,255,.7)}
.ol-presence-status.online{color:#7dd3fc}
.ol-presence-status .ol-status-dot{position:relative;bottom:auto;right:auto;border:0;width:9px;height:9px}
.ol-tab-row{display:flex;gap:6px;padding:4px;border-radius:14px;background:rgba(5,9,26,.65);border:1px solid rgba(190,214,255,.14);margin-bottom:14px}
.ol-tab-btn{flex:1;padding:9px 14px;border:0;border-radius:10px;background:transparent;color:rgba(210,225,255,.7);font:700 13px inherit;cursor:pointer;transition:background .15s,color .15s}
.ol-tab-btn:hover,.ol-tab-btn.nav-focus{background:rgba(255,255,255,.08);color:#fff}
.ol-tab-btn.active{background:#4f83f4;color:#fff;box-shadow:0 4px 14px rgba(79,131,244,.4)}
.ol-name-status{margin-top:6px;font-size:11.5px;font-weight:600;min-height:16px}
.ol-name-status.ok{color:#34d399}
.ol-name-status.err{color:#f87171}
.ol-name-status.wait{color:#93c5fd}
.ol-name-status.info{color:rgba(198,214,255,.55)}
.ol-btn.sure{background:#ff5d5d!important;color:#fff!important}


`; document.head.appendChild(st);
  el = document.createElement("div"); el.id = "onlinePanel"; document.body.appendChild(el);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("keyup", onKeyUp, true);
  el.addEventListener("click", e => { if (e.target === el) close(); });
}

/* ---------- focus: the D-pad (or arrows) walk the cards; A / Enter activates; B / Escape goes back ---------- */
function items() { return el ? [...el.querySelectorAll("[data-olf],input.ol-input")].filter(x => x.dataset.olf !== "close" && (x.offsetParent !== null || x.getClientRects().length)) : []; } // the ✕ stays mouse-only: B/Esc close
function paint() { if (!el) return; el.querySelectorAll(".nav-focus").forEach(x => x.classList.remove("nav-focus")); if (focusEl) { focusEl.classList.add("nav-focus"); try { focusEl.scrollIntoView({ block: "nearest" }); } catch {} } }
function step(dir) {
  const it = items(); if (!it.length) return;
  if (!focusEl || !it.includes(focusEl)) { focusEl = it[0]; paint(); return; }
  const r = focusEl.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, score = 1 / 0;
  for (const x of it) {
    if (x === focusEl) continue;
    const q = x.getBoundingClientRect(), dx = q.left + q.width / 2 - cx, dy = q.top + q.height / 2 - cy;
    let a, b;
    if (dir === "left") { if (dx >= -4) continue; a = -dx; b = Math.abs(dy); }
    else if (dir === "right") { if (dx <= 4) continue; a = dx; b = Math.abs(dy); }
    else if (dir === "up") { if (dy >= -4) continue; a = -dy; b = Math.abs(dx); }
    else { if (dy <= 4) continue; a = dy; b = Math.abs(dx); }
    const sc = a + b * 2.2; if (sc < score) { score = sc; best = x; }
  }
  if (best) { focusEl = best; paint(); }
}
function typing() { const a = document.activeElement; return el && el.classList.contains("on") && a && /^(input|textarea|select)$/i.test(a.tagName) && el.contains(a); }
function act() {
  if (!focusEl) return;
  if (/^(input|textarea|select)$/i.test(focusEl.tagName)) { focusEl.focus(); return; }
  const f = focusEl.dataset.olf, code = focusEl.dataset.code || "";
  if (f === "close") return close();
  if (f === "back") { mode = "home"; view = null; render(); return; }
  if (f === "sync") return run(() => api.onlineSync(), "Perfil sincronizado.", true);
  if (f === "copy") { try { navigator.clipboard.writeText(myCode); toast("Código copiado. Compártelo con tus amigos.", true); } catch { toast("No se pudo copiar."); } return; }
  if (f === "tab-reg") { authTab = "register"; render(); return; }
  if (f === "tab-login") { authTab = "login"; render(); return; }
  if (f === "create") {
    const n = el.querySelector("#olRegName"), p = el.querySelector("#olRegPass");
    if (!n || !p) return;
    const name = n.value.trim(), pass = p.value.trim();
    if (name.length < 3) { toast("El nombre debe tener al menos 3 caracteres."); return; }
    if (pass.length < 4) { toast("La contraseña debe tener al menos 4 caracteres."); return; }
    return run(async () => {
      await api.onlineRegister(name, pass);
      await api.onlineSync();
    }, "¡Cuenta creada! Ya estás en Boxshelf Together.");
  }
  if (f === "login") {
    const idEl = el.querySelector("#olLoginId"), pEl = el.querySelector("#olLoginPass");
    if (!idEl || !pEl) return;
    const id = idEl.value.trim(), pass = pEl.value.trim();
    if (!id) { toast("Escribe tu nombre de usuario o código."); return; }
    if (!pass) { toast("Escribe tu contraseña."); return; }
    return run(async () => {
      const res = await api.onlineLogin(id, pass);
      await api.onlineSync();
      return "¡Sesión iniciada! Bienvenido, " + (res.name || id);
    }, "¡Sesión iniciada!");
  }
  if (f === "logout") {
    const b = focusEl;
    if (!b.classList.contains("sure")) {
      b.classList.add("sure");
      b.textContent = "¿Cerrar sesión?";
      setTimeout(() => { if (b) { b.classList.remove("sure"); b.textContent = "Cerrar sesión"; } }, 3200);
      return;
    }
    return run(async () => {
      await api.onlineLogout();
      return "Sesión cerrada.";
    });
  }
  if (f === "add") return addFriend();
  if (f === "avatar" || f === "banner") return pickImage(f);
  if (f === "view") { mode = "view"; view = code; render(); return; }
  if (f === "accept") return run(async () => { const r = await api.onlineFriendAdd(code); return r && r.status === "friends" ? "¡Ya son amigos!" : "Listo."; });
  if (f === "remove") {
    const b = focusEl;
    if (!b.classList.contains("sure")) { b.classList.add("sure"); b.textContent = "¿Seguro?"; setTimeout(() => { b.classList.remove("sure"); b.textContent = "✕"; }, 2600); return; }
    return run(() => api.onlineFriendRemove(b.dataset.code), "Amigo quitado.");
  }
}
function onKey(e) {
  if (!el || !el.classList.contains("on")) return;
  e.stopPropagation(); // nothing else on the shelf hears a key while this screen is up
  const k = e.key;
  if (k === "Escape") { e.preventDefault(); if (typing()) document.activeElement.blur(); else back(); return; }
  if (typing()) return; // a field has focus: real typing happens normally (Tab moves on its own)
  if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") { e.preventDefault(); step(k.slice(5).toLowerCase()); return; }
  if (k === "Tab") { e.preventDefault(); step(k.shiftKey ? "left" : "right"); return; }
  if (k === "Enter" || k === " ") { e.preventDefault(); act(); }
}
function onKeyUp(e) { if (el && el.classList.contains("on") && !typing()) e.stopPropagation(); }
function back() { if (busy) return; if (mode === "view") { mode = "home"; view = null; render(); } else close(); }

/* ---------- the pad, read here directly (the shelf steps aside while the screen is up) ---------- */
const nintendoPad = id => /switch|nintendo|joy-?con|pro controller|gamecube|wii/i.test(String(id || "")); // on Nintendo pads B confirms
function poll(now) {
  raf = 0; if (!el || !el.classList.contains("on")) return;
  let gp = null; try { for (const p of navigator.getGamepads() || []) if (p && p.connected) { gp = p; break; } } catch {}
  if (gp) {
    const b = gp.buttons || [], ax = gp.axes || [], down = i => !!(b[i] && b[i].pressed);
    const v = (down(13) || ax[1] > .6) ? 1 : (down(12) || ax[1] < -.6) ? -1 : 0, h = (down(15) || ax[0] > .55) ? 1 : (down(14) || ax[0] < -.55) ? -1 : 0;
    const dir = v < 0 ? "up" : v > 0 ? "down" : h < 0 ? "left" : h > 0 ? "right" : null;
    if (dir && !typing()) { if (dir !== held) { held = dir; heldAt = now + 340; step(dir); } else if (now > heldAt) { heldAt = now + 140; step(dir); } } else held = null;
    const aBtn = nintendoPad(gp.id) ? 1 : 0, bBtn = aBtn ? 0 : 1; // A confirms, B goes back (swapped on Nintendo pads)
    const t = typing();
    const edge = (i, fn) => { const p = down(i); if (p && !prev[i]) fn(); prev[i] = p; };
    edge(aBtn, () => act());
    edge(bBtn, () => { if (t) { try { document.activeElement.blur(); } catch {} } else back(); });
    edge(8, () => { if (!t) back(); });  // select/view
    edge(9, () => { if (!t) act(); });   // start
    prev.h = true;
  } else { held = null; prev = {}; }
  raf = requestAnimationFrame(poll);
}

/* ---------- pictures: compressed here, uploaded through main ---------- */
function pickImage(kind) {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    toast(kind === "avatar" ? "Subiendo foto…" : "Subiendo banner…");
    try { const jpeg = await compress(f, kind); await run(() => api.onlineUpload(kind, jpeg), kind === "avatar" ? "Foto actualizada." : "Banner actualizado."); }
    catch (e) { toast(e && e.message || "No se pudo subir la imagen."); }
  };
  inp.click();
}
async function compress(file, kind) {
  const im = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("No se pudo leer la imagen.")); i.src = URL.createObjectURL(file); });
  const W = kind === "avatar" ? 256 : 1024, H = kind === "avatar" ? 256 : Math.min(576, Math.max(200, Math.round(im.height / im.width * 1024)));
  const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
  if (kind === "avatar") { const s = Math.min(im.width, im.height); x.drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, W, H); }
  else { const sh = Math.min(im.height, im.width * H / W); x.drawImage(im, 0, (im.height - sh) / 2, im.width, sh, 0, 0, W, H); }
  return new Promise(ok => { let q = .85; const next = () => c.toBlob(bl => { if (!bl) return ok(null);
    if (bl.size > 300 * 1024 && q > .55) { q -= .15; next(); return; }
    const fr = new FileReader(); fr.onload = () => ok({ type: "image/jpeg", base64: String(fr.result).split(",")[1] }); fr.readAsDataURL(bl); }, "image/jpeg", q); next(); });
}

/* ---------- actions ---------- */
function toast(msg, good) { const t = el && el.querySelector(".ol-toast"); if (!t) return; t.textContent = msg || ""; t.classList.toggle("good", !!good); clearTimeout(toast.t); toast.t = setTimeout(() => { t.textContent = ""; }, 4200); }
async function run(fn, good) {
  if (busy) return; busy = true;
  let r;
  try { r = await fn(); } catch (e) { busy = false; toast(e && e.message || "Algo falló."); return; }
  busy = false; // clear before re-rendering so the buttons don't come back disabled
  try { await render(); startLivePoll(); } catch {}
  if (good) toast(good, true); else if (typeof r === "string") toast(r, true);
  return r;
}
function addFriend() {
  const i = el.querySelector("#olCode"); if (!i) return;
  return run(async () => {
    const d = digits(i.value); if (d.length !== 12) return "El código tiene 12 dígitos (4-4-4).";
    const r = await api.onlineFriendAdd(pretty(d));
    return r && r.status === "friends" ? "¡Ya son amigos!" : "Solicitud enviada. Aparecerá cuando te acepte.";
  });
}

/* ---------- pieces ---------- */
const avatarHtml = (p, cls) => {
  const isPlaying = !!(p && p.playing);
  const isOnline = !!(p && p.isOnline);
  const dot = isPlaying ? '<span class="ol-status-dot playing" title="Jugando ahora"></span>' : (isOnline ? '<span class="ol-status-dot online" title="En línea"></span>' : '');
  return `<span class="ol-av-wrap ${cls || ""}">
    <span class="ol-av ${cls || ""}">${p && p.avatar ? `<img src="${esc(img(p.avatar, srv))}" alt="" loading="lazy">` : esc(((p && p.name) || "?")[0].toUpperCase())}</span>
    ${dot}
  </span>`;
};

function friendRow(p, o) {
  o = o || {};
  return `<${o.div ? "div" : "button"} class="ol-friend" ${o.div ? "" : `data-olf="${o.act || "view"}" data-code="${esc(p.code)}"`}>
    ${avatarHtml(p, "sm")}
    <span class="ol-info"><span class="ol-name">${esc(p.name)}</span><span class="ol-desc">${esc(p.description || "Sin descripción")}</span></span>
    <span class="ol-meta"><b>${fmt(p.totalMs)}</b>${p.favorites || 0} fav${p.playing ? ' · <span style="color:#9fe6a9">jugando</span>' : ""}</span>
    ${o.remove ? `<span class="ol-xsmall" data-olf="remove" data-code="${esc(p.code)}" title="Quitar amigo">✕</span>` : ""}
  </${o.div ? "div" : "button"}>`;
}

// pending requests get their own card: a slice of the person's banner on top (cropped, never stretched),
// the avatar leaning over its edge, and the whole card opens a preview of their profile
function pendingRow(p, kind) { // kind "in" = they asked you, "out" = you asked them
  const inr = kind === "in";
  return `<div class="ol-pend" data-olf="view" data-code="${esc(p.code)}" role="button">
    <span class="ol-pban">${p.banner ? `<img src="${esc(img(p.banner, srv))}" alt="" loading="lazy">` : ""}</span>
    <div class="ol-prow">
      ${avatarHtml(p)}
      <span class="ol-info"><span class="ol-name">${esc(p.name)}</span><span class="ol-desc">${inr ? "Quiere ser tu amigo" : "En espera de su respuesta"} · ${esc(p.code)}</span></span>
      ${inr ? `<button class="ol-btn mini" data-olf="accept" data-code="${esc(p.code)}">Aceptar</button>` : `<span class="ol-tag wait">Esperando</span>`}
    </div>
  </div>`;
}

function myCard(st) {
  return `<div class="ol-card">
    <div class="ol-me">${avatarHtml(st.me || {})}
      <div style="min-width:0">
        <div class="ol-name">${esc(st.name || "—")}</div>
        <div class="ol-code"><b>${esc(st.friendCode)}</b><button class="ol-btn alt mini" data-olf="copy">Copiar</button></div>
      </div>
    </div>
    <div class="ol-stats">
      <span class="ol-stat"><b>${fmt(st.hours)}</b>Horas jugadas</span>
      <span class="ol-stat"><b>${st.favs}</b>Favoritos</span>
      <span class="ol-stat"><b style="font-size:13px;margin-top:2px">${ago(st.lastSync)}</b>Última sincro</span>
    </div>
    <div class="ol-row" style="margin-top:14px">
      <button class="ol-btn" data-olf="sync" ${busy ? "disabled" : ""}>Sincronizar ahora</button>
      <button class="ol-btn alt" data-olf="avatar">Cambiar foto</button>
      <button class="ol-btn alt" data-olf="banner">Cambiar banner</button>
      <button class="ol-btn alt mini" data-olf="logout" style="margin-left:auto;color:#ff9e9e" title="Desvincular esta cuenta de este perfil local">Cerrar sesión</button>
    </div>
    <div class="ol-note" style="margin-top:12px">Tu código es tu identidad: dáselo a quien quieras agregar y agrega el suyo. Cuando los dos se agreguen, son amigos.</div>
  </div>`;
}

function profileView(p) {
  return `<div class="ol-card ol-view" style="padding:12px">
    <div class="ol-hero">${p.banner ? `<img src="${esc(img(p.banner, srv))}" alt="">` : ""}
      <button class="ol-btn mini alt ol-back" data-olf="back">← Volver</button></div>
    <div style="display:flex;align-items:flex-end;gap:14px;padding:0 18px">
      ${avatarHtml(p)}
      <div style="padding-bottom:8px"><div class="ol-name">${esc(p.name)}</div><div class="ol-code-s">${esc(p.code)}</div></div>
      <div style="margin-left:auto;padding-bottom:8px">${p.isFriend === false ? `<button class="ol-btn mini" data-olf="accept" data-code="${esc(p.code)}">+ Agregar</button>` : `<span class="ol-badge">Amigos</span>`}</div>
    </div>
    <div style="padding:0 18px 16px">
      <div class="ol-desc-big">${esc(p.description || "Sin descripción.")}</div>
      <div class="ol-stats"><span class="ol-stat"><b>${fmt(p.totalMs)}</b>Horas jugadas</span><span class="ol-stat"><b>${p.favorites || 0}</b>Favoritos</span></div>
    </div>
  </div>`;
}

function html(st, lists) {
  let inner = `<div class="ol-wrap">
    <div class="ol-top"><div><div class="ol-brand">Boxshelf</div><h1 class="ol-title">${mode === "view" ? "Perfil" : "Boxshelf Online"}</h1></div>
    <button class="ol-x" data-olf="close" title="Cerrar (B)">✕</button></div>`;

  if (!st.registered) {
    if (pendingEmail) {
      inner += `<div class="ol-card ol-create" style="max-width:520px;margin:22px auto 0">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <span style="font-size:26px">📬</span>
          <div>
            <h2 style="font-size:18px;font-weight:800;margin:0">Confirma tu correo</h2>
            <div class="ol-note" style="margin-top:3px">Te enviamos un código de 6 dígitos a <b style="color:#7dd3fc">${esc(pendingEmail)}</b>.</div>
          </div>
        </div>

        <span class="ol-lab" style="margin-top:16px">Código de 6 dígitos</span>
        <input class="ol-input" id="olVerifyCode" maxlength="6" inputmode="numeric" placeholder="000000" style="font-size:24px;letter-spacing:10px;text-align:center;font-weight:800;font-family:ui-monospace,Consolas,monospace">

        <div class="ol-row" style="margin-top:20px;gap:10px">
          <button class="ol-btn" data-olf="verify" ${busy ? "disabled" : ""} style="padding:12px 24px">Verificar y Activar</button>
          <button class="ol-btn alt" data-olf="resend" ${busy ? "disabled" : ""}>Reenviar código</button>
          <button class="ol-btn alt" data-olf="cancel-verify" style="margin-left:auto">← Volver</button>
        </div>
      </div>`;
    } else {
      inner += `<div class="ol-card ol-create" style="max-width:540px;margin:22px auto 0">
        <div class="ol-tab-row">
          <button class="ol-tab-btn ${authTab === "register" ? "active" : ""}" data-olf="tab-reg">Crear cuenta</button>
          <button class="ol-tab-btn ${authTab === "login" ? "active" : ""}" data-olf="tab-login">Iniciar sesión</button>
        </div>
        ${authTab === "register" ? `
          <div class="ol-note" style="margin-bottom:14px">Únete a Boxshelf Together con tu nombre único para jugar con amigos.</div>
          
          <span class="ol-lab">Nombre de usuario</span>
          <input class="ol-input" id="olRegName" maxlength="32" placeholder="Como te verán tus amigos (mínimo 3 letras)" value="${esc(regDraft.name || st.pName || "")}">
          <div class="ol-name-status info" id="olNameStatus">Elige un nombre para identificarte</div>

          <span class="ol-lab" style="margin-top:14px">Correo electrónico <span style="font-size:10.5px;color:rgba(198,214,255,.5);font-weight:500">(opcional, para confirmar tu cuenta)</span></span>
          <input class="ol-input" id="olRegEmail" type="email" maxlength="64" placeholder="tu@correo.com (recibirás un código de 6 dígitos)" value="${esc(regDraft.email || "")}">

          <span class="ol-lab" style="margin-top:14px">Contraseña</span>
          <input class="ol-input" id="olRegPass" type="password" maxlength="64" placeholder="Mínimo 4 caracteres (para entrar desde otra PC)" value="${esc(regDraft.pass || "")}">

          <div class="ol-row" style="margin-top:22px">
            <button class="ol-btn" data-olf="create" ${busy ? "disabled" : ""} style="padding:12px 26px">Crear mi cuenta</button>
          </div>
        ` : `
          <div class="ol-note" style="margin-bottom:14px">¿Ya tienes cuenta? Inicia sesión con tu correo, usuario o código de amigo.</div>
          
          <span class="ol-lab">Correo, Usuario o Código de amigo</span>
          <input class="ol-input" id="olLoginId" maxlength="64" placeholder="ejemplo@correo.com o tu usuario">

          <span class="ol-lab" style="margin-top:14px">Contraseña</span>
          <input class="ol-input" id="olLoginPass" type="password" maxlength="64" placeholder="Tu contraseña">

          <div class="ol-row" style="margin-top:22px">
            <button class="ol-btn" data-olf="login" ${busy ? "disabled" : ""} style="padding:12px 26px">Iniciar sesión</button>
          </div>
        `}
      </div>`;
    }
  } else if (mode === "view") {
    inner += lists.profile ? profileView(lists.profile)
      : `<div class="ol-card" style="margin-top:22px"><span class="ol-note">${esc(lists.verr || "No se pudo abrir el perfil.")}</span><div class="ol-row" style="margin-top:10px"><button class="ol-btn alt" data-olf="back">Volver</button></div></div>`;
  } else {
    const F = lists.friends || [], I = lists.incoming || [], O = lists.outgoing || [];
    inner += `<div class="ol-grid"><div>`;
    inner += myCard(st);
    inner += `</div><div>`;
    if (lists.error) inner += `<div class="ol-card"><span class="ol-note">${esc(lists.error)}</span><div class="ol-row" style="margin-top:10px"><button class="ol-btn alt" data-olf="sync">Reintentar</button></div></div>`;
    else {
      inner += `<div class="ol-card"><span class="ol-lab">Agregar amigo por código</span>
        <input class="ol-input" id="olCode" placeholder="0000-0000-0000" inputmode="numeric" maxlength="14">
        <div class="ol-row" style="margin-top:10px"><button class="ol-btn" data-olf="add" ${busy ? "disabled" : ""}>Enviar solicitud</button></div></div>`;
      inner += `<div class="ol-sec"><b>Tus amigos</b><span>${F.length ? F.length + (F.length === 1 ? " amigo" : " amigos") : ""}</span></div>`;
      inner += F.length ? F.map(p => friendRow(p, { remove: true })).join("") : `<div class="ol-empty">Aún no tienes amigos. Agrega a alguien con su código arriba ↑</div>`;
      if (I.length) inner += `<div class="ol-sec"><b>Solicitudes recibidas</b><span>toca la tarjeta para ver su perfil</span></div>` + I.map(p => pendingRow(p, "in")).join("");
      if (O.length) inner += `<div class="ol-sec"><b>En espera</b><span>toca la tarjeta para ver su perfil</span></div>` + O.map(p => pendingRow(p, "out")).join("");
    }
    inner += `</div></div>`;
  }
  inner += `<div class="ol-foot" style="margin-top:24px;text-align:center;font-size:11.5px;color:rgba(198,214,255,.55)">Servidor: ${esc(st.server || "—")}</div><div class="ol-toast" role="status"></div></div>`;
  return inner;
}

/* ---------- motion helper: cards and rows slide in one after another ---------- */
function animateIn() {
  if (!el) return; let i = 0;
  el.querySelectorAll(".ol-card,.ol-sec,.ol-friend,.ol-pend,.ol-empty,.ol-loading").forEach(n => { n.classList.add("ol-in"); n.style.animationDelay = Math.min(i * 50, 420) + "ms"; i++; });
}

let myCode = "";
async function render() {
  if (!el) return;
  el.classList.add("on"); const prevScroll = el ? el.scrollTop : 0;
  try {
    const st = await api.onlineStatus(); myCode = st.friendCode || ""; srv = String(st.server || "");
    if (st.registered) {
      let hours = 0, favs = [], pName = "";
      try { const h = await api.history(); for (const v of Object.values(h || {})) hours += Math.max(0, +((v && v.ms) || 0)); } catch {}
      try { const c = await api.getConfig(); const u = (c && c.ui) || {}; favs = u.favorites || []; pName = (c && c.profile && c.profile.name) || ""; } catch {}
      st.hours = hours; st.favs = favs.length; st.pName = pName;
      try { st.me = (await api.onlineView(myCode)) || null; } catch { st.me = null; }
    }
    let lists = null;
    if (st.registered) {
      if (mode === "view" && view) {
        const p = await api.onlineView(view).catch(e => ({ verr: (e && e.message) || "No se pudo abrir el perfil." }));
        lists = p.verr ? { verr: p.verr } : { profile: p };
      } else {
        const f = await api.onlineFriends().catch(e => ({ error: (e && e.message) || "No se pudo leer la lista." }));
        lists = f.error ? { error: f.error } : f; if (f && Array.isArray(f.friends)) checkFriendActivity(f.friends);
      }
    }
    el.innerHTML = html(st, lists || {});
    el.querySelectorAll("[data-olf]").forEach(b => b.onclick = e => { e.stopPropagation(); focusEl = b; act(); }); // inner buttons don't wake their card
    const key = focusEl ? (focusEl.dataset.olf || "") + "|" + (focusEl.dataset.code || "") + "|" + (focusEl.id || "") : "";
    const its = items();
    focusEl = its.find(x => (x.dataset.olf || "") + "|" + (x.dataset.code || "") + "|" + (x.id || "") === key)
      || its.find(x => x.dataset.olf === "sync") || its[0] || null; // keep the focus where it was, never on the close button
    paint();
    animateIn();
    if (!raf) raf = requestAnimationFrame(poll);
  } catch (e) {
    try {
      el.innerHTML = `<div class="ol-wrap"><div class="ol-top"><div><div class="ol-brand">Boxshelf</div><h1 class="ol-title">Boxshelf Online</h1></div>
        <button class="ol-x" data-olf="close">✕</button></div>
        <div class="ol-card" style="margin-top:22px"><span class="ol-note">Algo falló al abrir la pantalla: ${esc((e && e.message) || "error desconocido")}</span>
        <div class="ol-row" style="margin-top:10px"><button class="ol-btn" data-olf="close">Cerrar</button></div></div></div>`;
      el.querySelectorAll("[data-olf]").forEach(b => b.onclick = e => { e.stopPropagation(); focusEl = b; act(); });
      focusEl = items()[0] || null; paint(); animateIn();
    } catch {}
  }
}

async function open(opts) {
  opts = opts || {};
  returnTarget = opts.from || "settings"; // it is opened from Settings, so it goes back there (Settings sits over the shelf)
  ensure(); busy = false; mode = "home"; view = null; focusEl = null; prev = {}; held = null;
  el.classList.remove("closing");
  el.classList.add("on");
  el.innerHTML = `<div class="ol-wrap"><div class="ol-top"><div><div class="ol-brand">Boxshelf</div><h1 class="ol-title">Boxshelf Online</h1></div><button class="ol-x" data-olf="close">✕</button></div><div class="ol-loading">Conectando…</div></div>`;
  el.querySelectorAll("[data-olf]").forEach(b => b.onclick = () => { focusEl = b; act(); });
  await render();
}
function close() {
  if (!el || !el.classList.contains("on") || isClosing) return;
  isClosing = true;
  stopLivePoll(); if (raf) { cancelAnimationFrame(raf); raf = 0; }
  try { if (window.play_) window.play_("back"); else if (window.Sound && Sound.play) Sound.play("back"); } catch {}
  el.classList.add("closing");
  setTimeout(() => {
    isClosing = false;
    if (el) {
      el.classList.remove("on", "closing");
      focusEl = null;
    }
    const to = returnTarget;
    returnTarget = "shelf";
    if (to === "settings") {
      if (window.Shelf && Shelf.setMode) Shelf.setMode("browse");
      if (window.Setup && Setup.open) Setup.open({ page: "shelf" });
    } else {
      if (window.Shelf && Shelf.setMode) Shelf.setMode("browse");
      if (window.Shelf && Shelf.holdInput) Shelf.holdInput();
    }
  }, 220);
}
window.BS_ONLINE = { open, close };
})();
