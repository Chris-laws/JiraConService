"""Stream-Registry und App-Konfiguration aus YAML. Neue Streams = YAML-Eintrag, kein Code."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from lidlalign.config import ConfigError
from lidlalign.models import Epic, Stream


def _read_yaml(path: Path) -> dict:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise ConfigError(f"{path.name} nicht lesbar: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{path.name}: erwartet ein Objekt auf oberster Ebene")
    return data


def _stream_from(raw: dict) -> Stream:
    try:
        return Stream(
            id=str(raw["id"]),
            name=str(raw["name"]),
            description=str(raw["description"]),
            keywords=tuple(str(k) for k in raw.get("keywords", [])),
            board=str(raw.get("board", "")),
            epics=tuple(Epic(str(e["key"]), str(e["title"])) for e in raw.get("epics", [])),
            enabled=bool(raw.get("enabled", True)),
        )
    except (KeyError, TypeError) as exc:
        raise ConfigError(f"Stream-Eintrag unvollständig ({exc}): {raw}") from exc


class StreamRegistry:
    def __init__(self, streams: list[Stream]):
        ids = [s.id for s in streams]
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        if dupes:
            raise ConfigError(f"Stream-IDs doppelt: {', '.join(dupes)}")
        if not any(s.enabled for s in streams):
            raise ConfigError("Kein aktiver Stream konfiguriert")
        self._streams = {s.id: s for s in streams}

    @classmethod
    def from_yaml(cls, path: Path) -> StreamRegistry:
        raw = _read_yaml(path).get("streams") or []
        return cls([_stream_from(r) for r in raw])

    def active(self) -> list[Stream]:
        return [s for s in self._streams.values() if s.enabled]

    def all(self) -> list[Stream]:
        return list(self._streams.values())

    def get(self, stream_id: str) -> Stream:
        try:
            return self._streams[stream_id]
        except KeyError as exc:
            raise ConfigError(f"Unbekannter Stream: {stream_id}") from exc


@dataclass(frozen=True)
class AppConfig:
    priorities: list[str]
    default_priority: str
    lifecycle: list[str]
    _thresholds: dict

    def thresholds(self, embedder: str) -> dict:
        return self._thresholds.get(embedder) or self._thresholds["default"]


def load_app_config(path: Path) -> AppConfig:
    data = _read_yaml(path)
    try:
        cfg = AppConfig(
            priorities=list(data["priorities"]),
            default_priority=str(data["default_priority"]),
            lifecycle=list(data["lifecycle"]),
            _thresholds=dict(data["thresholds"]),
        )
    except KeyError as exc:
        raise ConfigError(f"settings.yaml: Feld fehlt: {exc}") from exc
    if cfg.default_priority not in cfg.priorities:
        raise ConfigError("default_priority muss in priorities stehen")
    if "default" not in cfg._thresholds:
        raise ConfigError("thresholds.default fehlt")
    return cfg
