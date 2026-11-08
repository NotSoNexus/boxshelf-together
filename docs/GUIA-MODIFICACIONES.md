# Guía de modificaciones (copia local)

Este repo es una copia de **Boxshelf 1.82.0-beta.10** (`sassiestrhihno/boxshelf-source`, GPL-3.0) preparada para
tocar el código. Está en la rama **`mi-version`**, partiendo del tag `v1.82.0-beta.10`.

> Todo lo que he añadido está marcado con `[AÑADIDO]` en los comentarios: busca ese texto para encontrar (o quitar)
> los cambios de ejemplo.

---

## 1. Arrancar

| Cómo | Qué hace |
|---|---|
| `Mi Boxshelf.bat` | Usa el Node portable de `.tools\node` y arranca a pantalla completa |
| `Mi Boxshelf.bat ventana` | Lo mismo, en una ventana (mejor para depurar) |
| `Start Boxshelf.bat` | El original: necesita Node en el `PATH` del sistema |
| `node scripts/check-mods.js` | Comprobación rápida de que las tablas están coherentes |

`node_modules` ya está instalado (Electron incluido). Si algo se rompe: borra `node_modules` y vuelve a lanzar el `.bat`.

> **Aviso con npm 11+**: por defecto no ejecuta los scripts de instalación, así que Electron se queda sin su
> `electron.exe`. Si tras reinstalar Boxshelf no arranca, ejecuta una vez:
>
> ```powershell
> npm install-scripts approve electron
> node node_modules\electron\install.js
> ```

Consola de depuración: en la ventana de Boxshelf, `Ctrl+Shift+I` abre DevTools. Los errores del proceso principal
salen en la ventana de la consola y en `data\boxshelf.log`.

---

## 2. Mapa del código

```
main.js                  proceso principal de Electron: IPC (handle(...)), arranque, ventanas
preload.js               puente window.boxshelf (la API que usa la interfaz, ver docs/PLATFORM-API.md)
main/                    lógica del sistema: detección, escaneo, carátulas, lanzadores, ajustes
renderer/                interfaz (HTML/CSS/JS + 3D). Nunca toca el sistema operativo
shared/titles.js         limpieza de nombres de juego
android-app/             versión Android (Capacitor), con su propio android-systems.js
docs/                    notas del autor: NEW-CONSOLES-PLAN.md, PLATFORM-API.md, LINUX-PLAN.md…
themes/                  (no viene en el repo) logos, vídeos de arranque y modelos por consola
```

Regla de oro: **el renderer habla solo con `window.boxshelf`**. Si necesitas algo nuevo del sistema, se añade un
`handle('loquesea', …)` en `main.js`, se expone en `preload.js` y se usa desde `renderer/`.

---

## 3. Añadir una consola (Windows)

Los estantes salen del array `CONSOLES` de `main/systems.js`; casi todo lo demás se deriva de él. Pero para que la
consola quede **completa** (carátulas, manuales, anuncios, modelo 3D, caja en el estante) hay que tocar estas tablas:

| # | Archivo | Qué añadir |
|---|---|---|
| 1 | `main/systems.js` | Una fila en `retro([...])` (consolas con RetroArch) o un objeto en `CONSOLES` (consolas modernas) |
| 2 | `main/covers.js` | `LIBRETRO` (nombre de carpeta en thumbnails.libretro.com) y `LAUNCHBOX` |
| 3 | `main/screenscraper.js` | `SYS` (número de consola) y, si es cartucho, el `Set CART` |
| 4 | `main/manuals.js` | `SYSTEM_WORDS`, el mapa de expresiones regulares y `GDB_SYSTEM` (gamesdatabase.org) |
| 5 | `main/commercials.js` | `CONSOLE`: nombres con los que buscar tráilers |
| 6 | `main/modelfind.js` | `QUERY`: búsqueda del modelo 3D del museo |
| 7 | `main/themes.js` | `MEDIA_NAME`: `cart`, `disc` o `umd` |
| 8 | `main/racores.js` | `BIOS`, **solo si la consola necesita BIOS** |
| 9 | `main/addgames.js` | `SPEC` / `BY_NAME`, solo para importar desde Playnite |
| 10 | `renderer/systems-extra.js` | `style` (forma y colores de la caja), `wordmarks` y `media` |
| 11 | `renderer/style.css` | Una clase `.wm-<id>` con el degradado del rótulo |
| 12 | `renderer/setup.js` | `OFFICIAL`: enlace de descarga que ofrece el asistente |

Para **Android** hay un juego aparte de tablas en `android-app/web-extras/`: `android-systems.js`,
`android-api.js`, `android-ra.js` y `android-reading.js`.

### Ejemplo ya aplicado: Neo Geo Pocket Color (`ngpc`)

Está hecho en los 12 sitios, con RetroArch y el core `mednafen_ngp` (no necesita BIOS). Búscalo así:

```powershell
Select-String -Path main\*.js,renderer\*.js,renderer\*.css -Pattern "ngpc|AÑADIDO"
```

- **Quitarlo**: borra la fila `['ngpc', …]` de `main/systems.js` y las entradas `ngpc:` del resto. Nada más depende
  de él, así que no rompe nada.
- **Duplicarlo** para otra consola: copia la fila y cambia `id`, `name`, carpetas, extensiones y `raCore`. La lista de
  cores de RetroArch está en `main/racores.js` y en `docs/NEW-CONSOLES-PLAN.md`.

### Cómo probarlo

1. Pon las ROMs en `ROMS\Neo Geo Pocket Color\` (o en la carpeta que elijas).
2. Settings → el estante nuevo → activar y elegir carpeta.
3. `node scripts/check-mods.js` avisa si se te ha olvidado una tabla.

---

## 4. Añadir un programa (app de escritorio, no un juego)

`main/systems.js`, array `APPS`: id, nombre, `exeNames` y carpetas donde buscarlo. Aparece en la fila de apps de la
pantalla de inicio y se lanza con `launchApp`. En el asistente de primer arranque sale desde `renderer/setup.js`
(`OFFICIAL`). Para Android, `launchApp` funciona por nombre de paquete.

Para juegos de PC sueltos (no de Steam/Epic) está *Settings → Custom games*; su lógica vive en `main/pcgames.js`.

---

## 5. Cambiar el aspecto de las cajas

Todo en `renderer/systems-extra.js`:

```js
ngpc: S('ngpc', { ...cardboard, hue: 265, ratio: 0.83, depth: 0.2,
  caseColor: '#e9e6f4', caseSide: '#c9c4dc', spineInk: '#2b2340',
  band:      { bg: '#2b2340', fg: '#ffd24a', label: 'NEO GEO POCKET' },   // franja de la portada
  spineBand: { bg: '#2b2340', fg: '#ffd24a', label: 'NGPC' },             // lomo
  tint: ['#3a2a6b', '#0d0820'], glow: '#c9b3ff' })
```

- `ratio` = ancho / alto de la caja real · `depth` = grosor / ancho
- Plantillas: `cardboard` (caja de cartón), `jewel` (estuche de CD), `clam` (carcasa Sega)
- `media`: `{ kind: 'cart' | 'disc' | 'umd', size, drive: 'slot' | 'top' }`

Los modelos y logos por consola van en `themes\<sistema>\` (`logo.png`, `boot.mp4`, `console.glb`, `disc.glb`…). Esa
carpeta **no** está en el repo: la creas tú.

---

## 6. Actualizar a la siguiente beta

El repo del autor es un *snapshot* por versión, así que cada beta es un commit nuevo. Para traerla:

```powershell
git fetch --unshallow      # una sola vez: el clon es superficial
git fetch --tags
git log --oneline --all --decorate -5
git merge v1.82.0-beta.11  # o el tag que salga
```

Los conflictos aparecerán casi seguro en `main/systems.js` y `renderer/systems-extra.js` (son líneas largas con
muchas entradas). Resuélvelos conservando tus filas.

---

## 7. ScreenScraper (carátulas traseras, lomos y discos)

**Dónde**: Settings (⚙) → **Accounts & services** → **ScreenScraper**. También en el asistente de primer arranque,
página *Accounts* (esa solo pide usuario y contraseña).

**Por qué no funciona solo con tu cuenta**: ScreenScraper exige que **cada aplicación** tenga su propio login de
desarrollador (`devid` / `devpassword`) en cada llamada. Boxshelf lo tiene solicitado pero aún no concedido, así que
el botón *Test* responde **"Not available yet"**. La beta.10 cambió el mensaje justo por esto.

**Cómo hacerlo funcionar hoy**:

1. Crea una cuenta gratuita en <https://www.screenscraper.fr/membreinscription.php>.
2. Pide acceso de desarrollador en su foro: <https://www.screenscraper.fr/forumsujets.php?frub=12&numpage=0>
   (Settings tiene el botón *Ask for developer access* que abre justo esa página).
3. En Settings → ScreenScraper rellena **Developer ID** y **Developer password** con lo que te den, además de tu
   usuario y contraseña.
4. Pulsa **Test**: debe decir *Working · N look-ups left today*.

Alternativa sin tocar la interfaz: crea `main/ss-dev.json` con `{ "devId": "…", "devPass": "…" }`. Ese archivo gana
solo si no has escrito un Developer ID en Settings. Ya está en `.gitignore`, así que no se sube por accidente.

**Qué aporta**: caras traseras, lomos, envoltorios completos y arte de disco/cartucho por región, dentro del
**Art Studio** (`main/screenscraper.js` + `main/artstudio.js`). Las carátulas frontales salen sin cuenta de libretro,
LaunchBox y SteamGridDB.

**Límites**: la cuenta gratuita tiene un número de consultas al día (una donación lo sube). Al agotarlo, Boxshelf
pausa hasta el día siguiente (UTC). Las credenciales se guardan cifradas (DPAPI) en `data\config.json` y nunca
aparecen en `boxshelf.log`.

---

## 8. Licencia y distribución

- **GPL-3.0**: puedes usar, estudiar, modificar y redistribuir. Si distribuyes un binario modificado, tienes que
  publicar el código fuente con la misma licencia y mantener los avisos de copyright.
- Uso personal: no hay ninguna obligación de publicar nada.
- La GPL **no** concede derechos sobre la marca: si publicas un fork, cámbiale el nombre.
- Faltan a propósito en el repo el modelo 3D del PC del museo y todos los assets con copyright (BIOS, ROMs,
  carátulas). Boxshelf los descarga en tiempo de ejecución.
