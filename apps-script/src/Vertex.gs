/**
 * Gemini über Vertex AI mit OAuth-Token und Quota-Projekt, ohne API-Key.
 *
 * Bewährter Weg (wie in der Schwester-App mit Apps Script): Bearer-Token aus ScriptApp.getOAuthToken() mit Scope cloud-platform
 * plus Header x-goog-user-project = Projekt-ID. Die Projekt-ID steht in der Script Property VERTEX_PROJECT_ID
 * (die ID mit Bindestrichen, nicht die Projektnummer).
 */

function vertexModelUrl(project, location, model, method) {
  var host = location === 'global' ? 'aiplatform.googleapis.com' : location + '-aiplatform.googleapis.com';
  return 'https://' + host + '/v1/projects/' + project + '/locations/' + location + '/publishers/google/models/' + model + ':' + method;
}

function vertexHeaders(project) {
  var token;
  try {
    token = ScriptApp.getOAuthToken();
  } catch (e) {
    throw new LlmUnavailable('Kein Google-Token. Bitte die Web-App einmal neu autorisieren.');
  }
  return { Authorization: 'Bearer ' + token, 'x-goog-user-project': project, Accept: 'application/json' };
}

function generateBody(prompt, jsonMode) {
  var config = { temperature: 0.2 };
  if (jsonMode) config.responseMimeType = 'application/json';
  return { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: config };
}

function parseGeminiText(data) {
  try {
    return data.candidates[0].content.parts[0].text;
  } catch (e) {
    throw new LlmUnavailable('Gemini-Antwort ohne Text');
  }
}

function VertexLlm(project, location, model, dailyLimit) {
  this.available = true;
  this.project = project;
  this.location = location;
  this.model = model;
  this.dailyLimit = dailyLimit === undefined ? 200 : dailyLimit;
}
VertexLlm.prototype.generate = function (prompt, jsonMode) {
  llmBudget_(this.dailyLimit);
  var data = requestJson('POST', vertexModelUrl(this.project, this.location, this.model, 'generateContent'), {
    headers: vertexHeaders(this.project), json: generateBody(prompt, !!jsonMode), error: LlmUnavailable
  });
  return parseGeminiText(data);
};

/**
 * Tageslimit je Person (Script Property LLM_DAILY_LIMIT, Standard 200, 0 = aus). Alle Nutzer teilen sich die
 * Kontingente des Projekts; damit eine Person sie nicht allein aufbraucht, zählt der Script-Cache die Aufrufe je
 * Tag und Person (ein Eintrag; der Schlüssel enthält das Datum, jeder Aufruf hält ihn 6 h, die Cache-Höchstdauer).
 * Ist das Limit erreicht, rechnen die Services mit ihrer Regel-Logik weiter und zeigen einen Hinweis.
 */
function llmBudget_(limit) {
  if (!limit) return;
  var who = '';
  try { who = String(Session.getActiveUser().getEmail() || ''); } catch (e) { who = ''; }
  if (!who) { try { who = Session.getTemporaryActiveUserKey(); } catch (e) { who = 'anon'; } }
  var day = Utilities.formatDate(new Date(), 'Etc/UTC', "yyyy-MM-dd'T'HH:mm:ss").slice(0, 10);
  var hash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, who)).slice(0, 16);
  var key = 'llmday:' + day + ':' + hash;
  var cache = CacheService.getScriptCache();
  var used = parseInt(cache.get(key) || '0', 10) || 0;
  if (used >= limit) throw new LlmUnavailable('Tageslimit für KI-Aufrufe erreicht (' + limit + ' je Person). Ab morgen wieder mit KI.');
  cache.put(key, String(used + 1), 21600);
}

/** Ohne Projekt-ID: keine KI, die Services nutzen ihre regelbasierte Offline-Logik. */
function OfflineLlm() { this.available = false; }
OfflineLlm.prototype.generate = function () { throw new LlmUnavailable('Keine KI konfiguriert (VERTEX_PROJECT_ID fehlt)'); };

/**
 * Embeddings über Vertex AI (multilingual, passend für deutsche Tickets). Damit nicht jede Seite alle Tickets neu
 * einbettet, liegen die Vektoren 6 Stunden im Script-Cache. Der Cache hält höchstens 1.000 Einträge für alle
 * Nutzer zusammen; deshalb steckt nicht jeder Vektor in einem eigenen Eintrag, sondern alle in 128 Fächern
 * (je Fach ein Eintrag), kompakt als 8-Bit-Werte. 5.000 Texte brauchen so etwa 40 KB je Fach.
 */
var EMB_SHARDS_ = 128;
var EMB_SHARD_MAX_ = 98000; // Zeichen je Fach (Base64, also Bytes), unter der Grenze von 100 KB je Cache-Eintrag
var EMB_SECONDS_ = 21600;

function VertexEmbedder(project, location, model) {
  this.name = 'vertex';
  this.project = project;
  this.location = location;
  this.model = model;
  this.batch = 50;
  this.parallel = 6;
}

/** Vektor als 8-Bit-Werte (Base64). Beim Lesen wird wieder normiert, die Skalierung fällt dabei heraus. */
function packVector_(vec) {
  var max = 0;
  for (var i = 0; i < vec.length; i++) max = Math.max(max, Math.abs(vec[i]));
  var bytes = vec.map(function (v) { return max ? Math.round(v / max * 127) : 0; });
  return Utilities.base64Encode(bytes);
}
function unpackVector_(text) {
  return l2_(Utilities.base64Decode(text).map(function (b) { return b; }));
}

VertexEmbedder.prototype.embed = function (texts) {
  var cache = CacheService.getScriptCache();
  var self = this;
  var prefix = 'embs:' + this.model.replace(/[^\w.-]/g, '') + ':';
  var ids = texts.map(function (t) {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, self.model + '\n' + (t || ' '), Utilities.Charset.UTF_8);
    return { shard: prefix + (((digest[0] % EMB_SHARDS_) + EMB_SHARDS_) % EMB_SHARDS_), hash: Utilities.base64EncodeWebSafe(digest.slice(1, 13)) };
  });
  var shardKeys = ids.map(function (x) { return x.shard; }).filter(function (k, i, all) { return all.indexOf(k) === i; });
  var shards = {};
  var raw = cache.getAll(shardKeys);
  shardKeys.forEach(function (k) {
    try { shards[k] = raw[k] ? JSON.parse(raw[k]) : {}; } catch (e) { shards[k] = {}; }
  });

  var vectors = new Array(texts.length);
  var missing = [];
  ids.forEach(function (id, i) {
    var packed = shards[id.shard][id.hash];
    if (packed) vectors[i] = unpackVector_(packed);
    else missing.push(i);
  });
  if (!missing.length) return vectors;

  var touched = {};
  var url = vertexModelUrl(this.project, this.location, this.model, 'predict');
  var chunks = [];
  for (var start = 0; start < missing.length; start += this.batch) chunks.push(missing.slice(start, start + this.batch));
  var request = function (chunk) {
    assertReadOnly_('POST', url);
    return { url: url, method: 'post', headers: vertexHeaders(self.project), contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ instances: chunk.map(function (i) { return { content: texts[i] || ' ' }; }) }) };
  };
  var send = function (group) {
    try {
      return group.length === 1 ? [UrlFetchApp.fetch(url, request(group[0]))] : UrlFetchApp.fetchAll(group.map(request));
    } catch (exc) {
      throw new LlmUnavailable('POST ' + url + ' fehlgeschlagen: ' + safeFetchMessage_(exc));
    }
  };
  try {
    // Mehrere Pakete gleichzeitig (UrlFetchApp.fetchAll): 2.000 neue Texte dauern so Sekunden statt einer Minute.
    for (var g = 0; g < chunks.length; g += this.parallel) {
      var group = chunks.slice(g, g + this.parallel);
      var responses = send(group);
      // Zu viele Anfragen (429): kurz warten und die betroffenen Pakete einmal wiederholen.
      var limited = group.filter(function (chunk, n) { return responses[n].getResponseCode() === 429; });
      if (limited.length) {
        Utilities.sleep(1500);
        var again = send(limited);
        limited.forEach(function (chunk, n) { responses[group.indexOf(chunk)] = again[n]; });
      }
      // Erst alle Antworten der Gruppe verarbeiten, dann einen Fehler melden: fertige Vektoren gehen nicht verloren.
      var failure = null;
      group.forEach(function (chunk, n) {
        var code = responses[n].getResponseCode();
        var data = null;
        if (code < 200 || code >= 300) failure = failure || 'antwortete mit HTTP ' + code;
        else {
          try { data = JSON.parse(responses[n].getContentText()); } catch (e) { failure = failure || 'lieferte kein JSON'; }
        }
        if (!data) return;
        if (!Array.isArray(data.predictions) || data.predictions.length !== chunk.length) {
          failure = failure || 'lieferte eine unerwartete Embedding-Antwort';
          return;
        }
        chunk.forEach(function (i, k) {
          var packed = packVector_(l2_(data.predictions[k].embeddings.values.slice()));
          vectors[i] = unpackVector_(packed); // gleiche Genauigkeit wie aus dem Cache
          shards[ids[i].shard][ids[i].hash] = packed;
          touched[ids[i].shard] = true;
        });
      });
      if (failure) throw new LlmUnavailable('POST ' + url + ' ' + failure);
    }
  } finally {
    // Auch bei einem Fehler mittendrin: was schon berechnet ist, bleibt im Cache.
    var out = {};
    Object.keys(touched).forEach(function (k) {
      var map = shards[k], names = Object.keys(map), text = JSON.stringify(map);
      while (text.length > EMB_SHARD_MAX_ && names.length) { delete map[names.shift()]; text = JSON.stringify(map); }
      out[k] = text;
    });
    try { if (Object.keys(out).length) cache.putAll(out, EMB_SECONDS_); } catch (e) { /* Cache voll: egal */ }
  }
  return vectors;
};

/** Zum Testen im Editor: prüft Token, Projekt und Modell mit einer kurzen Anfrage. */
function testVertex() {
  var s = loadSettings();
  if (!s.vertexProjectId) throw new Error('VERTEX_PROJECT_ID ist nicht gesetzt (Script Properties).');
  var llm = new VertexLlm(s.vertexProjectId, s.vertexLocation, s.geminiModel);
  Logger.log('Gemini: ' + llm.generate('Antworte nur mit: OK'));
  var emb = new VertexEmbedder(s.vertexProjectId, s.vertexLocation, s.vertexEmbeddingModel);
  Logger.log('Embedding-Länge: ' + emb.embed(['Verbindungstest'])[0].length);
}
