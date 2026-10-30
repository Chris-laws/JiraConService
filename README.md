# ReqPilot

Prototyp für das Anforderungsmanagement im ADF-Umfeld: einheitliche Anforderungs-Tickets, Duplikat- und
Ähnlichkeitsprüfung gegen Jira und Confluence, Stream-/Epic-Vorschlag, eigene Tickets verfolgen und
Ursachenanalyse für ServiceNow-Bugs.

Läuft als **Streamlit-App auf Databricks Apps**. Lokal und ohne Firmennetz funktioniert alles mit Testdaten.

- Design: [docs/superpowers/specs/2026-10-27-reqpilot-design.md](docs/superpowers/specs/2026-10-27-reqpilot-design.md)
- Umsetzungsplan: [docs/superpowers/plans/2026-10-27-reqpilot-grundgeruest.md](docs/superpowers/plans/2026-10-27-reqpilot-grundgeruest.md)

## Funktionen

| Seite | Was sie tut |
|---|---|
| Übersicht | Startseite: Kennzahlen, Lebenszyklus als Linie mit Anzahl je Phase, alle Pilot-Tickets, eigene Tickets, offene Tickets je Stream und Epic, offene Bugs (Absprung zur Ursache), zuletzt ausgerollte Changes, Anleitungen und Schulungen. Widgets fester Höhe, die in sich scrollen |
| Ticket erstellen | Freitext → automatisch befüllte, editierbare Vorgabemaske (Titel, Rolle, Ziel, Nutzen, Akzeptanzkriterien, Hintergrund, Land, genau ein Stream, Epic, Priorität); Prioritätsprüfung („Ist das wirklich ein Blocker?“); neue Epics nur für INT; Multi-Stream-Stopp mit Aufteilungsvorschlag; ähnliche Tickets/Seiten auch bei anderer Formulierung, mit Link; Jira-Text und Anlage mit der angemeldeten Person als Autor (abgeschaltet, siehe unten) |
| Meine Tickets | eigene Tickets aus Jira (nur lesen) mit Status und Fortschritt im Lebenszyklus |
| Wissen abfragen | Fragen an Jira, Confluence, Change Log, Anleitungen und Schulungsunterlagen, Antwort mit Quellen |
| Bug-Ursache finden | ServiceNow-Bug → wahrscheinlich verursachender Change/Patch, beteiligte Personen, Konfidenz und Begründung |

## Lokal starten

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
streamlit run app.py
```

Ohne weitere Einstellungen: Testdaten aus `fixtures/`, KI offline (regelbasierter Entwurf).

### Gemini anbinden (Vertex AI mit OAuth, kein API-Key)

API-Keys funktionieren in unserem Google-Cloud-Projekt nicht (401/403). Deshalb ruft ReqPilot Gemini über
Vertex AI mit einem OAuth-Token auf und nennt das Projekt im Header `x-goog-user-project`.

1. Im Cloud-Projekt: Agent Platform API (Vertex AI API) aktiv; das Konto braucht „Vertex AI User“ und
   „Service Usage Consumer“.
2. Lokal einmal anmelden: `gcloud auth application-default login`
3. `.env.example` nach `.env` kopieren und setzen: `REQPILOT_LLM=vertex`, `VERTEX_PROJECT_ID=<projekt-id>`.

| Meldung in der App | Ursache |
|---|---|
| „Keine Google-Anmeldung gefunden“ | Schritt 2 fehlt |
| HTTP 403 | Rolle fehlt, API nicht aktiv oder Projekt-ID falsch (ID, nicht Nummer) |
| HTTP 404 | Modell in der Region nicht verfügbar → `GEMINI_MODEL` oder `VERTEX_LOCATION` ändern |

## Auf Databricks Apps deployen

1. Repo als Git-Folder in den Workspace holen.
2. App anlegen (Compute → Apps → Create app → Custom) und auf den Ordner zeigen; `app.yaml` enthält den Startbefehl.
3. Für Gemini: Auf Databricks gibt es kein Nutzer-Token wie in Apps Script. Ein Service-Account mit den
   Rollen oben wird gebraucht; sein JSON als Secret anlegen, als App-Ressource `vertex-sa` hinterlegen und in
   `app.yaml` `VERTEX_PROJECT_ID`/`VERTEX_SERVICE_ACCOUNT_JSON` einkommentieren, `REQPILOT_LLM` auf `vertex`.
4. Zugriff für die Business-User über die App-Berechtigungen vergeben. Die Anmeldung läuft über den Workspace;
   die App liest die E-Mail aus dem Header `X-Forwarded-Email` (für „Meine Tickets“).

## Auf Live-Daten umschalten

`REQPILOT_DATA_SOURCE=live` und `JIRA_URL`, `JIRA_PAT`, `CONFLUENCE_URL`, `CONFLUENCE_PAT`, `CONFLUENCE_SPACES`,
`SERVICENOW_URL`, `SERVICENOW_TOKEN` setzen. Voraussetzung: Die App erreicht die Systeme im Firmennetz.
Bugs kommen aus der ServiceNow-Tabelle `incident`, Changes/Patches aus `change_request`.

**Jira-Schreiben ist abgeschaltet** (`REQPILOT_JIRA_WRITE_ENABLED=false`). Der Adapter existiert, der Knopf
„In Jira anlegen“ bleibt deaktiviert, bis das bewusst freigegeben wird. Ist es freigegeben, legt die App das
Ticket mit der angemeldeten Person als `reporter` an (E-Mail aus dem Databricks-Login), mit Priorität, Labels
für Land und Stream und dem Epic-Link (`jira.epic_link_field` in `config/settings.yaml`). Tickets, die mehrere
Streams betreffen, werden nicht angelegt.

Change Log, Anleitungen und Schulungsunterlagen liest die App als Markdown-Dateien aus `REQPILOT_DOCS_DIR`
(lokal `fixtures/docs`). Jede Datei hat einen kurzen Kopf mit `title`, `kind` (`changelog`, `guide`,
`training`) und optional `url`. Die Inhalte fließen in die Duplikatprüfung und in „Wissen abfragen“ ein.

## Streams pflegen

Streams stehen in [`config/streams.yaml`](config/streams.yaml). Pilot: 4 ADF-Streams (Namen sind Platzhalter).
Neuer Stream (bis zu 18): Eintrag kopieren, `id`, `name`, `description`, `keywords`, `epics` anpassen,
`enabled: true`. Kein Code nötig. Prioritäten, Lebenszyklus, Länder, Rollen und Schwellwerte stehen in
[`config/settings.yaml`](config/settings.yaml). Rollen: `INT` darf neue Epics vorschlagen, `Land` ordnet
bestehenden Epics zu; die Zuordnung E-Mail → Rolle steht unter `user_roles`, alle anderen bekommen
`default_role`.

## Aufbau

```
app.py                      Einstieg (Databricks Apps / lokal)
src/reqpilot/
  config.py                 Einstellungen aus Umgebung
  streams.py                Stream-Registry und fachliche Konfiguration
  adapters/                 Jira, Confluence, ServiceNow, Gemini (live) und Mocks; Protokolle in base.py
  index/                    Embedder (offline/Gemini) und Vektorindex
  services/                 Ticketersteller, Klassifikation, Duplikate, Meine Tickets, Wissen, Ursachenanalyse
  container.py              einzige mock/live-Weiche
  ui/                       Streamlit-Seiten, Texte (de/en), Farben
dev/                        Guard (npm run guard)
```

Die Oberfläche kennt nur Services, die Services nur Protokolle. Ein IT-Dienstleister kann die UI oder einzelne
Adapter tauschen, ohne die Fachlogik anzufassen.

## Qualität

```bash
npm run guard        # alle Checks
python -m dev.guard tests lint   # einzelne Checks
```

Checks: Tests + Coverage, Mutation, Lint, Security (bandit), Secrets, XSS, Datenschutz (Maskierung vor KI-Aufrufen),
i18n inkl. EN-Modus, WCAG-Kontrast hell/dunkel, A11y, Seitenrechte, Datenkonsistenz, Last-Kurzprofil gegen Mocks,
Performance-Budget, Lizenzen. Warnungen nur mit Ratsche (`dev/guard_baseline.json`).

Nicht automatisch prüfbar und daher manuell zu bewerten: echte Laufzeiten gegen Live-Systeme, Optik und
Verständlichkeit für Business-User, Screenreader-Durchgang, SSO und Freigaben auf Databricks, Qualität echter
Gemini-Antworten, rechtliche Bewertung der Ursachenanalyse (Personenbezug).

## Offene Punkte

- Echte Namen, Beschreibungen und Epics der 4 ADF-Pilotstreams.
- Erreicht Databricks das interne Jira/Confluence/ServiceNow und `aiplatform.googleapis.com`? Darf ein Service-Account für Vertex angelegt werden?
- Quelle für Patch-/Release-Daten bestätigen (angenommen: ServiceNow `change_request`).
- Schwellwerte mit echten Daten nachjustieren.
- Lizenz für das Repository festlegen.
- Rollenliste (wer ist INT) und Jira-Feld für den Epic-Link der Zielinstanz; Zuordnung E-Mail → Jira-Benutzername.
- Exportweg für Change Log, Anleitungen und Schulungsunterlagen in den Dokumente-Ordner.

## Markenhinweis

Jira und Confluence sind Marken von Atlassian, ServiceNow ist eine Marke von ServiceNow, Inc., Databricks ist
eine Marke von Databricks, Inc., Gemini ist eine Marke von Google LLC.
Die Nennung dient nur der Beschreibung der Schnittstellen.
