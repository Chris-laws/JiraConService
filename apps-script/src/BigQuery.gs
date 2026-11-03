/**
 * BigQuery als Datenspeicher (Skripteigenschaft BQ_DATASET schaltet es ein).
 *
 * Warum: Jira und Confluence live abzufragen dauert, und Confluence ist von Google aus nicht erreichbar. Ein
 * Abgleich (Zeitauslöser alle 15 Minuten) liest Jira (nur GET), liest den Confluence-Export aus einem Drive-Ordner,
 * berechnet für neue oder geänderte Texte die Vektoren mit Vertex und schreibt alles in einen EIGENEN Datensatz.
 * Die Seiten lesen dann nur noch aus BigQuery; die Ähnlichkeitssuche rechnet BigQuery über die gespeicherten
 * Vektoren, pro Suche wird nur noch die Anfrage selbst eingebettet.
 *
 * Sicherheit:
 *   - Jira und Confluence bleiben nur lesend (assertReadOnly_ in Adapters.gs). Einzige zusätzliche POST-Adresse
 *     ist der Abfrage-Endpunkt von BigQuery.
 *   - Jede SQL-Anweisung läuft durch assertOwnDataset_: nur SELECT, MERGE, DELETE, INSERT und CREATE ... IF NOT
 *     EXISTS, nur Tabellen im eigenen Datensatz, kein DROP/TRUNCATE/ALTER/GRANT, eine Anweisung je Aufruf.
 *   - Daten gehen nur als Parameter in die Abfrage, nie in den SQL-Text.
 *
 * Tabellen im Datensatz:
 *   issues      Jira-Tickets, in_search (Suche/Streams) und in_country (Country Report), Vektor je Ticket
 *   pages       Confluence-Seiten aus dem Export, Vektor je Seite
 *   sync_state  letzter Lauf je Quelle (Zeitpunkt, Ergebnis, Anzahl)
 */

var BQ_HOST_ = 'https://bigquery.googleapis.com/bigquery/v2/projects/';
var BQ_ROWS_PER_WRITE_ = 60;     // Zeilen je MERGE (mit Vektoren gut unter der Größengrenze einer Anfrage)
var BQ_EMBED_CHARS_ = 2000;      // so viel Text je Ticket/Seite geht ins Embedding
var BQ_FULL_EVERY_HOURS_ = 20;   // spätestens so oft ein Vollabgleich (entfernt gelöschte/verschobene Tickets)
var BQ_OVERLAP_MINUTES_ = 10;    // Überlappung beim Teilabgleich, damit nichts durch die Lücke fällt

// ---------- Sperre für SQL ----------

var BQ_FORBIDDEN_ = /\b(DROP|TRUNCATE|ALTER|GRANT|REVOKE|EXPORT|LOAD|CALL|EXECUTE|BEGIN|COMMIT|ROLLBACK|DECLARE|SET\s+@@|REPLACE\s+TABLE|OR\s+REPLACE)\b/i;
var BQ_ALLOWED_START_ = /^(SELECT|WITH|MERGE|DELETE\s+FROM|INSERT\s+INTO|CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS|CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS)\b/i;

/** Wirft WriteDisabled, wenn die Anweisung etwas anderes als den eigenen Datensatz anfasst oder gefährlich ist. */
function assertOwnDataset_(sql, project, dataset) {
  var body = String(sql).replace(/^\s*--[^\n]*\n/gm, '').trim().replace(/;\s*$/, '');
  var fail = function (why) { throw new WriteDisabled('BigQuery-Sperre: ' + why); };
  if (!BQ_ALLOWED_START_.test(body)) fail('nur SELECT, MERGE, DELETE, INSERT und CREATE … IF NOT EXISTS erlaubt');
  if (BQ_FORBIDDEN_.test(body)) fail('verbotenes Schlüsselwort');
  if (body.replace(/'[^']*'/g, '').indexOf(';') >= 0) fail('nur eine Anweisung je Aufruf');
  var own = project + '.' + dataset;
  var refs = body.match(/`[^`]*`/g) || [];
  refs.forEach(function (ref) {
    var name = ref.slice(1, -1);
    if (name !== own && name.indexOf(own + '.') !== 0) fail('Tabelle außerhalb des eigenen Datensatzes: ' + name);
  });
  if (!/^SELECT|^WITH/i.test(body) && !refs.length) fail('Schreibziel muss voll benannt sein (`projekt.datensatz.tabelle`)');
}

// ---------- Client (REST jobs.query, Google-Anmeldung des Skripts) ----------

function BigQueryClient(s) {
  if (!/^[A-Za-z0-9_]{1,1024}$/.test(String(s.bqDataset || ''))) throw new ConfigError('BQ_DATASET darf nur Buchstaben, Ziffern und _ enthalten');
  if (!/^[a-z0-9][a-z0-9.:-]{4,}$/.test(String(s.bqProject || ''))) throw new ConfigError('BQ_PROJECT (oder VERTEX_PROJECT_ID) fehlt');
  this.project = s.bqProject;
  this.dataset = s.bqDataset;
  this.location = s.bqLocation || 'EU';
  if (!/^[A-Za-z0-9-]{2,40}$/.test(this.location)) throw new ConfigError('BQ_LOCATION ist ungültig (z. B. EU oder europe-west3)');
}
/** Voll benannte Tabelle in Backticks. */
BigQueryClient.prototype.t = function (name) { return '`' + this.project + '.' + this.dataset + '.' + name + '`'; };

/**
 * Führt eine Anweisung aus und liefert die Zeilen als Objekte (Zeitstempel als Date, BOOL/INT64/FLOAT64 als Zahl).
 * params: {name: Wert}; Strings, Zahlen, true/false und Arrays von Zahlen (Vektoren) sind erlaubt.
 */
BigQueryClient.prototype.query = function (sql, params) {
  assertOwnDataset_(sql, this.project, this.dataset);
  var url = BQ_HOST_ + this.project + '/queries';
  var body = { query: sql, useLegacySql: false, location: this.location, timeoutMs: 30000, maxResults: 20000,
    parameterMode: 'NAMED', queryParameters: bqParams_(params || {}) };
  var opts = { headers: bqHeaders_(this.project), json: body, error: SourceUnavailable };
  var data = requestJson('POST', url, opts);
  var rows = (data.rows || []).slice();
  var job = data.jobReference || {};
  var token = data.pageToken;
  var schema = data.schema;
  for (var n = 0; (!data.jobComplete || token) && n < 60; n++) {
    var params2 = { location: this.location, timeoutMs: 30000, maxResults: 20000 };
    if (token) params2.pageToken = token;
    data = requestJson('GET', url + '/' + encodeURIComponent(job.jobId), { headers: bqHeaders_(this.project), params: params2, error: SourceUnavailable });
    if (data.jobComplete) { schema = data.schema; rows = rows.concat(data.rows || []); token = data.pageToken; }
  }
  if (!data.jobComplete) throw new SourceUnavailable('BigQuery-Abfrage dauert zu lange');
  return bqRows_(schema, rows);
};

function bqHeaders_(project) {
  try {
    return vertexHeaders(project);
  } catch (e) {
    throw new SourceUnavailable('Kein Google-Token für BigQuery. Bitte die Web-App einmal neu autorisieren.');
  }
}

function bqParams_(params) {
  return Object.keys(params).map(function (name) {
    var v = params[name];
    if (Array.isArray(v)) {
      return { name: name, parameterType: { type: 'ARRAY', arrayType: { type: 'FLOAT64' } },
        parameterValue: { arrayValues: v.map(function (x) { return { value: String(+x) }; }) } };
    }
    var type = typeof v === 'number' ? (Math.floor(v) === v ? 'INT64' : 'FLOAT64') : typeof v === 'boolean' ? 'BOOL' : 'STRING';
    return { name: name, parameterType: { type: type }, parameterValue: v === null || v === undefined ? {} : { value: String(v) } };
  });
}

function bqValue_(field, cell) {
  var v = cell === null || cell === undefined ? null : cell.v;
  if (field.mode === 'REPEATED') return (v || []).map(function (x) { return bqValue_({ type: field.type }, x); });
  if (v === null || v === undefined) return null;
  switch (field.type) {
    case 'TIMESTAMP': return new Date(Math.round(parseFloat(v) * 1000));
    case 'BOOL': case 'BOOLEAN': return v === true || v === 'true';
    case 'INT64': case 'INTEGER': return parseInt(v, 10);
    case 'FLOAT64': case 'FLOAT': return parseFloat(v);
    default: return String(v);
  }
}

function bqRows_(schema, rows) {
  var fields = (schema && schema.fields) || [];
  return rows.map(function (r) {
    var o = {};
    fields.forEach(function (f, i) { o[f.name] = bqValue_(f, r.f[i]); });
    return o;
  });
}

// ---------- Tabellen ----------

BigQueryClient.prototype.ensureSchema = function () {
  // DDL nimmt keine Parameter; der Ort ist oben auf Buchstaben, Ziffern und - geprüft.
  this.query('-- op: schema\nCREATE SCHEMA IF NOT EXISTS `' + this.project + '.' + this.dataset + "` OPTIONS(location = '" + this.location + "')");
  this.query('-- op: schema\nCREATE TABLE IF NOT EXISTS ' + this.t('issues') + ' (key STRING NOT NULL, summary STRING, description STRING, ' +
    'status STRING, reporter STRING, updated TIMESTAMP, created TIMESTAMP, resolved TIMESTAMP, stream STRING, epic STRING, ' +
    'issue_type STRING, url STRING, board_scope STRING, in_search BOOL, in_country BOOL, text_hash STRING, emb_model STRING, ' +
    'embedding ARRAY<FLOAT64>, synced_at TIMESTAMP) CLUSTER BY key');
  this.query('-- op: schema\nCREATE TABLE IF NOT EXISTS ' + this.t('pages') + ' (id STRING NOT NULL, title STRING, body STRING, ' +
    'space STRING, url STRING, text_hash STRING, emb_model STRING, embedding ARRAY<FLOAT64>, synced_at TIMESTAMP)');
  this.query('-- op: schema\nCREATE TABLE IF NOT EXISTS ' + this.t('sync_state') + ' (source STRING NOT NULL, mark TIMESTAMP, ' +
    'last_run TIMESTAMP, last_full TIMESTAMP, ok BOOL, note STRING, row_count INT64)');
};

BigQueryClient.prototype.state = function () {
  var out = {};
  this.query('-- op: state-read\nSELECT source, mark, last_run, last_full, ok, note, row_count FROM ' + this.t('sync_state'))
    .forEach(function (r) { out[r.source] = r; });
  return out;
};
BigQueryClient.prototype.saveState = function (source, st) {
  this.query('-- op: state-write\nMERGE ' + this.t('sync_state') + ' T USING (SELECT @source AS source) S ON T.source = S.source ' +
    'WHEN MATCHED THEN UPDATE SET mark = TIMESTAMP(@mark), last_run = TIMESTAMP(@last_run), last_full = TIMESTAMP(@last_full), ' +
    'ok = @ok, note = @note, row_count = @rows ' +
    'WHEN NOT MATCHED THEN INSERT (source, mark, last_run, last_full, ok, note, row_count) ' +
    'VALUES (@source, TIMESTAMP(@mark), TIMESTAMP(@last_run), TIMESTAMP(@last_full), @ok, @note, @rows)', {
    source: source, mark: isoOrNull_(st.mark), last_run: isoOrNull_(st.last_run), last_full: isoOrNull_(st.last_full),
    ok: !!st.ok, note: String(st.note || '').slice(0, 500), rows: st.row_count || 0
  });
};

function isoOrNull_(d) { return d ? new Date(d).toISOString() : null; }

/** Kurzer Fingerabdruck eines Textes: ändert er sich, wird neu eingebettet. */
function textHash_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)).slice(0, 22);
}

function issueText_(i) { return i.summary + '. ' + i.description; }
function pageText_(p) { return p.title + '. ' + p.body; }

/**
 * Schreibt Zeilen per MERGE (Schlüssel keyCol). Vorher: welche Texte sind neu oder geändert? Nur die gehen an Vertex.
 * Schlägt Vertex fehl, werden die Zeilen ohne Vektor geschrieben und der alte Fingerabdruck bleibt, damit der
 * nächste Lauf es erneut versucht.
 */
function bqUpsert_(bq, table, keyCol, rows, textOf, embedder, model, runIso, report) {
  if (!rows.length) return;
  var existing = {};
  for (var g = 0; g < rows.length; g += 2000) {
    var keys = rows.slice(g, g + 2000).map(function (r) { return r[keyCol]; });
    bq.query('-- op: existing-' + table + '\nSELECT ' + keyCol + ' AS k, text_hash, emb_model FROM ' + bq.t(table) +
      ' WHERE ' + keyCol + ' IN UNNEST(JSON_VALUE_ARRAY(@keys))', { keys: JSON.stringify(keys) })
      .forEach(function (r) { existing[r.k] = r; });
  }
  rows.forEach(function (r) { r.text_hash = textHash_(textOf(r)); });
  var todo = embedder ? rows.filter(function (r) {
    var e = existing[r[keyCol]];
    return !e || e.text_hash !== r.text_hash || e.emb_model !== model;
  }) : [];
  if (todo.length) {
    try {
      var vecs = embedder.embed(todo.map(function (r) { return textOf(r).slice(0, BQ_EMBED_CHARS_); }));
      todo.forEach(function (r, n) { r.embedding = vecs[n].map(function (x) { return Math.round(x * 1e5) / 1e5; }); r.emb_model = model; });
      report.embedded += todo.length;
    } catch (exc) {
      if (!(exc instanceof LlmUnavailable)) throw exc;
      report.notes.push('Vektoren fehlen (' + exc.message + '), nächster Lauf versucht es wieder');
    }
  }
  var cols = table === 'issues' ? BQ_ISSUE_COLS_ : BQ_PAGE_COLS_;
  for (var s = 0; s < rows.length; s += BQ_ROWS_PER_WRITE_) {
    var chunk = rows.slice(s, s + BQ_ROWS_PER_WRITE_).map(function (r) {
      var o = {};
      cols.forEach(function (c) { var v = r[c[0]]; o[c[0]] = v instanceof Date ? v.toISOString() : v === undefined ? null : v; });
      o.embedding = r.embedding || [];
      o.emb_model = r.emb_model || null;
      o.text_hash = r.text_hash;
      return o;
    });
    bq.query(bqMergeSql_(bq, table, keyCol, cols), { rows: JSON.stringify(chunk), run: runIso });
  }
}

var BQ_ISSUE_COLS_ = [['key', 'S'], ['summary', 'S'], ['description', 'S'], ['status', 'S'], ['reporter', 'S'], ['updated', 'T'],
  ['created', 'T'], ['resolved', 'T'], ['stream', 'S'], ['epic', 'S'], ['issue_type', 'S'], ['url', 'S'], ['board_scope', 'S'],
  ['in_search', 'B'], ['in_country', 'B']];
var BQ_PAGE_COLS_ = [['id', 'S'], ['title', 'S'], ['body', 'S'], ['space', 'S'], ['url', 'S']];

function bqMergeSql_(bq, table, keyCol, cols) {
  var sel = cols.map(function (c) {
    var j = "JSON_VALUE(r, '$." + c[0] + "')";
    return (c[1] === 'T' ? 'TIMESTAMP(' + j + ')' : c[1] === 'B' ? 'CAST(' + j + ' AS BOOL)' : j) + ' AS ' + c[0];
  });
  sel.push("JSON_VALUE(r, '$.text_hash') AS text_hash", "JSON_VALUE(r, '$.emb_model') AS emb_model",
    "ARRAY(SELECT CAST(x AS FLOAT64) FROM UNNEST(JSON_VALUE_ARRAY(r, '$.embedding')) AS x WITH OFFSET o ORDER BY o) AS embedding");
  var has = 'ARRAY_LENGTH(S.embedding) > 0';
  var set = cols.filter(function (c) { return c[0] !== keyCol; }).map(function (c) { return c[0] + ' = S.' + c[0]; });
  set.push('text_hash = IF(' + has + ', S.text_hash, T.text_hash)', 'emb_model = IF(' + has + ', S.emb_model, T.emb_model)',
    'embedding = IF(' + has + ', S.embedding, T.embedding)', 'synced_at = TIMESTAMP(@run)');
  var names = cols.map(function (c) { return c[0]; }).concat(['text_hash', 'emb_model', 'embedding', 'synced_at']);
  var vals = cols.map(function (c) { return 'S.' + c[0]; }).concat(['IF(' + has + ', S.text_hash, NULL)', 'S.emb_model', 'S.embedding', 'TIMESTAMP(@run)']);
  return '-- op: merge-' + table + '\nMERGE ' + bq.t(table) + ' T USING (SELECT ' + sel.join(', ') +
    ' FROM UNNEST(JSON_QUERY_ARRAY(@rows)) AS r) S ON T.' + keyCol + ' = S.' + keyCol +
    ' WHEN MATCHED THEN UPDATE SET ' + set.join(', ') +
    ' WHEN NOT MATCHED THEN INSERT (' + names.join(', ') + ') VALUES (' + vals.join(', ') + ')';
}

// ---------- Abgleich Jira ----------

/** Jira-Tickets für den Abgleich: Suche/Streams und Country Report getrennt markiert, nach Key zusammengeführt. */
function jiraSyncRows_(reader) {
  var byKey = {}, order = [];
  var put = function (i, flags) {
    if (!byKey[i.key]) { byKey[i.key] = cloneIssue_(i, { in_search: false, in_country: false }); order.push(i.key); }
    Object.keys(flags).forEach(function (k) { byKey[i.key][k] = flags[k]; });
  };
  reader.countryIssues().forEach(function (i) { put(i, { in_country: true }); });
  reader.searchIssues().forEach(function (i) { put(i, { in_search: true, stream: i.stream, board_scope: i.board_scope }); });
  return order.map(function (k) { return byKey[k]; });
}

function syncJira_(c, bq, st, full, runAt, report) {
  var reader = new JiraRestReader(c.settings);
  var prev = st.jira || {};
  if (!full && prev.mark) {
    reader.since = Math.ceil((runAt - prev.mark) / 60000) + BQ_OVERLAP_MINUTES_;
  }
  var rows = jiraSyncRows_(reader);
  var runIso = runAt.toISOString();
  bqUpsert_(bq, 'issues', 'key', rows, issueText_, syncEmbedder_(c), c.settings.vertexEmbeddingModel, runIso, report);
  if (full) {
    bq.query('-- op: prune-issues\nDELETE FROM ' + bq.t('issues') + ' WHERE synced_at < TIMESTAMP(@run)', { run: runIso });
  }
  report.jira = rows.length;
  return { mark: runAt, last_run: runAt, last_full: full ? runAt : prev.last_full, ok: true,
    note: (full ? 'Vollabgleich' : 'Teilabgleich') + ': ' + rows.length + ' Tickets', row_count: rows.length };
}

/** Für den Abgleich nur Vertex (die Vektoren müssen zur Suche passen); ohne Vertex wird ohne Vektoren gespeichert. */
function syncEmbedder_(c) {
  var s = c.settings;
  if (s.embeddings !== 'vertex') return null;
  var e = new VertexEmbedder(s.vertexProjectId, s.vertexLocation, s.vertexEmbeddingModel);
  e.batch = 12; // lange Tickets: so bleibt jedes Paket unter der Token-Grenze je Anfrage
  return e;
}

// ---------- Abgleich Confluence (Export im Drive-Ordner) ----------

/**
 * Liest den Confluence-Export aus dem Drive-Ordner CONFLUENCE_EXPORT_FOLDER_ID:
 *   - ZIP aus „Bereich exportieren → HTML“ (Bereichs-Admin), die Seiten heißen Titel_12345.html
 *   - einzelne .html-Dateien
 *   - .doc aus „Seite exportieren → Word“ (MIME-HTML, auch ohne Admin-Rechte möglich)
 * Liefert {pages, updated} (updated = jüngste Änderung im Ordner).
 */
function readConfluenceExport_(folderId, baseUrl) {
  var it = DriveApp.getFolderById(folderId).getFiles();
  var files = [];
  while (it.hasNext()) files.push(it.next());
  // Neueste Datei zuerst: steht eine Seite in mehreren Exporten, gilt der jüngste Stand.
  files = sortBy(files.map(function (f) { return { f: f, at: f.getLastUpdated() }; }), function (x) { return -x.at.getTime(); });
  var pages = [], seen = {}, updated = null;
  var push = function (p) {
    if (p && p.body && !seen[p.id]) { seen[p.id] = true; pages.push(p); }
  };
  var add = function (name, html) { push(parseConfluenceHtml_(name, html, baseUrl)); };
  files.forEach(function (x) {
    var f = x.f, name = f.getName();
    if (!updated || x.at > updated) updated = x.at;
    if (/\.zip$/i.test(name)) {
      var blob = f.getBlob();
      if (blob.setContentType) blob.setContentType('application/zip');
      Utilities.unzip(blob).forEach(function (b) {
        var n = b.getName();
        if (/\.html?$/i.test(n) && !/(^|\/)index\.html?$/i.test(n)) add(n, b.getDataAsString('UTF-8'));
      });
    } else if (/\.json$/i.test(name)) {
      confluenceJsonPages_(f.getBlob().getDataAsString('UTF-8'), name).forEach(push);
    } else if (/\.html?$/i.test(name)) {
      add(name, f.getBlob().getDataAsString('UTF-8'));
    } else if (/\.doc$/i.test(name)) {
      add(name, mimeHtml_(f.getBlob().getDataAsString('UTF-8')));
    }
  });
  return { pages: pages, updated: updated };
}

/**
 * Datei vom Confluence-Knopf (Confluence-Knopf.html): {format: 'confluence-pages', space, pages: [{id, title, body, url}]},
 * body als Confluence-HTML. Der Knopf liest im Browser mit der eigenen Anmeldung, nur lesend.
 */
function confluenceJsonPages_(text, name) {
  var data;
  try { data = JSON.parse(text); } catch (e) { throw new SourceUnavailable('Confluence-Datei ' + name + ' ist kein gültiges JSON'); }
  if (!data || data.format !== 'confluence-pages' || !Array.isArray(data.pages)) return [];
  var safeUrl = function (u) { return /^https:\/\//i.test(String(u || '')) ? String(u) : ''; };
  return data.pages.map(function (p) {
    return { id: String(p.id || ''), title: String(p.title || ''), body: stripHtml(String(p.body || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')),
      space: String(p.space || data.space || ''), url: safeUrl(p.url) };
  }).filter(function (p) { return p.id && p.title; });
}

/** Confluence aus dem Drive-Ordner, für den Betrieb ohne BigQuery. */
function DriveConfluence(s) { this.s = s; }
DriveConfluence.prototype.pages = function () {
  try {
    return readConfluenceExport_(this.s.confluenceExportFolderId, this.s.confluenceUrl).pages;
  } catch (exc) {
    if (exc instanceof SourceUnavailable) throw exc;
    throw new SourceUnavailable('Confluence-Export im Drive-Ordner nicht lesbar: ' + safeFetchMessage_(exc));
  }
};

/** HTML-Teil einer Word-Export-Datei (MIME, quoted-printable). */
function mimeHtml_(text) {
  var start = text.search(/<html[\s>]/i), end = text.search(/<\/html>/i);
  var html = start >= 0 ? text.slice(start, end > start ? end + 7 : undefined) : text;
  if (/quoted-printable/i.test(text)) {
    html = html.replace(/=\r?\n/g, '');
    try {
      html = decodeURIComponent(html.replace(/%/g, '%25').replace(/=([0-9A-F]{2})/g, '%$1'));
    } catch (e) {
      html = html.replace(/=([0-9A-F]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
    }
  }
  return html;
}

function parseConfluenceHtml_(fileName, html, baseUrl) {
  var t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  var full = t ? stripHtml(t[1]) : '';
  var space = '', title = full;
  var sep = full.indexOf(' : ');
  if (sep > 0) { space = full.slice(0, sep).trim(); title = full.slice(sep + 3).trim(); }
  var base = String(fileName).split('/').pop().replace(/\.(html?|doc)$/i, '');
  var idm = /(?:^|_)(\d{3,})$/.exec(base);
  var id = idm ? idm[1] : base;
  var bodyHtml = html;
  var main = html.search(/id="main-content"/i);
  if (main >= 0) {
    bodyHtml = html.slice(html.indexOf('>', main) + 1);
    var stop = bodyHtml.search(/class="pageSection|id="footer"|<\/body>/i);
    if (stop >= 0) bodyHtml = bodyHtml.slice(0, Math.max(0, bodyHtml.lastIndexOf('<', stop)));
  } else {
    var b = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (b) bodyHtml = b[1];
  }
  bodyHtml = bodyHtml.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  var body = stripHtml(bodyHtml);
  if (!title) title = base.replace(/_\d+$/, '').replace(/[-_]+/g, ' ');
  var url = idm && baseUrl ? baseUrl.replace(/\/+$/, '') + '/pages/viewpage.action?pageId=' + id : '';
  return { id: id, title: title, body: body, space: space, url: url };
}

function syncConfluence_(c, bq, st, full, runAt, report) {
  var s = c.settings;
  var prev = st.confluence || {};
  var exp;
  if (s.confluenceExportFolderId) {
    exp = readConfluenceExport_(s.confluenceExportFolderId, s.confluenceUrl);
  } else {
    // Ohne Export-Ordner direkt aus Confluence (nur wenn es erreichbar ist, siehe testConfluence), einmal am Tag.
    if (!full && prev.ok && prev.last_full) { report.confluence = 'täglich'; return null; }
    exp = { pages: new ConfluenceRest(s).pages(), updated: runAt };
  }
  if (!full && prev.mark && exp.updated && exp.updated <= prev.mark && prev.ok) {
    report.confluence = 'unverändert';
    return null; // nichts Neues im Ordner
  }
  var runIso = runAt.toISOString();
  bqUpsert_(bq, 'pages', 'id', exp.pages, pageText_, syncEmbedder_(c), s.vertexEmbeddingModel, runIso, report);
  // Der Ordner ist immer der ganze Stand: Seiten, die nicht mehr drin sind, fliegen raus.
  bq.query('-- op: prune-pages\nDELETE FROM ' + bq.t('pages') + ' WHERE synced_at < TIMESTAMP(@run)', { run: runIso });
  report.confluence = exp.pages.length;
  return { mark: exp.updated || runAt, last_run: runAt, last_full: runAt, ok: true,
    note: exp.pages.length + (s.confluenceExportFolderId ? ' Seiten aus dem Export' : ' Seiten direkt aus Confluence'), row_count: exp.pages.length };
}

// ---------- Abgleich: Einstieg für Zeitauslöser und Editor ----------

/**
 * Einmal im Editor ausführen: legt Datensatz und Tabellen an, gleicht einmal komplett ab und richtet den
 * Zeitauslöser (alle 15 Minuten) ein. Braucht BQ_DATASET in den Skripteigenschaften.
 */
function abgleichEinrichten() {
  var c = buildContainer();
  if (!c.bq) throw new ConfigError('BQ_DATASET fehlt in den Skripteigenschaften (z. B. reqalign).');
  c.bq.ensureSchema();
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'abgleich') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('abgleich').timeBased().everyMinutes(15).create();
  var report = runSync_(c, true);
  Logger.log('Eingerichtet. Zeitauslöser alle 15 Minuten. ' + syncSummary_(report));
  return report;
}

/** Zeitauslöser (alle 15 Minuten): Teilabgleich, einmal täglich Vollabgleich. */
function abgleich() { return runSync_(buildContainer(), false); }

/** Im Editor: sofort alles neu abgleichen (z. B. nach einem neuen Confluence-Export). */
function abgleichVoll() { return runSync_(buildContainer(), true); }

function runSync_(c, forceFull) {
  if (!c.bq) throw new ConfigError('BQ_DATASET fehlt in den Skripteigenschaften.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('Abgleich läuft schon, dieser Lauf entfällt.'); return { skipped: true }; }
  var report = { jira: 0, confluence: '-', embedded: 0, notes: [], ok: true };
  try {
    var bq = c.bq;
    var st = bq.state();
    var runAt = new Date();
    var jiraPrev = st.jira || {};
    var full = forceFull || !jiraPrev.last_full || (runAt - jiraPrev.last_full) > BQ_FULL_EVERY_HOURS_ * 3600000;
    var sources = [['jira', function () { return syncJira_(c, bq, st, full, runAt, report); }]];
    if (c.settings.confluenceExportFolderId || (c.settings.confluenceUrl && c.settings.confluencePat)) sources.push(['confluence', function () { return syncConfluence_(c, bq, st, full, runAt, report); }]);
    sources.forEach(function (src) {
      var res;
      try {
        res = src[1]();
      } catch (exc) {
        if (exc instanceof WriteDisabled || exc instanceof ConfigError) throw exc;
        report.ok = false;
        report.notes.push(src[0] + ': ' + safeFetchMessage_(exc));
        var old = st[src[0]] || {};
        res = { mark: old.mark, last_run: runAt, last_full: old.last_full, ok: false, note: safeFetchMessage_(exc), row_count: old.row_count };
      }
      if (res) {
        if (report.notes.length && res.ok) res.note += ' · ' + report.notes.join(' · ');
        bq.saveState(src[0], res);
      }
    });
    // Hat sich etwas geändert: alte Listen im Cache verwerfen. Danach den Cache füllen (falls leer), damit die erste
    // Person nach dem Abgleich nicht wartet.
    if (full || report.jira) bumpCacheVersion_('jira');
    if (typeof report.confluence === 'number') bumpCacheVersion_('confluence');
    var fresh = buildContainer(c.settings);
    try { fresh.jira.dashboardIssues(); fresh.jira.searchIssues(); } catch (e) { report.notes.push('Cache: ' + safeFetchMessage_(e)); }
  } finally {
    lock.releaseLock();
  }
  Logger.log(syncSummary_(report));
  return report;
}

function syncSummary_(r) {
  return 'Abgleich ' + (r.ok ? 'fertig' : 'mit Fehlern') + ': Jira ' + r.jira + ' Tickets, Confluence ' + r.confluence +
    ', neu eingebettet ' + r.embedded + (r.notes.length ? '. Hinweise: ' + r.notes.join(' | ') : '');
}

// ---------- Lesen aus BigQuery (die Seiten der App) ----------

var BQ_ISSUE_SELECT_ = 'key, summary, description, status, reporter, updated, url, stream, epic, issue_type, created, resolved, board_scope';

function bqIssue_(r) {
  var o = {};
  BQ_ISSUE_SELECT_.split(', ').forEach(function (k) { o[k] = r[k] === undefined ? null : r[k]; });
  o.summary = o.summary || ''; o.description = o.description || ''; o.status = o.status || ''; o.reporter = o.reporter || '';
  o.issue_type = o.issue_type || 'Story';
  return o;
}

/** Jira-Daten aus BigQuery. „Meine Tickets“ fragt weiter live in Jira (immer aktuell, kleine Abfrage). */
function BigQueryJira(bq, live) { this.bq = bq; this.live = live; }
BigQueryJira.prototype.searchIssues = function () {
  return this.bq.query('-- op: search-issues\nSELECT ' + BQ_ISSUE_SELECT_ + ' FROM ' + this.bq.t('issues') +
    ' WHERE in_search ORDER BY updated DESC').map(bqIssue_);
};
BigQueryJira.prototype.dashboardIssues = function () {
  return this.bq.query('-- op: dashboard-issues\nSELECT ' + BQ_ISSUE_SELECT_.replace('stream, ', 'IF(in_country, NULL, stream) AS stream, ')
    .replace('board_scope', "IF(in_country, 'adfcr', COALESCE(board_scope, stream)) AS board_scope") + ' FROM ' + this.bq.t('issues') +
    ' WHERE in_country OR in_search ORDER BY in_country DESC, updated DESC').map(bqIssue_);
};
BigQueryJira.prototype.issuesByReporter = function (email) { return this.live.issuesByReporter(email); };

function BigQueryConfluence(bq) { this.bq = bq; }
BigQueryConfluence.prototype.pages = function () {
  return this.bq.query('-- op: pages\nSELECT id, title, body, space, url FROM ' + this.bq.t('pages') + ' ORDER BY title').map(function (r) {
    return { id: r.id, title: r.title || '', body: r.body || '', space: r.space || '', url: r.url || '' };
  });
};

/**
 * Ähnlichkeitssuche in BigQuery über die gespeicherten Vektoren: nur die Anfrage wird eingebettet (ein Vertex-Aufruf),
 * den Rest rechnet BigQuery. Dokumente aus dem Drive-Ordner (wenige) kommen aus dem Speicher dazu.
 * Ohne Vertex (oder wenn BigQuery ausfällt) läuft die bisherige Suche im Speicher.
 */
function BigQueryIndex(c, fallback) { this.c = c; this.fallback = fallback; this.docs = null; }
BigQueryIndex.prototype.search = function (text, k, minScore) {
  k = k || 5; minScore = minScore || 0;
  if (!String(text).trim()) return [];
  var c = this.c;
  var q = c.embedder.embed([text])[0];
  if (c.embedder.name !== 'vertex') return this.fallback().search(text, k, minScore);
  var hits;
  try {
    hits = c.bq.query('-- op: vector-search\nSELECT source, id, title, url, snippet, payload, 1 - ML.DISTANCE(embedding, @q, \'COSINE\') AS score FROM (' +
      "SELECT 'jira' AS source, key AS id, CONCAT(key, ': ', IFNULL(summary, '')) AS title, url, " +
      "SUBSTR(CONCAT(IFNULL(summary, ''), '. ', IFNULL(description, '')), 1, @len) AS snippet, " +
      'TO_JSON_STRING(STRUCT(status, stream, epic)) AS payload, embedding FROM ' + c.bq.t('issues') +
      ' WHERE in_search AND emb_model = @model AND ARRAY_LENGTH(embedding) = @dim UNION ALL ' +
      "SELECT 'confluence', id, title, url, SUBSTR(CONCAT(IFNULL(title, ''), '. ', IFNULL(body, '')), 1, @len), " +
      'TO_JSON_STRING(STRUCT(space)), embedding FROM ' + c.bq.t('pages') +
      ' WHERE emb_model = @model AND ARRAY_LENGTH(embedding) = @dim) ORDER BY score DESC LIMIT @k',
    { q: q, model: c.settings.vertexEmbeddingModel, dim: q.length, len: SNIPPET_LEN, k: k }).map(function (r) {
      var payload = {};
      try { payload = JSON.parse(r.payload || '{}'); } catch (e) { payload = {}; }
      return { id: r.id, score: pyRound(r.score, 4), title: r.title || '', url: r.url || '', source: r.source, snippet: r.snippet || '', payload: payload };
    });
  } catch (exc) {
    if (!(exc instanceof SourceUnavailable)) throw exc;
    c.notices.push('BigQuery ist gerade nicht erreichbar (' + exc.message + '). Gesucht wird direkt in Jira.');
    return this.fallback().search(text, k, minScore);
  }
  hits = hits.concat(this.docIndex_().search(text, k, minScore));
  return sortBy(hits.filter(function (h) { return h.score >= minScore; }), function (h) { return -h.score; }).slice(0, k);
};
BigQueryIndex.prototype.docIndex_ = function () {
  if (this.docs) return this.docs;
  var index = new VectorIndex(this.c.embedder);
  var docs = [];
  try { docs = this.c.documents.documents(); } catch (e) { docs = []; }
  index.add(docs.map(function (d) {
    return { id: d.id, text: d.title + '. ' + d.body, title: d.title, url: d.url, source: d.kind, payload: {} };
  }));
  this.docs = index;
  return index;
};

/** Stand des Abgleichs für die Admin-Seite. */
function syncStatus_(bq) {
  var st = bq.state();
  return ['jira', 'confluence'].filter(function (k) { return st[k]; }).map(function (k) {
    var r = st[k];
    return { source: k, ok: r.ok, last_run: r.last_run, note: r.note || '', rows: r.row_count || 0 };
  });
}

/** Echter Zeitpunkt als „2026-11-03 14:05“ in der Zeitzone des Skripts. */
function formatLocal_(date) {
  var tz = (typeof Session !== 'undefined' && Session.getScriptTimeZone) ? Session.getScriptTimeZone() : 'Europe/Berlin';
  return Utilities.formatDate(date, tz, "yyyy-MM-dd'T'HH:mm:ss").replace('T', ' ').slice(0, 16);
}
