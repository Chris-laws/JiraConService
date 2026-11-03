// Schnelltests für den Apps-Script-Code:  node apps-script/dev/test.js
'use strict';

const assert = require('assert');
const { createRuntime } = require('./runtime');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (err) { failed += 1; console.log('FAIL ' + name + '\n     ' + (err.stack || err).toString().split('\n').slice(0, 3).join('\n     ')); }
}
const call = (rt, method, path, params) => JSON.parse(rt.apiRequest(method, path, params || {}));

const PAGES = [['GET', '/'], ['GET', '/tickets'], ['GET', '/ticket'], ['GET', '/meine-tickets'], ['GET', '/admin'],
  ['GET', '/wissen'], ['GET', '/bugs/INC0041871'], ['GET', '/streams'], ['GET', '/dokumente'], ['GET', '/releases']];

test('Testdaten: jede Seite liefert eine Vorlage', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  for (const [m, p] of PAGES) {
    const res = call(rt, m, p);
    assert.ok(res.template, p + ' ohne Vorlage: ' + JSON.stringify(res).slice(0, 200));
  }
  assert.strictEqual(call(rt, 'GET', '/bugs').redirect, '/bugs/INC0042010');
});

test('Ticketentwurf mit zwei Streams wird gesperrt und schlägt Aufteilung vor', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const ctx = call(rt, 'GET', '/ticket', { beispiel: ['1'] }).ctx;
  assert.ok(ctx.result.classification.multi_stream);
  assert.strictEqual(ctx.result.blocked, 'Das Ticket betrifft mehrere Streams. Bitte aufteilen, je Stream ein Ticket.');
  assert.ok(ctx.result.duplicates.some((d) => d.level === 'duplicate'));
});

test('Maske prüfen: Anlegen ist gesperrt, nur Text zum Kopieren', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const draft = call(rt, 'GET', '/ticket', { beispiel: ['0'] }).ctx.result.form;
  const fields = {};
  Object.keys(draft).forEach((k) => { fields[k] = [Array.isArray(draft[k]) ? draft[k].join('\n') : String(draft[k])]; });
  fields.current_state = ['Heute wird der Mindestbestand manuell überschrieben.'];
  fields.reviewed = ['1'];
  fields.action = ['anlegen'];
  const ctx = call(rt, 'POST', '/ticket/pruefen', fields).ctx;
  assert.strictEqual(ctx.result.blocked, 'Diese Fassung liest nur. Text kopieren und in Jira einfügen.');
  assert.ok(ctx.result.markup.indexOf('h3. 3. Ausgangssituation\nHeute wird der Mindestbestand manuell überschrieben.') >= 0);
});

test('Live mit Platzhaltern: Seiten zeigen den Fehler im Block statt abzustürzen', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'live', JIRA_URL: 'PLATZHALTER-https://jira.example.com' } });
  const ctx = call(rt, 'GET', '/').ctx;
  assert.ok(/JIRA_URL ist nicht konfiguriert/.test(ctx.issues_error), ctx.issues_error);
  assert.ok(/SERVICENOW_URL/.test(call(rt, 'GET', '/bugs').ctx.error));
});

function fakeSystems(log) {
  return (url, req) => {
    log.push({ url, req });
    if (url.indexOf('aiplatform.googleapis.com') >= 0) {
      if (/:predict$/.test(url)) {
        const n = JSON.parse(req.payload).instances.length;
        const preds = [];
        for (let i = 0; i < n; i++) { const v = new Array(8).fill(0); v[i % 8] = 1; v[(i + 3) % 8] = 0.5; preds.push({ embeddings: { values: v } }); }
        return { code: 200, text: JSON.stringify({ predictions: preds }) };
      }
      return { code: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Antwort laut [1].' }] } }] }) };
    }
    if (url.indexOf('/rest/api/2/search') >= 0) {
      return { code: 200, text: JSON.stringify({ total: 1, issues: [{ key: 'ADF-1', fields: {
        summary: 'Test', description: 'Bestellvorschlag Feiertage', status: { name: 'NEW REQUIREMENT' },
        reporter: { emailAddress: 'chris@firma.de' }, updated: '2026-10-30T10:00:00.000+0100', created: '2026-10-01T09:00:00.000+0200',
        resolutiondate: null, components: [{ name: 'Disposition' }], issuetype: { name: 'Story' }, customfield_10008: 'ADF-100' } }] }) };
    }
    if (url.indexOf('/rest/api/content') >= 0) {
      return { code: 200, text: JSON.stringify({ results: [{ id: '7', title: 'Leitfaden', body: { storage: { value: '<p>Text &amp; mehr</p>' } }, _links: { webui: '/x/7' } }] }) };
    }
    if (url.indexOf('/api/now/table/incident') >= 0) {
      return { code: 200, text: JSON.stringify({ result: [{ number: { display_value: 'INC1' }, short_description: { display_value: 'Fehler' },
        description: { display_value: 'Bestellvorschlag rundet falsch' }, cmdb_ci: { display_value: 'Bestellvorschlag' },
        opened_at: { display_value: '2026-10-14 07:30:00' }, priority: { display_value: '2 - High' }, caller_id: { display_value: 'Max' } }] }) };
    }
    if (url.indexOf('/api/now/table/change_request') >= 0) {
      return { code: 200, text: JSON.stringify({ result: [{ number: { display_value: 'CHG1' }, short_description: { display_value: 'Rundung' },
        description: { display_value: 'Rundung im Bestellvorschlag' }, assigned_to: { display_value: 'Felix' },
        closed_at: { display_value: '2026-10-13 22:00:00' }, cmdb_ci: { display_value: 'Bestellvorschlag' }, u_release: { display_value: '2026.10' } }] }) };
    }
    return { code: 404, text: '{}' };
  };
}

const LIVE = {
  DATA_SOURCE: 'live', VERTEX_PROJECT_ID: 'mein-projekt-123', VERTEX_LOCATION: 'europe-west3',
  JIRA_URL: 'https://jira.firma.de/', JIRA_PAT: 'pat-j', CONFLUENCE_URL: 'https://wiki.firma.de', CONFLUENCE_PAT: 'pat-c',
  CONFLUENCE_SPACES: 'ADF', SERVICENOW_URL: 'https://sn.firma.de', SERVICENOW_TOKEN: 'tok-s'
};

test('Live: REST-Adapter lesen Jira, Confluence und ServiceNow mit PAT als Bearer', () => {
  const log = [];
  const rt = createRuntime({ scriptProperties: LIVE, fetch: fakeSystems(log), email: 'chris@firma.de' });
  const dash = call(rt, 'GET', '/').ctx;
  assert.strictEqual(dash.issues_error, null);
  assert.strictEqual(dash.overall_total, 1);
  assert.strictEqual(dash.mine_open, 1);
  const jiraCall = log.find((l) => l.url.indexOf('jira.firma.de/rest/api/2/search') >= 0);
  assert.strictEqual(jiraCall.req.headers.Authorization, 'Bearer pat-j');
  const bug = call(rt, 'GET', '/bugs/INC1').ctx;
  assert.strictEqual(bug.result.candidates[0].change.id, 'CHG1');
  assert.strictEqual(bug.bug.caller, undefined, 'Melder darf nicht an die Oberfläche gehen');
  const snCall = log.find((l) => l.url.indexOf('sn.firma.de') >= 0);
  assert.strictEqual(snCall.req.headers.Authorization, 'Bearer tok-s');
});

test('Vertex: OAuth-Token und Projekt-ID im Header, kein API-Key, regionale Adresse', () => {
  const log = [];
  const rt = createRuntime({ scriptProperties: LIVE, fetch: fakeSystems(log), oauthToken: 'ya29.token' });
  const ctx = call(rt, 'GET', '/wissen', { frage: ['Bestellvorschlag Feiertage'] }).ctx;
  assert.strictEqual(ctx.answer.source, 'gemini');
  const gen = log.find((l) => /:generateContent$/.test(l.url));
  assert.strictEqual(gen.url, 'https://europe-west3-aiplatform.googleapis.com/v1/projects/mein-projekt-123/locations/europe-west3/publishers/google/models/gemini-2.5-flash:generateContent');
  assert.strictEqual(gen.req.headers.Authorization, 'Bearer ya29.token');
  assert.strictEqual(gen.req.headers['x-goog-user-project'], 'mein-projekt-123');
  assert.ok(!/key=/.test(gen.url));
  const emb = log.find((l) => /:predict$/.test(l.url));
  assert.ok(/text-multilingual-embedding-002:predict$/.test(emb.url));
});

test('Vertex verweigert (403): Offline-Rechnung mit Hinweis, Ticketentwurf offline', () => {
  const rt = createRuntime({
    scriptProperties: { DATA_SOURCE: 'mock', VERTEX_PROJECT_ID: 'mein-projekt-123' },
    fetch: () => ({ code: 403, text: '{"error":{}}' })
  });
  const ctx = call(rt, 'GET', '/ticket', { beispiel: ['0'] }).ctx;
  assert.ok(ctx.notices.some((n) => /Vertex Embeddings nicht erreichbar/.test(n)), JSON.stringify(ctx.notices));
  assert.ok(/KI nicht nutzbar/.test(ctx.result.form.notice));
  assert.strictEqual(ctx.result.form.stream, 'disposition');
});

test('Sprache und Testperson werden je Nutzer gespeichert', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  assert.strictEqual(call(rt, 'POST', '/sprache', { lang: ['en'], back: ['/tickets?q=x'] }).redirect, '/tickets?q=x');
  assert.strictEqual(call(rt, 'GET', '/').ctx.lang, 'en');
  assert.strictEqual(call(rt, 'POST', '/sprache', { lang: ['de'], back: ['//evil.example'] }).redirect, '/');
  call(rt, 'POST', '/benutzer', { user: ['marco.rossi@example.com'], role: ['Land'], back: ['/'] });
  const me = call(rt, 'GET', '/').ctx.me;
  assert.strictEqual(me.email, 'marco.rossi@example.com');
  assert.strictEqual(me.role, 'Land');
});

test('Datenschutz: E-Mail und Telefonnummer werden vor der KI maskiert', () => {
  const rt = createRuntime({});
  assert.strictEqual(rt.redact('Mail an max.muster@firma.de oder +49 30 1234567, Raum 12'), 'Mail an [E-Mail] oder [Telefon], Raum 12');
});

test('Fehlermeldungen von UrlFetch nennen keine Zugangsdaten', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const msg = rt.safeFetchMessage_(new Error('DNS error: https://nutzer:geheim1@jira.firma.de/rest?jql=x&token=geheim2 token=geheim3 Bearer geheim4\nzweite Zeile'));
  assert.ok(!/geheim/.test(msg), msg);
  assert.ok(/jira\.firma\.de\/rest/.test(msg), msg);
  assert.ok(!/zweite Zeile/.test(msg));
});

test('Fehlerantwort: Begründung von Jira wird angezeigt, ohne Tokens; HTML-Seite wird erkannt', () => {
  const answers = [
    [JSON.stringify({ errorMessages: ["Der Wert 'ADF' existiert nicht für das Feld 'project'."], errors: {} }), /HTTP 400: Der Wert 'ADF' existiert nicht/],
    [JSON.stringify({ errorMessages: [], errors: { jql: 'Fehler bei token=abc123' } }), /jql: Fehler bei token=…/],
    ['<!DOCTYPE html><html>Login</html>', /HTML-Seite/],
  ];
  for (const [text, rx] of answers) {
    const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'live', JIRA_URL: 'https://jira.x', JIRA_PAT: 'geheim' }, fetch: () => ({ code: 400, text }) });
    const err = call(rt, 'GET', '/').ctx.issues_error;
    assert.ok(rx.test(err), err);
    assert.ok(!/geheim|abc123/.test(err), err);
  }
});

test('Ticketliste: 250 Zeilen je Paket, „Weitere laden“ bis zur Obergrenze', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const base = rt.MOCK_DATA.issues.filter((i) => !String(i.key).startsWith('ADFCR'));
  const many = [];
  for (let n = 0; many.length < 600; n++) many.push(Object.assign({}, base[n % base.length], { key: 'ADF-' + (9000 + n), description: 'x'.repeat(500) }));
  rt.MOCK_DATA.issues = rt.MOCK_DATA.issues.concat(many);
  const first = call(rt, 'GET', '/tickets').ctx;
  assert.strictEqual(first.rows.length, 250);
  assert.ok(first.matched >= 600, String(first.matched));
  assert.strictEqual(first.more, 250);
  assert.ok(first.rows.every((r) => r.description.length <= 241), 'Beschreibung wird gekürzt');
  const second = call(rt, 'GET', '/tickets', { limit: '500' }).ctx;
  assert.strictEqual(second.rows.length, 500);
  assert.strictEqual(second.more, Math.min(250, first.matched - 500));
  const huge = call(rt, 'GET', '/tickets', { limit: '999999' }).ctx;
  assert.strictEqual(huge.limit, 5000);
  assert.strictEqual(huge.rows.length, first.matched);
  assert.ok(huge.more <= 0);
  assert.strictEqual(call(rt, 'GET', '/tickets', { limit: 'abc' }).ctx.rows.length, 250);
});

function fakeVertex(log, failFirst) {
  let calls = 0;
  return (url, req, batch) => {
    calls++;
    const inst = JSON.parse(req.payload).instances;
    log.push({ n: inst.length, parallel: batch ? batch.parallel : 1 });
    if (failFirst && failFirst(calls, inst)) return { code: failFirst.code || 500, text: '{}' };
    return { code: 200, text: JSON.stringify({ predictions: inst.map((x) => {
      const v = new Array(768).fill(0); const h = String(x.content).length; v[h % 768] = 1; v[(h * 7) % 768] += 0.5;
      return { embeddings: { values: v } }; }) }) };
  };
}
const texts = (n) => Array.from({ length: n }, (_, i) => 'Ticket Nummer ' + i + ' ' + 'x'.repeat(i % 50));

test('Vertex-Embeddings: parallel, kompakt im Cache (wenige Einträge), zweiter Lauf ohne Aufruf', () => {
  const log = [];
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' }, fetch: fakeVertex(log) });
  const emb = new rt.VertexEmbedder('p', 'global', 'text-multilingual-embedding-002');
  const a = emb.embed(texts(2000));
  assert.strictEqual(log.length, 40);
  assert.ok(log.some((l) => l.parallel > 1), 'fetchAll wird genutzt');
  assert.ok(rt.__cache.size() <= 128, 'höchstens 128 Cache-Einträge, waren ' + rt.__cache.size());
  log.length = 0;
  const b = emb.embed(texts(2000));
  assert.strictEqual(log.length, 0, 'zweiter Lauf aus dem Cache');
  const dot = a[7].reduce((s, v, i) => s + v * b[7][i], 0);
  assert.ok(Math.abs(dot - 1) < 1e-9, 'gleiche Vektoren aus Cache und Neuberechnung');
});

test('Vertex-Embeddings: Fehler in einem Paket behält die fertigen Vektoren, 429 wird einmal wiederholt', () => {
  const log = [];
  const fail = (calls, inst) => /Nummer 0 /.test(inst[0].content);
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' }, fetch: fakeVertex(log, fail) });
  const emb = new rt.VertexEmbedder('p', 'global', 'm');
  assert.throws(() => emb.embed(texts(300)), (e) => e instanceof rt.LlmUnavailable && /HTTP 500/.test(e.message));
  log.length = 0;
  const rt2 = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' }, fetch: fakeVertex(log), cache: rt.__cache });
  new rt2.VertexEmbedder('p', 'global', 'm').embed(texts(300));
  assert.strictEqual(log.length, 1, 'nur das fehlgeschlagene Paket wird neu geholt, waren ' + log.length);
  const log3 = [];
  let tries = 0;
  const once429 = Object.assign(() => ++tries === 1, { code: 429 });
  const rt3 = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' }, fetch: fakeVertex(log3, once429) });
  assert.strictEqual(new rt3.VertexEmbedder('p', 'global', 'm').embed(texts(10)).length, 10);
  assert.strictEqual(log3.length, 2);
});

test('Cache wie Apps Script: höchstens 1.000 Einträge, die kurzlebigen fliegen zuerst', () => {
  const { memoryCache } = require('./runtime');
  const c = memoryCache();
  c.put('kurz', 'x', 300);
  const lots = {}; for (let i = 0; i < 1000; i++) lots['lang' + i] = 'x';
  c.putAll(lots, 21600);
  assert.strictEqual(c.size(), 900);
  assert.strictEqual(c.get('kurz'), null);
  assert.throws(() => c.put('gross', 'ä'.repeat(60000)), /too large/);
  c.advance(21601);
  assert.strictEqual(c.get('lang1'), null);
});

test('Ladezeit: unveränderte Seite kommt als {same}, Messwerte mit _perf, Log-Zeile je Aufruf', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const first = call(rt, 'GET', '/streams');
  assert.ok(first.etag && first.template);
  const again = call(rt, 'GET', '/streams', { _etag: [first.etag] });
  assert.deepStrictEqual(again, { same: true, etag: first.etag });
  assert.ok(call(rt, 'GET', '/streams', { _etag: ['alt'] }).template, 'anderer Stand liefert die ganze Seite');
  const perf = call(rt, 'GET', '/', { _perf: ['1'] }).perf;
  assert.ok(perf && perf.ms >= 0 && perf.bytes > 0, JSON.stringify(perf));
  assert.ok(rt.__logs.some((l) => /^api GET \/ \d+ ms/.test(l)), 'Log-Zeile „api <route> <ms> ms“');
  assert.strictEqual(call(rt, 'POST', '/sprache', { lang: ['de'] }).etag, undefined, 'POST ohne Kennung');
});

test('Netz wackelt: GET wird mit Wartezeit wiederholt, POST nicht', () => {
  const log = [];
  let fails = 0;
  const systems = fakeSystems(log);
  const flaky = (url, req) => (req.method === 'get' && /rest\/api\/2\/search/.test(url) && fails++ < 2 ? { code: 503, text: '' } : systems(url, req));
  const rt = createRuntime({ scriptProperties: LIVE, fetch: flaky, email: 'chris@firma.de' });
  assert.strictEqual(call(rt, 'GET', '/').ctx.issues_error, null, 'nach zwei 503 klappt der dritte Versuch');
});

test('Nur lesen: kein POST/PUT/DELETE an Jira, Confluence, ServiceNow, auch nicht mit alter Schreib-Einstellung', () => {
  const log = [];
  const systems = fakeSystems(log);
  const methods = [];
  const props = Object.assign({}, LIVE, { JIRA_WRITE_ENABLED: 'true' });
  const rt = createRuntime({ scriptProperties: props, email: 'chris@firma.de',
    fetch: (url, req) => { methods.push([String(req.method).toUpperCase(), url]); return systems(url, req); } });
  // alle Seiten und alle Formulare, auch „anlegen“
  for (const [m, p] of PAGES) call(rt, m, p);
  call(rt, 'GET', '/bugs/INC1');
  call(rt, 'POST', '/bugs/INC1/erklaerung', {});
  call(rt, 'POST', '/wissen', { frage: ['Bestellvorschlag Feiertage'] });
  const draft = call(rt, 'POST', '/ticket', { text: ['Der Bestellvorschlag soll Feiertage je Land berücksichtigen, damit nicht zu viel bestellt wird.'] }).ctx.result.form;
  const fields = {};
  Object.keys(draft).forEach((k) => { fields[k] = [Array.isArray(draft[k]) ? draft[k].join('\n') : String(draft[k])]; });
  Object.assign(fields, { current_state: ['Heute manuell.'], reviewed: ['1'], action: ['anlegen'], stream: ['disposition'] });
  const res = call(rt, 'POST', '/ticket/pruefen', fields).ctx.result;
  assert.ok(!res.created, 'nichts angelegt');
  assert.ok(methods.length > 5, 'Live-Abrufe fanden statt');
  const writes = methods.filter(([m, u]) => m !== 'GET' && !/^https:\/\/([a-z0-9-]+-)?aiplatform\.googleapis\.com\//.test(u));
  assert.deepStrictEqual(writes, [], 'nur GET an Jira & Co.');
  // Die Sperre selbst: jede andere Methode an jede andere Adresse wird verweigert, bevor ein Aufruf rausgeht.
  const before = methods.length;
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const u of ['https://jira.firma.de/rest/api/2/issue', 'https://wiki.firma.de/rest/api/content', 'https://sn.firma.de/api/now/table/incident',
      'https://aiplatform.googleapis.com.evil.de/x', 'https://evil.de/aiplatform.googleapis.com/']) {
      assert.throws(() => rt.requestJson(m, u, { json: {} }), (e) => e instanceof rt.WriteDisabled && /Nur-Lesen-Sperre/.test(e.message), m + ' ' + u);
    }
  }
  assert.strictEqual(methods.length, before, 'verweigerte Aufrufe gehen nicht raus');
  assert.throws(() => new rt.ReadOnlyJiraWriter().createIssue({}), rt.WriteDisabled);
  assert.strictEqual(typeof rt.JiraRestWriter, 'undefined', 'kein Code zum Anlegen mehr');
});

test('Ausgelieferte Fassung ohne Testdaten: DATA_SOURCE=mock gibt einen klaren Fehler, Standard ist live', () => {
  const path = require('path');
  const bundle = [path.join(__dirname, '..', 'bundle', 'Code.gs')];
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' }, codeFiles: bundle });
  assert.strictEqual(typeof rt.MOCK_DATA, 'undefined');
  assert.throws(() => rt.loadSettings(), /Testdaten sind in dieser Fassung nicht enthalten/);
  const live = createRuntime({ scriptProperties: {}, codeFiles: bundle });
  assert.strictEqual(live.loadSettings().dataSource, 'live');
  const docs = call(live, 'GET', '/dokumente');
  assert.ok(docs.template && !docs.fatal, 'Seite ohne Drive-Ordner läuft');
});

test('KI-Tageslimit je Person: danach Regel-Logik mit Hinweis', () => {
  const log = [];
  const rt = createRuntime({ scriptProperties: Object.assign({}, LIVE, { LLM_DAILY_LIMIT: '2' }), fetch: fakeSystems(log), email: 'a@firma.de' });
  for (let i = 0; i < 2; i++) assert.strictEqual(call(rt, 'GET', '/wissen', { frage: ['Bestellvorschlag Feiertage'] }).ctx.answer.source, 'gemini');
  const third = call(rt, 'GET', '/wissen', { frage: ['Bestellvorschlag Feiertage'] }).ctx.answer;
  assert.notStrictEqual(third.source, 'gemini');
  assert.ok(/Tageslimit/.test(third.notice), third.notice);
  const other = createRuntime({ scriptProperties: Object.assign({}, LIVE, { LLM_DAILY_LIMIT: '2' }), fetch: fakeSystems(log), email: 'b@firma.de', cache: rt.__cache });
  assert.strictEqual(call(other, 'GET', '/wissen', { frage: ['Bestellvorschlag Feiertage'] }).ctx.answer.source, 'gemini', 'andere Person hat eigenes Limit');
});

test('Seite ohne Kommentare (minify): Vorlagen liefern Zeichen für Zeichen dasselbe HTML, Skripte sind gültig', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const { stripHtml, stripJs } = require('./minify');
  const SRC = path.join(__dirname, '..', 'src');
  const script = (html) => /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const load = (strip) => {
    const sandbox = { MARK_SRC: 'mark.svg', URLSearchParams, Intl, Date, Math, JSON };
    vm.createContext(sandbox);
    for (const f of ['JsI18n', 'JsHelpers', 'JsTemplates']) {
      const html = fs.readFileSync(path.join(SRC, f + '.html'), 'utf8');
      vm.runInContext(script(strip ? stripHtml(html) : html), sandbox);
    }
    return sandbox;
  };
  const a = load(false), b = load(true);
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const pages = PAGES.map(([m, p]) => call(rt, m, p)).concat([call(rt, 'GET', '/ticket', { beispiel: ['1'] }), call(rt, 'GET', '/wissen', { frage: ['Bestellvorschlag'] })]);
  let n = 0;
  for (const res of pages) {
    for (const lang of ['de', 'en']) {
      // Jede Fassung bekommt eine eigene Kopie: manche Vorlagen sortieren Listen im Kontext um.
      const copy = () => JSON.parse(JSON.stringify(Object.assign({}, res.ctx, { lang, query_string: '' })));
      const ca = copy(), cb = copy();
      a.CTX = ca; b.CTX = cb;
      assert.strictEqual(b.TEMPLATES[res.template](cb), a.TEMPLATES[res.template](ca), res.template + ' ' + lang);
      n++;
    }
  }
  assert.ok(n >= 20);
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.html'))) {
    const out = stripHtml(fs.readFileSync(path.join(SRC, f), 'utf8'));
    (out.match(/<script>([\s\S]*?)<\/script>/g) || []).forEach((s) => new vm.Script(s.slice(8, -9).replace(/<\?!?=[\s\S]*?\?>/g, '0'), { filename: f }));
    assert.ok(!/<!--/.test(out), f + ' enthält noch HTML-Kommentare');
  }
  assert.strictEqual(stripJs("var a = 1 / 2; // x\nvar r = /\\/\\/[^/]*/g; /* y */ var s = '// z';\nvar t = `a ${ {b: 1}.b } // c`;"),
    "var a = 1 / 2;\nvar r = /\\/\\/[^/]*/g;  var s = '// z';\nvar t = `a ${ {b: 1}.b } // c`;");
});

test('Gebündelte Fassung (bundle/) ist aktuell und rechnet gleich', () => {
  const fs = require('fs');
  const path = require('path');
  const before = fs.readFileSync(path.join(__dirname, '..', 'bundle', 'Code.gs'), 'utf8');
  require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'bundle.js')]);
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'bundle', 'Code.gs'), 'utf8'), before, 'bundle/ war veraltet, jetzt neu erzeugt: bitte mit committen');
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' }, codeFiles: [path.join(__dirname, '..', 'bundle', 'Code.gs'), path.join(__dirname, '..', 'src', 'MockData.gs')] });
  const a = call(rt, 'GET', '/ticket', { beispiel: ['2'] }).ctx.result.markup;
  const b = call(createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } }), 'GET', '/ticket', { beispiel: ['2'] }).ctx.result.markup;
  assert.strictEqual(a, b);
  const html = fs.readFileSync(path.join(__dirname, '..', 'bundle', 'Index.html'), 'utf8');
  assert.ok(!/include\(/.test(html), 'Index.html enthält noch include()');
});

console.log(failed ? '\n' + failed + ' Test(s) fehlgeschlagen' : '\nAlle Tests bestanden');
process.exit(failed ? 1 : 0);
