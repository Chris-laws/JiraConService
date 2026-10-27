"""Einstellungen aus Umgebungsvariablen. Secrets kommen nie aus dem Repo."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

_TRUE = {"1", "true", "yes", "ja", "on"}
_DATA_SOURCES = {"mock", "live"}
_LLMS = {"fake", "gemini"}


class ConfigError(ValueError):
    """Ungültige oder unvollständige Konfiguration."""


@dataclass(frozen=True)
class Settings:
    data_source: str = "mock"
    llm: str = "fake"
    jira_write_enabled: bool = False
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-2.5-flash"
    http_timeout: float = 15.0
    jira_url: str | None = None
    jira_pat: str | None = None
    confluence_url: str | None = None
    confluence_pat: str | None = None
    servicenow_url: str | None = None
    servicenow_token: str | None = None
    config_dir: Path = ROOT / "config"
    fixtures_dir: Path = ROOT / "fixtures"


def _opt(env: Mapping[str, str], key: str) -> str | None:
    value = env.get(key, "").strip()
    return value or None


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    data_source = env.get("LIDLALIGN_DATA_SOURCE", "mock").strip().lower()
    llm = env.get("LIDLALIGN_LLM", "fake").strip().lower()
    if data_source not in _DATA_SOURCES:
        raise ConfigError(f"LIDLALIGN_DATA_SOURCE muss eins von {sorted(_DATA_SOURCES)} sein")
    if llm not in _LLMS:
        raise ConfigError(f"LIDLALIGN_LLM muss eins von {sorted(_LLMS)} sein")

    settings = Settings(
        data_source=data_source,
        llm=llm,
        jira_write_enabled=env.get("LIDLALIGN_JIRA_WRITE_ENABLED", "false").strip().lower() in _TRUE,
        gemini_api_key=_opt(env, "GEMINI_API_KEY"),
        gemini_model=_opt(env, "GEMINI_MODEL") or "gemini-2.5-flash",
        http_timeout=float(env.get("LIDLALIGN_HTTP_TIMEOUT", "15")),
        jira_url=_opt(env, "JIRA_URL"),
        jira_pat=_opt(env, "JIRA_PAT"),
        confluence_url=_opt(env, "CONFLUENCE_URL"),
        confluence_pat=_opt(env, "CONFLUENCE_PAT"),
        servicenow_url=_opt(env, "SERVICENOW_URL"),
        servicenow_token=_opt(env, "SERVICENOW_TOKEN"),
    )
    if llm == "gemini" and not settings.gemini_api_key:
        raise ConfigError("LIDLALIGN_LLM=gemini braucht GEMINI_API_KEY")
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
