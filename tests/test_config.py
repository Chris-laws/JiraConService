import pytest

from lidlalign.config import ConfigError, load_settings


def test_defaults_are_safe_offline_prototype():
    s = load_settings({})
    assert s.data_source == "mock"
    assert s.llm == "fake"
    assert s.jira_write_enabled is False
    assert s.http_timeout == 15.0


def test_gemini_without_key_is_config_error():
    with pytest.raises(ConfigError):
        load_settings({"LIDLALIGN_LLM": "gemini"})


def test_unknown_data_source_rejected():
    with pytest.raises(ConfigError):
        load_settings({"LIDLALIGN_DATA_SOURCE": "prod"})


def test_write_flag_parses_truthy_values():
    assert load_settings({"LIDLALIGN_JIRA_WRITE_ENABLED": "true"}).jira_write_enabled is True
    assert load_settings({"LIDLALIGN_JIRA_WRITE_ENABLED": "nein"}).jira_write_enabled is False


def test_live_source_requires_urls():
    with pytest.raises(ConfigError):
        load_settings({"LIDLALIGN_DATA_SOURCE": "live"})


def test_dotenv_file_is_read_without_overriding_environment(tmp_path):
    from lidlalign.config import read_dotenv

    env_file = tmp_path / ".env"
    env_file.write_text(
        "# Kommentar\nLIDLALIGN_LLM=gemini   # Inline-Kommentar\nGEMINI_API_KEY='abc'\nLEER=\n", encoding="utf-8"
    )
    assert read_dotenv(env_file) == {"LIDLALIGN_LLM": "gemini", "GEMINI_API_KEY": "abc", "LEER": ""}
    assert read_dotenv(tmp_path / "fehlt.env") == {}
