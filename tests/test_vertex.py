from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import numpy as np
import pytest
import requests

from reqpilot.adapters.errors import LlmUnavailable
from reqpilot.adapters.google_auth import AdcTokenProvider
from reqpilot.adapters.vertex import VertexLlm, vertex_model_url
from reqpilot.index.embedder import VertexEmbedder


class StaticToken:
    def __init__(self, value="tok", exc=None):
        self.value, self.exc = value, exc

    def token(self):
        if self.exc:
            raise self.exc
        return self.value


def _session(json_data=None, status=200, exc=None):
    session = MagicMock()
    resp = MagicMock(status_code=status, ok=status < 400)
    resp.json.return_value = json_data
    if exc:
        session.request.side_effect = exc
    else:
        session.request.return_value = resp
    return session


OK = {"candidates": [{"content": {"parts": [{"text": "Hallo"}]}}]}


def test_global_and_regional_urls():
    assert vertex_model_url("mein-projekt", "global", "gemini-2.5-flash", "generateContent") == (
        "https://aiplatform.googleapis.com/v1/projects/mein-projekt/locations/global"
        "/publishers/google/models/gemini-2.5-flash:generateContent"
    )
    assert vertex_model_url("p", "europe-west3", "m", "predict").startswith(
        "https://europe-west3-aiplatform.googleapis.com/v1/projects/p/locations/europe-west3/"
    )


def test_llm_sends_oauth_token_and_quota_project():
    session = _session(OK)
    llm = VertexLlm("mein-projekt", "global", "gemini-2.5-flash", 5, StaticToken("abc"), session=session)
    assert llm.generate("Hi", json_mode=True) == "Hallo"
    _, kwargs = session.request.call_args
    assert kwargs["headers"]["Authorization"] == "Bearer abc"
    assert kwargs["headers"]["x-goog-user-project"] == "mein-projekt"
    assert "key=" not in session.request.call_args[0][1]
    assert kwargs["json"]["generationConfig"]["responseMimeType"] == "application/json"


@pytest.mark.parametrize(
    "session",
    [_session({"error": {}}, status=401), _session({"error": {}}, status=403), _session(exc=requests.Timeout())],
)
def test_llm_http_errors_become_unavailable(session):
    with pytest.raises(LlmUnavailable):
        VertexLlm("p", "global", "m", 5, StaticToken(), session=session).generate("x")


def test_llm_token_failure_becomes_unavailable():
    llm = VertexLlm("p", "global", "m", 5, StaticToken(exc=LlmUnavailable("kein Login")), session=_session(OK))
    with pytest.raises(LlmUnavailable, match="kein Login"):
        llm.generate("x")


def test_embedder_batches_and_normalizes():
    session = MagicMock()

    def respond(method, url, **kwargs):
        n = len(kwargs["json"]["instances"])
        resp = MagicMock(status_code=200, ok=True)
        resp.json.return_value = {"predictions": [{"embeddings": {"values": [3.0, 4.0]}} for _ in range(n)]}
        return resp

    session.request.side_effect = respond
    emb = VertexEmbedder("p", "global", 5, StaticToken(), model="text-multilingual-embedding-002", session=session)
    emb.BATCH = 2
    out = emb.embed(["a", "b", "c"])
    assert out.shape == (3, 2)
    assert np.allclose(out[0], [0.6, 0.8])
    assert session.request.call_count == 2
    _, kwargs = session.request.call_args
    assert kwargs["headers"]["x-goog-user-project"] == "p"
    assert session.request.call_args[0][1].endswith("/models/text-multilingual-embedding-002:predict")


def test_embedder_bad_response_is_unavailable():
    emb = VertexEmbedder("p", "global", 5, StaticToken(), session=_session({"predictions": [{}]}))
    with pytest.raises(LlmUnavailable):
        emb.embed(["a"])


class FakeCreds:
    def __init__(self, token="t1", valid=True):
        self.token, self.valid, self.refreshed = token, valid, 0
        self.expiry = datetime.now(UTC).replace(tzinfo=None) + timedelta(minutes=30)

    def refresh(self, request):
        self.refreshed += 1
        self.token, self.valid = f"t{self.refreshed + 1}", True


def test_adc_token_provider_refreshes_only_when_needed(monkeypatch):
    creds = FakeCreds(valid=False)
    monkeypatch.setattr("google.auth.default", lambda scopes: (creds, "proj"))
    provider = AdcTokenProvider()
    assert provider.token() == "t2"
    assert provider.token() == "t2"
    assert creds.refreshed == 1


def test_adc_without_login_explains_fix(monkeypatch):
    import google.auth.exceptions

    def no_creds(scopes):
        raise google.auth.exceptions.DefaultCredentialsError("nichts da")

    monkeypatch.setattr("google.auth.default", no_creds)
    with pytest.raises(LlmUnavailable, match="gcloud auth application-default login"):
        AdcTokenProvider().token()


def test_service_account_json_is_used_when_given(monkeypatch):
    seen = {}

    def from_info(info, scopes):
        seen["info"] = info
        return FakeCreds()

    monkeypatch.setattr("google.oauth2.service_account.Credentials.from_service_account_info", from_info)
    provider = AdcTokenProvider(service_account_json='{"type": "service_account", "project_id": "p"}')
    assert provider.token() == "t1"
    assert seen["info"]["project_id"] == "p"


def test_broken_service_account_json_is_unavailable():
    with pytest.raises(LlmUnavailable):
        AdcTokenProvider(service_account_json="{kaputt").token()
