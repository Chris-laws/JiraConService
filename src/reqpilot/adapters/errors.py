"""Fehlertypen der Adapter. Die UI übersetzt sie in verständliche Meldungen."""


class SourceUnavailable(RuntimeError):
    """Eine Datenquelle (Jira, Confluence, ServiceNow) ist nicht erreichbar oder antwortet unbrauchbar."""


class WriteDisabled(PermissionError):
    """Schreiben nach Jira ist im Prototyp abgeschaltet."""


class LlmUnavailable(RuntimeError):
    """Kein LLM verfügbar oder Aufruf fehlgeschlagen; Services nutzen dann ihre Offline-Logik."""
