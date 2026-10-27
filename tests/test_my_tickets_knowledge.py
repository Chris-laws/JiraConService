from pathlib import Path

import pytest

from lidlalign.adapters.errors import LlmUnavailable
from lidlalign.adapters.mock import MockConfluence, MockJira
from lidlalign.adapters.offline_llm import OfflineLlm
from lidlalign.index.embedder import HashingEmbedder
from lidlalign.index.vector_index import build_knowledge_index
from lidlalign.services.knowledge import NO_SOURCE, KnowledgeService
from lidlalign.services.my_tickets import MyTickets
from lidlalign.streams import load_app_config

ROOT = Path(__file__).resolve().parents[1]
CFG = load_app_config(ROOT / "config" / "settings.yaml")
FIX = ROOT / "fixtures"


@pytest.fixture(scope="module")
def index():
    return build_knowledge_index(MockJira(FIX), MockConfluence(FIX), HashingEmbedder())


def test_only_own_tickets_sorted_newest_first():
    rows = MyTickets(MockJira(FIX), CFG.lifecycle).for_user("Anna.Berger@example.com")
    assert len(rows) == 4
    assert all(r.issue.reporter == "anna.berger@example.com" for r in rows)
    assert [r.issue.updated for r in rows] == sorted((r.issue.updated for r in rows), reverse=True)


def test_phase_from_lifecycle():
    rows = {r.issue.key: r for r in MyTickets(MockJira(FIX), CFG.lifecycle).for_user("anna.berger@example.com")}
    assert rows["ADF-1015"].phase == 2
    assert rows["ADF-1040"].phase == CFG.lifecycle.index("READY FOR DEPLOYMENT") + 1
    rejected = MyTickets(MockJira(FIX), CFG.lifecycle).for_user("lukas.schmidt@example.com")
    assert next(r for r in rejected if r.issue.key == "ADF-1047").phase is None


def test_unknown_or_empty_user_has_no_tickets():
    assert MyTickets(MockJira(FIX), CFG.lifecycle).for_user("") == []
    assert MyTickets(MockJira(FIX), CFG.lifecycle).for_user("niemand@example.com") == []


def test_offline_answer_is_extractive_with_sources(index):
    ans = KnowledgeService(index, OfflineLlm(), CFG.thresholds("hashing")).ask(
        "Werden regionale Feiertage im Bestellvorschlag berücksichtigt?"
    )
    assert ans.sources
    assert ans.source == "offline"
    assert "Feiertag" in ans.text


def test_no_matching_source(index):
    ans = KnowledgeService(index, OfflineLlm(), CFG.thresholds("hashing")).ask("Wie ist das Wetter in Rom?")
    assert ans.sources == []
    assert ans.text == NO_SOURCE


class StubLlm:
    available = True

    def __init__(self, answer=None, exc=None):
        self.answer, self.exc, self.prompts = answer, exc, []

    def generate(self, prompt, *, json_mode=False):
        self.prompts.append(prompt)
        if self.exc:
            raise self.exc
        return self.answer


def test_llm_answer_uses_numbered_sources(index):
    llm = StubLlm("Nein, regionale Feiertage fehlen noch [1].")
    ans = KnowledgeService(index, llm, CFG.thresholds("hashing")).ask("Regionale Feiertage im Bestellvorschlag?")
    assert ans.source == "gemini"
    assert "[1]" in llm.prompts[0]
    assert ans.text.startswith("Nein")


def test_llm_failure_falls_back(index):
    ans = KnowledgeService(index, StubLlm(exc=LlmUnavailable("x")), CFG.thresholds("hashing")).ask(
        "Regionale Feiertage im Bestellvorschlag?"
    )
    assert ans.source == "offline"
    assert ans.notice
