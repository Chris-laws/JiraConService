"""OAuth-Token für Google Cloud (Token statt API-Key).

Reihenfolge: Service-Account-JSON aus der Umgebung (z. B. Databricks-Secret), sonst Application Default
Credentials (lokal: `gcloud auth application-default login`).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Protocol

from reqpilot.adapters.errors import LlmUnavailable

SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)
REFRESH_MARGIN = timedelta(minutes=5)
LOGIN_HINT = "Lokal einmal `gcloud auth application-default login` ausführen oder VERTEX_SERVICE_ACCOUNT_JSON setzen."


class TokenProvider(Protocol):
    def token(self) -> str: ...


class AdcTokenProvider:
    def __init__(self, service_account_json: str | None = None):
        self._sa_json = service_account_json
        self._creds = None

    def _load(self):
        import google.auth
        import google.auth.exceptions
        from google.oauth2 import service_account

        if self._sa_json:
            try:
                info = json.loads(self._sa_json)
                return service_account.Credentials.from_service_account_info(info, scopes=list(SCOPES))
            except (ValueError, KeyError) as exc:
                raise LlmUnavailable(f"VERTEX_SERVICE_ACCOUNT_JSON ist ungültig: {type(exc).__name__}") from exc
        try:
            creds, _ = google.auth.default(scopes=list(SCOPES))
        except google.auth.exceptions.DefaultCredentialsError as exc:
            raise LlmUnavailable(f"Keine Google-Anmeldung gefunden. {LOGIN_HINT}") from exc
        return creds

    def _needs_refresh(self) -> bool:
        if not self._creds.valid or not self._creds.token:
            return True
        expiry = getattr(self._creds, "expiry", None)
        return expiry is not None and expiry - REFRESH_MARGIN <= datetime.now(UTC).replace(tzinfo=None)

    def token(self) -> str:
        import google.auth.exceptions
        from google.auth.transport.requests import Request

        if self._creds is None:
            self._creds = self._load()
        if self._needs_refresh():
            try:
                self._creds.refresh(Request())
            except google.auth.exceptions.GoogleAuthError as exc:
                raise LlmUnavailable(f"Google-Token konnte nicht erneuert werden. {LOGIN_HINT}") from exc
        return self._creds.token
