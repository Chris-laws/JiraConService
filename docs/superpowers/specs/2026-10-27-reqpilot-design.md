# ReqPilot – Design-Spec (Prototyp)

Stand: 2026-10-27 · Status: abgestimmt mit Chris im Projekt-Thread

## 1. Ziel und Kontext

Länder und Teams im ADF-Umfeld schreiben Anforderungs-Tickets uneinheitlich. Das erschwert das
Anforderungsmanagement (siehe interne Präsentation zum Anforderungsmanagement): unterschiedliches Wording, Multi-Stream-Tickets,
Duplikate, fehlende Epic-Zuordnung. Zusätzlich ist bei ServiceNow-Bugs unklar, welcher Patch sie verursacht hat.

ReqPilot ist ein **Prototyp** für Business-User (zuerst INT und Dispomanagement, später die Länder). Er wird
nach dem PoC an einen IT-Dienstleister übergeben. Deshalb: einfache deutsche Oberfläche, sauberer Python-Code,
austauschbare Adapter, keine Betriebs- oder SSO-Eigenbauten.

### Erfolgskriterien

- Ein Business-User erzeugt aus Freitext ein Ticket im Standardformat, ohne das Format zu kennen.
- Multi-Stream-Anforderungen werden erkannt und zur Aufteilung vorgeschlagen.
- Ähnliche/doppelte Tickets und Confluence-Seiten werden vor dem Anlegen mit Link angezeigt.
- Streams sind reine Konfiguration: Stream 5 bis 18 hinzufügen heißt eine YAML-Datei ändern, keinen Code.
- Zu einem ServiceNow-Bug nennt das Tool die wahrscheinlich verursachenden Changes/Patches mit Konfidenz und Begründung.
- Alles läuft lokal mit Mock-Daten, ohne Firmennetz, ohne Databricks, ohne Gemini-Key.

### Nicht-Ziele (Prototyp)

- Kein Schreiben nach Jira. Ein Schreib-Adapter existiert, ist aber per Schalter aus (`REQPILOT_JIRA_WRITE_ENABLED=false`) und in der UI nicht erreichbar.
- Keine eigene Benutzerverwaltung; Anmeldung über Databricks Apps (Workspace-SSO).
- Kein Sprint-Performance-Dashboard, kein Scoring-Modell für Priorisierung (später).

## 2. Plattform und Architektur

- **Laufzeit:** Databricks Apps (Python ≥ 3.11), Oberfläche **Streamlit**. Lokal: `streamlit run app.py`.
- **LLM:** Google Gemini über REST. Key als Databricks-Secret bzw. lokal in `.env` (`GEMINI_API_KEY`).
  Ohne Key läuft ein deterministischer Offline-Ersatz (`FakeLlm`), damit Demo und Tests funktionieren.
- **Datenquellen:** Jira, Confluence, ServiceNow nur im Firmennetz. Bis PATs vorliegen: Fixtures in `fixtures/`.

```
Streamlit-UI (src/reqpilot/ui)        ← nur Darstellung, Texte aus i18n
        │
Services (src/reqpilot/services)      ← fachliche Logik, kennt nur Protokolle
        │
Adapter-Protokolle (adapters/base.py)  ← JiraReader, JiraWriter, ConfluenceReader,
        │                                 ServiceNowReader, ChangeSource, Llm, Embedder
   ┌────┴─────────────┐
 Mock (Fixtures)   Live (REST: Jira, Confluence, ServiceNow, Gemini)
```

`container.py` baut anhand der Einstellungen (`REQPILOT_DATA_SOURCE=mock|live`, `REQPILOT_LLM=fake|gemini`)
die passenden Adapter zusammen. Die UI bekommt nur den fertigen Container.

### Konfiguration

- `config/streams.yaml`: Liste der Streams (id, Name, Beschreibung, Schlüsselwörter, Jira-Board, Epics,
  `enabled`). Pilot: 4 ADF-Streams mit Platzhalter-Namen, bis Chris die echten Namen liefert. Weitere Streams
  werden mit `enabled: false` vorbereitet bzw. ergänzt.
- `config/settings.yaml`: Prioritätsschema (Blocker, High, Medium, Low), Status-Lebenszyklus aus dem PDF,
  Schwellwerte für Ähnlichkeit/Konfidenz je Embedder.
- Umgebungsvariablen überschreiben Einstellungen (12-Factor), Secrets nie im Repo.

## 3. Funktionen

### 3.1 Ticketersteller

1. Eingabe: Freitext, Land, optional Titelidee.
2. `TicketWriter` lässt das LLM ein strukturiertes JSON erzeugen: Titel, User Story (Rolle, Ziel, Nutzen),
   Akzeptanzkriterien, fachlicher Hintergrund, Priorität (nur Werte aus dem Schema), offene Fragen.
   Fehlende Angaben werden als offene Fragen zurückgegeben, nicht erfunden. Ungültige LLM-Antworten werden
   validiert und notfalls durch einen sicheren Rohentwurf ersetzt.
3. Ergebnis wird als Jira-Wiki-Markup exportiert (Kopieren/Download).

### 3.2 Stream-/Epic-Vorschlag und Multi-Stream-Erkennung

- `StreamClassifier` vergleicht den Entwurf per Embedding mit einem Profil je aktivem Stream
  (Beschreibung + Schlüsselwörter + Epic-Titel) und liefert die Top-3 mit Konfidenz (Softmax über Ähnlichkeiten)
  und Begründung (gemeinsame Schlüsselwörter).
- Epic-Vorschlag: ähnlichstes Epic innerhalb des Top-Streams.
- Multi-Stream: liegt der zweitbeste Stream nah am besten (Verhältnis ≥ Schwellwert) und über einer
  Mindestähnlichkeit, gilt das Ticket als Multi-Stream → Erstell-Stopp mit Vorschlag: ein Ticket je Stream.

### 3.3 Duplikat- und Ähnlichkeitsprüfung

- `KnowledgeIndex` indiziert Jira-Issues und Confluence-Seiten (In-Memory-Vektorindex, später Adapter für
  Databricks Vector Search).
- `DuplicateChecker` sucht die ähnlichsten Dokumente; Einstufung „wahrscheinliches Duplikat“ / „ähnlich“ nach
  Schwellwerten. Bei Duplikat Empfehlung: bestehendes Ticket referenzieren (PDF: Duplikat → REJECTED + Verweis).

### 3.4 Meine Tickets (read-only)

- Nutzeridentität: auf Databricks aus dem Header `X-Forwarded-Email`, lokal per Auswahl aus den Mock-Nutzern.
- Liste der eigenen Tickets (Reporter) mit Status, Phase im Lebenszyklus, Stream, letzter Änderung, Link.
  Aktualisieren-Knopf, Cache mit kurzer Lebensdauer. Nur Lesezugriff.

### 3.5 Wissensabfrage (RAG)

- Frage → Top-k-Treffer aus demselben Index → LLM-Antwort ausschließlich auf Basis der Quellen, mit Quellenangabe.
  `FakeLlm` antwortet extraktiv mit den besten Passagen.

### 3.6 Bug-Ursachenanalyse (ServiceNow)

- Eingabe: ServiceNow-Bug (Komponente, erstes Auftreten, Beschreibung).
- Kandidaten: Changes/Patches (Releases mit Autor, Datum, betroffenen Komponenten, Beschreibung) im Zeitfenster
  vor dem ersten Auftreten.
- Score je Kandidat aus drei nachvollziehbaren Signalen: Komponenten-Überlappung, zeitliche Nähe (exponentieller
  Abfall), Textähnlichkeit Bug ↔ Change. Normiert zu Konfidenz; liegt der beste Score unter einer Schwelle, sagt
  das Tool ehrlich „keine klare Ursache“.
- Ausgabe: wahrscheinlichster Patch, beteiligte Person(en), Konfidenz, Begründung je Signal, verwandte Jira-Tickets.
- Hinweis in der UI: Ergebnis ist eine Hypothese zur Ursachenforschung, keine Schuldzuweisung.

## 4. Datenschutz

- Vor jedem LLM-Aufruf werden E-Mail-Adressen und Telefonnummern maskiert (`privacy.redact`).
- Aufrufer-/Melderdaten aus ServiceNow gehen nicht an das LLM.

## 5. Fehlerbehandlung

- Adapter werfen eigene Fehlertypen (`SourceUnavailable`, `WriteDisabled`); die UI zeigt verständliche Meldungen.
- Timeouts für alle HTTP-Aufrufe; LLM-Ausfall → Fallback auf `FakeLlm`-Ergebnis mit Hinweis.
- Kaputte LLM-Antworten (kein JSON, falsche Felder) werden abgefangen und validiert.

## 6. Qualität: Guard

`npm run guard` (ruft `python -m dev.guard`) führt eine Registry von Checks aus (`dev/checks/__init__.py`):
tests+coverage, mutation (leichtgewichtig, Scoring-Logik), lint (ruff), security (bandit), secrets, xss
(`unsafe_allow_html` nur mit statischem CSS), i18n (DE/EN-Schlüssel vollständig, keine hart codierten UI-Texte),
contrast (WCAG AA hell und dunkel), a11y (Pflicht-Labels, `help`-Texte), consistency (Stream-Config + Fixtures),
permissions (jede Seite in der Seiten-Registry mit Rolle), load (Kurzprofil gegen Mocks), budget (Kaltstart),
license (nur erlaubte Lizenzen). Warnungen nur mit Ratsche (`dev/guard_baseline.json`).

Nicht automatisierbar und daher dokumentiert: echte Laufzeiten gegen Live-Systeme, Optik und Verständlichkeit,
Screenreader-Durchgang, SSO/Freigaben auf Databricks, Qualität echter Gemini-Antworten.

## 7. Offene Punkte

- Echte Namen und Beschreibungen der 4 ADF-Pilotstreams und ihrer Epics.
- Erreicht die Databricks-App das interne Jira/Confluence/ServiceNow? Ist Egress zur Gemini-API erlaubt?
- Wo liegen Patch-/Release-Daten (Jira-Fix-Versions, Git, ServiceNow-Changes)? Bis dahin Fixture `changes.json`.
