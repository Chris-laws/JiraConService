"""Seiten-Registry: jede Seite mit Rolle. Der Guard prüft, dass keine Seite fehlt."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PageSpec:
    module: str  # Datei unter ui/pages ohne .py
    title_key: str
    icon: str
    roles: tuple[str, ...]


# Rolle "user" = jede Person mit Zugriff auf die Databricks-App.
PAGES: tuple[PageSpec, ...] = (
    PageSpec("ticket", "nav.ticket", ":material/edit_note:", ("user",)),
    PageSpec("my_tickets", "nav.my_tickets", ":material/assignment_ind:", ("user",)),
    PageSpec("knowledge", "nav.knowledge", ":material/travel_explore:", ("user",)),
    PageSpec("rca", "nav.rca", ":material/bug_report:", ("user",)),
)
