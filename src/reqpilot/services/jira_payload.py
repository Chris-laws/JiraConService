"""Baut aus der ausgefüllten Vorgabemaske die Felder für POST /rest/api/2/issue.

Der Autor (reporter) ist die angemeldete Person, nicht das technische Konto hinter dem PAT. Jira Server/Data
Center erwartet dafür den Benutzernamen; solange dafür keine Zuordnung existiert, wird die E-Mail aus dem
Databricks-Login verwendet. Geschrieben wird nur, wenn REQPILOT_JIRA_WRITE_ENABLED gesetzt ist.
"""

from __future__ import annotations

from reqpilot.services.ticket_writer import TicketDraft, to_jira_markup


class OneStreamOnly(ValueError):
    """Ein Ticket darf genau einem Stream gehören."""


def issue_fields(
    draft: TicketDraft,
    *,
    project: str,
    reporter: str | None,
    stream_id: str | None,
    stream_name: str | None,
    epic_key: str | None,
    epic_link_field: str,
    multi_stream: bool = False,
) -> dict:
    if multi_stream:
        raise OneStreamOnly("Das Ticket betrifft mehrere Streams. Bitte aufteilen, je Stream ein Ticket.")
    if not stream_id:
        raise OneStreamOnly("Bitte genau einen Stream wählen.")
    fields: dict = {
        "project": {"key": project},
        "issuetype": {"name": "Story"},
        "summary": draft.title,
        "description": to_jira_markup(draft, stream_name=stream_name, epic_key=epic_key),
        "priority": {"name": draft.priority},
        "labels": [f"land-{draft.country.lower()}", f"stream-{stream_id}"],
    }
    if reporter:
        fields["reporter"] = {"name": reporter}
    if epic_key:
        fields[epic_link_field] = epic_key
    return fields
