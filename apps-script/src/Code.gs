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
  return template.evaluate()
    .setTitle(settings.appName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Bindet eine weitere HTML-Datei (CSS, Skripte) in Index.html ein. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
