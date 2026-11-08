// Definitions for every shelf the launcher knows about.
// Paths may use %ENV% variables and {app} (the folder Boxshelf lives in).
// Game launch options use {rom} for the game file; edit them later in Settings.
// coverSeconds: the longest Boxshelf's black loading screen stays on top while the emulator opens (it lifts as soon
// as the game's window is fullscreen), hiding its window until then (0 = off).
// Dolphin: -b closes Dolphin when the game stops, -C overrides a setting for this launch only.

// (beta.11) VisualBoyAdvance-M, for the Game Boy shelves (before CONSOLES: the retro rows below use it)
const VBA = ['visualboyadvance-m.exe', 're:^visualboyadvance[^\\\\]*\\.exe$'], VBA_DIRS = ['{app}\\VisualBoyAdvance-M', '{app}\\visualboyadvance-m', '%ProgramFiles%\\VisualBoyAdvance-M'];
const CONSOLES = [
  {
    id: 'gc', name: 'GameCube', emulatorName: 'Dolphin',
    exeNames: ['Dolphin.exe', 'DolphinQt.exe'],
    emulatorFolders: ['{app}\\Dolphin', '%ProgramFiles%\\Dolphin', '%ProgramFiles%\\Dolphin-x64', '%LOCALAPPDATA%\\Programs\\Dolphin'],
    romFolderNames: ['gamecube', 'gc', 'gcn', 'ngc'],
    extensions: ['rvz', 'iso', 'gcm', 'ciso', 'gcz', 'dol', 'elf'],
    gameArgs: '-b -C Dolphin.Display.Fullscreen=True -C Dolphin.Interface.ConfirmStop=False -e "{rom}"',
    emulatorArgs: '',
    coverSeconds: 4
  },
  {
    id: 'wii', name: 'Wii', emulatorName: 'Dolphin',
    exeNames: ['Dolphin.exe', 'DolphinQt.exe'],
    emulatorFolders: ['{app}\\Dolphin', '%ProgramFiles%\\Dolphin', '%ProgramFiles%\\Dolphin-x64', '%LOCALAPPDATA%\\Programs\\Dolphin'],
    romFolderNames: ['wii'],
    extensions: ['rvz', 'iso', 'wbfs', 'wia', 'ciso', 'gcz', 'wad'],
    gameArgs: '-b -C Dolphin.Display.Fullscreen=True -C Dolphin.Interface.ConfirmStop=False -e "{rom}"',
    emulatorArgs: '',
    coverSeconds: 4
  },
  {
    id: 'wiiu', name: 'Wii U', emulatorName: 'Cemu',
    exeNames: ['Cemu.exe', 'cemu.exe'],
    emulatorFolders: ['{app}\\Cemu', '{app}\\cemu', '%LOCALAPPDATA%\\Programs\\Cemu', '%ProgramFiles%\\Cemu', '%APPDATA%\\Cemu'],
    romFolderNames: ['wii u', 'wiiu', 'wii-u', 'cemu'],
    // .wua (Cemu's one-file archive, best), .wud / .wux disc images, or an extracted game folder (code\<name>.rpx,
    // with meta\meta.xml giving the title). -f fullscreen, -g the game.
    extensions: ['wua', 'wud', 'wux', 'rpx', 'tmd'], deep: true, // tmd: NUS-format folders (title.tmd + .app files), which Cemu opens directly
    gameArgs: '-f -g "{rom}"',
    emulatorArgs: '',
    coverSeconds: 5
  },
  {
    id: 'sw', name: 'Switch', emulatorName: 'Eden',
    exeNames: ['eden.exe', 'Eden.exe', 'citron.exe', 'Citron.exe', 'Ryujinx.exe', 'ryujinx.exe'], // (beta.8: Citron and Ryujinx too; Ryujinx gets its own options at launch)
    emulatorFolders: ['{app}\\Eden', '%LOCALAPPDATA%\\Programs\\Eden', '%ProgramFiles%\\Eden', '%APPDATA%\\Eden', '{app}\\Citron', '%LOCALAPPDATA%\\Programs\\Citron', '{app}\\Ryujinx', '%LOCALAPPDATA%\\Programs\\Ryujinx'],
    romFolderNames: ['switch', 'nsw', 'ns'],
    extensions: ['nsp', 'xci', 'nca', 'nro'],
    // Eden comes from the yuzu family: -f = fullscreen, -g = game file.
    gameArgs: '-f -g "{rom}"',
    emulatorArgs: '',
    coverSeconds: 6
  },
  {
    id: 'sw2', name: 'Switch 2', emulatorName: 'Eglantine',
    exeNames: ['eglantine.exe', 'Eglantine.exe'],
    emulatorFolders: ['{app}\\Switch 2 emu', '{app}\\Eglantine', '{app}\\Switch 2', '%LOCALAPPDATA%\\Programs\\Eglantine', '%ProgramFiles%\\Eglantine'],
    romFolderNames: ['switch 2', 'switch2', 'nsw2', 'ns2'],
    // Eglantine is an Eden fork (same -f / -g). Games are mostly unpacked folders (exefs\main + romfs, often as base\ and
    // updates\<version>\): main\nx2.js finds them, names them and picks the newest update to boot. .nsp / .xci / .nup
    // (the newer builds' packed format) work too. Play asks which build to use (people keep several forks).
    extensions: ['nsp', 'xci', 'nup'], deep: true, hint: 'unpacked game folders (exefs + romfs), or .nsp / .xci / .nup',
    gameArgs: '-f -g "{rom}"',
    emulatorArgs: '',
    coverSeconds: 10
  },
  {
    id: 'psp', name: 'PSP', emulatorName: 'PPSSPP',
    exeNames: ['PPSSPPWindows64.exe', 'PPSSPPWindows.exe'],
    emulatorFolders: ['{app}\\PPSPP', '{app}\\PPSSPP', '%ProgramFiles%\\PPSSPP', '%ProgramFiles(x86)%\\PPSSPP'],
    romFolderNames: ['psp'],
    extensions: ['iso', 'cso', 'chd', 'pbp'],
    gameArgs: '--fullscreen --pause-menu-exit "{rom}"',
    emulatorArgs: '',
    coverSeconds: 2
  },
  {
    id: 'ps2', name: 'PS2', emulatorName: 'PCSX2',
    exeNames: ['pcsx2-qt.exe', 'pcsx2-qtx64.exe', 'pcsx2-qtx64-avx2.exe', 'pcsx2.exe'],
    emulatorFolders: ['{app}\\PCSX2', '{app}\\pcsx2', '%ProgramFiles%\\PCSX2', '%ProgramFiles%\\PCSX2 1.7.0'],
    romFolderNames: ['ps2', 'playstation 2', 'pcsx2'],
    extensions: ['iso', 'chd', 'cso', 'zso', 'gz', 'bin'],
    // -batch: close PCSX2 when the game closes; -nogui: no main window in between
    gameArgs: '-fullscreen -nogui -batch -- "{rom}"',
    emulatorArgs: '',
    coverSeconds: 4
  },
  {
    id: 'ps3', name: 'PS3', emulatorName: 'RPCS3',
    exeNames: ['rpcs3.exe', 'RPCS3.exe'],
    emulatorFolders: ['{app}\\RPCS3', '{app}\\rpcs3', '%ProgramFiles%\\RPCS3', '%LOCALAPPDATA%\\RPCS3'],
    romFolderNames: ['ps3', 'playstation 3', 'rpcs3'],
    // PS3 games are folders: disc games  <Game>\PS3_GAME\USRDIR\EBOOT.BIN, digital ones  dev_hdd0\game\NPUB12345\USRDIR\EBOOT.BIN;
    // the scanner reads PARAM.SFO next to USRDIR for the title (and skips installed patches). Newer RPCS3 builds also boot .iso.
    extensions: ['bin', 'iso'], gameFile: 'eboot.bin', alsoFiles: ['iso'], hint: 'game folders with EBOOT.BIN, or .iso', // hint: what Settings says goes in the games folder (any .bin is not a game here)
    // --no-gui: straight into the game, no game list; --fullscreen: only used together with --no-gui
    gameArgs: '--no-gui --fullscreen "{rom}"',
    emulatorArgs: '',
    coverSeconds: 6
  },
  {
    id: 'ps4', name: 'PS4', emulatorName: 'shadPS4',
    exeNames: ['shadPS4.exe', 'shadps4.exe', 'shadPS4-qt.exe'],
    emulatorFolders: ['{app}\\shadPS4', '{app}\\shadps4', '{app}\\ShadPS4', '%LOCALAPPDATA%\\shadPS4', '%ProgramFiles%\\shadPS4'],
    romFolderNames: ['ps4', 'playstation 4', 'shadps4'],
    // PS4 games are folders (CUSAxxxxx\eboot.bin); the scanner looks for eboot.bin and reads sce_sys\param.sfo for the title
    extensions: ['bin', 'pkg'], gameFile: 'eboot.bin', hint: 'game folders with eboot.bin, or .pkg',
    gameArgs: '-f true -g "{rom}"',
    emulatorArgs: '',
    coverSeconds: 6
  },
  {
    id: 'ps5', name: 'PS5', emulatorName: 'Kyty',
    exeNames: ['kyty_emulator.exe'],
    // the KytyJets fork first (Kytyps5\KytyJets\KytyPS5-U59-Windows-x64\…), then any other Kyty build
    emulatorFolders: ['{app}\\Kytyps5\\KytyJets', '{app}\\KytyJets', '{app}\\Kytyps5', '{app}\\Kyty', '{app}\\KytyPS5', '%LOCALAPPDATA%\\Kyty', '%ProgramFiles%\\Kyty'],
    romFolderNames: ['ps5', 'playstation 5', 'kyty'],
    // PS5 games are folders (PPSAxxxxx\eboot.bin with sce_sys\param.json); main/kyty.js adds the Kyty launcher's
    // settings, the game's patch file and the build's preset, and hands the emulator the game's folder
    extensions: ['bin'], gameFile: 'eboot.bin', hint: 'game folders with eboot.bin',
    gameArgs: '--game "{rom}"',
    emulatorArgs: '',
    coverSeconds: 10
  },
  {
    id: 'x360', name: 'Xbox 360', emulatorName: 'Xenia',
    exeNames: ['xenia_canary.exe', 'xenia.exe', 'xenia_canary_netplay.exe'],
    emulatorFolders: ['{app}\\Xenia', '{app}\\Xenia\\Emulators\\Xenia Canary', '{app}\\xenia', '{app}\\xenia_canary', '{app}\\Xenia Canary', '%ProgramFiles%\\Xenia'],
    romFolderNames: ['xbox 360', 'xbox360', 'x360', 'xenia'],
    // disc images, XBLA / extracted games (default.xex inside a folder; the folder's name is the title), .zar archives
    extensions: ['iso', 'xex', 'zar'],
    gameArgs: '--fullscreen=true "{rom}"',
    emulatorArgs: '',
    coverSeconds: 6
  },
  {
    id: 'n3ds', name: '3DS', emulatorName: 'Azahar',
    exeNames: ['azahar.exe', 'azahar-qt.exe', 'lime3ds.exe', 'lime3ds-gui.exe', 'citra-qt.exe'],
    emulatorFolders: ['{app}\\Azahar', '{app}\\azahar', '%ProgramFiles%\\Azahar', '%LOCALAPPDATA%\\Programs\\Azahar', '%LOCALAPPDATA%\\Azahar', '%APPDATA%\\Azahar', '{app}\\Citra', '%LOCALAPPDATA%\\Citra\\nightly', '%LOCALAPPDATA%\\Citra\\canary', '{app}\\Lime3DS'],
    romFolderNames: ['3ds', 'n3ds', 'nintendo 3ds', 'azahar', 'citra'],
    // decrypted game images (.3ds/.cci/.cxi), homebrew (.3dsx), Azahar's compressed versions (.z*) and .cia installers
    // (Boxshelf installs a .cia into Azahar the first time it's played, then boots the installed game)
    extensions: ['3ds', 'cci', 'cxi', '3dsx', 'zcci', 'zcxi', 'z3dsx', 'cia'],
    // Azahar (Citra's successor): -f fullscreen, the game file last
    gameArgs: '-f "{rom}"',
    emulatorArgs: '',
    coverSeconds: 4
  },
  // ---------- (beta.6) retro and handheld shelves: RetroArch for all of them (raCore: its core for this console; the
  // launch builds `-f -L <RetroArch>\cores\<core>_libretro.dll "{rom}"` whenever the emulator is retroarch.exe), or the
  // standalone emulator named first. Launch options checked against the real programs (2026-11): DuckStation
  // -fullscreen -batch -nogui -- ; mGBA -f ; melonDS -f ; RMG --fullscreen --quit-after-emulation --nogui ; BlastEm -f
  // (toggles fullscreen). Their cases and media are in renderer/systems-extra.js.
  ...retro([
    // (beta.11) DuckStation's program has had several names (…-Release.exe, …-ReleaseLTCG.exe, ARM64 builds): any
    // duckstation*.exe is found; DeSmuME (DS) and VisualBoyAdvance-M (GB, GBC, GBA) are found too (main.js ALT_ARGS)
    ['psx', 'PlayStation', 'DuckStation', ['duckstation-qt-x64-ReleaseLTCG.exe', 'duckstation-qt-x64-ReleaseLTCG-SSE2.exe', 'duckstation-qt.exe', 're:^duckstation[^\\\\]*\\.exe$'], ['{app}\\DuckStation', '{app}\\duckstation', '{app}\\duckstation-windows-x64-release', '%LOCALAPPDATA%\\Programs\\DuckStation', '%ProgramFiles%\\DuckStation'],
      ['psx', 'ps1', 'playstation', 'playstation 1'], ['cue', 'chd', 'm3u', 'pbp', 'iso', 'ecm', 'mds', 'img', 'ccd'], '-fullscreen -batch -nogui -- "{rom}"', 'swanstation', true],
    ['nes', 'NES', 'RetroArch', [], [], ['nes', 'famicom', 'nintendo entertainment system'], ['nes', 'fds', 'unf', 'unif', 'zip', '7z'], '', 'mesen'],
    ['snes', 'SNES', 'RetroArch', [], [], ['snes', 'sfc', 'super nintendo', 'super famicom'], ['sfc', 'smc', 'fig', 'swc', 'bs', 'zip', '7z'], '', 'snes9x'],
    ['n64', 'Nintendo 64', 'RetroArch', ['RMG.exe'], ['{app}\\RMG', '{app}\\Rosalie\'s Mupen GUI', '%LOCALAPPDATA%\\Programs\\RMG'],
      ['n64', 'nintendo 64'], ['z64', 'n64', 'v64', 'zip', '7z'], '--fullscreen --quit-after-emulation --nogui "{rom}"', 'mupen64plus_next'],
    ['gb', 'Game Boy', 'RetroArch', ['mGBA.exe', ...VBA], ['{app}\\mGBA', ...VBA_DIRS], ['gb', 'gameboy', 'game boy'], ['gb', 'zip', '7z'], '', 'gambatte'],
    ['gbc', 'Game Boy Color', 'RetroArch', ['mGBA.exe', ...VBA], ['{app}\\mGBA', ...VBA_DIRS], ['gbc', 'gameboy color', 'game boy color'], ['gbc', 'zip', '7z'], '', 'gambatte'],
    ['gba', 'Game Boy Advance', 'RetroArch', ['mGBA.exe', ...VBA], ['{app}\\mGBA', '%ProgramFiles%\\mGBA', ...VBA_DIRS], ['gba', 'gameboy advance', 'game boy advance'], ['gba', 'zip', '7z'], '-f "{rom}"', 'mgba'],
    ['nds', 'DS', 'melonDS', ['melonDS.exe', 're:^desmume[^\\\\]*\\.exe$'], ['{app}\\melonDS', '%ProgramFiles%\\melonDS', '{app}\\DeSmuME', '%ProgramFiles%\\DeSmuME'], ['nds', 'ds', 'nintendo ds'], ['nds', 'dsi', 'zip', '7z'], '-f "{rom}"', 'melondsds', true],
    ['megadrive', 'Mega Drive', 'RetroArch', ['blastem.exe'], ['{app}\\BlastEm', '{app}\\blastem'], ['megadrive', 'genesis', 'mega drive', 'md'], ['md', 'gen', 'smd', 'bin', 'zip', '7z'], '-f "{rom}"', 'genesis_plus_gx'],
    ['mastersystem', 'Master System', 'RetroArch', [], [], ['mastersystem', 'master system', 'sms'], ['sms', 'zip', '7z'], '', 'genesis_plus_gx'],
    ['gamegear', 'Game Gear', 'RetroArch', [], [], ['gamegear', 'game gear', 'gg'], ['gg', 'zip', '7z'], '', 'genesis_plus_gx'],
    // Flycast 2.7 has no fullscreen option to pass: the Dreamcast starts in RetroArch's Flycast core unless Flycast itself is chosen
    ['dreamcast', 'Dreamcast', 'RetroArch', ['flycast.exe'], ['{app}\\Flycast', '{app}\\flycast'], ['dreamcast', 'dc'], ['chd', 'gdi', 'cdi', 'cue', 'm3u'], '"{rom}"', 'flycast'],
    // (beta.7) wave 2: RetroArch only. Arcade and Neo Geo games are zips named by their set ("sf2.zip"): the shelf shows the
    // FinalBurn Neo game name for them (main/arcadenames.js). DOS games are zips (or .dosz) that DOSBox Pure starts directly.
    ['saturn', 'Saturn', 'RetroArch', [], [], ['saturn', 'sega saturn', 'ss'], ['cue', 'chd', 'ccd', 'm3u', 'iso', 'mds'], '', 'mednafen_saturn'],
    ['pcengine', 'TurboGrafx-16', 'RetroArch', [], [], ['pcengine', 'pce', 'tg16', 'turbografx', 'turbografx16', 'turbografx-16', 'pcenginecd', 'tg-cd'], ['pce', 'sgx', 'cue', 'chd', 'ccd', 'm3u', 'zip', '7z'], '', 'mednafen_pce_fast'],
    ['neogeo', 'Neo Geo', 'RetroArch', [], [], ['neogeo', 'neo geo', 'neo-geo'], ['zip', '7z'], '', 'fbneo'],
    ['arcade', 'Arcade', 'RetroArch', [], [], ['arcade', 'mame', 'fbneo', 'fba', 'cps1', 'cps2', 'cps3'], ['zip', '7z'], '', 'fbneo'],
    ['segacd', 'Sega CD', 'RetroArch', [], [], ['segacd', 'sega cd', 'megacd', 'mega cd'], ['cue', 'chd', 'iso', 'm3u'], '', 'genesis_plus_gx'],
    ['sega32x', '32X', 'RetroArch', [], [], ['sega32x', '32x', 'sega 32x'], ['32x', 'zip', '7z'], '', 'picodrive'],
    ['atari2600', 'Atari 2600', 'RetroArch', [], [], ['atari2600', 'atari 2600', '2600', 'a2600'], ['a26', 'bin', 'zip', '7z'], '', 'stella'],
    ['atarilynx', 'Lynx', 'RetroArch', [], [], ['atarilynx', 'lynx', 'atari lynx'], ['lnx', 'zip', '7z'], '', 'handy'],
    ['wonderswan', 'WonderSwan', 'RetroArch', [], [], ['wonderswan', 'wonderswancolor', 'wonderswan color', 'wsc', 'ws'], ['ws', 'wsc', 'zip', '7z'], '', 'mednafen_wswan'],
    // [AÑADIDO] Neo Geo Pocket / Color: solo RetroArch (core mednafen_ngp), sin BIOS. Quita o cambia esta línea para
    // quitar el estante; el resto de sus datos está marcado con [AÑADIDO] en covers.js, screenscraper.js, manuals.js,
    // commercials.js, modelfind.js, themes.js, addgames.js, renderer/systems-extra.js, renderer/style.css y renderer/setup.js
    ['ngpc', 'Neo Geo Pocket Color', 'RetroArch', [], [], ['ngpc', 'ngp', 'neogeo pocket', 'neo geo pocket', 'neogeo pocket color', 'neo geo pocket color'], ['ngpc', 'ngp', 'zip', '7z'], '', 'mednafen_ngp'],
    ['dos', 'DOS', 'RetroArch', [], [], ['dos', 'msdos', 'ms-dos', 'pc dos'], ['zip', 'dosz'], '', 'dosbox_pure'],
  ])
];
// (beta.6) one retro shelf: [id, name, emulator name, standalone exe names, its folders, ROM folder names, extensions,
// standalone launch options, RetroArch core, standalone first?]. RetroArch's usual homes are searched for every one of them;
// a shelf whose standalone emulator is the better choice (DuckStation, melonDS) looks for it first.
function retro(rows) {
  const RA_EXE = ['retroarch.exe'];
  const RA_DIRS = ['{app}\\RetroArch', '{app}\\RetroArch-Win64', 'C:\\RetroArch-Win64', 'C:\\RetroArch', '%APPDATA%\\RetroArch', '%ProgramFiles%\\RetroArch', '%ProgramFiles%\\RetroArch-Win64',
    '%ProgramFiles(x86)%\\Steam\\steamapps\\common\\RetroArch', '%ProgramFiles%\\Steam\\steamapps\\common\\RetroArch'];
  return rows.map(([id, name, emulatorName, exes, dirs, romFolderNames, extensions, args, raCore, standaloneFirst]) => ({
    id, name, emulatorName, raCore, retro: true,
    exeNames: standaloneFirst ? [...exes, ...RA_EXE] : [...RA_EXE, ...exes],
    emulatorFolders: standaloneFirst ? [...dirs, ...RA_DIRS] : [...RA_DIRS, ...dirs],
    romFolderNames, extensions,
    gameArgs: args || '"{rom}"', // (the standalone's options; RetroArch gets its own, see main.js retroArgs)
    emulatorArgs: '',
    coverSeconds: 4
  }));
}

const APPS = [
  {
    id: 'stremio', name: 'Stremio',
    exeNames: ['stremio.exe', 'stremio-shell-ng.exe', 'Stremio.exe'],
    folders: ['%LOCALAPPDATA%\\Programs\\LNV\\Stremio-4', '%LOCALAPPDATA%\\Programs\\Stremio', '%ProgramFiles%\\Stremio', '%ProgramFiles%\\LNV\\Stremio-4']
  },
  {
    id: 'nuvio', name: 'Nuvio',
    exeNames: ['Nuvio.exe', 'nuvio.exe'],
    folders: ['%LOCALAPPDATA%\\Programs\\Nuvio', '%LOCALAPPDATA%\\Programs\\nuvio', '%ProgramFiles%\\Nuvio']
  }
];

// Extra places to look for portable emulators and ROM folders. (1.82) Windows 11 with OneDrive backup moves the Desktop and
// Documents into the OneDrive folder (%OneDrive%; a place whose variable isn't set is simply skipped).
const SEARCH_ROOTS = [
  '{app}', '{app}\\Emulators',
  '%USERPROFILE%\\Desktop', '%OneDrive%\\Desktop', '%USERPROFILE%\\Emulators', '%USERPROFILE%\\Downloads',
  '%USERPROFILE%\\Documents', '%OneDrive%\\Documents',
  'C:\\Emulators', 'D:\\Emulators', 'E:\\Emulators', 'C:\\Games', 'D:\\Games'
];
const ROM_ROOT_NAMES = ['roms', 'games', 'isos'];

// ---------- (Linux) where emulators live there: installed programs (/usr/bin), Flatpaks (each one exports a launcher
// named after its id, e.g. /var/lib/flatpak/exports/bin/org.DolphinEmu.dolphin-emu, so it's found and started like any
// program) and AppImages (versioned names: "re:" entries are patterns). EmuDeck keeps AppImages in ~/Applications and ROMs
// in ~/Emulation/roms/<system>, RetroDECK in ~/retrodeck/roms; SD cards are added by detect.js (/run/media/…).
// Only applied on Linux: Windows keeps the tables above exactly as they are.
const LINUX_DIRS = ['{app}', '{app}/Emulators', '%HOME%/Applications', '%HOME%/.local/bin', '%HOME%/.local/share/flatpak/exports/bin',
  '/var/lib/flatpak/exports/bin', '/usr/bin', '/usr/games', '/usr/local/bin', '/opt', '%HOME%/Emulation/tools', '%HOME%/Desktop', '%HOME%/Downloads'];
const LINUX_RA = ['retroarch', 'org.libretro.RetroArch', 're:^retroarch.*\\.appimage$'];
const LINUX_RA_DIRS = ['%HOME%/.local/share/Steam/steamapps/common/RetroArch', '%HOME%/.steam/steam/steamapps/common/RetroArch'];
const LINUX_EMU = {
  gc: ['dolphin-emu', 'org.DolphinEmu.dolphin-emu', 're:^dolphin.*\\.appimage$'],
  wii: ['dolphin-emu', 'org.DolphinEmu.dolphin-emu', 're:^dolphin.*\\.appimage$'],
  wiiu: ['cemu', 'info.cemu.Cemu', 're:^cemu.*\\.appimage$'],
  sw: ['eden', 're:^eden.*\\.appimage$', 'citron', 're:^citron.*\\.appimage$', 'Ryujinx', 'ryujinx', 'org.ryujinx.Ryujinx', 're:^(ryujinx|ryubing).*\\.appimage$'], // (beta.8: EmuDeck installs Citron or Ryujinx)
  sw2: ['eglantine', 're:^eglantine.*\\.appimage$'],
  psp: ['PPSSPPSDL', 'PPSSPPQt', 'ppsspp', 'org.ppsspp.PPSSPP', 're:^ppsspp.*\\.appimage$'],
  ps2: ['pcsx2-qt', 'net.pcsx2.PCSX2', 're:^pcsx2.*\\.appimage$'],
  ps3: ['rpcs3', 'net.rpcs3.RPCS3', 're:^rpcs3.*\\.appimage$'],
  ps4: ['shadps4', 'net.shadps4.shadPS4', 're:^shadps4.*\\.appimage$'],
  ps5: [], x360: [], // (Kyty and Xenia: Windows only)
  n3ds: ['azahar', 'org.azahar_emu.Azahar', 're:^azahar.*\\.appimage$', 'lime3ds', 'citra-qt'],
  psx: ['duckstation-qt', 'org.duckstation.DuckStation', 're:^duckstation.*\\.appimage$'],
  n64: ['RMG', 'com.github.Rosalie241.RMG', 're:^rmg.*\\.appimage$'],
  gba: ['mgba-qt', 'mgba', 'io.mgba.mGBA', 're:^mgba.*\\.appimage$', 'visualboyadvance-m', 'com.vba_m.visualboyadvance-m', 're:^visualboyadvance.*\\.appimage$'],
  gb: ['mgba-qt', 'mgba', 'io.mgba.mGBA', 'visualboyadvance-m', 'com.vba_m.visualboyadvance-m'], gbc: ['mgba-qt', 'mgba', 'io.mgba.mGBA', 'visualboyadvance-m', 'com.vba_m.visualboyadvance-m'], // (beta.11)
  nds: ['melonDS', 'net.kuribo64.melonDS', 're:^melonds.*\\.appimage$', 'desmume', 'org.desmume.DeSmuME'], // (beta.11: DeSmuME too)
  megadrive: ['blastem'],
  dreamcast: ['flycast', 'org.flycast.Flycast', 're:^flycast.*\\.appimage$'],
};
function forLinux() {
  for (const c of CONSOLES) {
    const own = LINUX_EMU[c.id] || [];
    if (c.retro) { const first = c.exeNames[0] !== 'retroarch.exe'; c.exeNames = first ? [...own, ...LINUX_RA] : [...LINUX_RA, ...own]; c.emulatorFolders = [...LINUX_DIRS, ...LINUX_RA_DIRS]; }
    else { c.exeNames = own; c.emulatorFolders = LINUX_DIRS; }
  }
  APPS.splice(0, APPS.length, { id: 'stremio', name: 'Stremio', exeNames: ['stremio', 'com.stremio.Stremio'], folders: LINUX_DIRS });
  SEARCH_ROOTS.splice(0, SEARCH_ROOTS.length, '{app}', '{app}/Emulators', '%HOME%/Emulation', '%HOME%/retrodeck', '%HOME%', '%HOME%/Games',
    '%HOME%/Emulators', '%HOME%/Desktop', '%HOME%/Downloads', '%HOME%/Documents');
}
if (process.platform === 'linux') forLinux();

module.exports = { CONSOLES, APPS, SEARCH_ROOTS, ROM_ROOT_NAMES, forLinux };
