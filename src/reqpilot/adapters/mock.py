"""Mock-Adapter auf Basis der JSON-Fixtures. Damit läuft alles ohne Firmennetz."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from reqpilot.adapters.errors import WriteDisabled
from reqpilot.models import Bug, Change, Issue, Page

MOCK_JIRA_URL = "https://jira.example.com"
MOCK_CONFLUENCE_URL = "https://confluence.example.com"
MOCK_SERVICENOW_URL = "https://servicenow.example.com"


def _load(directory: Path, name: str) -> list[dict]:
    return json.loads((directory / name).read_text(encoding="utf-8"))


class MockJira:
    def __init__(self, fixtures: Path):
        self._issues = [
            Issue(
                key=r["key"],
                summary=r["summary"],
                description=r["description"],
                status=r["status"],
                reporter=r["reporter"],
                updated=datetime.fromisoformat(r["updated"]),
                url=f"{MOCK_JIRA_URL}/browse/{r['key']}",
                stream=r.get("stream"),
                epic=r.get("epic"),
            )
            for r in _load(fixtures, "jira_issues.json")
        ]

    def search_issues(self) -> list[Issue]:
        return list(self._issues)

    def issues_by_reporter(self, email: str) -> list[Issue]:
        email = email.strip().lower()
        return [i for i in self._issues if i.reporter.lower() == email]

    def reporters(self) -> list[str]:
        return sorted({i.reporter for i in self._issues})


class MockJiraWriter:
    """Merkt sich angelegte Tickets nur im Speicher. Standardmäßig abgeschaltet."""

    def __init__(self, enabled: bool = False):
        self.enabled = enabled
        self.created: list[dict] = []

    def create_issue(self, fields: dict) -> str:
        if not self.enabled:
            raise WriteDisabled("Schreiben nach Jira ist im Prototyp abgeschaltet")
        self.created.append(fields)
        return f"MOCK-{len(self.created)}"


class MockConfluence:
    def __init__(self, fixtures: Path):
        self._pages = [
            Page(
                id=r["id"],
                title=r["title"],
                body=r["body"],
                space=r["space"],
                url=f"{MOCK_CONFLUENCE_URL}/pages/{r['id']}",
            )
            for r in _load(fixtures, "confluence_pages.json")
        ]

    def pages(self) -> list[Page]:
        return list(self._pages)


class MockServiceNow:
    def __init__(self, fixtures: Path):
        self._bugs = {
            r["number"]: Bug(
                number=r["number"],
                short_description=r["short_description"],
                description=r["description"],
                component=r["component"],
                first_seen=datetime.fromisoformat(r["first_seen"]),
                url=f"{MOCK_SERVICENOW_URL}/incident/{r['number']}",
                priority=r.get("priority", ""),
                caller=r.get("caller", ""),
            )
            for r in _load(fixtures, "servicenow_bugs.json")
        }

    def bugs(self) -> list[Bug]:
        return list(self._bugs.values())

    def bug(self, number: str) -> Bug:
        return self._bugs[number]


class MockChangeSource:
    def __init__(self, fixtures: Path):
        self._changes = [
            Change(
                id=r["id"],
                title=r["title"],
                description=r["description"],
                author=r["author"],
                deployed_at=datetime.fromisoformat(r["deployed_at"]),
                components=tuple(r["components"]),
                url=f"{MOCK_SERVICENOW_URL}/change/{r['id']}",
                release=r.get("release", ""),
            )
            for r in _load(fixtures, "changes.json")
        ]

    def changes(self) -> list[Change]:
        return list(self._changes)
