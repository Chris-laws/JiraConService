"""ServiceNow-Table-API: Bugs (Incidents) und Changes (Patches/Deployments)."""

from __future__ import annotations

from datetime import datetime

import requests

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.adapters.http import request_json
from reqpilot.models import Bug, Change


def _dt(value: str) -> datetime:
    return datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S")


def _display(value) -> str:
    if isinstance(value, dict):
        return str(value.get("display_value", ""))
    return str(value or "")


class ServiceNowRest:
    def __init__(
        self,
        base_url: str,
        token: str | None,
        timeout: float,
        bug_table: str = "incident",
        bug_query: str = "active=true^ORDERBYDESCopened_at",
        change_query: str = "state=3^ORDERBYDESCclosed_at",
        limit: int = 200,
        session: requests.Session | None = None,
    ):
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"} if token else {}
        self._timeout = timeout
        self._bug_table = bug_table
        self._bug_query = bug_query
        self._change_query = change_query
        self._limit = limit
        self._session = session or requests.Session()

    def _table(self, table: str, query: str) -> list[dict]:
        data = request_json(
            self._session,
            "GET",
            f"{self._base}/api/now/table/{table}",
            timeout=self._timeout,
            headers=self._headers,
            params={"sysparm_query": query, "sysparm_limit": self._limit, "sysparm_display_value": "all"},
        )
        try:
            return list(data["result"])
        except (KeyError, TypeError) as exc:
            raise SourceUnavailable(f"ServiceNow-Antwort unerwartet: {exc}") from exc

    def _to_bug(self, r: dict) -> Bug:
        number = _display(r["number"])
        return Bug(
            number=number,
            short_description=_display(r.get("short_description")),
            description=_display(r.get("description")),
            component=_display(r.get("cmdb_ci")).lower(),
            first_seen=_dt(_display(r.get("opened_at"))),
            url=f"{self._base}/nav_to.do?uri={self._bug_table}.do?sysparm_query=number={number}",
            priority=_display(r.get("priority")),
            caller=_display(r.get("caller_id")),
        )

    def bugs(self) -> list[Bug]:
        try:
            return [self._to_bug(r) for r in self._table(self._bug_table, self._bug_query)]
        except (KeyError, ValueError) as exc:
            raise SourceUnavailable(f"ServiceNow-Bug unvollständig: {exc}") from exc

    def bug(self, number: str) -> Bug:
        safe = "".join(ch for ch in number if ch.isalnum())
        rows = self._table(self._bug_table, f"number={safe}")
        if not rows:
            raise KeyError(number)
        return self._to_bug(rows[0])

    def changes(self) -> list[Change]:
        try:
            return [
                Change(
                    id=_display(r["number"]),
                    title=_display(r.get("short_description")),
                    description=_display(r.get("description")),
                    author=_display(r.get("assigned_to")),
                    deployed_at=_dt(_display(r.get("closed_at") or r.get("end_date"))),
                    components=tuple(c for c in [_display(r.get("cmdb_ci")).lower()] if c),
                    url=f"{self._base}/nav_to.do?uri=change_request.do?sysparm_query=number={_display(r['number'])}",
                    release=_display(r.get("u_release")),
                )
                for r in self._table("change_request", self._change_query)
            ]
        except (KeyError, ValueError) as exc:
            raise SourceUnavailable(f"ServiceNow-Change unvollständig: {exc}") from exc
