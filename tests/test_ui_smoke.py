from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[1]
PAGES = ROOT / "src" / "reqpilot" / "ui" / "pages"


def _page(name: str) -> AppTest:
    return AppTest.from_file(str(PAGES / f"{name}.py"), default_timeout=30)


def test_app_entry_renders():
    at = AppTest.from_file(str(ROOT / "app.py"), default_timeout=30).run()
    assert not at.exception
    assert at.sidebar.caption[0].value == "Einheitliche Anforderungen, weniger Doppelarbeit"


@pytest.mark.parametrize("name", ["ticket", "my_tickets", "knowledge", "rca"])
def test_each_page_renders(name):
    at = _page(name).run()
    assert not at.exception
    assert at.title


def test_ticket_flow_produces_markup_and_disabled_jira_button():
    at = _page("ticket").run()
    at.text_area[0].input(
        "Als Disponent möchte ich den Mindestbestand für Aktionsartikel überschreiben, damit die Filiale "
        "genug Ware hat. Die Änderung muss nach Aktionsende zurückgesetzt werden."
    )
    at.button[0].click().run()
    assert not at.exception
    assert "h3. User Story" in at.code[0].value
    create = next(b for b in at.button if b.label == "In Jira anlegen")
    assert create.disabled


def test_multi_stream_warning_shown():
    at = _page("ticket").run()
    at.text_area[0].input(
        "Bei Lieferantenwechsel soll die Gebindegröße im Artikelstamm aktualisiert werden. "
        "Der Bestellvorschlag soll die neue Gebindegröße bei der Bestellmenge nutzen."
    )
    at.button[0].click().run()
    assert any("mehrere Streams" in w.value for w in at.warning)


def test_rca_flow_shows_top_cause():
    at = _page("rca").run()
    at.button[0].click().run()
    assert not at.exception
    assert any("CHG0030110" in m.value for m in at.markdown)
    assert at.subheader[0].value.startswith("Rundungslogik")


def test_knowledge_chat_answers_with_sources():
    at = _page("knowledge").run()
    at.chat_input[0].set_value("Werden regionale Feiertage im Bestellvorschlag berücksichtigt?").run()
    assert not at.exception
    assert len(at.chat_message) == 2
    assert any("[1]" in cap.value for cap in at.caption)


def test_ticket_example_fills_input():
    at = _page("ticket").run()
    at.button_group[0].set_value("ticket.example_2").run()
    assert "Gebindegröße" in at.text_area[0].value


def test_my_tickets_filter_narrows_table():
    at = _page("my_tickets").run()
    full = len(at.dataframe[0].value)
    at.button_group[0].set_value("open").run()
    assert not at.exception
    assert len(at.dataframe[0].value) <= full


def test_split_proposal_does_not_repeat_text():
    at = _page("ticket").run()
    at.text_area[0].input(
        "Bei Lieferantenwechsel soll die Gebindegröße im Artikelstamm aktualisiert werden. "
        "Der Bestellvorschlag soll die neue Gebindegröße bei der Bestellmenge nutzen."
    )
    at.button[0].click().run()
    parts = [m.value for m in at.markdown if m.value.startswith("- **Stammdaten")]
    assert parts and parts[0].count("aktualisiert werden") == 1


def test_rca_page_survives_unreachable_index(monkeypatch):
    from reqpilot.adapters.errors import SourceUnavailable
    from reqpilot.adapters.mock import MockConfluence

    def down(self):
        raise SourceUnavailable("Confluence weg")

    monkeypatch.setattr(MockConfluence, "pages", down)
    from reqpilot.ui.state import get_container

    get_container.clear()
    try:
        at = _page("rca").run()
        at.button[0].click().run()
        assert not at.exception
        assert at.error
    finally:
        get_container.clear()
