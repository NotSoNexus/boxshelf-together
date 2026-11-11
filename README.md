# Boxshelf Together 🎮

Un fork de Boxshelf enfocado en conectar jugadores: perfiles locales personalizables, lista de amigos y sistema online para compartir tus sesiones retro.

Basado en **Boxshelf 1.82.0-beta.12** (`sassiestrhihno/boxshelf-source`, GPL-3.0).

### ✨ Características añadidas:
- 👥 **Perfiles Locales:** Crea y cambia entre perfiles de jugador con foto de perfil, banner y biografía personalizada.
- 🌐 **Boxshelf Online:** Conexión con amigos mediante Códigos de Amigo (Friend Codes) y servidor de presencia en tiempo real.
- 🚀 **Navegación Fluida:** Animaciones de retorno suaves entre menús, compatible con mandos (Xbox, PlayStation, Switch y genéricos).
- ⚙️ **Configuración Sencilla:** Ajusta tu servidor online y gestiona tus perfiles directamente desde los ajustes del Shelf.

---

## Boxshelf Original

> **This is Boxshelf's source code** (Windows: Electron; Android: Capacitor, in `android-app\`), released under the
> [GNU GPL v3.0](LICENSE). **Just want to play?** Get the ready-made download from the
> [Boxshelf beta page](https://github.com/sassiestrhihno/boxshelf-beta/releases). Bugs and ideas go to the beta page's
> [issues](https://github.com/sassiestrhihno/boxshelf-beta/issues/new/choose). This repository is a snapshot of each
> beta (it starts at 1.82.0-beta.4); the 3D PC model the museum can show isn't included here.

## First run

1. Install **Node.js LTS** from nodejs.org (one time).
2. Double-click **Start Boxshelf.bat**. The first start installs what it needs (about a minute).
3. The setup wizard opens. Click **Find automatically**, check each system, then **Open Boxshelf**.

Use **Start Boxshelf (window).bat** to run it in a window instead of fullscreen. `npm run dist` builds a
portable `Boxshelf.exe` in `dist\` if you'd rather not keep Node around; keep the exe in this folder.

## Folder layout (portable)

```
Boxshelf\
  Dolphin\       Dolphin.exe             GameCube + Wii
  Cemu\          Cemu.exe                Wii U
  Eden\          eden.exe                Switch
  PPSPP\         PPSSPPWindows64.exe     PSP
  PCSX2\         pcsx2-qt.exe            PS2
  RPCS3\         rpcs3.exe               PS3
  shadPS4\       shadPS4.exe             PS4
  Xenia\         xenia_canary.exe        Xbox 360
  Azahar\        azahar.exe              3DS
  ROMS\Gamecube  ROMS\Wii  ROMS\Wii U  ROMS\Switch  ROMS\PSP  ROMS\PS2  ROMS\PS3  ROMS\PS4  ROMS\Xbox 360  ROMS\3DS
  themes\<system>\   logo.png · boot.mp4 · console.png | console.glb (+ console.json) · cart.glb | disc.glb | umd.glb
  data\          config.json, boxshelf.log, caches (art database index, icons, achievements)
```

Games in subfolders are found too; `DLC`, `Updates` and `Patches` folders are skipped, as are Switch update
and DLC packages. PS4 games are folders with an `eboot.bin` inside (`CUSA00223\eboot.bin`); the title comes
from `sce_sys\param.sfo`. Xbox 360 games are `.iso` discs, extracted folders with a `default.xex`, XBLA `.xex` files or `.zar`
archives; the title ID inside the game gives the real name (via the Xenia compatibility list, cached in `data\`), so
`DVD.iso` in a folder still shows up as the game. Details show Xenia's compatibility rating. Picking `XeniaManager.exe`
is fine: Boxshelf launches the Canary build from its `Emulators` folder. Wii `.nkit.iso` dumps and Switch `[titleid][v0]` names are cleaned up automatically.

## Art, manuals and game info

Settings → **Find artwork & manuals** searches every selected shelf and shows one list to tick through before
anything downloads. Fronts come from the libretro thumbnail library and the LaunchBox Games Database; backs,
spines, disc / cartridge labels and the game descriptions, release dates and ratings in Details come from
LaunchBox; manuals come from GamesDatabase.org (PDFs, turned into pages in the background) and the Internet
Archive. Digital-only titles fall back to fan-made box fronts or the Steam poster. Backs prefer English-only
scans (UK / Australia) over the trilingual North American ones; tick *Replace existing backs* once to swap
ones you already have. GameCube and Wii spines that LaunchBox doesn't have are cut from GameTDB's full cover
scans (found by the disc ID inside the game file). With *Fetch box art / manuals automatically* on, new games
that appear after a rescan get their art and manuals fetched in the background; both are **off** on a fresh
install until you turn them on (setup's last page, or Settings → Library & art). Manuals already in your folders
are only ever moved aside, never deleted: replaced pages go to `covers\.manual-originals\<game>\<date>\`.

Cover art by hand: images named like the game file (`Pikmin (USA).png`, `-back`, `-spine`, `-disc`,
`-manual-01.jpg …`) in a `covers` folder inside the games folder. App and emulator tiles use each program's
own icon.

## Controls

| Action | Keyboard | Xbox / PlayStation |
|---|---|---|
| Browse | ← → | D-pad / left stick |
| Change shelf | ↑ ↓ | LT / RT (or D-pad up/down) |
| Jump by letter | Z / C | LB / RB |
| Play / Open | Enter | A / Cross |
| Back | Esc | B / Circle |
| Flip box (the right stick turns it freely and settles on a side: front, spine, back) | F | Y / Triangle |
| Details | I | X / Square |
| Inspect | V | Click the right stick |
| Shuffle (spin to a random game) | R | Click the left stick |
| Settings · Customize | S · T | Start · Back (short press) |
| Quit a game, or Boxshelf from the shelf | | hold L3 + R3 (changeable in Settings → Controller) |

**Inspect**: left/right or D-pad step to the next side (front, spine, back, edge); the stick turns freely and
settles on a side when released; triggers zoom (zoomed in, the left stick pans gently and the right stick turns); A opens the case, then takes the
disc or cartridge out (the case slides away so you're holding just the disc); hold A to play; X reads the
manual (bumpers, D-pad, stick or A turn pages); B puts things back. **Details**: Y opens the achievement list
when the game has one.

## Launch options

Each system's command line is editable in Settings → (system) → Launch options. `{rom}` is the game file.

- Dolphin: `-b -C Dolphin.Display.Fullscreen=True -C Dolphin.Interface.ConfirmStop=False -e "{rom}"`
- Eden: `-f -g "{rom}"` · Cemu: `-f -g "{rom}"` · PPSSPP: `--fullscreen --pause-menu-exit "{rom}"` · PCSX2: `-fullscreen -nogui -batch -- "{rom}"`
- RPCS3: `--no-gui --fullscreen "{rom}"` · shadPS4: `-f true -g "{rom}"` · Xenia: `--fullscreen=true "{rom}"` · Azahar: `-f "{rom}"`

*Cover time* keeps Boxshelf's black screen on top while the emulator opens (raise it if you see the emulator's
window flash). GameCube can boot through the real startup sequence if you add an IPL to Dolphin (Settings →
GameCube → Boot sequence).

## Controller while a game runs

On the shelf, Guide (or Home / P on the keyboard) opens the same panel with Home shelf, Museum, Sort, Settings and **Power**: Sleep, Restart, Shut down and Quit Boxshelf (the last three need A held). A controller icon beside the clock lights while a pad is connected, the mouse pointer hides while you use the pad, and Settings → Display → Interface size makes everything larger for a TV across the room.

Press **Guide** (or hold **View/Back** for about a second) in a game for the Home menu: the game pauses and a panel slides in from the left with Resume, Save state, Load state, Screenshot, Power and Quit to shelf (hold A). Sleep from a game saves a state first where it can and leaves the game paused; Restart and Shut down close the game properly first. It sends each emulator's default hotkeys — Dolphin F10/Shift+F1/F1/F9, PCSX2 Space/F1/F3/F8, PPSSPP F2/F4/F12, Eden F4/Ctrl+P — and only shows what that emulator can do. If you've remapped them, add `"hotkeys": { "pause": "f10", "save": "shift+f1", "load": "f1", "shot": "f9" }` under that console in `data\\config.json`. If Guide opens the Xbox Game Bar, turn off its controller shortcut (Windows Settings → Gaming → Xbox Game Bar) or use the hold.

A small helper reads XInput directly, so it works while Boxshelf is minimized: hold the quit combo for about a
second to close the emulator and come back to the shelf. Eden's "stop emulation?" confirmation is switched off in its
settings before each launch so the combo closes it cleanly; anything still open a few seconds later is ended. Media apps can get their fullscreen key pressed for
them once their window is up, and optionally a pointer driven by the pad (Settings → Media) for apps with no
controller support of their own.

## Museum

M, the **Museum** button, or holding View/Back on the pad opens your whole collection as one shelving wall: a row per
system with every case standing spine-out at its real size, the console at the end of its row (your
`themes\<system>\console.glb` if you've added one, otherwise an original stand-in) and a plaque with that shelf's
numbers. The cases drop into place when you enter (any button skips; games added since your last visit glow).
Up/down picks a row, left/right a case (it slides out and turns to face you, with a little card beneath), bumpers skip
ten, A opens it in Inspect, A on the console picks it up to turn with the stick, B comes back. Settings → Display has a
shadows toggle if the museum stutters on your GPU.


Lighting: Gallery (warm picture lights), Daylight, After hours (dim room, strong spotlight) or Neon (each row lit in its console's colour). Press Y on the pad or L on the keyboard inside the museum to cycle, or pick one in Settings → Display → Museum. The case you're on gets its own soft spotlight, and the card beside it shows maker, year, publisher, genre, rating and your play history.

## Home, Continue and favorites

Once you've played something, a **Home** shelf appears first: the games you launched most recently (any system),
then your favorites. Hold Y (or press H) on any game to favorite it — a heart appears on its box. Playing from Home
hops to the game's own shelf and starts it.

## Details

X / I opens Details: cover, year, genre, players, rating and your own history with the game (launches, time
played, last played), a strip of screenshots (bumpers or [ ] flick through them, the chosen one fills the top),
the description, and a **Trailer** button (Y or T) that plays the game's trailer in a window over the shelf — Esc
or the close button ends it. Hold Y for the achievement list when a game has both.

## Attract mode and shuffle

Leave the shelf alone for a few minutes and it starts drifting through the boxes on its own with the HUD faded,
wandering between shelves; any button or mouse movement brings it back (Settings → Display to turn it off).
Shuffle (R, or click the left stick) flickers across your shelves and lands on a random game with a holographic flash;
Settings → Library & art can limit it to the shelf you're on. Inspect lifts the selected box straight out of the shelf,
which stays visible behind it.

## Settings

Settings is split into pages: Display (theme — Spectrum, Midnight, Aurora, Sunset, Gallery or Synthwave — fullscreen, the background behind the shelf — soft blur or the game's own artwork, sharp — visual effects, museum shadows, attract mode), Sound, Controller (prompts, quit combo, rumble), Library & art (automatic covers, art folder, shuffle scope, rescan) and Startup & system. Each emulator still has its own page above them.

## Wii U (Cemu)

Point the Wii U page in Settings at `Cemu.exe` and add your games folder. Games can be `.wua` files (best), `.wud`/`.wux` disc images (need your keys.txt in Cemu) or extracted game folders: the shelf finds `code\*.rpx` and takes the title from `meta\meta.xml`. Install updates and DLC inside Cemu. Cemu has no save states, so the Home menu offers Screenshot (F12), Power and Quit.

## 3DS (Azahar) and PS3 (RPCS3)

Point the 3DS page at `azahar.exe` and add your games folder. Unencrypted `.cia` files can be installed into
Azahar from Boxshelf; encrypted ones have to be decrypted first. PS3 games are launched through RPCS3 with
`--no-gui --fullscreen`; install games and firmware inside RPCS3 first.

## Phone companion

Settings → Phone companion turns your phone into a remote: on the same Wi-Fi, scan the QR code, enter the PIN, and
the phone can browse the library, start a game on the TV, read a manual, and work as a d-pad and keyboard. See the
privacy section for how it's locked down.

## Sort, filter and volume

G (or hold Menu/Start on the pad, or the Sort button) opens *Arrange your shelves*: sort by A–Z, release year, last
played, most played, rating or genre, and show all games, favorites, played or not-played-yet. It applies to every
shelf and the museum, and is remembered. L1/R1 (Z/C) then jump between sections — letters, years, genres or play-time
bands — and the museum puts a brass divider tab on the shelf edge where each section starts.

The speaker beside the clock mutes; hover it for a volume slider. On the keyboard, - and = nudge the volume.

## PC (Steam) art

Steam only keeps a box cover for games you've looked at in its library grid. For the rest, Boxshelf fetches the cover,
hero image, release date, developer, genres, Metacritic score and screenshots from Steam's public store (no account or
key) and keeps them in `data\steam-art` and `steam-info.json`. Turning off automatic covers in Settings stops it.

## Sounds

Settings → Sound: six voices (Aero is the default), a master volume, and an optional (off by default) ambient bed that follows the
shelf with its own level slider.

## RetroAchievements

Settings → Achievements: your RA username and web API key (retroachievements.org → Settings → Keys). The shelf
then shows your points, per-game progress tags, a progress ring and the full achievement list in Details, and a
recap of what you unlocked when you come back from a game. Earning happens in the emulator: enable
RetroAchievements and log in inside Dolphin (Config → Achievements; GameCube only, Wii has no sets), PPSSPP
(Settings → Tools → RetroAchievements) and PCSX2 (Settings → Achievements).

## Your own 3D models

`themes\<system>\console.glb` replaces the built-in console in the insert animation and the museum (Wii, PS2, PS4 and
Xbox 360 models take the disc upright through a front slot; GameCube opens a lid; `"slot": "top"|"front"` in
console.json overrides that, and `"museumYaw"` / `"museumScale"` turn or resize the model on the museum shelf only) (Customize →
Console → Add 3D model, or **Find a model**, which opens a search of free downloadable models in your browser and
installs the first .glb / .zip you save to Downloads — check each model's licence; Boxshelf doesn't bundle console
models): it rises in, its lid opens, the disc lands on it, the lid closes. Loose accessories in the file are
hidden; a lid is found by name (`lid`, `cover`, `door`…) or by shape. Tweak with `console.json`:

```json
{ "yaw": 0, "pitch": 0, "roll": 0, "scale": 1, "lift": 0,
  "lid": "Lid_mesh_name", "lidHinge": "back", "lidAxis": "x", "lidAngle": -70,
  "discX": 0, "discZ": 0, "discHeight": 0, "discScale": 1, "hide": "controller|cable", "exposure": 1 }
```

`themes\sw\cart.glb`, `themes\psp\umd.glb`, `themes\gc\disc.glb` / `themes\wii\disc.glb` / `themes\ps4\disc.glb`
replace the media in Inspect. Files with several copies of the object are fine: the first one with a picture
is used and the game's own cover goes where that picture was. `cart.json` (`{ "yaw": 0, "pitch": 0, "roll": 0,
"scale": 1 }`) adjusts the automatic orientation. Customize → Test replays the insert animation without launching.

## Privacy and what Boxshelf changes on your PC

Boxshelf has no accounts, ads or telemetry, and everything it saves stays in its own folder (`data\`) and in the
`covers` folders next to your games. It goes online only for:

| Service | When | What it's sent |
|---|---|---|
| libretro thumbnails, LaunchBox Games Database, GameTDB | Art look-ups (automatic only if you turned it on) | game titles / GameCube & Wii disc IDs |
| Internet Archive, GamesDatabase.org | Manual look-ups (automatic only if you turned it on) | game titles |
| Steam store | PC shelf art for games Steam has no cover for | Steam app IDs |
| raw.githubusercontent.com | Xbox 360 shelf: Xenia's compatibility list, weekly | nothing |
| RetroAchievements | Only if you enter your account | your username and web API key (https) |
| YouTube (youtube-nocookie.com) | Only when you play a trailer | the video ID |
| SteamGridDB | Only if you enter your own API key (Settings) | game titles / Steam app IDs and your key |
| ScreenScraper | Only if you enter your own account | file name, size and checksums (CRC/MD5/SHA-1) of the game file, and your login. Never the file itself |
| fanart.tv | Only if you enter your own API key | movie/show IDs (Stremio / Nuvio shelves) |
| Stremio (cinemeta, metahub) | Stremio / Nuvio shelves | movie/show IDs |
| Internet Archive | Retro TV commercials, magazines and guides you search for | search text |
| Sketchfab, Poly Pizza | Only when you press **Find a model** (opens your browser) | the console name |
| Wikimedia Commons | Only when you press **Find a logo** (Customize) | the console name |

The **phone companion** is off until you switch it on. It runs a small web server on your home network only:
it answers private-range addresses only, phones pair with a 6-digit PIN (5 wrong tries lock pairing for 10
minutes), and every request needs the long random token the phone gets when it pairs. Tokens are stored only as
hashes, and pictures go out under random IDs, never file paths.

All API keys and passwords you enter are stored encrypted for your Windows account, like the RetroAchievements key.

Fonts are bundled; nothing is loaded from Google. Your RetroAchievements key and other API keys are stored encrypted for your Windows
account (it has to be entered again after moving the folder to another PC). `data\boxshelf.log` writes your home
folder as `~` and is kept under about 4 MB.

Changes outside Boxshelf's folder:
- **Emulator settings.** So Home → Quit closes games cleanly, Boxshelf turns off the "are you sure?" questions in
  Eden / yuzu, PCSX2 and RPCS3 before a launch (each file is backed up once as `<file>.boxshelf-bak`; Settings →
  Library & art → *Restore emulator settings* puts them back). Dolphin gets borderless fullscreen and no stop
  question on its command line for that run only — its own settings files aren't touched.
- **Start with Windows** (only if you switch it on): a shortcut in your Startup folder or an entry under
  `HKCU\…\Run`; switch it off in Settings before deleting the folder.
- While a game runs, a small controller helper (PowerShell, in `data\padwatch`) watches the pad for Guide / the
  quit combo, presses the emulator's own hotkeys for the Home menu, and moves the mouse pointer out of the way. It
  only acts while the game is in front and exits on its own if Boxshelf closes.

## Building the exe

`Build Boxshelf.exe.bat` makes a portable `Boxshelf.exe` in `dist\`. The exe is locked down against tampering
(Electron fuses): it only runs its own packed, integrity-checked app files, and it can't be started as a plain
Node.js runtime or with a debugger attached. The exe isn't code-signed, so Windows may show a SmartScreen
warning the first time; choose **More info → Run anyway**.

## Credits

Box art and metadata: [libretro thumbnails](https://thumbnails.libretro.com), [LaunchBox Games Database](https://gamesdb.launchbox-app.com),
[GameTDB](https://www.gametdb.com). Manuals: [Internet Archive](https://archive.org) collections and
[GamesDatabase.org](https://www.gamesdatabase.org). Box art and manuals are © their publishers. Fonts are under the
SIL Open Font License (see `renderer\fonts\LICENSES`). Bundled libraries and their licences: see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Licence

Boxshelf is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License
as published by the Free Software Foundation, version 3 ([LICENSE](LICENSE)). It comes with no warranty.

**The name and logo:** the GPL covers the code, not the Boxshelf name or its logo. If you release a fork or a
modified version, please give it a different name and logo, so people can tell it apart from the official Boxshelf
(saying it's "based on Boxshelf" is welcome).

## When something's off

`data\boxshelf.log` records launches, downloads, matches that failed and renderer errors. Settings → Startup & system → *Open app folder* gets you there. Try Settings → Display →
*Visual effects → Smooth* if the shelf stutters on a large or high-refresh screen.
