// The game controllers actually plugged in (Windows), for the button prompts: Windows hands XInput pads to the shelf
// without saying what they are, and Steam Input or DS4Windows wrap PlayStation / Switch pads as XInput, so the shelf
// asks which real pads are connected (USB or Bluetooth) to show the right buttons.
//   list() → [{ vendor, product, style }]  (cached for a few seconds; style xbox / ps / nintendo)
// Left out: other Microsoft devices (mice, keyboards), Sony / Nintendo devices that aren't pads (a PULSE headset
// has no game-controller part), Steam's and ViGEm's virtual pads (DS4Windows' "Xbox 360" pads), Wii remotes.
const { execFile } = require('child_process');

let memo = null, memoAt = 0, flight = null;
const STYLE = { '054c': 'ps', '057e': 'nintendo', '045e': 'xbox', '28de': 'xbox' }; // (beta.10: 8BitDo pads count as Xbox-style: most run in X-input mode, and in Switch mode they show up as Nintendo's own pad)
const PS = '(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match "VID_(054C|057E|045E|28DE|2DC8)|VID&0002(054C|057E|045E|28DE|2DC8)" -or $_.FriendlyName -match "Virtual Gamepad Emulation Bus" } | ForEach-Object { $_.InstanceId + "|" + $_.Class + "|" + $_.FriendlyName }) -join "`n"';

function parse(out) {
  const lines = String(out || '').split(/\r?\n/).filter(Boolean), vigem = lines.some(l => /virtual gamepad emulation bus/i.test(l));
  const seen = new Map(); // vendor:product → { pad: game-controller part seen, xbox: an Xbox device class }
  for (const l of lines) {
    const [id, cls, name] = l.split('|');
    const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(id) || /VID&0002([0-9A-F]{4})_PID&([0-9A-F]{4})/i.exec(id); if (!m) continue;
    const k = m[1].toLowerCase() + ':' + m[2].toLowerCase(), o = seen.get(k) || { pad: false, xbox: false };
    if (/game controller|gamepad|joystick|controller|joy-?con|dualsense|dualshock|playstation|switch/i.test(name || '')) o.pad = true;
    if (/^(XnaComposite|XboxComposite)$/i.test(cls || '')) o.xbox = true;
    seen.set(k, o);
  }
  const out2 = [];
  for (const [k, o] of seen) {
    const [v, p] = k.split(':');
    if (v === '057e' && (p === '0306' || p === '0330')) continue; // Wii remotes (the shelf reads those itself)
    if (v === '28de' && p === '11ff') continue; // Steam's own virtual pad
    if (v === '045e') { if (!(o.xbox || /^0[2b]/.test(p))) continue; if (vigem && p === '028e') continue; } // an Xbox pad, not a mouse; not DS4Windows' virtual 360
    else if (!o.pad) continue; // a headset or another device from a pad maker
    out2.push({ vendor: v, product: p, style: STYLE[v] || 'xbox' });
  }
  return out2;
}
function list(force) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  if (!force && memo && Date.now() - memoAt < 4000) return Promise.resolve(memo);
  if (flight) return flight;
  flight = new Promise(res => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, timeout: 15000 }, (err, out) => {
      flight = null; memo = err ? (memo || []) : parse(out); memoAt = Date.now(); res(memo);
    });
  });
  return flight;
}

module.exports = { list, parse };
