// Fasst src/ zu drei Dateien zum Kopieren zusammen:  node apps-script/dev/bundle.js
//   bundle/Code.gs          alle .gs-Dateien
//   bundle/Index.html       Oberfläche mit eingebettetem CSS und Skripten
//   bundle/appsscript.json  Manifest (Berechtigungen, Zeitzone, Web-App)
'use strict';

const fs = require('fs');
const path = require('path');
const { SRC } = require('./runtime');

const OUT = path.join(__dirname, '..', 'bundle');
fs.mkdirSync(OUT, { recursive: true });

const ORDER = ['Code', 'Config', 'Util', 'Adapters', 'Vertex', 'Services', 'Container', 'TicketFlow', 'Views', 'Api', 'MockData'];
const gs = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).map((f) => f.slice(0, -3));
const missing = gs.filter((n) => ORDER.indexOf(n) < 0);
if (missing.length) throw new Error('In ORDER fehlen: ' + missing.join(', '));

const header = '// Automatisch erzeugt aus apps-script/src (node apps-script/dev/bundle.js). Nicht von Hand ändern,\n' +
  '// sondern die Dateien in src/ bearbeiten und neu bündeln.\n';
const code = header + ORDER.map((n) => '\n// ======================================================= ' + n + '.gs\n\n' +
  fs.readFileSync(path.join(SRC, n + '.gs'), 'utf8')).join('');
fs.writeFileSync(path.join(OUT, 'Code.gs'), code);

const read = (name) => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
const index = read('Index').replace(/<\?!=\s*include\('(\w+)'\)\s*\?>/g, (m, name) => read(name).trim());
fs.writeFileSync(path.join(OUT, 'Index.html'), index);
fs.copyFileSync(path.join(SRC, 'appsscript.json'), path.join(OUT, 'appsscript.json'));
console.log('bundle/Code.gs ' + code.length + ' Zeichen, bundle/Index.html ' + index.length + ' Zeichen');
