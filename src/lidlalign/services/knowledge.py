"""Wissensabfrage (RAG) über Jira und Confluence, Antworten nur mit Quellen."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from lidlalign.adapters.base import Llm
from lidlalign.adapters.errors import LlmUnavailable
from lidlalign.index.embedder import tokens
from lidlalign.index.vector_index import VectorIndex
from lidlalign.models import SearchHit
from lidlalign.privacy import redact

NO_SOURCE = "Dazu habe ich in Jira und Confluence keine passende Quelle gefunden."
_SENTENCE = re.compile(r"(?<=[.!?])\s+")

PROMPT = """Beantworte die Frage ausschließlich mit den nummerierten Quellen. Zitiere mit [Nummer].
Steht die Antwort nicht in den Quellen, sage das ehrlich. Antworte knapp auf Deutsch.

Quellen:
{sources}

Frage: {question}"""


@dataclass
class Answer:
    text: str
    sources: list[SearchHit] = field(default_factory=list)
    source: str = "offline"
    notice: str = ""


class KnowledgeService:
    def __init__(self, index: VectorIndex, llm: Llm, thresholds: dict, k: int = 4):
        self._index = index
        self._llm = llm
        self._min = thresholds["similar"]
        self._k = k

    def ask(self, question: str) -> Answer:
        hits = self._index.search(question, k=self._k, min_score=self._min)
        if not hits:
            return Answer(NO_SOURCE)
        if self._llm.available:
            try:
                return Answer(self._generate(question, hits), hits, "gemini")
            except LlmUnavailable as exc:
                answer = self._extract(question, hits)
                answer.notice = f"KI nicht erreichbar ({exc}); Antwort aus den besten Textstellen."
                return answer
        return self._extract(question, hits)

    def _generate(self, question: str, hits: list[SearchHit]) -> str:
        sources = "\n".join(f"[{n}] {h.title}: {h.snippet}" for n, h in enumerate(hits, 1))
        return self._llm.generate(PROMPT.format(sources=redact(sources), question=redact(question))).strip()

    @staticmethod
    def _extract(question: str, hits: list[SearchHit]) -> Answer:
        wanted = set(tokens(question))
        best: list[tuple[int, str]] = []
        for n, hit in enumerate(hits, 1):
            for sentence in _SENTENCE.split(hit.snippet):
                overlap = len(wanted & set(tokens(sentence)))
                if overlap:
                    best.append((overlap, f"{sentence.strip()} [{n}]"))
        best.sort(key=lambda x: x[0], reverse=True)
        lines = [s for _, s in best[:3]] or [f"{hits[0].snippet} [1]"]
        return Answer("Laut den gefundenen Quellen: " + " ".join(lines), hits, "offline")
