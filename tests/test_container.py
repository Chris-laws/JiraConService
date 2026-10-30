import pytest

from reqpilot.adapters.errors import LlmUnavailable, WriteDisabled
from reqpilot.adapters.gemini import GeminiLlm
from reqpilot.adapters.jira_rest import JiraRestReader
from reqpilot.config import load_settings
from reqpilot.container import build_container
from reqpilot.index.embedder import GeminiEmbedder, HashingEmbedder


def test_mock_container_wires_all_services():
    c = build_container(load_settings({}))
    assert isinstance(c.embedder, HashingEmbedder)
    assert c.thresholds == c.app_config.thresholds("hashing")
    assert len(c.index) == 30
    draft = c.ticket_writer.draft("Als Disponent möchte ich Bestellvorschläge prüfen, damit Fehler auffallen.", "DE")
    assert c.classifier.classify(draft.as_text()).suggestions
    assert c.rca.analyze(c.servicenow.bugs()[0]).candidates
    with pytest.raises(WriteDisabled):
        c.jira_writer.create_issue({})


def test_gemini_settings_use_gemini_adapters(monkeypatch):
    monkeypatch.setattr(GeminiEmbedder, "embed", lambda self, texts: HashingEmbedder().embed(texts))
    c = build_container(load_settings({"REQPILOT_LLM": "gemini", "GEMINI_API_KEY": "k"}))
    assert isinstance(c.llm, GeminiLlm)
    assert isinstance(c.embedder, GeminiEmbedder)


def test_live_settings_use_rest_adapters():
    env = {
        "REQPILOT_DATA_SOURCE": "live",
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
    c = build_container(load_settings({"REQPILOT_LLM": "gemini", "GEMINI_API_KEY": "k"}))
    assert isinstance(c.embedder, HashingEmbedder)
    assert c.notices
    assert c.classifier.classify("Bestellvorschlag").suggestions


def test_vertex_settings_use_vertex_adapters(monkeypatch):
    from reqpilot.adapters.vertex import VertexLlm
    from reqpilot.index.embedder import VertexEmbedder

    monkeypatch.setattr(VertexEmbedder, "embed", lambda self, texts: HashingEmbedder().embed(texts))
    c = build_container(load_settings({"REQPILOT_LLM": "vertex", "VERTEX_PROJECT_ID": "p"}))
    assert isinstance(c.llm, VertexLlm)
    assert isinstance(c.embedder, VertexEmbedder)
