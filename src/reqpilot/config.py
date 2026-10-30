"""Einstellungen aus Umgebungsvariablen. Secrets kommen nie aus dem Repo."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

_TRUE = {"1", "true", "yes", "ja", "on"}
_DATA_SOURCES = {"mock", "live"}
_LLMS = {"fake", "gemini", "vertex"}


class ConfigError(ValueError):
    """Ungültige oder unvollständige Konfiguration."""


@dataclass(frozen=True)
class Settings:
    data_source: str = "mock"
    llm: str = "fake"
    jira_write_enabled: bool = False
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-2.5-flash"
    vertex_project_id: str | None = None
    vertex_location: str = "global"
    vertex_embedding_model: str = "text-multilingual-embedding-002"
    vertex_service_account_json: str | None = None
    http_timeout: float = 15.0
    jira_url: str | None = None
    jira_pat: str | None = None
    confluence_url: str | None = None
    confluence_pat: str | None = None
    servicenow_url: str | None = None
    servicenow_token: str | None = None
    config_dir: Path = ROOT / "config"
    fixtures_dir: Path = ROOT / "fixtures"
    # Change Log, Anleitungen, Schulungsunterlagen als Markdown-Export (auch im Live-Modus ein Ordner)
    docs_dir: Path = ROOT / "fixtures" / "docs"


def _opt(env: Mapping[str, str], key: str) -> str | None:
    value = env.get(key, "").strip()
    return value or None


def read_dotenv(path: Path) -> dict[str, str]:
    """Liest eine einfache .env-Datei (KEY=VALUE, # Kommentare). Fehlt sie, ist das Ergebnis leer."""
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.split(" #", 1)[0].strip().strip("'\"")
        values[key.strip()] = value
    return values


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    if env is None:
        # Lokal: .env im Projektordner; echte Umgebungsvariablen (z. B. auf Databricks) haben Vorrang.
        env = {**read_dotenv(ROOT / ".env"), **os.environ}
    data_source = env.get("REQPILOT_DATA_SOURCE", "mock").strip().lower()
    llm = env.get("REQPILOT_LLM", "fake").strip().lower()
    if data_source not in _DATA_SOURCES:
        raise ConfigError(f"REQPILOT_DATA_SOURCE muss eins von {sorted(_DATA_SOURCES)} sein")
    if llm not in _LLMS:
        raise ConfigError(f"REQPILOT_LLM muss eins von {sorted(_LLMS)} sein")

    settings = Settings(
        data_source=data_source,
        llm=llm,
        jira_write_enabled=env.get("REQPILOT_JIRA_WRITE_ENABLED", "false").strip().lower() in _TRUE,
        gemini_api_key=_opt(env, "GEMINI_API_KEY"),
        gemini_model=_opt(env, "GEMINI_MODEL") or "gemini-2.5-flash",
        vertex_project_id=_opt(env, "VERTEX_PROJECT_ID"),
        vertex_location=_opt(env, "VERTEX_LOCATION") or "global",
        vertex_embedding_model=_opt(env, "VERTEX_EMBEDDING_MODEL") or "text-multilingual-embedding-002",
        vertex_service_account_json=_opt(env, "VERTEX_SERVICE_ACCOUNT_JSON"),
        http_timeout=float(env.get("REQPILOT_HTTP_TIMEOUT", "15")),
        jira_url=_opt(env, "JIRA_URL"),
        jira_pat=_opt(env, "JIRA_PAT"),
        confluence_url=_opt(env, "CONFLUENCE_URL"),
        confluence_pat=_opt(env, "CONFLUENCE_PAT"),
        servicenow_url=_opt(env, "SERVICENOW_URL"),
        servicenow_token=_opt(env, "SERVICENOW_TOKEN"),
        docs_dir=Path(_opt(env, "REQPILOT_DOCS_DIR") or ROOT / "fixtures" / "docs"),
    )
    if llm == "gemini" and not settings.gemini_api_key:
        raise ConfigError("REQPILOT_LLM=gemini braucht GEMINI_API_KEY")
    if llm == "vertex" and not settings.vertex_project_id:
        raise ConfigError("REQPILOT_LLM=vertex braucht VERTEX_PROJECT_ID (Projekt-ID mit Bindestrichen)")
    if data_source == "live":
        missing = [
            name
            for name, value in (
                ("JIRA_URL", settings.jira_url),
                ("CONFLUENCE_URL", settings.confluence_url),
                ("SERVICENOW_URL", settings.servicenow_url),
            )
            if not value
        ]
        if missing:
            raise ConfigError(f"Live-Modus braucht: {', '.join(missing)}")
    return settings
