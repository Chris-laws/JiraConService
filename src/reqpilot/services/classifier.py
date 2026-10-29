"""Stream- und Epic-Vorschlag mit Konfidenz; erkennt Multi-Stream-Anforderungen."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from reqpilot.index.embedder import Embedder, tokens
from reqpilot.models import Epic, Stream
from reqpilot.streams import StreamRegistry

TOP_N = 3
MIN_CLAUSE_TOKENS = 3
_CLAUSE_SPLIT = re.compile(r"(?<=[.!?;])\s+|\s+(?:und außerdem|sowie|zusätzlich soll)\s+", re.I)


@dataclass(frozen=True)
class StreamSuggestion:
    stream: Stream
    similarity: float
    confidence: float
    matched_keywords: tuple[str, ...] = ()


@dataclass(frozen=True)
class SplitPart:
    stream: Stream
    text: str


@dataclass
class Classification:
    suggestions: list[StreamSuggestion]
    all_scores: list[StreamSuggestion]
    epic: Epic | None
    multi_stream: bool
    uncertain: bool
    split_proposal: list[SplitPart] = field(default_factory=list)


def _softmax(values: np.ndarray, temperature: float) -> np.ndarray:
    z = (values - values.max()) / max(temperature, 1e-6)
    e = np.exp(z)
    return e / e.sum()


class StreamClassifier:
    def __init__(self, registry: StreamRegistry, embedder: Embedder, thresholds: dict):
        self._streams = registry.active()
        self._embedder = embedder
        self._th = thresholds
        self._profiles = embedder.embed([s.profile_text() for s in self._streams])

    def _similarities(self, text: str) -> np.ndarray:
        return self._profiles @ self._embedder.embed([text])[0]

    @staticmethod
    def _matched(stream: Stream, text: str) -> tuple[str, ...]:
        text_tokens = set(tokens(text))
        return tuple(k for k in stream.keywords if set(tokens(k)) & text_tokens)

    def _epic(self, stream: Stream, text: str) -> Epic | None:
        if not stream.epics:
            return None
        sims = self._embedder.embed([e.title for e in stream.epics]) @ self._embedder.embed([text])[0]
        return stream.epics[int(np.argmax(sims))]

    def _split(self, text: str) -> list[SplitPart]:
        parts: dict[str, list[str]] = {}
        for clause in (c.strip() for c in _CLAUSE_SPLIT.split(text)):
            if len(tokens(clause)) < MIN_CLAUSE_TOKENS:
                continue
            sims = self._similarities(clause)
            best = int(np.argmax(sims))
            if sims[best] >= self._th["multi_stream_min"]:
                parts.setdefault(self._streams[best].id, []).append(clause)
        by_id = {s.id: s for s in self._streams}
        return [SplitPart(by_id[sid], " ".join(clauses)) for sid, clauses in parts.items()]

    def classify(self, text: str) -> Classification:
        sims = self._similarities(text)
        conf = _softmax(sims, self._th["stream_temperature"])
        scored = [
            StreamSuggestion(s, round(float(sims[i]), 4), float(conf[i]), self._matched(s, text))
            for i, s in enumerate(self._streams)
        ]
        ranked = sorted(scored, key=lambda s: s.similarity, reverse=True)
        top = ranked[0]
        uncertain = top.similarity < self._th["multi_stream_min"]

        split = [] if uncertain else self._split(text)
        multi = len(split) >= 2
        if not multi and len(ranked) > 1 and not uncertain:
            second = ranked[1]
            close = second.similarity >= self._th["multi_stream_ratio"] * top.similarity
            multi = close and second.similarity >= self._th["multi_stream_min"]
            if multi:
                split = [SplitPart(top.stream, text), SplitPart(second.stream, text)]

        return Classification(
            suggestions=ranked[:TOP_N],
            all_scores=scored,
            epic=None if uncertain else self._epic(top.stream, text),
            multi_stream=multi,
            uncertain=uncertain,
            split_proposal=split if multi else [],
        )
