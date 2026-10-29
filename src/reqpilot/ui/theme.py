"""Optische Feinheiten. Farben aus der Tailwind-Palette; Kontrast wird im Guard geprüft.

Einzige Stelle mit unsafe_allow_html: statisches CSS ohne Nutzerdaten.
"""

from __future__ import annotations

import streamlit as st

from reqpilot.ui.i18n import t

# Tailwind-Tokens (hell / dunkel). Text auf Hintergrund muss WCAG AA (4.5:1) erfüllen.
PALETTE = {
    "light": {
        "background": "#f9fafb",  # gray-50
        "surface": "#ffffff",
        "text": "#111827",  # gray-900
        "muted": "#4b5563",  # gray-600
        "accent": "#1d4ed8",  # blue-700
        "success": "#047857",  # emerald-700
        "warning": "#b45309",  # amber-700
        "danger": "#be123c",  # rose-700
    },
    "dark": {
        "background": "#111827",  # gray-900
        "surface": "#1f2937",  # gray-800
        "text": "#f9fafb",  # gray-50
        "muted": "#d1d5db",  # gray-300
        "accent": "#93c5fd",  # blue-300
        "success": "#6ee7b7",  # emerald-300
        "warning": "#fcd34d",  # amber-300
        "danger": "#fda4af",  # rose-300
    },
}

_CSS = """
<style>
  .block-container { padding-top: 2rem; max-width: 72rem; }
  h1 { letter-spacing: -0.025em; }
  [data-testid="stMetricValue"] { font-variant-numeric: tabular-nums; }
  [data-testid="stVerticalBlockBorderWrapper"] { border-radius: 0.5rem; }
</style>
"""


def apply_theme() -> None:
    st.markdown(_CSS, unsafe_allow_html=True)


def confidence_label(confidence: float) -> str:
    """Konfidenz als Wort, damit die Aussage nicht nur über Farbe/Zahl transportiert wird."""
    if confidence >= 0.7:
        return t("conf.high")
    if confidence >= 0.4:
        return t("conf.medium")
    return t("conf.low")
