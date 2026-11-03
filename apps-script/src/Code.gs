/**
 * Einstieg der Web-App (Bereitstellen → Neue Bereitstellung → Web-App).
 *
 * Die Oberfläche ist eine einzige HTML-Seite (Index.html). Seitenwechsel und Formulare laufen ohne Neuladen
 * über google.script.run → apiRequest() in Api.gs.
 */

function doGet(e) {
  var settings;
  try {
    settings = loadSettings();
  } catch (exc) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">Konfiguration fehlerhaft: ' +
      String(exc.message).replace(/[<&>]/g, '') + '</p>').setTitle('Konfiguration');
  }
  var template = HtmlService.createTemplateFromFile('Index');
  template.appName = settings.appName;
  template.startPath = (e && e.parameter && e.parameter.seite) ? String(e.parameter.seite) : '';
  template.perf = !!(e && e.parameter && e.parameter.perf === '1');
  template.viewer = viewerKey_();
  return template.evaluate()
    .setTitle(settings.appName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Kurze, nicht rückrechenbare Kennung der angemeldeten Person. Der Browser hält den Seiten-Cache nur für diese
 * Kennung; meldet sich im selben Browser jemand anderes an, wird der Cache verworfen. Leer = kein Seiten-Cache.
 */
function viewerKey_() {
  var who = '';
  try { who = String(Session.getActiveUser().getEmail() || ''); } catch (e) { who = ''; }
  if (!who) { try { who = String(Session.getTemporaryActiveUserKey() || ''); } catch (e) { who = ''; } }
  if (!who) return '';
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'viewer:' + who)).slice(0, 16);
}

/** Bindet eine weitere HTML-Datei (CSS, Skripte) in Index.html ein. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
