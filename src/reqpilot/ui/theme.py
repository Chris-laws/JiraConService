"""Optische Feinheiten. Farben stehen als Tokens in .streamlit/config.toml (hell und dunkel).

Einzige Stelle mit unsafe_allow_html: statisches CSS ohne Nutzerdaten und ohne Farben,
damit hell und dunkel automatisch aus dem Streamlit-Theme kommen.
"""

from __future__ import annotations

from pathlib import Path

import streamlit as st

ASSETS = Path(__file__).resolve().parents[3] / "assets"

_CSS = """
<style>
  .block-container { padding-top: 2.5rem; padding-bottom: 4rem; max-width: 76rem; }
  h1 { letter-spacing: -0.025em; font-weight: 700; }
  h2, h3 { letter-spacing: -0.015em; font-weight: 650; }
  [data-testid="stMetricValue"] { font-variant-numeric: tabular-nums; font-size: 1.5rem; }
  [data-testid="stMetricLabel"] p { font-size: 0.8125rem; opacity: 0.8; }
  [data-testid="stCaptionContainer"] p { line-height: 1.6; }
  [data-testid="stCode"] pre { font-size: 0.8125rem; line-height: 1.55; }
  footer { visibility: hidden; }
</style>
"""


def apply_theme() -> None:
    st.markdown(_CSS, unsafe_allow_html=True)
    st.logo(str(ASSETS / "logo.svg"), icon_image=str(ASSETS / "icon.svg"), size="large")
