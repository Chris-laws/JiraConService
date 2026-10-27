"""Gemeinsamer HTTP-Aufruf: immer mit Timeout, Fehler werden zu SourceUnavailable."""

from __future__ import annotations

from typing import Any

import requests

from lidlalign.adapters.errors import SourceUnavailable


def request_json(
    session: requests.Session,
    method: str,
    url: str,
    *,
    timeout: float,
    headers: dict | None = None,
    params: dict | None = None,
    json: Any = None,
    error: type[Exception] = SourceUnavailable,
) -> Any:
    try:
        resp = session.request(method, url, headers=headers, params=params, json=json, timeout=timeout)
    except requests.RequestException as exc:
        raise error(f"{method} {_host(url)} fehlgeschlagen: {type(exc).__name__}") from exc
    if not resp.ok:
        raise error(f"{method} {_host(url)} antwortete mit HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError as exc:
        raise error(f"{method} {_host(url)} lieferte kein JSON") from exc


def _host(url: str) -> str:
    # Nur Host/Pfad melden, nie Query-Parameter (könnten Tokens enthalten)
    return url.split("?", 1)[0]
