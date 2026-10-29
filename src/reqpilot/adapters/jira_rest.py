"""Jira-REST-Adapter (Server/Data Center, PAT als Bearer). Lesen aktiv, Schreiben per Schalter."""

from __future__ import annotations

from datetime import datetime

import requests

from reqpilot.adapters.errors import SourceUnavailable, WriteDisabled
from reqpilot.adapters.http import request_json
from reqpilot.models import Issue

_FIELDS = "summary,description,status,reporter,updated,components,issuetype,customfield_epic"


def _parse_time(value: str) -> datetime:
    # Jira liefert z. B. 2026-10-01T10:00:00.000+0200
    return datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")


class JiraRestReader:
    def __init__(
        self,
        base_url: str,
        pat: str | None,
        timeout: float,
        jql: str = "project = ADF ORDER BY updated DESC",
        max_results: int = 500,
        session: requests.Session | None = None,
    ):
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {pat}", "Accept": "application/json"} if pat else {}
        self._timeout = timeout
        self._jql = jql
        self._max = max_results
        self._session = session or requests.Session()

    def _search(self, jql: str) -> list[Issue]:
        data = request_json(
            self._session,
            "GET",
            f"{self._base}/rest/api/2/search",
            timeout=self._timeout,
            headers=self._headers,
            params={"jql": jql, "maxResults": self._max, "fields": _FIELDS},
        )
        try:
            return [self._to_issue(raw) for raw in data["issues"]]
        except (KeyError, TypeError, ValueError) as exc:
            raise SourceUnavailable(f"Jira-Antwort unerwartet: {exc}") from exc

    def _to_issue(self, raw: dict) -> Issue:
        f = raw["fields"]
        components = f.get("components") or []
        return Issue(
            key=raw["key"],
            summary=f.get("summary") or "",
            description=f.get("description") or "",
            status=(f.get("status") or {}).get("name", ""),
            reporter=(f.get("reporter") or {}).get("emailAddress", ""),
            updated=_parse_time(f["updated"]),
            url=f"{self._base}/browse/{raw['key']}",
            stream=components[0]["name"].lower() if components else None,
            epic=f.get("customfield_epic"),
            issue_type=(f.get("issuetype") or {}).get("name", "Story"),
        )

    def search_issues(self) -> list[Issue]:
        return self._search(self._jql)

    def issues_by_reporter(self, email: str) -> list[Issue]:
        safe = email.replace('"', "")
        return self._search(f'reporter = "{safe}" ORDER BY updated DESC')


class JiraRestWriter:
    def __init__(
        self,
        base_url: str,
        pat: str | None,
        timeout: float,
        enabled: bool = False,
        session: requests.Session | None = None,
    ):
        self.enabled = enabled
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {pat}", "Content-Type": "application/json"}
        self._timeout = timeout
        self._session = session or requests.Session()

    def create_issue(self, fields: dict) -> str:
        if not self.enabled:
            raise WriteDisabled("Schreiben nach Jira ist im Prototyp abgeschaltet")
        data = request_json(
            self._session,
            "POST",
            f"{self._base}/rest/api/2/issue",
            timeout=self._timeout,
            headers=self._headers,
            json={"fields": fields},
        )
        return str(data["key"])
