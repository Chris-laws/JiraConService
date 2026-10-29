"""Maskiert personenbezogene Daten, bevor Text an ein LLM geht."""

from __future__ import annotations

import re

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?<![\w.])\+?\d[\d \t/()-]{5,}\d(?![\w.])")
_MIN_PHONE_DIGITS = 7


def _mask_phone(match: re.Match) -> str:
    digits = sum(ch.isdigit() for ch in match.group())
    return "[Telefon]" if digits >= _MIN_PHONE_DIGITS else match.group()


def redact(text: str) -> str:
    return _PHONE.sub(_mask_phone, _EMAIL.sub("[E-Mail]", text))
