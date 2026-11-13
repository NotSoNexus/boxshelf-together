// Controller battery for the shelf's HUD. Chromium's Gamepad API never reports it, so a small PowerShell
// helper asks Windows itself: XInputGetBatteryInformation for Xbox pads (and anything posing as one, such
// as Steam Input / DS4Windows), and the battery nibble inside the input reports of PlayStation and
// Nintendo pads (the same HID reading padwatch.js does while a game runs). The helper stays alive and
// reports every 45 s; if it dies it is started again a minute later. Windows only.
'use strict';
const path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');

const CS = [`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public class PB {
  [StructLayout(LayoutKind.Sequential)] public struct BAT { public byte type; public byte level; }
  [StructLayout(LayoutKind.Sequential)] public struct GP { public ushort wButtons; public byte lt; public byte rt; public short lx; public short ly; public short rx; public short ry; public uint res; }
  [StructLayout(LayoutKind.Sequential)] public struct ST { public uint pkt; public GP pad; }
  [DllImport("xinput1_4.dll", EntryPoint="XInputGetState")] static extern uint S14(uint i, ref ST s);
  [DllImport("xinput1_4.dll", EntryPoint="XInputGetBatteryInformation")] static extern uint B14(uint i, byte t, out BAT b);
  [DllImport("xinput9_1_0.dll", EntryPoint="XInputGetState")] static extern uint S91(uint i, ref ST s);
  [DllImport("xinput9_1_0.dll", EntryPoint="XInputGetBatteryInformation")] static extern uint B91(uint i, byte t, out BAT b);
  static string XB(uint i) {
    ST s = new ST(); uint r;
    try { r = S14(i, ref s); } catch { r = 1; }
    if (r != 0) { try { r = S91(i, ref s); } catch { return null; } }
    if (r != 0) return null;
    BAT b = new BAT();
    try { r = B14(i, 0, out b); } catch { r = 1; }
    if (r != 0) { try { r = B91(i, 0, out b); } catch { return null; } }
    if (r != 0 || b.type == 0) return null;
    if (b.type == 1) return "xinput:" + i + ":wired"; // wired: no battery to report
    // XInput reports four steps (empty / low / medium / full); a few drivers use 0-255 instead
    int pct = b.level > 3 ? (int)Math.Round(b.level * 100.0 / 255.0) : b.level == 3 ? 100 : b.level == 2 ? 50 : b.level == 1 ? 20 : 5;
    return "xinput:" + i + ":" + pct;
  }
  [StructLayout(LayoutKind.Sequential)] struct HIDA { public int Size; public ushort Vid; public ushort Pid; public ushort Ver; }
  [StructLayout(LayoutKind.Sequential)] struct DIDATA { public int cbSize; public Guid g; public int flags; public IntPtr reserved; }
  [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
  [DllImport("hid.dll")] static extern bool HidD_GetAttributes(IntPtr h, ref HIDA a);
  [DllImport("hid.dll")] static extern bool HidD_GetFeature(IntPtr h, byte[] b, int n);
  [DllImport("setupapi.dll", EntryPoint="SetupDiGetClassDevsW", CharSet=CharSet.Unicode)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr p, int f);
  [DllImport("setupapi.dll")] static extern bool SetupDiEnumDeviceInterfaces(IntPtr s, IntPtr d, ref Guid g, int i, ref DIDATA dd);
  [DllImport("setupapi.dll", EntryPoint="SetupDiGetDeviceInterfaceDetailW", CharSet=CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr s, ref DIDATA dd, IntPtr buf, int size, out int req, IntPtr di);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr s);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string n, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, byte[] buf, int n, out int got, IntPtr ov);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  class Dev { public IntPtr h; public int pid; public bool ps, bt; }
  static int PsLevel(byte b) { return (b & 0x0F) * 10; }            // DualShock 4 / DualSense: 0-10 steps
  static bool PsChg(byte b) { return (b & 0xF0) != 0; }             // the high nibble says charging / full
  static int NtLevel(byte b) { int n = (b >> 4) & 0x0F; return n >= 8 ? 100 : (int)Math.Round(n * 100.0 / 8); } // Switch pads: 0-8
  public static string[] Hid() {
    Guid g; HidD_GetHidGuid(out g);
    IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12);
    if (set == IntPtr.Zero || set == new IntPtr(-1)) return new string[0];
    List<Dev> devs = new List<Dev>();
    try {
      for (int i = 0; i < 64; i++) {
        DIDATA dd = new DIDATA(); dd.cbSize = Marshal.SizeOf(typeof(DIDATA));
        if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref dd)) break;
        int req; SetupDiGetDeviceInterfaceDetail(set, ref dd, IntPtr.Zero, 0, out req, IntPtr.Zero); if (req <= 0) continue;
        IntPtr buf = Marshal.AllocHGlobal(req); string p = null;
        try { Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6); if (SetupDiGetDeviceInterfaceDetail(set, ref dd, buf, req, out req, IntPtr.Zero)) p = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 4)); } finally { Marshal.FreeHGlobal(buf); }
        if (p == null) continue;
        string lp = p.ToLowerInvariant();
        bool sony = lp.IndexOf("vid_054c") >= 0 || lp.IndexOf("vid&0002054c") >= 0;
        bool nin = lp.IndexOf("vid_057e") >= 0 || lp.IndexOf("vid&0002057e") >= 0;
        if (!sony && !nin) continue;
        IntPtr h = CreateFile(p, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == IntPtr.Zero || h == new IntPtr(-1)) continue;
        HIDA a = new HIDA(); a.Size = Marshal.SizeOf(typeof(HIDA));
        bool ok = HidD_GetAttributes(h, ref a);
        bool known = ok && (sony ? (a.Pid == 0x05C4 || a.Pid == 0x09CC || a.Pid == 0x0BA0 || a.Pid == 0x0CE6 || a.Pid == 0x0DF2) : (a.Pid == 0x2006 || a.Pid == 0x2007 || a.Pid == 0x2009));
        if (!known) { CloseHandle(h); continue; }
        // a DualShock 4 only sends its full 0x11 report (the one with the battery) after the host asks
        // for its calibration: 0x05 over Bluetooth, 0x02 over USB. Linux's hid-playstation and DS4Windows
        // do the same; Windows' own driver never asks, so the pad stays in the cut-down 0x01 report.
        bool bt = lp.IndexOf("00001124-0000-1000-8000-00805f9b34fb") >= 0;
        if (sony && (a.Pid == 0x05C4 || a.Pid == 0x09CC || a.Pid == 0x0BA0)) {
          byte[] cal = new byte[bt ? 41 : 37]; cal[0] = (byte)(bt ? 0x05 : 0x02);
          try { HidD_GetFeature(h, cal, cal.Length); } catch {}
        }
        Dev d = new Dev(); d.h = h; d.pid = a.Pid; d.ps = sony; d.bt = bt; devs.Add(d);
      }
    } finally { SetupDiDestroyDeviceInfoList(set); }
    if (devs.Count == 0) return new string[0];
    int[] lvl = new int[devs.Count]; int[] chg = new int[devs.Count]; bool[] got = new bool[devs.Count];
    for (int k = 0; k < devs.Count; k++) {
      int idx = k; Dev d = devs[k];
      Thread t = new Thread(delegate() {
        byte[] r = new byte[2048]; int n, seen = 0; // a pad can declare a long report (the DS4 over Bluetooth: 547 bytes)
        try { while (true) {
          if (!ReadFile(d.h, r, r.Length, out n, IntPtr.Zero)) break;
          if (n < 4) continue;
          if (seen == 0) { seen = n; Console.WriteLine("RAW " + (d.ps ? "ps" : "nt") + ":" + d.pid.ToString("X4") + (d.bt ? ":bt" : ":usb") + ":len" + n + ":id" + r[0].ToString("X2") + ":b30_" + r[30].ToString("X2") + ":b32_" + r[32].ToString("X2") + ":b53_" + r[53].ToString("X2") + ":b54_" + r[54].ToString("X2")); }
          int lv = -1, ch = 0;
          if (d.ps) {
            if (d.pid == 0x0CE6 || d.pid == 0x0DF2) {
              if (r[0] == 0x01 && n > 53) { lv = PsLevel(r[53]); ch = PsChg(r[53]) ? 1 : 0; }           // USB, and pads that use the USB layout over Bluetooth
              else if (r[0] == 0x31 && n > 54) { lv = PsLevel(r[54]); ch = PsChg(r[54]) ? 1 : 0; }      // Bluetooth
            } else {
              if (r[0] == 0x01 && n > 30) { lv = PsLevel(r[30]); ch = PsChg(r[30]) ? 1 : 0; }           // USB, and Bluetooth pads with a long USB-style report
              else if (r[0] == 0x11 && n > 32) { lv = PsLevel(r[32]); ch = PsChg(r[32]) ? 1 : 0; }      // Bluetooth
            }
          } else if (r[0] == 0x30 || r[0] == 0x21 || r[0] == 0x31 || r[0] == 0x3F) lv = NtLevel(r[2]);
          if (lv >= 0 && lv <= 100) { lock (lvl) { lvl[idx] = lv; chg[idx] = ch; got[idx] = true; } break; }
        } } catch {}
      });
      t.IsBackground = true; t.Start();
    }
    Thread.Sleep(1200);
    for (int k = 0; k < devs.Count; k++) { try { CloseHandle(devs[k].h); } catch {} }
    List<string> outList = new List<string>();
    for (int k = 0; k < devs.Count; k++) if (got[k]) outList.Add((devs[k].ps ? "ps" : "nt") + ":" + devs[k].pid.ToString("X4") + ":" + lvl[k] + ":" + chg[k]);
    return outList.ToArray();
  }
  public static string[] All() {
    List<string> l = new List<string>();
    for (uint i = 0; i < 4; i++) { try { string x = XB(i); if (x != null) l.Add(x); } catch {} }
    try { l.AddRange(Hid()); } catch {}
    return l.ToArray();
  }
}
`];

let proc = null, quit = false, retryT = null, latest = { at: 0, pads: [] }, send = () => {}, log = () => {}, logged = null;

function script(dll) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$src = @"
${CS[0]}
"@
$dll = '${String(dll).replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$ok = $false
if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -Path $dll; $ok = [bool]('PB' -as [type]) } catch {} }
if (-not $ok) { try { Add-Type -TypeDefinition $src -OutputAssembly $dll -OutputType Library; Add-Type -Path $dll; $ok = [bool]('PB' -as [type]) } catch { try { Add-Type -TypeDefinition $src; $ok = [bool]('PB' -as [type]) } catch {} } }
if (-not $ok) { Write-Output 'FAIL'; exit 1 }
$n = 0
while ($true) {
  $found = 0
  foreach ($l in [PB]::All()) { Write-Output ('BATT ' + $l); $found++ }
  Write-Output 'END'
  if ($n -lt 3) { $n++; Start-Sleep -Seconds 4 }                                  # the first rounds come quickly, so the HUD fills in at once
  elseif ($found -eq 0) { Start-Sleep -Seconds 6 }                                # a pad switched on later is picked up within seconds
  else { Start-Sleep -Seconds 45 }
}`;
}

function start() {
  if (quit || process.platform !== 'win32' || proc) return;
  const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const dll = path.join(require('electron').app.getPath('userData'), 'padbattery-' + crypto.createHash('sha1').update(CS[0]).digest('hex').slice(0, 12) + '.dll');
  let buf = '', round = [], raw = '';
  try {
    proc = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script(dll), 'utf16le').toString('base64')], { windowsHide: true });
  } catch { proc = null; retryT = setTimeout(start, 60000); return; }
  proc.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '').trim(); buf = buf.slice(i + 1);
      if (line === 'END') {
        latest = { at: Date.now(), pads: round.slice(0, 8) }; round = [];
        const sig = latest.pads.map(p => p.id + '=' + (p.wired ? 'wired' : p.pct) + (p.charging ? '+' : '')).join(', ');
        const full = sig + (raw ? ' [' + raw + ']' : ''); raw = '';
        if (full !== logged) { logged = full; try { log(full ? 'pad battery: ' + full : 'pad battery: no controller seen by Windows'); } catch {} }
        try { send(latest); } catch {}
      } else if (line.startsWith('RAW ')) {
        raw = line.slice(4);
      } else if (line.startsWith('BATT ')) {
        const v = line.slice(5).split(':');
        if (v[0] === 'xinput' && v[2] === 'wired') round.push({ id: 'xinput:' + v[1], pct: -1, wired: true });
        else if (v[0] === 'xinput' && v.length >= 3) round.push({ id: 'xinput:' + v[1], pct: Math.max(0, Math.min(100, +v[2] || 0)) });
        else if ((v[0] === 'ps' || v[0] === 'nt') && v.length >= 4) round.push({ id: v[0] + ':' + v[1], pct: Math.max(0, Math.min(100, +v[2] || 0)), charging: v[3] === '1' });
      }
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('error', () => {});
  proc.on('exit', () => { proc = null; if (!quit) retryT = setTimeout(start, 60000); });
}

function init(sendFn, logFn) { send = sendFn || send; log = logFn || log; start(); }
function stop() { quit = true; clearTimeout(retryT); try { if (proc) proc.kill(); } catch {} proc = null; }
const last = () => latest;

module.exports = { init, stop, last };
