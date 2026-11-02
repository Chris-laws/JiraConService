// Lädt den Apps-Script-Code (src/*.gs) in Node, mit Nachbildungen der Google-Dienste.
// Nur für lokale Tests und Vorschau; in Apps Script selbst wird diese Datei nicht gebraucht.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');

function memoryProperties(initial) {
  const store = Object.assign({}, initial || {});
  return {
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); return this; },
    getProperties: () => Object.assign({}, store),
    deleteProperty: (k) => { delete store[k]; },
  };
}

function memoryCache() {
  const store = new Map();
  return {
    get: (k) => (store.has(k) ? store.get(k) : null),
    getAll: (keys) => { const out = {}; keys.forEach((k) => { if (store.has(k)) out[k] = store.get(k); }); return out; },
    put: (k, v) => { store.set(k, v); },
    putAll: (obj) => { Object.keys(obj).forEach((k) => store.set(k, obj[k])); },
  };
}

/**
 * Erzeugt eine frische Laufzeit. options.scriptProperties: Script Properties; options.email: angemeldete Person;
 * options.fetch(url, req) → {code, text}: Nachbildung von UrlFetchApp.fetch.
 */
function createRuntime(options) {
  options = options || {};
  const scriptProps = memoryProperties(options.scriptProperties || {});
  const userProps = memoryProperties({});
  const cache = memoryCache();
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), warn: () => {} },
    Logger: { log: (m) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => scriptProps, getUserProperties: () => userProps },
    CacheService: { getScriptCache: () => cache },
    Session: {
      getActiveUser: () => ({ getEmail: () => options.email || '' }),
      getScriptTimeZone: () => 'Europe/Berlin',
    },
    ScriptApp: { getOAuthToken: () => options.oauthToken || 'test-token' },
    UrlFetchApp: {
      fetch: (url, req) => {
        if (!options.fetch) throw new Error('Kein Netz in der lokalen Laufzeit: ' + url.split('?')[0]);
        const r = options.fetch(url, req);
        return { getResponseCode: () => r.code, getContentText: () => r.text };
      },
    },
    Utilities: {
      formatDate: (date, tz, fmt) => {
        if (fmt !== "yyyy-MM-dd'T'HH:mm:ss") throw new Error('Format nicht nachgebildet: ' + fmt);
        if (options.now) return options.now;
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
        const g = (t) => parts.find((p) => p.type === t).value;
        return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
      },
      computeDigest: (alg, text) => Array.from(crypto.createHash('sha256').update(text, 'utf8').digest()),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => (b + 256) % 256)).toString('base64url'),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
    },
    HtmlService: {},
    DriveApp: { getFolderById: () => { throw new Error('Drive ist lokal nicht verfügbar'); } },
  };
  vm.createContext(sandbox);
  const files = options.codeFiles || fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().map((f) => path.join(SRC, f));
  for (const f of files) vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: path.basename(f) });
  sandbox.__logs = logs;
  sandbox.__userProps = userProps;
  return sandbox;
}

/** Index.html mit ihren Scriptlets zusammensetzen (<?!= include('X') ?>, <?= name ?>, <?!= ausdruck ?>). */
function renderIndex(vars, template) {
  const read = (name) => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const scope = Object.assign({ include: read, JSON }, vars);
  const evalExpr = (expr) => Function(...Object.keys(scope), 'return (' + expr + ');')(...Object.values(scope));
  return (template || read('Index')).replace(/<\?(!?)=\s*([\s\S]*?)\s*\?>/g, (m, raw, expr) => (raw ? String(evalExpr(expr)) : esc(evalExpr(expr))));
}

module.exports = { createRuntime, renderIndex, SRC };
