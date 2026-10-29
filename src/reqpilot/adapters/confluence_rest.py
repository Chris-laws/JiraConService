"""Confluence-REST-Adapter (Server/Data Center, PAT als Bearer)."""

from __future__ import annotations

import html
import re

import requests

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.adapters.http import request_json
from reqpilot.models import Page

_TAG = re.compile(r"<[^>]+>")


def strip_html(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(_TAG.sub(" ", value))).strip()


class ConfluenceRest:
    def __init__(
        self,
        base_url: str,
        pat: str | None,
        timeout: float,
        spaces: tuple[str, ...] = ("ADF",),
        limit: int = 200,
        session: requests.Session | None = None,
    ):
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {pat}", "Accept": "application/json"} if pat else {}
        self._timeout = timeout
        self._spaces = spaces
        self._limit = limit
        self._session = session or requests.Session()

    def pages(self) -> list[Page]:
        result: list[Page] = []
        for space in self._spaces:
            data = request_json(
                self._session,
                "GET",
                f"{self._base}/rest/api/content",
                timeout=self._timeout,
                headers=self._headers,
                params={"spaceKey": space, "type": "page", "limit": self._limit, "expand": "body.storage"},
            )
            try:
                result += [
                    Page(
                        id=str(r["id"]),
                        title=r["title"],
                        body=strip_html(r["body"]["storage"]["value"]),
                        space=space,
                        url=f"{self._base}{r['_links']['webui']}",
                    )
                    for r in data["results"]
                ]
            except (KeyError, TypeError) as exc:
                raise SourceUnavailable(f"Confluence-Antwort unerwartet: {exc}") from exc
        return result
