/**
 * Bereitet die Daten für die Seiten auf. Jede Zahl auf einer Seite wird hier aus den Zeilen berechnet,
 * nie getrennt gepflegt. Formatierung (Datum, Bezeichnungen) passiert in der Oberfläche (JsHelpers.html).
 */

var CLOSED = ['DONE', 'REJECTED'];
var WAITING = ['ON HOLD DM', 'ON HOLD'];
var DOC_KIND_LABELS = { changelog: 'Change Log', guide: 'Anleitung', training: 'Schulung' };
var MONTHS_DE = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
var STREAM_HUES = ['blue', 'teal', 'amber', 'rose', 'green', 'sky'];
// Farben der Statusverteilung in Reihenfolge des Lebenszyklus
var DONUT_COLORS = ['#0050AA', '#5AA9FF', '#A9C9EE', '#FFB020', '#FFD400', '#248A3D', '#4ADE80', '#B8C2D3', '#7C8BA6', '#C9D3E3'];

var PHASE_LABELS = {
  'NEW REQUIREMENT': 'Neue Anforderung', 'VALIDATION INT': 'Prüfung INT', 'ON HOLD DM': 'Wartet auf DM',
  'VALIDATION TEAM': 'Prüfung Team', 'ON HOLD': 'Zurückgestellt', 'DEVELOPMENT BACKLOG': 'Entwicklungs-Backlog',
  'SELECTED FOR DEVELOPMENT': 'In Planung', 'READY FOR DEPLOYMENT': 'Bereit zum Rollout', 'DONE': 'Erledigt', 'REJECTED': 'Abgelehnt'
};

function isOpen(issue) { return CLOSED.indexOf(upper(issue.status)) < 0; }

function phaseLabel(status) {
  var s = upper(status);
  return PHASE_LABELS[s] || (status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : '');
}

function streamLabel(streamId) {
  if (!streamId) return '–';
  for (var i = 0; i < STREAMS.length; i++) if (STREAMS[i].id === streamId) return STREAMS[i].name.split(' (')[0];
  return streamId;
}

/** vorname.nachname@… → Vorname Nachname. */
function displayName(email) {
  if (!email) return '';
  var local = email.split('@')[0];
  return local.replace(/_/g, '.').split('.').filter(String).map(function (p) {
    return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  }).join(' ');
}

function initials(name) {
  return name.split(/\s+/).filter(String).slice(0, 2).map(function (p) { return p.charAt(0); }).join('').toUpperCase() || '?';
}

/** Country Report ist ein eigenes Board, nie ein fünfter Stream. */
function issueScope(issue) {
  if (issue.board_scope === 'adfcr' || upper(issue.key).indexOf('ADFCR-') === 0) return 'adfcr';
  return issue.board_scope || issue.stream;
}

/** Bereich und Suche arbeiten auf demselben geladenen Jira-Stand. */
function filterScopeIssues(issues, scope, allowed, query, phase, epic) {
  var selected = allowed.concat(['adfcr']).indexOf(scope) >= 0 ? scope : '';
  var needle = String(query || '').trim().toLowerCase();
  return sortBy(issues.filter(function (i) {
    return (!selected || issueScope(i) === selected) &&
      (!epic || i.epic === epic) &&
      (!phase || upper(i.status) === upper(phase)) &&
      (!needle || (i.key + ' ' + i.summary + ' ' + i.description).toLowerCase().indexOf(needle) >= 0);
  }), function (i) { return i.updated; }, true);
}

/** Erstellte und gelöste Tickets je Monat; nie aus `updated` geschätzt. */
function yearActivity(issues, year) {
  var created = [], resolved = [];
  for (var m = 0; m < 12; m++) { created.push(0); resolved.push(0); }
  issues.forEach(function (i) {
    if (i.created && i.created.getUTCFullYear() === year) created[i.created.getUTCMonth()] += 1;
    if (i.resolved && i.resolved.getUTCFullYear() === year) resolved[i.resolved.getUTCMonth()] += 1;
  });
  return MONTHS_DE.map(function (month, n) { return { month: month, created: created[n], resolved: resolved[n] }; });
}

/** Jeder Stream behält seine Farbe überall in der Oberfläche (Reihenfolge der Konfiguration). */
function streamHues() {
  var hues = {};
  activeStreams().forEach(function (s, n) { hues[s.id] = STREAM_HUES[n % STREAM_HUES.length]; });
  return hues;
}

function statusShares(issues) {
  var counts = {};
  issues.forEach(function (i) { var s = upper(i.status); counts[s] = (counts[s] || 0) + 1; });
  var total = issues.length || 1;
  var top = Math.max.apply(null, [0].concat(Object.keys(counts).map(function (k) { return counts[k]; }))) || 1;
  var life = SETTINGS.lifecycle;
  var rows = life.filter(function (s) { return counts[s]; });
  rows = rows.concat(Object.keys(counts).filter(function (s) { return life.indexOf(s) < 0; }).sort());
  return rows.map(function (s) {
    return {
      status: s, label: phaseLabel(s), count: counts[s], share: counts[s] / total, width: counts[s] / top,
      color: life.indexOf(s) >= 0 ? DONUT_COLORS[life.indexOf(s) % DONUT_COLORS.length] : '#75859A'
    };
  });
}

/** CSS conic-gradient für das Ringdiagramm. */
function donut(shares) {
  var parts = [], acc = 0;
  shares.forEach(function (s) {
    var start = acc;
    acc = acc + s.share * 100;
    parts.push(s.color + ' ' + start.toFixed(2) + '% ' + acc.toFixed(2) + '%');
  });
  return parts.length ? 'conic-gradient(' + parts.join(', ') + ')' : 'var(--fill)';
}

/** ServiceNow-Prioritäten 1 und 2 gelten als dringend. */
function severityOf(priority) { return ['1', '2'].indexOf(String(priority).charAt(0)) >= 0 ? 'high' : 'normal'; }

/** Für die Navigation reichen die Stammdaten; die Ursachenanalyse läuft nur für den gewählten Bug. */
function bugSummaries(bugs) {
  return sortBy(bugs, function (b) { return b.first_seen; }, true).map(function (b) {
    return { number: b.number, title: b.short_description, component: b.component, priority: b.priority,
      severity: severityOf(b.priority), first_seen: b.first_seen };
  });
}

function isStory_(issue) { return ['story', 'user story', 'user-story'].indexOf(String(issue.issue_type).toLowerCase()) >= 0; }

/** Jira-Storys je Stream und zentralem Epic. Country Report und Epics selbst zählen nicht als Storys. */
function streamPortfolio(issues) {
  var portfolio = activeStreams().map(function (stream) {
    var stories = sortBy(issues.filter(function (i) { return issueScope(i) === stream.id && isStory_(i); }),
      function (i) { return i.updated; }, true);
    var known = {};
    stream.epics.forEach(function (e) { known[e.key] = e.title; });
    var live = {};
    issues.forEach(function (i) {
      if (issueScope(i) === stream.id && String(i.issue_type).toLowerCase() === 'epic' && i.summary) live[i.key] = i.summary;
    });
    var extra = {};
    stories.forEach(function (i) { if (i.epic) extra[i.epic] = true; });
    Object.keys(live).forEach(function (k) { extra[k] = true; });
    var keys = Object.keys(known).concat(Object.keys(extra).filter(function (k) { return !(k in known); }).sort());
    var epics = keys.map(function (key) {
      var children = stories.filter(function (i) { return i.epic === key; });
      return {
        key: key,
        title: live[key] || known[key] || 'In Jira zugeordnet · nicht in der Stream-Konfiguration',
        total: children.length,
        open: children.filter(isOpen).length,
        stories: children.slice(0, 2),
        configured: key in known
      };
    });
    return {
      id: stream.id, name: streamLabel(stream.id), description: stream.description, total: stories.length,
      open: stories.filter(isOpen).length, unassigned: stories.filter(function (i) { return !i.epic; }).length, epics: epics
    };
  });
  return sortBy(portfolio, function (s) { return [-s.open, s.name]; });
}
