from pathlib import Path

import pytest

from reqpilot.config import ConfigError
from reqpilot.streams import StreamRegistry, load_app_config

CONFIG = Path(__file__).resolve().parents[1] / "config"


def test_pilot_has_four_active_adf_streams():
    reg = StreamRegistry.from_yaml(CONFIG / "streams.yaml")
    assert len(reg.active()) == 4
    assert all(s.epics for s in reg.active())


def test_disabled_stream_not_active(tmp_path):
    p = tmp_path / "s.yaml"
    p.write_text(
        "streams:\n"
        "  - {id: a, name: A, description: d, enabled: true}\n"
        "  - {id: b, name: B, description: d, enabled: false}\n",
        encoding="utf-8",
    )
    reg = StreamRegistry.from_yaml(p)
    assert [s.id for s in reg.active()] == ["a"]
    assert reg.get("b").name == "B"


def test_duplicate_ids_rejected(tmp_path):
    p = tmp_path / "s.yaml"
    p.write_text(
        "streams:\n  - {id: a, name: A, description: d}\n  - {id: a, name: B, description: d}\n",
        encoding="utf-8",
    )
    with pytest.raises(ConfigError, match="doppelt"):
        StreamRegistry.from_yaml(p)


def test_no_active_streams_rejected(tmp_path):
    p = tmp_path / "s.yaml"
    p.write_text("streams:\n  - {id: a, name: A, description: d, enabled: false}\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="aktiv"):
        StreamRegistry.from_yaml(p)


def test_missing_required_field_rejected(tmp_path):
    p = tmp_path / "s.yaml"
    p.write_text("streams:\n  - {id: a}\n", encoding="utf-8")
    with pytest.raises(ConfigError):
        StreamRegistry.from_yaml(p)


def test_app_config_has_exact_priorities_and_lifecycle():
    cfg = load_app_config(CONFIG / "settings.yaml")
    assert cfg.priorities == ["Blocker", "High", "Medium", "Low"]
    assert cfg.lifecycle[0] == "NEW REQUIREMENT"
    assert "SELECTED FOR DEVELOPMENT" in cfg.lifecycle
    assert cfg.thresholds("hashing")["duplicate"] > cfg.thresholds("hashing")["similar"]


def test_countries_start_with_de():
    assert load_app_config(CONFIG / "settings.yaml").countries[0] == "DE"
