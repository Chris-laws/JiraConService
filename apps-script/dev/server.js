// Lokale Vorschau der Apps-Script-Web-App mit Testdaten:  node apps-script/dev/server.js [port]
// Bildet google.script.run nach (POST /api) und rechnet mit demselben Code wie in Apps Script.
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { createRuntime, renderIndex } = require('./runtime');

// BUNDLE=1: die gebündelte Fassung aus bundle/ ausliefern (so wie sie per Copy-Paste in Apps Script landet).
const BUNDLE = process.env.BUNDLE === '1';
const BUNDLE_DIR = path.join(__dirname, '..', 'bundle');

const port = Number(process.argv[2] || process.env.PORT || 8790);
const runtime = createRuntime({
  scriptProperties: { DATA_SOURCE: 'mock' },
  now: process.env.FAKE_NOW,
  codeFiles: BUNDLE ? [path.join(BUNDLE_DIR, 'Code.gs')] : undefined,
});

const SHIM = `<script>
// Nachbildung von google.script.run für die lokale Vorschau
var google = { script: { run: (function () {
  function runner(ok, fail) {
    return new Proxy({}, { get: function (_, name) {
      if (name === 'withSuccessHandler') return function (fn) { return runner(fn, fail); };
      if (name === 'withFailureHandler') return function (fn) { return runner(ok, fn); };
      return function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
          .then(function (r) { return r.json(); })
          .then(function (d) { if (d.error) { if (fail) fail(new Error(d.error)); } else if (ok) ok(d.result); })
          .catch(function (err) { if (fail) fail(err); });
      };
    } });
  }
  return runner(null, null);
})() } };
</script>`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const name = req.url.slice(5);
      let out;
      try {
        if (name !== 'apiRequest') throw new Error('Unbekannte Funktion ' + name);
        out = { result: runtime.apiRequest.apply(null, JSON.parse(body)) };
      } catch (err) {
        out = { error: err.message };
      }
      // LATENCY=ms bildet die Laufzeit von google.script.run nach (in Apps Script etwa 300 bis 1500 ms je Aufruf).
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      }, Number(process.env.LATENCY || 0));
    });
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    const settings = runtime.loadSettings();
    const vars = { appName: settings.appName, startPath: '', perf: /[?&]perf=1(&|$)/.test(req.url), viewer: 'dev' };
    const html = (BUNDLE ? renderIndex(vars, fs.readFileSync(path.join(BUNDLE_DIR, 'Index.html'), 'utf8')) : renderIndex(vars)).replace('<body>', '<body>\n' + SHIM);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end('nicht gefunden');
}).listen(port, '127.0.0.1', () => console.log('Vorschau: http://127.0.0.1:' + port + '/'));
