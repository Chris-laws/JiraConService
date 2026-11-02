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

test('Maske prüfen und Anlegen ist ohne Freigabe abgeschaltet', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  const draft = call(rt, 'GET', '/ticket', { beispiel: ['0'] }).ctx.result.form;
  const fields = {};
  Object.keys(draft).forEach((k) => { fields[k] = [Array.isArray(draft[k]) ? draft[k].join('\n') : String(draft[k])]; });
  fields.current_state = ['Heute wird der Mindestbestand manuell überschrieben.'];
  fields.reviewed = ['1'];
  fields.action = ['anlegen'];
  const ctx = call(rt, 'POST', '/ticket/pruefen', fields).ctx;
  assert.strictEqual(ctx.result.blocked, 'Anlegen in Jira ist im Prototyp abgeschaltet. Text kopieren und in Jira einfügen.');
  assert.ok(ctx.result.markup.indexOf('h3. 3. Ausgangssituation\nHeute wird der Mindestbestand manuell überschrieben.') >= 0);
});

test('Anlegen mit Freigabe liefert einen Schlüssel', () => {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock', JIRA_WRITE_ENABLED: 'true' } });
  const draft = call(rt, 'GET', '/ticket', { beispiel: ['0'] }).ctx.result.form;
  const fields = {};
  Object.keys(draft).forEach((k) => { fields[k] = [Array.isArray(draft[k]) ? draft[k].join('\n') : String(draft[k])]; });
  Object.assign(fields, { current_state: ['Heute manuell.'], reviewed: ['1'], action: ['anlegen'] });
  assert.strictEqual(call(rt, 'POST', '/ticket/pruefen', fields).ctx.result.created, 'MOCK-1');
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

test('Gebündelte Fassung (bundle/) ist aktuell und rechnet gleich', () => {
  const fs = require('fs');
  const path = require('path');
  const before = fs.readFileSync(path.join(__dirname, '..', 'bundle', 'Code.gs'), 'utf8');
  require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'bundle.js')]);
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'bundle', 'Code.gs'), 'utf8'), before, 'bundle/ war veraltet, jetzt neu erzeugt: bitte mit committen');
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' }, codeFiles: [path.join(__dirname, '..', 'bundle', 'Code.gs')] });
  const a = call(rt, 'GET', '/ticket', { beispiel: ['2'] }).ctx.result.markup;
  const b = call(createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } }), 'GET', '/ticket', { beispiel: ['2'] }).ctx.result.markup;
  assert.strictEqual(a, b);
  const html = fs.readFileSync(path.join(__dirname, '..', 'bundle', 'Index.html'), 'utf8');
  assert.ok(!/include\(/.test(html), 'Index.html enthält noch include()');
});

console.log(failed ? '\n' + failed + ' Test(s) fehlgeschlagen' : '\nAlle Tests bestanden');
process.exit(failed ? 1 : 0);
