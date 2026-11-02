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

function VertexLlm(project, location, model) {
  this.available = true;
  this.project = project;
  this.location = location;
  this.model = model;
}
VertexLlm.prototype.generate = function (prompt, jsonMode) {
  var data = requestJson('POST', vertexModelUrl(this.project, this.location, this.model, 'generateContent'), {
    headers: vertexHeaders(this.project), json: generateBody(prompt, !!jsonMode), error: LlmUnavailable
  });
  return parseGeminiText(data);
};

/** Ohne Projekt-ID: keine KI, die Services nutzen ihre regelbasierte Offline-Logik. */
function OfflineLlm() { this.available = false; }
OfflineLlm.prototype.generate = function () { throw new LlmUnavailable('Keine KI konfiguriert (VERTEX_PROJECT_ID fehlt)'); };

/**
 * Embeddings über Vertex AI (multilingual, passend für deutsche Tickets). Vektoren werden je Text 6 Stunden
 * im Script-Cache gehalten, damit nicht jede Seite alle Tickets neu einbettet.
 */
function VertexEmbedder(project, location, model) {
  this.name = 'vertex';
  this.project = project;
  this.location = location;
  this.model = model;
  this.batch = 50;
  this.parallel = 6;
}
VertexEmbedder.prototype.embed = function (texts) {
  var cache = CacheService.getScriptCache();
  var self = this;
  var keys = texts.map(function (t) {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, self.model + '\n' + (t || ' '), Utilities.Charset.UTF_8);
    return 'emb:' + Utilities.base64EncodeWebSafe(digest);
  });
  var cached = {};
  for (var c = 0; c < keys.length; c += 100) {
    var part = cache.getAll(keys.slice(c, c + 100));
    Object.keys(part).forEach(function (k) { cached[k] = part[k]; });
  }
  var vectors = new Array(texts.length);
  var missing = [];
  keys.forEach(function (k, i) {
    if (cached[k]) vectors[i] = JSON.parse(cached[k]);
    else missing.push(i);
  });
  var url = vertexModelUrl(this.project, this.location, this.model, 'predict');
  var chunks = [];
  for (var start = 0; start < missing.length; start += this.batch) chunks.push(missing.slice(start, start + this.batch));
  // Mehrere Pakete gleichzeitig (UrlFetchApp.fetchAll): 2.000 neue Texte dauern so Sekunden statt einer Minute.
  for (var g = 0; g < chunks.length; g += this.parallel) {
    var group = chunks.slice(g, g + this.parallel);
    var requests = group.map(function (chunk) {
      return { url: url, method: 'post', headers: vertexHeaders(self.project), contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ instances: chunk.map(function (i) { return { content: texts[i] || ' ' }; }) }) };
    });
    var responses;
    try {
      responses = group.length === 1 ? [UrlFetchApp.fetch(url, requests[0])] : UrlFetchApp.fetchAll(requests);
    } catch (exc) {
      throw new LlmUnavailable('POST ' + url + ' fehlgeschlagen: ' + safeFetchMessage_(exc));
    }
    var toCache = {};
    group.forEach(function (chunk, n) {
      var code = responses[n].getResponseCode();
      if (code < 200 || code >= 300) throw new LlmUnavailable('POST ' + url + ' antwortete mit HTTP ' + code);
      var data;
      try { data = JSON.parse(responses[n].getContentText()); } catch (e) { throw new LlmUnavailable('POST ' + url + ' lieferte kein JSON'); }
      if (!data || !Array.isArray(data.predictions) || data.predictions.length !== chunk.length) {
        throw new LlmUnavailable('Vertex-Embedding-Antwort unerwartet');
      }
      chunk.forEach(function (i, k) {
        var values = data.predictions[k].embeddings.values.map(function (v) { return Math.round(v * 1e6) / 1e6; });
        vectors[i] = l2_(values);
        toCache[keys[i]] = JSON.stringify(vectors[i]);
      });
    });
    try { cache.putAll(toCache, 21600); } catch (e) { /* Cache voll: egal */ }
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
