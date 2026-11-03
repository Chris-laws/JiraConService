// Lastsimulation mit den echten Grenzen von Apps Script:  node apps-script/dev/load.js [--quick]
//
// Die Web-App läuft als die Person, die sie bereitstellt (executeAs USER_DEPLOYING). Damit teilen sich alle Nutzer
// deren Kontingent: höchstens 30 gleichzeitige Ausführungen. Der 31. Aufruf scheitert sofort; der Browser wiederholt
// GET bis zu zweimal mit wachsender, zufälliger Wartezeit (wie in JsApp.html), POST nie.
//
// 1. Dienstzeit je Seite messen: derselbe Code wie in Apps Script, 2.000 Jira-Tickets über die Live-Adapter
//    (nachgebildete Antworten). Laufzeitmodell je Aufruf (Zahlen in budgets.json, "model"):
//    Start der Ausführung + Rechenzeit × Faktor (Apps Script rechnet langsamer als Node) + je HTTP-Aufruf eine
//    Wartezeit (Jira & Co. 400 ms, Vertex 700 ms) + je Cache-Zugriff 15 ms. Im Browser kommt google.script.run dazu.
//    Kalt (Cache leer) zählt höchstens einmal je 5 Minuten und Cache-Schlüssel, persönliche Listen je Person.
// 2. Ereignis-Simulation einer Spitzenstunde mit 100/300/500/1.000 aktiven Personen. Jede Person öffnet im Mittel
//    alle 30 s eine Seite (Poisson), dazu Vorladen beim Zeigen auf Links. Ergebnis: Antwortzeit p50/p95, Anteil der
//    Aufrufe, die erst nach Wiederholung oder gar nicht durchkommen, höchste Gleichzeitigkeit.
// 3. Gegenprobe mit Erlang-B (Blockierwahrscheinlichkeit ohne Wiederholung) für dieselbe Last.
//
// Grenzwerte (Ratsche, nur nach unten) stehen in budgets.json unter "load"; dev/checks/appscript.py prüft sie im Guard.
'use strict';

const fs = require('fs');
const path = require('path');
const { createRuntime } = require('./runtime');
const { makeSystems, LIVE } = require('./stress');

const QUICK = process.argv.includes('--quick');
const BUDGETS = JSON.parse(fs.readFileSync(path.join(__dirname, 'budgets.json'), 'utf8'));
const M = BUDGETS.model;
const CACHE_SECONDS = 300;

// Seitenmix einer Spitzenstunde (Anteil der Seitenaufrufe). Persönlich = Liste je Person im Cache.
const MIX = [
  { route: ['GET', '/', {}], share: 0.24, personal: true },
  { route: ['GET', '/tickets', {}], share: 0.14 },
  { route: ['GET', '/tickets', { q: ['Bestellvorschlag Feiertag'] }], share: 0.08 },
  { route: ['GET', '/meine-tickets', {}], share: 0.15, personal: true },
  { route: ['GET', '/streams', {}], share: 0.08 },
  { route: ['GET', '/ticket', {}], share: 0.07 },
  { route: ['POST', '/ticket', { text: ['Der Bestellvorschlag soll Feiertage je Land berücksichtigen, damit die Filiale nicht zu viel bestellt.'] }], share: 0.05 },
  { route: ['GET', '/wissen', { frage: ['Wie funktioniert der Bestellvorschlag an Feiertagen?'] }], share: 0.05 },
  { route: ['GET', '/bugs/BUG', {}], share: 0.07 },
  { route: ['POST', '/bugs/BUG/erklaerung', {}], share: 0.02 },
  { route: ['GET', '/admin', {}], share: 0.05 },
];
const VIEW_EVERY_S = 30;
const PREFETCH_PER_VIEW = 0.15; // Vorladen: höchstens eins gleichzeitig, nur nach 80 ms Zeigen, nicht bei frischem Stand

// ---------------------------------------------------------------- 1. Dienstzeiten messen

function execMs(rt, log, method, p, params) {
  const before = log.length;
  const t0 = process.hrtime.bigint();
  const out = JSON.parse(rt.apiRequest(method, p, Object.assign({ _perf: ['1'] }, params)));
  const cpu = Number(process.hrtime.bigint() - t0) / 1e6;
  const calls = log.slice(before);
  const waits = (list) => list.filter((c) => !c.batch).length + new Set(list.filter((c) => c.batch).map((c) => c.batch)).size;
  const perf = out.perf || { cacheHits: 0, cacheMisses: 0, bytes: 0 };
  const cacheOps = 2 * (perf.cacheHits + perf.cacheMisses) + 2;
  if (out.fatal) throw new Error(method + ' ' + p + ': ' + out.fatal);
  return M.exec_start_ms + cpu * M.cpu_factor + waits(calls.filter((c) => !c.vertex)) * M.system_ms +
    waits(calls.filter((c) => c.vertex)) * M.vertex_ms + cacheOps * M.cache_ms;
}

function serviceTimes() {
  const log = [];
  const sys = makeSystems(2000, log);
  const rt = createRuntime({ scriptProperties: LIVE, fetch: sys.fetch, email: 'chris@firma.de' });
  const rt2 = createRuntime({ scriptProperties: LIVE, fetch: sys.fetch, email: 'person1@firma.de', cache: rt.__cache });
  const fix = (p) => p.replace('BUG', sys.firstBug);
  return MIX.map((m) => {
    const [method, p, params] = m.route;
    const cold = execMs(rt, log, method, fix(p), params);
    const warm = Math.min(execMs(rt, log, method, fix(p), params), execMs(rt, log, method, fix(p), params));
    const userCold = m.personal ? execMs(rt2, log, method, fix(p), params) : warm; // andere Person, geteilte Listen warm
    return Object.assign({}, m, { cold, warm, userCold, label: method + ' ' + p + (params.q ? '?q' : '') });
  });
}

// ---------------------------------------------------------------- 2. Ereignis-Simulation

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function simulate(users, routes, seconds, seed) {
  const r = rng(seed);
  const expo = (mean) => -Math.log(1 - r()) * mean;
  const jitter = () => Math.exp((r() - 0.5) * 0.6); // ±30 % um den Messwert
  const viewRate = users / VIEW_EVERY_S;
  const rate = viewRate * (1 + PREFETCH_PER_VIEW);
  const shareSum = routes.reduce((s, x) => s + x.share, 0);
  const pickRoute = () => { let x = r() * shareSum; for (const rt of routes) { x -= rt.share; if (x <= 0) return rt; } return routes[routes.length - 1]; };

  // Kalt: einmal je 5 Minuten und Schlüssel; persönlich: wie oft eine Person die Seite in 5 Minuten öffnet.
  const pCold = (rt) => Math.min(1, 1 / Math.max(1e-9, viewRate * rt.share * CACHE_SECONDS));
  const pUserCold = (rt) => Math.min(1, 1 / Math.max(1e-9, (rt.share / VIEW_EVERY_S) * CACHE_SECONDS));
  const service = (rt) => {
    const u = r();
    const base = u < pCold(rt) ? rt.cold : rt.personal && u < pCold(rt) + pUserCold(rt) ? rt.userCold : rt.warm;
    return base * jitter();
  };

  // Ereignisse: [Zeit, Art, Daten]; kleine Warteschlange als sortiertes Array (Binärsuche beim Einfügen).
  const events = [];
  const push = (ev) => { let lo = 0, hi = events.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid][0] < ev[0]) lo = mid + 1; else hi = mid; } events.splice(lo, 0, ev); };
  let t = 0;
  while (t < seconds * 1000) { t += expo(1000 / rate); push([t, 'arrive', { rt: pickRoute(), start: t, attempt: 0 }]); }

  let busy = 0, peak = 0, done = 0, retried = 0, failed = 0, firstRejected = 0, total = 0, busyArea = 0, lastT = 0;
  const times = [];
  while (events.length) {
    const [now, kind, req] = events.shift();
    busyArea += busy * (now - lastT); lastT = now;
    if (kind === 'finish') { busy--; done++; times.push(now - req.start + M.client_ms); continue; }
    if (req.attempt === 0) total++;
    if (busy < M.concurrent) {
      busy++; peak = Math.max(peak, busy);
      if (req.attempt > 0) retried++;
      push([now + service(req.rt), 'finish', req]);
      continue;
    }
    if (req.attempt === 0) firstRejected++;
    if (req.rt.route[0] !== 'GET' || req.attempt >= 2) { failed++; continue; }
    push([now + 500 * Math.pow(3, req.attempt) * (0.5 + r()), 'arrive', Object.assign({}, req, { attempt: req.attempt + 1 })]);
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))] || 0;
  const meanS = routes.reduce((s, rt) => s + rt.share * rt.warm, 0) / shareSum; // grob, für Erlang-B
  return { users, rate, total, done, failed, retried, firstRejected, p50: q(0.5), p95: q(0.95), peak,
    util: busyArea / lastT / M.concurrent, erlangs: rate * meanS / 1000 };
}

/** Erlang-B: Wahrscheinlichkeit, dass alle c Plätze belegt sind, bei a Erlang angebotener Last. */
function erlangB(c, a) {
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return b;
}

// ---------------------------------------------------------------- Ausgabe

const fmt = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');
const pct = (x) => (x * 100).toFixed(x < 0.01 ? 2 : 1) + ' %';

function main() {
  const routes = serviceTimes();
  console.log('Lastsimulation Apps Script: höchstens ' + M.concurrent + ' gleichzeitige Ausführungen für alle Nutzer');
  console.log('\n## Dienstzeit je Aufruf (geschätzt in Apps Script, 2.000 Tickets)');
  console.log('   Seite                          Anteil   warm      kalt');
  routes.forEach((rt) => console.log(`   ${rt.label.padEnd(30)} ${pct(rt.share).padStart(6)} ${fmt(rt.warm).padStart(8)} ${fmt(rt.cold).padStart(9)}`));

  const seconds = QUICK ? 900 : 3600;
  const steps = QUICK ? [100, 300, 1000] : [100, 300, 500, 1000];
  console.log(`\n## Spitze: jede Person öffnet alle ${VIEW_EVERY_S} s eine Seite, ${seconds / 60} Minuten simuliert`);
  console.log('   Personen  Aufrufe/s  Erlang  Erlang-B  p50      p95      wiederholt  gescheitert  höchste Gleichz.');
  const results = steps.map((n) => {
    const s = simulate(n, routes, seconds, n);
    const b = erlangB(M.concurrent, s.erlangs);
    console.log(`   ${String(n).padStart(8)}  ${s.rate.toFixed(1).padStart(9)}  ${s.erlangs.toFixed(1).padStart(6)}  ${pct(b).padStart(8)}  ` +
      `${fmt(s.p50).padStart(7)}  ${fmt(s.p95).padStart(7)}  ${pct(s.retried / s.total).padStart(10)}  ${pct(s.failed / s.total).padStart(11)}  ${String(s.peak).padStart(6)} von ${M.concurrent}`);
    return Object.assign(s, { erlangB: b });
  });

  const L = BUDGETS.load;
  const target = results.find((s) => s.users === L.users) || simulate(L.users, routes, seconds, L.users);
  const problems = [];
  if (target.p95 > L.p95_ms) problems.push(`p95 bei ${L.users} Personen ${fmt(target.p95)} > ${fmt(L.p95_ms)}`);
  if (target.failed / target.total > L.failed_max) problems.push(`gescheitert bei ${L.users} Personen ${pct(target.failed / target.total)} > ${pct(L.failed_max)}`);
  if (erlangB(M.concurrent, target.erlangs) > L.erlang_b_max) problems.push(`Erlang-B bei ${L.users} Personen ${pct(erlangB(M.concurrent, target.erlangs))} > ${pct(L.erlang_b_max)}`);
  const limit = results.find((s) => s.failed / s.total > 0.01);
  console.log('\n   Ziel (budgets.json): ' + L.users + ' Personen gleichzeitig aktiv, p95 ≤ ' + fmt(L.p95_ms) + ', gescheitert ≤ ' + pct(L.failed_max));
  if (limit) console.log('   Grenze: ab etwa ' + limit.users + ' gleichzeitig aktiven Personen scheitern über 1 % der Aufrufe (dann: zweite Bereitstellung oder executeAs USER_ACCESSING).');
  problems.forEach((p) => console.log('   FAIL ' + p));
  console.log(problems.length ? `\n${problems.length} Grenzwerte gerissen` : '\nAlle Grenzwerte eingehalten');
  process.exitCode = problems.length ? 1 : 0;
}

if (require.main === module) main();
module.exports = { simulate, erlangB, serviceTimes };
