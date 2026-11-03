/**
 * Seitensteuerung: nimmt eine Anfrage der Oberfläche (Methode, Pfad, Formularfelder) entgegen und liefert
 * die Daten für eine Seite. Aufbau und Pfade entsprechen der bisherigen Web-App, damit Links und Formulare
 * gleich bleiben. Die Oberfläche ruft nur apiRequest() über google.script.run auf.
 *
 * Antwort (als JSON-Text, damit Datumswerte sicher ankommen):
 *   {template, ctx}            Seite anzeigen
 *   {redirect}                 zu einem anderen Pfad wechseln
 *   {download: {name, text}}   Datei speichern
 *   {json, status}             Daten für ein Skript (Bug-Erklärung)
 */

var BACKLOG_ROWS = 8;
var STALE_DAYS = 14;
var ADMIN_ROLE = 'INT';
var MAX_TURNS = 6; // so viele frühere Fragen bleiben im Assistenten sichtbar
var QUESTIONS = ['Wie werden Teillieferungen im Wareneingang erfasst?', 'Was hat sich im Release 2026.10.2 geändert?',
  'Was muss in ein Anforderungs-Ticket?'];

/**
 * Einziger Einstieg für die Oberfläche. Zusätzlich zu den Formularfeldern versteht er:
 *   _etag   Kennung des Stands, den der Browser schon hat. Ist die Seite unverändert, kommt nur {same: true}.
 *   _perf   1 = Messwerte mitschicken (Dauer, Aufrufe an Jira & Co., Cache), für ?perf=1.
 * Jeder Aufruf schreibt „api <Methode> <Pfad> <ms> ms“ ins Ausführungsprotokoll.
 */
function apiRequest(method, path, params) {
  var started = Date.now();
  perfReset_();
  method = String(method || 'GET').toUpperCase();
  path = String(path || '/');
  params = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  var etag = last_(params, '_etag'), wantPerf = last_(params, '_perf') === '1';
  var clean = {};
  Object.keys(params).forEach(function (k) { if (k.charAt(0) !== '_') clean[k] = params[k]; });
  var response;
  try {
    response = route_(method, path, clean);
  } catch (exc) {
    console.error(exc && exc.stack ? exc.stack : exc);
    response = { fatal: exc && exc.message ? exc.message : String(exc) };
  }
  if (method === 'GET' && response.template) {
    response.etag = etagOf_(response);
    if (etag && etag === response.etag) response = { same: true, etag: etag };
  }
  var text = JSON.stringify(response);
  var ms = Date.now() - started;
  if (wantPerf) {
    response.perf = { ms: ms, bytes: text.length, fetches: PERF_.fetches, fetchMs: PERF_.fetchMs, cacheHits: PERF_.cacheHits, cacheMisses: PERF_.cacheMisses };
    text = JSON.stringify(response);
  }
  console.log('api ' + method + ' ' + path + ' ' + ms + ' ms' + (PERF_.fetches ? ' (' + PERF_.fetches + ' Abrufe)' : ''));
  return text;
}

/** Kennung einer Seite ohne die Uhrzeit, damit gleicher Inhalt gleich bleibt. */
function etagOf_(response) {
  var ctx = {};
  Object.keys(response.ctx || {}).forEach(function (k) { if (k !== 'now') ctx[k] = response.ctx[k]; });
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, response.template + '\n' + JSON.stringify(ctx), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest.slice(0, 12));
}

function safeDecode_(text) {
  try { return decodeURIComponent(text); } catch (e) { return String(text); }
}

function last_(params, key, fallback) {
  var v = params[key];
  if (Array.isArray(v)) v = v.length ? v[v.length - 1] : undefined;
  return v === undefined || v === null ? (fallback === undefined ? '' : fallback) : String(v);
}

function all_(params, key) {
  var v = params[key];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

function route_(method, path, p) {
  var c = buildContainer();
  var req = { method: method, path: path, params: p, c: c };
  var m;
  if (method === 'GET' && path === '/') return dashboardPage_(req);
  if (method === 'GET' && path === '/tickets') return ticketsPage_(req);
  if (method === 'GET' && path === '/ticket') return ticketForm_(req);
  if (method === 'POST' && path === '/ticket') return ticketDraftPage_(req);
  if (method === 'POST' && path === '/ticket/pruefen') return ticketCheckPage_(req);
  if (method === 'POST' && path === '/ticket/text') return { download: { name: 'ticket.txt', text: last_(p, 'markup') } };
  if (method === 'GET' && path === '/meine-tickets') return myTicketsPage_(req);
  if (method === 'GET' && path === '/admin') return adminPage_(req);
  if (method === 'GET' && path === '/wissen') return assistant_(req, [], last_(p, 'frage').trim(), ['jira', 'confluence']);
  if (method === 'POST' && path === '/wissen') return knowledgeChat_(req);
  if (method === 'GET' && path === '/bugs') return bugsPage_(req);
  if (method === 'GET' && (m = /^\/bugs\/([^/]+)$/.exec(path))) return bugDetail_(req, safeDecode_(m[1]));
  if (method === 'POST' && (m = /^\/bugs\/([^/]+)\/erklaerung$/.exec(path))) return bugExplanation_(req, safeDecode_(m[1]));
  if (method === 'GET' && path === '/streams') return streamsPage_(req);
  if (method === 'GET' && path === '/dokumente') return documentsPage_(req);
  if (method === 'GET' && path === '/releases') return releasesPage_(req);
  if (method === 'POST' && path === '/benutzer') return switchUser_(req);
  if (method === 'POST' && path === '/sprache') return switchLanguage_(req);
  return render_(req, 'notfound', '', {});
}

// ---------- Angemeldete Person ----------

function userProps_() { return PropertiesService.getUserProperties(); }

/**
 * Live: E-Mail aus der Google-Anmeldung. Mit Testdaten lässt sich die Person unten in der Seitenleiste
 * wechseln (gespeichert je Nutzer), damit sich Rechte und „Meine Tickets“ ausprobieren lassen.
 */
function viewer_(c) {
  var mock = c.settings.dataSource === 'mock';
  var login = '';
  try { login = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (e) { login = ''; }
  var props = userProps_();
  var email = mock ? (props.getProperty('mock_user') || '') : login;
  if (!email && mock) email = Object.keys(c.settings.userRoles)[0] || '';
  email = email || null;
  var role = roleFor(c.settings, email);
  var savedRole = props.getProperty('mock_role') || '';
  if (mock && SETTINGS.roles.indexOf(savedRole) >= 0) role = savedRole;
  var name = displayName(email) || 'Unbekannt';
  return { email: email, name: name, initials: initials(name), role: role, from_login: !mock && !!login };
}

function lang_() {
  return userProps_().getProperty('lang') === 'en' ? 'en' : 'de';
}

// ---------- Rahmen ----------

function render_(req, template, active, ctx, snapshots) {
  var c = req.c;
  snapshots = snapshots || {};
  var issues = snapshots.issues || [];
  var me = viewer_(c);
  var mineOpen = issues.filter(function (i) { return me.email && i.reporter.toLowerCase() === me.email && isOpen(i); }).length;
  var people = {};
  issues.forEach(function (i) { people[i.reporter.toLowerCase()] = true; });
  Object.keys(c.settings.userRoles).forEach(function (k) { people[k] = true; });
  var streamNames = {};
  STREAMS.forEach(function (s) { streamNames[s.id] = s.name; });
  var base = {
    path: req.path,
    query: req.query || '',
    app_name: c.settings.appName,
    active: active,
    me: me,
    mock: c.settings.dataSource === 'mock',
    ai: c.llm.available,
    notices: c.notices,
    nav_counts: { bugs: snapshots.bugs ? snapshots.bugs.length : null, mine: snapshots.issues ? mineOpen : null },
    hues: streamHues(),
    stream_names: streamNames,
    people: Object.keys(people).sort(),
    roles: SETTINGS.roles,
    now: nowLocal(),
    lang: lang_()
  };
  Object.keys(ctx).forEach(function (k) { base[k] = ctx[k]; });
  return { template: template, ctx: base };
}

/** Lädt die Daten eines Blocks; ein Fehler bleibt im Block, statt die ganze Seite zu brechen. */
function block_(fn) {
  try {
    return [fn(), null];
  } catch (exc) {
    if (exc instanceof SourceUnavailable) return [null, exc.message];
    throw exc;
  }
}

function allowedStreams_() { return activeStreams().map(function (s) { return s.id; }); }

// ---------- Seiten ----------

function dashboardPage_(req) {
  var c = req.c, p = req.params;
  var me = viewer_(c);
  var r = block_(function () { return c.jira.dashboardIssues(); });
  var issues = r[0] || [], issuesError = r[1];
  var allowed = allowedStreams_();
  var selected = last_(p, 'scope') || last_(p, 'stream');
  if (allowed.concat(['adfcr']).indexOf(selected) < 0) selected = '';
  var q = last_(p, 'q');
  var scoped = filterScopeIssues(issues, selected, allowed);
  var openScoped = scoped.filter(isOpen);
  var mine = issues.filter(function (i) { return me.email && i.reporter.toLowerCase() === me.email; });
  var openIssues = issues.filter(isOpen);
  var shares = statusShares(scoped);
  var count = function (id) { return issues.filter(function (i) { return issueScope(i) === id; }).length; };
  var streams = sortBy(activeStreams(), function (s) { return [-count(s.id), s.name]; });
  var scopes = streams.map(function (s) { return { id: s.id, label: streamLabel(s.id), count: count(s.id) }; });
  scopes.push({ id: 'adfcr', label: 'ADFCR · Country Report', count: count('adfcr') });
  var chartYear = nowLocal().getUTCFullYear();
  var series = yearActivity(scoped, chartYear);
  var label = 'Alle Boards';
  scopes.forEach(function (s) { if (s.id === selected) label = s.label; });
  return render_(req, 'dashboard', 'dashboard', {
    open_total: openScoped.length,
    mine_open: mine.filter(isOpen).length,
    questions_for_me: mine.filter(function (i) { return upper(i.status) === 'ON HOLD DM'; }).length,
    backlog: filterScopeIssues(openIssues, selected, allowed, q).slice(0, BACKLOG_ROWS),
    scope: selected,
    q: q,
    scopes: scopes,
    scope_summary: { label: label, total: scoped.length, open: openScoped.length },
    overall_total: issues.length,
    series: series,
    chart_year: chartYear,
    shares: shares,
    donut: donut(shares),
    total: scoped.length,
    issues_error: issuesError
  }, { issues: issues });
}

var TICKET_PAGE_ = 250;

function ticketsPage_(req) {
  var c = req.c, p = req.params;
  var r = block_(function () { return c.jira.dashboardIssues(); });
  var issues = r[0] || [];
  var allowed = allowedStreams_();
  var selected = last_(p, 'scope') || last_(p, 'stream');
  if (allowed.concat(['adfcr']).indexOf(selected) < 0) selected = '';
  var q = last_(p, 'q'), phase = last_(p, 'phase'), epic = last_(p, 'epic');
  var matched = filterScopeIssues(issues, selected, allowed, q, phase, epic);
  // Große Boards: nur die ersten Zeilen schicken (Antwort klein, Seite schnell), „Weitere laden“ holt mehr.
  var limit = Math.min(Math.max(parseInt(last_(p, 'limit'), 10) || TICKET_PAGE_, TICKET_PAGE_), 20 * TICKET_PAGE_);
  return render_(req, 'tickets', 'tickets', {
    rows: matched.slice(0, limit).map(function (i) {
      return i.description && i.description.length > 240 ? cloneIssue_(i, { description: i.description.slice(0, 240) + '…' }) : i;
    }),
    matched: matched.length,
    limit: limit,
    page_size: TICKET_PAGE_,
    more: Math.min(TICKET_PAGE_, matched.length - limit, 20 * TICKET_PAGE_ - limit),
    total: issues.length,
    error: r[1],
    scope: selected,
    phase: phase.toUpperCase(),
    epic: epic,
    q: q,
    scopes: [{ id: 'adfcr', label: 'ADFCR · Country Report' }].concat(activeStreams().map(function (s) {
      return { id: s.id, label: streamLabel(s.id) };
    })),
    phases: SETTINGS.lifecycle.slice()
  }, { issues: issues });
}

function ticketPage_(req, ctx) {
  var c = req.c;
  var defaults = {
    examples: EXAMPLES,
    countries: SETTINGS.countries,
    priorities: SETTINGS.priorities,
    streams: activeStreams().map(function (s) { return { id: s.id, name: s.name }; }),
    new_epic: NEW_EPIC,
    safety: SAFETY,
    scales: SCALES,
    country: SETTINGS.countries[0],
    chat: [],
    blank: emptyForm(SETTINGS.countries[0]),
    result: null,
    error: null,
    reply: '',
    write_enabled: c.jiraWriter.enabled,
    author: viewer_(c)
  };
  Object.keys(ctx).forEach(function (k) { defaults[k] = ctx[k]; });
  return render_(req, 'ticket', 'ticket', defaults);
}

function ticketForm_(req) {
  var n = parseInt(last_(req.params, 'beispiel', '-1'), 10);
  if (n >= 0 && n < EXAMPLES.length) return ticketChat_(req, [EXAMPLES[n][1]], SETTINGS.countries[0]);
  return ticketPage_(req, {});
}

/** Jede Chat-Nachricht ergänzt die Beschreibung; daraus wird die Maske neu entworfen. */
function ticketChat_(req, messages, country) {
  var c = req.c;
  var me = viewer_(c);
  var form = ticketDraft(c, messages.join('\n'), country);
  var result = ticketCheck(c, form, me.role, me.email);
  return ticketPage_(req, { country: country, chat: messages, result: result, reply: ticketReply(result) });
}

function ticketDraftPage_(req) {
  var p = req.params;
  var text = (last_(p, 'text') || last_(p, 'frage')).trim();
  var country = last_(p, 'country') || SETTINGS.countries[0];
  var history = all_(p, 'verlauf').filter(function (m) { return m.trim(); });
  if (!text) return ticketPage_(req, { country: country, error: 'Bitte beschreibe kurz, was du brauchst.' });
  return ticketChat_(req, history.concat([text]), country);
}

function ticketCheckPage_(req) {
  var c = req.c, p = req.params;
  var f = {};
  Object.keys(p).forEach(function (k) { f[k] = last_(p, k); });
  var me = viewer_(c);
  var form = formFromFields(f);
  var result = ticketCheck(c, form, me.role, me.email);
  if (f.action === 'anlegen' && result.blocked === null) {
    try {
      result.created = ticketCreate(c, form, me.email, result.classification.multi_stream);
    } catch (exc) {
      if (exc instanceof WriteDisabled || exc instanceof SourceUnavailable || exc instanceof OneStreamOnly) result.blocked = exc.message;
      else throw exc;
    }
  }
  var chat = all_(p, 'verlauf').filter(function (m) { return m.trim(); });
  return ticketPage_(req, { country: form.country, chat: chat, result: result, reply: ticketReply(result) });
}

function myTicketsPage_(req) {
  var c = req.c;
  var me = viewer_(c);
  var r = block_(function () { return c.myTickets.forUser(me.email || ''); });
  var rows = r[0] || [];
  return render_(req, 'my_tickets', 'mine', {
    rows: sortBy(rows, function (row) { return row.issue.updated; }, true),
    error: r[1]
  }, { issues: rows.map(function (row) { return row.issue; }) });
}

function adminPage_(req) {
  var c = req.c;
  var me = viewer_(c);
  var r = block_(function () { return c.jira.searchIssues(); });
  var issues = r[0] || [], error = r[1];
  var now = nowLocal();
  var stale = sortBy(issues.filter(function (i) {
    return WAITING.indexOf(upper(i.status)) >= 0 && Math.floor(daysBetween(now, i.updated)) > STALE_DAYS;
  }), function (i) { return i.updated; });
  var mock = c.settings.dataSource === 'mock';
  return render_(req, 'admin', 'admin', {
    allowed: me.role === ADMIN_ROLE,
    error: error,
    total: issues.length,
    rejected: issues.filter(function (i) { return upper(i.status) === 'REJECTED'; }).length,
    stale: stale.map(function (i) { return { issue: i, age: Math.floor(daysBetween(now, i.updated)) }; }),
    stale_days: STALE_DAYS,
    streams: activeStreams().length,
    checks: [
      ['Datenquelle', !mock, !mock ? 'Live-Modus' : 'Lokaler Modus'],
      ['Jira lesen', error === null, error || 'Erreichbar'],
      ['KI', c.llm.available, c.llm.available ? 'Aktiv' : 'Offline, Antworten direkt aus den Quellen'],
      ['Jira schreiben', false, 'Gesperrt, nur Lesen']
    ]
  }, { issues: issues });
}

function assistant_(req, turns, question, sources) {
  var c = req.c;
  var r = question ? block_(function () { return c.knowledge.ask(question); }) : [null, null];
  var answer = r[0];
  var shown = (answer ? answer.sources : []).filter(function (s) {
    return sources.indexOf(s.source === 'jira' ? 'jira' : 'confluence') >= 0;
  });
  return render_(req, 'knowledge', 'knowledge', {
    turns: turns, frage: question, answer: answer, shown_sources: shown, quellen: sources, error: r[1], questions: QUESTIONS
  });
}

function knowledgeChat_(req) {
  var p = req.params;
  var fs = all_(p, 'f'), as = all_(p, 'a');
  var turns = [];
  for (var i = 0; i < Math.min(fs.length, as.length); i++) turns.push([fs[i], as[i]]);
  var question = all_(p, 'frage').map(function (q) { return q.trim(); }).filter(String)[0] || '';
  return assistant_(req, turns.slice(-MAX_TURNS), question, all_(p, 'quelle'));
}

function bugsPage_(req) {
  var c = req.c;
  var r = block_(function () { return c.servicenow.bugs(); });
  var leads = bugSummaries(r[0] || []);
  if (leads.length) return { redirect: '/bugs/' + encodeURIComponent(leads[0].number) };
  return render_(req, 'bugs', 'bugs', { leads: leads, error: r[1], bug: null, result: null });
}

function bugDetail_(req, number) {
  var c = req.c;
  var r = block_(function () { return c.servicenow.bugs(); });
  var all = r[0] || [];
  var leads = bugSummaries(all);
  var bug = all.filter(function (b) { return b.number === number; })[0] || null;
  if (!bug) return render_(req, 'bugs', 'bugs', { leads: leads, error: r[1], bug: null, result: null });
  var a = block_(function () { return c.rca.analyze(bug); });
  var safeBug = {};
  Object.keys(bug).forEach(function (k) { if (k !== 'caller') safeBug[k] = bug[k]; }); // Melder bleibt auf dem Server
  if (a[0]) a[0].bug = safeBug;
  return render_(req, 'bugs', 'bugs', {
    leads: leads, error: r[1] || a[1], bug: safeBug, result: a[0], severity: severityOf(bug.priority)
  }, { bugs: all });
}

function bugExplanation_(req, number) {
  var c = req.c;
  try {
    var bug = c.servicenow.bugs().filter(function (b) { return b.number === number; })[0];
    if (!bug) return { json: { error: 'Bug nicht gefunden.' }, status: 404 };
    var out = explainRca(c.rca.analyze(bug), c.llm);
    return { json: { text: out[0], generated: out[1] }, status: 200 };
  } catch (exc) {
    if (exc instanceof SourceUnavailable) {
      return { json: { error: 'Die Befunde sind gerade nicht erreichbar. Bitte erneut versuchen.' }, status: 503 };
    }
    throw exc;
  }
}

function streamsPage_(req) {
  var c = req.c;
  var r = block_(function () { return c.jira.dashboardIssues(); });
  var issues = r[0] || [];
  var portfolio = streamPortfolio(issues);
  return render_(req, 'streams', 'streams', {
    portfolio: portfolio,
    epic_count: portfolio.reduce(function (a, s) { return a + s.epics.length; }, 0),
    story_count: portfolio.reduce(function (a, s) { return a + s.total; }, 0),
    unassigned_count: portfolio.reduce(function (a, s) { return a + s.unassigned; }, 0),
    country_count: issues.filter(function (i) { return issueScope(i) === 'adfcr'; }).length,
    error: r[1]
  }, { issues: issues });
}

function documentsPage_(req) {
  var c = req.c;
  var art = last_(req.params, 'art');
  var docs = c.documents ? c.documents.documents() : [];
  var counts = { guide: 0, training: 0 };
  docs.forEach(function (d) { if (d.kind in counts) counts[d.kind] += 1; });
  var shown = docs.filter(function (d) { return (d.kind === 'guide' || d.kind === 'training') && (!art || d.kind === art); });
  return render_(req, 'documents', 'docs', {
    docs: shown, art: art, kinds: { guide: DOC_KIND_LABELS.guide, training: DOC_KIND_LABELS.training }, counts: counts,
    total: counts.guide + counts.training
  });
}

function releasesPage_(req) {
  var c = req.c;
  var docs = c.documents ? c.documents.documents() : [];
  return render_(req, 'releases', 'releases', { changes: docs.filter(function (d) { return d.kind === 'changelog'; }) });
}

/** Nur erlaubte, interne Pfade als Ziel einer Weiterleitung. */
function safeInternalRedirect(value) {
  value = String(value || '');
  if (value.charAt(0) !== '/' || value.indexOf('//') === 0 || value.indexOf('\\') >= 0) return '/';
  if (/[\x00-\x1f]/.test(value) || /^[a-z]+:/i.test(value)) return '/';
  return value;
}

/** Nur mit Testdaten: Person und Rolle wechseln, um Rechte und „Meine Tickets“ auszuprobieren. */
function switchUser_(req) {
  var c = req.c, p = req.params;
  var target = safeInternalRedirect(last_(p, 'back', '/'));
  if (c.settings.dataSource !== 'mock') return { redirect: target };
  var props = userProps_();
  var email = last_(p, 'user').trim().toLowerCase();
  if (email) props.setProperty('mock_user', email);
  var role = last_(p, 'role');
  if (SETTINGS.roles.indexOf(role) >= 0) props.setProperty('mock_role', role);
  return { redirect: target };
}

function switchLanguage_(req) {
  var p = req.params;
  userProps_().setProperty('lang', last_(p, 'lang') === 'en' ? 'en' : 'de');
  return { redirect: safeInternalRedirect(last_(p, 'back', '/')) };
}
