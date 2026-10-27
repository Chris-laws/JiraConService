"""UI-Texte. Alle sichtbaren Texte kommen aus strings/<lang>.yaml."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml

STRINGS = Path(__file__).parent / "strings"
DEFAULT_LANG = "de"


@lru_cache(maxsize=4)
def load_strings(lang: str) -> dict[str, str]:
    return yaml.safe_load((STRINGS / f"{lang}.yaml").read_text(encoding="utf-8"))


def current_lang() -> str:
    return os.environ.get("LIDLALIGN_LANG", DEFAULT_LANG)


def t(key: str, /, **kwargs) -> str:
    strings = load_strings(current_lang())
    text = strings.get(key) or load_strings(DEFAULT_LANG).get(key) or key
    return text.format(**kwargs) if kwargs else text
