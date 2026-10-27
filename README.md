# LidlALign

Prototyp für das Anforderungsmanagement im ADF-Umfeld: einheitliche Anforderungs-Tickets, Duplikat- und
Ähnlichkeitsprüfung gegen Jira und Confluence, Stream-/Epic-Vorschlag, eigene Tickets verfolgen und
Ursachenanalyse für ServiceNow-Bugs.

Läuft als **Streamlit-App auf Databricks Apps**. Lokal und ohne Firmennetz funktioniert alles mit Testdaten.

- Design: [docs/superpowers/specs/2026-10-27-lidlalign-design.md](docs/superpowers/specs/2026-10-27-lidlalign-design.md)
- Umsetzungsplan: [docs/superpowers/plans/2026-10-27-lidlalign-grundgeruest.md](docs/superpowers/plans/2026-10-27-lidlalign-grundgeruest.md)

## Funktionen

| Seite | Was sie tut |
|---|---|
| Ticket erstellen | Freitext → User Story mit Akzeptanzkriterien und Priorität; Stream-/Epic-Vorschlag mit Konfidenz; Multi-Stream-Stopp mit Aufteilungsvorschlag; ähnliche Tickets/Seiten; Export im Jira-Format |
| Meine Tickets | eigene Tickets aus Jira (nur lesen) mit Status und Fortschritt im Lebenszyklus |
| Wissen abfragen | Fragen an Jira und Confluence, Antwort mit Quellen |
| Bug-Ursache finden | ServiceNow-Bug → wahrscheinlich verursachender Change/Patch, beteiligte Personen, Konfidenz und Begründung |

## Lokal starten

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
streamlit run app.py
```

Ohne weitere Einstellungen: Testdaten aus `fixtures/`, KI offline (regelbasierter Entwurf). Für Gemini:
`.env.example` nach `.env` kopieren bzw. Variablen setzen: `LIDLALIGN_LLM=gemini`, `GEMINI_API_KEY=…`.

## Auf Databricks Apps deployen

1. Repo als Git-Folder in den Workspace holen.
2. App anlegen (Compute → Apps → Create app → Custom) und auf den Ordner zeigen; `app.yaml` enthält den Startbefehl.
3. Gemini-Key als Secret anlegen und als App-Ressource `gemini-key` hinterlegen, dann in `app.yaml` die
   `GEMINI_API_KEY`-Zeilen einkommentieren und `LIDLALIGN_LLM` auf `gemini` setzen.
4. Zugriff für die Business-User über die App-Berechtigungen vergeben. Die Anmeldung läuft über den Workspace;
   die App liest die E-Mail aus dem Header `X-Forwarded-Email` (für „Meine Tickets“).

## Auf Live-Daten umschalten

`LIDLALIGN_DATA_SOURCE=live` und `JIRA_URL`, `JIRA_PAT`, `CONFLUENCE_URL`, `CONFLUENCE_PAT`, `CONFLUENCE_SPACES`,
`SERVICENOW_URL`, `SERVICENOW_TOKEN` setzen. Voraussetzung: Die App erreicht die Systeme im Firmennetz.
Bugs kommen aus der ServiceNow-Tabelle `incident`, Changes/Patches aus `change_request`.

**Jira-Schreiben ist abgeschaltet** (`LIDLALIGN_JIRA_WRITE_ENABLED=false`). Der Adapter existiert, der Knopf
„In Jira anlegen“ bleibt deaktiviert, bis das bewusst freigegeben wird.

## Streams pflegen

Streams stehen in [`config/streams.yaml`](config/streams.yaml). Pilot: 4 ADF-Streams (Namen sind Platzhalter).
Neuer Stream (bis zu 18): Eintrag kopieren, `id`, `name`, `description`, `keywords`, `epics` anpassen,
`enabled: true`. Kein Code nötig. Prioritäten, Lebenszyklus, Länder und Schwellwerte stehen in
[`config/settings.yaml`](config/settings.yaml).

## Aufbau

```
app.py                      Einstieg (Databricks Apps / lokal)
src/lidlalign/
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
- Erreicht Databricks das interne Jira/Confluence/ServiceNow? Ist Egress zur Gemini-API erlaubt?
- Quelle für Patch-/Release-Daten bestätigen (angenommen: ServiceNow `change_request`).
- Schwellwerte mit echten Daten nachjustieren.
- Lizenz für das Repository festlegen.

## Markenhinweis

Jira und Confluence sind Marken von Atlassian, ServiceNow ist eine Marke von ServiceNow, Inc., Databricks ist
eine Marke von Databricks, Inc., Gemini ist eine Marke von Google LLC. Lidl ist eine Marke der Lidl Stiftung & Co. KG.
Die Nennung dient nur der Beschreibung der Schnittstellen.
