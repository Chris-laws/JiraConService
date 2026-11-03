(async function () {
  var space = prompt('Welcher Confluence-Bereich? (Kürzel, z. B. ADF)', '__SPACE__');
  if (!space) return;
  var base = (window.AJS && AJS.contextPath) ? AJS.contextPath() : '';
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#fff;color:#172b4d;border:2px solid #0052cc;border-radius:6px;padding:12px 16px;font:14px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  document.body.appendChild(box);
  var pages = [], start = 0, limit = 50;
  try {
    for (var n = 0; n < 400; n++) {
      box.textContent = 'Lese ' + space + ' … ' + pages.length + ' Seiten';
      var r = await fetch(base + '/rest/api/content?type=page&spaceKey=' + encodeURIComponent(space) + '&start=' + start + '&limit=' + limit +
        '&expand=body.storage,version', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('Confluence antwortete mit HTTP ' + r.status);
      var d = await r.json();
      d.results.forEach(function (p) {
        pages.push({ id: String(p.id), title: p.title, space: space, body: (p.body && p.body.storage && p.body.storage.value) || '',
          url: location.origin + base + ((p._links && p._links.webui) || ''), updated: (p.version && p.version.when) || '' });
      });
      if (d.results.length < limit) break;
      start += limit;
    }
    var day = new Date().toISOString().slice(0, 10);
    var file = 'confluence-' + space + '-' + day + '.json';
    var blob = new Blob([JSON.stringify({ format: 'confluence-pages', space: space, exported: new Date().toISOString(), pages: pages })], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    document.body.appendChild(a);
    a.click();
    box.textContent = 'Fertig: ' + pages.length + ' Seiten in ' + file + '. Datei in den Drive-Ordner legen.';
  } catch (e) {
    box.textContent = 'Hat nicht geklappt: ' + e.message;
  }
  setTimeout(function () { box.remove(); }, 15000);
})();
