// Fasst src/ zu drei Dateien zum Kopieren zusammen:  node apps-script/dev/bundle.js [--out ORDNER] [--app-name NAME]
//   --out       Zielordner (Standard: bundle/)
//   --app-name  anderer Standardname der App (statt ReqAlign), z. B. für eine interne Auslieferung.
//               Im Repo bleibt der neutrale Name; die Skripteigenschaft APP_NAME geht ohnehin vor.
//   bundle/Code.gs          alle .gs-Dateien
//   bundle/Index.html       Oberfläche mit eingebettetem CSS und Skripten
//   bundle/appsscript.json  Manifest (Berechtigungen, Zeitzone, Web-App)
'use strict';

const fs = require('fs');
const path = require('path');
const { SRC } = require('./runtime');

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const OUT = path.resolve(arg('out') || path.join(__dirname, '..', 'bundle'));
const APP_NAME = arg('app-name');
if (APP_NAME !== undefined && !/^[\p{L}\p{N} ._-]{1,40}$/u.test(APP_NAME)) throw new Error('--app-name: nur Buchstaben, Ziffern, Leerzeichen, . _ -');
const named = (text) => (APP_NAME ? text.replace(/'ReqAlign'/g, JSON.stringify(APP_NAME).replace(/^"|"$/g, "'")) : text);
fs.mkdirSync(OUT, { recursive: true });

const ORDER = ['Code', 'Config', 'Util', 'Adapters', 'Vertex', 'Services', 'Container', 'TicketFlow', 'Views', 'Api', 'MockData'];
const gs = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).map((f) => f.slice(0, -3));
const missing = gs.filter((n) => ORDER.indexOf(n) < 0);
if (missing.length) throw new Error('In ORDER fehlen: ' + missing.join(', '));

const header = '// Automatisch erzeugt aus apps-script/src (node apps-script/dev/bundle.js). Nicht von Hand ändern,\n' +
  '// sondern die Dateien in src/ bearbeiten und neu bündeln.\n';
const code = header + ORDER.map((n) => '\n// ======================================================= ' + n + '.gs\n\n' +
  fs.readFileSync(path.join(SRC, n + '.gs'), 'utf8')).join('');
fs.writeFileSync(path.join(OUT, 'Code.gs'), named(code));

const read = (name) => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
const index = read('Index').replace(/<\?!=\s*include\('(\w+)'\)\s*\?>/g, (m, name) => read(name).trim());
fs.writeFileSync(path.join(OUT, 'Index.html'), index);
fs.copyFileSync(path.join(SRC, 'appsscript.json'), path.join(OUT, 'appsscript.json'));
console.log(OUT + (APP_NAME ? ' (Name ' + APP_NAME + ')' : '') + ': Code.gs ' + code.length + ' Zeichen, Index.html ' + index.length + ' Zeichen');
