from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests

from reqpilot.adapters.errors import LlmUnavailable, SourceUnavailable, WriteDisabled
from reqpilot.adapters.gemini import GeminiLlm
from reqpilot.adapters.jira_rest import JiraRestReader, JiraRestWriter
from reqpilot.adapters.mock import (
    MockChangeSource,
    MockConfluence,
    MockJira,
    MockJiraWriter,
    MockServiceNow,
)
from reqpilot.adapters.offline_llm import OfflineLlm
from reqpilot.adapters.servicenow_rest import ServiceNowRest

FIX = Path(__file__).resolve().parents[1] / "fixtures"


def _session(json_data=None, status=200, exc=None, bad_json=False):
    session = MagicMock()
    resp = MagicMock()
    resp.status_code = status
    resp.ok = status < 400
    if bad_json:
        resp.json.side_effect = ValueError("kein JSON")
    else:
        resp.json.return_value = json_data
    if exc:
        session.request.side_effect = exc
    else:
        session.request.return_value = resp
    return session


def test_mock_readers_load_fixtures():
    jira = MockJira(FIX)
    assert len(jira.search_issues()) == 22
    assert all(i.reporter == "anna.berger@example.com" for i in jira.issues_by_reporter("anna.berger@example.com"))
    assert jira.search_issues()[0].url.endswith("/browse/ADF-1012")
    assert MockConfluence(FIX).pages()[0].title
    bug = MockServiceNow(FIX).bug("INC0041871")
    assert bug.component == "bestellvorschlag"
    assert MockChangeSource(FIX).changes()[0].components


def test_unknown_bug_raises_key_error():
    with pytest.raises(KeyError):
        MockServiceNow(FIX).bug("INC0000000")


def test_writers_refuse_when_disabled():
    with pytest.raises(WriteDisabled):
        MockJiraWriter(enabled=False).create_issue({"summary": "x"})
    with pytest.raises(WriteDisabled):
        JiraRestWriter("https://jira", "pat", 5, enabled=False, session=_session({})).create_issue({})


def test_mock_writer_records_when_enabled():
    w = MockJiraWriter(enabled=True)
    assert w.create_issue({"summary": "x"}) == "MOCK-1"
    assert w.created == [{"summary": "x"}]


def test_jira_rest_maps_issues():
    data = {
        "issues": [
            {
                "key": "ADF-1",
                "fields": {
                    "summary": "S",
                    "description": "D",
                    "status": {"name": "DONE"},
                    "reporter": {"emailAddress": "a@example.com"},
                    "updated": "2026-10-01T10:00:00.000+0200",
                    "components": [{"name": "Logistik"}],
                    "issuetype": {"name": "Story"},
                },
            }
        ],
        "total": 1,
    }
    reader = JiraRestReader("https://jira.example.com", "pat", 5, session=_session(data))
    issues = reader.search_issues()
    assert issues[0].key == "ADF-1"
    assert issues[0].status == "DONE"
    assert issues[0].stream == "logistik"
    assert issues[0].url == "https://jira.example.com/browse/ADF-1"


@pytest.mark.parametrize(
    "session",
    [
        _session(exc=requests.Timeout("zu langsam")),
        _session(exc=requests.ConnectionError("kein Netz")),
        _session({"x": 1}, status=500),
        _session(bad_json=True),
        _session({"unerwartet": True}),
    ],
)
def test_live_sources_wrap_failures(session):
    with pytest.raises(SourceUnavailable):
        JiraRestReader("https://jira", "pat", 5, session=session).search_issues()


def test_servicenow_timeout_is_source_unavailable():
    sn = ServiceNowRest("https://sn", "tok", 5, session=_session(exc=requests.Timeout()))
    with pytest.raises(SourceUnavailable):
        sn.bugs()


def test_gemini_returns_text_and_wraps_errors():
    ok = {"candidates": [{"content": {"parts": [{"text": "Hallo"}]}}]}
    assert GeminiLlm("k", "m", 5, session=_session(ok)).generate("p") == "Hallo"
    with pytest.raises(LlmUnavailable):
        GeminiLlm("k", "m", 5, session=_session(exc=requests.Timeout())).generate("p")
    with pytest.raises(LlmUnavailable):
        GeminiLlm("k", "m", 5, session=_session({"candidates": []})).generate("p")


def test_gemini_sends_key_in_header_not_url():
    session = _session({"candidates": [{"content": {"parts": [{"text": "x"}]}}]})
    GeminiLlm("geheim", "m", 5, session=session).generate("p", json_mode=True)
    _, kwargs = session.request.call_args
    assert kwargs["headers"]["x-goog-api-key"] == "geheim"
    assert "geheim" not in session.request.call_args[0][1]
    assert kwargs["json"]["generationConfig"]["responseMimeType"] == "application/json"


def test_offline_llm_is_unavailable():
    llm = OfflineLlm()
    assert llm.available is False
    with pytest.raises(LlmUnavailable):
        llm.generate("x")
