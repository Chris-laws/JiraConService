"""Optik der App. Grundfarben stehen als Tokens in .streamlit/config.toml (hell und dunkel).

Einzige Stelle mit unsafe_allow_html: statisches CSS ohne Nutzerdaten. Flächenfarben laufen über
light-dark(), weil .stApp das color-scheme des aktiven Streamlit-Themes setzt. Seiten verwenden
Container mit key="hero" bzw. key="card_…", Streamlit hängt daran die Klasse .st-key-<key>.
"""

from __future__ import annotations

from pathlib import Path

import streamlit as st

ASSETS = Path(__file__).resolve().parents[3] / "assets"

# Hero-Verlauf (indigo-700 → violet-700) mit weißer Schrift; Kontrast prüft der Guard.
HERO_COLORS = ("#4338ca", "#6d28d9")

_CSS = """
<style>
  .stApp {
    --rp-card: light-dark(#ffffff, #111a2e);
    --rp-line: light-dark(#e6eaf1, #1f2b44);
    --rp-muted: light-dark(#f1f4f9, #0f1729);
    --rp-shadow: 0 1px 2px light-dark(rgba(15,23,42,.05), rgba(0,0,0,.35)),
                 0 10px 28px -14px light-dark(rgba(15,23,42,.18), rgba(0,0,0,.6));
  }

  /* Raster: volle Breite, wenig Leerraum oben */
  .block-container { padding: 1.25rem 2rem 3rem; max-width: 104rem; }
  [data-testid="stMainBlockContainer"] [data-testid="stVerticalBlock"] { gap: 0.875rem; }
  h1, h2, h3, h4 { letter-spacing: -0.02em; }
  [data-testid="stHeaderActionElements"] { display: none; }
  footer { visibility: hidden; }

  /* Hero-Band */
  .st-key-hero {
    background:
      radial-gradient(120% 140% at 100% 0%, rgba(255,255,255,.18) 0%, rgba(255,255,255,0) 55%),
      linear-gradient(120deg, #4338ca 0%, #6d28d9 100%);
    border-radius: 1rem; padding: 1.25rem 1.5rem 1.1rem; box-shadow: var(--rp-shadow);
    gap: 0.35rem !important; flex: 0 0 auto;
  }
  .st-key-hero > div, [class*="st-key-card"] > div, [class*="st-key-tile"] > div { flex-shrink: 0; }
  .st-key-hero, .st-key-hero * { color: #ffffff !important; }
  .st-key-hero h1 { font-size: 1.625rem; font-weight: 700; padding: 0; margin: 0; line-height: 1.25; }
  .st-key-hero [data-testid="stMarkdownContainer"], .st-key-hero p { margin: 0 !important; }
  .st-key-hero [data-testid="stCaptionContainer"] { opacity: 1; }
  .st-key-hero [data-testid="stCaptionContainer"] p { opacity: .92; font-size: .9rem; }
  .st-key-hero [data-testid="stMarkdownContainer"] p { font-size: .8125rem; font-weight: 500; padding-top: .2rem; }

  /* Karten */
  [class*="st-key-card"] {
    background: var(--rp-card); border: 1px solid var(--rp-line); border-radius: 0.875rem;
    padding: 1.1rem 1.25rem 1.2rem; box-shadow: var(--rp-shadow);
  }
  [class*="st-key-card"] h3 { font-size: 1.2rem; font-weight: 650; line-height: 1.35; padding: .1rem 0 0; }
  [class*="st-key-card"] [data-testid="stCaptionContainer"] p { line-height: 1.55; }
  .st-key-card_empty { padding: 1.5rem; }
  [class*="st-key-tile"] {
    background: var(--rp-muted); border-radius: .75rem; padding: .85rem 1rem; gap: .15rem !important;
  }

  /* Kennzahlen */
  [data-testid="stMetric"] {
    background: var(--rp-card); border-color: var(--rp-line) !important; border-radius: .875rem;
    box-shadow: var(--rp-shadow); padding: .6rem .9rem !important; height: 100%;
  }
  [data-testid="stMetricValue"] { font-variant-numeric: tabular-nums; font-size: 1.2rem; font-weight: 650; }
  [data-testid="stMetricValue"], [data-testid="stMetricValue"] * {
    white-space: normal !important; text-overflow: clip !important; overflow: visible !important; line-height: 1.3;
  }
  [data-testid="stMetricLabel"] p { font-size: .8125rem; font-weight: 500; opacity: .7; }

  /* Kennzahlen einer Reihe gleich hoch */
  [data-testid="stHorizontalBlock"]:has(
    > [data-testid="stColumn"] > [data-testid="stVerticalBlock"]
    > [data-testid="stElementContainer"] > [data-testid="stMetric"]
  ) { align-items: stretch; }
  [data-testid="stColumn"]:has(
    > [data-testid="stVerticalBlock"] > [data-testid="stElementContainer"] > [data-testid="stMetric"]
  ) > [data-testid="stVerticalBlock"],
  [data-testid="stColumn"] > [data-testid="stVerticalBlock"]
    > [data-testid="stElementContainer"]:has(> [data-testid="stMetric"]) { height: 100%; }

  /* Tabs als Segment-Schalter */
  [data-testid="stTabs"] [role="tablist"] {
    gap: .25rem; background: var(--rp-muted); padding: .25rem; border-radius: .7rem;
    width: fit-content; max-width: 100%; box-shadow: none; border: none;
  }
  [data-testid="stTabs"] [role="tablist"]::before, [data-testid="stTabs"] [role="tablist"]::after { display: none; }
  [data-testid="stTab"] { border-radius: .55rem; padding: .3rem .8rem; height: auto; }
  [data-testid="stTab"][data-selected="true"] { background: var(--rp-card); box-shadow: var(--rp-shadow); }
  [data-testid="stTab"] > div:not([data-testid]) { display: none; }
  [data-testid="stTabPanel"] { padding-top: .9rem; }

  /* Eingaben, Buttons, Tabellen */
  .stTextArea textarea { line-height: 1.6; font-size: .95rem; }
  button[kind="primary"], button[kind="primaryFormSubmit"] {
    box-shadow: 0 8px 18px -8px rgba(79,70,229,.65); font-weight: 600;
  }
  [data-testid="stForm"] { border: none; padding: 0; }
  [data-testid="stDataFrame"] { border-radius: .75rem; overflow: hidden; }
  [data-testid="stCode"] pre { font-size: .8125rem; line-height: 1.55; max-height: 26rem; }
  [data-testid="stAlert"] { border-radius: .75rem; }
  [data-testid="stAlertContainer"] { padding: .7rem .9rem; }

  /* Seitenleiste */
  [data-testid="stSidebar"] { background: var(--rp-card); }
  [data-testid="stSidebarNav"] a { border-radius: .55rem; }
  [data-testid="stSidebarUserContent"] { padding-top: .5rem; }
</style>
"""


def apply_theme() -> None:
    st.markdown(_CSS, unsafe_allow_html=True)
    st.logo(str(ASSETS / "logo.svg"), icon_image=str(ASSETS / "icon.svg"), size="large")
