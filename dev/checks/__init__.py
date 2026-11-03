"""Registry aller Guard-Checks. Neuer Check = neuer Eintrag."""

from dev.checks import appscript, quality, runtime, security, ui
from dev.checks.base import Check

CHECKS: tuple[Check, ...] = (
    Check("tests", "Unit-, Mock- und UI-Smoke-Tests mit Coverage", f"alle grün, Coverage ≥ {quality.COVERAGE_MIN} %", quality.tests),
    Check("mutation", "Tests erkennen Logikfehler in der Scoring-Logik", f"Mutation-Score ≥ {quality.MUTATION_MIN:.0%}", quality.mutation),
    Check("lint", "ruff: Fehler, Stil, Komplexität, Formatierung", "0 Befunde", quality.lint),
    Check("security", "bandit: unsichere Muster", "0 Befunde ab Medium", security.security),
    Check("secrets", "keine Schlüssel/Tokens im Repo", "0 Treffer", security.secrets),
    Check("xss", "kein ungeprüftes HTML in der UI", "nur statisches CSS in theme.py", security.xss),
    Check("privacy", "personenbezogene Daten nicht an die KI", "redact() vor jedem LLM-Aufruf", security.privacy),
    Check("i18n", "alle Texte übersetzbar, EN-Modus rendert", "DE = EN, keine hart codierten Texte", ui.i18n),
    Check("contrast", "WCAG-Kontrast hell und dunkel", f"≥ {ui.AA}:1", ui.contrast),
    Check("a11y", "Labels, Hilfetexte, Ladezustände", "0 Befunde", ui.a11y),
    Check("permissions", "jede Seite mit Rolle registriert", "0 fehlende Einträge", ui.permissions),
    Check("consistency", "Stream-Config, Epics, Status und Fixtures passen zusammen", "0 Widersprüche", runtime.consistency),
    Check("load", "Last-Kurzprofil gegen Mocks", f"p95 ≤ {runtime.LOAD_P95_MS} ms", runtime.load),
    Check("budget", "Kaltstart und Abhängigkeiten", f"≤ {runtime.COLD_START_S} s, ≤ {runtime.MAX_RUNTIME_DEPS} Pakete", runtime.budget),
    Check("license", "erlaubte Lizenzen, Markenhinweis", "nur Allowlist", runtime.license_check),
    Check("brand", "keine Firmen- oder internen Namen im öffentlichen Repo", "0 Treffer", appscript.brand),
    Check("as-tests", "Apps Script: Seiten, Live-Adapter, Vertex-Header, Bundle aktuell", "alle grün", appscript.tests),
    Check("as-readonly", "Apps Script liest nur: alle Abrufe durch die Sperre, nur GET an Jira/Confluence/ServiceNow, keine Schreib-Berechtigungen", "0 Befunde", appscript.readonly),
    Check("as-privacy", "Apps Script: Prompts nur nach redact(), Melder bleibt auf dem Server", "0 Befunde", appscript.privacy),
    Check("as-stress", "Apps Script: 500/2.000 Tickets, Cache unter 100 KB je Wert, 4.775 Fuzzing-Aufrufe", "Seite mit Cache < 30 s, kein Absturz, keine Tokens", appscript.stress),
    Check("as-budget", "Apps Script: Seitengröße, größte Antwort, Laufzeit mit Cache; Budgets nur senken (Ratsche)", "unter budgets.json", appscript.budget),
    Check("as-load", "Apps Script: Lastsimulation mit 30 gleichzeitigen Ausführungen, Wiederholung, Erlang-B", "300 Personen: p95 ≤ 3 s, ≤ 0,5 % gescheitert", appscript.load),
    Check("as-ui", "Apps Script im Browser: XSS, Kontrast, Schrift, A11y, Layout, Englisch", "0 Befunde außer begründeten Ausnahmen", appscript.ui),
)  # fmt: skip
