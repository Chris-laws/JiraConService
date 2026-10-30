"""Optik der App im Stil "Achromatic ledger" (Taste-Skill, App-Regeln).

Grundfarben stehen als Tokens in .streamlit/config.toml. Hier nur statisches CSS ohne Nutzerdaten, die
einzige Stelle mit unsafe_allow_html. Flächenfarben laufen über light-dark(), weil .stApp das
color-scheme des aktiven Streamlit-Themes setzt. Karten sind Container mit key="card_…", Kennzahlen
Container mit key="kpis_…"; Streamlit hängt daran die Klasse .st-key-<key>.

Regeln: Chrome in Tinte, der eine Datenton (#1d5fbf) nur auf Daten, keine Verläufe, keine Schatten auf
ruhenden Flächen, Karten mit 1px-Linie und 8px Radius, ein Abstand (12px) überall.
"""

from __future__ import annotations

from pathlib import Path

import streamlit as st

ASSETS = Path(__file__).resolve().parents[3] / "assets"

# Beschriftung des Primär-Buttons je Modus (dunkel invertiert: helle Fläche, dunkle Schrift).
BUTTON_INK = {"light": "#ffffff", "dark": "#0a0a0a"}
# Kartenfläche je Modus (im CSS als --surface).
SURFACE = {"light": "#ffffff", "dark": "#111111"}
# Der eine Datenton je Modus, z. B. für Fortschrittsbalken. Kontrast prüft der Guard.
DATA_HUE = {"light": "#1d5fbf", "dark": "#7fb0ff"}

_CSS = """
<style>
  .stApp {
    --surface: light-dark(#ffffff, #111111);
    --line: light-dark(#e3e5e8, #262626);
    --rule: light-dark(#eef0f2, #1c1c1c);
    --muted: light-dark(#5f6368, #b4b4b4);
    --hue: light-dark(#1d5fbf, #7fb0ff);
    --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  }

  /* Raster: ein Abstand, Titel 32px unter der Kante */
  .block-container { padding: 4rem 2rem 3rem; max-width: 90rem; }  /* 4rem: frei von der festen Kopfleiste */
  @media (max-width: 640px) { .block-container { padding-left: 16px; padding-right: 16px; } }
  [data-testid="stMainBlockContainer"] [data-testid="stVerticalBlock"] { gap: 12px; }
  [data-testid="stMainBlockContainer"] [data-testid="stHorizontalBlock"] { gap: 12px; }
  [data-testid="stHeaderActionElements"] { display: none; }
  footer { visibility: hidden; }

  /* Titelzeile: Substantiv, 24px, darunter ein grauer Satz zu den Daten */
  [data-testid="stMainBlockContainer"] h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.01em;
    padding: 0; line-height: 32px; }
  h2, h3 { letter-spacing: -0.01em; }
  [data-testid="stCaptionContainer"] { opacity: 1; }
  [data-testid="stCaptionContainer"] p { color: var(--muted); font-size: 13px; line-height: 20px; }

  /* Karten: weiß, 1px Linie, kein Schatten */
  [class*="st-key-card"] {
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 20px;
  }
  [class*="st-key-card"] h3 { font-size: 18px; font-weight: 600; line-height: 26px; padding: 0; }

  /* Karten einer Reihe enden auf einer Linie; nur eine Aktion darf am Fuß sitzen */
  [data-testid="stHorizontalBlock"]:has(> [data-testid="stColumn"] > [data-testid="stVerticalBlock"]
    > [data-testid="stLayoutWrapper"] > [class*="st-key-card"]) { align-items: stretch; }
  [data-testid="stColumn"] > [data-testid="stVerticalBlock"]:has(> [data-testid="stLayoutWrapper"]
    > [class*="st-key-card"]) { height: 100%; }
  [data-testid="stColumn"] > [data-testid="stVerticalBlock"]
    > [data-testid="stLayoutWrapper"]:last-child:has(> [class*="st-key-card"]) { flex: 1 1 auto; }
  [data-testid="stColumn"] > [data-testid="stVerticalBlock"]
    > [data-testid="stLayoutWrapper"]:last-child > [class*="st-key-card"] { height: 100%; }
  [class*="st-key-card"] > [data-testid="stLayoutWrapper"]:has(> [class*="st-key-foot"]) { margin-top: auto; }
  .st-key-card_input > [data-testid="stLayoutWrapper"]:has(> [data-testid="stForm"]) { flex: 1 1 auto; }
  .st-key-card_input [data-testid="stForm"] { flex: 1 1 auto; display: flex; flex-direction: column; }
  .st-key-card_input [data-testid="stForm"] > [data-testid="stVerticalBlock"] { flex: 1 1 auto; }
  /* Das Textfeld wächst mit der Karte, damit die Eingabe wie ein Editor die Spalte füllt */
  .st-key-card_input [data-testid="stForm"] [data-testid="stElementContainer"]:has(.stTextArea) {
    flex: 1 1 auto; display: flex; flex-direction: column; }
  .st-key-card_input .stTextArea { flex: 1 1 auto; display: flex; flex-direction: column; }
  .st-key-card_input .stTextArea > div:has([data-testid="stTextAreaRootElement"]) { flex: 1 1 auto; display: flex; }
  .st-key-card_input [data-testid="stTextAreaRootElement"] { flex: 1 1 auto; height: auto !important; }
  .st-key-card_input [data-testid="stTextAreaRootElement"] textarea { height: 100% !important; }

  /* Kennzahlen: ein Streifen, durch Haarlinien geteilt, keine Kacheln */
  .st-key-kpis_mine { border-top: none !important; padding-top: 0 !important; }
  [class*="st-key-kpis"] { gap: 0 !important; border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule); padding: 12px 0; }
  [class*="st-key-kpis"] > [data-testid="stElementContainer"] { flex: 1 1 0; min-width: 0; padding: 0 16px; }
  [class*="st-key-kpis"] > [data-testid="stElementContainer"]:first-child { padding-left: 0; }
  [class*="st-key-kpis"] > [data-testid="stElementContainer"] + [data-testid="stElementContainer"] {
    border-left: 1px solid var(--rule); }
  [data-testid="stMetric"] { padding: 0 !important; border: none !important; background: none; }
  [data-testid="stMetricLabel"] p { font-size: 12px; color: var(--muted); }
  .st-key-kpis_ticket > [data-testid="stElementContainer"]:nth-child(2) { flex-grow: 2; }
  [data-testid="stMetricValue"] { font-size: 20px; font-weight: 500; font-variant-numeric: tabular-nums; }
  [data-testid="stMetricValue"], [data-testid="stMetricValue"] * {
    white-space: normal !important; text-overflow: clip !important; overflow: visible !important; line-height: 28px;
  }

  /* Hinweise: blasse Paare mit 1px Kante statt gefüllter Flächen */
  [data-testid="stAlertContainer"] { padding: 10px 12px; border-radius: 6px; border: 1px solid transparent; }
  [data-testid="stAlertContainer"]:has([data-testid="stAlertContentError"]) {
    background: light-dark(#ffedea, #2c1a20); border-color: light-dark(#f6cfc9, #4a2630); }
  [data-testid="stAlertContainer"]:has([data-testid="stAlertContentError"]) * { color: light-dark(#831c1e, #f19aa8); }
  [data-testid="stAlertContainer"]:has([data-testid="stAlertContentWarning"]) {
    background: light-dark(#fffbeb, #2a2210); border-color: light-dark(#fde68a, #4d3d12); }
  [data-testid="stAlertContainer"]:has([data-testid="stAlertContentWarning"]) * { color: light-dark(#92400e, #f3c97a); }
  [data-testid="stAlertContainer"]:has([data-testid="stAlertContentInfo"]) {
    background: light-dark(#f5f6f8, #161616); border-color: var(--line); }
  [data-testid="stAlertContainer"]:has([data-testid="stAlertContentInfo"]) * { color: inherit; }

  /* Eingaben: weiß mit Linie (secondaryBackgroundColor), Textfeld mit ruhiger Zeilenhöhe */
  .stTextArea textarea { line-height: 22px; font-size: 14px; background: transparent; }

  /* Primär-Button: Tinte, im Dunkeln invertiert; Druck-Feedback statt Schatten */
  button[kind="primary"], button[kind="primaryFormSubmit"] { font-weight: 500; }
  button[kind="primary"], button[kind="primary"] *, button[kind="primaryFormSubmit"],
  button[kind="primaryFormSubmit"] * { color: light-dark(#ffffff, #0a0a0a) !important; }
  button { transition: transform 160ms var(--ease-out), background-color 150ms ease, border-color 150ms ease; }
  button:active:not(:disabled) { transform: scale(0.97); }
  @media (prefers-reduced-motion: reduce) {
    button { transition: background-color 150ms ease, border-color 150ms ease; }
    button:active:not(:disabled) { transform: none; }
  }

  /* Daten: der eine Ton auf Fortschritt und Konfidenz */
  [data-testid="stProgressBarTrack"] { background: light-dark(#eceef1, #262626) !important; height: 6px; }
  [data-testid="stProgressBarTrack"] > div { background: var(--hue) !important; }

  /* Tabellen und Code */
  [data-testid="stDataFrame"] { border-radius: 6px; }
  [data-testid="stCode"] pre { font-size: 13px; line-height: 20px; max-height: 24rem; }

  /* Seitenleiste auf dem Seitengrund, aktive Seite als graue Pille */
  [data-testid="stSidebar"] { background: light-dark(#f2f4f7, #0a0a0a); }
  [data-testid="stSidebarNavLink"] { border-radius: 6px; }
  [data-testid="stSidebarNavLink"][aria-current="page"] { background: light-dark(#e6e8ec, #1f1f1f); }
  [data-testid="stSidebarUserContent"] { padding-top: 4px; }
</style>
"""


def apply_theme() -> None:
    st.markdown(_CSS, unsafe_allow_html=True)
    st.logo(str(ASSETS / "logo.svg"), icon_image=str(ASSETS / "icon.svg"), size="large")
