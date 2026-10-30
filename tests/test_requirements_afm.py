"""Anforderungen zur KI-Unterstützung: Rollen, Priorität, weitere Wissensquellen, Jira-Felder mit Autor."""

from pathlib import Path

import pytest

from reqpilot.adapters.documents import LocalDocuments
from reqpilot.config import load_settings
from reqpilot.container import build_container
from reqpilot.services.jira_payload import OneStreamOnly, issue_fields
from reqpilot.services.priority import PriorityAdvisor
from reqpilot.services.ticket_writer import TicketDraft
from reqpilot.streams import load_app_config

ROOT = Path(__file__).resolve().parents[1]
CFG = load_app_config(ROOT / "config" / "settings.yaml")
PRIOS = ["Blocker", "High", "Medium", "Low"]


def test_roles_from_settings():
    assert CFG.role_for("Anna.Berger@example.com") == "INT"
    assert CFG.role_for("someone@example.com") == "Land"
    assert CFG.role_for(None) == "Land"
    assert CFG.may_create_epic("INT")
    assert not CFG.may_create_epic("Land")


def test_unknown_default_role_rejected(tmp_path):
    text = (
        (ROOT / "config" / "settings.yaml")
        .read_text(encoding="utf-8")
        .replace("default_role: Land", "default_role: Chef")
    )
    p = tmp_path / "settings.yaml"
    p.write_text(text, encoding="utf-8")
    with pytest.raises(ValueError, match="default_role"):
        load_app_config(p)


@pytest.mark.parametrize(
    ("text", "chosen", "expected", "agrees"),
    [
        ("Die Filiale kann nicht arbeiten, keine Umgehung möglich.", "Blocker", "Blocker", True),
        ("Kasse blockiert, aber manuell geht es übergangsweise.", "Blocker", "High", False),
        ("Falsche Menge im Bestellvorschlag vor dem Aktionsstart.", "Medium", "High", False),
        ("Die Darstellung der Liste wäre schön kompakter.", "Medium", "Low", False),
        ("Neues Feld für den Lieferantenkontakt im Stamm.", "Medium", "Medium", True),
    ],
)
def test_priority_advice(text, chosen, expected, agrees):
    advice = PriorityAdvisor(PRIOS).assess(text, chosen)
    assert advice.recommended == expected
    assert advice.agrees is agrees
    assert advice.reasons


def test_blocker_without_stoppage_gets_explanation():
    advice = PriorityAdvisor(PRIOS).assess("Neues Feld im Bericht.", "Blocker")
    assert any("Blocker nur" in r for r in advice.reasons)


def test_local_documents_read_front_matter(tmp_path):
    (tmp_path / "a.md").write_text("---\ntitle: Release 1\nkind: changelog\nurl: https://x/1\n---\nText", "utf-8")
    (tmp_path / "b.md").write_text("Nur Text ohne Kopf", "utf-8")
    (tmp_path / "c.md").write_text("---\nkind: unbekannt\n---\nX", "utf-8")
    docs = {d.id: d for d in LocalDocuments(tmp_path).documents()}
    assert docs["a"].title == "Release 1" and docs["a"].kind == "changelog" and docs["a"].url == "https://x/1"
    assert docs["a"].body == "Text"
    assert docs["b"].kind == "guide" and docs["b"].title == "b"
    assert docs["c"].kind == "guide"
    assert LocalDocuments(tmp_path / "fehlt").documents() == []


def test_knowledge_index_contains_changelog_guide_training():
    c = build_container(load_settings({}))
    sources = {item.source for item in c.index._items}
    assert {"changelog", "guide", "training", "jira", "confluence"} <= sources
    hits = c.index.search("Teillieferung im Wareneingang Schulung", k=5)
    assert any(h.source == "training" for h in hits)


def _draft(**kw):
    base = dict(
        title="Feiertage im Bestellvorschlag",
        role="Disponent",
        goal="Feiertage berücksichtigen",
        benefit="keine Überbestände",
        acceptance_criteria=["Feiertagskalender je Land"],
        background="Regionale Feiertage fehlen.",
        priority="High",
        country="AT",
    )
    return TicketDraft(**{**base, **kw})


def test_issue_fields_carry_author_stream_epic():
    fields = issue_fields(
        _draft(),
        project="ADF",
        reporter="anna.berger@example.com",
        stream_id="disposition",
        stream_name="Disposition",
        epic_key="ADF-100",
        epic_link_field="customfield_10008",
    )
    assert fields["reporter"] == {"name": "anna.berger@example.com"}
    assert fields["project"] == {"key": "ADF"} and fields["priority"] == {"name": "High"}
    assert fields["customfield_10008"] == "ADF-100"
    assert "stream-disposition" in fields["labels"] and "land-at" in fields["labels"]
    assert "Stream: Disposition" in fields["description"]


@pytest.mark.parametrize(("stream_id", "multi"), [(None, False), ("disposition", True)])
def test_issue_fields_need_exactly_one_stream(stream_id, multi):
    with pytest.raises(OneStreamOnly):
        issue_fields(
            _draft(),
            project="ADF",
            reporter=None,
            stream_id=stream_id,
            stream_name=None,
            epic_key=None,
            epic_link_field="cf",
            multi_stream=multi,
        )
