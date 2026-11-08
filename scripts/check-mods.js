// Comprobación rápida de las modificaciones locales de Boxshelf.
//   node scripts/check-mods.js
// Revisa que main/systems.js y renderer/systems-extra.js carguen, que no haya ids repetidos y que el
// estante de ejemplo (Neo Geo Pocket Color) esté en todas las tablas donde tiene que estar.
// Añade una línea al objeto `checks` cada vez que añadas una consola nueva.
'use strict';
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const { CONSOLES, APPS } = require(path.join(root, 'main', 'systems.js'));

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok || detail == null ? '' : '  -> ' + String(detail).slice(0, 300)));
  if (!ok) fails++;
};

const ids = CONSOLES.map(c => c.id);
const dups = ids.filter((x, i) => ids.indexOf(x) !== i);
check('ids únicos en CONSOLES (' + ids.length + ' estantes)', dups.length === 0, dups.join(','));

const ngpc = CONSOLES.find(c => c.id === 'ngpc');
check('ngpc existe en main/systems.js', !!ngpc);
if (ngpc) {
  check('ngpc usa RetroArch + core mednafen_ngp', ngpc.raCore === 'mednafen_ngp', ngpc.raCore);
  check('ngpc tiene extensiones', (ngpc.extensions || []).length > 0);
}

// renderer/systems-extra.js es un IIFE de navegador: se le da un window falso
global.window = {};
require(path.join(root, 'renderer', 'systems-extra.js'));
const ex = global.window.BS_SYSTEMS_EXTRA;
check('renderer/systems-extra.js carga', !!(ex && ex.style && ex.wordmarks && ex.media));
if (ex) {
  check('ngpc tiene caja (style)', !!ex.style.ngpc);
  check('ngpc tiene cartucho (media)', !!ex.media.ngpc);
  check('ngpc tiene wordmark', !!ex.wordmarks.ngpc);
}

// Tablas de datos por consola: cada id nuevo debe aparecer también aquí
const tableChecks = {
  'main/covers.js (libretro)': /LIBRETRO[^]*?ngpc:/.test(read('main/covers.js')),
  'main/covers.js (launchbox)': /LAUNCHBOX[^]*?ngpc:/.test(read('main/covers.js')),
  'main/screenscraper.js (SYS)': /ngpc: 82/.test(read('main/screenscraper.js')),
  'main/screenscraper.js (CART)': /'wonderswan', 'ngpc'\]/.test(read('main/screenscraper.js')),
  'main/manuals.js (SYSTEM_WORDS)': /ngpc: \['neo geo pocket'/.test(read('main/manuals.js')),
  'main/manuals.js (GDB_SYSTEM)': /ngpc: 'snk-neo-geo-pocket-color'/.test(read('main/manuals.js')),
  'main/commercials.js': /ngpc: \['Neo Geo Pocket Color'/.test(read('main/commercials.js')),
  'main/modelfind.js': /ngpc: 'neo geo pocket color handheld'/.test(read('main/modelfind.js')),
  'main/themes.js (MEDIA_NAME)': /ngpc: 'cart'/.test(read('main/themes.js')),
  'main/addgames.js (SPEC)': /snk_neogeo_pocket: 'ngpc'/.test(read('main/addgames.js')),
  'renderer/style.css (.wm-ngpc)': /\.wm-ngpc\{/.test(read('renderer/style.css')),
  'renderer/setup.js (OFFICIAL)': /ngpc:\[RA\]/.test(read('renderer/setup.js')),
};
for (const [name, ok] of Object.entries(tableChecks)) check(name, ok);

console.log('\napps (APPS):', APPS.map(a => a.id).join(', '));
console.log(fails ? '\n' + fails + ' comprobación(es) fallida(s)' : '\nTodo bien');
process.exit(fails ? 1 : 0);
