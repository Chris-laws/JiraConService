"""Platzhalter ohne Gemini-Key: meldet sich als nicht verfügbar, Services nutzen ihre Offline-Logik."""

from reqpilot.adapters.errors import LlmUnavailable


class OfflineLlm:
    available = False

    def generate(self, prompt: str, *, json_mode: bool = False) -> str:
        raise LlmUnavailable("Kein Gemini-Key konfiguriert (Offline-Modus)")
