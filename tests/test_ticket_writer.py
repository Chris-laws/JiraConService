import json

import pytest

from reqpilot.adapters.errors import LlmUnavailable
from reqpilot.adapters.offline_llm import OfflineLlm
from reqpilot.services.ticket_writer import TicketDraft, TicketWriter, to_jira_markup

PRIOS = ["Blocker", "High", "Medium", "Low"]


class StubLlm:
    available = True

    def __init__(self, answer=None, exc=None):
        self.answer, self.exc, self.prompts = answer, exc, []

    def generate(self, prompt, *, json_mode=False):
        self.prompts.append(prompt)
        if self.exc:
            raise self.exc
        return self.answer


def writer(llm=None):
    return TicketWriter(llm or OfflineLlm(), PRIOS, "Medium")


def test_offline_draft_extracts_user_story_parts():
    d = writer().draft(
        "Als Disponent möchte ich den Mindestbestand für Aktionsartikel überschreiben, damit die Filiale "
        "zum Aktionsstart genug Ware hat. Die Änderung muss nach Aktionsende automatisch zurückgesetzt werden.",
        "DE",
    )
    assert d.role == "Disponent"
    assert "Mindestbestand" in d.goal
    assert "Aktionsstart" in d.benefit
    assert any("zurückgesetzt" in c for c in d.acceptance_criteria)
    assert d.priority == "Medium"
    assert d.country == "DE"
    assert d.source == "offline"


@pytest.mark.parametrize("text", ["", "   ", "Bitte fixen"])
def test_short_or_empty_text_asks_instead_of_inventing(text):
    d = writer().draft(text, "AT")
    assert d.open_questions
    assert d.acceptance_criteria == []
    assert d.title


def test_missing_benefit_and_criteria_become_open_questions():
    d = writer().draft("Im Bericht für Bestandsreichweite fehlt die Spalte für die Warengruppe je Land.", "PL")
    joined = " ".join(d.open_questions)
    assert "Nutzen" in joined
    assert "Akzeptanzkriterien" in joined


def test_priority_keywords():
    assert (
        writer().draft("Blocker: Filialen können nicht bestellen, alles blockiert, sofort lösen", "DE").priority
        == "Blocker"
    )
    assert writer().draft("Dringend: der Export bricht ab und muss heute laufen", "DE").priority == "High"


def test_gemini_answer_is_used_and_validated():
    answer = json.dumps(
        {
            "title": "Mindestbestand für Aktionsartikel",
            "role": "Disponent",
            "goal": "Mindestbestand überschreiben",
            "benefit": "genug Ware zum Aktionsstart",
            "acceptance_criteria": ["Überschreiben möglich", "Automatisches Zurücksetzen"],
            "background": "Aktionen",
            "priority": "High",
            "open_questions": [],
        }
    )
    d = writer(StubLlm(answer)).draft("Mindestbestand für Aktionsartikel temporär überschreiben können", "DE")
    assert d.source == "gemini"
    assert d.priority == "High"
    assert d.acceptance_criteria == ["Überschreiben möglich", "Automatisches Zurücksetzen"]


def test_invalid_priority_from_llm_falls_back_to_default():
    answer = json.dumps({"title": "T", "goal": "G", "priority": "Super", "acceptance_criteria": "nicht-liste"})
    d = writer(StubLlm(answer)).draft("Etwas längerer Text über eine Anforderung im Wareneingang", "DE")
    assert d.priority == "Medium"
    assert d.acceptance_criteria == []


@pytest.mark.parametrize("llm", [StubLlm("kein json {"), StubLlm(json.dumps([1, 2])), StubLlm(exc=LlmUnavailable("x"))])
def test_broken_llm_answer_falls_back_to_offline_with_notice(llm):
    d = writer(llm).draft("Als Disponent möchte ich Bestellvorschläge prüfen, damit Fehler auffallen.", "DE")
    assert d.source == "offline"
    assert d.notice
    assert d.role == "Disponent"


def test_prompt_is_redacted():
    llm = StubLlm(json.dumps({"title": "T", "goal": "G"}))
    writer(llm).draft("Rückfragen an petra.klein@example.com wegen Bestellvorschlag in der Filiale", "DE")
    assert "petra.klein" not in llm.prompts[0]


def test_jira_markup_contains_sections():
    d = TicketDraft(
        title="Titel",
        role="Disponent",
        goal="Ziel",
        benefit="Nutzen",
        acceptance_criteria=["A", "B"],
        background="Hintergrund",
        priority="High",
        country="DE",
    )
    md = to_jira_markup(d, stream_name="Logistik", epic_key="ADF-200")
    assert "h3. User Story" in md
    assert "*Als* Disponent *möchte ich* Ziel, *damit* Nutzen." in md
    assert "* A\n* B" in md
    assert "Epic: ADF-200" in md
    assert "Priorität: High" in md


def test_long_first_sentence_is_truncated_to_80_chars():
    text = "Wort " * 30 + "Ende."
    title = writer().draft(text, "DE").title
    assert len(title) == 80
    assert title.endswith("…")


def test_title_of_exactly_80_chars_is_kept():
    sentence = ("a" * 9 + " ") * 7 + "b" * 9  # 79 Zeichen
    sentence += "c"  # 80
    assert writer().draft(sentence + ". Noch mehr Text dazu hier.", "DE").title == sentence
