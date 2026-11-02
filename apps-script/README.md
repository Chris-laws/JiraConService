# Apps-Script-Fassung

Die komplette Web-App (Übersicht, Neue Anforderung, Meine Tickets, Alle Tickets, Systementwicklung, Wissen,
Anleitungen, Releases, Bug-Ursachen, Admin) als **Google Apps Script Web-App**. Oberfläche und Fachlogik
entsprechen 1:1 der Python-Fassung: gleiche Seiten, gleiche Texte, gleiche Berechnungen.

- **KI:** Gemini über Vertex AI mit dem Google-Token der Web-App und der **Projekt-ID** (kein API-Key).
- **Jira, Confluence, ServiceNow:** PATs sind Platzhalter. Solange sie fehlen, läuft alles mit Testdaten.
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
| `DATA_SOURCE` | `mock` = Testdaten (Standard), `live` = Jira/Confluence/ServiceNow über REST |
| `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `GEMINI_MODEL`, `VERTEX_EMBEDDING_MODEL` | KI, siehe oben |
| `EMBEDDINGS` | `auto` (Standard: Vertex, wenn eine Projekt-ID da ist), `vertex` oder `hashing` (offline) |
| `JIRA_URL`, `JIRA_PAT` | Jira Server/Data Center, PAT als Bearer-Token |
| `JIRA_JQL` | Abfrage für die Stream-Tickets, solange keine Board-IDs gesetzt sind |
| `JIRA_BOARD_DISPOSITION`, `…_LOGISTIK`, `…_STAMMDATEN`, `…_REPORTING` | Board-IDs je Stream (alle vier oder keine) |
| `JIRA_BOARD_ADFCR`, `JIRA_ADFCR_JQL` | Country-Report-Board bzw. Abfrage dafür |
| `JIRA_WRITE_ENABLED` | `false` (Standard). Erst auf `true`, wenn Tickets wirklich angelegt werden sollen |
| `CONFLUENCE_URL`, `CONFLUENCE_PAT`, `CONFLUENCE_SPACES` | Confluence und die Bereiche (kommagetrennt) |
| `SERVICENOW_URL`, `SERVICENOW_TOKEN` | ServiceNow-Table-API für Incidents und Changes |
| `DOCS_FOLDER_ID` | Optional: Drive-Ordner mit Markdown-Dateien für Anleitungen, Schulungen, Change Log |
| `USER_ROLES` | Optional: Rollen als JSON, z. B. `{"vorname.nachname@firma.de": "INT"}` |

Werte, die mit `PLATZHALTER` beginnen, gelten als nicht gesetzt. Streams, Epics, Prioritäten, Lebenszyklus und
Länder stehen oben in `Code.gs` (Abschnitt `Config.gs`, Objekte `SETTINGS` und `STREAMS`). Neuer Stream = neuer
Eintrag in `STREAMS`.

## Auf echte Daten umschalten

1. PATs und URLs in die Skripteigenschaften eintragen.
2. `DATA_SOURCE` auf `live` setzen. Keine neue Bereitstellung nötig, Eigenschaften gelten sofort.
3. Ist ein System nicht erreichbar, zeigt die jeweilige Seite den Grund im Block an. Die übrigen Seiten laufen weiter.

**Wichtig, bitte vorab mit der IT klären:** Apps Script ruft Jira, Confluence und ServiceNow von **Google-Servern**
aus auf, nicht aus dem Firmennetz. Systeme, die nur im Firmennetz erreichbar sind, antworten dann nicht. Mögliche
Wege: die Systeme für Google Apps Script freigeben (IP-Bereiche von Google), ein API-Gateway davor, oder die Cloud-
Varianten der Systeme. Vertex AI ist davon nicht betroffen.

Jira-Daten werden 5 Minuten zwischengespeichert, Vektoren für die Ähnlichkeitssuche 6 Stunden.

## Was anders ist als in der Python-Fassung

| Thema | Python (Databricks) | Apps Script |
|---|---|---|
| Anmeldung | Header `X-Forwarded-Email` | Google-Konto (`Session.getActiveUser`) |
| KI-Token | Service-Account-JSON | Token der Web-App (`ScriptApp.getOAuthToken`) |
| Einstellungen | Umgebungsvariablen, YAML | Skripteigenschaften, `SETTINGS`/`STREAMS` im Code |
| Sprache, Testperson | Cookies | je Nutzer gespeichert (`UserProperties`) |
| Dokumente | Ordner mit Markdown | Drive-Ordner mit Markdown (`DOCS_FOLDER_ID`) |
| Seitenwechsel | Seite lädt neu | ohne Neuladen, Adresse als `#/pfad` |
| Testdaten | Fixtures | `MockData.gs` |

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
node apps-script/dev/ui-check.js      # Browser-Prüfung: XSS, Kontrast, Schrift, A11y, Layout, Englisch (braucht Playwright)
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

Mit [clasp](https://github.com/google/clasp): `.clasp.json.example` nach `.clasp.json` kopieren, `scriptId`
eintragen, dann im Ordner `apps-script/` `clasp push`. Dabei landen die Dateien aus `src/` einzeln im Projekt.
