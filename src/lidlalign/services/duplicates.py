"""Semantische Duplikat- und Ähnlichkeitsprüfung gegen Jira und Confluence."""

from __future__ import annotations

from dataclasses import dataclass

from lidlalign.index.vector_index import VectorIndex
from lidlalign.models import SearchHit


@dataclass(frozen=True)
class DuplicateHit:
    hit: SearchHit
    level: str  # "duplicate" | "similar"


class DuplicateChecker:
    def __init__(self, index: VectorIndex, thresholds: dict, k: int = 5):
        self._index = index
        self._th = thresholds
        self._k = k

    def check(self, text: str) -> list[DuplicateHit]:
        hits = self._index.search(text, k=self._k, min_score=self._th["similar"])
        return [DuplicateHit(h, "duplicate" if h.score >= self._th["duplicate"] else "similar") for h in hits]
