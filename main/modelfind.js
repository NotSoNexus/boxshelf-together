// "Find a model": opens a search for free, downloadable 3D models of a console in the browser, then watches the
// Downloads folder; the first .glb/.gltf (or a .zip holding one) that lands there is installed as that system's
// console model. We don't host or bundle console models ourselves; you pick one you're allowed to use.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { shell, app } = require('electron');
const themes = require('./themes');

let log = () => {}, watch = null;
function init(logger) { if (logger) log = logger; }

const QUERY = { gc: 'gamecube console', wii: 'nintendo wii console', wiiu: 'nintendo wii u console', sw: 'nintendo switch dock', sw2: 'nintendo switch 2 console', psp: 'psp handheld', ps2: 'playstation 2 console', ps3: 'playstation 3 console', ps4: 'playstation 4 console', ps5: 'playstation 5 console', x360: 'xbox 360 console', n3ds: 'nintendo 3ds handheld', psx: 'playstation 1 console', nes: 'nes console', snes: 'super nintendo console', n64: 'nintendo 64 console', gb: 'game boy handheld', gbc: 'game boy color handheld', gba: 'game boy advance handheld', nds: 'nintendo ds handheld', megadrive: 'sega genesis console', mastersystem: 'sega master system console', gamegear: 'sega game gear handheld', dreamcast: 'sega dreamcast console', saturn: 'sega saturn console', pcengine: 'turbografx 16 console', neogeo: 'neo geo aes console', arcade: 'arcade cabinet', segacd: 'sega cd console', sega32x: 'sega 32x', atari2600: 'atari 2600 console', atarilynx: 'atari lynx handheld', wonderswan: 'wonderswan handheld', ngpc: 'neo geo pocket color handheld', dos: 'retro pc computer' };
function searchUrl(sysId, name, site) {
  const q = encodeURIComponent(QUERY[sysId] || `${name} console`);
  return site === 'polypizza' ? `https://poly.pizza/search/${q}` : `https://sketchfab.com/search?features=downloadable&q=${q}&sort_by=-likeCount&type=models`;
}
function downloadsDir() { try { return app.getPath('downloads'); } catch { return path.join(os.homedir(), 'Downloads'); } }

function stop() { if (watch) { try { watch.watcher && watch.watcher.close(); } catch {} clearTimeout(watch.timer); clearTimeout(watch.debounce); clearInterval(watch.poll); watch = null; } }

// Start watching Downloads for a model for `sysId`; onFound(info) when one is installed. Stops after 15 minutes.
function start(sysId, name, site, onFound) {
  stop();
  const dir = downloadsDir(); if (!fs.existsSync(dir)) return { ok: false, error: `No Downloads folder at ${dir}` };
  const before = new Set(fs.readdirSync(dir));
  const seen = new Map(); let me = null;
  const consider = () => {
    let names; try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (before.has(n) || !/\.(glb|zip)$/i.test(n)) continue; // a loose .gltf needs its .bin and textures beside it: ask for .glb or a .zip
      const f = path.join(dir, n); let st; try { st = fs.statSync(f); } catch { continue; }
      // wait until the file stops growing (browser finished writing it)
      const prev = seen.get(n); seen.set(n, st.size);
      if (prev == null || prev !== st.size || st.size < 1024) continue;
      install(f, sysId, name).then(r => { if (r && watch === me) { stop(); onFound(r); } }).catch(e => log('model install', e.message));
      seen.delete(n); before.add(n);
    }
  };
  me = { sysId, watcher: null, poll: 0, timer: 0, debounce: 0 };
  const tick = () => { if (watch !== me) return; consider(); };
  try { me.watcher = fs.watch(dir, () => { if (watch !== me) return; clearTimeout(me.debounce); me.debounce = setTimeout(tick, 900); }); } catch (e) { log('model watch', e.message); }
  me.poll = setInterval(tick, 2500); me.timer = setTimeout(stop, 15 * 60e3); watch = me;
  shell.openExternal(searchUrl(sysId, name, site)).catch(e => log('model search open', e.message));
  return { ok: true, dir };
}

// Runs a program, resolving its stdout. A failed spawn (no tar.exe) arrives through the callback, never thrown.
const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { windowsHide: true, timeout: 120e3, maxBuffer: 16 << 20, ...opts }, (err, out) => err ? rej(err) : res(String(out))));

async function install(file, sysId, name) {
  let src = file, out = null;
  if (/\.zip$/i.test(file)) {
    // look inside before unpacking anything: a zip without a .glb (some other download) is left alone
    // (a .gltf alone isn't enough: it needs its .bin and textures beside it, see below)
    // (Linux: GNU tar can't read a .zip; bsdtar / unzip / Python list and unpack it, main/linux.js)
    const L = process.platform === 'linux' ? require('./linux') : null;
    let list; try { list = L ? (L.zipList(file) || []).join('\n') : await run('tar', ['-tf', file]); } catch (e) { log('model zip unreadable:', path.basename(file), e.message); return null; }
    if (!list.split(/\r?\n/).some(l => /\.glb$/i.test(l.trim()))) { log('model zip had no .glb, ignored:', path.basename(file)); return null; }
    // a fresh folder per zip, never one named after the file ("...zip" would make it "..", the data folder itself)
    const root = path.join(app.getPath('userData'), 'model-unzip'); fs.mkdirSync(root, { recursive: true });
    out = fs.mkdtempSync(path.join(root, 'z-'));
    try {
      // file names reach PowerShell through the environment, never spliced into its code (it treats ‘ ’ ‚ ‛ as quotes too)
      if (L) { if (!(await L.unzipAsync(file, out))) throw new Error('could not unpack (install unzip or bsdtar)'); }
      else try { await run('tar', ['-xf', file, '-C', out]); }
      catch { await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:BS_SRC -DestinationPath $env:BS_DST -Force'], { env: { ...process.env, BS_SRC: file, BS_DST: out } }); }
      const found = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && /\.glb$/i.test(e.name)) found.push(p); } }; walk(out); // (isFile: no symlinks out of the folder)
      if (!found.length) { log('model zip had no .glb:', file); return null; } // .gltf + separate textures/bins need the whole folder; ask for a .glb
      found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size); src = found[0];
      themes.set(sysId, 'model', src); // (copies it into the theme folder, so the unpacked files can go)
    } finally { rmInside(root, out); }
  } else themes.set(sysId, 'model', src);
  log('Installed console model for', sysId, 'from', path.basename(file));
  return { sysId, name, file: path.basename(file) };
}
// delete `p` only if it really is a folder below `root`
function rmInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) { log('model unzip: refusing to delete', p); return; }
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { log('model unzip cleanup', e.message); }
}

module.exports = { init, start, stop, searchUrl };
