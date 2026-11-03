/**
 * Adapter für alle externen Systeme. Die Services kennen nur diese Schnittstellen:
 *
 *   Jira:        searchIssues(), dashboardIssues(), issuesByReporter(email)
 *   JiraWriter:  enabled, createIssue(fields)
 *   Confluence:  pages()
 *   ServiceNow:  bugs(), bug(number), changes()
 *   Dokumente:   documents()
 *
 * Für jedes System gibt es eine Live-Variante (REST über UrlFetchApp, PAT als Bearer) und eine Mock-Variante
 * (MockData.gs). Welche genutzt wird, entscheidet allein buildContainer() anhand von DATA_SOURCE.
 *
 * Datenobjekte:
 *   Issue    {key, summary, description, status, reporter, updated, url, stream, epic, issue_type, created, resolved, board_scope}
 *   Page     {id, title, body, space, url}
 *   Bug      {number, short_description, description, component, first_seen, url, priority, caller}
 *   Change   {id, title, description, author, deployed_at, components, url, release}
 *   Document {id, title, body, kind, url}     kind: changelog | guide | training
 * Zeiten sind Date-Objekte (siehe parseTime in Util.gs).
 */

// ---------- HTTP ----------

/**
 * Nur-Lesen-Sperre, fest im Code (keine Skripteigenschaft kann sie lockern): Jira, Confluence, ServiceNow und jede
 * andere Adresse bekommen ausschließlich GET. Ausnahmen: Vertex AI (Gemini und Embeddings), das Anfragen technisch
 * per POST erwartet, und der Abfrage-Endpunkt von BigQuery (nur für den eigenen Datensatz, siehe BigQuery.gs).
 * Jeder HTTP-Aufruf der App läuft hier durch (requestJson und das parallele Einbetten in Vertex.gs).
 */
var READ_ONLY_POST_HOST_ = /^https:\/\/([a-z0-9-]+-)?aiplatform\.googleapis\.com\//;
// BigQuery: nur der Abfrage-Endpunkt. Was dort laufen darf (nur der eigene Datensatz), prüft assertOwnDataset_ in BigQuery.gs.
var BIGQUERY_QUERY_URL_ = /^https:\/\/bigquery\.googleapis\.com\/bigquery\/v2\/projects\/[a-z0-9.:-]+\/queries$/;
function assertReadOnly_(method, url) {
  var m = String(method || '').toUpperCase();
  if (m === 'GET') return;
  if (m === 'POST' && READ_ONLY_POST_HOST_.test(String(url))) return;
  if (m === 'POST' && BIGQUERY_QUERY_URL_.test(String(url))) return;
  throw new WriteDisabled('Nur-Lesen-Sperre: ' + m + ' an ' + String(url).split('?')[0].replace(/^(https?:\/\/[^/]+).*$/, '$1') + ' ist verboten.');
}

/** Gemeinsamer HTTP-Aufruf. Fehler werden zu errorType (Standard: SourceUnavailable). */
function requestJson(method, url, options) {
  options = options || {};
  assertReadOnly_(method, url);
  var ErrorType = options.error || SourceUnavailable;
  var host = url.split('?')[0]; // nie Query-Parameter melden (könnten Tokens enthalten)
  if (options.params) {
    var q = Object.keys(options.params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(options.params[k]);
    }).join('&');
    url += (url.indexOf('?') >= 0 ? '&' : '?') + q;
  }
  var req = { method: method.toLowerCase(), headers: options.headers || {}, muteHttpExceptions: true, followRedirects: true };
  if (options.json !== undefined) {
    req.contentType = 'application/json';
    req.payload = JSON.stringify(options.json);
  }
  // Lesen wird bei vorübergehenden Fehlern (429, 502–504, Netz) bis zu zweimal wiederholt,
  // mit wachsender, zufälliger Wartezeit. Schreiben nie, damit nichts doppelt angelegt wird.
  var retries = options.retries !== undefined ? options.retries : (method === 'GET' ? 2 : 0);
  var resp, code;
  for (var attempt = 0; ; attempt++) {
    var t0 = Date.now();
    PERF_.fetches++;
    try {
      resp = UrlFetchApp.fetch(url, req);
      code = resp.getResponseCode();
    } catch (exc) {
      PERF_.fetchMs += Date.now() - t0;
      if (attempt < retries) { backoff_(attempt); continue; }
      throw new ErrorType(method + ' ' + host + ' fehlgeschlagen: ' + safeFetchMessage_(exc));
    }
    PERF_.fetchMs += Date.now() - t0;
    if (attempt < retries && TRANSIENT_CODES_.indexOf(code) >= 0) { backoff_(attempt); continue; }
    break;
  }
  if (code < 200 || code >= 300) {
    throw new ErrorType(method + ' ' + host + ' antwortete mit HTTP ' + code + errorDetail_(resp));
  }
  try {
    return JSON.parse(resp.getContentText());
  } catch (e) {
    throw new ErrorType(method + ' ' + host + ' lieferte kein JSON' + notJsonDetail_(method, url, req, resp));
  }
}

/**
 * Warum kam kein JSON? Meist eine Anmeldeseite (SSO), weil der PAT nicht angenommen wird, oder eine Weiterleitung
 * auf einen anderen Pfad (z. B. /confluence). Nennt den Seitentitel und, nur bei GET, das Weiterleitungsziel
 * (ein zweiter Abruf ohne Weiterleitung, ohne Query-Teil gemeldet).
 */
function notJsonDetail_(method, url, req, resp) {
  var parts = [];
  try {
    var m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(String(resp.getContentText() || ''));
    if (m) parts.push('Seite „' + m[1].replace(/\s+/g, ' ').trim() + '“');
  } catch (e) { /* egal */ }
  if (method === 'GET') {
    try {
      assertReadOnly_('GET', url);
      var probe = UrlFetchApp.fetch(url, { method: 'get', headers: req.headers, muteHttpExceptions: true, followRedirects: false });
      var code = probe.getResponseCode();
      var headers = probe.getHeaders ? probe.getHeaders() : {};
      var loc = headers.Location || headers.location || '';
      if (code >= 300 && code < 400 && loc) parts.push('leitet weiter nach ' + String(loc).split(/[?#]/)[0]);
      else parts.push('HTTP ' + code + ' ohne Weiterleitung');
    } catch (e) { /* egal */ }
  }
  return parts.length ? ' (' + safeFetchMessage_({ message: parts.join(', ') }) + ')' : '';
}

/**
 * Mehrere Abrufe gleichzeitig (UrlFetchApp.fetchAll), gleiche Sperre wie requestJson: nur GET (bzw. POST an Vertex).
 * items: [{url, params}]. Liefert die JSON-Antworten in derselben Reihenfolge. Fehlt eine, wird sie einzeln wiederholt.
 */
function requestJsonAll(method, items, options) {
  options = options || {};
  var ErrorType = options.error || SourceUnavailable;
  var reqs = items.map(function (it) {
    var url = it.url;
    if (it.params) {
      url += (url.indexOf('?') >= 0 ? '&' : '?') + Object.keys(it.params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(it.params[k]);
      }).join('&');
    }
    assertReadOnly_(method, url);
    return { url: url, method: method.toLowerCase(), headers: options.headers || {}, muteHttpExceptions: true, followRedirects: true };
  });
  if (reqs.length === 1) return [requestJson(method, items[0].url, { headers: options.headers, params: items[0].params, error: ErrorType })];
  var t0 = Date.now(), resps;
  PERF_.fetches += reqs.length;
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (exc) { resps = []; }
  PERF_.fetchMs += Date.now() - t0;
  return items.map(function (it, n) {
    var r = resps[n], code = r ? r.getResponseCode() : 0;
    if (code >= 200 && code < 300) {
      try { return JSON.parse(r.getContentText()); } catch (e) { /* unten einzeln */ }
    }
    return requestJson(method, it.url, { headers: options.headers, params: it.params, error: ErrorType }); // einzeln mit Wiederholung
  });
}

/** Erste Zeile der Fehlermeldung, ohne Query-Teile von Adressen (dort könnten Tokens stehen). */
/**
 * Begründung aus der Fehlerantwort, damit man sieht, WARUM (z. B. Jira: „Das Projekt ADF existiert nicht“).
 * Jira: errorMessages/errors, Confluence: message, ServiceNow: error.message. Gekürzt und ohne Tokens.
 */
function errorDetail_(resp) {
  var text = '';
  try { text = String(resp.getContentText() || ''); } catch (e) { return ''; }
  var parts = [];
  try {
    var d = JSON.parse(text);
    if (d && Array.isArray(d.errorMessages)) parts = parts.concat(d.errorMessages);
    if (d && d.errors && typeof d.errors === 'object') Object.keys(d.errors).forEach(function (k) { parts.push(k + ': ' + d.errors[k]); });
    if (d && typeof d.message === 'string') parts.push(d.message);
    if (d && d.error && typeof d.error.message === 'string') parts.push(d.error.message);
  } catch (e) {
    if (/<html|<!doctype/i.test(text)) parts.push('Antwort ist eine HTML-Seite (Anmeldeseite oder Proxy statt Jira-API?)');
  }
  var msg = parts.map(String).join(' | ').replace(/\s+/g, ' ').trim();
  return msg ? ': ' + safeFetchMessage_({ message: msg }).slice(0, 240) : '';
}

function safeFetchMessage_(exc) {
  var msg = exc && exc.message ? String(exc.message).split('\n')[0] : 'Netzwerkfehler';
  return msg
    .replace(/(\/\/)[^\/@\s"']+@/g, '$1') // Zugangsdaten in Adressen (https://nutzer:passwort@host)
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, '$1') // Query-Teil
    .replace(/\b((?:access_)?token|key|api_?key|pat|password|secret|sig)=[^&\s"']*/gi, '$1=…')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer …')
    .slice(0, 300);
}

var TRANSIENT_CODES_ = [429, 502, 503, 504];

/** Wartezeit vor einer Wiederholung: 0,4 s, 1,2 s … mit ±50 % Zufall gegen gleichzeitige Wiederholungen. */
function backoff_(attempt) {
  var base = 400 * Math.pow(3, attempt);
  Utilities.sleep(Math.round(base * (0.5 + Math.random())));
}

function bearer_(token, extra) {
  var h = { Accept: 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}

function requireUrl_(url, name) {
  if (!url) throw new SourceUnavailable(name + ' ist nicht konfiguriert (Script Property ' + name + ' fehlt oder ist ein Platzhalter)');
  return url.replace(/\/+$/, '');
}

function cloneIssue_(issue, changes) {
  var copy = {};
  Object.keys(issue).forEach(function (k) { copy[k] = issue[k]; });
  Object.keys(changes).forEach(function (k) { copy[k] = changes[k]; });
  return copy;
}

// ---------- Jira (Server/Data Center, PAT als Bearer). Lesen aktiv, Schreiben per Schalter ----------

var JIRA_FIELDS_ = 'summary,description,status,reporter,updated,created,resolutiondate,components,issuetype';

function JiraRestReader(s) {
  this.s = s;
  this.fields = JIRA_FIELDS_ + ',' + SETTINGS.jira.epic_link_field;
  this.max = 500;
  this.since = null; // Minuten: nur Tickets, die sich seitdem geändert haben (Teilabgleich nach BigQuery)
}
JiraRestReader.prototype.base_ = function () { return requireUrl_(this.s.jiraUrl, 'JIRA_URL'); };
JiraRestReader.prototype.paged_ = function (path, params) {
  var base = this.base_(), self = this;
  var query = function (start) {
    var p = { startAt: start, maxResults: self.max, fields: self.fields };
    Object.keys(params).forEach(function (k) { p[k] = params[k]; });
    return p;
  };
  var check = function (data) {
    var rows = data && data.issues;
    var total = data ? parseInt(data.total, 10) : NaN;
    if (!Array.isArray(rows) || !(total >= 0)) throw new SourceUnavailable('Jira-Antwort unerwartet: issues/total ungültig');
    return { rows: rows, total: total };
  };
  var first = check(requestJson('GET', base + path, { headers: bearer_(this.s.jiraPat), params: query(0) }));
  var pages = [first.rows];
  // Die Gesamtzahl steht in der ersten Antwort: die übrigen Seiten gleichzeitig holen (je 6), statt nacheinander.
  var starts = [];
  for (var s = first.rows.length; first.rows.length && s < first.total; s += this.max) starts.push(s);
  for (var g = 0; g < starts.length; g += 6) {
    var group = starts.slice(g, g + 6);
    requestJsonAll('GET', group.map(function (st) { return { url: base + path, params: query(st) }; }), { headers: bearer_(this.s.jiraPat) })
      .forEach(function (data) { pages.push(check(data).rows); });
  }
  var result = [];
  pages.forEach(function (rows) { rows.forEach(function (r) { result.push(self.toIssue_(r, base)); }); });
  if (result.length < first.total && pages.some(function (rows) { return !rows.length; })) {
    throw new SourceUnavailable('Jira-Antwort enthält eine leere Seite vor dem Ende');
  }
  return result;
};
JiraRestReader.prototype.search_ = function (jql) { return this.paged_('/rest/api/2/search', { jql: sinceJql_(jql, this.since) }); };
JiraRestReader.prototype.board_ = function (id) {
  return this.paged_('/rest/agile/1.0/board/' + id + '/issue', this.since ? { jql: 'updated >= -' + this.since + 'm' } : {});
};
JiraRestReader.prototype.toIssue_ = function (raw, base) {
  var f = raw.fields || {};
  var components = f.components || [];
  var updated = parseTime(f.updated);
  if (!updated) throw new SourceUnavailable('Jira-Antwort ohne Aktualisierungszeitpunkt');
  return {
    key: raw.key,
    summary: f.summary || '',
    description: f.description || '',
    status: (f.status || {}).name || '',
    reporter: (f.reporter || {}).emailAddress || '',
    updated: updated,
    url: base + '/browse/' + raw.key,
    stream: components.length ? String(components[0].name).toLowerCase() : null,
    epic: f[SETTINGS.jira.epic_link_field] || null,
    issue_type: (f.issuetype || {}).name || 'Story',
    created: parseTime(f.created),
    resolved: parseTime(f.resolutiondate),
    board_scope: null
  };
};
JiraRestReader.prototype.searchIssues = function () {
  var boards = this.s.jiraBoardIds;
  if (Object.keys(boards).length) {
    var byKey = {}, order = [];
    var self = this;
    Object.keys(boards).forEach(function (scope) {
      self.board_(boards[scope]).forEach(function (issue) {
        // Country Report ist ein eigener fünfter Bereich und darf nicht in die Streams/RAG laufen.
        if (upper(issue.key).indexOf('ADFCR-') === 0) return;
        if (!byKey[issue.key]) { byKey[issue.key] = cloneIssue_(issue, { stream: scope, board_scope: scope }); order.push(issue.key); }
      });
    });
    return order.map(function (k) { return byKey[k]; });
  }
  return this.search_(this.s.jiraJql);
};
/** Country Report: Board, sonst JQL. */
JiraRestReader.prototype.countryIssues = function () {
  return this.s.jiraAdfcrBoardId !== null ? this.board_(this.s.jiraAdfcrBoardId)
    : this.s.jiraAdfcrJql ? this.search_(this.s.jiraAdfcrJql) : [];
};
/** Vier Stream-Boards plus Country Report, nach Jira-Key entdoppelt. */
JiraRestReader.prototype.dashboardIssues = function () {
  var country = this.countryIssues();
  var byKey = {}, order = [];
  country.forEach(function (i) {
    if (!byKey[i.key]) order.push(i.key);
    byKey[i.key] = cloneIssue_(i, { stream: null, board_scope: 'adfcr' });
  });
  this.searchIssues().forEach(function (i) {
    if (!byKey[i.key]) { byKey[i.key] = cloneIssue_(i, { board_scope: i.board_scope || i.stream }); order.push(i.key); }
  });
  return order.map(function (k) { return byKey[k]; });
};
JiraRestReader.prototype.issuesByReporter = function (email) {
  var safe = String(email).replace(/"/g, '');
  return this.search_('reporter = "' + safe + '" ORDER BY updated DESC');
};

/** JQL um „nur seit N Minuten geändert“ ergänzen; ORDER BY bleibt am Ende. */
function sinceJql_(jql, minutes) {
  if (!minutes) return jql;
  var m = /^([\s\S]*?)(\s+ORDER\s+BY\s[\s\S]*)?$/i.exec(String(jql));
  return '(' + m[1].trim() + ') AND updated >= -' + Math.max(1, Math.ceil(minutes)) + 'm' + (m[2] || '');
}

/**
 * Diese Fassung liest nur. Es gibt keinen Code, der in Jira etwas anlegt oder ändert; der „Writer“ sagt immer nein.
 * Wer später schreiben will, muss hier bewusst neuen Code einbauen UND die Sperre in assertReadOnly_ lockern.
 */
function ReadOnlyJiraWriter() { this.enabled = false; }
ReadOnlyJiraWriter.prototype.createIssue = function () {
  throw new WriteDisabled('Diese Fassung liest nur. Anlegen in Jira ist gesperrt.');
};

// ---------- Confluence (Server/Data Center, PAT als Bearer) ----------

function stripHtml(value) {
  var text = String(value).replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); });
  return text.replace(/\s+/g, ' ').trim();
}

function ConfluenceRest(s) { this.s = s; this.limit = 100; }
ConfluenceRest.prototype.pages = function () {
  var base = requireUrl_(this.s.confluenceUrl, 'CONFLUENCE_URL');
  var self = this, result = [];
  this.s.confluenceSpaces.forEach(function (space) {
    for (var start = 0, n = 0; n < 50; n++, start += self.limit) {
      var data = requestJson('GET', base + '/rest/api/content', {
        headers: confluenceHeaders_(self.s),
        params: { spaceKey: space, type: 'page', start: start, limit: self.limit, expand: 'body.storage' }
      });
      var rows;
      try {
        rows = data.results;
        rows.forEach(function (r) {
          result.push({ id: String(r.id), title: r.title, body: stripHtml(r.body.storage.value), space: space, url: base + r._links.webui });
        });
      } catch (exc) {
        throw new SourceUnavailable('Confluence-Antwort unerwartet: ' + exc.message);
      }
      if (rows.length < self.limit) break;
    }
  });
  return result;
};

/**
 * Anmeldung an Confluence. Standard: PAT als Bearer. Steht Confluence hinter einem F5-Anmeldegateway (BIG-IP APM),
 * hilft manchmal dessen „Clientless-Modus“ für Programme (Header clientless-mode), Skripteigenschaft
 * CONFLUENCE_CLIENTLESS = 1 oder 3. Welcher Weg geht, zeigt testConfluence() im Editor.
 */
function confluenceHeaders_(s) {
  var h = bearer_(s.confluencePat);
  if (s.confluenceClientless) h['clientless-mode'] = s.confluenceClientless;
  return h;
}

/**
 * Im Editor ausführen: probiert die Anmeldewege an Confluence durch (nur GET, ohne Weiterleitungen zu folgen) und
 * schreibt ins Protokoll, was jeweils zurückkommt. Kein Token landet im Protokoll.
 */
function testConfluence() {
  var s = loadSettings();
  var base = requireUrl_(s.confluenceUrl, 'CONFLUENCE_URL');
  var url = base + '/rest/api/space?limit=1';
  assertReadOnly_('GET', url);
  var variants = [
    ['ohne Anmeldung', {}],
    ['PAT als Bearer (wie bisher)', bearer_(s.confluencePat)],
    ['PAT + clientless-mode 1', confluenceHeaders_({ confluencePat: s.confluencePat, confluenceClientless: '1' })],
    ['PAT + clientless-mode 3', confluenceHeaders_({ confluencePat: s.confluencePat, confluenceClientless: '3' })]
  ];
  var lines = ['Confluence-Test gegen ' + base + '/rest/api/space'], works = null;
  variants.forEach(function (v) {
    var line = v[0] + ': ';
    try {
      var r = UrlFetchApp.fetch(url, { method: 'get', headers: v[1], muteHttpExceptions: true, followRedirects: false });
      var code = r.getResponseCode();
      var h = r.getHeaders ? r.getHeaders() : {};
      var text = String(r.getContentText() || '');
      var json = false;
      try { json = !!JSON.parse(text); } catch (e) { json = false; }
      var title = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(text);
      var loc = h.Location || h.location;
      line += 'HTTP ' + code + (json ? ', JSON' : '') + (loc ? ', leitet weiter nach ' + String(loc).split(/[?#]/)[0] : '') +
        (title ? ', Seite „' + title[1].trim() + '“' : '') + (h.Server || h.server ? ', Server ' + (h.Server || h.server) : '');
      if (code === 200 && json && v[0] !== 'ohne Anmeldung' && !works) works = v[0];
    } catch (exc) {
      line += 'Fehler ' + safeFetchMessage_(exc);
    }
    lines.push(safeFetchMessage_({ message: line }));
  });
  lines.push(works ? 'ERGEBNIS: Es geht mit „' + works + '“.' + (/clientless-mode (\d)/.test(works)
    ? ' Skripteigenschaft CONFLUENCE_CLIENTLESS = ' + /clientless-mode (\d)/.exec(works)[1] + ' setzen.' : '')
    : 'ERGEBNIS: Kein Weg kommt durch das Anmeldegateway. Confluence bitte über den Export im Drive-Ordner (BigQuery-Abgleich).');
  lines.forEach(function (l) { Logger.log(l); });
  return lines;
}

// ---------- ServiceNow (Table API): Bugs (Incidents) und Changes (Patches/Deployments) ----------

function snDisplay_(value) {
  if (value && typeof value === 'object') return String(value.display_value || '');
  return String(value || '');
}

function ServiceNowRest(s) {
  this.s = s;
  this.bugTable = 'incident';
  this.bugQuery = 'active=true^ORDERBYDESCopened_at';
  this.changeQuery = 'state=3^ORDERBYDESCclosed_at';
  this.limit = 200;
}
ServiceNowRest.prototype.table_ = function (table, query) {
  var base = requireUrl_(this.s.servicenowUrl, 'SERVICENOW_URL');
  var data = requestJson('GET', base + '/api/now/table/' + table, {
    headers: bearer_(this.s.servicenowToken),
    params: { sysparm_query: query, sysparm_limit: this.limit, sysparm_display_value: 'all' }
  });
  if (!data || !Array.isArray(data.result)) throw new SourceUnavailable('ServiceNow-Antwort unerwartet');
  return data.result;
};
ServiceNowRest.prototype.toBug_ = function (r) {
  var base = this.s.servicenowUrl.replace(/\/+$/, '');
  var number = snDisplay_(r.number);
  var seen = parseTime(snDisplay_(r.opened_at));
  if (!number || !seen) throw new SourceUnavailable('ServiceNow-Bug unvollständig');
  return {
    number: number,
    short_description: snDisplay_(r.short_description),
    description: snDisplay_(r.description),
    component: snDisplay_(r.cmdb_ci).toLowerCase(),
    first_seen: seen,
    url: base + '/nav_to.do?uri=' + this.bugTable + '.do?sysparm_query=number=' + number,
    priority: snDisplay_(r.priority),
    caller: snDisplay_(r.caller_id) // personenbezogen: geht nie an das LLM
  };
};
ServiceNowRest.prototype.bugs = function () {
  var self = this;
  return this.table_(this.bugTable, this.bugQuery).map(function (r) { return self.toBug_(r); });
};
ServiceNowRest.prototype.bug = function (number) {
  var safe = String(number).replace(/[^A-Za-z0-9]/g, '');
  var rows = this.table_(this.bugTable, 'number=' + safe);
  if (!rows.length) throw new Error('Bug nicht gefunden: ' + number);
  return this.toBug_(rows[0]);
};
ServiceNowRest.prototype.changes = function () {
  var base = this.s.servicenowUrl ? this.s.servicenowUrl.replace(/\/+$/, '') : '';
  return this.table_('change_request', this.changeQuery).map(function (r) {
    var id = snDisplay_(r.number);
    var deployed = parseTime(snDisplay_(r.closed_at) || snDisplay_(r.end_date));
    if (!id || !deployed) throw new SourceUnavailable('ServiceNow-Change unvollständig');
    var comp = snDisplay_(r.cmdb_ci).toLowerCase();
    return {
      id: id,
      title: snDisplay_(r.short_description),
      description: snDisplay_(r.description),
      author: snDisplay_(r.assigned_to),
      deployed_at: deployed,
      components: comp ? [comp] : [],
      url: base + '/nav_to.do?uri=change_request.do?sysparm_query=number=' + id,
      release: snDisplay_(r.u_release)
    };
  });
};

// ---------- Dokumente: Change Log, Anleitungen, Schulungen als Markdown ----------
// Live: Markdown-Dateien in einem Drive-Ordner (Script Property DOCS_FOLDER_ID). Jede Datei beginnt mit
//   ---
//   title: Release Notes 2026.10
//   kind: changelog          # changelog | guide | training
//   url: https://…           # optional
//   ---

var DOC_KINDS_ = ['changelog', 'guide', 'training'];

function parseMarkdownDoc(id, text) {
  var meta = {}, body = text;
  if (text.indexOf('---') === 0) {
    var rest = text.slice(3);
    var end = rest.indexOf('\n---');
    var head = end >= 0 ? rest.slice(0, end) : rest;
    body = end >= 0 ? rest.slice(end + 4) : '';
    head.trim().split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).split(' #')[0].trim();
    });
    body = body.replace(/^[-\n]+/, '');
  }
  var kind = meta.kind || 'guide';
  return { id: id, title: meta.title || id, body: body.trim(), kind: DOC_KINDS_.indexOf(kind) >= 0 ? kind : 'guide', url: meta.url || '' };
}

function DriveDocuments(folderId) { this.folderId = folderId; }
DriveDocuments.prototype.documents = function () {
  if (!this.folderId) return [];
  var docs = [];
  var files = DriveApp.getFolderById(this.folderId).getFiles();
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (!/\.md$/i.test(name)) continue;
    docs.push(parseMarkdownDoc(name.replace(/\.md$/i, ''), file.getBlob().getDataAsString('UTF-8')));
  }
  return sortBy(docs, function (d) { return d.id; });
};

/** Ohne DOCS_FOLDER_ID: keine Anleitungen (die Seite sagt, wie man den Drive-Ordner einträgt). */
function EmptyDocuments() {}
EmptyDocuments.prototype.documents = function () { return []; };

// ---------- Zwischenspeicher für Live-Abfragen ----------
// Jede Seite lädt die Jira-Daten neu; für ein paar Minuten reicht der Stand aus dem Cache.

var CACHE_SECONDS_ = 1800; // Standard 30 Minuten; Skripteigenschaft CACHE_MINUTES (1 bis 360) ändert das
function cacheSeconds_() {
  var m = 0;
  var bq = false;
  try {
    var props = PropertiesService.getScriptProperties();
    m = parseInt(props.getProperty('CACHE_MINUTES') || '', 10);
    bq = !!props.getProperty('BQ_DATASET');
  } catch (e) { m = 0; }
  if (m >= 1) return Math.min(m, 360) * 60;
  // Mit BigQuery wirft jeder Abgleich den Cache ohnehin weg und füllt ihn neu: dann gilt er bis zu 6 Stunden.
  return bq ? 21600 : CACHE_SECONDS_;
}

/** Versions-Token je Datenquelle: ein Schreibvorgang setzt ein neues, alte Cache-Stände gelten dann nicht mehr. */
function cacheVersion_(cache, group) { return cache.get('ver:' + group) || '0'; }
function bumpCacheVersion_(group) {
  try { CacheService.getScriptCache().put('ver:' + group, String(Date.now()), 21600); } catch (e) { /* egal */ }
}

function cachedList_(cacheKey, loader, dateFields) {
  var cache = CacheService.getScriptCache();
  cacheKey = cacheKey + '@' + cacheVersion_(cache, cacheKey.split(':')[0]);
  var raw = readChunked_(cache, cacheKey);
  if (raw) PERF_.cacheHits++; else PERF_.cacheMisses++;
  if (raw) {
    try {
      return JSON.parse(raw).map(function (row) {
        dateFields.forEach(function (f) { if (row[f]) row[f] = new Date(row[f]); });
        return row;
      });
    } catch (e) { /* defekter Cache: neu laden */ }
  }
  var list = loader();
  writeChunked_(cache, cacheKey, JSON.stringify(list), cacheSeconds_());
  return list;
}

function readChunked_(cache, key) {
  var head = cache.get(key + ':n');
  if (!head) return null;
  var n = parseInt(head, 10), keys = [];
  for (var i = 0; i < n; i++) keys.push(key + ':' + i);
  var parts = cache.getAll(keys);
  var out = '';
  for (var j = 0; j < n; j++) {
    if (parts[keys[j]] === undefined || parts[keys[j]] === null) return null;
    out += parts[keys[j]];
  }
  return out;
}

function writeChunked_(cache, key, text, seconds) {
  // 32.000 Zeichen sind höchstens 96 KB, auch wenn jedes Zeichen 3 Bytes braucht (Grenze: 100 KB je Wert).
  var size = 32000, values = {}, n = 0;
  for (var i = 0; i < text.length; i += size) values[key + ':' + (n++)] = text.slice(i, i + size);
  if (n > 200) return; // zu groß für den Cache, dann eben ohne
  try {
    cache.putAll(values, seconds);
    cache.put(key + ':n', String(n), seconds);
  } catch (e) { /* Cache voll: ohne Cache weiter */ }
}

function CachedJira(inner) { this.inner = inner; }
var ISSUE_DATES_ = ['updated', 'created', 'resolved'];
CachedJira.prototype.searchIssues = function () {
  var inner = this.inner;
  return cachedList_('jira:search', function () { return inner.searchIssues(); }, ISSUE_DATES_);
};
CachedJira.prototype.dashboardIssues = function () {
  var inner = this.inner;
  return cachedList_('jira:dashboard', function () { return inner.dashboardIssues(); }, ISSUE_DATES_);
};
/** ServiceNow-Incidents und -Changes für ein paar Minuten zwischenspeichern; einzelne Bugs aus der Liste. */
function CachedServiceNow(inner) { this.inner = inner; }
CachedServiceNow.prototype.bugs = function () {
  var inner = this.inner;
  return cachedList_('sn:bugs', function () { return inner.bugs(); }, ['first_seen']);
};
CachedServiceNow.prototype.bug = function (number) { return this.inner.bug(number); };
CachedServiceNow.prototype.changes = function () {
  var inner = this.inner;
  return cachedList_('sn:changes', function () { return inner.changes(); }, ['deployed_at']);
};

function CachedConfluence(inner) { this.inner = inner; }
CachedConfluence.prototype.pages = function () {
  var inner = this.inner;
  return cachedList_('confluence:pages', function () { return inner.pages(); }, []);
};

function CachedDocuments(inner) { this.inner = inner; }
CachedDocuments.prototype.documents = function () {
  var inner = this.inner;
  return cachedList_('docs:' + inner.folderId, function () { return inner.documents(); }, []);
};

CachedJira.prototype.issuesByReporter = function (email) {
  var inner = this.inner;
  return cachedList_('jira:reporter:' + String(email).toLowerCase(), function () { return inner.issuesByReporter(email); }, ISSUE_DATES_);
};
