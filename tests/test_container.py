import pytest

from lidlalign.adapters.errors import LlmUnavailable, WriteDisabled
from lidlalign.adapters.gemini import GeminiLlm
from lidlalign.adapters.jira_rest import JiraRestReader
from lidlalign.config import load_settings
from lidlalign.container import build_container
from lidlalign.index.embedder import GeminiEmbedder, HashingEmbedder


def test_mock_container_wires_all_services():
    c = build_container(load_settings({}))
    assert isinstance(c.embedder, HashingEmbedder)
    assert c.thresholds == c.app_config.thresholds("hashing")
    assert len(c.index) == 15
    draft = c.ticket_writer.draft("Als Disponent möchte ich Bestellvorschläge prüfen, damit Fehler auffallen.", "DE")
    assert c.classifier.classify(draft.as_text()).suggestions
    assert c.rca.analyze(c.servicenow.bugs()[0]).candidates
    with pytest.raises(WriteDisabled):
        c.jira_writer.create_issue({})


def test_gemini_settings_use_gemini_adapters(monkeypatch):
    monkeypatch.setattr(GeminiEmbedder, "embed", lambda self, texts: HashingEmbedder().embed(texts))
    c = build_container(load_settings({"LIDLALIGN_LLM": "gemini", "GEMINI_API_KEY": "k"}))
    assert isinstance(c.llm, GeminiLlm)
    assert isinstance(c.embedder, GeminiEmbedder)


def test_live_settings_use_rest_adapters():
    env = {
        "LIDLALIGN_DATA_SOURCE": "live",
        "JIRA_URL": "https://jira",
        "CONFLUENCE_URL": "https://conf",
        "SERVICENOW_URL": "https://sn",
    }
    c = build_container(load_settings(env))
    assert isinstance(c.jira, JiraRestReader)


def test_unreachable_gemini_embeddings_fall_back_to_offline(monkeypatch):
    def boom(self, texts):
        raise LlmUnavailable("kein Egress")

    monkeypatch.setattr(GeminiEmbedder, "embed", boom)
    c = build_container(load_settings({"LIDLALIGN_LLM": "gemini", "GEMINI_API_KEY": "k"}))
    assert isinstance(c.embedder, HashingEmbedder)
    assert c.notices
    assert c.classifier.classify("Bestellvorschlag").suggestions
