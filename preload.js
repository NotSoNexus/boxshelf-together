// The only bridge between the launcher screen and your PC.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (name, arg) => ipcRenderer.invoke(name, arg).then(r => { if (!r.ok) throw new Error(r.error); return r.data; });

contextBridge.exposeInMainWorld('boxshelf', {
  // What this build can do (docs/PLATFORM-API.md). The Android build reports os 'android' and turns off what it can't do.
  // (Linux / Steam Deck: no in-game Home menu, Windows emulator-settings fixes, Dolphin IPL setup, RetroArch auto-config or
  // taskbar switch there yet. beta.12: power (systemctl) and start at login (an autostart .desktop file) are on)
  platform: process.platform === 'linux'
    ? { os: 'linux', caps: { steam: true, power: true, homeMenu: false, emuSettings: false, autostart: true, displays: true, folders: true, companionServer: true, winMode: false, dolphinIpl: false, raAutoConfig: false } }
    : { os: 'windows', caps: { steam: true, power: true, homeMenu: true, emuSettings: true, autostart: true, displays: true, folders: true, companionServer: true, winMode: true, dolphinIpl: true, raAutoConfig: true } },
  getConfig: () => call('config:get'),
  reload: () => call('app:reload'), // main reloads the screen (a page-initiated location.reload() is blocked by will-navigate)
  profiles: () => call('profiles:list'),
  createProfile: name => call('profiles:create', { name: String(name || '') }),
  selectProfile: id => call('profiles:select', { id: String(id || '') }),
  updateProfile: (id, patch) => call('profiles:update', { id: String(id || ''), patch: patch || {} }),
  stageProfileImage: file => call('profiles:stage', { file: String(file || '') }),

  // Boxshelf Online (perfiles y amigos)
  onlineStatus: () => call('online:status'),
  onlineSetServer: url => call('online:setServer', { url: String(url || '') }),
  onlineRegister: name => call('online:register', { name: String(name || '') }),
  onlineSync: () => call('online:sync'),
  onlineUpload: (kind, data) => call('online:upload', { kind: String(kind || ''), data: data || {} }),
  onlineFriends: () => call('online:friends'),
  onlineFriendAdd: code => call('online:friendAdd', { code: String(code || '') }),
  onlineFriendRemove: code => call('online:friendRemove', { code: String(code || '') }),
  onlineView: code => call('online:view', { code: String(code || '') }),
  openExternal: url => call('app:openExternal', { url }),
  updateCheck: force => call('app:updateCheck', { force: !!force }), // (1.82) { current, latest, newer, url, links } or { error }
  onUpdate: cb => ipcRenderer.on('app:update', (_e, r) => cb(r)),
  restoreEmuSettings: () => call('emucfg:restore'),
  // (beta.7) Set up for me
  emuSetupStatus: (systemId) => call('emusetup:status', { systemId }), emuSetupPlan: (systemId) => call('emusetup:plan', { systemId }),
  emuSetupApply: (systemId, on) => call('emusetup:apply', { systemId, on }), emuSetupUndo: (systemId) => call('emusetup:undo', { systemId }), emuSetupAuto: () => call('emusetup:auto'),
  getCore: (systemId) => call('racore:get', { systemId }), openBiosFolder: (systemId) => call('bios:open', { systemId }),
  onCoreProgress: (fn) => { const h = (_e, d) => fn(d); ipcRenderer.on('racore:progress', h); return () => ipcRenderer.removeListener('racore:progress', h); },
  log: msg => ipcRenderer.send('renderer:log', String(msg).slice(0, 2000)),
  crumb: t => ipcRenderer.send('ui:crumb', String(t).slice(0, 200)), // (beta.9) the screen's last steps, logged only if it crashes
  uiBusy: () => ipcRenderer.send('ui:busy'),
  saveConfig: cfg => call('config:save', cfg),
  detect: () => call('detect'),
  scan: () => call('library:scan'),
  scanIfChanged: () => call('library:scan', { ifChanged: true }),
  cachedLibrary: () => call('library:cached'),
  homeMeta: meta => ipcRenderer.send('home:meta', meta),
  pick: opts => call('dialog:pick', opts),
  launchGame: (systemId, file, emulator) => call('launch:game', { systemId, file, emulator }),
  customThemes: () => call('customThemes:list'), // (1.76) picture themes: Custom themes\<name>\
  customThemeCreate: (file, name) => call('customThemes:create', { file, name }),
  customThemesOpen: () => call('customThemes:open'),
  sw2Builds: file => call('sw2:builds', { file }), // Switch 2: the Eglantine builds to choose from at Play
  sw2AddBuild: exe => call('sw2:addBuild', { exe }), // (beta.11) "+ Add another emulator" in that list
  onLaunchStatus: cb => ipcRenderer.on('launch:status', (_e, t) => cb(t)),
  launchEmulator: systemId => call('launch:emulator', { systemId }),
  launchApp: (appId, link) => call('launch:app', { appId, link }),
  stremioLibrary: () => call('stremio:library'),
  stremioPoster: (id, url) => call('stremio:poster', { id, url }),
  stremioDetails: (type, id) => call('stremio:details', { type, id }),
  tvScan: () => call('tv:scan'), tvList: () => call('tv:list'), tvAdFor: (systemId, file) => call('tv:adFor', { systemId, file }), tvLocal: ad => call('tv:local', { ad }),
  onTvFound: cb => ipcRenderer.on('tv:found', (e, x) => cb(x)),
  launchSteam: appid => call('launch:steam', { appid }),
  launchPc: id => call('launch:pc', { id }), // (beta.4) Epic, Quiver and hand-added games, by id
  findQuiver: () => call('pc:findQuiver'),
  pcStatus: () => call('pc:status'),
  // (beta.5) a PC game's cover picker
  pcCoverOptions: (id, term) => call('pccover:options', { id, term }),
  pcCoverUse: (id, key) => call('pccover:use', { id, key }),
  steamExit: () => call('steam:exit'), // (beta.12) closes Steam (it lets go of a controller it took over)
  rocketFind: () => call('rocket:find'), // (beta.12, Windows) RocketLauncher
  rocketSystems: exe => call('rocket:systems', { exe }),
  // (beta.12) RomM
  rommStatus: () => call('romm:status'), rommPairStart: () => call('romm:pairStart'), rommPairPoll: () => call('romm:pairPoll'),
  rommPairCancel: () => call('romm:pairCancel'), rommPairCode: code => call('romm:pairCode', { code }), rommTest: () => call('romm:test'),
  rommSync: () => call('romm:sync'), rommForget: () => call('romm:forget'), rommCancel: () => call('romm:cancel'),
  pcCoverOwn: id => call('pccover:own', { id }),
  pcCoverReset: id => call('pccover:reset', { id }),
  pcCoverMissing: () => call('pccover:missing'), // (beta.9) custom games with no cover chosen yet
  renameGame: o => call('game:rename', o), // (beta.5) { systemId, file } or { id }, and title ('' = back to the file's name)
  themes: () => call('themes:list'),
  setTheme: (systemId, kind, file) => call('themes:set', { systemId, kind, file }),
  removeTheme: (systemId, kind) => call('themes:remove', { systemId, kind }),
  // Customize → Find a logo: { ok, list:[{ key, source, label, licence, by, preview }], offline }
  findLogos: systemId => call('themes:findLogos', { systemId: String(systemId || '') }),
  useLogo: (systemId, key) => call('themes:useLogo', { systemId: String(systemId || ''), key: String(key || '') }),
  restoreLogo: systemId => call('themes:restoreLogo', { systemId: String(systemId || '') }),
  saveConsoleFit: (systemId, patch) => call('themes:fit', { systemId, patch }),
  library: () => call('library:list'),
  libraryCover: (id, side) => call('library:cover', { id, side }),
  libraryPages: id => call('library:pages', { id }),
  openLibraryFolder: kind => call('library:open', { kind }),
  archiveSearch: (text, kind, page, plain) => call('archive:search', { text, kind, page, plain }),
  archiveCheck: ids => call('archive:check', { ids }),
  archiveDownload: (id, kind, title, series) => call('archive:download', { id, kind, title, series }),
  onArchiveProgress: fn => ipcRenderer.on('archive:progress', (e, p) => fn(p)),
  archiveCancel: id => call('archive:cancel', { id }),
  readingWhere: () => call('reading:where'),
  readingOld: () => call('reading:old'),
  readingImport: root => call('reading:import', { root }),
  readingImportStop: () => call('reading:importStop'),
  onReadingImport: fn => ipcRenderer.on('reading:import', (e, p) => fn(p)),
  openThemeFolder: systemId => call('themes:open', { systemId }),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  checkPaths: list => call('fs:check', list),
  downloadCovers: (systemIds, types, hd) => call('covers:download', { systemIds, types, hd }),
  cancelCovers: o => call('covers:cancel', o && o.auto ? { auto: true } : undefined), // (beta.10) { auto: true }: only the background run (the shelf's art card)
  pauseCovers: () => call('covers:pause'), resumeCovers: () => call('covers:resume'), // (beta.10) the background run: { ok } (false: nothing running)
  onGpuBack: fn => ipcRenderer.on('gpu:back', () => fn()), // (beta.10) the graphics process came back after it went away
  manualCoverage: () => call('manuals:coverage'),
  artCoverage: () => call('covers:coverage'),
  onCoversProgress: fn => ipcRenderer.on('covers:progress', (e, info) => fn(info)),
  onCoversAuto: fn => ipcRenderer.on('covers:auto', (e, info) => fn(info)), // the background art check (first-run Done screen)
  onLibraryChanged: fn => ipcRenderer.on('library:changed', (e, info) => fn(info)),
  onShelfMenu: fn => ipcRenderer.on('shelf:menu', (e, d) => fn(d)),
  openShelfMenu: () => ipcRenderer.send('shelf:openMenu'),
  onShelfMenuRequest: fn => ipcRenderer.on('shelf:menuRequest', () => fn()),
  shelfMenuKey: (key, down) => ipcRenderer.send('shelf:menuKey', { key: String(key), down: !!down }),
  shelfInfo: info => ipcRenderer.send('shelf:info', info),
  // Phone companion (Settings → Phone companion; main/companion.js): its state for Settings, and the phone's input / Play for the shelf
  companionState: () => call('companion:state'),
  companionSet: o => call('companion:set', o),
  companionForget: id => call('companion:forget', { id }),
  companionPin: () => call('companion:pin'),
  onCompanionState: fn => ipcRenderer.on('companion:state', (e, s) => fn(s)),
  onCompanionInput: fn => ipcRenderer.on('companion:input', (e, m) => fn(m)),
  findManuals: systemIds => call('manuals:find', { systemIds }),
  cancelManuals: () => call('manuals:cancel'),
  recentManuals: () => call('manuals:recent'),
  getAutostart: () => call('autostart:get'),
  setAutostart: enabled => call('autostart:set', { enabled }),
  openAppFolder: () => call('app:openFolder'),
  songs: () => call('songs:list'),
  songRead: file => call('songs:read', { file }),
  openSongsFolder: () => call('songs:open'),
  raProgress: (systemId, title, force) => call('ra:progress', { systemId, title, force }),
  raShelf: (systemId, titles) => call('ra:shelf', { systemId, titles }),
  raProfile: () => call('ra:profile'),
  raEnabled: () => call('ra:enabled'),
  findModel: (systemId, name, site) => call('models:find', { systemId, name, site }),
  onModelInstalled: fn => ipcRenderer.on('models:installed', (e, r) => fn(r)),
  history: () => call('history:get'),
  historyTouch: id => call('history:touch', { id }),
  openTrailer: url => call('trailer:open', { url }),
  // (beta.7) video previews
  // (beta.7) Add games
  scanGameFolder: (root) => call('games:scanFolder', { root }), gameTitles: (exes) => call('games:titleFor', { exes }), gameCovers: (items) => call('games:covers', { items }),
  playniteFind: (dir) => call('playnite:find', { dir }), emulatorIn: (dir, systemId) => call('games:emuIn', { dir, systemId }), playnitePlan: (dir) => call('playnite:plan', { dir }),
  previewFind: (o) => call('preview:find', o || {}), previewWarm: (list) => call('preview:warm', Array.isArray(list) ? list : []),previewYt: (id, rect, muted) => call('preview:yt', { id, rect, muted }), previewYtMove: (rect, show) => call('preview:ytMove', { rect, show }),
  previewYtStop: () => call('preview:ytStop'), previewClipAudio: url => call('preview:clipAudio', { url: String(url || '') }), /* (beta.12) a clip's sound for Details' box */ previewCount: () => call('preview:count'), previewClearSteam: () => call('preview:clearSteam'),
  onPreviewYt: (fn) => { const h = (_e, d) => fn(d); ipcRenderer.on('preview:yt', h); return () => ipcRenderer.removeListener('preview:yt', h); },
  // (beta.8) console trailers: a clip became ready; the helper's status, download and progress; clearing the clips
  onPreviewClip: (fn) => { const h = (_e, d) => fn(d); ipcRenderer.on('preview:clip', h); return () => ipcRenderer.removeListener('preview:clip', h); },
  // (beta.12, Linux Game Mode) Boxshelf's own file / folder browser instead of the desktop's dialog (renderer/picker.js)
  onPickOpen: (fn) => { const h = (_e, d) => fn(d); ipcRenderer.on('pick:open', h); return () => ipcRenderer.removeListener('pick:open', h); },
  pickDone: (id, p) => ipcRenderer.send('pick:done', { id: +id || 0, path: p ? String(p) : '' }),
  fsList: (dir, o) => call('fs:list', { dir: String(dir || ''), folder: !!(o && o.folder), exts: o && Array.isArray(o.exts) ? o.exts.map(String).slice(0, 40) : [] }), fsPlaces: () => call('fs:places'),
  onNotice: (fn) => { const h = (_e, d) => fn(String(d || '')); ipcRenderer.on('app:notice', h); return () => ipcRenderer.removeListener('app:notice', h); }, /* (beta.12) a message from main for the screen (Linux: Power refused) */
  // (beta.8) Steam Deck: where Boxshelf runs ({ deck, steam, gameMode, canAdd, inSteam }) and Add Boxshelf to Steam
  deckInfo: () => call('deck:info'), addToSteam: (closeSteam) => call('deck:addToSteam', { closeSteam: !!closeSteam }),
  clipStatus: () => call('ytclip:status'), clipHelper: () => call('ytclip:helper'), clipClear: () => call('ytclip:clear'),
  onClipProgress: (fn) => { const h = (_e, d) => fn(d); ipcRenderer.on('ytclip:progress', h); return () => ipcRenderer.removeListener('ytclip:progress', h); },
  onRaUnlocks: fn => ipcRenderer.on('ra:unlocks', (e, list) => fn(list)),
  downloadManuals: choices => call('manuals:download', { choices }),
  saveOptimizedModel: (systemId, kind, bytes) => call('models:saveOptimized', { systemId, kind, bytes }),
  rejectManual: (systemId, file) => call('manuals:reject', { systemId, file }),
  onManualTurn: fn => ipcRenderer.on('manuals:turn', (e, d) => fn(d)), // (beta.9) Wrong game / Repair: { wait } then { go }
  checkManuals: () => call('manuals:check'), // (beta.9) Settings → Get manuals → Check my manuals
  cancelCheckManuals: () => call('manuals:checkCancel'),
  onManualCheck: fn => ipcRenderer.on('manuals:check', (e, d) => fn(d)), // { stage, done, total, checked, moved }
  findIpl: systemId => call('dolphin:ipl', { systemId }),
  openIplFolder: (systemId, region) => call('dolphin:iplFolder', { systemId, region }),
  toggleFullscreen: () => call('app:fullscreen'),
  setScreenMode: mode => call('seamless:screenMode', { mode: String(mode || '') }), // (beta.12) Seamless play: 'full' | 'window'
  watchCancel: () => call('seamless:cancel'), // (beta.12) B before a watched Steam / store game showed up: { cancelled }
  onWatchGaveUp: fn => ipcRenderer.on('run:watchGaveUp', () => fn()), // (beta.12) it never showed up: the old "Running through" note
  winMode: mode => call('app:winMode', { mode: String(mode || '') }), // the smoothness test: 'full' | 'max' | 'half'
  quit: why => call('app:quit', { why: typeof why === 'string' ? why : '' }),
  power: kind => call('app:power', kind),
  onUiScale: fn => ipcRenderer.on('ui:scale', (e, d) => fn(d)),
  chooseArt: id => call('art:choose', { id }),
  gameEmulator: id => call('game:emulator', { id }),
  gameStatus: (id, status) => call('game:status', { id, status }), // (beta.12) Details → Your play → Status
  onWiimote: fn => ipcRenderer.on('wiimote', (e, d) => fn(d)), // the Wii remote: { x, y, seen, b, hold } / { on }
  wmRumble: ms => ipcRenderer.send('wm:rumble', ms),
  padsPresent: (force) => call('pads:present', force === true), // the real controllers plugged in: [{ vendor, product, style }]
  onExited: fn => ipcRenderer.on('run:exited', (e, info) => fn(info)),
  onRunReady: fn => ipcRenderer.on('run:ready', () => fn()),
  onRunQuitting: fn => ipcRenderer.on('run:quitting', () => fn()),
  onRunAside: fn => ipcRenderer.on('run:aside', (e, on) => fn(!!on)),
  // Settings (1.55)
  listDisplays: () => call('display:list'),
  moveToDisplay: id => call('display:move', { id: String(id == null ? '' : id) }),
  backupSettings: () => call('settings:backup'),
  restoreSettings: () => call('settings:restore'),
  reportProblem: () => call('app:reportProblem'),
  clearHistory: () => call('history:clear'),
  onHistoryChanged: fn => ipcRenderer.on('history:changed', (e, info) => fn(info)),
  apiStatus: () => call('api:status'),
  testApi: service => call('api:test', { service: String(service || '') }),
  clipboardText: () => call('clipboard:text'), // (beta.9) setup's Paste buttons
  repairManual: (systemId, file) => call('manuals:repair', { systemId: String(systemId || ''), file: String(file || '') }), // (beta.9) the reader's Repair
  raEmulators: () => call('ra:emulators'),
  onApiStatus: fn => ipcRenderer.on('api:status', (e, st) => fn(st)),
  // Art Studio (1.67): every call takes one object; a game is { systemId, file }. The on… ones return an unsubscribe.
  artStudio: () => call('art:studio'),
  artGames: o => call('art:games', o),
  artStyle: o => call('art:style', o),
  artCandidates: o => call('art:cands', o),
  artUse: o => call('art:use', o),
  artMix: o => call('art:mix', o),
  artUndo: o => call('art:undo', o),
  artSets: o => call('art:sets', o), // { systemId, file } → { sets }
  artUseSet: o => call('art:useSet', o), // { systemId, file, setId } → { art, lock, changed }
  artUndoSet: o => call('art:undoSet', o), // { systemId, file } → { art, lock }
  artCancel: o => call('art:cancel', o),
  artBuildIndex: () => call('art:index'),
  artRefreshIndex: () => call('art:refreshIndex'), // Refresh art database (1.71) → { at, bytes, state }; throws "cancelled" after artRefreshCancel
  artRefreshCancel: () => call('art:refreshCancel'),
  artIndexInfo: () => call('art:indexInfo'), // { state, at, bytes }
  onArtIndex: fn => { const h = (e, d) => fn(d); ipcRenderer.on('art:indexProgress', h); return () => ipcRenderer.removeListener('art:indexProgress', h); },
  artLock: o => call('art:lock', o), // { systemId, file, lock } → { frozen, lock, art, repick, jobId }
  artOwn: o => call('art:own', o), // { systemId, file, part, cut? } → { art, lock } or { canceled }
  artRelease: o => call('art:release', o), // { systemId } → { released, jobId }
  onArtCand: fn => { const h = (e, d) => fn(d); ipcRenderer.on('art:cand', h); return () => ipcRenderer.removeListener('art:cand', h); },
  // Manual Studio: { systemId, file, … } objects; candidates and job progress arrive as events
  manualStudio: () => call('manual:studio'),
  manualGames: o => call('manual:games', o),
  manualCands: o => call('manual:cands', o),
  manualUse: o => call('manual:use', o),
  manualUndo: o => call('manual:undo', o),
  manualLock: o => call('manual:lock', o),
  manualOwn: o => call('manual:own', o),
  manualPref: o => call('manual:pref', o),
  manualCancel: o => call('manual:cancel', o),
  onManualCand: fn => { const h = (e, d) => fn(d); ipcRenderer.on('manual:cand', h); return () => ipcRenderer.removeListener('manual:cand', h); },
  onManualJob: fn => { const h = (e, d) => fn(d); ipcRenderer.on('manual:job', h); return () => ipcRenderer.removeListener('manual:job', h); },
  onArtJob: fn => { const h = (e, d) => fn(d); ipcRenderer.on('art:job', h); return () => ipcRenderer.removeListener('art:job', h); },
});
