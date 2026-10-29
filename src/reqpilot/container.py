"""Verdrahtet Adapter und Services anhand der Einstellungen. Einziger Ort mit mock/live-Weiche."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import cached_property

from reqpilot.adapters.base import (
    ChangeSource,
    ConfluenceReader,
    JiraReader,
    JiraWriter,
    Llm,
    ServiceNowReader,
)
from reqpilot.adapters.confluence_rest import ConfluenceRest
from reqpilot.adapters.errors import LlmUnavailable
from reqpilot.adapters.gemini import GeminiLlm
from reqpilot.adapters.google_auth import AdcTokenProvider
from reqpilot.adapters.jira_rest import JiraRestReader, JiraRestWriter
from reqpilot.adapters.mock import MockChangeSource, MockConfluence, MockJira, MockJiraWriter, MockServiceNow
from reqpilot.adapters.offline_llm import OfflineLlm
from reqpilot.adapters.servicenow_rest import ServiceNowRest
from reqpilot.adapters.vertex import VertexLlm
from reqpilot.config import Settings
from reqpilot.index.embedder import Embedder, GeminiEmbedder, HashingEmbedder, VertexEmbedder
from reqpilot.index.vector_index import VectorIndex, build_knowledge_index
from reqpilot.services.classifier import StreamClassifier
from reqpilot.services.duplicates import DuplicateChecker
from reqpilot.services.knowledge import KnowledgeService
from reqpilot.services.my_tickets import MyTickets
from reqpilot.services.rca import RootCauseAnalyzer
from reqpilot.services.ticket_writer import TicketWriter
from reqpilot.streams import AppConfig, StreamRegistry, load_app_config


@dataclass
class Container:
    settings: Settings
    app_config: AppConfig
    streams: StreamRegistry
    jira: JiraReader
    jira_writer: JiraWriter
    confluence: ConfluenceReader
    servicenow: ServiceNowReader
    changes: ChangeSource
    llm: Llm
    embedder: Embedder
    notices: list[str] = field(default_factory=list)

    @property
    def thresholds(self) -> dict:
        return self.app_config.thresholds(self.embedder.name)

    @cached_property
    def index(self) -> VectorIndex:
        return build_knowledge_index(self.jira, self.confluence, self.embedder)

    @cached_property
    def ticket_writer(self) -> TicketWriter:
        return TicketWriter(self.llm, self.app_config.priorities, self.app_config.default_priority)

    @cached_property
    def classifier(self) -> StreamClassifier:
        return StreamClassifier(self.streams, self.embedder, self.thresholds)

    @cached_property
    def duplicates(self) -> DuplicateChecker:
        return DuplicateChecker(self.index, self.thresholds)

    @cached_property
    def knowledge(self) -> KnowledgeService:
        return KnowledgeService(self.index, self.llm, self.thresholds)

    @cached_property
    def my_tickets(self) -> MyTickets:
        return MyTickets(self.jira, self.app_config.lifecycle)

    @cached_property
    def rca(self) -> RootCauseAnalyzer:
        return RootCauseAnalyzer(self.changes, self.embedder)


def build_container(settings: Settings) -> Container:
    s = settings
    notices: list[str] = []
    llm: Llm
    embedder: Embedder
    if s.llm in {"gemini", "vertex"}:
        if s.llm == "vertex":
            tokens = AdcTokenProvider(s.vertex_service_account_json)
            project, loc = s.vertex_project_id or "", s.vertex_location
            llm = VertexLlm(project, loc, s.gemini_model, s.http_timeout, tokens)
            embedder = VertexEmbedder(project, loc, s.http_timeout, tokens, s.vertex_embedding_model)
        else:
            llm = GeminiLlm(s.gemini_api_key or "", s.gemini_model, s.http_timeout)
            embedder = GeminiEmbedder(s.gemini_api_key or "", s.http_timeout)
        try:
            # Einmal beim Start prüfen: Index und Anfragen müssen denselben Embedder nutzen.
            embedder.embed(["Verbindungstest"])
        except LlmUnavailable as exc:
            embedder = HashingEmbedder()
            notices.append(f"KI-Embeddings nicht erreichbar ({exc}); Ähnlichkeitssuche läuft offline.")
    else:
        llm, embedder = OfflineLlm(), HashingEmbedder()

    if s.data_source == "live":
        spaces = tuple(x.strip() for x in os.environ.get("CONFLUENCE_SPACES", "ADF").split(",") if x.strip())
        servicenow = ServiceNowRest(s.servicenow_url or "", s.servicenow_token, s.http_timeout)
        jira: JiraReader = JiraRestReader(s.jira_url or "", s.jira_pat, s.http_timeout)
        writer: JiraWriter = JiraRestWriter(s.jira_url or "", s.jira_pat, s.http_timeout, s.jira_write_enabled)
        confluence: ConfluenceReader = ConfluenceRest(s.confluence_url or "", s.confluence_pat, s.http_timeout, spaces)
        sn: ServiceNowReader = servicenow
        changes: ChangeSource = servicenow
    else:
        jira = MockJira(s.fixtures_dir)
        writer = MockJiraWriter(s.jira_write_enabled)
        confluence = MockConfluence(s.fixtures_dir)
        sn = MockServiceNow(s.fixtures_dir)
        changes = MockChangeSource(s.fixtures_dir)

    return Container(
        settings=s,
        app_config=load_app_config(s.config_dir / "settings.yaml"),
        streams=StreamRegistry.from_yaml(s.config_dir / "streams.yaml"),
        jira=jira,
        jira_writer=writer,
        confluence=confluence,
        servicenow=sn,
        changes=changes,
        llm=llm,
        embedder=embedder,
        notices=notices,
    )
