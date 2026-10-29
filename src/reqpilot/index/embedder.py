"""Embedder: offline per Feature-Hashing (deterministisch, ohne Netz) oder über Gemini."""

from __future__ import annotations

import re
import unicodedata
import zlib
from typing import Protocol

import numpy as np
import requests

from reqpilot.adapters.errors import LlmUnavailable
from reqpilot.adapters.gemini import API
from reqpilot.adapters.google_auth import TokenProvider
from reqpilot.adapters.http import request_json
from reqpilot.adapters.vertex import vertex_headers, vertex_model_url

_WORD = re.compile(r"[a-z0-9]+")
_STOP = frozenset(
    [
        "der",
        "die",
        "das",
        "und",
        "oder",
        "ein",
        "eine",
        "einer",
        "eines",
        "einem",
        "einen",
        "ist",
        "sind",
        "wird",
        "werden",
        "soll",
        "sollen",
        "muss",
        "müssen",
        "im",
        "in",
        "am",
        "an",
        "auf",
        "aus",
        "bei",
        "mit",
        "nach",
        "von",
        "vor",
        "zu",
        "zum",
        "zur",
        "für",
        "fur",
        "ich",
        "wir",
        "sie",
        "es",
        "nicht",
        "auch",
        "als",
        "wie",
        "dass",
        "damit",
        "um",
        "den",
        "dem",
        "des",
        "bitte",
        "noch",
        "nur",
        "so",
        "sehr",
        "kann",
        "können",
        "mehr",
        "dann",
        "wenn",
        "aber",
    ]
)
_SUFFIXES = ("ungen", "ung", "en", "er", "es", "e", "n", "s")


def _normalize(text: str) -> str:
    text = text.lower().replace("ß", "ss")
    text = text.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def _stem(word: str) -> str:
    for suffix in _SUFFIXES:
        if len(word) > len(suffix) + 4 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def tokens(text: str) -> list[str]:
    stop = {_normalize(w) for w in _STOP}
    return [_stem(w) for w in _WORD.findall(_normalize(text)) if w not in stop and len(w) > 1]


class Embedder(Protocol):
    name: str

    def embed(self, texts: list[str]) -> np.ndarray: ...


def _l2(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


class HashingEmbedder:
    """Wortstämme plus Zeichen-4-Gramme (fängt Komposita wie Bestellvorschlag/Bestellvorschläge)."""

    name = "hashing"

    def __init__(self, dim: int = 2048, ngram: int = 4, ngram_weight: float = 0.35):
        self.dim = dim
        self.ngram = ngram
        self.ngram_weight = ngram_weight

    def _features(self, text: str) -> list[tuple[str, float]]:
        feats: list[tuple[str, float]] = []
        for tok in tokens(text):
            feats.append((f"w:{tok}", 1.0))
            padded = f"_{tok}_"
            for i in range(max(len(padded) - self.ngram + 1, 0)):
                feats.append((f"g:{padded[i : i + self.ngram]}", self.ngram_weight))
        return feats

    def embed(self, texts: list[str]) -> np.ndarray:
        matrix = np.zeros((len(texts), self.dim), dtype=np.float32)
        for row, text in enumerate(texts):
            for feat, weight in self._features(text):
                h = zlib.crc32(feat.encode())
                sign = 1.0 if (h >> 31) & 1 else -1.0
                matrix[row, h % self.dim] += sign * weight
        return _l2(matrix)


class GeminiEmbedder:
    name = "gemini"
    BATCH = 100

    def __init__(
        self,
        api_key: str,
        timeout: float,
        model: str = "text-embedding-004",
        session: requests.Session | None = None,
    ):
        self._key = api_key
        self._model = model
        self._timeout = timeout
        self._session = session or requests.Session()

    def embed(self, texts: list[str]) -> np.ndarray:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.BATCH):
            chunk = texts[start : start + self.BATCH]
            body = {
                "requests": [
                    {"model": f"models/{self._model}", "content": {"parts": [{"text": t or " "}]}} for t in chunk
                ]
            }
            data = request_json(
                self._session,
                "POST",
                f"{API}/models/{self._model}:batchEmbedContents",
                timeout=self._timeout,
                headers={"x-goog-api-key": self._key, "Content-Type": "application/json"},
                json=body,
                error=LlmUnavailable,
            )
            try:
                vectors += [e["values"] for e in data["embeddings"]]
            except (KeyError, TypeError) as exc:
                raise LlmUnavailable("Gemini-Embedding-Antwort unerwartet") from exc
        return _l2(np.asarray(vectors, dtype=np.float32).reshape(len(texts), -1))


class VertexEmbedder:
    """Embeddings über Vertex AI mit OAuth-Token (multilingual, passend für deutsche Tickets)."""

    name = "vertex"
    BATCH = 50

    def __init__(
        self,
        project: str,
        location: str,
        timeout: float,
        tokens: TokenProvider,
        model: str = "text-multilingual-embedding-002",
        session: requests.Session | None = None,
    ):
        self._project = project
        self._location = location
        self._timeout = timeout
        self._tokens = tokens
        self._model = model
        self._session = session or requests.Session()

    def embed(self, texts: list[str]) -> np.ndarray:
        vectors: list[list[float]] = []
        url = vertex_model_url(self._project, self._location, self._model, "predict")
        for start in range(0, len(texts), self.BATCH):
            chunk = texts[start : start + self.BATCH]
            data = request_json(
                self._session,
                "POST",
                url,
                timeout=self._timeout,
                headers=vertex_headers(self._project, self._tokens),
                json={"instances": [{"content": t or " "} for t in chunk]},
                error=LlmUnavailable,
            )
            try:
                vectors += [p["embeddings"]["values"] for p in data["predictions"]]
            except (KeyError, TypeError) as exc:
                raise LlmUnavailable("Vertex-Embedding-Antwort unerwartet") from exc
        return _l2(np.asarray(vectors, dtype=np.float32).reshape(len(texts), -1))
