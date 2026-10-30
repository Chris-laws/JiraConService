"""In-Memory-Vektorindex. Später austauschbar gegen Databricks Vector Search."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from reqpilot.adapters.base import ConfluenceReader, DocumentSource, JiraReader
from reqpilot.index.embedder import Embedder
from reqpilot.models import SearchHit

SNIPPET_LEN = 220


@dataclass(frozen=True)
class IndexItem:
    id: str
    text: str
    title: str
    url: str
    source: str
    payload: dict


class VectorIndex:
    def __init__(self, embedder: Embedder):
        self.embedder = embedder
        self._items: list[IndexItem] = []
        self._matrix = np.zeros((0, 1), dtype=np.float32)

    def __len__(self) -> int:
        return len(self._items)

    def add(self, items: list[IndexItem]) -> None:
        if not items:
            return
        vectors = self.embedder.embed([i.text for i in items])
        self._matrix = vectors if not self._items else np.vstack([self._matrix, vectors])
        self._items += items

    def search(self, text: str, k: int = 5, min_score: float = 0.0) -> list[SearchHit]:
        if not self._items or not text.strip():
            return []
        query = self.embedder.embed([text])[0]
        scores = self._matrix @ query
        order = np.argsort(-scores)[:k]
        hits = []
        for idx in order:
            score = float(scores[idx])
            if score < min_score:
                continue
            item = self._items[idx]
            hits.append(
                SearchHit(
                    id=item.id,
                    score=round(score, 4),
                    title=item.title,
                    url=item.url,
                    source=item.source,
                    snippet=item.text[:SNIPPET_LEN],
                    payload=item.payload,
                )
            )
        return hits


def build_knowledge_index(
    jira: JiraReader,
    confluence: ConfluenceReader,
    embedder: Embedder,
    documents: DocumentSource | None = None,
) -> VectorIndex:
    index = VectorIndex(embedder)
    items = [
        IndexItem(
            id=i.key,
            text=f"{i.summary}. {i.description}",
            title=f"{i.key}: {i.summary}",
            url=i.url,
            source="jira",
            payload={"status": i.status, "stream": i.stream, "epic": i.epic},
        )
        for i in jira.search_issues()
    ]
    items += [
        IndexItem(
            id=p.id,
            text=f"{p.title}. {p.body}",
            title=p.title,
            url=p.url,
            source="confluence",
            payload={"space": p.space},
        )
        for p in confluence.pages()
    ]
    items += [
        IndexItem(id=d.id, text=f"{d.title}. {d.body}", title=d.title, url=d.url, source=d.kind, payload={})
        for d in (documents.documents() if documents else [])
    ]
    index.add(items)
    return index
