// Schnelltests für den Apps-Script-Code:  node apps-script/dev/test.js
'use strict';

const assert = require('assert');
const { createRuntime } = require('./runtime');

let failed = 0;
const pendingAsync = [];
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); } catch (err) { failed += 1; console.log('FAIL ' + name + '\n     ' + (err.stack || err).toString().split("\n").slice(0, 8).join('\n     ')); }
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
        // Inhaltsabhängig wie ein echtes Modell: gleiche Wörter → ähnliche Vektoren (Länge 1).
        const preds = JSON.parse(req.payload).instances.map((x) => {
          const v = new Array(8).fill(0);
          String(x.content).toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean).forEach((w) => { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 8; v[h] += 1; });
          const len = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
          return { embeddings: { values: v.map((y) => y / len) } };
        });
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

test('Adressen aus dem Browser: Grundadresse wird erkannt (Board-, Bereichs- und Seiten-Links)', () => {
  const rt = createRuntime({});
  const cases = [
    ['https://jira.firma/secure/RapidBoard.jspa?rapidView=42249&projectKey=ADFCR', 'https://jira.firma'],
    ['https://jira.firma/jira/browse/ADFCR-1', 'https://jira.firma/jira'],
    ['https://wiki.firma/spaces/ADINT/overview', 'https://wiki.firma'],
    ['https://wiki.firma/confluence/display/ADINT/Start', 'https://wiki.firma/confluence'],
    ['https://wiki.firma/pages/viewpage.action?pageId=1', 'https://wiki.firma'],
    ['https://jira.firma/', 'https://jira.firma'],
  ];
  for (const [raw, want] of cases) assert.strictEqual(rt.baseUrl_(raw), want, raw);
  const log = [];
  const r2 = createRuntime({ scriptProperties: Object.assign({}, LIVE, { CONFLUENCE_URL: 'https://wiki.firma.de/spaces/ADF/overview' }), fetch: fakeSystems(log) });
  call(r2, 'GET', '/wissen', { frage: ['Bestellvorschlag Feiertage'] });
  assert.ok(log.some((l) => l.url.indexOf('https://wiki.firma.de/rest/api/content') === 0), 'Confluence-API unter der Grundadresse');
});

test('Jira mit vielen Tickets: erste Seite, dann die übrigen gleichzeitig (fetchAll), alle Tickets da', () => {
  const issues = Array.from({ length: 1234 }, (_, i) => ({ key: 'ADFCR-' + i, fields: { summary: 's' + i, description: '', status: { name: 'NEW REQUIREMENT' },
    reporter: { emailAddress: 'x@firma.de' }, updated: '2026-10-01T10:00:00.000+0000', created: '2026-10-01T10:00:00.000+0000', components: [], issuetype: { name: 'Story' } } }));
  let single = 0, parallel = 0;
  const fetch = (url, req, batch) => {
    if (batch) parallel++; else single++;
    const q = new URL(url).searchParams; const start = +q.get('startAt'); const max = +q.get('maxResults');
    return { code: 200, text: JSON.stringify({ startAt: start, maxResults: max, total: issues.length, issues: issues.slice(start, start + max) }) };
  };
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'live', JIRA_URL: 'https://jira.firma', JIRA_PAT: 'p' }, fetch });
  const got = new rt.JiraRestReader(rt.loadSettings()).searchIssues();
  assert.strictEqual(got.length, 1234);
  assert.strictEqual(new Set(got.map((i) => i.key)).size, 1234);
  assert.strictEqual(single, 1, 'nur die erste Seite einzeln');
  assert.strictEqual(parallel, 2, 'die übrigen zwei Seiten gleichzeitig');
});

test('Kein JSON: Seitentitel und Weiterleitungsziel werden genannt (z. B. SSO statt PAT)', () => {
  const fetch = (url, req) => (req.followRedirects === false
    ? { code: 302, text: '', headers: { Location: 'https://sso.firma.de/login?ticket=geheim' } }
    : { code: 200, text: '<html><head><title>Anmelden - Confluence</title></head></html>' });
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'live', CONFLUENCE_URL: 'https://wiki.firma.de', CONFLUENCE_PAT: 'p', CONFLUENCE_SPACES: 'ADINT' }, fetch });
  assert.throws(() => new rt.ConfluenceRest(rt.loadSettings()).pages(), (e) => {
    assert.ok(/kein JSON \(Seite „Anmelden - Confluence“, leitet weiter nach https:\/\/sso\.firma\.de\/login\)/.test(e.message), e.message);
    assert.ok(!/geheim/.test(e.message));
    return true;
  });
});

test('Wissen: Confluence hinter Anmeldeseite, Suche läuft mit Jira weiter und zeigt einen Hinweis', () => {
  const log = [];
  const systems = fakeSystems(log);
  const fetch = (url, req) => (url.indexOf('/rest/api/content') >= 0 ? { code: 200, text: '<html><title>BIG-IP logout page</title></html>' } : systems(url, req));
  const rt = createRuntime({ scriptProperties: LIVE, fetch });
  const ctx = call(rt, 'GET', '/wissen', { frage: ['Bestellvorschlag Feiertage'] }).ctx;
  assert.ok(ctx.notices.some((n) => /Confluence ist gerade nicht erreichbar.*BIG-IP/.test(n)), JSON.stringify(ctx.notices));
  assert.ok(ctx.answer.sources.some((h) => h.source === 'jira'), 'Treffer aus Jira');
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

test('Suche: Stichwort-Vorauswahl, nur die besten 60 plus Anfrage werden eingebettet, Treffer stimmt', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const seen = [];
  const embedder = { name: 'test', embed: (texts) => { seen.push(texts.length); return new rt.HashingEmbedder().embed(texts); } };
  const index = new rt.VectorIndex(embedder);
  const items = Array.from({ length: 3000 }, (_, i) => ({ id: 'T' + i, text: 'Ticket ' + i + ' Lager Palette Etikett Scanner ' + (i % 7 ? 'Tour' : 'Retoure'), title: 'T' + i, url: '', source: 'jira', payload: {} }));
  items.push({ id: 'ZIEL', text: 'Bestellvorschlag berücksichtigt regionale Feiertage nicht', title: 'Ziel', url: '', source: 'jira', payload: {} });
  index.add(items);
  assert.strictEqual(seen.length, 0, 'Aufbau bettet nichts ein');
  const hits = index.search('Feiertage im Bestellvorschlag fehlen', 3, 0);
  assert.strictEqual(hits[0].id, 'ZIEL');
  assert.ok(seen.length === 1 && seen[0] <= 61, 'höchstens 60 Kandidaten plus Anfrage, waren ' + seen);
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

test('Seite ohne Kommentare (minify): Skripte bleiben gültig, die Oberfläche zeichnet gekürzt dasselbe', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const { stripHtml, stripJs } = require('./minify');
  const SRC = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.html'))) {
    const out = stripHtml(fs.readFileSync(path.join(SRC, f), 'utf8'));
    (out.match(/<script>([\s\S]*?)<\/script>/g) || []).forEach((s) => new vm.Script(s.slice(8, -9).replace(/<\?!?=[\s\S]*?\?>/g, '0'), { filename: f }));
    assert.ok(!/<!--/.test(out), f + ' enthält noch HTML-Kommentare');
  }
  // JsApp in einer kleinen Nachbildung des Browsers laufen lassen: volle und gekürzte Fassung zeichnen dasselbe HTML.
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const ctx = call(rt, 'POST', '/abgleich', { text: ['Im Wareneingang sollen Teillieferungen einer Palette erfasst werden können.'], modus: ['wunsch'] });
  const drawn = (strip) => {
    const html = fs.readFileSync(path.join(SRC, 'JsApp.html'), 'utf8');
    const code = /<script>([\s\S]*)<\/script>/.exec(strip ? stripHtml(html) : html)[1];
    const app = { innerHTML: '', addEventListener: () => {} };
    const sandbox = { MARK_SRC: 'mark.svg', JSON, Math, Promise, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, FormData: function () {},
      localStorage: { getItem: () => null, setItem: () => {} }, location: { hash: '' }, navigator: {},
      document: { getElementById: (id) => (id === 'app' ? app : null), documentElement: { dataset: { theme: 'light' } }, querySelector: () => null, activeElement: null },
      window: { APP_NAME: 'ReqAlign', addEventListener: () => {}, BOOT: { path: '/abgleich', promise: { then: (fn) => { const r = fn(JSON.stringify(ctx)); return { then: (g) => { g(r); return { catch: () => {} }; } }; } } } } };
    sandbox.google = undefined;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return app.innerHTML;
  };
  const full = drawn(false);
  assert.ok(/ADF-1021/.test(full) && /id="markup"/.test(full) && /h-verdict/.test(full), full.slice(0, 300));
  assert.strictEqual(drawn(true), full);
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


// ---------- BigQuery (Nachbildung: erkennt jede Anweisung an ihrem „-- op:“-Etikett) ----------

function fakeBigQuery(db, calls) {
  db.chunks = db.chunks || [];
  const T = (d) => (d ? String(new Date(d).getTime() / 1000) : null);
  const out = (fields, rows) => ({ code: 200, text: JSON.stringify({ jobComplete: true,
    schema: { fields: fields.map(([name, type, mode]) => ({ name, type, mode: mode || 'NULLABLE' })) },
    rows: rows.map((r) => ({ f: fields.map(([n, type, mode]) => ({ v: mode === 'REPEATED' ? (r[n] || []).map((x) => ({ v: String(x) }))
      : r[n] === null || r[n] === undefined ? null : type === 'TIMESTAMP' ? T(r[n]) : String(r[n]) })) })) }) });
  const ISSUE = [['key', 'STRING'], ['summary', 'STRING'], ['description', 'STRING'], ['status', 'STRING'], ['reporter', 'STRING'],
    ['updated', 'TIMESTAMP'], ['url', 'STRING'], ['stream', 'STRING'], ['epic', 'STRING'], ['issue_type', 'STRING'],
    ['created', 'TIMESTAMP'], ['resolved', 'TIMESTAMP'], ['board_scope', 'STRING']];
  const quant = (values, n) => { const v = values.slice().sort((x, y) => x - y); return Array.from({ length: n + 1 }, (_, i) => (v.length ? v[Math.min(v.length - 1, Math.floor((i / n) * v.length))] : 0)); };
  return (url, req) => {
    const body = JSON.parse(req.payload);
    const p = {};
    (body.queryParameters || []).forEach((q) => {
      p[q.name] = q.parameterType.type === 'ARRAY' ? q.parameterValue.arrayValues.map((x) => +x.value) : q.parameterValue.value === undefined ? null : q.parameterValue.value;
    });
    const op = /-- op: ([\w-]+)/.exec(body.query)[1];
    calls.push({ op, sql: body.query, params: p, url, headers: req.headers });
    const table = /-(issues|pages)$/.exec(op);
    const keyCol = table && table[1] === 'issues' ? 'key' : 'id';
    const rows = table ? db[table[1]] : null;
    const titleOf = (r) => (table[1] === 'issues' ? r.summary : r.title) || '';
    const bodyOf = (r) => (table[1] === 'issues' ? r.description : r.body) || '';
    if (op === 'schema') return out([], []);
    if (op === 'state-read') return out([['source', 'STRING'], ['mark', 'TIMESTAMP'], ['last_run', 'TIMESTAMP'], ['last_full', 'TIMESTAMP'],
      ['ok', 'BOOL'], ['note', 'STRING'], ['row_count', 'INT64']], Object.values(db.state));
    if (op === 'state-write') { db.state[p.source] = { source: p.source, mark: p.mark, last_run: p.last_run, last_full: p.last_full, ok: p.ok === 'true', note: p.note, row_count: +p.rows }; return out([], []); }
    if (op.startsWith('existing-')) {
      const keys = JSON.parse(p.keys);
      return out([['k', 'STRING'], ['text_hash', 'STRING'], ['emb_model', 'STRING']],
        rows.filter((r) => keys.includes(r[keyCol])).map((r) => ({ k: r[keyCol], text_hash: r.text_hash, emb_model: r.emb_model })));
    }
    if (op.startsWith('merge-')) {
      JSON.parse(p.rows).forEach((r) => {
        const old = rows.find((x) => x[keyCol] === r[keyCol]);
        const row = Object.assign({}, r, { synced_at: p.run, emb_model: r.emb_model === null ? (old ? old.emb_model : null) : r.emb_model });
        if (old) Object.assign(old, row); else rows.push(row);
      });
      return out([], []);
    }
    if (op.startsWith('prune-')) { const keep = JSON.parse(p.keys); db[table[1]] = rows.filter((r) => keep.includes(r[keyCol])); return out([], []); }
    if (op === 'chunks-delete') { const ids = JSON.parse(p.ids); db.chunks = db.chunks.filter((c) => !(c.source === p.source && ids.includes(c.doc_id))); return out([], []); }
    if (op === 'chunks-insert') { JSON.parse(p.rows).forEach((r) => db.chunks.push(Object.assign({}, r, { synced_at: p.run }))); return out([], []); }
    if (op === 'chunks-prune') { const keep = JSON.parse(p.keys); db.chunks = db.chunks.filter((c) => c.source !== p.source || keep.includes(c.doc_id)); return out([], []); }
    if (op.startsWith('backfill-')) {
      return out([['k', 'STRING'], ['title', 'STRING'], ['body', 'STRING']], rows.filter((r) => !r.text_hash || r.emb_model !== p.marker).slice(0, +p.n)
        .map((r) => ({ k: r[keyCol], title: titleOf(r), body: bodyOf(r) })));
    }
    if (op.startsWith('mark-')) {
      JSON.parse(p.rows).forEach((x) => { const r = rows.find((y) => y[keyCol] === x.k); if (r) Object.assign(r, { emb_model: p.marker, text_hash: x.text_hash }); });
      return out([], []);
    }
    if (op === 'search-issues') return out(ISSUE, db.issues.filter((r) => r.in_search));
    if (op === 'dashboard-issues') return out(ISSUE, db.issues.filter((r) => r.in_country || r.in_search)
      .map((r) => Object.assign({}, r, { stream: r.in_country ? null : r.stream, board_scope: r.in_country ? 'adfcr' : r.board_scope || r.stream })));
    if (op === 'pages') return out([['id', 'STRING'], ['title', 'STRING'], ['body', 'STRING'], ['space', 'STRING'], ['url', 'STRING']], db.pages);
    if (op === 'docs-by-id') {
      const keys = JSON.parse(p.keys);
      return out([['id', 'STRING'], ['title', 'STRING'], ['body', 'STRING']], db.issues.filter((r) => keys.includes(r.key)).map((r) => ({ id: r.key, title: r.summary, body: r.description })));
    }
    if (op === 'hybrid-search') {
      // Rechnet wie die Abfrage: BM25 über die Wortstämme, Kosinus über die Vektoren, je Weg die besten @pool, RRF.
      const sources = JSON.parse(p.sources), terms = p.terms ? JSON.parse(p.terms) : [];
      const pool = db.chunks.filter((c) => sources.includes(c.source));
      const tfs = pool.map((c) => { const tf = {}; c.terms.forEach((x) => { if (terms.includes(x)) tf[x] = (tf[x] || 0) + 1; }); return tf; });
      const df = {}; tfs.forEach((tf) => Object.keys(tf).forEach((x) => { df[x] = (df[x] || 0) + 1; }));
      const avgdl = pool.reduce((s, c) => s + c.n_terms, 0) / (pool.length || 1) || 1;
      const rank = (list) => list.sort((x, y) => y.score - x.score || (x.c.chunk_id < y.c.chunk_id ? -1 : 1)).slice(0, +p.pool).map((x, i) => Object.assign(x, { r: i + 1 }));
      const lex = /lexr AS/.test(body.query) ? rank(pool.map((c, i) => ({ c, cov: Object.keys(tfs[i]).length / +p.nq,
        score: Object.keys(tfs[i]).reduce((s, x) => s + Math.log(1 + (pool.length - df[x] + 0.5) / (df[x] + 0.5)) * tfs[i][x] * 2.2 / (tfs[i][x] + 1.2 * (0.25 + 0.75 * c.n_terms / avgdl)), 0) }))
        .filter((x) => x.cov > 0)) : [];
      const dotp = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
      const vec = /vecr AS/.test(body.query) ? rank(pool.filter((c) => c.emb_model === p.model && c.embedding.length === +p.dim).map((c) => ({ c, score: dotp(c.embedding, p.q) }))) : [];
      const fused = new Map();
      lex.forEach((x) => fused.set(x.c.chunk_id, { c: x.c, rrf: 1 / (+p.rrf + x.r), lex: x.score, cov: x.cov, vec: null }));
      vec.forEach((x) => { const f = fused.get(x.c.chunk_id) || { c: x.c, rrf: 0, lex: null, cov: 0, vec: null }; f.rrf += 1 / (+p.rrf + x.r); f.vec = x.score; fused.set(x.c.chunk_id, f); });
      const res = [...fused.values()].sort((x, y) => y.rrf - x.rrf || (x.c.chunk_id < y.c.chunk_id ? -1 : 1)).slice(0, +p.k).map((f) => {
        const i = f.c.source === 'jira' ? db.issues.find((r) => r.key === f.c.doc_id) : null;
        const pg = f.c.source === 'confluence' ? db.pages.find((r) => r.id === f.c.doc_id) : null;
        return { chunk_id: f.c.chunk_id, source: f.c.source, doc_id: f.c.doc_id, chunk_no: f.c.chunk_no, heading: f.c.heading, text: f.c.text, rrf: f.rrf, lex: f.lex,
          cov: f.cov, vec: f.vec, title: i ? i.summary : pg ? pg.title : null, url: i ? i.url : pg ? pg.url : null, status: i ? i.status : null,
          stream: i ? i.stream : null, epic: i ? i.epic : null, space: pg ? pg.space : null, updated: i ? i.updated : null };
      });
      return out([['chunk_id', 'STRING'], ['source', 'STRING'], ['doc_id', 'STRING'], ['chunk_no', 'INT64'], ['heading', 'STRING'], ['text', 'STRING'],
        ['rrf', 'FLOAT64'], ['lex', 'FLOAT64'], ['cov', 'FLOAT64'], ['vec', 'FLOAT64'], ['title', 'STRING'], ['url', 'STRING'], ['status', 'STRING'],
        ['stream', 'STRING'], ['epic', 'STRING'], ['space', 'STRING'], ['updated', 'TIMESTAMP']], res);
    }
    if (op === 'eda-issues' || op === 'eda-pages') {
      const seen = new Set(rows.map((r) => titleOf(r).trim().toLowerCase()));
      return out([['docs', 'INT64'], ['empty', 'INT64'], ['dup_titles', 'INT64'], ['q', 'INT64', 'REPEATED']],
        [{ docs: rows.length, empty: rows.filter((r) => !bodyOf(r).trim()).length, dup_titles: rows.length - seen.size, q: quant(rows.map((r) => bodyOf(r).length), 100) }]);
    }
    if (op.startsWith('eda-sample-')) return out([['title', 'STRING'], ['body', 'STRING']], rows.slice(0, +p.n).map((r) => ({ title: titleOf(r), body: bodyOf(r).slice(0, +p.cap) })));
    if (op === 'eda-groups') {
      const res = [];
      const tally = (kind, list, key) => { const m = {}; list.forEach((r) => { const k = r[key] || '(ohne)'; m[k] = (m[k] || 0) + 1; }); Object.keys(m).forEach((k) => res.push({ kind, name: k, n: m[k] })); };
      tally('stream', db.issues, 'stream'); tally('status', db.issues, 'status'); tally('space', db.pages, 'space');
      return out([['kind', 'STRING'], ['name', 'STRING'], ['n', 'INT64']], res);
    }
    if (op === 'eda-chunks') {
      return out([['source', 'STRING'], ['chunks', 'INT64'], ['docs', 'INT64'], ['embedded', 'INT64'], ['q', 'INT64', 'REPEATED']], ['jira', 'confluence'].map((s) => {
        const mine = db.chunks.filter((c) => c.source === s);
        return { source: s, chunks: mine.length, docs: new Set(mine.map((c) => c.doc_id)).size, embedded: mine.filter((c) => c.embedding.length).length, q: quant(mine.map((c) => c.text.length), 4) };
      }).filter((r) => r.chunks));
    }
    throw new Error('Unbekannte BigQuery-Anweisung: ' + op);
  };
}

const BQ = Object.assign({}, LIVE, { BQ_DATASET: 'reqalign', CONFLUENCE_EXPORT_FOLDER_ID: 'ordner1', JIRA_BOARD_ADFCR: '42249' });
const EXPORT_HTML = (title, body) => `<html><head><title>ADINT : ${title}</title></head><body><div id="breadcrumbs">Start</div>` +
  `<div id="main-content" class="wiki-content group"><p>${body}</p></div><div class="pageSection group">Anhänge</div></body></html>`;

function bqWorld(extra) {
  const db = { issues: [], pages: [], chunks: [], state: {} };
  const log = [], calls = [];
  const systems = fakeSystems(log);
  const bq = fakeBigQuery(db, calls);
  const board = [{ key: 'ADFCR-7', fields: { summary: 'Feiertage im Bestellvorschlag', description: 'Land AT braucht Feiertage',
    status: { name: 'NEW REQUIREMENT' }, reporter: { emailAddress: 'chris@firma.de' }, updated: '2026-11-02T09:00:00.000+0100',
    created: '2026-11-01T09:00:00.000+0100', resolutiondate: null, components: [], issuetype: { name: 'Story' } } }];
  const fetch = (url, req) => {
    if (url.startsWith('https://bigquery.googleapis.com/')) return bq(url, req);
    if (url.indexOf('/rest/agile/1.0/board/42249/issue') >= 0) { log.push({ url, req }); return { code: 200, text: JSON.stringify({ total: board.length, issues: board }) }; }
    return systems(url, req);
  };
  const drive = { ordner1: [{ name: 'ADINT-export.zip', updated: new Date('2026-11-01T08:00:00Z'), entries: [
    { name: 'ADINT/index.html', text: '<html><title>Index</title></html>' },
    { name: 'ADINT/Feiertagslogik_123456.html', text: EXPORT_HTML('Feiertagslogik', 'Feiertage je Land werden im Bestellvorschlag berücksichtigt &amp; gepflegt.') }] },
  { name: 'Leitfaden.doc', updated: new Date('2026-10-01T08:00:00Z'),
    text: 'MIME-Version: 1.0\nContent-Transfer-Encoding: quoted-printable\n\n<html><head><title>ADINT : Leitfaden Tickets</title></head><body>Gr=C3=BC=\nnde f=C3=BCr Tickets</body></html>' }] };
  const rt = createRuntime(Object.assign({ scriptProperties: BQ, fetch, email: 'chris@firma.de', drive }, extra || {}));
  return { rt, db, log, calls, board };
}

test('BigQuery-Abgleich: Jira und Confluence-Export landen mit Vektoren im eigenen Datensatz, Auslöser alle 15 Minuten', () => {
  const { rt, db, log, calls } = bqWorld();
  const report = rt.abgleichEinrichten();
  assert.ok(report.ok, JSON.stringify(report));
  assert.deepStrictEqual(rt.__triggers.map((t) => [t.fn, t.minutes]), [['abgleich', 15]]);
  assert.deepStrictEqual(db.issues.map((i) => [i.key, i.in_search, i.in_country]).sort(), [['ADF-1', true, false], ['ADFCR-7', false, true]]);
  const MARK = 'text-multilingual-embedding-002|v1|1200|150';
  assert.ok(db.issues.every((i) => i.text_hash && i.emb_model === MARK), JSON.stringify(db.issues.map((i) => [i.text_hash, i.emb_model])));
  assert.deepStrictEqual(db.chunks.map((c) => c.chunk_id).sort(), ['confluence:123456#0', 'confluence:Leitfaden#0', 'jira:ADF-1#0', 'jira:ADFCR-7#0']);
  assert.ok(db.chunks.every((c) => c.embedding.length === 8 && c.emb_model === 'text-multilingual-embedding-002' && c.terms.length === c.n_terms && c.n_terms > 0));
  assert.ok(db.chunks.find((c) => c.doc_id === 'ADFCR-7').terms.includes('feiertag'), 'Wortstämme aus Titel und Text');
  assert.deepStrictEqual(db.pages.map((p) => [p.id, p.title, p.space]).sort(), [['123456', 'Feiertagslogik', 'ADINT'], ['Leitfaden', 'Leitfaden Tickets', 'ADINT']]);
  assert.strictEqual(db.pages.find((p) => p.id === '123456').body, 'Feiertage je Land werden im Bestellvorschlag berücksichtigt & gepflegt.');
  assert.strictEqual(db.pages.find((p) => p.id === '123456').url, 'https://wiki.firma.de/pages/viewpage.action?pageId=123456');
  assert.strictEqual(db.pages.find((p) => p.id === 'Leitfaden').body, 'Gründe für Tickets');
  assert.strictEqual(db.state.jira.ok, true);
  assert.ok(/Vollabgleich: 2 Tickets/.test(db.state.jira.note), db.state.jira.note);
  // Jira nur GET, BigQuery nur über den Abfrage-Endpunkt mit Google-Token und Projekt
  assert.ok(log.filter((l) => /jira\.firma\.de/.test(l.url)).every((l) => l.req.method === 'get'));
  assert.ok(calls.every((c) => c.url === 'https://bigquery.googleapis.com/bigquery/v2/projects/mein-projekt-123/queries' && c.headers.Authorization === 'Bearer test-token'));
  assert.ok(calls.every((c) => !/ADFCR-7|Feiertag/.test(c.sql)), 'Daten nur als Parameter, nie im SQL-Text');
});

test('BigQuery-Abgleich: Teilabgleich fragt nur Änderungen ab und bettet nur geänderte Texte neu ein', () => {
  const { rt, db, log, calls, board } = bqWorld();
  rt.abgleichEinrichten();
  const predicts = () => log.filter((l) => /:predict$/.test(l.url)).reduce((n, l) => n + JSON.parse(l.req.payload).instances.length, 0);
  const before = predicts();
  log.length = 0;
  board[0].fields.description = 'Land AT und CH brauchen Feiertage';
  rt.abgleich();
  const jql = log.filter((l) => /jira\.firma\.de/.test(l.url)).map((l) => decodeURIComponent(l.url.split('jql=')[1] || '').split('&')[0]);
  assert.ok(jql.length && jql.every((q) => /updated >= -1\dm/.test(q.replace(/\+/g, ' '))), jql.join(' | '));
  assert.ok(jql.some((q) => /^\(project = ADF\) AND updated >= -\d+m ORDER BY updated DESC$/.test(q.replace(/\+/g, ' '))), jql.join(' | '));
  assert.strictEqual(predicts(), 1, 'nur das geänderte Ticket (Confluence-Ordner unverändert)');
  assert.ok(before >= 4);
  assert.strictEqual(db.issues.find((i) => i.key === 'ADFCR-7').description, 'Land AT und CH brauchen Feiertage');
  assert.ok(/Teilabgleich/.test(db.state.jira.note));
  assert.ok(!calls.slice(-6).some((c) => c.op === 'prune-issues'), 'Teilabgleich löscht nichts');
});

test('BigQuery-Modus: Seiten lesen aus BigQuery, Suche rechnet dort (nur die Anfrage geht an Vertex)', () => {
  const { rt, log, calls } = bqWorld();
  rt.abgleichEinrichten();
  rt.__cache.advance(99999);
  log.length = 0; calls.length = 0;
  const dash = call(rt, 'GET', '/').ctx;
  assert.strictEqual(dash.issues_error, null);
  assert.ok(!log.some((l) => /rest\/agile|rest\/api\/2\/search\?jql=project/.test(l.url)), 'Übersicht ohne Jira-Abfrage der Boards');
  const ans = call(rt, 'POST', '/wissen', { frage: ['Feiertage im Bestellvorschlag'] }).ctx.answer;
  assert.ok(ans.sources.length, JSON.stringify(ans));
  assert.ok(ans.sources.some((s) => s.source === 'confluence' && s.id === '123456'), JSON.stringify(ans.sources.map((s) => s.id)));
  const embeds = log.filter((l) => /:predict$/.test(l.url)).map((l) => JSON.parse(l.req.payload).instances.length);
  assert.deepStrictEqual(embeds, [1, 1], 'Verbindungstest und die Frage, sonst nichts');
  assert.ok(calls.some((c) => c.op === 'hybrid-search'));
  const admin = call(rt, 'GET', '/admin').ctx;
  assert.ok(admin.checks.some((c) => c[0] === 'Abgleich Jira' && c[1] === true), JSON.stringify(admin.checks));
});

test('BigQuery-Sperre: nur eigener Datensatz, kein DROP/TRUNCATE/ALTER, eine Anweisung, nichts geht raus', () => {
  const { rt, calls } = bqWorld();
  const bq = new rt.BigQueryClient(rt.loadSettings());
  const bad = ['DROP TABLE `mein-projekt-123.reqalign.issues`', 'TRUNCATE TABLE `mein-projekt-123.reqalign.issues`',
    'DELETE FROM `anderes-projekt.daten.kunden` WHERE true', 'SELECT * FROM `mein-projekt-123.anderer.issues`',
    'DELETE FROM `mein-projekt-123.reqalign.issues` WHERE true; DROP TABLE `mein-projekt-123.reqalign.pages`',
    'CREATE OR REPLACE TABLE `mein-projekt-123.reqalign.x` AS SELECT 1', 'ALTER TABLE `mein-projekt-123.reqalign.issues` ADD COLUMN x STRING',
    'GRANT `roles/bigquery.dataViewer` ON TABLE `mein-projekt-123.reqalign.issues` TO "user:x@y.de"', 'UPDATE issues SET key = 1',
    'DELETE FROM issues WHERE true'];
  bad.forEach((sql) => assert.throws(() => bq.query(sql), (e) => e instanceof rt.WriteDisabled && /BigQuery-Sperre/.test(e.message), sql));
  assert.strictEqual(calls.length, 0);
  assert.throws(() => rt.requestJson('POST', 'https://bigquery.googleapis.com/bigquery/v2/projects/p/datasets', { json: {} }), rt.WriteDisabled);
  assert.throws(() => rt.requestJson('POST', 'https://bigquery.googleapis.com/bigquery/v2/projects/p/queries/x', { json: {} }), rt.WriteDisabled);
  assert.throws(() => rt.loadSettings() && new rt.BigQueryClient(Object.assign(rt.loadSettings(), { bqDataset: 'a.b' })), /BQ_DATASET/);
});

test('BigQuery-Abgleich: fällt Jira aus, läuft Confluence trotzdem; der Stand nennt den Fehler', () => {
  const db = { issues: [], pages: [], chunks: [], state: {} };
  const drive = { ordner1: [{ name: 'Seite_555.html', updated: new Date('2026-11-01T08:00:00Z'), text: EXPORT_HTML('Seite', 'Inhalt der Seite') }] };
  const rt = createRuntime({ scriptProperties: BQ, email: 'chris@firma.de', drive,
    fetch: (url, req) => (url.indexOf('jira.firma.de') >= 0 ? { code: 503, text: '' } : url.startsWith('https://bigquery.googleapis.com/')
      ? fakeBigQuery(db, [])(url, req) : fakeSystems([])(url, req)) });
  const rep = rt.abgleichVoll();
  assert.strictEqual(rep.ok, false);
  assert.strictEqual(db.state.jira.ok, false);
  assert.ok(/HTTP 503/.test(db.state.jira.note), db.state.jira.note);
  assert.strictEqual(db.state.confluence.ok, true, 'Confluence lief trotzdem');
  assert.deepStrictEqual(db.pages.map((p) => p.id), ['555']);
});


test('Confluence-Test: probiert Anmeldewege nur mit GET, nennt den passenden und keinen Token', () => {
  const seen = [];
  const rt = createRuntime({ scriptProperties: LIVE, fetch: (url, req) => {
    seen.push([req.method, req.followRedirects, req.headers['clientless-mode'] || '']);
    if (req.headers['clientless-mode'] === '3') return { code: 200, text: '{"results":[]}' };
    return { code: 302, text: '', headers: { Location: 'https://wiki.firma.de/my.policy?x=1', Server: 'BigIP' } };
  } });
  const lines = rt.testConfluence();
  assert.ok(seen.every(([m, f]) => m === 'get' && f === false));
  assert.ok(lines.some((l) => /leitet weiter nach https:\/\/wiki\.firma\.de\/my\.policy, Server BigIP/.test(l)), lines.join('\n'));
  assert.ok(/CONFLUENCE_CLIENTLESS = 3/.test(lines[lines.length - 1]), lines.join('\n'));
  assert.ok(!lines.join(' ').includes('pat-c'));
  const rt2 = createRuntime({ scriptProperties: Object.assign({}, LIVE, { CONFLUENCE_CLIENTLESS: '3' }), fetch: (url, req) => {
    seen.push(['live', req.headers['clientless-mode']]);
    return { code: 200, text: JSON.stringify({ results: [{ id: '7', title: 'A', body: { storage: { value: 'x' } }, _links: { webui: '/x/7' } }] }) };
  } });
  assert.strictEqual(rt2.buildContainer().confluence.pages().length, 1);
  assert.deepStrictEqual(seen[seen.length - 1], ['live', '3']);
});


test('Confluence-Knopf (startet)', () => {
  const vmod = require('vm');
  const { knopfCode, page } = require('./knopf-page');
  const calls = [];
  const all = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, title: 'Seite ' + i, body: { storage: { value: '<p>Text ' + i + ' &amp; mehr</p><script>x()</script>' } },
    _links: { webui: '/pages/viewpage.action?pageId=' + (1000 + i) }, version: { when: '2026-11-01T10:00:00Z' } }));
  let saved = null, shown = '';
  const el = () => ({ style: {}, set textContent(v) { shown = v; }, get textContent() { return shown; }, remove() {}, click() { saved = this.download; } });
  const sandbox = {
    window: { AJS: { contextPath: () => '/wiki' } }, AJS: { contextPath: () => '/wiki' }, location: { origin: 'https://wiki.firma.de' },
    prompt: (q, def) => def, setTimeout: () => {}, console,
    document: { createElement: el, body: { appendChild: () => {} } },
    URL: { createObjectURL: () => 'blob:x' },
    Blob: function (parts) { this.text = parts.join(''); sandbox.__blob = this.text; },
    fetch: async (url, opt) => {
      calls.push([opt.method, opt.credentials, url]);
      const u = new URL(url, 'https://wiki.firma.de');
      const st = +u.searchParams.get('start'), lim = +u.searchParams.get('limit');
      return { ok: true, status: 200, json: async () => ({ results: all.slice(st, st + lim) }) };
    },
  };
  vmod.createContext(sandbox);
  pendingAsync.push(vmod.runInContext(knopfCode('ADF').replace(/\}\)\(\);\s*$/, '})()'), sandbox).then(() => {
    assert.ok(calls.length === 3 && calls.every(([m, c, u]) => m === 'GET' && c === 'same-origin' && u.startsWith('/wiki/rest/api/content?')), JSON.stringify(calls));
    assert.strictEqual(saved, 'confluence-ADF-' + new Date().toISOString().slice(0, 10) + '.json');
    const pages = createRuntime({}).confluenceJsonPages_(sandbox.__blob, 'x.json');
    assert.strictEqual(pages.length, 120);
    assert.ok(!/<|x\(\)/.test(JSON.parse(sandbox.__blob).pages[0].body), 'nur Text, ohne HTML und Skript');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(pages[0])), { id: '1000', title: 'Seite 0', body: 'Text 0 & mehr', space: 'ADF', url: 'https://wiki.firma.de/wiki/pages/viewpage.action?pageId=1000' });
    assert.ok(/href="javascript:/.test(page('ADF')) && !/<script/i.test(page('ADF').replace(/&lt;script/g, '')));
    // Als Lesezeichen steht der Code in einer Zeile: er muss dann noch gültig sein (kein Zeilenkommentar frisst den Rest).
    const href = /href="(javascript:[^"]+)"/.exec(page('ADF'))[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&quot;/g, '"');
    const oneLine = decodeURIComponent(href.slice('javascript:'.length));
    assert.ok(!/\n/.test(oneLine));
    new vmod.Script(oneLine);
    assert.ok(/await fetch\(/.test(oneLine) && /a\.click\(\)/.test(oneLine), 'Code vollständig');
    console.log('ok   Confluence-Knopf: liest im Browser nur mit GET (alle Seiten), Datei wird von der App gelesen');
  }).catch((err) => { failed += 1; console.log('FAIL Confluence-Knopf\n     ' + (err.stack || err)); }));
});

test('Ohne BigQuery: Confluence kommt aus dem Drive-Ordner (Knopf-Datei, neueste gilt), Wissen findet es', () => {
  const file = (body, d) => ({ name: 'confluence-ADF-' + d + '.json', updated: new Date(d + 'T10:00:00Z'),
    text: JSON.stringify({ format: 'confluence-pages', space: 'ADF', pages: [{ id: '9', title: 'Feiertage', body: '<p>' + body + '</p>', url: 'https://wiki.firma.de/x/9' }] }) });
  const rt = createRuntime({ scriptProperties: Object.assign({}, LIVE, { CONFLUENCE_EXPORT_FOLDER_ID: 'o' }), fetch: fakeSystems([]), email: 'chris@firma.de',
    drive: { o: [file('alt', '2026-10-01'), file('Feiertage je Land im Bestellvorschlag', '2026-11-03')] } });
  const pages = rt.buildContainer().confluence.pages();
  assert.strictEqual(pages.length, 1);
  assert.strictEqual(pages[0].body, 'Feiertage je Land im Bestellvorschlag');
  const ans = call(rt, 'POST', '/wissen', { frage: ['Feiertage je Land'] }).ctx.answer;
  assert.ok(ans.sources.some((x) => x.source === 'confluence' && x.id === '9'), JSON.stringify(ans.sources));
});

test('BigQuery-Abgleich: großer Bestand verteilt sich auf mehrere Läufe (Budget), nichts doppelt eingebettet', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(500 + i), title: 'Seite ' + i, body: '<p>Inhalt Nummer ' + i + ' Bestellung</p>', url: 'https://wiki.firma.de/x/' + i }));
  const { rt, db, log } = bqWorld({ drive: { ordner1: [{ name: 'confluence-ADF-2026-11-03.json', updated: new Date('2026-11-03T10:00:00Z'),
    text: JSON.stringify({ format: 'confluence-pages', space: 'ADF', pages: many }) }] } });
  rt.BQ_EMBED_PER_RUN_ = 10;
  const embedded = () => log.filter((l) => /:predict$/.test(l.url)).reduce((n, l) => n + JSON.parse(l.req.payload).instances.length, 0);
  rt.abgleichEinrichten();
  assert.strictEqual(db.pages.length, 30, 'alle Seiten gespeichert');
  assert.strictEqual(db.chunks.filter((c) => c.source === 'confluence' && c.embedding.length).length, 8, '10 Vektoren je Lauf, 2 davon für Jira');
  assert.strictEqual(db.pages.filter((p) => p.text_hash).length, 8, 'Fingerabdruck nur, wo die Chunks geschrieben sind');
  for (let i = 0; i < 4; i++) rt.abgleich();
  assert.strictEqual(db.pages.filter((p) => p.text_hash).length, 30, 'nach weiteren Läufen alles da');
  assert.strictEqual(db.chunks.filter((c) => c.source === 'confluence' && c.embedding.length).length, 30);
  const total = embedded();
  rt.abgleichVoll();
  assert.strictEqual(embedded() - total, 0, 'Vollabgleich bettet nichts erneut ein');
  assert.ok(/Seiten/.test(rt.syncSummary_({ ok: true, jira: 1, confluence: 30, embedded: 0, notes: [] })));
});

// ---------- Abgleich: Chunking, Hybrid-Suche, Reranker, Streams, Datenanalyse ----------

test('Chunking: trennt an Überschriften, legt kleine Abschnitte zusammen, teilt lange mit Überlappung', () => {
  const rt = createRuntime({});
  const cfg = { chars: 400, overlap: 60 };
  const jira = 'Vorwort zum Ticket.\nh3. 1. Ziel\nAls Disponent möchte ich Feiertage sehen.\n# erster Punkt\n# zweiter Punkt\nh3. 2. Mehrwert\nWeniger Abschriften.';
  const secs = rt.sections_(jira, 'jira');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(secs.map((s) => [s.path, s.text]))), [['', 'Vorwort zum Ticket.'],
    ['1. Ziel', 'Als Disponent möchte ich Feiertage sehen.\n# erster Punkt\n# zweiter Punkt'], ['2. Mehrwert', 'Weniger Abschriften.']], '„# “ ist in Jira eine Liste, keine Überschrift');
  const small = rt.chunkDoc_({ source: 'jira', title: 'Feiertage', body: jira }, cfg);
  assert.strictEqual(small.length, 1, 'kurzes Ticket bleibt ein Chunk');
  assert.ok(small[0].embed_text.startsWith('Feiertage\n') && /2\. Mehrwert\nWeniger Abschriften\./.test(small[0].text));
  const long = 'h2. Regeln\n' + Array.from({ length: 30 }, (_, i) => 'Satz Nummer ' + i + ' beschreibt eine Regel für den Bestellvorschlag.').join(' ') + '\nh2. Ausnahmen\nKeine.';
  const chunks = rt.chunkDoc_({ source: 'jira', title: 'Lang', body: long }, cfg);
  assert.ok(chunks.length >= 4, String(chunks.length));
  assert.ok(chunks.every((c) => c.text.length <= cfg.chars + cfg.overlap + 10), JSON.stringify(chunks.map((c) => c.text.length)));
  assert.ok(chunks.slice(0, -1).every((c) => c.heading === 'Regeln'));
  assert.ok(chunks[1].text.startsWith('… ') && chunks[0].text.includes(chunks[1].text.slice(2, 30)), 'Überlappung mit dem Ende des vorigen Stücks');
  assert.ok(chunks.every((c) => c.embed_text.startsWith('Lang › ')), 'Titel und Überschrift stehen in jedem Chunk');
  for (let i = 0; i < 30; i++) assert.ok(chunks.some((c) => c.text.includes('Satz Nummer ' + i + ' ')), 'kein Satz geht verloren: ' + i);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rt.chunkDoc_({ source: 'jira', title: 'Nur Titel', body: '' }, cfg))),
    [{ chunk_no: 0, heading: '', text: '', embed_text: 'Nur Titel' }]);
  const giant = rt.chunkDoc_({ source: 'confluence', title: 'X', body: 'wort '.repeat(40000) }, cfg);
  assert.ok(giant.length <= 80, 'Obergrenze je Seite');
});

test('Confluence-HTML wird zu Text mit Aufbau: Überschriften, Absätze, Listen; verschachtelte Überschriften ergeben den Pfad', () => {
  const rt = createRuntime({});
  const text = rt.htmlToText_('<h1>Bestellung</h1><p>Erster   Absatz &amp; mehr.</p><h2>Feiertage</h2><ul><li>AT</li><li>CH</li></ul><script>x()</script><table><tr><td>a</td><td>b</td></tr></table>');
  assert.strictEqual(text, '# Bestellung\n\nErster Absatz & mehr.\n\n## Feiertage\n\n- AT\n- CH\n\na | b');
  assert.strictEqual(rt.htmlToText_('Zeile 1\n\n## Titel\nZeile 2 &amp; 3'), 'Zeile 1\n\n## Titel\nZeile 2 & 3', 'Text vom Knopf behält seine Zeilen');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rt.sections_(text, 'confluence').map((s) => s.path))), ['Bestellung', 'Bestellung › Feiertage']);
  assert.strictEqual(rt.htmlToText_(null), '');
});

const RANK_URL = 'https://discoveryengine.googleapis.com/v1/projects/mein-projekt-123/locations/global/rankingConfigs/default_ranking_config:rank';

/** Welt mit BigQuery, mehreren Tickets (Streams/Epics) und einem Reranker nach Wahl. */
function ragWorld(opts) {
  opts = opts || {};
  const w = bqWorld({ scriptProperties: Object.assign({}, BQ, opts.props || {}) });
  const mk = (key, summary, description, comp, epic) => ({ key, fields: { summary, description, status: { name: 'NEW REQUIREMENT' },
    reporter: { emailAddress: 'a@firma.de' }, updated: '2026-11-02T09:00:00.000+0100', created: '2026-11-01T09:00:00.000+0100', resolutiondate: null,
    components: comp ? [{ name: comp }] : [], issuetype: { name: 'Story' }, customfield_10008: epic || null } });
  w.board.length = 0;
  w.board.push(
    mk('ADFCR-7', 'Feiertage im Bestellvorschlag', 'h3. 1. Ziel\nLand AT braucht Feiertage im Bestellvorschlag.\nh3. 2. Mehrwert\nWeniger Abschriften an Feiertagen.', 'Disposition', 'ADF-100'),
    mk('ADFCR-8', 'Bestellvorschlag an Feiertagen anpassen', 'h3. 1. Ziel\nFeiertage je Land im Bestellvorschlag berücksichtigen.\nh3. 2. Mehrwert\nKeine Überbestände.', 'Disposition', 'ADF-100'),
    mk('ADFCR-9', 'Leergut Rücknahme', 'Pfandflaschen am Automaten zählen', 'Logistik', 'ADF-200'));
  return w;
}
const withRanker = (w, handler, log) => {
  const inner = w.rt.UrlFetchApp.fetch;
  w.rt.UrlFetchApp.fetch = (url, req) => {
    if (url.startsWith('https://discoveryengine.googleapis.com/')) {
      log.push({ url, req });
      const r = handler(JSON.parse(req.payload));
      return { getResponseCode: () => r.code, getContentText: () => r.text, getHeaders: () => ({}) };
    }
    return inner(url, req);
  };
};
const WISH = 'Wir brauchen im Bestellvorschlag die Feiertage je Land, damit an Feiertagen nicht zu viel bestellt wird.';

test('Abgleich mit BigQuery: Hybrid-Suche (Stichwörter + Vektor) in einer Abfrage, Reranker ordnet, Treffer je Ticket', () => {
  const w = ragWorld();
  const ranks = [];
  withRanker(w, (body) => ({ code: 200, text: JSON.stringify({ records: body.records.map((r) => ({ id: r.id, score: /ADFCR-8/.test(r.id) ? 0.97 : /ADFCR-7/.test(r.id) ? 0.9 : 0.02 })) }) }), ranks);
  w.rt.abgleichEinrichten();
  w.calls.length = 0; w.log.length = 0;
  const ctx = call(w.rt, 'POST', '/abgleich', { text: [WISH] }).ctx;
  assert.strictEqual(ctx.error, null);
  const res = ctx.result;
  assert.deepStrictEqual([res.search.lexical, res.search.vector, res.search.reranker], [true, true, 'ranking']);
  assert.deepStrictEqual(res.hits.slice(0, 2).map((h) => h.id), ['ADFCR-8', 'ADFCR-7'], 'Reihenfolge vom Reranker');
  assert.ok(res.hits.every((h) => ['duplicate', 'similar', 'related'].includes(h.level) && h.passages.length >= 1 && h.score >= 0 && h.score <= 100));
  assert.ok(res.hits[0].by_keyword && res.hits[0].by_meaning);
  const search = w.calls.filter((c) => c.op === 'hybrid-search');
  assert.strictEqual(search.length, 1, 'eine Abfrage');
  assert.ok(/lexr AS/.test(search[0].sql) && /vecr AS/.test(search[0].sql) && /FULL OUTER JOIN/.test(search[0].sql));
  assert.ok(!/Feiertag|Bestellvorschlag/i.test(search[0].sql), 'Anfrage nur als Parameter');
  assert.ok(JSON.parse(search[0].params.terms).includes('feiertag'));
  // Reranker: genau die freigegebene Adresse, Google-Token, Projekt, Texte der Abschnitte
  assert.strictEqual(ranks.length, 1);
  assert.strictEqual(ranks[0].url, RANK_URL);
  assert.strictEqual(ranks[0].req.headers['x-goog-user-project'], 'mein-projekt-123');
  const sent = JSON.parse(ranks[0].req.payload);
  assert.strictEqual(sent.model, 'semantic-ranker-default@latest');
  assert.ok(sent.records.length >= 3 && sent.records.every((r) => r.id && r.title && r.content));
  // Jira und Confluence wurden für die Suche nicht angefasst
  assert.ok(!w.log.some((l) => /jira\.firma\.de|wiki\.firma\.de/.test(l.url)));
});

test('Abgleich: Streams und Epics kommen aus den ähnlichsten vorhandenen Tickets', () => {
  const w = ragWorld({ props: { RERANKER: 'none' } });
  w.rt.abgleichEinrichten();
  const res = call(w.rt, 'POST', '/abgleich', { text: [WISH], modus: ['pruefen'] }).ctx.result;
  assert.strictEqual(res.stream_basis, 'tickets');
  assert.strictEqual(res.streams[0].id, 'disposition');
  assert.strictEqual(res.streams[0].name, 'Disposition & Bestellung');
  assert.ok(res.streams[0].share > 50 && res.streams[0].examples.includes('ADFCR-7'), JSON.stringify(res.streams));
  assert.strictEqual(res.epics[0].id, 'ADF-100');
  assert.strictEqual(res.draft, null, 'Entwurf nur im Modus Wunsch');
  assert.strictEqual(res.search.reranker, 'none');
});

test('Wunsch: Entwurf im Aufbau der Vorgabemaske mit Stream und Epic, formuliert nach dem Vorbild ähnlicher Tickets', () => {
  const w = ragWorld({ props: { RERANKER: 'none' } });
  const inner = w.rt.UrlFetchApp.fetch;
  const prompts = [];
  w.rt.UrlFetchApp.fetch = (url, req) => {
    if (/:generateContent$/.test(url)) {
      prompts.push(JSON.parse(req.payload).contents[0].parts[0].text);
      const text = JSON.stringify({ title: 'Feiertage je Land im Bestellvorschlag', role: 'Disponent', goal: 'Feiertage je Land sehen', benefit: 'weniger Überbestand',
        acceptance_criteria: ['Feiertage je Land gepflegt'], priority: 'Mittel', open_questions: ['Welche Länder zuerst?'] });
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), getHeaders: () => ({}) };
    }
    return inner(url, req);
  };
  w.rt.abgleichEinrichten();
  const res = call(w.rt, 'POST', '/abgleich', { text: [WISH + ' Kontakt: max@firma.at'], modus: ['wunsch'], country: ['AT'] }).ctx.result;
  assert.strictEqual(res.draft.source, 'gemini');
  assert.ok(/h3\. 1\. Ziel der Anforderung/.test(res.draft.markup) && /Land: AT/.test(res.draft.markup));
  assert.ok(/Stream: Disposition & Bestellung/.test(res.draft.markup) && /Epic: ADF-100/.test(res.draft.markup), res.draft.markup);
  assert.deepStrictEqual(res.draft.open_questions, ['Welche Länder zuerst?']);
  assert.ok(res.guide.examples.length >= 2 && res.guide.examples[0].sections.includes('1. Ziel'), JSON.stringify(res.guide));
  assert.ok(res.guide.sections.some((s) => s.name === '2. Mehrwert' && s.n >= 2));
  assert.strictEqual(prompts.length, 1);
  assert.ok(/So sind ähnliche, vorhandene Tickets formuliert/.test(prompts[0]) && /h3\. 1\. Ziel/.test(prompts[0]), 'Vorbilder im Prompt');
  assert.ok(!/max@firma\.at/.test(prompts[0]) && /\[E-Mail\]/.test(prompts[0]), 'E-Mail-Adressen gehen nicht an die KI');
});

test('Reranker fällt aus: Gemini springt ein, sonst bleibt die Reihenfolge der Suche; der Hinweis nennt den Grund', () => {
  const w = ragWorld();
  const ranks = [];
  withRanker(w, () => ({ code: 403, text: '{"error":{"message":"Discovery Engine API has not been used"}}' }), ranks);
  const inner = w.rt.UrlFetchApp.fetch;
  let gemini = 0;
  w.rt.UrlFetchApp.fetch = (url, req) => {
    if (/:generateContent$/.test(url)) {
      gemini += 1;
      const list = JSON.parse(req.payload).contents[0].parts[0].text;
      const scores = {};
      list.split('\n').forEach((l) => { const m = /^\[(\d+)\] /.exec(l); if (m) scores[m[1]] = /Leergut/.test(l) ? 99 : 5; });
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ scores }) }] } }] }), getHeaders: () => ({}) };
    }
    return inner(url, req);
  };
  w.rt.abgleichEinrichten();
  const res = call(w.rt, 'POST', '/abgleich', { text: [WISH] }).ctx.result;
  assert.strictEqual(res.search.reranker, 'gemini');
  assert.ok(/Ranking API\) nicht erreichbar/.test(res.search.note) && /HTTP 403/.test(res.search.note), res.search.note);
  assert.strictEqual(res.hits.find((h) => h.id === 'ADFCR-9').rerank, 0.99);
  assert.strictEqual(gemini, 1);
  call(w.rt, 'POST', '/abgleich', { text: [WISH] });
  assert.strictEqual(ranks.length, 1, 'eine abgeschaltete API wird nicht bei jeder Suche erneut gefragt');
  // Ohne Gemini-Antwort: Reihenfolge der Suche, kein Absturz
  const w2 = ragWorld();
  withRanker(w2, () => ({ code: 500, text: 'kaputt' }), []);
  w2.rt.abgleichEinrichten();
  const res2 = call(w2.rt, 'POST', '/abgleich', { text: [WISH] }).ctx.result;
  assert.strictEqual(res2.search.reranker, 'none');
  assert.ok(res2.hits.length >= 2 && /Gemini als Reranker nicht nutzbar/.test(res2.search.note), res2.search.note);
});

test('Sperre: beim Reranker ist nur die Methode rank frei, sonst bleibt alles gesperrt', () => {
  const rt = createRuntime({ scriptProperties: LIVE, fetch: () => ({ code: 200, text: '{"records":[]}' }) });
  rt.requestJson('POST', RANK_URL, { json: {} });
  ['https://discoveryengine.googleapis.com/v1/projects/p/locations/global/collections/x/dataStores/y/documents',
    RANK_URL.replace(':rank', ':delete'), RANK_URL + '/x', RANK_URL.replace('https://', 'https://evil.example/'),
    'https://discoveryengine.googleapis.com.evil.example/v1/projects/p/locations/global/rankingConfigs/default_ranking_config:rank']
    .forEach((u) => assert.throws(() => rt.requestJson('POST', u, { json: {} }), rt.WriteDisabled, u));
  assert.throws(() => rt.requestJson('DELETE', RANK_URL, {}), rt.WriteDisabled);
});

test('Vertex fällt aus: die Suche läuft nur über Stichwörter weiter und sagt das', () => {
  const w = ragWorld({ props: { RERANKER: 'none' } });
  w.rt.abgleichEinrichten();
  const inner = w.rt.UrlFetchApp.fetch;
  w.rt.UrlFetchApp.fetch = (url, req) => (/:predict$/.test(url) ? { getResponseCode: () => 503, getContentText: () => '', getHeaders: () => ({}) } : inner(url, req));
  w.rt.UrlFetchApp.fetchAll = (reqs) => reqs.map((r) => w.rt.UrlFetchApp.fetch(r.url, r));
  w.rt.__cache.advance(99999);
  w.calls.length = 0;
  const ctx = call(w.rt, 'POST', '/abgleich', { text: [WISH] }).ctx;
  assert.deepStrictEqual([ctx.result.search.lexical, ctx.result.search.vector], [true, false]);
  assert.ok(ctx.result.hits.some((h) => h.id === 'ADFCR-8' && h.by_keyword && !h.by_meaning), JSON.stringify(ctx.result.hits.map((h) => [h.id, h.level])));
  assert.ok(!ctx.result.hits.some((h) => h.level === 'duplicate'), 'ohne Vektor keine Aussage „Duplikat“');
  assert.ok(!/vecr AS/.test(w.calls.find((c) => c.op === 'hybrid-search').sql));
  assert.ok(ctx.notices.some((n) => /Vertex Embeddings nicht erreichbar/.test(n)));
});

test('Neue Chunk-Einstellung: alles wird neu zerlegt; geänderter Text ersetzt seine alten Chunks; gelöschte Tickets verschwinden', () => {
  const w = ragWorld({ props: { RERANKER: 'none' } });
  w.rt.abgleichEinrichten();
  const before = w.db.chunks.length;
  w.board[0].fields.description = 'h3. 1. Ziel\n' + 'Feiertage je Land sind wichtig für die Bestellung. '.repeat(60);
  w.rt.abgleich();
  const seven = w.db.chunks.filter((c) => c.doc_id === 'ADFCR-7');
  assert.ok(seven.length >= 3 && seven.every((c) => c.embedding.length === 8), String(seven.length));
  assert.deepStrictEqual(seven.map((c) => c.chunk_no).sort((a, b) => a - b), seven.map((_, i) => i), 'alte Chunks ersetzt, keine doppelten');
  assert.strictEqual(w.db.chunks.length, before - 1 + seven.length);
  // andere Größe → Kennung passt nicht mehr → der nächste Lauf zerlegt alles neu
  const rt2 = createRuntime({ scriptProperties: Object.assign({}, BQ, { RERANKER: 'none', CHUNK_CHARS: '600', CHUNK_OVERLAP: '60' }), fetch: w.rt.UrlFetchApp.fetch.__raw || ((url, req) => { const r = w.rt.UrlFetchApp.fetch(url, req); return { code: r.getResponseCode(), text: r.getContentText() }; }), email: 'chris@firma.de', drive: { ordner1: [] } });
  rt2.abgleichVoll();
  assert.ok(w.db.issues.every((i) => i.emb_model === 'text-multilingual-embedding-002|v1|600|60' && i.text_hash), JSON.stringify(w.db.issues.map((i) => i.emb_model)));
  assert.ok(w.db.chunks.filter((c) => c.doc_id === 'ADFCR-7').length > seven.length, 'kleinere Chunks, also mehr');
  assert.ok(!w.db.chunks.some((c) => c.source === 'confluence'), 'Seiten, die nicht mehr im Ordner sind, verlieren ihre Chunks');
  w.board.splice(2, 1);
  rt2.abgleichVoll();
  assert.ok(!w.db.chunks.some((c) => c.doc_id === 'ADFCR-9') && !w.db.issues.some((i) => i.key === 'ADFCR-9'));
});

test('Datenanalyse: Messwerte je Quelle und eine Chunking-Empfehlung, mit BigQuery und im Speicher', () => {
  const w = ragWorld({ props: { RERANKER: 'none' } });
  for (let i = 0; i < 12; i++) w.board.push({ key: 'ADFCR-' + (100 + i), fields: { summary: i < 2 ? 'Doppelter Titel' : 'Ticket ' + i,
    description: i === 5 ? '' : 'h3. 1. Ziel\n' + 'Regel für die Filiale und den Bestand. '.repeat(20 + 6 * i) + '\nh3. 2. Mehrwert\nWeniger Aufwand.',
    status: { name: i % 2 ? 'DONE' : 'NEW REQUIREMENT' }, reporter: { emailAddress: 'a@firma.de' }, updated: '2026-11-02T09:00:00.000+0100',
    created: '2026-11-01T09:00:00.000+0100', resolutiondate: null, components: [{ name: 'Logistik' }], issuetype: { name: 'Story' } } });
  w.rt.abgleichEinrichten();
  w.calls.length = 0;
  const ctx = call(w.rt, 'GET', '/daten').ctx;
  assert.strictEqual(ctx.error, null);
  const rep = ctx.report, jira = rep.sources.find((s) => s.source === 'jira');
  assert.strictEqual(rep.mode, 'bigquery');
  assert.deepStrictEqual([jira.docs, jira.empty, jira.dup_titles], [16, 1, 1]);
  assert.ok(jira.len.p50 > 500 && jira.len.max > jira.len.p50 && jira.structure.with_headings > 80 && jira.structure.sample === 16, JSON.stringify(jira));
  assert.ok(rep.advice.chars >= 600 && rep.advice.chars <= 1600 && rep.advice.chars % 100 === 0 && rep.advice.overlap > 0, JSON.stringify(rep.advice));
  assert.ok(rep.advice.est_chunks >= 16 && rep.advice.lines.some((l) => /haben Überschriften: getrennt wird an den Überschriften/.test(l)));
  assert.ok(rep.advice.lines.some((l) => /keinen Text/.test(l)) && rep.advice.lines.some((l) => /Titel, den es schon gibt/.test(l)));
  assert.ok(rep.groups.stream.some((g) => g.name === 'logistik' && g.n === 13) && rep.groups.status.length >= 2);
  assert.ok(rep.chunks.find((x) => x.source === 'jira').embedded >= 16);
  assert.ok(ctx.sync.some((s) => s.source === 'jira' && s.ok));
  ['eda-issues', 'eda-pages', 'eda-sample-issues', 'eda-groups', 'eda-chunks'].forEach((op) => assert.ok(w.calls.some((c) => c.op === op), op));
  w.calls.length = 0;
  call(w.rt, 'GET', '/daten');
  assert.ok(!w.calls.some((c) => /^eda-/.test(c.op)), 'zweiter Aufruf kommt aus dem Cache');
  call(w.rt, 'GET', '/daten', { neu: ['1'] });
  assert.ok(w.calls.some((c) => c.op === 'eda-issues'), '?neu=1 rechnet neu');
  assert.ok(/Empfehlung: CHUNK_CHARS = \d+, CHUNK_OVERLAP = \d+/.test(w.rt.datenanalyse()));
  // im Speicher (Testdaten): dieselbe Auswertung ohne BigQuery
  const mem = call(createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } }), 'GET', '/daten').ctx;
  assert.strictEqual(mem.report.mode, 'memory');
  assert.ok(mem.report.sources.find((s) => s.source === 'jira').docs > 20 && mem.report.advice.differs === false, 'kurze Tickets: Einstellung passt schon');
});

test('Abgleich im Speicher (Testdaten): Duplikat erkannt, Stream aus den Nachbarn, zu kurze Eingabe wird freundlich abgelehnt', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const page = call(rt, 'GET', '/abgleich').ctx;
  assert.ok(page.examples.length >= 3 && page.result === null && page.store === 'memory');
  const ctx = call(rt, 'POST', '/abgleich', { text: [page.examples[2].text], modus: ['wunsch'], quelle: ['jira'] }).ctx;
  assert.strictEqual(ctx.result.verdict.level, 'duplicate');
  assert.strictEqual(ctx.result.hits[0].id, 'ADF-1021');
  assert.ok(ctx.result.hits.every((h) => h.source === 'jira'), 'Quellenfilter');
  assert.strictEqual(ctx.result.streams[0].id, 'logistik');
  assert.ok(/h2\. /.test(ctx.result.draft.markup));
  assert.strictEqual(call(rt, 'POST', '/abgleich', { text: ['zu kurz'] }).ctx.error, 'Bitte beschreibe das Anliegen in einem ganzen Satz.');
  const none = call(rt, 'POST', '/abgleich', { text: ['Xylophon Quastenflosser Zeppelin Orgelpfeife'] }).ctx.result;
  assert.strictEqual(none.verdict.level, 'new');
  assert.ok(Array.isArray(rt.sucheTesten()));
});

Promise.all(pendingAsync).then(() => {
  console.log(failed ? '\n' + failed + ' Test(s) fehlgeschlagen' : '\nAlle Tests bestanden');
  process.exit(failed ? 1 : 0);
});
