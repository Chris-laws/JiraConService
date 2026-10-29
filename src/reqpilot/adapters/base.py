"""Protokolle für alle externen Systeme. Services kennen nur diese Schnittstellen."""

from __future__ import annotations

from typing import Protocol

from reqpilot.models import Bug, Change, Issue, Page


class JiraReader(Protocol):
    def search_issues(self) -> list[Issue]: ...
    def issues_by_reporter(self, email: str) -> list[Issue]: ...


class JiraWriter(Protocol):
    enabled: bool

    def create_issue(self, fields: dict) -> str: ...


class ConfluenceReader(Protocol):
    def pages(self) -> list[Page]: ...


class ServiceNowReader(Protocol):
    def bugs(self) -> list[Bug]: ...
    def bug(self, number: str) -> Bug: ...


class ChangeSource(Protocol):
    def changes(self) -> list[Change]: ...


class Llm(Protocol):
    available: bool

    def generate(self, prompt: str, *, json_mode: bool = False) -> str: ...
