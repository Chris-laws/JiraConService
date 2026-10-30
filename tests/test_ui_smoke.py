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
    assert at.sidebar.caption[0].value == "Pilot ADF · Anforderungen im Standard"


@pytest.mark.parametrize("name", ["dashboard", "ticket", "my_tickets", "knowledge", "rca"])
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


def test_ticket_shows_recent_tickets_before_submit():
    at = _page("ticket").run()
    assert 1 <= sum("/browse/ADF-" in m.value for m in at.markdown) <= 8
    assert not at.code


def test_rca_lists_changes_before_analysis():
    at = _page("rca").run()
    assert not at.subheader
    assert any("zeitlicher Nähe" in c.value for c in at.caption)
    assert sum(m.value.startswith("[CHG") for m in at.markdown) == 6


def test_knowledge_suggestion_is_asked_once():
    at = _page("knowledge").run()
    at.button_group[0].set_value("knowledge.suggest_1").run()
    assert not at.exception
    assert len(at.chat_message) == 2
    at.run()
    assert len(at.chat_message) == 2


MINDESTBESTAND = (
    "Als Disponent möchte ich den Mindestbestand für Aktionsartikel überschreiben, damit die Filiale "
    "zum Aktionsstart genug Ware hat. Die Änderung muss nach Aktionsende zurückgesetzt werden."
)


def test_dashboard_shows_lifecycle_line_and_scroll_widgets():
    at = _page("dashboard").run()
    assert not at.exception
    assert [m.label for m in at.metric][0] == "Offen im Pilot"
    stations = [c.value for c in at.caption if c.value in {"Neu", "Prüfung INT", "Backlog", "Erledigt"}]
    assert len(stations) == 4
    assert sum(c.value == "Engpass" for c in at.caption) == 1
    assert any(m.value.startswith("[INC") for m in at.markdown)
    assert any("Schulung Wareneingang" in m.value for m in at.markdown)


def _drafted(role: str | None = None) -> AppTest:
    at = _page("ticket")
    if role:
        at.session_state["sb_role"] = role
    at.run()
    at.text_area[0].input(MINDESTBESTAND)
    at.button[0].click().run()
    assert not at.exception
    return at


def test_template_form_is_prefilled_and_feeds_markup():
    at = _drafted()
    assert at.text_input(key="f_role").value == "Disponent"
    assert at.selectbox(key="f_stream").value == "disposition"
    at.text_input(key="f_title").input("Mindestbestand für Aktionsware übersteuern").run()
    assert "h2. Mindestbestand für Aktionsware übersteuern" in at.code[0].value
    assert "Autor in Jira" in " ".join(m.value for m in at.markdown)


def test_priority_check_questions_a_blocker():
    at = _drafted()
    at.selectbox(key="f_priority").select("Blocker").run()
    assert any("Ist das wirklich Blocker" in w.value for w in at.warning)


def test_only_int_may_propose_new_epic():
    assert "Neues Epic vorschlagen" in _drafted("INT").selectbox(key="f_epic").options
    land = _drafted("Land")
    assert "Neues Epic vorschlagen" not in land.selectbox(key="f_epic").options
    assert any("Neue Epics legt INT an" in c.value for c in land.caption)
