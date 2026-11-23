/**
 * BigQuery als Datenspeicher (Skripteigenschaft BQ_DATASET schaltet es ein).
 *
 * Warum: Jira und Confluence live abzufragen dauert, und Confluence ist von Google aus nicht erreichbar. Ein
 * Abgleich (Zeitauslöser alle 15 Minuten) liest Jira (nur GET), liest den Confluence-Export aus einem Drive-Ordner,
 * zerlegt neue oder geänderte Texte in Chunks (Rag.gs), berechnet deren Vektoren mit Vertex und schreibt alles in
 * einen EIGENEN Datensatz. Die Seiten lesen dann nur noch aus BigQuery; die Suche (Stichwörter + Vektoren) rechnet
 * BigQuery über die Tabelle chunks, pro Suche wird nur noch die Anfrage selbst eingebettet.
 *
 * Sicherheit:
 *   - Jira und Confluence bleiben nur lesend (assertReadOnly_ in Adapters.gs). Einzige zusätzliche POST-Adresse
 *     ist der Abfrage-Endpunkt von BigQuery.
 *   - Jede SQL-Anweisung läuft durch assertOwnDataset_: nur SELECT, MERGE, DELETE, INSERT und CREATE ... IF NOT
 *     EXISTS, nur Tabellen im eigenen Datensatz, kein DROP/TRUNCATE/ALTER/GRANT, eine Anweisung je Aufruf.
 *   - Daten gehen nur als Parameter in die Abfrage, nie in den SQL-Text.
 *
 * Tabellen im Datensatz:
 *   issues      Jira-Tickets, in_search (Suche/Streams) und in_country (Country Report)
 *   pages       Confluence-Seiten aus dem Export
 *   chunks      Abschnitte der Tickets und Seiten (siehe Rag.gs) mit Wortstämmen und Vektor: darauf läuft die Suche
 *   sync_state  letzter Lauf je Quelle (Zeitpunkt, Ergebnis, Anzahl)
 */

var BQ_HOST_ = 'https://bigquery.googleapis.com/bigquery/v2/projects/';
var BQ_ROWS_PER_WRITE_ = 200;    // höchstens so viele Zeilen je Schreibanfrage
var BQ_EMBED_PER_RUN_ = 2500;    // höchstens so viele neue Vektoren (Chunks) je Lauf (Laufzeitgrenze 6 Minuten)
var BQ_RUN_SECONDS_ = 270;       // danach keine neuen Schreibpakete mehr, Rest im nächsten Lauf
var BQ_EMBED_CHARS_ = 4500;      // so viel Text je Chunk geht höchstens ins Embedding (Modellgrenze 2.000 Token)
var BQ_WRITE_CHARS_ = 3500000;   // Zeichen je Schreibanfrage (Grenze 10 MB, Umlaute zählen doppelt)
var BQ_BACKFILL_DOCS_ = { issues: 400, pages: 120 }; // so viele Tickets/Seiten holt ein Lauf höchstens nach
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
  this.query('-- op: schema\nCREATE TABLE IF NOT EXISTS ' + this.t('chunks') + ' (chunk_id STRING NOT NULL, source STRING, doc_id STRING, ' +
    'chunk_no INT64, heading STRING, text STRING, terms ARRAY<STRING>, n_terms INT64, emb_model STRING, embedding ARRAY<FLOAT64>, ' +
    'synced_at TIMESTAMP) CLUSTER BY source, doc_id');
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

var BQ_ISSUE_COLS_ = [['key', 'S'], ['summary', 'S'], ['description', 'S'], ['status', 'S'], ['reporter', 'S'], ['updated', 'T'],
  ['created', 'T'], ['resolved', 'T'], ['stream', 'S'], ['epic', 'S'], ['issue_type', 'S'], ['url', 'S'], ['board_scope', 'S'],
  ['in_search', 'B'], ['in_country', 'B']];
var BQ_PAGE_COLS_ = [['id', 'S'], ['title', 'S'], ['body', 'S'], ['space', 'S'], ['url', 'S']];

function bqTable_(table) {
  return table === 'issues'
    ? { name: 'issues', source: 'jira', key: 'key', title: 'summary', body: 'description', cols: BQ_ISSUE_COLS_, textOf: issueText_ }
    : { name: 'pages', source: 'confluence', key: 'id', title: 'title', body: 'body', cols: BQ_PAGE_COLS_, textOf: pageText_ };
}

/** Zeilen in Pakete teilen, die unter der Größengrenze einer Anfrage bleiben. */
function bqBatches_(rows) {
  var out = [], batch = [], size = 0;
  rows.forEach(function (r) {
    var n = JSON.stringify(r).length;
    if (batch.length && (size + n > BQ_WRITE_CHARS_ || batch.length >= BQ_ROWS_PER_WRITE_)) { out.push(batch); batch = []; size = 0; }
    batch.push(r); size += n;
  });
  if (batch.length) out.push(batch);
  return out;
}

/**
 * Zerlegt Tickets/Seiten in Chunks (Rag.gs), bettet sie mit Vertex ein und schreibt sie in die Tabelle chunks.
 * docs: [{k, title, body}]. Höchstens report.embedBudget neue Vektoren je Lauf und nur bis report.deadline; was
 * nicht mehr drankommt, bleibt für den nächsten Lauf. Liefert {k: true} für alles, was fertig geschrieben ist.
 */
function writeChunks_(bq, t, docs, s, embedder, runIso, report) {
  var cfg = chunkConfig_(s), taken = [], texts = [];
  for (var d = 0; d < docs.length; d++) {
    var chunks = chunkDoc_({ source: t.source, title: docs[d].title, body: docs[d].body }, cfg);
    if (embedder && chunks.length > report.embedBudget) break;
    if (embedder) report.embedBudget -= chunks.length;
    taken.push({ k: docs[d].k, chunks: chunks });
    chunks.forEach(function (ch) { texts.push(ch.embed_text.slice(0, BQ_EMBED_CHARS_)); });
  }
  var vecs = null;
  if (embedder && texts.length) {
    try {
      vecs = embedder.embed(texts);
      report.embedded += texts.length;
    } catch (exc) {
      if (!(exc instanceof LlmUnavailable)) throw exc;
      report.notes.push('Vektoren fehlen (' + exc.message + '), nächster Lauf versucht es wieder');
      return {};
    }
  }
  var n = 0, done = {};
  var groups = bqBatches_(taken.map(function (doc) {
    return { k: doc.k, rows: doc.chunks.map(function (ch) {
      var terms = termsOf_(ch.embed_text), vec = vecs ? vecs[n] : null;
      n += 1;
      return { chunk_id: t.source + ':' + doc.k + '#' + ch.chunk_no, source: t.source, doc_id: doc.k, chunk_no: ch.chunk_no, heading: ch.heading,
        text: ch.text, terms: terms, n_terms: terms.length, emb_model: vec ? s.vertexEmbeddingModel : null,
        embedding: vec ? vec.map(function (x) { return Math.round(x * 1e5) / 1e5; }) : [] };
    }) };
  }));
  for (var g = 0; g < groups.length; g++) {
    if (Date.now() > report.deadline) { report.notes.push('Zeit knapp, Rest im nächsten Lauf'); break; }
    var rows = [];
    groups[g].forEach(function (doc) { rows = rows.concat(doc.rows); });
    // Erst die alten Chunks dieser Tickets/Seiten weg, dann die neuen hinein.
    bq.query('-- op: chunks-delete\nDELETE FROM ' + bq.t('chunks') + ' WHERE source = @source AND doc_id IN UNNEST(JSON_VALUE_ARRAY(@ids))',
      { source: t.source, ids: JSON.stringify(groups[g].map(function (doc) { return doc.k; })) });
    bq.query('-- op: chunks-insert\nINSERT INTO ' + bq.t('chunks') + ' (chunk_id, source, doc_id, chunk_no, heading, text, terms, n_terms, emb_model, embedding, synced_at) ' +
      "SELECT JSON_VALUE(r, '$.chunk_id'), JSON_VALUE(r, '$.source'), JSON_VALUE(r, '$.doc_id'), CAST(JSON_VALUE(r, '$.chunk_no') AS INT64), " +
      "JSON_VALUE(r, '$.heading'), JSON_VALUE(r, '$.text'), JSON_VALUE_ARRAY(r, '$.terms'), CAST(JSON_VALUE(r, '$.n_terms') AS INT64), " +
      "JSON_VALUE(r, '$.emb_model'), ARRAY(SELECT CAST(x AS FLOAT64) FROM UNNEST(JSON_VALUE_ARRAY(r, '$.embedding')) AS x WITH OFFSET o ORDER BY o), " +
      'TIMESTAMP(@run) FROM UNNEST(JSON_QUERY_ARRAY(@rows)) AS r', { rows: JSON.stringify(rows), run: runIso });
    groups[g].forEach(function (doc) { done[doc.k] = true; });
  }
  return done;
}

/**
 * Schreibt Zeilen per MERGE. Vorher: welche Texte sind neu oder geändert (Fingerabdruck), oder mit einer anderen
 * Chunk-Einstellung zerlegt (Kennung in emb_model)? Nur die werden neu zerlegt und eingebettet. Zeilen, die in diesem
 * Lauf nicht mehr drankommen, bekommen keinen Fingerabdruck; backfill_ holt sie in den nächsten Läufen nach.
 * onlyChanged: nur neue/geänderte Zeilen schreiben (Confluence); sonst alle (Jira, wegen Status & Co.).
 */
function bqUpsert_(bq, table, rows, s, embedder, runIso, report, onlyChanged) {
  if (!rows.length) return;
  var t = bqTable_(table), marker = chunkMarker_(s);
  var existing = {};
  for (var g = 0; g < rows.length; g += 5000) {
    var keys = rows.slice(g, g + 5000).map(function (r) { return r[t.key]; });
    bq.query('-- op: existing-' + table + '\nSELECT ' + t.key + ' AS k, text_hash, emb_model FROM ' + bq.t(table) +
      ' WHERE ' + t.key + ' IN UNNEST(JSON_VALUE_ARRAY(@keys))', { keys: JSON.stringify(keys) })
      .forEach(function (r) { existing[r.k] = r; });
  }
  var hashes = {};
  var changed = rows.filter(function (r) {
    var h = hashes[r[t.key]] = textHash_(t.textOf(r));
    var e = existing[r[t.key]];
    return !e || e.text_hash !== h || e.emb_model !== marker;
  });
  var done = changed.length ? writeChunks_(bq, t, changed.map(function (r) { return { k: r[t.key], title: r[t.title], body: r[t.body] }; }),
    s, embedder, runIso, report) : {};
  if (Object.keys(done).length < changed.length) report.pending = true;
  var write = (onlyChanged ? changed : rows).map(function (r) {
    var o = {}, k = r[t.key], e = existing[k];
    t.cols.forEach(function (c) { var v = r[c[0]]; o[c[0]] = v instanceof Date ? v.toISOString() : v === undefined ? null : v; });
    // Fingerabdruck nur, wenn die Chunks zum Text passen.
    o.text_hash = done[k] || (e && e.text_hash === hashes[k] && e.emb_model === marker) ? hashes[k] : null;
    o.emb_model = done[k] ? marker : null;
    return o;
  });
  var batches = bqBatches_(write);
  for (var b = 0; b < batches.length; b++) {
    if (Date.now() > report.deadline) { report.pending = true; report.notes.push('Zeit knapp, Rest im nächsten Lauf'); break; }
    bq.query(bqMergeSql_(bq, table, t.key, t.cols), { rows: JSON.stringify(batches[b]), run: runIso });
  }
}

/** Tickets/Seiten ohne passende Chunks (Rest aus früheren Läufen, neue Chunk-Einstellung) nachträglich zerlegen. */
function backfill_(bq, s, embedder, runIso, report) {
  var marker = chunkMarker_(s);
  ['issues', 'pages'].forEach(function (table) {
    if ((embedder && report.embedBudget <= 0) || Date.now() > report.deadline) return;
    var t = bqTable_(table);
    // Voller Text (wie beim Abgleich), damit der Fingerabdruck derselbe ist und nichts doppelt eingebettet wird.
    var rows = bq.query('-- op: backfill-' + table + '\nSELECT ' + t.key + ' AS k, IFNULL(' + t.title + ", '') AS title, IFNULL(" + t.body + ", '') AS body FROM " +
      bq.t(table) + ' WHERE text_hash IS NULL OR emb_model IS NULL OR emb_model != @marker LIMIT @n', { marker: marker, n: BQ_BACKFILL_DOCS_[table] });
    if (!rows.length) return;
    var done = writeChunks_(bq, t, rows, s, embedder, runIso, report);
    var ok = rows.filter(function (r) { return done[r.k]; }).map(function (r) { return { k: r.k, text_hash: textHash_(r.title + '. ' + r.body) }; });
    if (ok.length < rows.length || rows.length >= BQ_BACKFILL_DOCS_[table]) report.pending = true;
    bqBatches_(ok).forEach(function (batch) {
      bq.query('-- op: mark-' + table + '\nMERGE ' + bq.t(table) + " T USING (SELECT JSON_VALUE(r, '$.k') AS k, JSON_VALUE(r, '$.text_hash') AS text_hash " +
        'FROM UNNEST(JSON_QUERY_ARRAY(@rows)) AS r) S ON T.' + t.key + ' = S.k ' +
        'WHEN MATCHED THEN UPDATE SET text_hash = S.text_hash, emb_model = @marker', { rows: JSON.stringify(batch), marker: marker });
    });
  });
}

function bqMergeSql_(bq, table, keyCol, cols) {
  var sel = cols.map(function (c) {
    var j = "JSON_VALUE(r, '$." + c[0] + "')";
    return (c[1] === 'T' ? 'TIMESTAMP(' + j + ')' : c[1] === 'B' ? 'CAST(' + j + ' AS BOOL)' : j) + ' AS ' + c[0];
  });
  sel.push("JSON_VALUE(r, '$.text_hash') AS text_hash", "JSON_VALUE(r, '$.emb_model') AS emb_model");
  var set = cols.filter(function (c) { return c[0] !== keyCol; }).map(function (c) { return c[0] + ' = S.' + c[0]; });
  set.push('text_hash = S.text_hash', 'emb_model = IFNULL(S.emb_model, T.emb_model)', 'synced_at = TIMESTAMP(@run)');
  var names = cols.map(function (c) { return c[0]; }).concat(['text_hash', 'emb_model', 'synced_at']);
  var vals = cols.map(function (c) { return 'S.' + c[0]; }).concat(['S.text_hash', 'S.emb_model', 'TIMESTAMP(@run)']);
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
  bqUpsert_(bq, 'issues', rows, c.settings, syncEmbedder_(c), runIso, report);
  if (full) {
    // Was Jira nicht mehr liefert (gelöscht, verschoben), fliegt raus. Über die Keys, nicht über die Zeit: so bleibt
    // auch bei einem abgebrochenen Lauf nichts Gültiges auf der Strecke.
    bq.query('-- op: prune-issues\nDELETE FROM ' + bq.t('issues') + ' WHERE key NOT IN UNNEST(JSON_VALUE_ARRAY(@keys))',
      { keys: JSON.stringify(rows.map(function (r) { return r.key; })) });
    pruneChunks_(bq, 'jira', rows.map(function (r) { return r.key; }));
  }
  report.jira = rows.length;
  return { mark: runAt, last_run: runAt, last_full: full ? runAt : prev.last_full, ok: true,
    note: (full ? 'Vollabgleich' : 'Teilabgleich') + ': ' + rows.length + ' Tickets', row_count: rows.length };
}

function pruneChunks_(bq, source, keys) {
  bq.query('-- op: chunks-prune\nDELETE FROM ' + bq.t('chunks') + ' WHERE source = @source AND doc_id NOT IN UNNEST(JSON_VALUE_ARRAY(@keys))',
    { source: source, keys: JSON.stringify(keys) });
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
    if (p && p.body && !seen[p.id]) { seen[p.id] = true; p.body = p.body.slice(0, RAG_PAGE_CHARS_); pages.push(p); }
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
    return { id: String(p.id || ''), title: String(p.title || ''), body: htmlToText_(p.body || ''),
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
  var body = htmlToText_(bodyHtml);
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
  bqUpsert_(bq, 'pages', exp.pages, s, syncEmbedder_(c), runIso, report, true);
  // Der Ordner ist immer der ganze Stand: Seiten, die nicht mehr drin sind, fliegen raus.
  bq.query('-- op: prune-pages\nDELETE FROM ' + bq.t('pages') + ' WHERE id NOT IN UNNEST(JSON_VALUE_ARRAY(@keys))',
    { keys: JSON.stringify(exp.pages.map(function (p) { return p.id; })) });
  pruneChunks_(bq, 'confluence', exp.pages.map(function (p) { return p.id; }));
  report.confluence = exp.pages.length;
  // Nicht fertig geworden (Zeit): Ordner beim nächsten Lauf erneut lesen; schon Geschriebenes wird übersprungen.
  return { mark: report.pending ? prev.mark : exp.updated || runAt, last_run: runAt, last_full: runAt, ok: true,
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
  var report = { jira: 0, confluence: '-', embedded: 0, notes: [], ok: true, pending: false,
    embedBudget: BQ_EMBED_PER_RUN_, deadline: Date.now() + BQ_RUN_SECONDS_ * 1000 };
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
    try {
      backfill_(bq, c.settings, syncEmbedder_(c), runAt.toISOString(), report);
    } catch (exc) {
      if (exc instanceof WriteDisabled) throw exc;
      report.notes.push('Nachbetten: ' + safeFetchMessage_(exc));
    }
    if (report.pending) report.notes.push('Noch nicht alles zerlegt und eingebettet, geht im nächsten Lauf weiter');
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
  return 'Abgleich ' + (r.ok ? 'fertig' : 'mit Fehlern') + ': Jira ' + r.jira + ' Tickets, Confluence ' + r.confluence + ' Seiten' +
    ', neu eingebettet ' + r.embedded + ' Abschnitte' + (r.notes.length ? '. Hinweise: ' + r.notes.join(' | ') : '');
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
  return this.bq.query('-- op: pages\nSELECT id, title, SUBSTR(body, 1, 6000) AS body, space, url FROM ' + this.bq.t('pages') + ' ORDER BY title').map(function (r) {
    return { id: r.id, title: r.title || '', body: r.body || '', space: r.space || '', url: r.url || '' };
  });
};

/**
 * Ähnlichkeitssuche für die älteren Seiten (Wissen, Ticketprüfung): nutzt dieselbe Suche über die Chunks (Rag.gs).
 * Nur die Anfrage wird eingebettet (ein Vertex-Aufruf), den Rest rechnet BigQuery. Dokumente aus dem Drive-Ordner (wenige) kommen aus dem Speicher dazu.
 * Ohne Vertex (oder wenn BigQuery ausfällt) läuft die bisherige Suche im Speicher.
 */
function BigQueryIndex(c, fallback) { this.c = c; this.fallback = fallback; this.docs = null; }
BigQueryIndex.prototype.search = function (text, k, minScore) {
  k = k || 5; minScore = minScore || 0;
  if (!String(text).trim()) return [];
  var c = this.c, found;
  try {
    found = c.retriever.search(text, {});
  } catch (exc) {
    if (!(exc instanceof SourceUnavailable)) throw exc;
    c.notices.push('BigQuery ist gerade nicht erreichbar (' + exc.message + '). Gesucht wird direkt in Jira.');
    return this.fallback().search(text, k, minScore);
  }
  if (!found.vector) return this.fallback().search(text, k, minScore);
  var byDoc = {}, hits = [];
  found.rows.forEach(function (r) {
    if (r.vec === null || r.vec === undefined) return;
    var id = r.source + ':' + r.doc_id;
    if (byDoc[id]) { if (r.vec > byDoc[id].score) { byDoc[id].score = r.vec; byDoc[id].snippet = r.text.slice(0, SNIPPET_LEN); } return; }
    hits.push(byDoc[id] = { id: r.doc_id, score: r.vec, title: r.source === 'jira' ? r.doc_id + ': ' + r.title : r.title, url: r.url, source: r.source,
      snippet: r.text.slice(0, SNIPPET_LEN), payload: r.source === 'jira' ? { status: r.status, stream: r.stream, epic: r.epic } : { space: r.space } });
  });
  hits.forEach(function (h) { h.score = pyRound(h.score, 4); });
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
