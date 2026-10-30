"""Gemini über REST. Key nur im Header, nie in der URL."""

from __future__ import annotations

import requests

from reqpilot.adapters.errors import LlmUnavailable
from reqpilot.adapters.http import request_json

API = "https://generativelanguage.googleapis.com/v1beta"


def generate_body(prompt: str, json_mode: bool) -> dict:
    config: dict = {"temperature": 0.2}
    if json_mode:
        config["responseMimeType"] = "application/json"
    return {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": config}


def parse_text(data: dict) -> str:
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmUnavailable("Gemini-Antwort ohne Text") from exc


class GeminiLlm:
    available = True

    def __init__(self, api_key: str, model: str, timeout: float, session: requests.Session | None = None):
        self._key = api_key
        self._model = model
        self._timeout = timeout
        self._session = session or requests.Session()

    def generate(self, prompt: str, *, json_mode: bool = False) -> str:
        data = request_json(
            self._session,
            "POST",
            f"{API}/models/{self._model}:generateContent",
            timeout=self._timeout,
            headers={"x-goog-api-key": self._key, "Content-Type": "application/json"},
            json=generate_body(prompt, json_mode),
            error=LlmUnavailable,
        )
        return parse_text(data)
