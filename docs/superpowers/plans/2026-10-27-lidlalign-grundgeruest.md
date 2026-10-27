# LidlALign Grundgerüst Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lauffähiger Streamlit-Prototyp mit allen vier Funktionen auf Mock-Daten, austauschbaren Adaptern und grünem Guard.

**Architecture:** Python-Paket `lidlalign` (src-Layout) mit Protokollen für alle externen Systeme, Mock- und Live-Adaptern, fachlichen Services und einer dünnen Streamlit-UI. `container.build_container(settings)` verdrahtet alles.

**Tech Stack:** Python ≥ 3.11, Streamlit, numpy, PyYAML, requests, pytest, ruff, bandit, pip-licenses.

**Spec:** `docs/superpowers/specs/2026-10-27-lidlalign-design.md`

**Ausführung:** Native (Chris: „in einem Zug“), TDD pro Task.

## Global Constraints

- Python ≥ 3.11 (Databricks Apps); keine weiteren Laufzeit-Abhängigkeiten als streamlit, numpy, pyyaml, requests.
- UI-Texte nur über `lidlalign.ui.i18n.t(key)`; Sprache Deutsch, EN-Datei für das Audit.
- Jira-Schreiben aus: `LIDLALIGN_JIRA_WRITE_ENABLED` Default `false`; `JiraWriter.create_issue` wirft `WriteDisabled`.
- Prioritäten exakt: `Blocker`, `High`, `Medium`, `Low`.
- Secrets nur aus Umgebung (`GEMINI_API_KEY`, `JIRA_PAT`, `CONFLUENCE_PAT`, `SERVICENOW_TOKEN`).
- Alle HTTP-Aufrufe mit Timeout (Default 15 s).
- Vor LLM-Aufrufen `privacy.redact()`.

## Review Focus

- Leerer oder sehr kurzer Freitext → offene Fragen statt Absturz oder erfundener Inhalt (Test in Task 4).
- Gemini liefert kein gültiges JSON / Prioritätswert außerhalb des Schemas → validierter Fallback-Entwurf (Task 4).
- Kein aktiver Stream bzw. Stream ohne Epics in der YAML → Konfigurationsfehler mit klarer Meldung, bzw. kein Epic-Vorschlag (Task 2/5).
- Bug ohne Changes im Zeitfenster → „keine klare Ursache“ statt Kandidat mit Schein-Konfidenz (Task 7).
- Live-Quelle nicht erreichbar / Timeout → `SourceUnavailable`, UI zeigt Meldung (Task 3).

---

### Task 1: Projektgerüst, Einstellungen, Guard-Skelett

**Files:** `pyproject.toml`, `requirements.txt`, `requirements-dev.txt`, `package.json`, `app.yaml`, `.gitignore`, `.env.example`, `src/lidlalign/config.py`, `tests/test_config.py`

**Interfaces:** Produces `Settings` (frozen dataclass) mit `data_source: str`, `llm: str`, `jira_write_enabled: bool`, `gemini_api_key: str | None`, `gemini_model: str`, `http_timeout: float`, `config_dir: Path`, `fixtures_dir: Path`; `load_settings(env: Mapping[str,str] | None = None) -> Settings`.

- [ ] Test: Defaults `data_source == "mock"`, `llm == "fake"`, `jira_write_enabled is False`; `LIDLALIGN_LLM=gemini` ohne Key → `ConfigError`.
- [ ] Implementieren, Test grün, Commit.

### Task 2: Modelle und Stream-Registry

**Files:** `src/lidlalign/models.py`, `src/lidlalign/streams.py`, `config/streams.yaml`, `config/settings.yaml`, `tests/test_streams.py`

**Interfaces:** `Stream(id, name, description, keywords, board, epics: list[Epic], enabled)`, `Epic(key, title)`; `StreamRegistry.from_yaml(path) -> StreamRegistry`, `.active() -> list[Stream]`, `.get(id) -> Stream`. Fehler: doppelte IDs / keine aktiven Streams → `ConfigError`.

- [ ] Tests: 4 aktive Pilot-Streams; Stream mit `enabled: false` nicht in `active()`; doppelte ID → `ConfigError`.
- [ ] Implementieren, grün, Commit.

### Task 3: Adapter-Protokolle, Mock-Adapter, Live-Adapter, Container

**Files:** `src/lidlalign/adapters/{base,errors,mock,jira_rest,confluence_rest,servicenow_rest,gemini,fake_llm}.py`, `src/lidlalign/container.py`, `fixtures/*.json`, `tests/test_adapters.py`

**Interfaces:** Protokolle `JiraReader.search_issues() -> list[Issue]`, `.issues_by_reporter(email) -> list[Issue]`; `JiraWriter.create_issue(draft) -> str`; `ConfluenceReader.pages() -> list[Page]`; `ServiceNowReader.bugs() -> list[Bug]`, `.bug(number) -> Bug`; `ChangeSource.changes() -> list[Change]`; `Llm.generate(prompt: str, *, json_mode: bool=False) -> str`. `Container(settings, streams, jira, jira_writer, confluence, servicenow, changes, llm, embedder)`; `build_container(settings) -> Container`.

- [ ] Tests: Mock-Reader lesen Fixtures; Writer wirft `WriteDisabled`; Live-Adapter mit gemocktem `requests`: Timeout → `SourceUnavailable`, HTTP 500 → `SourceUnavailable`, kaputtes JSON → `SourceUnavailable`.
- [ ] Implementieren, grün, Commit.

### Task 4: Privacy, Ticket-Entwurf, Jira-Export

**Files:** `src/lidlalign/privacy.py`, `src/lidlalign/services/ticket_writer.py`, `tests/test_ticket_writer.py`, `tests/test_privacy.py`

**Interfaces:** `redact(text) -> str`; `TicketDraft(title, role, goal, benefit, acceptance_criteria, background, priority, country, open_questions)`; `TicketWriter(llm, priorities).draft(text, country) -> TicketDraft`; `to_jira_markup(draft, stream=None, epic=None) -> str`.

- [ ] Tests: E-Mail/Telefon maskiert; leerer Text → offene Frage, kein Absturz; LLM liefert Müll → Fallback-Entwurf mit Priorität `Medium`; Priorität „Super“ → `Medium`; Markup enthält „h3. User Story“ und Akzeptanzkriterien als `*`-Liste.

### Task 5: Embedder, Index, Klassifikation, Duplikate

**Files:** `src/lidlalign/index/{embedder,vector_index}.py`, `src/lidlalign/services/{classifier,duplicates}.py`, Tests.

**Interfaces:** `Embedder.embed(texts) -> np.ndarray` (L2-normiert); `HashingEmbedder(dim=512)`; `VectorIndex.add(ids, texts, payloads)`, `.search(text, k) -> list[SearchHit]`; `StreamClassifier(registry, embedder, thresholds).classify(text) -> Classification(suggestions: list[StreamSuggestion], epic: Epic | None, multi_stream: bool)`; `DuplicateChecker(index, thresholds).check(text) -> list[DuplicateHit]` mit `level in {"duplicate","similar"}`.

- [ ] Tests: Kassen-Text → Stream „Kasse“ auf Platz 1; Konfidenzen summieren ≈ 1; Text, der zwei Streams nennt → `multi_stream`; nahezu identischer Fixture-Text → `duplicate`; fremder Text → keine Treffer.

### Task 6: Meine Tickets und Wissensabfrage

**Files:** `src/lidlalign/services/{my_tickets,knowledge}.py`, Tests.

**Interfaces:** `MyTickets(jira, lifecycle).for_user(email) -> list[TicketStatus]`; `KnowledgeService(index, llm).ask(question, k=4) -> Answer(text, sources)`.

- [ ] Tests: nur eigene Tickets, Phase-Nummer aus Lebenszyklus; Antwort enthält Quellen; keine Treffer → „keine Quelle gefunden“.

### Task 7: Bug-Ursachenanalyse

**Files:** `src/lidlalign/services/rca.py`, `tests/test_rca.py`

**Interfaces:** `RootCauseAnalyzer(changes, embedder, window_days=21, half_life_days=4, min_score=0.35).analyze(bug) -> RcaResult(candidates: list[RcaCandidate], conclusive: bool)`; `RcaCandidate(change, score, confidence, signals: dict[str,float], reasons: list[str])`.

Score: `0.45*komponente + 0.30*zeit + 0.25*text`, `zeit = 0.5 ** (Tage/half_life)`, nur Changes mit `deployed_at <= first_seen` und im Fenster; Konfidenz = Score-Anteil an der Summe der Top-Kandidaten, gedeckelt durch den absoluten Score.

- [ ] Tests: Fixture-Bug → erwarteter Patch auf Platz 1; Change nach Bug-Beginn ignoriert; keine Kandidaten → `conclusive is False`.

### Task 8: Streamlit-UI

**Files:** `app.py`, `src/lidlalign/ui/{i18n,theme,state,pages_registry}.py`, `src/lidlalign/ui/pages/{ticket,my_tickets,knowledge,rca}.py`, `src/lidlalign/ui/strings/{de,en}.yaml`, `.streamlit/config.toml`, `tests/test_ui_smoke.py`

- [ ] Smoke-Tests mit `streamlit.testing.v1.AppTest`: jede Seite rendert ohne Exception; Ticketseite erzeugt Entwurf nach Klick.

### Task 9: Guard-Checks komplett, README

**Files:** `dev/guard.py`, `dev/checks/*.py`, `dev/guard_baseline.json`, `README.md`

- [ ] Alle Checks aus Spec §6 registriert; `npm run guard` grün; README (Deutsch) mit Start lokal, Deploy auf Databricks, Umschalten auf Live, Stream hinzufügen, offene Punkte.
