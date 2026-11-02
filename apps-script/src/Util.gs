/**
 * Gemeinsame Bausteine: Fehlertypen, Zeitstempel, Textzerlegung, Offline-Embedder, Datenschutz.
 */

// ---------- Fehlertypen (die Oberfläche übersetzt sie in verständliche Meldungen) ----------

function makeError_(name) {
  var E = function (message) { this.name = name; this.message = message; };
  E.prototype = Object.create(Error.prototype);
  E.prototype.constructor = E;
  return E;
}
/** Eine Datenquelle (Jira, Confluence, ServiceNow) ist nicht erreichbar oder antwortet unbrauchbar. */
var SourceUnavailable = makeError_('SourceUnavailable');
/** Schreiben nach Jira ist im Prototyp abgeschaltet. */
var WriteDisabled = makeError_('WriteDisabled');
/** Kein LLM verfügbar oder Aufruf fehlgeschlagen; Services nutzen dann ihre Offline-Logik. */
var LlmUnavailable = makeError_('LlmUnavailable');
/** Ein Ticket darf genau einem Stream gehören. */
var OneStreamOnly = makeError_('OneStreamOnly');

// ---------- Zeit ----------
// Alle Zeiten sind "Wanduhr"-Zeiten ohne Zeitzone (wie in Jira angezeigt). Intern als UTC-Date gespeichert,
// damit Rechnen und Anzeigen unabhängig von der Zeitzone des Servers gleich bleiben.

function parseTime(value) {
  if (!value) return null;
  var s = String(value).replace(' ', 'T').slice(0, 19);
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
}

function isoTime(date) {
  return date ? date.toISOString().slice(0, 19) : null;
}

/** Jetzt als Wanduhr-Zeit in der Zeitzone des Skripts. */
function nowLocal() {
  var tz = (typeof Session !== 'undefined' && Session.getScriptTimeZone) ? Session.getScriptTimeZone() : 'Europe/Berlin';
  return parseTime(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss"));
}

function daysBetween(later, earlier) { return (later.getTime() - earlier.getTime()) / 86400000; }

function dateOnlyDays(later, earlier) {
  var a = Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate());
  var b = Date.UTC(earlier.getUTCFullYear(), earlier.getUTCMonth(), earlier.getUTCDate());
  return Math.round((a - b) / 86400000);
}

// ---------- Zahlen ----------

/** Rundet wie Python round(): bei genau .5 zur geraden Zahl. */
function pyRound(value, digits) {
  var f = Math.pow(10, digits || 0);
  var x = value * f;
  var r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;
  return r / f;
}

function percent(value) { return pyRound(Math.max(0, Math.min(1, value)) * 100); }

// ---------- Reguläre Ausdrücke mit Umlauten ----------
// JavaScript kennt \b nur für ASCII. wordRegex() ersetzt \b durch eine Wortgrenze, die auch ä, ö, ü, ß kennt.

var WB_ = '(?:(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_]))';
function wordRegex(source, flags) {
  return new RegExp(source.replace(/\\b/g, WB_), (flags || '') + 'u');
}

// ---------- Textzerlegung ----------

var STOP_ = ['der', 'die', 'das', 'und', 'oder', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen', 'ist', 'sind',
  'wird', 'werden', 'soll', 'sollen', 'muss', 'müssen', 'im', 'in', 'am', 'an', 'auf', 'aus', 'bei', 'mit', 'nach',
  'von', 'vor', 'zu', 'zum', 'zur', 'für', 'fur', 'ich', 'wir', 'sie', 'es', 'nicht', 'auch', 'als', 'wie', 'dass',
  'damit', 'um', 'den', 'dem', 'des', 'bitte', 'noch', 'nur', 'so', 'sehr', 'kann', 'können', 'mehr', 'dann', 'wenn',
  'aber'];
var SUFFIXES_ = ['ungen', 'ung', 'en', 'er', 'es', 'e', 'n', 's'];

function normalizeText(text) {
  text = String(text).toLowerCase().replace(/ß/g, 'ss');
  text = text.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
  return text.normalize('NFKD').replace(/[^\x00-\x7f]/g, '');
}

var STOP_SET_ = null;
function stopSet_() {
  if (!STOP_SET_) {
    STOP_SET_ = {};
    STOP_.forEach(function (w) { STOP_SET_[normalizeText(w)] = true; });
  }
  return STOP_SET_;
}

function stem_(word) {
  for (var i = 0; i < SUFFIXES_.length; i++) {
    var s = SUFFIXES_[i];
    if (word.length > s.length + 4 && word.slice(-s.length) === s) return word.slice(0, -s.length);
  }
  return word;
}

/** Wortstämme eines Textes ohne Füllwörter (für Offline-Embedder, Schlüsselwort-Abgleich, Antwortauswahl). */
function tokens(text) {
  var stop = stopSet_();
  var words = normalizeText(text).match(/[a-z0-9]+/g) || [];
  return words.filter(function (w) { return !stop[w] && w.length > 1; }).map(stem_);
}

function tokenSet(text) {
  var set = {};
  tokens(text).forEach(function (t) { set[t] = true; });
  return set;
}

function intersects(a, b) {
  for (var k in a) if (b[k]) return true;
  return false;
}

function countIntersection(a, b) {
  var n = 0;
  for (var k in a) if (b[k]) n++;
  return n;
}

// ---------- Offline-Embedder ----------

var CRC_TABLE_ = null;
function crc32(str) {
  if (!CRC_TABLE_) {
    CRC_TABLE_ = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE_[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < str.length; i++) crc = CRC_TABLE_[(crc ^ str.charCodeAt(i)) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function l2_(vec) {
  var sum = 0;
  for (var i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  var norm = Math.sqrt(sum) || 1;
  for (var j = 0; j < vec.length; j++) vec[j] = vec[j] / norm;
  return vec;
}

function dot(a, b) {
  var s = 0;
  for (var i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Wortstämme plus Zeichen-4-Gramme (fängt Komposita wie Bestellvorschlag/Bestellvorschläge). Ohne Netz. */
function HashingEmbedder(dim, ngram, ngramWeight) {
  this.name = 'hashing';
  this.dim = dim || 2048;
  this.ngram = ngram || 4;
  this.ngramWeight = ngramWeight === undefined ? 0.35 : ngramWeight;
}
HashingEmbedder.prototype.embed = function (texts) {
  var self = this;
  return texts.map(function (text) {
    var vec = new Array(self.dim);
    for (var i = 0; i < self.dim; i++) vec[i] = 0;
    tokens(text).forEach(function (tok) {
      var feats = [['w:' + tok, 1.0]];
      var padded = '_' + tok + '_';
      for (var j = 0; j < Math.max(padded.length - self.ngram + 1, 0); j++) {
        feats.push(['g:' + padded.slice(j, j + self.ngram), self.ngramWeight]);
      }
      feats.forEach(function (f) {
        var h = crc32(f[0]);
        var sign = (h >>> 31) & 1 ? 1.0 : -1.0;
        vec[h % self.dim] += sign * f[1];
      });
    });
    return l2_(vec);
  });
};

// ---------- Datenschutz ----------

var EMAIL_RX_ = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
var PHONE_RX_ = /(?<![\w.])\+?\d[\d \t\/()-]{5,}\d(?![\w.])/g;

/** Maskiert E-Mail-Adressen und Telefonnummern, bevor Text an ein LLM geht. */
function redact(text) {
  return String(text).replace(EMAIL_RX_, '[E-Mail]').replace(PHONE_RX_, function (m) {
    var digits = (m.match(/\d/g) || []).length;
    return digits >= 7 ? '[Telefon]' : m;
  });
}

// ---------- Sonstiges ----------

function compareKeys_(ka, kb) {
  if (Array.isArray(ka)) {
    for (var i = 0; i < ka.length; i++) {
      var c = compareKeys_(ka[i], kb[i]);
      if (c) return c;
    }
    return 0;
  }
  if (ka instanceof Date) { ka = ka.getTime(); kb = kb.getTime(); }
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Stabile Sortierung wie Python sorted(key=..., reverse=...); Schlüssel dürfen Listen sein (Tupel). */
function sortBy(list, keyFn, reverse) {
  var copy = list.slice();
  copy.sort(function (a, b) {
    var c = compareKeys_(keyFn(a), keyFn(b));
    return reverse ? -c : c;
  });
  return copy;
}

function upper(s) { return String(s || '').toUpperCase(); }
