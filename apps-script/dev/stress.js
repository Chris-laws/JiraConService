// Stresstest für die Apps-Script-Fassung:  node apps-script/dev/stress.js [--quick]
//
// 1. Menge: 500 bis 5.000 Jira-Tickets (plus Confluence, ServiceNow) über die Live-Adapter mit nachgebildeten
//    Antworten. Gemessen werden Rechenzeit je Seite, Anzahl der HTTP-Aufrufe, Antwortgröße und ob der Cache
//    innerhalb der Apps-Script-Grenzen (100 KB je Wert) bleibt. Die geschätzte Laufzeit in Apps Script rechnet
//    je HTTP-Aufruf eine feste Wartezeit dazu (Jira/Confluence/ServiceNow 400 ms, Vertex 700 ms).
// 2. Vertex: Embeddings für alle Texte beim ersten Aufruf, danach aus dem Cache.
// 3. Robustheit: kaputte Pfade, falsche Methoden, riesige und bösartige Eingaben. apiRequest muss immer gültiges
//    JSON liefern und darf keinen Stacktrace und keine Tokens nach außen geben.
//
// Grenzen von Apps Script, gegen die geprüft wird: 6 Minuten je Ausführung (Web-App), 100 KB je Cache-Wert,
// 1.000 Cache-Einträge für alle Nutzer zusammen (darüber verdrängt der Cache die kurzlebigen zuerst).
// Ziel für eine Seite: unter 30 Sekunden geschätzte Laufzeit, auch beim ersten Aufruf ohne Cache.
'use strict';

const assert = require('assert');
const { createRuntime } = require('./runtime');

const QUICK = process.argv.includes('--quick');
const SIZES = QUICK ? [500, 2000] : [500, 2000, 5000];
const LATENCY = { system: 400, vertex: 700 };
const PAGE_BUDGET_MS = 30000;
const HARD_LIMIT_MS = 6 * 60 * 1000;

// ---------------------------------------------------------------- Testdaten erzeugen

const STREAM_IDS = ['disposition', 'logistik', 'stammdaten', 'reporting'];
const EPICS = { disposition: ['ADF-100', 'ADF-101'], logistik: ['ADF-200', 'ADF-201'], stammdaten: ['ADF-300', 'ADF-301'], reporting: ['ADF-400', 'ADF-401'] };
const STATUSES = ['NEW REQUIREMENT', 'VALIDATION INT', 'WAITING FOR DM', 'VALIDATION TEAM', 'POSTPONED', 'DEVELOPMENT BACKLOG', 'IN PLANNING', 'READY FOR ROLLOUT', 'DONE', 'REJECTED'];
const WORDS = ('Bestellvorschlag Feiertag Filiale Lager Gebinde Mindestbestand Aktionsartikel Wareneingang Lieferant Tour ' +
  'Retoure Leergut Abschrift Prognose Absatz Bestand Reichweite Länderbericht Kennzahl Export Stammdaten Sortiment ' +
  'Öffnungszeit Palette Etikett Scanner Disposition Übersicht Größe Rundung Fehler Anzeige Änderung prüfen').split(' ');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
const sentence = (r, n) => Array.from({ length: n }, () => pick(r, WORDS)).join(' ');
const iso = (d) => d.toISOString().replace('Z', '+0000');

function makeSystems(n, log) {
  const r = rng(n);
  const people = Array.from({ length: 60 }, (_, i) => 'person' + i + '@firma.de').concat(['chris@firma.de']);
  const issues = Array.from({ length: n }, (_, i) => {
    const stream = pick(r, STREAM_IDS);
    const created = new Date(Date.UTC(2026, Math.floor(r() * 10), 1 + Math.floor(r() * 27), 8, 0, 0));
    const status = pick(r, STATUSES);
    const updated = new Date(created.getTime() + Math.floor(r() * 20) * 86400000);
    return { key: (i % 23 === 0 ? 'ADFCR-' : 'ADF-') + (5000 + i), fields: {
      summary: sentence(r, 6), description: sentence(r, 40 + Math.floor(r() * 80)) + ' "<script>alert(1)</script>" & <b>',
      status: { name: status }, reporter: { emailAddress: pick(r, people) }, updated: iso(updated), created: iso(created),
      resolutiondate: status === 'DONE' ? iso(updated) : null, components: [{ name: stream }], issuetype: { name: 'Story' },
      customfield_10008: pick(r, EPICS[stream]) } };
  });
  const pages = Array.from({ length: Math.ceil(n / 5) }, (_, i) => ({ id: String(900 + i), title: sentence(r, 4),
    body: { storage: { value: '<p>' + sentence(r, 120) + '</p>' } }, _links: { webui: '/x/' + i } }));
  const incidents = Array.from({ length: 200 }, (_, i) => ({ number: { display_value: 'INC' + (70000 + i) },
    short_description: { display_value: sentence(r, 5) }, description: { display_value: sentence(r, 30) },
    cmdb_ci: { display_value: pick(r, ['Bestellvorschlag', 'Wareneingang', 'Filialstamm', 'Reporting']) },
    opened_at: { display_value: '2026-10-' + String(1 + (i % 28)).padStart(2, '0') + ' 07:30:00' },
    priority: { display_value: pick(r, ['1 - Critical', '2 - High', '3 - Moderate']) }, caller_id: { display_value: 'Max' } }));
  const changes = Array.from({ length: 500 }, (_, i) => ({ number: { display_value: 'CHG' + (30000 + i) },
    short_description: { display_value: sentence(r, 5) }, description: { display_value: sentence(r, 25) },
    assigned_to: { display_value: 'Person ' + (i % 25) }, closed_at: { display_value: '2026-' + String(1 + (i % 10)).padStart(2, '0') + '-12 22:00:00' },
    cmdb_ci: { display_value: pick(r, ['Bestellvorschlag', 'Wareneingang', 'Filialstamm', 'Reporting']) }, u_release: { display_value: '2026.' + (1 + (i % 10)) } }));

  const query = (url) => Object.fromEntries(new URL(url).searchParams);
  const fetch = (url, req, batch) => {
    const vertex = url.indexOf('aiplatform.googleapis.com') >= 0;
    log.push({ url: url.split('?')[0], vertex, batch: batch ? batch.id : null });
    if (vertex) {
      if (/:predict$/.test(url)) {
        const inst = JSON.parse(req.payload).instances;
        return { code: 200, text: JSON.stringify({ predictions: inst.map((x, i) => {
          const v = new Array(768).fill(0); const h = String(x.content).length; v[h % 768] = 1; v[(h * 7 + i) % 768] = 0.5;
          return { embeddings: { values: v } }; }) }) };
      }
      return { code: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Antwort laut [1].' }] } }] }) };
    }
    if (url.indexOf('/rest/api/2/search') >= 0) {
      const q = query(url); const start = +q.startAt || 0; const max = Math.min(+q.maxResults || 50, 1000);
      const jql = q.jql || '';
      const rep = /reporter\s*=\s*"?([^"\s]+)"?/i.exec(jql);
      const pool = rep ? issues.filter((x) => x.fields.reporter.emailAddress === rep[1])
        : /ADFCR/.test(jql) ? issues.filter((x) => x.key.startsWith('ADFCR-')) : issues;
      return { code: 200, text: JSON.stringify({ startAt: start, maxResults: max, total: pool.length, issues: pool.slice(start, start + max) }) };
    }
    if (url.indexOf('/rest/api/content') >= 0) return { code: 200, text: JSON.stringify({ results: pages }) };
    if (url.indexOf('/api/now/table/incident') >= 0) {
      const q = query(url); const m = /number=([A-Z0-9]+)/.exec(q.sysparm_query || '');
      return { code: 200, text: JSON.stringify({ result: m ? incidents.filter((x) => x.number.display_value === m[1]) : incidents }) };
    }
    if (url.indexOf('/api/now/table/change_request') >= 0) return { code: 200, text: JSON.stringify({ result: changes }) };
    return { code: 404, text: '{}' };
  };
  return { fetch, firstBug: incidents[0].number.display_value };
}

const LIVE = {
  DATA_SOURCE: 'live', VERTEX_PROJECT_ID: 'mein-projekt-123', VERTEX_LOCATION: 'europe-west3',
  JIRA_URL: 'https://jira.firma.de', JIRA_PAT: 'geheim-pat-jira', CONFLUENCE_URL: 'https://wiki.firma.de', CONFLUENCE_PAT: 'geheim-pat-wiki',
  CONFLUENCE_SPACES: 'ADF', SERVICENOW_URL: 'https://sn.firma.de', SERVICENOW_TOKEN: 'geheim-token-sn', JIRA_JQL: 'project = ADF'
};

// ---------------------------------------------------------------- Messen

const ROUTES = (bug) => [
  ['GET', '/', {}], ['GET', '/tickets', {}], ['GET', '/tickets', { q: 'Bestellvorschlag Feiertag' }], ['GET', '/meine-tickets', {}],
  ['GET', '/streams', {}], ['GET', '/ticket', {}],
  ['POST', '/ticket', { text: 'Der Bestellvorschlag soll Feiertage je Land berücksichtigen, damit die Filiale nicht zu viel bestellt.' }],
  ['GET', '/wissen', { frage: 'Wie funktioniert der Bestellvorschlag an Feiertagen?' }],
  ['GET', '/bugs', {}], ['GET', '/bugs/' + bug, {}], ['POST', '/bugs/' + bug + '/erklaerung', {}], ['GET', '/admin', {}]
];

function measure(rt, log, method, path, params) {
  const before = log.length;
  const t0 = process.hrtime.bigint();
  const raw = rt.apiRequest(method, path, params);
  const cpu = Number(process.hrtime.bigint() - t0) / 1e6;
  const calls = log.slice(before);
  const sys = calls.filter((c) => !c.vertex).length, vx = calls.length - sys;
  // Parallel laufende Aufrufe (fetchAll) kosten zusammen nur eine Wartezeit.
  const waits = (list) => list.filter((c) => !c.batch).length + new Set(list.filter((c) => c.batch).map((c) => c.batch)).size;
  const est = cpu + waits(calls.filter((c) => !c.vertex)) * LATENCY.system + waits(calls.filter((c) => c.vertex)) * LATENCY.vertex;
  const out = JSON.parse(raw);
  return { cpu, sys, vx, est, bytes: Buffer.byteLength(raw), out };
}

const fmt = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };

function volume(n) {
  const log = [];
  const cacheStats = { gets: 0, puts: 0 };
  const sys = makeSystems(n, log);
  const rt = createRuntime({ scriptProperties: LIVE, fetch: sys.fetch, email: 'chris@firma.de', cacheStats });
  console.log(`\n## ${n} Jira-Tickets, ${Math.ceil(n / 5)} Confluence-Seiten, 200 Incidents, 500 Changes`);
  console.log('   Seite                                  erster Aufruf (geschätzt)   danach (Cache)   HTTP   Antwort');
  for (const [method, path, params] of ROUTES(sys.firstBug)) {
    const first = measure(rt, log, method, path, params);
    const second = measure(rt, log, method, path, params);
    const label = (method + ' ' + path + (params.q ? '?q' : '')).padEnd(38);
    console.log(`   ${label} ${fmt(first.est).padStart(10)} (Rechnen ${fmt(first.cpu)})`.padEnd(73) +
      `${fmt(second.est).padStart(8)}   ${String(first.sys + first.vx).padStart(4)}   ${(first.bytes / 1024).toFixed(0)} KB`);
    for (const r of [first, second]) {
      if (r.out.fatal) fail(`${method} ${path}: ${r.out.fatal}`);
      const notices = (r.out.ctx && r.out.ctx.notices) || [];
      if (notices.length) fail(`${method} ${path}: Hinweis ${notices.join(' | ')}`);
      const errs = r.out.ctx ? ['issues_error', 'error', 'pages_error'].map((k) => r.out.ctx[k]).filter(Boolean) : [];
      if (errs.length) fail(`${method} ${path}: ${errs.join(' | ')}`);
    }
    if (first.est > HARD_LIMIT_MS) fail(`${method} ${path}: ${fmt(first.est)} über der 6-Minuten-Grenze`);
    else if (second.est > PAGE_BUDGET_MS) fail(`${method} ${path}: mit Cache ${fmt(second.est)} (Ziel unter 30 s)`);
    if (second.sys > 0) fail(`${method} ${path}: zweiter Aufruf fragt Jira/Confluence/ServiceNow erneut (${second.sys}×), Cache greift nicht`);
  }
  console.log(`   Cache: ${rt.__cache.size()} von höchstens 1.000 Einträgen, alle unter 100 KB, ${cacheStats.evictions || 0} verdrängt`);
  if (cacheStats.evictions) fail('Cache läuft über 1.000 Einträge, Listen werden verdrängt');
  return rt;
}

function robustness() {
  console.log('\n## Robustheit: kaputte und bösartige Eingaben');
  const log = [];
  const sys = makeSystems(300, log);
  const runtimes = [
    ['Testdaten', createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } })],
    ['Live', createRuntime({ scriptProperties: LIVE, fetch: sys.fetch, email: 'chris@firma.de' })],
    ['Live, Systeme antworten mit 500', createRuntime({ scriptProperties: LIVE, fetch: () => ({ code: 500, text: 'Fehler mit geheim-pat-jira' }) })],
    ['Live, Systeme liefern Unsinn', createRuntime({ scriptProperties: LIVE, fetch: () => ({ code: 200, text: '{"issues": "kaputt", "total": -1, "result": 5}' }) })],
    ['Live, Netz weg', createRuntime({ scriptProperties: LIVE, fetch: () => { throw new Error('DNS error: jira.firma.de?token=geheim-pat-jira'); } })],
  ];
  const big = 'Bestellvorschlag '.repeat(15000); // etwa 250.000 Zeichen
  const evil = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '${7*7}', '{{7*7}}', '../../etc/passwd',
    '%E0%A4%A', '\u0000‮\ud800', 'javascript:alert(1)', big];
  const cases = [];
  ['GET', 'POST', 'PUT', 'DELETE', '', null, 42].forEach((m) => ['/', '/ticket', '/wissen', '/bugs/%E0%A4%A', '/bugs/' + encodeURIComponent('<x>'),
    '/bugs/x/erklaerung', '//', '/../admin', '/tickets?x=1', '', null, '/' + 'a'.repeat(5000)].forEach((p) => cases.push([m, p, {}])));
  for (const v of evil) {
    for (const key of ['q', 'text', 'frage', 'scope', 'stream', 'phase', 'verteilung', 'lang', 'mock_user', 'markup', 'history', 'serie']) {
      cases.push(['GET', '/', { [key]: v }], ['GET', '/tickets', { [key]: v }], ['POST', '/ticket', { [key]: v }],
        ['POST', '/ticket/pruefen', { [key]: v }], ['POST', '/wissen', { [key]: v }], ['POST', '/benutzer', { [key]: v }],
        ['POST', '/sprache', { [key]: v }], ['POST', '/ticket/text', { [key]: v }]);
    }
  }
  cases.push(['GET', '/', null], ['GET', '/', 'kein Objekt'], ['GET', '/', { q: ['a', 'b'] }], ['GET', '/', { q: { x: 1 } }],
    ['POST', '/wissen', { history: '[{"role":"user","text":"' + 'x'.repeat(100000) + '"}]', frage: 'Hallo' }],
    ['POST', '/wissen', { history: 'kein JSON', frage: 'Hallo' }], ['POST', '/wissen', { history: JSON.stringify(Array(500).fill({ role: 'user', text: 'Frage' })), frage: 'x' }]);

  let total = 0, worst = 0, worstCase = '';
  for (const [name, rt] of runtimes) {
    let bad = 0;
    for (const [m, p, params] of cases) {
      total++;
      const t0 = Date.now();
      let raw;
      try { raw = rt.apiRequest(m, p, params); } catch (exc) { bad++; fail(`${name}: apiRequest(${m}, ${String(p).slice(0, 30)}) wirft ${exc.message}`); continue; }
      const ms = Date.now() - t0;
      if (ms > worst) { worst = ms; worstCase = `${name}: ${m} ${String(p).slice(0, 30)} ${JSON.stringify(params).slice(0, 40)}`; }
      let out;
      try { out = JSON.parse(raw); } catch (e) { bad++; fail(`${name}: keine JSON-Antwort für ${m} ${p}`); continue; }
      if (/geheim-|ya29\.|at [A-Za-z_]+ \(|\.gs:\d+/.test(raw)) { bad++; fail(`${name}: Antwort enthält Token oder Stacktrace für ${m} ${String(p).slice(0, 30)}: ${raw.slice(0, 160)}`); }
      if (out.fatal) { bad++; fail(`${name}: Absturz statt Fehlerblock für ${m} ${String(p).slice(0, 30)} ${JSON.stringify(params).slice(0, 60)}: ${out.fatal}`); }
    }
    console.log(`   ${name.padEnd(34)} ${cases.length} Aufrufe, ${bad ? bad + ' Probleme' : 'alles gültig'}`);
  }
  console.log(`   Langsamster Aufruf: ${worst} ms (${worstCase})`);
}

function vertexCache() {
  console.log('\n## Vertex-Embeddings: alle Texte einbetten, danach aus dem Cache');
  const log = [];
  const cacheStats = { gets: 0, puts: 0 };
  const sys = makeSystems(2000, log);
  const rt = createRuntime({ scriptProperties: Object.assign({}, LIVE, { EMBEDDINGS: 'vertex' }), fetch: sys.fetch, email: 'chris@firma.de', cacheStats });
  const params = { text: 'Der Bestellvorschlag soll Feiertage je Land berücksichtigen.' };
  const a = measure(rt, log, 'POST', '/ticket', params);
  const parallel = log.filter((c) => c.vertex && c.batch).length;
  const b = measure(rt, log, 'POST', '/ticket', params);
  console.log(`   erster Aufruf: ${a.vx} Vertex-Aufrufe (${parallel} davon parallel), geschätzt ${fmt(a.est)}`);
  console.log(`   zweiter Aufruf: ${b.vx} Vertex-Aufrufe, ${b.sys} Systemaufrufe, ${fmt(b.est)}`);
  console.log(`   Cache: ${rt.__cache.size()} Einträge, ${cacheStats.evictions || 0} verdrängt`);
  if (a.vx < 40) fail('erster Aufruf bettet nicht alle Texte ein (' + a.vx + ' Vertex-Aufrufe)');
  if (!parallel) fail('Embeddings laufen nicht parallel (fetchAll)');
  if (b.vx > 1 || b.sys > 0) fail('zweiter Aufruf liest nicht aus dem Cache');
  if (cacheStats.evictions) fail('Cache läuft über 1.000 Einträge, Einträge werden verdrängt');
}

console.log('Stresstest Apps-Script-Fassung' + (QUICK ? ' (kurz)' : ''));
SIZES.forEach(volume);
vertexCache();
robustness();
console.log(failures ? `\n${failures} Probleme gefunden` : '\nKeine Probleme gefunden');
process.exitCode = failures ? 1 : 0;
