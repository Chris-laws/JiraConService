"""Eigene Tickets aus Jira (nur Lesezugriff) mit Phase im Lebenszyklus."""

from __future__ import annotations

from dataclasses import dataclass

from reqpilot.adapters.base import JiraReader
from reqpilot.models import Issue

TERMINAL_OFF_PATH = {"REJECTED"}


@dataclass(frozen=True)
class TicketStatus:
    issue: Issue
    phase: int | None  # 1-basiert; None = außerhalb des Standardpfads (z. B. REJECTED)
    phase_total: int


class MyTickets:
    def __init__(self, jira: JiraReader, lifecycle: list[str]):
        self._jira = jira
        self._path = [s for s in lifecycle if s not in TERMINAL_OFF_PATH]

    def _phase(self, status: str) -> int | None:
        status = status.upper()
        return self._path.index(status) + 1 if status in self._path else None

    def for_user(self, email: str) -> list[TicketStatus]:
        if not email.strip():
            return []
        issues = sorted(self._jira.issues_by_reporter(email), key=lambda i: i.updated, reverse=True)
        return [TicketStatus(i, self._phase(i.status), len(self._path)) for i in issues]
