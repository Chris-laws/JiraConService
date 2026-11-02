// Oberflächen-Prüfung im echten Browser (Playwright/Chromium):  node apps-script/dev/ui-check.js
//
// Alle Seiten, hell und dunkel, bei 1440, 1024 und 390 px Breite:
//   xss       Testdaten und Eingaben enthalten HTML/Skript; nichts davon darf ausgeführt oder als Element erscheinen
//   js        keine Skriptfehler im Browser
//   text      keine Schrift unter 11 px
//   contrast  Text mindestens 4,5:1 (große Schrift 3:1)
//   surface   keine Verläufe auf Flächen (außer Diagrammen), kein Milchglas
//   a11y      genau eine h1, jedes Eingabefeld mit Label, jedes Bedienelement mit Namen, Bilder mit alt
//   layout    kein waagerechtes Scrollen der Seite
//   i18n      Englisch rendert ohne Fehler
// Ausnahmen stehen mit Begründung in ALLOW. Ergebnis als Text; Exit-Code 1 bei Befunden.
'use strict';

const http = require('http');
const { createRuntime, renderIndex } = require('./runtime');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('Playwright fehlt: npm i -D playwright (oder vorinstalliertes Chromium nutzen)');
  process.exit(2);
}

const EVIL = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>"\'><svg onload="window.__xss=1">';
const PAGES = ['/', '/ticket', '/tickets', '/meine-tickets', '/admin', '/wissen', '/bugs', '/bugs/INC0041871', '/streams',
  '/dokumente', '/releases', '/tickets?q=' + encodeURIComponent(EVIL), '/wissen?frage=' + encodeURIComponent(EVIL), '/gibt-es-nicht'];
const WIDTHS = [1440, 1024, 390];

// Ausnahmen, je mit Grund. Schlüssel: Regel + CSS-Selektor des Elements.
const ALLOW = {
  'contrast span.brand-y': 'Wortmarke: „Align“ in der Markenfarbe Gelb, Logo statt Fließtext',
  'contrast .tl span': 'Lebenszyklus: Beschriftung steht unter dem Punkt, die Messung nimmt fälschlich die Punktfarbe als Grund',
  'contrast .gp b': 'Häkchen/Kreuz als Statuszeichen neben dem Text, kein eigener Text',
  'text a.ai-cta': 'Handy: Knopf zeigt nur das Symbol (Schrift 0), Name über aria-label',
  'text a.board-new': 'Handy: Knopf zeigt nur das Symbol (Schrift 0), Name über aria-label',
  'surface div.board-donut': 'Kreisdiagramm (conic-gradient) ist Daten, keine Fläche',
  'surface div.ring': 'Konfidenz-Ring (conic-gradient) ist Daten, keine Fläche',
  'surface div.ring > span': 'Innenfläche des Konfidenz-Rings',
};

function startServer() {
  const rt = createRuntime({ scriptProperties: { DATA_SOURCE: 'mock' } });
  // Bösartige Inhalte in alle Quellen, die die Oberfläche zeigt
  const d = rt.MOCK_DATA;
  d.issues.slice(0, 12).forEach((i) => { i.summary = 'Titel ' + EVIL; i.description = 'Text ' + EVIL; });
  d.pages.slice(0, 3).forEach((p) => { p.title = 'Seite ' + EVIL; p.body = 'Bestellvorschlag ' + EVIL; });
  d.bugs.forEach((b) => { b.short_description = 'Bug ' + EVIL; b.description = 'Bestellvorschlag ' + EVIL; });
  d.changes.slice(0, 5).forEach((c) => { c.title = 'Change ' + EVIL; c.author = 'Felix ' + EVIL; });
  d.documents.slice(0, 2).forEach((doc) => { doc.title = 'Doku ' + EVIL; doc.body = 'Inhalt ' + EVIL; });
  const shim = `<script>var google = { script: { run: (function () {
    function r(ok, fail) { return new Proxy({}, { get: function (_, n) {
      if (n === 'withSuccessHandler') return function (f) { return r(f, fail); };
      if (n === 'withFailureHandler') return function (f) { return r(ok, f); };
      return function () { var a = Array.prototype.slice.call(arguments);
        fetch('/api', { method: 'POST', body: JSON.stringify(a) }).then(function (x) { return x.json(); })
          .then(function (d) { if (d.error) { if (fail) fail(new Error(d.error)); } else if (ok) ok(d.result); }); }; } }); }
    return r(null, null); })() } };</script>`;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let out; try { out = { result: rt.apiRequest.apply(null, JSON.parse(body)) }; } catch (e) { out = { error: e.message }; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
      });
      return;
    }
    const html = renderIndex({ appName: rt.loadSettings().appName, startPath: '' }).replace('<body>', '<body>\n' + shim);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function audit() {
  const res = [];
  const sel = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + cls;
  };
  const key = (el) => {
    const parent = el.parentElement;
    return [sel(el), parent ? sel(parent) + ' > ' + sel(el) : '', el.closest('.tl') ? '.tl span' : '', el.closest('.gp') ? '.gp b' : ''].filter(Boolean);
  };
  const vis = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const parse = (c) => { const m = c.match(/[\d.]+/g); if (!m) return null; return { rgb: m.slice(0, 3).map(Number), a: m[3] === undefined ? 1 : +m[3] }; };
  const lum = (rgb) => { const v = rgb.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage !== 'none' && !/url\(/.test(s.backgroundImage)) return null; // Verlauf/Bild: nicht messbar
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a > 0.95) break; }
    }
    let rgb = [255, 255, 255];
    if (!layers.length || layers[layers.length - 1].a <= 0.95) rgb = document.documentElement.dataset.theme === 'dark' ? [11, 12, 16] : [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) rgb = rgb.map((v, k) => layers[i].rgb[k] * layers[i].a + v * (1 - layers[i].a));
    return rgb;
  };
  // Text
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode; const text = t.textContent.trim(); if (!text) continue;
    const el = t.parentElement; if (!el || seen.has(el) || !vis(el) || el.closest('svg,script,style,[aria-hidden="true"],.sr-only')) continue;
    seen.add(el);
    const s = getComputedStyle(el); const fs = parseFloat(s.fontSize);
    if (fs < 11) res.push(['text', key(el), fs + 'px „' + text.slice(0, 24) + '“']);
    const fg = parse(s.color); const bg = bgOf(el);
    if (fg && bg && fg.a > 0.5) {
      const L1 = lum(fg.rgb), L2 = lum(bg); const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = fs >= 24 || (fs >= 18.66 && +s.fontWeight >= 700);
      if (cr < (large ? 3 : 4.5)) res.push(['contrast', key(el), cr.toFixed(2) + ':1 „' + text.slice(0, 24) + '“']);
    }
  }
  document.querySelectorAll('body *').forEach((el) => {
    if (!vis(el) || el.closest('svg')) return; const s = getComputedStyle(el);
    if (/gradient/.test(s.backgroundImage)) res.push(['surface', key(el), 'Verlauf']);
    if (/blur/.test(s.backdropFilter || '') && !el.closest('dialog')) res.push(['surface', key(el), 'Milchglas']);
  });
  document.querySelectorAll('button, a[href], input, select, textarea').forEach((el) => {
    if (!vis(el) || el.type === 'hidden') return;
    const lab = el.id && document.querySelector('label[for="' + el.id + '"]');
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.value || '').trim();
    if (/INPUT|SELECT|TEXTAREA/.test(el.tagName) && !/submit|button/.test(el.type) && !lab && !el.closest('label') && !el.getAttribute('aria-label')) res.push(['a11y', key(el), 'Eingabefeld ohne Label']);
    else if (!name && !lab) res.push(['a11y', key(el), 'Bedienelement ohne Namen']);
  });
  const h1 = [...document.querySelectorAll('h1')].filter(vis).length; if (h1 !== 1) res.push(['a11y', ['h1'], h1 + ' sichtbare h1']);
  document.querySelectorAll('img:not([alt])').forEach((el) => res.push(['a11y', key(el), 'Bild ohne alt']));
  if (document.documentElement.scrollWidth > innerWidth + 1) res.push(['layout', ['html'], 'Seite scrollt waagerecht (' + document.documentElement.scrollWidth + ' > ' + innerWidth + ')']);
  // XSS: eingeschleuste Elemente
  if (window.__xss) res.push(['xss', ['window'], 'eingeschleustes Skript wurde ausgeführt']);
  document.querySelectorAll('img[src="x"], svg[onload], [onerror]').forEach((el) => res.push(['xss', key(el), 'eingeschleustes Element im DOM']));
  return res;
}

(async () => {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const found = new Map();
  const note = (rule, keys, where, msg) => {
    if (keys.some((k) => ALLOW[rule + ' ' + k])) return;
    const id = rule + ' ' + keys[0] + ' ' + msg.replace(/[\d.]+(:1|px)/, '#');
    if (!found.has(id)) found.set(id, { rule, sel: keys[0], msg, where: [] });
    found.get(id).where.push(where);
  };
  const runs = [];
  for (const theme of ['light', 'dark']) for (const w of WIDTHS) runs.push({ theme, w, lang: 'de' });
  runs.push({ theme: 'light', w: 1440, lang: 'en' });
  let pagesChecked = 0;
  for (const { theme, w, lang } of runs) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch (e) { /* egal */ } }, theme);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => note('js', ['window'], `${theme} ${w}`, e.message));
    page.on('dialog', (d) => { note('xss', ['dialog'], `${theme} ${w}`, 'Dialog geöffnet: ' + d.message()); d.dismiss(); });
    await page.goto(base, { waitUntil: 'networkidle' });
    if (lang === 'en') {
      await page.evaluate(() => google.script.run.withSuccessHandler(() => {}).apiRequest('POST', '/sprache', { lang: 'en' }));
      await page.waitForTimeout(300);
    }
    for (const path of PAGES) {
      await page.goto(base + '#' + path, { waitUntil: 'networkidle' });
      await page.waitForSelector('main.sheet', { timeout: 8000 }).catch(() => note('js', ['main'], `${theme} ${w} ${path}`, 'Seite wurde nicht gezeichnet'));
      await page.waitForTimeout(250);
      for (const [rule, keys, msg] of await page.evaluate(audit)) note(rule, keys, `${path} ${theme} ${w}${lang === 'en' ? ' en' : ''}`, msg);
      pagesChecked++;
    }
    // Eingaben: Ticketentwurf und Wissensfrage mit bösartigem Text abschicken
    for (const [path, field] of [['/ticket', 'textarea'], ['/wissen', 'textarea, input[name="frage"]']]) {
      await page.goto(base + '#' + path, { waitUntil: 'networkidle' });
      const box = page.locator(field).first();
      if (await box.count()) {
        await box.fill('Bestellvorschlag Feiertage ' + EVIL);
        await box.press(field.startsWith('textarea') ? 'Control+Enter' : 'Enter').catch(() => {});
        await page.locator('form:has(' + field.split(',')[0] + ') [type=submit]').first().click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(700);
        for (const [rule, keys, msg] of (await page.evaluate(audit)).filter((r) => r[0] === 'xss')) note(rule, keys, `${path} Eingabe`, msg);
      }
    }
    await ctx.close();
  }
  await browser.close();
  server.close();
  const list = [...found.values()];
  console.log(`${pagesChecked} Seitenansichten geprüft (${PAGES.length} Seiten, hell/dunkel, ${WIDTHS.join('/')} px, Englisch)`);
  if (!list.length) { console.log('Keine Befunde'); return; }
  for (const f of list) console.log(`${f.rule.padEnd(8)} ${f.sel} ${f.msg}  [${f.where.slice(0, 3).join(', ')}${f.where.length > 3 ? ' …' : ''}]`);
  process.exitCode = 1;
})();
