# Apps-Script-Fassung

Die komplette Web-App (Übersicht, Neue Anforderung, Meine Tickets, Alle Tickets, Systementwicklung, Wissen,
Anleitungen, Releases, Bug-Ursachen, Admin) als **Google Apps Script Web-App**. Oberfläche und Fachlogik
entsprechen 1:1 der Python-Fassung: gleiche Seiten, gleiche Texte, gleiche Berechnungen.

- **KI:** Gemini über Vertex AI mit dem Google-Token der Web-App und der **Projekt-ID** (kein API-Key).
- **Jira, Confluence, ServiceNow:** **nur lesend**, mit PAT als Bearer. Die App legt nichts an und ändert nichts
  (Sperre im Code, siehe „Nur lesen“). Ausgeliefert wird ohne Testdaten; fehlt ein PAT, zeigt die Seite das im Block.
- **Anmeldung:** über das Google-Konto. Niemand braucht ein Passwort für die App.

## Ordner

| Ordner | Inhalt |
|---|---|
| `bundle/` | **Zum Kopieren:** drei Dateien (`Code.gs`, `Index.html`, `appsscript.json`). Wird aus `src/` erzeugt. |
| `src/` | Der Code, aufgeteilt nach Themen (für clasp und zum Weiterentwickeln). |
| `dev/` | Lokale Vorschau und Tests mit Node. Wird nicht nach Apps Script kopiert. |

## Einrichten (ohne Programmierkenntnisse, etwa 15 Minuten)

### 1. Projekt anlegen

1. [script.google.com](https://script.google.com) öffnen → **Neues Projekt**. Oben links einen Namen vergeben.
2. Links auf das Zahnrad **Projekteinstellungen** → Haken bei **„Manifestdatei appsscript.json im Editor anzeigen“**.
3. Zurück zum **Editor** (Symbol `< >`).

### 2. Drei Dateien einfügen

Die Dateien liegen im Repo unter `apps-script/bundle/`. Auf GitHub die Datei öffnen, rechts oben **„Copy raw file“**.

| Im Editor | Inhalt komplett ersetzen durch |
|---|---|
| `appsscript.json` | `bundle/appsscript.json` |
| `Code.gs` | `bundle/Code.gs` |
| Neue Datei: **＋ → HTML**, Name `Index` (ohne .html) | `bundle/Index.html` |

Speichern (Strg+S).

### 3. Einstellungen anlegen

1. Oben in der Funktionsauswahl **`setup`** wählen → **Ausführen**.
2. Google fragt nach Berechtigungen: Konto wählen → **Zulassen**. (Bei „App nicht verifiziert“: *Erweitert* →
   *Weiter zu …*. Das ist bei eigenen Skripten normal.)
3. **Projekteinstellungen → Skripteigenschaften**: Dort stehen jetzt alle Einstellungen mit Platzhaltern.

Mindestens eintragen:

| Eigenschaft | Wert |
|---|---|
| `APP_NAME` | Name oben links. Endet er auf „Align“, wird „Align“ gelb. |
| `VERTEX_PROJECT_ID` | Die Google-Cloud-**Projekt-ID** (mit Bindestrichen, nicht die Projektnummer). |

Alles andere kann vorerst bleiben, wie es ist.

### 4. KI-Verbindung prüfen

Funktion **`testVertex`** wählen → **Ausführen**. Im Ausführungsprotokoll steht dann `Gemini: OK` und eine
Embedding-Länge. Bei Fehlern siehe [Fehlerbilder](#fehlerbilder).

### 5. Als Web-App bereitstellen

1. **Bereitstellen → Neue Bereitstellung** → Zahnrad bei „Typ auswählen“ → **Web-App**.
2. **Ausführen als: Ich** (dann nutzt die KI dein Google-Konto und deine Cloud-Rechte, andere brauchen keine).
3. **Zugriff:** *Jeder in [Organisation]* (oder nur du zum Testen).
4. **Bereitstellen** → die angezeigte Web-App-URL ist der Link zur App.

Nach Änderungen am Code: **Bereitstellen → Bereitstellungen verwalten → Bearbeiten → Version: Neue Version**.
Sonst läuft weiter die alte Fassung.

Direkt auf eine Seite verlinken: `…/exec?seite=/tickets` oder `…/exec?seite=/bugs`.

## Google Cloud: was das Projekt braucht

Wie in der bestehenden Apps-Script-App mit Gemini:

- Im Cloud-Projekt ist die **Vertex AI API** (Agent Platform API) aktiviert.
- Das Konto, das die Web-App bereitstellt, hat die Rollen **„Vertex AI User“** und **„Service Usage Consumer“**.
- Das Apps-Script-Projekt muss **nicht** mit dem Cloud-Projekt verknüpft werden. Die App schickt das Token aus
  `ScriptApp.getOAuthToken()` und nennt das Projekt im Header `x-goog-user-project`.
- Die Berechtigung `cloud-platform` steht in `appsscript.json`. Fehlt sie, lehnt Vertex das Token ab.

Optional: `VERTEX_LOCATION` (Standard `global`, z. B. `europe-west3`), `GEMINI_MODEL` (Standard
`gemini-2.5-flash`), `VERTEX_EMBEDDING_MODEL` (Standard `text-multilingual-embedding-002`).

Ohne `VERTEX_PROJECT_ID` läuft die App ohne KI: Ticketentwurf und Antworten kommen dann aus den Regeln und den
besten Textstellen der Quellen.

## Alle Skripteigenschaften

| Eigenschaft | Bedeutung |
|---|---|
| `APP_NAME` | Name der App oben links |
| `DATA_SOURCE` | `live` (Standard): echte Daten. `mock` gibt es nur in der Entwicklung (`MockData.gs` wird nicht ausgeliefert) |
| `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `GEMINI_MODEL`, `VERTEX_EMBEDDING_MODEL` | KI, siehe oben |
| `EMBEDDINGS` | `auto` (Standard: Vertex, wenn eine Projekt-ID da ist), `vertex` oder `hashing` (offline) |
| `JIRA_URL`, `JIRA_PAT` | Jira Server/Data Center, PAT als Bearer-Token |
| `JIRA_JQL` | Abfrage für die Stream-Tickets, solange keine Board-IDs gesetzt sind |
| `JIRA_BOARD_DISPOSITION`, `…_LOGISTIK`, `…_STAMMDATEN`, `…_REPORTING` | Board-IDs je Stream (alle vier oder keine) |
| `JIRA_BOARD_ADFCR`, `JIRA_ADFCR_JQL` | Country-Report-Board bzw. Abfrage dafür |
| `CONFLUENCE_URL`, `CONFLUENCE_PAT`, `CONFLUENCE_SPACES` | Confluence und die Bereiche (kommagetrennt) |
| `SERVICENOW_URL`, `SERVICENOW_TOKEN` | ServiceNow-Table-API für Incidents und Changes |
| `DOCS_FOLDER_ID` | Optional: Drive-Ordner mit Markdown-Dateien für Anleitungen, Schulungen, Change Log |
| `USER_ROLES` | Optional: Rollen als JSON, z. B. `{"vorname.nachname@firma.de": "INT"}` |
| `CACHE_MINUTES` | Wie lange Listen aus Jira, Confluence und ServiceNow gelten (Standard 30, 1 bis 360). Länger = schneller, aber älterer Stand |
| `LLM_DAILY_LIMIT` | KI-Aufrufe je Person und Tag (Standard 200, `0` = kein Limit). Danach rechnet die App mit Regeln weiter und zeigt einen Hinweis |

Werte, die mit `PLATZHALTER` beginnen, gelten als nicht gesetzt. Streams, Epics, Prioritäten, Lebenszyklus und
Länder stehen oben in `Code.gs` (Abschnitt `Config.gs`, Objekte `SETTINGS` und `STREAMS`). Neuer Stream = neuer
Eintrag in `STREAMS`.

## Echte Daten

1. PATs und URLs in die Skripteigenschaften eintragen. Keine neue Bereitstellung nötig, Eigenschaften gelten sofort.
2. Ist ein System nicht erreichbar oder fehlt ein PAT, zeigt die jeweilige Seite den Grund im Block an. Die übrigen
   Seiten laufen weiter.

## Nur lesen

Diese Fassung schreibt nirgends hin. Abgesichert in mehreren Schichten:

1. **Sperre im Code** (`assertReadOnly_` in `Adapters.gs`): Jeder HTTP-Aufruf der App läuft hindurch. An Jira,
   Confluence, ServiceNow und jede andere Adresse geht nur `GET`. Einzige Ausnahme ist Vertex AI
   (`*aiplatform.googleapis.com`), das Anfragen per `POST` erwartet. Keine Skripteigenschaft kann das lockern.
2. **Kein Code zum Anlegen:** Der frühere Jira-Writer ist entfernt; „Einreichen“ bleibt gesperrt, das Ticket wird
   als Text kopiert und von Hand in Jira eingefügt.
3. **Berechtigungen:** Drive nur lesend (`drive.readonly`), keine Gmail-, Kalender- oder Tabellen-Rechte.
4. **Prüfungen:** Ein Test ruft alle Seiten und Formulare (auch „Einreichen“) gegen nachgebildete Systeme auf und
   zählt jede Methode: nur `GET` an Jira & Co. Der Guard-Check `as-readonly` scheitert, sobald Code mit
   `POST`/`PUT`/`DELETE` an andere Adressen, ein neuer `UrlFetchApp`-Aufruf an der Sperre vorbei oder eine
   zusätzliche Berechtigung auftaucht.

Zusätzlich empfehlenswert: die PATs von einem Konto mit nur Leserechten anlegen. Jira- und Confluence-PATs haben
immer die Rechte des Kontos, für das sie erstellt wurden.

**Wichtig, bitte vorab mit der IT klären:** Apps Script ruft Jira, Confluence und ServiceNow von **Google-Servern**
aus auf, nicht aus dem Firmennetz. Systeme, die nur im Firmennetz erreichbar sind, antworten dann nicht. Mögliche
Wege: die Systeme für Google Apps Script freigeben (IP-Bereiche von Google), ein API-Gateway davor, oder die Cloud-
Varianten der Systeme. Vertex AI ist davon nicht betroffen.

Jira-Daten werden 30 Minuten zwischengespeichert (`CACHE_MINUTES`), Vektoren für die Ähnlichkeitssuche 6 Stunden.

## Was anders ist als in der Python-Fassung

| Thema | Python (Databricks) | Apps Script |
|---|---|---|
| Anmeldung | Header `X-Forwarded-Email` | Google-Konto (`Session.getActiveUser`) |
| KI-Token | Service-Account-JSON | Token der Web-App (`ScriptApp.getOAuthToken`) |
| Einstellungen | Umgebungsvariablen, YAML | Skripteigenschaften, `SETTINGS`/`STREAMS` im Code |
| Sprache, Testperson | Cookies | je Nutzer gespeichert (`UserProperties`) |
| Dokumente | Ordner mit Markdown | Drive-Ordner mit Markdown (`DOCS_FOLDER_ID`) |
| Seitenwechsel | Seite lädt neu | ohne Neuladen, Adresse als `#/pfad` |
| Testdaten | Fixtures | `MockData.gs`, nur in der Entwicklung, nicht ausgeliefert |

## Fehlerbilder

| Meldung | Ursache |
|---|---|
| `testVertex`: HTTP 403 | Rolle fehlt, API nicht aktiv oder Projekt-ID falsch (ID, nicht Nummer) |
| `testVertex`: HTTP 404 | Modell in der Region nicht verfügbar → `GEMINI_MODEL` oder `VERTEX_LOCATION` ändern |
| `testVertex`: HTTP 401 | Berechtigung `cloud-platform` fehlt → `appsscript.json` prüfen, `setup` erneut ausführen |
| Hinweis oben „Vertex Embeddings nicht erreichbar“ | wie 403/404; die App rechnet so lange offline weiter |
| „… ist nicht konfiguriert“ | URL fehlt oder ist noch ein Platzhalter |
| „… antwortete mit HTTP 401“ | PAT falsch oder abgelaufen |
| „… fehlgeschlagen“ | System von Google aus nicht erreichbar (siehe Firmennetz oben) |

## Für Entwickler

```bash
node apps-script/dev/test.js          # Tests (Testdaten, Live-Adapter mit nachgebildeten Antworten, Vertex-Header)
node apps-script/dev/server.js        # Vorschau mit Testdaten: http://127.0.0.1:8790/
node apps-script/dev/bundle.js        # bundle/ nach Änderungen in src/ neu erzeugen
node apps-script/dev/stress.js        # Stresstest: 500 bis 5.000 Tickets, Cache-Grenzen, Fuzzing (--quick: kürzer)
node apps-script/dev/ui-check.js      # Browser-Prüfung: XSS, Kontrast, Schrift, A11y, Layout, Englisch, Laden (--bundle: ausgelieferte Fassung)
node apps-script/dev/budget.js        # Budgets: Seitengröße, größte Antwort, Laufzeit mit Cache (Grenzen in dev/budgets.json)
node apps-script/dev/load.js          # Lastsimulation: 100 bis 1.000 Personen bei 30 gleichzeitigen Ausführungen (--quick: kürzer)
LATENCY=1200 node apps-script/dev/server.js   # Vorschau mit Wartezeit wie in Apps Script, um Skelette und Cache zu sehen
npm run guard                         # kompletter Guard (Python-Prototyp und Apps Script)
```

Für eine interne Auslieferung mit anderem Standardnamen: `node apps-script/dev/bundle.js --out <ordner> --app-name <Name>`.
Im Repo bleibt der neutrale Name.

### Was der Stresstest zeigt

Gemessen mit nachgebildeten Systemen und geschätzter Wartezeit je Aufruf (Jira/Confluence/ServiceNow 400 ms,
Vertex 700 ms). Echte Laufzeiten hängen vom Netz ab und lassen sich nur im Apps-Script-Projekt messen.

| Tickets | Übersicht, erster Aufruf | Ticketentwurf, erster Aufruf (alle Embeddings neu) | jede Seite mit Cache |
|---|---|---|---|
| 500 | etwa 1,5 s | etwa 6 s | etwa 1 s oder weniger |
| 2.000 | etwa 3 s | etwa 13 s | etwa 1 s oder weniger |
| 5.000 | etwa 5 s | etwa 26 s | etwa 1 s oder weniger |

Apps Script rechnet langsamer als Node; die Rechenanteile können dort zwei- bis dreimal so lang dauern.

Die Ticketliste schickt 250 Zeilen auf einmal („Weitere 250 laden“, höchstens 5.000).

Der Script-Cache hält höchstens 1.000 Einträge für alle Nutzer zusammen und je Eintrag 100 KB. Die Listen aus
Jira, Confluence und ServiceNow liegen in Teilen zu höchstens 96 KB, die Vektoren in 128 Fächern. Bei 5.000 Tickets
sind das etwa 560 Einträge. Google kann Einträge trotzdem früher löschen; dann lädt bzw. rechnet die App neu
(langsamer, aber korrekt). Im Cache liegen auch ServiceNow-Melder, nur serverseitig und höchstens 5 Minuten.

### Ladezeiten

Was die App tut, damit Seiten schnell erscheinen:

- **Start:** Index.html schickt die erste Anfrage sofort ab, noch bevor die Skripte gelesen sind. Bis die Antwort
  da ist, steht ein Gerüst in Seitenform. Die Schrift lädt nebenher, bis dahin gilt die Systemschrift.
- **Letzter Stand aus dem Browser:** Übersicht, Ticketlisten, Systementwicklung, Bugs, Dokumentation und Admin
  liegen nach dem ersten Besuch im Browser (höchstens 12 Seiten, nur für die angemeldete Person). Sie erscheinen
  sofort; dann fragt die App mit einer Kennung (etag) nach. Ist nichts neu, kommt nur `{same: true}` zurück,
  sonst die neue Seite, ohne dass Blätterposition, Fokus oder Eingabe verloren gehen.
- **Ladeanzeige nach Dauer:** bis 100 ms nichts, dann der dünne Balken oben, ab 1 s ein Skelett der Zielseite.
- **Vorladen:** Ruht der Zeiger 80 ms auf einem Link, holt die App die Seite schon (höchstens eine Anfrage
  gleichzeitig je Browser).
- **Server:** Listen aus Jira, Confluence und ServiceNow liegen 30 Minuten im Script-Cache (`CACHE_MINUTES`). Große Boards holt die App nach der ersten Seite parallel (je 6 Seiten zu 500 Tickets). Ein neues Ticket erhöht
  die Versionsnummer der Jira-Listen, damit niemand den alten Stand sieht. Lesende Aufrufe an Jira & Co. werden bei
  Netzfehlern und 429/502/503/504 bis zu zweimal wiederholt (wachsende, zufällige Wartezeit); Anlegen nie.
- **Überlast:** Apps Script führt für alle Nutzer zusammen höchstens 30 Aufrufe gleichzeitig aus. Der Browser
  wiederholt eine abgelehnte Seite bis zu zweimal mit Wartezeit.
- **Kleine Seite:** Die ausgelieferte Oberfläche hat keine Kommentare (`dev/minify.js`); ein Test zeigt, dass die
  Vorlagen danach Zeichen für Zeichen dasselbe HTML liefern.

**Messen:** Web-App-Adresse mit `?perf=1` öffnen. Unten rechts erscheint eine Tafel mit der Zeit bis zur ersten
Seite und je Aufruf: Dauer im Browser, Rechenzeit auf dem Server, Größe, Aufrufe an Jira & Co. und Cache-Treffer.
Im Ausführungsprotokoll von Apps Script steht je Aufruf eine Zeile `api GET /tickets 412 ms`.

**Budgets als Ratsche:** `dev/budgets.json` legt Grenzen fest (Seite roh ≤ 240 KB, gzip ≤ 60 KB, größte Antwort
≤ 220 KB, Aufruf mit Cache ≤ 3 s, bei 300 gleichzeitig aktiven Personen p95 ≤ 3 s und höchstens 0,5 % gescheiterte
Aufrufe). Der Guard prüft sie und lässt die Werte nur sinken.

Lastsimulation (Modell: Start 150 ms, Rechnen × 2,5, Jira & Co. 400 ms, Vertex 700 ms, Cache 15 ms je Zugriff,
google.script.run 250 ms; jede Person öffnet alle 30 s eine Seite):

| aktive Personen | p50 | p95 | gescheitert nach Wiederholung | höchste Gleichzeitigkeit |
|---|---|---|---|---|
| 100 | etwa 0,6 s | etwa 1,7 s | 0 % | 9 von 30 |
| 300 | etwa 0,6 s | etwa 1,6 s | 0 % | 16 von 30 |
| 1.000 | etwa 0,6 s | etwa 1,6 s | etwa 0,02 % | 30 von 30 |

Ab etwa 1.000 gleichzeitig aktiven Personen ist das Kontingent voll. Dann hilft eine zweite Bereitstellung unter
einem anderen Konto oder `executeAs: USER_ACCESSING` (jede Person bringt ihr eigenes Kontingent mit, braucht dann aber
selbst die Vertex-Rolle im Google-Cloud-Projekt).

Mit [clasp](https://github.com/google/clasp): `.clasp.json.example` nach `.clasp.json` kopieren, `scriptId`
eintragen, dann im Ordner `apps-script/` `clasp push`. Dabei landen die Dateien aus `src/` einzeln im Projekt.
