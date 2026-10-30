"""Gemini über Vertex AI (Agent Platform) mit OAuth-Token und Quota-Projekt, ohne API-Key.

Bewährter Weg in unserer Umgebung: Bearer-Token mit Scope cloud-platform plus Header x-goog-user-project.
"""

from __future__ import annotations

import requests

from reqpilot.adapters.errors import LlmUnavailable
from reqpilot.adapters.gemini import generate_body, parse_text
from reqpilot.adapters.google_auth import TokenProvider
from reqpilot.adapters.http import request_json


def vertex_model_url(project: str, location: str, model: str, method: str) -> str:
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    return f"https://{host}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:{method}"


def vertex_headers(project: str, tokens: TokenProvider) -> dict:
    return {
        "Authorization": f"Bearer {tokens.token()}",
        "x-goog-user-project": project,
        "Content-Type": "application/json",
    }


class VertexLlm:
    available = True

    def __init__(
        self,
        project: str,
        location: str,
        model: str,
        timeout: float,
        tokens: TokenProvider,
        session: requests.Session | None = None,
    ):
        self._project = project
        self._location = location
        self._model = model
        self._timeout = timeout
        self._tokens = tokens
        self._session = session or requests.Session()

    def generate(self, prompt: str, *, json_mode: bool = False) -> str:
        data = request_json(
            self._session,
            "POST",
            vertex_model_url(self._project, self._location, self._model, "generateContent"),
            timeout=self._timeout,
            headers=vertex_headers(self._project, self._tokens),
            json=generate_body(prompt, json_mode),
            error=LlmUnavailable,
        )
        return parse_text(data)
