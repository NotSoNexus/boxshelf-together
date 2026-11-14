// Hidden window: cuts a two-page scan into its left and right halves (off Boxshelf's main thread, which a large
// scan used to freeze for up to a couple of seconds). The image arrives as bytes: a canvas holding a file:// image
// is "tainted" and can't be exported.
/* global wum */
wum.onModel(async job => {
  try {
    // (beta.13) the Discord link card: banner as the background, the profile picture, name and stats on top
    if (job.mode === 'og') { const u = await ogCard(job); wum.done(u ? null : 'no og made', u ? [u] : []); return; }
    // (beta.9) a manual page too big to show: made `w` pixels wide (decoded at that size, never in full on a canvas)
    if (job.mode === 'shrink') { const b = await createImageBitmap(new Blob([job.data]), { resizeWidth: Math.max(64, job.w | 0), resizeQuality: 'high' });
      const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; c.getContext('2d').drawImage(b, 0, 0); b.close();
      const u = c.toDataURL('image/jpeg', 0.9); c.width = c.height = 0; wum.done(null, [u]); return; }
    const bmp = await createImageBitmap(new Blob([job.data]));
    if (job.mode === 'cart') { const r = cart(bmp, job); bmp.close(); wum.done(r ? null : 'no cartridge made', r ? [r] : []); return; }
    if (job.mode === 'back') { const r = await back(bmp, job); bmp.close(); wum.done(r ? null : 'no back made', r ? [r] : []); return; }
    if (job.mode === 'madespine') { const r = await madeSpine(bmp, job); bmp.close(); wum.done(r ? null : 'no spine made', r ? [r] : []); return; }
    if (job.mode === 'spine') { const r = spine(bmp, job); bmp.close(); wum.done(r ? null : job.part === 'back' ? 'no back found' : 'no spine found', r ? [r] : []); return; }
    const w = bmp.width, h = bmp.height, half = Math.floor(w / 2), out = [];
    for (const side of ['left', 'right']) {
      const c = document.createElement('canvas'); c.width = half; c.height = h;
      c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, side === 'left' ? 0 : w - half, 0, half, h, 0, 0, half, h);
      out.push(c.toDataURL('image/jpeg', 0.9));
    }
    bmp.close();
    wum.done(null, out);
  } catch (e) { wum.done(String(e && e.message || e), []); }
});

// A case back made for a game no source has a scanned back of (new consoles above all: hardly any Switch 2 backs are
// scanned yet). Laid out like a real back: the console's band at the top, a big screenshot (or the game's artwork),
// the title and description, a strip of smaller screenshots, and a bar with the age rating, players and publisher, all
// over the game's own art, blurred and darkened. job: data (the front), shots / bg (image bytes), title, overview, esrb,
// players, pub, year, band { bg, fg, label }. The front's shape decides the back's.
async function back(front, job) {
  const H = 1550, W = Math.round(H * Math.min(.8, Math.max(.55, front.width / front.height)));
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const load = async b => { try { return b ? await createImageBitmap(new Blob([b])) : null; } catch { return null; } };
  const shots = (await Promise.all((job.shots || []).slice(0, 3).map(load))).filter(Boolean), bg = (await load(job.bg)) || front;
  const cover = (img, x, y, w, h) => { const s = Math.max(w / img.width, h / img.height), sw = w / s, sh = h / s; g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h); };
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const F = 'Segoe UI, Lexend, Arial, sans-serif', M = Math.round(W * .06), band = job.band || { bg: '#16161b', fg: '#fff', label: '' };
  // the background: the game's art, blurred and darkened toward the bottom
  g.fillStyle = '#0d0e12'; g.fillRect(0, 0, W, H);
  g.save(); g.filter = 'blur(26px) saturate(1.15)'; cover(bg, -40, -40, W + 80, H + 80); g.restore();
  const shade = g.createLinearGradient(0, 0, 0, H); shade.addColorStop(0, 'rgba(8,9,13,.45)'); shade.addColorStop(.45, 'rgba(8,9,13,.62)'); shade.addColorStop(1, 'rgba(8,9,13,.9)'); g.fillStyle = shade; g.fillRect(0, 0, W, H);
  // the console's band
  const bh = Math.round(H * .062); g.fillStyle = band.bg; g.fillRect(0, 0, W, bh);
  if (band.label) { g.fillStyle = band.fg; g.font = `800 ${Math.round(bh * .42)}px ${F}`; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(band.label.toUpperCase(), M, bh / 2 + 1); }
  // the big picture: the first screenshot, else the artwork itself (taller when there's no description to fill the space)
  // descriptions often run a heading into the next sentence across a line break: those breaks get a full stop
  const text = String(job.overview || '').replace(/([^.!?:;,\s])[ \t]*(\r?\n)+\s*/g, '$1. ').replace(/\s+/g, ' ').trim();
  let y = bh + Math.round(H * .03); const hw = W - 2 * M, hh = Math.round(hw * (text ? 9 / 16 : 1.05));
  g.save(); rr(M, y, hw, hh, 18); g.clip(); cover(shots[0] || bg, M, y, hw, hh); g.restore();
  g.save(); rr(M, y, hw, hh, 18); g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 3; g.stroke(); g.restore();
  y += hh + Math.round(H * .03);
  // the title, then the description (wrapped, cut with an ellipsis where it runs out of room)
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = '#fff';
  const wrap = (text, size, weight, maxLines, lh) => { g.font = `${weight} ${size}px ${F}`; const words = String(text || '').replace(/\s+/g, ' ').trim().split(' '); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > hw && cur) { lines.push(cur); cur = w; if (lines.length === maxLines) break; } else cur = t; }
    if (lines.length < maxLines && cur) lines.push(cur); else if (lines.length === maxLines) { let l = lines[maxLines - 1]; while (l && g.measureText(l + '…').width > hw) l = l.replace(/\s*\S+$/, ''); lines[maxLines - 1] = l + '…'; }
    for (const l of lines) { y += size * lh; g.fillText(l, M, y); } return lines.length; };
  wrap(job.title, Math.round(H * .034), 800, 2, 1.18);
  y += Math.round(H * .012); g.fillStyle = 'rgba(255,255,255,.86)';
  const small = shots.length >= 3, room = Math.round(H * (small ? .6 : .82)) - y, fs = Math.round(H * .0195), lines = Math.max(3, Math.floor(room / (fs * 1.42)));
  if (text) wrap(text, fs, 400, lines, 1.42);
  // a strip of two more screenshots
  if (small) { const top = Math.round(H * .64), gap = Math.round(M * .5), sw = (hw - gap) / 2, sh = Math.round(sw * 9 / 16);
    for (let i = 0; i < 2; i++) { const x = M + i * (sw + gap); g.save(); rr(x, top, sw, sh, 12); g.clip(); cover(shots[i + 1], x, top, sw, sh); g.restore(); g.save(); rr(x, top, sw, sh, 12); g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 2; g.stroke(); g.restore(); } }
  // the bottom bar: age rating box, players, publisher · year
  const fy = Math.round(H * .885), fh = Math.round(H * .085), esrb = /^(EC|E10\+|E|T|M|AO|RP)(?=\s|$|-)/.exec(String(job.esrb || '').trim());
  const pl = +job.players, line1 = pl > 1 ? `1–${pl} players` : pl === 1 ? '1 player' : '', line2 = [job.pub, job.year].filter(Boolean).join(' · ');
  if (!esrb && !line1 && !line2) { shots.forEach(b => b.close()); if (bg !== front) bg.close(); return c.toDataURL('image/jpeg', .9); } // nothing for the bar
  g.fillStyle = 'rgba(255,255,255,.08)'; rr(M, fy, hw, fh, 14); g.fill();
  let fx = M + Math.round(fh * .18);
  if (esrb) { const bw2 = Math.round(fh * .62), bh2 = Math.round(fh * .8), by = fy + (fh - bh2) / 2;
    g.fillStyle = '#fff'; g.fillRect(fx, by, bw2, bh2); g.fillStyle = '#000'; g.fillRect(fx + 3, by + 3, bw2 - 6, bh2 - 6); g.fillStyle = '#fff'; g.fillRect(fx + 6, by + 6, bw2 - 12, bh2 * .66);
    g.fillStyle = '#000'; g.textAlign = 'center'; g.font = `900 ${Math.round(bh2 * (esrb[1].length > 2 ? .3 : .5))}px ${F}`; g.textBaseline = 'middle'; g.fillText(esrb[1], fx + bw2 / 2, by + 6 + bh2 * .33);
    g.fillStyle = '#fff'; g.font = `800 ${Math.round(bh2 * .17)}px ${F}`; g.fillText('ESRB', fx + bw2 / 2, by + bh2 * .85); fx += bw2 + Math.round(fh * .25); }
  g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
  g.font = `700 ${Math.round(fh * .26)}px ${F}`; if (line1) g.fillText(line1, fx, fy + fh * (line2 ? .34 : .5));
  g.fillStyle = 'rgba(255,255,255,.7)'; g.font = `500 ${Math.round(fh * .22)}px ${F}`; if (line2) g.fillText(line2, fx, fy + fh * (line1 ? .68 : .5));
  shots.forEach(b => b.close()); if (bg !== front) bg.close();
  return c.toDataURL('image/jpeg', .9);
}

// A spine made for a game no source has a spine of (Switch 2 above all). Laid out like the console's real spines: its band
// at the top with the console's name, then the game's logo (or its title in bold type) running down the spine, read top
// to bottom. A light logo gets a dark spine tinted with the cover's own colour, a dark one a light spine, so it always
// reads. job: data (the front), logo (image bytes or null), title, band { bg, fg, label }, ratio (spine width / height),
// pub (the publisher, printed small at the foot when there's room).
async function madeSpine(front, job) {
  const H = 1400, ratio = Math.min(.16, Math.max(.04, +job.ratio || .06)), W = Math.max(48, Math.round(H * ratio));
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const F = 'Segoe UI, Lexend, Arial, sans-serif', band = job.band || { bg: '#16161b', fg: '#fff', label: '' };
  let logo = null; try { logo = job.logo ? await createImageBitmap(new Blob([job.logo])) : null; } catch { logo = null; }
  // colours read from small copies (a readback-friendly 2D canvas): the cover's average, the logo's brightness and how much of it is ink
  const sample = (img, n) => { const s = document.createElement('canvas'); s.width = n; s.height = n; const x = s.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, n, n); return x.getImageData(0, 0, n, n).data; };
  const fd = sample(front, 16); let fr = 0, fg = 0, fb = 0; for (let i = 0; i < fd.length; i += 4) { fr += fd[i]; fg += fd[i + 1]; fb += fd[i + 2]; } const np = fd.length / 4; fr /= np; fg /= np; fb /= np;
  let light = true, ink = 0;
  if (logo) { const d = sample(logo, 48); let sum = 0, n = 0; for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; if (a < .5) continue; sum += (.2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2]) / 255; n++; } ink = n / (d.length / 4); light = n ? sum / n > .55 : true;
    // no transparency: a picture, not a logo; a squarish logo (stacked words, a badge) would be tiny across a thin spine:
    // the title in type reads better
    if (ink > .92 || logo.width / logo.height < 2.4) { logo.close(); logo = null; light = true; } }
  // the console's own spine colour (job.lightBody: Nintendo, Xbox 360, PS5 are light; PS2 / PS3 / PSP / GameCube dark);
  // a light logo on a light spine gets the dark one, tinted with the cover's colour, so it always reads
  const dark = `rgb(${Math.round(fr * .22 + 10)},${Math.round(fg * .22 + 10)},${Math.round(fb * .22 + 12)})`;
  const lightBody = logo ? !light : job.lightBody !== false;
  const body = lightBody ? '#f2f2f0' : dark, ink2 = lightBody ? '#16161b' : '#ffffff';
  g.fillStyle = body; g.fillRect(0, 0, W, H);
  // a soft sheen across the width, as on a printed spine
  const sh = g.createLinearGradient(0, 0, W, 0); sh.addColorStop(0, 'rgba(0,0,0,.18)'); sh.addColorStop(.18, 'rgba(255,255,255,.05)'); sh.addColorStop(.82, 'rgba(255,255,255,.03)'); sh.addColorStop(1, 'rgba(0,0,0,.2)'); g.fillStyle = sh; g.fillRect(0, 0, W, H);
  // the console's band, its name running down it
  const bh = Math.round(Math.max(W * 2.2, H * .15)); g.fillStyle = band.bg; g.fillRect(0, 0, W, bh);
  const down = (fn) => { g.save(); g.translate(W, 0); g.rotate(Math.PI / 2); fn(); g.restore(); }; // x = along the spine (down), y = across it (from the right edge)
  if (band.label) down(() => { g.fillStyle = band.fg; g.textAlign = 'center'; g.textBaseline = 'middle'; let fs = Math.round(W * .36); g.font = `800 ${fs}px ${F}`;
    while (fs > 8 && g.measureText(band.label.toUpperCase()).width > bh * .86) { fs--; g.font = `800 ${fs}px ${F}`; } g.fillText(band.label.toUpperCase(), bh / 2, W / 2 + 1); });
  // the foot: the publisher, small
  const footH = job.pub ? Math.round(H * .13) : Math.round(H * .04);
  if (job.pub) down(() => { g.fillStyle = ink2; g.globalAlpha = .7; g.textAlign = 'center'; g.textBaseline = 'middle'; let fs = Math.round(W * .26); g.font = `700 ${fs}px ${F}`; const t = String(job.pub).slice(0, 40);
    while (fs > 7 && g.measureText(t).width > footH * .9) { fs--; g.font = `700 ${fs}px ${F}`; } g.fillText(t, H - footH / 2, W / 2 + 1); });
  // the logo or title in the space between
  const x0 = bh + Math.round(H * .025), x1 = H - footH - Math.round(H * .02), len = x1 - x0, across = W * .78;
  if (logo) down(() => { const s = Math.min(len / logo.width, across / logo.height), w = logo.width * s, h = logo.height * s;
    if (!light) { g.shadowColor = 'rgba(0,0,0,0)'; } else { g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = Math.round(W * .06); }
    g.drawImage(logo, x0 + (len - w) / 2, (W - h) / 2, w, h); });
  else down(() => { g.fillStyle = ink2; g.textAlign = 'center'; g.textBaseline = 'middle'; const t = String(job.title || '').trim(); let fs = Math.round(W * .44); g.font = `800 ${fs}px ${F}`;
    while (fs > 9 && g.measureText(t).width > len) { fs--; g.font = `800 ${fs}px ${F}`; }
    if (g.measureText(t).width > len) { // two lines, split near the middle at a space
      const mid = t.length / 2; let at = -1, best = 1e9; for (let i = 0; i < t.length; i++) if (t[i] === ' ' && Math.abs(i - mid) < best) { best = Math.abs(i - mid); at = i; }
      if (at > 0) { const a = t.slice(0, at), b = t.slice(at + 1); fs = Math.round(W * .3); g.font = `800 ${fs}px ${F}`; while (fs > 8 && Math.max(g.measureText(a).width, g.measureText(b).width) > len) { fs--; g.font = `800 ${fs}px ${F}`; }
        g.fillText(a, x0 + len / 2, W / 2 - fs * .58); g.fillText(b, x0 + len / 2, W / 2 + fs * .62); return; } }
    g.fillText(t, x0 + len / 2, W / 2 + 1); });
  if (logo) logo.close();
  return c.toDataURL('image/jpeg', .92);
}

// A full box wrap is back | spine | front. The spine's width follows from the case's shape (front width and spine
// thickness relative to its height); its two edges are then looked for as the strongest vertical lines near where
// they should be (wraps are rarely cropped exactly), and the strip between them is cut out.
function spine(bmp, job) {
  const W = bmp.width, H = bmp.height; if (W < H * 1.15) return null; // not a wrap
  const fr = job.front || .71, sr = job.spine || .074;
  let s0 = W - 2 * fr * H; if (!(s0 > sr * H * .5 && s0 < sr * H * 2)) s0 = sr * H;
  const L0 = (W - s0) / 2, R0 = (W + s0) / 2;
  // column edge strength on a small copy (height 400)
  const k = Math.min(1, 400 / H), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, y0 = Math.floor(h * .08), y1 = Math.ceil(h * .92), edge = new Float32Array(w);
  for (let x = 1; x < w; x++) { let e = 0; for (let y = y0; y < y1; y++) { const i = (y * w + x) * 4, j = i - 4; e += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]); } edge[x] = e / (y1 - y0); }
  const best = (cx, r) => { let bx = -1, bv = 0; for (let x = Math.max(1, Math.round(cx - r)); x <= Math.min(w - 1, Math.round(cx + r)); x++) if (edge[x] > bv) { bv = edge[x]; bx = x; } return [bx, bv]; };
  const avg = edge.reduce((a, b) => a + b, 0) / w, r = s0 * k * .3;
  const [lx, lv] = best(L0 * k, r), [rx, rv] = best(R0 * k, r);
  let L = L0, R = R0;
  if (lx > 0 && rx > lx && lv > avg * 2 && rv > avg * 2) { const s1 = (rx - lx) / k; if (s1 > s0 * .7 && s1 < s0 * 1.35) { L = lx / k; R = rx / k; } }
  const inset = Math.round((R - L) * .03); // stay inside the fold lines
  // the back (1.71): everything left of the spine's left fold, from the same fold search. It should be about a front's width
  // (fr x H); much narrower means the wrap is cropped or isn't back | spine | front, so nothing is cut
  if (job.part === 'back') { const bw = Math.round(L) - inset; if (bw < fr * H * .75) return null; const x0 = Math.max(0, Math.round(L - Math.min(bw, fr * H * 1.08))), cw = Math.round(L) - inset - x0;
    const o = document.createElement('canvas'); o.width = cw; o.height = H; o.getContext('2d', { willReadFrequently: true }).drawImage(bmp, x0, 0, cw, H, 0, 0, cw, H); return o.toDataURL('image/jpeg', .92); }
  const x0 = Math.round(L) + inset, sw = Math.max(4, Math.round(R - L) - 2 * inset);
  const o = document.createElement('canvas'); o.width = sw; o.height = H; o.getContext('2d', { willReadFrequently: true }).drawImage(bmp, x0, 0, sw, H, 0, 0, sw, H);
  return o.toDataURL('image/jpeg', .92);
}

// A cartridge made from the game's front cover (1.73.5), for a Switch or 3DS game no source has a cartridge picture of: the
// cover's artwork on the label of a plain, unbranded game card, on a transparent background, like the cartridge photos
// LaunchBox has (the 3D view puts the whole picture on the cartridge's face). Proportions from the real cards: Switch
// 21 x 31 mm, 3DS 35 x 33 mm.
function cart(bmp, job) {
  const ds = job.sys === 'n3ds', H = 1000, W = Math.round(H * (ds ? 35 / 33 : 21 / 31));
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  // the shell
  const body = g.createLinearGradient(0, 0, W, H);
  if (ds) { body.addColorStop(0, '#d9dadf'); body.addColorStop(1, '#a9abb2'); } else { body.addColorStop(0, '#3a3b42'); body.addColorStop(1, '#1d1e22'); }
  rr(0, 0, W, H, W * (ds ? .045 : .07)); g.fillStyle = body; g.fill();
  g.strokeStyle = ds ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.10)'; g.lineWidth = W * .008; g.stroke();
  // the label: inset from the edges, with room for the grip (3DS: a ridge along the top; Switch: grooves along the bottom)
  const lx = W * (ds ? .08 : .085), ly = H * (ds ? .2 : .05), lw = W - 2 * lx, lh = H * (ds ? .72 : .74), lr = W * .025;
  if (ds) { g.fillStyle = 'rgba(0,0,0,.10)'; for (let i = 0; i < 5; i++) g.fillRect(W * .2, H * (.05 + i * .025), W * .6, H * .008); }
  else { g.fillStyle = 'rgba(255,255,255,.07)'; for (let i = 0; i < 3; i++) g.fillRect(W * .25, H * (.84 + i * .035), W * .5, H * .012); }
  g.save(); rr(lx, ly, lw, lh, lr); g.clip();
  // the cover's artwork filling the label
  const s = Math.max(lw / bmp.width, lh / bmp.height), dw = bmp.width * s, dh = bmp.height * s;
  // (Switch and 3DS covers carry the console's band across the top: it's left off the label when the cover is tall enough)
  const skip = dh > lh ? Math.min(dh - lh, dh * (ds ? .1 : .085)) : (dh - lh) * -.5;
  g.drawImage(bmp, lx + (lw - dw) / 2, ly - skip, dw, dh);
  const sh = g.createLinearGradient(lx, ly, lx + lw, ly + lh); sh.addColorStop(0, 'rgba(255,255,255,.16)'); sh.addColorStop(.45, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,.12)');
  g.fillStyle = sh; g.fillRect(lx, ly, lw, lh); g.restore();
  rr(lx, ly, lw, lh, lr); g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = W * .006; g.stroke();
  return c.toDataURL('image/png');
}

// The card Discord shows for a profile link: 1200x630, the banner filling it, the profile picture in a ring, the name,
// the description and the hours / favourites / friend code as small pills. Same zoom & pan as the app for both pictures.
async function ogCard(job) {
  const W = 1200, H = 630, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const load = async b => { try { return b ? await createImageBitmap(new Blob([b])) : null; } catch { return null; } };
  const [banner, avatar] = await Promise.all([load(job.data), load(job.avatar)]);
  const F = 'Segoe UI, Lexend, Arial, sans-serif', E = 'Segoe UI Emoji, Segoe UI, Arial, sans-serif';
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const fitOf = f => { const z = Math.min(3, Math.max(1, +f.z || 1)), lim = (z - 1) * 50, cl = n => Math.min(lim, Math.max(-lim, +n || 0)); return { z, x: cl(f.x), y: cl(f.y) }; };
  // fill the rect with the picture (cover) and the same zoom / pan the profile editor saved
  const cover = (img, x, y, w, h, f) => {
    if (!img) return;
    const q = fitOf(f || {}), s = Math.max(w / img.width, h / img.height) * q.z, dw = img.width * s, dh = img.height * s;
    g.drawImage(img, x + (w - dw) / 2 + q.x / 100 * w, y + (h - dh) / 2 + q.y / 100 * h, dw, dh);
  };
  g.fillStyle = '#070c1e'; g.fillRect(0, 0, W, H);
  if (banner) cover(banner, 0, 0, W, H, (job.fit || {}).banner);
  // dark on the left so the text always reads, a soft shade at the bottom for depth
  const side = g.createLinearGradient(0, 0, W, 0);
  side.addColorStop(0, 'rgba(5,9,26,.97)'); side.addColorStop(.44, 'rgba(5,9,26,.9)'); side.addColorStop(.72, 'rgba(5,9,26,.4)'); side.addColorStop(1, 'rgba(5,9,26,.1)');
  g.fillStyle = side; g.fillRect(0, 0, W, H);
  const bottom = g.createLinearGradient(0, H * .6, 0, H); bottom.addColorStop(0, 'rgba(5,9,26,0)'); bottom.addColorStop(1, 'rgba(5,9,26,.85)');
  g.fillStyle = bottom; g.fillRect(0, 0, W, H);
  const accent = g.createLinearGradient(0, 0, 0, H); accent.addColorStop(0, '#5b8dff'); accent.addColorStop(1, '#8b5cf6');
  g.fillStyle = accent; g.fillRect(0, 0, 7, H);
  // brand
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = 'rgba(190,214,255,.72)'; g.font = `700 19px ${F}`;
  try { g.letterSpacing = '4px'; } catch {} g.fillText('BOXSHELF TOGETHER', 80, 78); try { g.letterSpacing = '0px'; } catch {}
  // profile picture in its ring
  const AX = 80, AY = 176, AS = 158;
  g.save(); g.beginPath(); g.arc(AX + AS / 2, AY + AS / 2, AS / 2, 0, Math.PI * 2); g.clip();
  g.fillStyle = '#1b2b5c'; g.fillRect(AX, AY, AS, AS); cover(avatar, AX, AY, AS, AS, (job.fit || {}).avatar); g.restore();
  g.beginPath(); g.arc(AX + AS / 2, AY + AS / 2, AS / 2 + 3, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,255,255,.92)'; g.lineWidth = 5; g.stroke();
  const cut = (t, size, weight, mw, font) => { g.font = `${weight} ${size}px ${font || F}`; t = String(t || ''); if (g.measureText(t).width <= mw) return t; while (t && g.measureText(t + '…').width > mw) t = t.slice(0, -1); return t + '…'; };
  const maxW = W - 300;
  g.fillStyle = '#fff'; g.fillText(cut(job.name, 62, 800, maxW), 286, 258);
  if (job.desc) { g.fillStyle = 'rgba(185,200,230,.92)'; g.fillText(cut(job.desc, 24, 500, maxW), 288, 302); }
  // hours / favourites pills
  const chip = (x, y, text, icon) => {
    g.font = `600 24px ${E}`; const w = g.measureText(icon + '  ' + text).width + 44, h = 58;
    g.fillStyle = 'rgba(120,160,255,.14)'; rr(x, y, w, h, 16); g.fill();
    g.strokeStyle = 'rgba(150,180,255,.26)'; g.lineWidth = 1.5; rr(x, y, w, h, 16); g.stroke();
    g.fillStyle = '#eaf1ff'; g.textBaseline = 'middle'; g.fillText(icon + '  ' + text, x + 22, y + h / 2 + 1); g.textBaseline = 'alphabetic';
    return w;
  };
  let cx = 288; const cy = 342;
  cx += chip(cx, cy, `${job.hours} h jugadas`, '🕹️') + 14;
  chip(cx, cy, `${job.favs} favoritos`, '⭐');
  // friend code
  const ct = '🆔  ' + job.code; g.font = `600 22px ui-monospace, Consolas, monospace`;
  const cw = g.measureText(ct).width + 44;
  g.fillStyle = 'rgba(120,160,255,.1)'; rr(288, 452, cw, 50, 14); g.fill();
  g.strokeStyle = 'rgba(150,180,255,.24)'; g.lineWidth = 1.5; rr(288, 452, cw, 50, 14); g.stroke();
  g.fillStyle = '#9dc0ff'; g.textBaseline = 'middle'; g.fillText(ct, 288 + 22, 478); g.textBaseline = 'alphabetic';
  g.textAlign = 'right'; g.fillStyle = 'rgba(160,180,215,.5)'; g.font = `600 18px ${F}`; g.fillText('boxshelf-online', W - 60, H - 42); g.textAlign = 'left';
  banner && banner.close(); avatar && avatar.close();
  return c.toDataURL('image/jpeg', .88);
}
