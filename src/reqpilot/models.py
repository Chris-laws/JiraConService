"""Fachliche Datentypen, unabhängig von Jira/Confluence/ServiceNow."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class Epic:
    key: str
    title: str


@dataclass(frozen=True)
class Stream:
    id: str
    name: str
    description: str
    keywords: tuple[str, ...] = ()
    board: str = ""
    epics: tuple[Epic, ...] = ()
    enabled: bool = True

    def profile_text(self) -> str:
        """Text, gegen den Tickets für die Stream-Zuordnung verglichen werden."""
        parts = [self.name, self.description, " ".join(self.keywords)]
        parts += [e.title for e in self.epics]
        return " ".join(parts)


@dataclass(frozen=True)
class Issue:
    key: str
    summary: str
    description: str
    status: str
    reporter: str
    updated: datetime
    url: str
    stream: str | None = None
    epic: str | None = None
    issue_type: str = "Story"


@dataclass(frozen=True)
class Page:
    id: str
    title: str
    body: str
    space: str
    url: str


@dataclass(frozen=True)
class Bug:
    number: str
    short_description: str
    description: str
    component: str
    first_seen: datetime
    url: str
    priority: str = ""
    caller: str = ""  # personenbezogen: geht nie an das LLM


@dataclass(frozen=True)
class Change:
    id: str
    title: str
    description: str
    author: str
    deployed_at: datetime
    components: tuple[str, ...]
    url: str
    release: str = ""


@dataclass(frozen=True)
class SearchHit:
    id: str
    score: float
    title: str
    url: str
    source: str  # "jira" | "confluence"
    snippet: str = ""
    payload: dict = field(default_factory=dict, compare=False)
