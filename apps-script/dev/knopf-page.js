// Baut die Seite mit dem Confluence-Knopf (Lesezeichen), z. B.:
//   node apps-script/dev/knopf-page.js --space ADF --out Confluence-Knopf.html
'use strict';
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function knopfCode(space) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'knopf.js'), 'utf8');
  return src.replace('__SPACE__', String(space).replace(/[^A-Za-z0-9_~-]/g, ''));
}

function page(space) {
  const code = knopfCode(space);
  const href = 'javascript:' + encodeURIComponent(code.replace(/\n\s*/g, ' '));
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confluence-Knopf</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#172b4d;background:#fff}
h1{font-size:24px}h2{font-size:18px;margin-top:28px}
.knopf{display:inline-block;padding:10px 16px;border-radius:6px;background:#0052cc;color:#fff;font-weight:600;text-decoration:none}
textarea{width:100%;height:160px;font:12px/1.4 monospace}
.hint{background:#f4f5f7;border-left:4px solid #0052cc;padding:8px 12px}
</style></head><body>
<h1>Confluence für die App holen, ohne Admin-Rechte</h1>
<p>Der Knopf liest einen Confluence-Bereich mit <strong>deiner</strong> Anmeldung im Browser und speichert ihn als Datei.
Er liest nur, er ändert in Confluence nichts. Die Datei legst du in den Drive-Ordner (<code>CONFLUENCE_EXPORT_FOLDER_ID</code>).</p>

<h2>Weg A: Lesezeichen</h2>
<ol>
<li>Lesezeichenleiste einblenden (Strg+Umschalt+B).</li>
<li>Diesen Knopf mit der Maus in die Lesezeichenleiste ziehen: <a class="knopf" href="${esc(href)}">Confluence holen</a></li>
<li>In Confluence eine beliebige Seite öffnen (angemeldet), dann auf das Lesezeichen klicken.</li>
<li>Bereich bestätigen (vorbelegt: <strong>${esc(space)}</strong>). Oben rechts zählt ein Kasten die Seiten; am Ende lädt der Browser die Datei <code>confluence-${esc(space)}-Datum.json</code> herunter.</li>
<li>Datei in den Drive-Ordner ziehen. Ältere Dateien dort darfst du löschen (die neueste gilt).</li>
</ol>

<h2>Weg B: falls das Lesezeichen nichts tut</h2>
<p class="hint">Manche Confluence-Seiten sperren Lesezeichen-Knöpfe. Dann so:</p>
<ol>
<li>In Confluence eine Seite öffnen, <strong>F12</strong> drücken, oben den Reiter <strong>Konsole</strong> wählen.</li>
<li>Den Text unten komplett kopieren, in die Konsole einfügen, Enter. (Fragt der Browser, ob Einfügen erlaubt ist: <code>allow pasting</code> tippen, Enter, dann nochmal einfügen.)</li>
</ol>
<textarea readonly>${esc(code)}</textarea>

<h2>Wie oft?</h2>
<p>Wann immer sich in Confluence Wichtiges geändert hat, z. B. einmal pro Woche. Die App übernimmt die neue Datei beim nächsten Abgleich (mit BigQuery: innerhalb von 15 Minuten; ohne: nach Ablauf des Caches).</p>
</body></html>
`;
}

if (require.main === module) {
  const out = arg('out', 'Confluence-Knopf.html');
  fs.writeFileSync(out, page(arg('space', 'ADF')));
  console.log('geschrieben: ' + out);
}
module.exports = { knopfCode, page };
