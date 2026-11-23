// Budgets für Ladezeit und Größe:  node apps-script/dev/budget.js
// Prüft gegen dev/budgets.json: Größe der ausgelieferten Seite (bundle/Index.html, roh und gzip), größte Antwort
// einer Seite und geschätzte Laufzeit mit warmem Cache (2.000 Tickets, Modell wie in load.js).
// Die Werte in budgets.json sind eine Ratsche: sie dürfen nur sinken (Guard vergleicht mit dem letzten Commit).
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { serviceTimes } = require('./load');
const { createRuntime } = require('./runtime');
const { makeSystems, LIVE } = require('./stress');

const B = JSON.parse(fs.readFileSync(path.join(__dirname, 'budgets.json'), 'utf8'));
const html = fs.readFileSync(path.join(__dirname, '..', 'bundle', 'Index.html'));
const gz = zlib.gzipSync(html, { level: 9 }).length;
const problems = [];
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const line = (name, value, limit, fmt) => {
  const ok = value <= limit;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(44)} ${fmt(value).padStart(10)}  (Grenze ${fmt(limit)}, ${Math.round((100 * value) / limit)} %)`);
  if (!ok) problems.push(name);
};

line('Seite roh (HTML+CSS+JS)', html.length, B.page.raw_bytes, kb);
line('Seite gzip', gz, B.page.gzip_bytes, kb);

const log = [];
const sys = makeSystems(2000, log);
const rt = createRuntime({ scriptProperties: LIVE, fetch: sys.fetch, email: 'chris@firma.de' });
const GETS = ['/', '/tickets', '/meine-tickets', '/streams', '/ticket', '/bugs/' + sys.firstBug, '/dokumente', '/releases', '/admin'];
let biggest = { bytes: 0 };
GETS.forEach((p) => { const bytes = Buffer.byteLength(rt.apiRequest('GET', p, {})); if (bytes > biggest.bytes) biggest = { bytes, p }; });
line('größte Antwort (' + biggest.p + ')', biggest.bytes, B.response.max_bytes, kb);

const slowest = serviceTimes().reduce((a, x) => (x.warm > a.warm ? x : a), { warm: 0 });
line('langsamster Aufruf mit Cache (' + slowest.label + ')', slowest.warm, B.response.warm_exec_ms, (ms) => Math.round(ms) + ' ms');

console.log(problems.length ? `\n${problems.length} Budgets gerissen` : '\nAlle Budgets eingehalten');
process.exitCode = problems.length ? 1 : 0;
