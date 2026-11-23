/**
 * Abgleich: Duplikat- und Ähnlichkeitssuche über Jira und Confluence (Hybrid-RAG mit Reranker).
 *
 * Ablauf einer Anfrage:
 *   1. Suche in den Abschnitten (Chunks) auf zwei Wegen: Stichwörter (BM25) und Bedeutung (Vektor, Vertex).
 *   2. Beide Ranglisten werden zusammengeführt (Reciprocal Rank Fusion).
 *   3. Der Reranker (Vertex Ranking API, sonst Gemini, sonst ohne) ordnet die besten Abschnitte neu.
 *   4. Abschnitte werden je Ticket/Seite zusammengefasst und eingestuft: Duplikat, ähnlich, verwandt.
 *   5. Streams und Epics kommen aus den ähnlichsten vorhandenen Tickets (Abstimmung der Nachbarn).
 *   6. „Wunsch“: zusätzlich ein Ticket-Entwurf, formuliert nach dem Vorbild ähnlicher Tickets.
 *
 * Chunking: Texte werden an Überschriften getrennt (Jira: h1. bis h6., Confluence: # aus dem HTML), kleine Abschnitte
 * zusammengelegt, große an Absätzen und Sätzen geteilt (mit Überlappung). Jeder Chunk trägt Titel und Überschrift
 * im Text, damit er auch allein verständlich ist. Größe: CHUNK_CHARS / CHUNK_OVERLAP (Skripteigenschaften); welche
 * Werte zu den eigenen Daten passen, sagt die Datenanalyse (Seite „Daten“, im Editor datenanalyse()).
 *
 * Mit BigQuery (BQ_DATASET) rechnet BigQuery die Suche über die Tabelle chunks; ohne läuft dasselbe im Speicher.
 */

var CHUNK_VERSION_ = 'v1';       // ändert sich die Art zu trennen, wird alles neu zerlegt
var CHUNK_MAX_PER_DOC_ = 80;     // Obergrenze je Ticket/Seite
var RAG_TERMS_MAX_ = 400;        // so viele Wortstämme je Chunk für die Stichwortsuche
var RAG_POOL_ = 60;              // Kandidaten je Suchweg
var RAG_RERANK_ = 40;            // so viele Abschnitte gehen an den Reranker
var RAG_DOCS_ = 12;              // so viele Tickets/Seiten zeigt das Ergebnis höchstens
var RAG_RRF_K_ = 60;             // Konstante der Reciprocal Rank Fusion
var RAG_PAGE_CHARS_ = 40000;     // so viel Text je Confluence-Seite wird gespeichert
var RAG_SOURCES_ = ['jira', 'confluence'];

// ---------- Text aus HTML, mit Struktur ----------

function decodeEntities_(text) {
  return String(text).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); }).replace(/&amp;/g, '&');
}

/**
 * HTML zu Text, aber mit Struktur: Überschriften werden zu „# Titel“ (Ebene = Anzahl #), Absätze und Listenpunkte
 * zu Zeilen. Text ohne HTML (z. B. schon vom Confluence-Knopf umgewandelt) behält seine Zeilen.
 */
function htmlToText_(value) {
  var t = String(value === null || value === undefined ? '' : value);
  if (/<[a-z\/!][^>]*>/i.test(t)) {
    t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/\s+/g, ' ');
    t = t.replace(/<h([1-6])[^>]*>/gi, function (m, n) { return '\n\n' + '######'.slice(0, +n) + ' '; }).replace(/<\/h[1-6]>/gi, '\n\n');
    t = t.replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|blockquote|pre|table|ul|ol)>/gi, '\n\n')
      .replace(/<\/(div|tr|section)>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ');
    t = t.replace(/<[^>]+>/g, ' ');
  }
  var lines = decodeEntities_(t).split(/\r?\n/).map(function (l) { return l.replace(/[ \t ]+/g, ' ').replace(/( \|)+\s*$/, '').trim(); })
    .filter(function (l) { return !/^#{1,6}$/.test(l) && l !== '-'; });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- Chunking ----------

function chunkConfig_(s) {
  var chars = Math.min(4000, Math.max(300, parseInt(s.chunkChars, 10) || 1200));
  var overlap = Math.min(Math.floor(chars / 3), Math.max(0, parseInt(s.chunkOverlap, 10) >= 0 ? parseInt(s.chunkOverlap, 10) : 150));
  return { chars: chars, overlap: overlap };
}

/** Kennung des Standes: Modell + Art zu trennen. Passt sie nicht mehr, wird neu zerlegt und eingebettet. */
function chunkMarker_(s) {
  var cfg = chunkConfig_(s);
  return (s.embeddings === 'vertex' ? s.vertexEmbeddingModel : 'ohne') + '|' + CHUNK_VERSION_ + '|' + cfg.chars + '|' + cfg.overlap;
}

var JIRA_HEADING_ = /^\s*h([1-6])\.\s+(.+?)\s*$/;
var MD_HEADING_ = /^\s*(#{1,6})\s+(.+?)\s*$/;

/**
 * Text in Abschnitte nach Überschriften. Jira kennt nur „h1.“ bis „h6.“ („# “ ist dort eine nummerierte Liste),
 * Confluence-Text trägt „#“ aus htmlToText_. Liefert [{path: 'A › B', name: 'B', text}].
 */
function sections_(text, source) {
  var out = [], stack = [], cur = { path: '', name: '', lines: [] };
  var push = function () {
    var body = cur.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body || cur.name) out.push({ path: cur.path, name: cur.name, text: body });
  };
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var m = JIRA_HEADING_.exec(line), level = 0, name = '';
    if (m) { level = +m[1]; name = m[2]; }
    else if (source !== 'jira' && (m = MD_HEADING_.exec(line))) { level = m[1].length; name = m[2]; }
    if (!level) { cur.lines.push(line); return; }
    push();
    name = name.replace(/[*_{}]+/g, '').trim();
    stack = stack.filter(function (h) { return h.level < level; });
    stack.push({ level: level, name: name });
    cur = { path: stack.map(function (h) { return h.name; }).join(' › '), name: name, lines: [] };
  });
  push();
  return out.filter(function (s) { return s.text || s.name; });
}

/** Zerlegt einen zu langen Text in Stücke bis max Zeichen: erst an Absätzen, dann an Sätzen, zur Not an Wörtern. */
function splitLong_(text, max) {
  var pieces = [];
  var cut = function (t, seps) {
    if (t.length <= max) { if (t.trim()) pieces.push(t.trim()); return; }
    if (!seps.length) {
      for (var i = 0; i < t.length;) {
        var end = Math.min(t.length, i + max);
        if (end < t.length) { var sp = t.lastIndexOf(' ', end); if (sp > i + max / 2) end = sp; }
        if (t.slice(i, end).trim()) pieces.push(t.slice(i, end).trim());
        i = end;
      }
      return;
    }
    var buf = '';
    t.split(seps[0]).forEach(function (part) {
      if (!part) return;
      if (buf && (buf + part).length > max) { cut(buf, seps.slice(1)); buf = ''; }
      buf += part;
    });
    if (buf) cut(buf, seps.slice(1));
  };
  cut(text, [/(\n{2,})/, /(\n)/, /((?<=[.!?])\s+)/]);
  return pieces;
}

/**
 * Chunks eines Tickets oder einer Seite: [{chunk_no, heading, text, embed_text}].
 * embed_text = Titel › Überschrift + Text; das geht ins Embedding, in die Stichwortsuche und an den Reranker.
 */
function chunkDoc_(doc, cfg) {
  var title = String(doc.title || '').trim();
  var units = [];
  sections_(doc.body, doc.source).forEach(function (sec) {
    var head = sec.name ? sec.name + '\n' : '';
    var room = Math.max(200, cfg.chars - head.length);
    var parts = sec.text ? splitLong_(sec.text, room) : [''];
    parts.forEach(function (p, n) { units.push({ path: sec.path, text: (n === 0 ? head : '') + p, cont: n > 0 }); });
  });
  var chunks = [], cur = null;
  var close = function () { if (cur && cur.text.trim()) chunks.push(cur); cur = null; };
  units.forEach(function (u) {
    if (cur && (cur.text.length + 2 + u.text.length > cfg.chars)) {
      var prev = cur.text;
      close();
      if (u.cont && cfg.overlap) {
        // Fortsetzung desselben Abschnitts: das Ende des vorigen Stücks kommt noch einmal mit (Überlappung).
        var tail = prev.slice(-cfg.overlap);
        var sp = tail.indexOf(' ');
        cur = { heading: u.path, text: '… ' + (sp >= 0 ? tail.slice(sp + 1) : tail) };
      }
    }
    if (!cur) cur = { heading: u.path, text: '' };
    cur.text += (cur.text ? '\n\n' : '') + u.text;
  });
  close();
  if (!chunks.length) chunks.push({ heading: '', text: '' }); // nur Titel (leere Beschreibung)
  return chunks.slice(0, CHUNK_MAX_PER_DOC_).map(function (ch, n) {
    var prefix = title + (ch.heading ? ' › ' + ch.heading : '');
    return { chunk_no: n, heading: ch.heading, text: ch.text, embed_text: (prefix + '\n' + ch.text).trim() };
  });
}

function termsOf_(text) { return tokens(text).slice(0, RAG_TERMS_MAX_); }

function distinct_(list) {
  var seen = {}, out = [];
  list.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
  return out;
}

// ---------- Suche im Speicher (ohne BigQuery, auch für Testdaten) ----------

function MemoryRetriever(c) { this.c = c; this.built = null; }

MemoryRetriever.prototype.docs_ = function () {
  var c = this.c, docs = [];
  var load = function (name, fn) {
    try { fn(); } catch (exc) {
      if (!(exc instanceof SourceUnavailable)) throw exc;
      c.notices.push(name + ' ist gerade nicht erreichbar (' + exc.message + ').');
    }
  };
  load('Jira', function () {
    c.jira.dashboardIssues().forEach(function (i) {
      docs.push({ source: 'jira', id: i.key, title: i.summary, body: i.description, url: i.url, status: i.status,
        stream: i.stream || (i.board_scope && i.board_scope !== 'adfcr' ? i.board_scope : null), epic: i.epic, space: null, updated: i.updated });
    });
  });
  load('Confluence', function () {
    c.confluence.pages().forEach(function (p) {
      docs.push({ source: 'confluence', id: p.id, title: p.title, body: p.body, url: p.url, status: null, stream: null, epic: null,
        space: p.space, updated: null });
    });
  });
  return docs;
};

MemoryRetriever.prototype.build_ = function () {
  if (this.built) return this.built;
  var cfg = chunkConfig_(this.c.settings), chunks = [], docs = this.docs_();
  docs.forEach(function (d) {
    chunkDoc_(d, cfg).forEach(function (ch) {
      var terms = termsOf_(ch.embed_text);
      chunks.push({ chunk_id: d.source + ':' + d.id + '#' + ch.chunk_no, doc: d, chunk_no: ch.chunk_no, heading: ch.heading, text: ch.text,
        embed_text: ch.embed_text, terms: terms });
    });
  });
  var vecs = this.c.embedder.embed(chunks.map(function (ch) { return ch.embed_text; }));
  chunks.forEach(function (ch, n) { ch.vec = vecs[n]; });
  var total = chunks.reduce(function (a, ch) { return a + ch.terms.length; }, 0);
  this.built = { docs: docs, chunks: chunks, avgdl: chunks.length ? total / chunks.length || 1 : 1 };
  return this.built;
};

MemoryRetriever.prototype.search = function (text, opts) {
  var b = this.build_();
  var sources = (opts && opts.sources) || RAG_SOURCES_;
  var pool = b.chunks.filter(function (ch) { return sources.indexOf(ch.doc.source) >= 0; });
  var qTerms = distinct_(tokens(text)).slice(0, 64);
  var q = pool.length ? this.c.embedder.embed([text])[0] : null;
  var tfs = pool.map(function (ch) {
    var tf = {};
    ch.terms.forEach(function (t) { if (qTerms.indexOf(t) >= 0) tf[t] = (tf[t] || 0) + 1; });
    return tf;
  });
  var df = {};
  tfs.forEach(function (tf) { Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; }); });
  var n = pool.length, avgdl = b.avgdl;
  var scored = pool.map(function (ch, i) {
    var tf = tfs[i], lex = 0, matched = Object.keys(tf);
    matched.forEach(function (t) {
      lex += Math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) * tf[t] * 2.2 / (tf[t] + 1.2 * (0.25 + 0.75 * ch.terms.length / avgdl));
    });
    return { ch: ch, lex: matched.length ? lex : null, cov: qTerms.length ? matched.length / qTerms.length : 0, vec: q ? dot(q, ch.vec) : null };
  });
  var rank = function (key) {
    var list = sortBy(scored.filter(function (r) { return r[key] !== null; }), function (r) { return [-r[key], r.ch.chunk_id]; }).slice(0, RAG_POOL_);
    list.forEach(function (r, i) { r[key + 'Rank'] = i + 1; });
  };
  rank('lex'); rank('vec');
  var rows = scored.filter(function (r) { return r.lexRank || r.vecRank; }).map(function (r) {
    var d = r.ch.doc;
    return { chunk_id: r.ch.chunk_id, source: d.source, doc_id: d.id, chunk_no: r.ch.chunk_no, heading: r.ch.heading, text: r.ch.text,
      rrf: (r.lexRank ? 1 / (RAG_RRF_K_ + r.lexRank) : 0) + (r.vecRank ? 1 / (RAG_RRF_K_ + r.vecRank) : 0),
      lex: r.lexRank ? r.lex : null, cov: r.lexRank ? r.cov : 0, vec: r.vecRank ? r.vec : null,
      title: d.title, url: d.url, status: d.status, stream: d.stream, epic: d.epic, space: d.space, updated: d.updated };
  });
  rows = sortBy(rows, function (r) { return [-r.rrf, r.chunk_id]; }).slice(0, RAG_RERANK_);
  return { rows: rows, vector: !!q, lexical: qTerms.length > 0, terms: qTerms.length, embedder: this.c.embedder.name };
};

/** Volle Texte einzelner Tickets (Vorbilder für die Formulierung). */
MemoryRetriever.prototype.issueTexts = function (keys) {
  return this.build_().docs.filter(function (d) { return d.source === 'jira' && keys.indexOf(d.id) >= 0; })
    .map(function (d) { return { id: d.id, title: d.title, body: d.body || '' }; });
};

// ---------- Suche in BigQuery ----------

function BigQueryRetriever(c) { this.c = c; }

/** Eine Abfrage: Stichwörter (BM25) und Vektor, zusammengeführt mit RRF, dazu die Angaben zum Ticket / zur Seite. */
function ragSql_(bq, lexical, vector) {
  var ch = bq.t('chunks');
  var src = 'source IN UNNEST(JSON_VALUE_ARRAY(@sources))';
  var parts = [];
  if (lexical) {
    parts.push('q AS (SELECT DISTINCT term FROM UNNEST(JSON_VALUE_ARRAY(@terms)) AS term)',
      'stats AS (SELECT COUNT(*) AS n, IFNULL(AVG(n_terms), 1) AS avgdl FROM ' + ch + ' WHERE ' + src + ')',
      'tf AS (SELECT c.chunk_id, t AS term, COUNT(*) AS tf, ANY_VALUE(c.n_terms) AS dl FROM ' + ch + ' AS c CROSS JOIN UNNEST(c.terms) AS t ' +
        'WHERE c.' + src + ' AND t IN (SELECT term FROM q) GROUP BY c.chunk_id, t)',
      'df AS (SELECT term, COUNT(*) AS df FROM tf GROUP BY term)',
      'lex AS (SELECT tf.chunk_id, SUM(LN(1 + (stats.n - df.df + 0.5) / (df.df + 0.5)) * tf.tf * 2.2 / ' +
        '(tf.tf + 1.2 * (0.25 + 0.75 * tf.dl / stats.avgdl))) AS score, COUNT(*) / @nq AS cov ' +
        'FROM tf JOIN df USING (term) CROSS JOIN stats GROUP BY tf.chunk_id)',
      'lexr AS (SELECT chunk_id, score, cov, ROW_NUMBER() OVER (ORDER BY score DESC, chunk_id) AS r FROM lex WHERE TRUE QUALIFY r <= @pool)');
  }
  if (vector) {
    parts.push("vec AS (SELECT chunk_id, 1 - ML.DISTANCE(embedding, @q, 'COSINE') AS score FROM " + ch +
        ' WHERE ' + src + ' AND emb_model = @model AND ARRAY_LENGTH(embedding) = @dim)',
      'vecr AS (SELECT chunk_id, score, ROW_NUMBER() OVER (ORDER BY score DESC, chunk_id) AS r FROM vec WHERE TRUE QUALIFY r <= @pool)');
  }
  var fused;
  if (lexical && vector) {
    fused = 'SELECT chunk_id, IFNULL(1 / (@rrf + lexr.r), 0) + IFNULL(1 / (@rrf + vecr.r), 0) AS rrf, lexr.score AS lex, ' +
      'IFNULL(lexr.cov, 0) AS cov, vecr.score AS vec FROM lexr FULL OUTER JOIN vecr USING (chunk_id)';
  } else if (lexical) {
    fused = 'SELECT chunk_id, 1 / (@rrf + r) AS rrf, score AS lex, cov, CAST(NULL AS FLOAT64) AS vec FROM lexr';
  } else {
    fused = 'SELECT chunk_id, 1 / (@rrf + r) AS rrf, CAST(NULL AS FLOAT64) AS lex, 0.0 AS cov, score AS vec FROM vecr';
  }
  parts.push('fused AS (' + fused + ')');
  return '-- op: hybrid-search\nWITH ' + parts.join(',\n') + '\n' +
    'SELECT c.chunk_id, c.source, c.doc_id, c.chunk_no, c.heading, c.text, f.rrf, f.lex, f.cov, f.vec, ' +
    'IFNULL(i.summary, p.title) AS title, IFNULL(i.url, p.url) AS url, i.status, i.stream, i.epic, p.space, i.updated ' +
    'FROM fused AS f JOIN ' + ch + ' AS c USING (chunk_id) ' +
    "LEFT JOIN " + bq.t('issues') + " AS i ON c.source = 'jira' AND i.key = c.doc_id " +
    "LEFT JOIN " + bq.t('pages') + " AS p ON c.source = 'confluence' AND p.id = c.doc_id " +
    'ORDER BY f.rrf DESC, c.chunk_id LIMIT @k';
}

BigQueryRetriever.prototype.search = function (text, opts) {
  var c = this.c, s = c.settings;
  var sources = (opts && opts.sources) || RAG_SOURCES_;
  var qTerms = distinct_(tokens(text)).slice(0, 64);
  var q = null;
  if (s.embeddings === 'vertex') {
    // Fällt Vertex aus, liefert der Embedder Offline-Vektoren: die passen nicht zu den gespeicherten, also nur Stichwörter.
    var v = c.embedder.embed([text])[0];
    if (c.embedder.name === 'vertex') q = v;
  }
  var out = { rows: [], vector: !!q, lexical: qTerms.length > 0, terms: qTerms.length, embedder: q ? 'vertex' : 'ohne' };
  if (!q && !qTerms.length) return out;
  var params = { sources: JSON.stringify(sources), pool: RAG_POOL_, rrf: RAG_RRF_K_, k: RAG_RERANK_ };
  if (qTerms.length) { params.terms = JSON.stringify(qTerms); params.nq = qTerms.length; }
  if (q) { params.q = q; params.model = s.vertexEmbeddingModel; params.dim = q.length; }
  out.rows = c.bq.query(ragSql_(c.bq, qTerms.length > 0, !!q), params).map(function (r) {
    r.title = r.title || r.doc_id; r.heading = r.heading || ''; r.text = r.text || ''; r.url = r.url || '';
    r.cov = r.cov || 0;
    return r;
  });
  return out;
};

BigQueryRetriever.prototype.issueTexts = function (keys) {
  if (!keys.length) return [];
  return this.c.bq.query('-- op: docs-by-id\nSELECT key AS id, summary AS title, SUBSTR(IFNULL(description, \'\'), 1, 6000) AS body FROM ' +
    this.c.bq.t('issues') + ' WHERE key IN UNNEST(JSON_VALUE_ARRAY(@keys))', { keys: JSON.stringify(keys) })
    .map(function (r) { return { id: r.id, title: r.title || '', body: r.body || '' }; });
};

// ---------- Reranker ----------

var RERANK_PROMPT_ = 'Bewerte, wie gut jeder Abschnitt inhaltlich zur Anfrage passt (0 = gar nicht, 100 = dasselbe Anliegen).\n' +
  'Antworte nur mit JSON: {"scores": {"1": 80, "2": 10}}.\nAnfrage:\n"""{question}"""\nAbschnitte:\n{text}';

/**
 * Ordnet die Abschnitte neu. RERANKER: auto (Ranking API, sonst Gemini, sonst ohne), ranking, gemini, none.
 * Liefert {rows, used, note}; rows tragen rerank (0 bis 1) oder null.
 */
function rerank_(c, query, rows) {
  var s = c.settings, mode = s.reranker || 'auto';
  var out = { rows: rows, used: 'none', note: '' };
  rows.forEach(function (r) { r.rerank = null; });
  if (!rows.length || mode === 'none' || !s.vertexProjectId) return out;
  var cache = CacheService.getScriptCache();
  var apply = function (scores, used) {
    rows.forEach(function (r) { if (typeof scores[r.chunk_id] === 'number') r.rerank = Math.max(0, Math.min(1, scores[r.chunk_id])); });
    out.rows = sortBy(rows, function (r) { return [r.rerank === null ? 1 : 0, -(r.rerank || 0), -r.rrf]; });
    out.used = used;
  };
  if (mode !== 'gemini' && !cache.get('rerank:aus')) {
    try {
      var records = rows.map(function (r) {
        return { id: r.chunk_id, title: String(r.title || '').slice(0, 200), content: ((r.heading ? r.heading + '\n' : '') + r.text).slice(0, 3000) || r.title };
      });
      apply(new VertexRanker(s.vertexProjectId, s.rankingModel).rank(redact(query), records), 'ranking');
      return out;
    } catch (exc) {
      if (!(exc instanceof LlmUnavailable)) throw exc;
      // Nicht bei jeder Anfrage erneut gegen eine abgeschaltete API laufen: 10 Minuten merken.
      try { cache.put('rerank:aus', '1', 600); } catch (e) { /* egal */ }
      out.note = 'Reranker (Vertex Ranking API) nicht erreichbar: ' + exc.message;
      if (mode === 'ranking') return out;
    }
  } else if (mode !== 'gemini') {
    out.note = 'Reranker (Vertex Ranking API) war zuletzt nicht erreichbar, nächster Versuch in wenigen Minuten.';
  }
  if (!c.llm.available) return out;
  try {
    var top = rows.slice(0, 20);
    var list = top.map(function (r, n) { return '[' + (n + 1) + '] ' + r.title + (r.heading ? ' › ' + r.heading : '') + ': ' + r.text.replace(/\s+/g, ' ').slice(0, 400); }).join('\n');
    var prompt = RERANK_PROMPT_.replace('{question}', redact(query).slice(0, 2000)).replace('{text}', redact(list));
    var data = JSON.parse(c.llm.generate(prompt, true));
    var scores = {};
    top.forEach(function (r, n) { var v = data && data.scores ? Number(data.scores[String(n + 1)]) : NaN; if (v >= 0) scores[r.chunk_id] = v / 100; });
    if (Object.keys(scores).length) apply(scores, 'gemini');
  } catch (exc) {
    if (!(exc instanceof LlmUnavailable || exc instanceof SyntaxError || exc instanceof TypeError)) throw exc;
    out.note = (out.note ? out.note + ' ' : '') + 'Gemini als Reranker nicht nutzbar (' + exc.message + ').';
  }
  return out;
}

// ---------- Ergebnis: je Ticket/Seite, Einstufung, Streams ----------

var SNIPPET_CHARS_ = 420;

function ragLevel_(sim, cov, rerank, th, vector, terms) {
  if (vector && sim !== null) {
    if (sim >= th.duplicate) return 'duplicate';
    if (sim >= th.similar) return 'similar';
    if (sim >= th.similar * 0.8 || cov >= 0.5 || (rerank !== null && rerank >= 0.5)) return 'related';
    return null;
  }
  if (terms >= 3 && cov >= 0.8) return 'similar';
  if (cov >= 0.4 || (rerank !== null && rerank >= 0.5)) return 'related';
  return null;
}

/**
 * Abschnitte je Ticket/Seite zusammenfassen. Reihenfolge: mit Reranker genau dessen Rangfolge; ohne zuerst nach
 * Einstufung (Duplikat, ähnlich, verwandt), darin nach der Rangfolge der Suche.
 */
function groupHits_(rows, th, found, reranked) {
  var byDoc = {}, order = [];
  rows.forEach(function (r, pos) {
    var id = r.source + ':' + r.doc_id;
    if (!byDoc[id]) {
      byDoc[id] = { id: r.doc_id, source: r.source, title: r.title, url: r.url, status: r.status || null, stream: r.stream || null,
        epic: r.epic || null, space: r.space || null, updated: r.updated || null, pos: pos, sim: null, cov: 0, rerank: null, rrf: 0,
        by_keyword: false, by_meaning: false, passages: [] };
      order.push(id);
    }
    var d = byDoc[id];
    if (r.vec !== null && r.vec !== undefined) { d.sim = d.sim === null ? r.vec : Math.max(d.sim, r.vec); d.by_meaning = true; }
    if (r.lex !== null && r.lex !== undefined) d.by_keyword = true;
    d.cov = Math.max(d.cov, r.cov || 0);
    if (r.rerank !== null && r.rerank !== undefined) d.rerank = d.rerank === null ? r.rerank : Math.max(d.rerank, r.rerank);
    d.rrf = Math.max(d.rrf, r.rrf);
    var text = String(r.text || '').replace(/\s*\n\s*/g, ' · ').trim();
    d.passages.push({ heading: r.heading || '', text: text.length > SNIPPET_CHARS_ ? text.slice(0, SNIPPET_CHARS_) + '…' : text });
  });
  var hits = [];
  order.forEach(function (id) {
    var d = byDoc[id];
    d.level = ragLevel_(d.sim, d.cov, d.rerank, th, found.vector, found.terms);
    if (!d.level) return;
    d.n_passages = d.passages.length;
    d.passages = d.passages.slice(0, 2);
    // Anzeige: Bedeutung (Kosinus) wenn vorhanden, sonst Anteil der gefundenen Stichwörter.
    d.score = percent(d.sim !== null ? d.sim : d.cov);
    d.sim = d.sim === null ? null : pyRound(d.sim, 4);
    d.cov = pyRound(d.cov, 2);
    d.rerank = d.rerank === null ? null : pyRound(d.rerank, 3);
    delete d.rrf; delete d.pos;
    hits.push(d);
  });
  var weight = { duplicate: 0, similar: 1, related: 2 };
  return sortBy(hits.map(function (h, n) { h.n = n; return h; }), function (h) { return [reranked ? 0 : weight[h.level], h.n]; })
    .slice(0, RAG_DOCS_).map(function (h) { delete h.n; return h; });
}

function topOf_(hits, level) {
  var h = hits.filter(function (x) { return x.level === level; })[0];
  return { id: h.id, title: h.title, url: h.url, source: h.source };
}

function streamName_(id) {
  var known = STREAMS.filter(function (s) { return s.id === id; })[0];
  if (known) return known.name;
  return String(id).replace(/(^|[\s_-])(\p{L})/gu, function (m, a, b) { return (a ? ' ' : '') + b.toUpperCase(); });
}

/** Abstimmung der ähnlichsten Tickets: Welchem Stream / Epic gehören sie? Gewicht = Ähnlichkeit. */
function neighbourVote_(hits, field) {
  var votes = {}, total = 0;
  hits.filter(function (h) { return h.source === 'jira' && h[field]; }).slice(0, 10).forEach(function (h) {
    var w = Math.max(0.05, (h.score || 0) / 100) * (h.level === 'related' ? 0.6 : 1);
    var v = votes[h[field]] = votes[h[field]] || { id: h[field], weight: 0, votes: 0, examples: [] };
    v.weight += w; v.votes += 1; total += w;
    if (v.examples.length < 3) v.examples.push(h.id);
  });
  return sortBy(Object.keys(votes).map(function (k) { return votes[k]; }), function (v) { return [-v.weight, v.id]; }).slice(0, 4)
    .map(function (v) { return { id: v.id, name: field === 'stream' ? streamName_(v.id) : v.id, share: pyRound(100 * v.weight / total), votes: v.votes, examples: v.examples }; });
}

/** Ohne passende Nachbarn: Einschätzung aus den Stream-Beschreibungen (Konfiguration). */
function profileStreams_(c, text) {
  try {
    return c.classifier.classify(text).suggestions.filter(function (x) { return x.confidence >= 0.15; }).slice(0, 3).map(function (x) {
      return { id: x.stream.id, name: x.stream.name, share: pyRound(100 * x.confidence), votes: 0, examples: [], keywords: x.matched_keywords };
    });
  } catch (exc) {
    if (!(exc instanceof LlmUnavailable)) throw exc;
    return [];
  }
}

/** Wie schreiben ähnliche Tickets? Vorbilder mit ihren Abschnitten, häufige Abschnitte, Beispieltext für die KI. */
function writingGuide_(c, hits) {
  var top = hits.filter(function (h) { return h.source === 'jira'; }).slice(0, 3);
  if (!top.length) return { examples: [], sections: [], prompt: '' };
  var texts = {};
  try {
    c.retriever.issueTexts(top.map(function (h) { return h.id; })).forEach(function (d) { texts[d.id] = d; });
  } catch (exc) {
    if (!(exc instanceof SourceUnavailable)) throw exc;
  }
  var count = {}, order = [];
  var examples = top.map(function (h) {
    var body = texts[h.id] ? texts[h.id].body : '';
    var names = distinct_(sections_(body, 'jira').map(function (s) { return s.name; }).filter(String)).slice(0, 8);
    names.forEach(function (n) { if (!count[n]) { count[n] = 0; order.push(n); } count[n] += 1; });
    return { id: h.id, title: h.title, url: h.url, sections: names, chars: body.length };
  });
  var prompt = top.filter(function (h) { return texts[h.id] && texts[h.id].body; }).slice(0, 2).map(function (h) {
    return 'Titel: ' + h.title + '\n' + texts[h.id].body.slice(0, 900);
  }).join('\n---\n');
  return { examples: examples, prompt: prompt,
    sections: sortBy(order.map(function (n) { return { name: n, n: count[n] }; }), function (x) { return -x.n; }).filter(function (x) { return x.n >= 2; }) };
}

/**
 * Der ganze Abgleich. modus: 'pruefen' (gibt es das schon?) oder 'wunsch' (zusätzlich Stream und Ticket-Entwurf).
 */
function ragAnalyse_(c, text, modus, opts) {
  var started = Date.now();
  opts = opts || {};
  text = String(text || '').trim().slice(0, 6000);
  var sources = (opts.sources || []).filter(function (x) { return RAG_SOURCES_.indexOf(x) >= 0; });
  if (!sources.length) sources = RAG_SOURCES_;
  var found = c.retriever.search(text, { sources: sources });
  var rr = rerank_(c, text, found.rows);
  var th = thresholdsFor(found.vector ? found.embedder : 'default');
  var hits = groupHits_(rr.rows, th, found, rr.used !== 'none');
  var n = function (level) { return hits.filter(function (h) { return h.level === level; }).length; };
  var level = n('duplicate') ? 'duplicate' : n('similar') ? 'similar' : 'new';
  var streams = neighbourVote_(hits, 'stream'), basis = 'tickets';
  if (!streams.length) { streams = profileStreams_(c, text); basis = streams.length ? 'profile' : 'none'; }
  var out = {
    query: text, modus: modus, sources: sources,
    search: { lexical: found.lexical, vector: found.vector, reranker: rr.used, note: rr.note, passages: found.rows.length, ms: 0,
      scale: found.vector ? { similar: percent(th.similar), duplicate: percent(th.duplicate) } : null },
    verdict: { level: level, duplicates: n('duplicate'), similar: n('similar'), related: n('related'),
      top: level !== 'new' ? topOf_(hits, level) : null },
    hits: hits, streams: streams, stream_basis: basis, epics: neighbourVote_(hits, 'epic'), draft: null, guide: null,
    points: wishPoints_(c, text, rr.rows, hits)
  };
  if (modus === 'wunsch') {
    var guide = writingGuide_(c, hits);
    var country = SETTINGS.countries.indexOf(opts.country) >= 0 ? opts.country : SETTINGS.countries[0];
    // Der Entwurf beschreibt nur, was es noch nicht (ganz) gibt. Gibt es alles schon, bleibt der ganze Wunsch die Grundlage.
    var fresh = out.points.items.filter(function (it) { return it.status !== 'exists'; });
    var onlyNew = fresh.length > 0 && fresh.length < out.points.items.length;
    var draft = c.ticketWriter.draft(onlyNew ? fresh.map(function (it) { return it.text.replace(/[.!?]*$/, '.'); }).join(' ') : text, country, guide.prompt);
    out.guide = { examples: guide.examples, sections: guide.sections };
    out.draft = { title: draft.title, source: draft.source, notice: draft.notice || '', open_questions: draft.open_questions, country: country,
      scope: { only_new: onlyNew, fresh: fresh.length, known: out.points.items.length - fresh.length },
      markup: toJiraMarkup(draft, streams.length ? streams[0].name : '', out.epics.length ? out.epics[0].id : '') + scopeMarkup_(out.points) };
  }
  out.search.ms = Date.now() - started;
  return out;
}

// ---------- Was ist wirklich neu? Wunsch in Punkte zerlegen und jeden Punkt einzeln prüfen ----------

var POINTS_MAX_ = 6;            // so viele Punkte je Wunsch höchstens
var POINTS_LLM_ROWS_ = 15;      // so viele Abschnitte sieht Gemini beim Prüfen
var POINT_QUOTE_CHARS_ = 220;   // Länge des belegenden Satzes
var POINT_CUT_ = /(?:[.!?;]+(?=\s|$)\s*|\n+|:\s+|,?\s+(?:außerdem|zusätzlich|sowie|ferner|darüber hinaus)\s+)/i;
var POINT_TAIL_ = /^(?:damit|weil|denn|sodass|so dass|um)\b/i;
var POINT_STATUS_ = { vorhanden: 'exists', teilweise: 'partial', neu: 'new' };

var POINTS_PROMPT_ = 'Zerlege den Wunsch in seine einzelnen fachlichen Punkte (höchstens ' + POINTS_MAX_ + '). Jeder Punkt ist ein kurzer Satz ' +
  'in den Worten des Wunsches. Eine Begründung („damit …“) gehört zum Punkt davor und ist kein eigener Punkt.\n' +
  'Prüfe dann für jeden Punkt, ob einer der nummerierten Abschnitte ihn schon beschreibt: "vorhanden" = ein Abschnitt beschreibt genau das, ' +
  '"teilweise" = ein Abschnitt deckt nur einen Teil ab, "neu" = kein Abschnitt passt. Erfinde nichts.\n' +
  'Bei "vorhanden" und "teilweise": Nummer des Abschnitts in "source" und den passenden Satz wörtlich aus dem Abschnitt in "quote" (höchstens 200 Zeichen).\n' +
  'Antworte nur mit JSON: {"points": [{"text": "…", "status": "neu", "source": null, "quote": ""}]}\n' +
  'Wunsch:\n"""{text}"""\nAbschnitte:\n{list}';

function cleanPoint_(s) {
  s = String(s || '').replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim().replace(/[,;:]+$/, '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** Ohne KI: an Satzenden, Zeilen, Doppelpunkten und Wörtern wie „außerdem“ trennen; Begründungen und Bruchstücke anhängen. */
var POINT_ABBR_ = /\b(?:[a-z]\.\s?[a-z]\.|(?:bzw|ca|ggf|inkl|evtl|usw|etc|nr|vgl|max|min|bspw|zzgl)\.)/gi;

function splitPoints_(text) {
  var out = [];
  // Abkürzungen (z. B., bzw., ca.) sind kein Satzende: Punkte vorübergehend ersetzen.
  var masked = String(text || '').replace(POINT_ABBR_, function (m) { return m.replace(/\./g, '\u2024'); });
  masked.split(POINT_CUT_).map(function (s) { return cleanPoint_(s.replace(/\u2024/g, '.')); }).filter(String).forEach(function (part) {
    var short = distinct_(tokens(part)).length < 2;
    if (out.length && (short || POINT_TAIL_.test(part))) out[out.length - 1] += (POINT_TAIL_.test(part) ? ', ' + part.charAt(0).toLowerCase() + part.slice(1) : ' ' + part);
    else out.push(part);
  });
  // Ein zu kurzer erster Teil (z. B. eine Überschrift vor dem Doppelpunkt) bleibt nur stehen, wenn er allein steht.
  if (out.length > 1 && distinct_(tokens(out[0])).length < 2) out.splice(0, 2, out[0] + ': ' + out[1]);
  return out.slice(0, POINTS_MAX_).map(function (p) { return p.length > 300 ? p.slice(0, 299) + '…' : p; });
}

function rowText_(r) { return [r.title, r.heading, r.text].filter(Boolean).join(' · '); }

/** Der Satz eines Abschnitts, der am meisten Wörter des Punkts enthält (Beleg). */
function quoteFor_(point, row) {
  var want = tokenSet(point), best = '', bestN = 0;
  String(row.text || '').split(/(?<=[.!?])\s+|\s*\n\s*/).forEach(function (s) {
    var n = countIntersection(want, tokenSet(s));
    if (n > bestN) { best = s.trim(); bestN = n; }
  });
  if (!best) return '';
  return best.length > POINT_QUOTE_CHARS_ ? best.slice(0, POINT_QUOTE_CHARS_ - 1) + '…' : best;
}

function pointRef_(row, quote) {
  return { id: row.doc_id, source: row.source, title: row.title || row.doc_id, url: row.url || '', heading: row.heading || '', quote: quote || '' };
}

/** Ohne KI: je Punkt der beste Abschnitt nach Bedeutung (Embedder) und Anteil der gefundenen Wörter. */
function matchPointsOffline_(c, points, rows) {
  var pool = rows.slice(0, RAG_RERANK_);
  var vecs = null, th = thresholdsFor('default');
  if (pool.length) {
    try {
      vecs = c.embedder.embed(points.concat(pool.map(rowText_)));
      th = thresholdsFor(c.embedder.name);
    } catch (exc) {
      if (!(exc instanceof LlmUnavailable)) throw exc;
      vecs = null;
    }
  }
  var sets = pool.map(function (r) { return tokenSet(rowText_(r)); });
  return points.map(function (p, i) {
    var want = distinct_(tokens(p)), best = null;
    pool.forEach(function (r, k) {
      var cov = want.length ? want.filter(function (t) { return sets[k][t]; }).length / want.length : 0;
      var sim = vecs ? dot(vecs[i], vecs[points.length + k]) : null;
      var score = (sim === null ? 0 : sim / th.similar) + cov;
      if (!best || score > best.score) best = { row: r, cov: cov, sim: sim, score: score };
    });
    // Streng: lieber „neu“ als ein schwacher Beleg. Bedeutung allein reicht nicht, es müssen auch Wörter des Punkts vorkommen.
    var status = 'new';
    if (best) {
      var sim = best.sim === null ? -1 : best.sim, cov = best.cov, mid = (th.similar + th.duplicate) / 2;
      if ((sim >= th.duplicate && cov >= 0.4) || (sim >= mid && cov >= 0.5) || (want.length >= 3 && cov >= 0.75)) status = 'exists';
      else if ((sim >= mid && cov >= 0.3) || (sim >= th.similar && cov >= 0.5) || cov >= 0.5) status = 'partial';
    }
    return { text: p, status: status, ref: status === 'new' ? null : pointRef_(best.row, quoteFor_(p, best.row)) };
  });
}

/** Mit KI: Gemini zerlegt und prüft in einem Aufruf. Zitate, die nicht wörtlich im Abschnitt stehen, fallen weg. */
function matchPointsLlm_(c, text, rows) {
  var top = rows.slice(0, POINTS_LLM_ROWS_);
  var list = top.map(function (r, n) {
    return '[' + (n + 1) + '] ' + r.title + (r.heading ? ' › ' + r.heading : '') + ': ' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 500);
  }).join('\n');
  var prompt = POINTS_PROMPT_.replace('{text}', redact(text).slice(0, 3000)).replace('{list}', redact(list || '(keine)'));
  var data = JSON.parse(c.llm.generate(prompt, true));
  if (!data || !Array.isArray(data.points)) throw new TypeError('KI-Antwort ohne Punkte');
  var flat = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
  var items = data.points.slice(0, POINTS_MAX_).map(function (p) {
    var pt = cleanPoint_(p && p.text).slice(0, 300);
    if (!pt) return null;
    var status = POINT_STATUS_[String(p.status || '').toLowerCase()] || 'new';
    var row = top[Number(p.source) - 1];
    if (status !== 'new' && !row) status = 'new';
    if (status === 'new') return { text: pt, status: 'new', ref: null };
    var quote = flat(p.quote).slice(0, POINT_QUOTE_CHARS_);
    if (!quote || flat(row.text).indexOf(quote.replace(/…$/, '')) < 0) quote = quoteFor_(pt, row);
    return { text: pt, status: status, ref: pointRef_(row, quote) };
  }).filter(Boolean);
  if (!items.length) throw new TypeError('KI-Antwort ohne Punkte');
  return items;
}

/**
 * Was ist wirklich neu? Liefert {method, items: [{text, status: exists|partial|new, ref, hit}], counts, note}.
 * ref.hit ist die Nummer in hits (für den Sprung zur Quelle) oder -1.
 */
function wishPoints_(c, text, rows, hits) {
  var method = 'offline', note = '', items = null;
  if (c.llm.available && rows.length) {
    try {
      items = matchPointsLlm_(c, text, rows);
      method = 'gemini';
    } catch (exc) {
      if (!(exc instanceof LlmUnavailable || exc instanceof SyntaxError || exc instanceof TypeError)) throw exc;
      note = 'Zerlegen mit KI nicht möglich (' + exc.message + '); die Punkte wurden ohne KI bestimmt.';
    }
  }
  if (!items) items = matchPointsOffline_(c, splitPoints_(text), rows);
  var counts = { exists: 0, partial: 0, 'new': 0 };
  items.forEach(function (it) {
    counts[it.status] += 1;
    if (it.ref) {
      it.ref.hit = -1;
      hits.forEach(function (h, i) { if (it.ref.hit < 0 && h.id === it.ref.id && h.source === it.ref.source) it.ref.hit = i; });
    }
  });
  return { method: method, items: items, counts: counts, note: note };
}

/** Abgrenzung für den Ticket-Entwurf: was es schon gibt, mit Verweis. */
function scopeMarkup_(points) {
  var known = points.items.filter(function (it) { return it.ref; });
  if (!known.length) return '';
  return '\n\nh3. Abgrenzung (gibt es schon)\n' + known.map(function (it) {
    var link = it.ref.url ? '[' + it.ref.id + '|' + it.ref.url + ']' : it.ref.id;
    return '* ' + it.text + ': ' + (it.status === 'exists' ? 'vorhanden in ' : 'teilweise in ') + link + ' (' + it.ref.title + ')';
  }).join('\n');
}

// ---------- Datenanalyse (EDA): Was steckt in den Daten, wie sollte man trennen? ----------

var EDA_PS_ = [10, 25, 50, 75, 90, 99];

function quantiles_(values) {
  var v = values.slice().sort(function (a, b) { return a - b; });
  var out = { max: v.length ? v[v.length - 1] : 0 };
  EDA_PS_.forEach(function (p) { out['p' + p] = v.length ? v[Math.min(v.length - 1, Math.floor(p / 100 * v.length))] : 0; });
  return out;
}

/** Aus APPROX_QUANTILES(x, 100): 101 Werte, Index = Perzentil. */
function quantilesFromArray_(q) {
  var out = { max: q.length ? q[q.length - 1] : 0 };
  EDA_PS_.forEach(function (p) { out['p' + p] = q.length > p ? q[p] : 0; });
  return out;
}

/** Zählwerte über alle Dokumente (im Speicher). In BigQuery rechnet das die Abfrage eda-<tabelle>. */
function edaCounts_(docs) {
  var titles = {}, dup = 0;
  docs.forEach(function (d) { var t = String(d.title || '').trim().toLowerCase(); if (titles[t]) dup += 1; titles[t] = true; });
  return { docs: docs.length, empty: docs.filter(function (d) { return !String(d.body || '').trim(); }).length, dup_titles: dup,
    len: quantiles_(docs.map(function (d) { return String(d.body || '').length; })) };
}

/** Aufbau der Texte aus einer Stichprobe: Überschriften, Abschnitts- und Absatzlängen. */
function edaStructure_(sample, source) {
  var perDoc = [], secLen = [], paraLen = [], withHead = 0;
  sample.forEach(function (d) {
    var secs = sections_(d.body, source);
    var named = secs.filter(function (s) { return s.name; }).length;
    if (named) withHead += 1;
    perDoc.push(named);
    secs.forEach(function (s) {
      if (s.text) secLen.push(s.text.length);
      s.text.split(/\n{2,}|\n/).forEach(function (p) { if (p.trim()) paraLen.push(p.trim().length); });
    });
  });
  return { sample: sample.length, with_headings: sample.length ? pyRound(100 * withHead / sample.length) : 0,
    sections_per_doc: quantiles_(perDoc).p50, section_len: quantiles_(secLen), para_len: quantiles_(paraLen) };
}

/**
 * Empfehlung für CHUNK_CHARS / CHUNK_OVERLAP aus den Messwerten, mit Begründung in Sätzen.
 * Leitgedanke: ein Chunk = ein zusammenhängender Gedanke. Bei Jira ist das meist das ganze Ticket (Ziel: 90 % der
 * Tickets bleiben ganz), bei Confluence ein Abschnitt unter einer Überschrift (Ziel: 75 % der Abschnitte bleiben ganz).
 * Obergrenze 1.600 Zeichen: der Reranker liest je Abschnitt rund 1.000 Token, das Embedding-Modell 2.000.
 * Ändert die Empfehlung an der Zerlegung der Stichprobe nichts, bleibt es bei der aktuellen Einstellung.
 */
function chunkAdvice_(sources, cfg, samples) {
  var want = 0;
  sources.forEach(function (s) {
    if (!s.docs || !s.structure.sample) return;
    want = Math.max(want, s.source === 'jira' ? s.len.p90 : s.structure.section_len.p75);
  });
  var chars = want ? Math.min(1600, Math.max(600, Math.ceil(want / 100) * 100)) : cfg.chars;
  var rec = { chars: chars, overlap: Math.round(chars * 0.12 / 10) * 10 };
  var count = function (conf) {
    var out = {};
    sources.forEach(function (s) {
      out[s.source] = (samples[s.source] || []).map(function (d) { return chunkDoc_({ source: s.source, title: d.title, body: d.body }, conf).length; });
    });
    return out;
  };
  var now = count(cfg), then = count(rec);
  var differs = JSON.stringify(now) !== JSON.stringify(then);
  if (!differs) { rec = cfg; then = now; }
  var lines = [], est = 0;
  sources.forEach(function (s) {
    if (!s.docs) return;
    var counts = then[s.source];
    var per = counts.length ? counts.reduce(function (a, b) { return a + b; }, 0) / counts.length : 1;
    s.est_chunks = Math.round(per * s.docs);
    s.single_chunk = counts.length ? pyRound(100 * counts.filter(function (x) { return x === 1; }).length / counts.length) : 100;
    est += s.est_chunks;
    var label = s.source === 'jira' ? 'Jira-Tickets' : 'Confluence-Seiten';
    lines.push(s.single_chunk + ' % der ' + label + ' passen komplett in einen Chunk, im Mittel ' + per.toFixed(1).replace('.', ',') + ' je ' +
      (s.source === 'jira' ? 'Ticket' : 'Seite') + '.');
    if (s.structure.with_headings >= 30) lines.push(s.structure.with_headings + ' % der ' + label + ' haben Überschriften: getrennt wird an den Überschriften.');
    else lines.push(s.structure.with_headings + ' % der ' + label + ' haben Überschriften: getrennt wird dort vor allem an Absätzen.');
    var emptyShare = pyRound(100 * s.empty / s.docs);
    if (emptyShare >= 5) lines.push(emptyShare + ' % der ' + label + ' haben keinen Text: dort zählt nur der Titel, die Treffer sind schwächer.');
    if (s.dup_titles) lines.push(s.dup_titles + ' ' + label + ' tragen einen Titel, den es schon gibt: Kandidaten für echte Duplikate.');
  });
  return { chars: rec.chars, overlap: rec.overlap, differs: differs, est_chunks: est,
    est_runs: Math.max(1, Math.ceil(est / BQ_EMBED_PER_RUN_)), lines: lines };
}

var EDA_SAMPLE_ = { jira: 300, confluence: 60 };

/** Messwerte je Quelle + Empfehlung. Mit BigQuery über alle Zeilen (Abfragen eda-*), sonst im Speicher. */
function edaReport_(c) {
  var cfg = chunkConfig_(c.settings);
  var sources = [], samples = {}, groups = [], chunkState = [];
  if (c.bq) {
    var bq = c.bq;
    [['jira', 'issues', 'key', 'summary', 'description'], ['confluence', 'pages', 'id', 'title', 'body']].forEach(function (t) {
      var body = 'IFNULL(' + t[4] + ", '')";
      var r = bq.query('-- op: eda-' + t[1] + '\nSELECT COUNT(*) AS docs, COUNTIF(LENGTH(TRIM(' + body + ')) = 0) AS empty, ' +
        'COUNT(*) - COUNT(DISTINCT LOWER(TRIM(IFNULL(' + t[3] + ", '')))) AS dup_titles, APPROX_QUANTILES(LENGTH(" + body + '), 100) AS q FROM ' + bq.t(t[1]))[0] ||
        { docs: 0, empty: 0, dup_titles: 0, q: [] };
      samples[t[0]] = r.docs ? bq.query('-- op: eda-sample-' + t[1] + '\nSELECT ' + t[3] + ' AS title, SUBSTR(' + body + ', 1, @cap) AS body FROM ' + bq.t(t[1]) +
        ' ORDER BY FARM_FINGERPRINT(' + t[2] + ') LIMIT @n', { cap: RAG_PAGE_CHARS_, n: EDA_SAMPLE_[t[0]] }) : [];
      sources.push({ source: t[0], docs: r.docs || 0, empty: r.empty || 0, dup_titles: Math.max(0, r.dup_titles || 0), len: quantilesFromArray_(r.q || []) });
    });
    groups = bq.query("-- op: eda-groups\nSELECT 'stream' AS kind, IFNULL(stream, '(ohne)') AS name, COUNT(*) AS n FROM " + bq.t('issues') + ' GROUP BY 2 ' +
      "UNION ALL SELECT 'status' AS kind, IFNULL(status, '(ohne)') AS name, COUNT(*) AS n FROM " + bq.t('issues') + ' GROUP BY 2 ' +
      "UNION ALL SELECT 'space' AS kind, IFNULL(space, '(ohne)') AS name, COUNT(*) AS n FROM " + bq.t('pages') + ' GROUP BY 2');
    chunkState = bq.query('-- op: eda-chunks\nSELECT source, COUNT(*) AS chunks, COUNT(DISTINCT doc_id) AS docs, ' +
      'COUNTIF(ARRAY_LENGTH(embedding) > 0) AS embedded, APPROX_QUANTILES(LENGTH(text), 4) AS q FROM ' + bq.t('chunks') + ' GROUP BY source')
      .map(function (r) { return { source: r.source, chunks: r.chunks, docs: r.docs, embedded: r.embedded, len_p50: (r.q || [])[2] || 0 }; });
  } else {
    var built = c.retriever.build_();
    RAG_SOURCES_.forEach(function (src) {
      var docs = built.docs.filter(function (d) { return d.source === src; });
      var counts = edaCounts_(docs);
      counts.source = src;
      sources.push(counts);
      samples[src] = docs.slice(0, EDA_SAMPLE_[src] * 4);
      var mine = built.chunks.filter(function (ch) { return ch.doc.source === src; });
      if (mine.length) chunkState.push({ source: src, chunks: mine.length, docs: docs.length, embedded: mine.length,
        len_p50: quantiles_(mine.map(function (ch) { return ch.text.length; })).p50 });
    });
    var tally = function (kind, list, key) {
      var m = {};
      list.forEach(function (d) { var k = d[key] || '(ohne)'; m[k] = (m[k] || 0) + 1; });
      Object.keys(m).forEach(function (k) { groups.push({ kind: kind, name: k, n: m[k] }); });
    };
    tally('stream', built.docs.filter(function (d) { return d.source === 'jira'; }), 'stream');
    tally('status', built.docs.filter(function (d) { return d.source === 'jira'; }), 'status');
    tally('space', built.docs.filter(function (d) { return d.source === 'confluence'; }), 'space');
  }
  sources.forEach(function (s) { s.structure = edaStructure_(samples[s.source] || [], s.source); });
  var advice = chunkAdvice_(sources, cfg, samples);
  var by = function (kind) {
    return sortBy(groups.filter(function (g) { return g.kind === kind; }), function (g) { return [-g.n, g.name]; }).slice(0, 12)
      .map(function (g) { return { name: g.name, n: g.n }; });
  };
  return { mode: c.bq ? 'bigquery' : 'memory', config: cfg, sources: sources, advice: advice, chunks: chunkState,
    groups: { stream: by('stream'), status: by('status'), space: by('space') },
    embeddings: c.settings.embeddings, reranker: c.settings.reranker || 'auto' };
}

function edaText_(r) {
  var lines = ['Datenanalyse (' + (r.mode === 'bigquery' ? 'BigQuery' : 'Speicher') + ')'];
  r.sources.forEach(function (s) {
    lines.push((s.source === 'jira' ? 'Jira' : 'Confluence') + ': ' + s.docs + ' Einträge, ' + s.empty + ' ohne Text, ' + s.dup_titles + ' doppelte Titel. ' +
      'Länge in Zeichen: Median ' + s.len.p50 + ', 90 % bis ' + s.len.p90 + ', längster ' + s.len.max + '. ' +
      'Stichprobe ' + s.structure.sample + ': ' + s.structure.with_headings + ' % mit Überschriften, Abschnitt Median ' + s.structure.section_len.p50 +
      ' / 75 % bis ' + s.structure.section_len.p75 + ' Zeichen.');
  });
  lines.push('Empfehlung: CHUNK_CHARS = ' + r.advice.chars + ', CHUNK_OVERLAP = ' + r.advice.overlap + ' (aktuell ' + r.config.chars + ' / ' + r.config.overlap + '). ' +
    'Erwartet rund ' + r.advice.est_chunks + ' Chunks, etwa ' + r.advice.est_runs + ' Abgleich-Läufe zum Einbetten.');
  return lines.concat(r.advice.lines).join('\n');
}

/** Im Editor ausführen: schreibt die Datenanalyse mit der Chunking-Empfehlung ins Protokoll. */
function datenanalyse() {
  var text = edaText_(edaReport_(buildContainer()));
  Logger.log(text);
  return text;
}

/** Im Editor ausführen: eine Probesuche; zeigt, ob Stichwörter, Vektoren und Reranker arbeiten. */
function sucheTesten() {
  var c = buildContainer();
  var r = ragAnalyse_(c, 'Bestellvorschlag soll Feiertage je Land berücksichtigen', 'pruefen', {});
  var lines = ['Suche: Stichwörter ' + (r.search.lexical ? 'ja' : 'nein') + ', Vektoren ' + (r.search.vector ? 'ja' : 'nein') +
    ', Reranker ' + r.search.reranker + (r.search.note ? ' (' + r.search.note + ')' : '') + ', ' + r.search.passages + ' Abschnitte, ' + r.search.ms + ' ms'];
  r.hits.forEach(function (h) { lines.push(h.level + ' ' + h.score + ' %  ' + h.id + '  ' + h.title); });
  c.notices.forEach(function (x) { lines.push('Hinweis: ' + x); });
  Logger.log(lines.join('\n'));
  return lines;
}
