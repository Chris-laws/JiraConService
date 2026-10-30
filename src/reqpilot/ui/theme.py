"""Optik der App: "Achromatic ledger" (Taste-Skill) mit Petrol-Seitenleiste und Lebenszyklus-Linie (Impeccable).

Grundfarben stehen als Tokens in .streamlit/config.toml. Hier nur statisches CSS ohne Nutzerdaten, die
einzige Stelle mit unsafe_allow_html. Flächenfarben laufen über light-dark(), weil .stApp das
color-scheme des aktiven Streamlit-Themes setzt. Karten sind Container mit key="card_…", Kennzahlen
Container mit key="kpis_…"; Streamlit hängt daran die Klasse .st-key-<key>.

Regeln: Seitenleiste Petrol (config.toml), Arbeitsfläche in Tinte, der eine Datenton (#1d5fbf) nur auf Daten,
keine Verläufe, keine Schatten auf ruhenden Flächen, Karten mit 1px-Linie und 8px Radius, ein Abstand (12px)
überall. Bewegung nur als Rückmeldung (Emil Kowalski): Druck auf 97 %, Hover nur mit Maus, reduced-motion.
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
  .st-key-card_input [data-testid="stTextAreaRootElement"] { flex: 1 1 auto; height: auto !important;
    min-height: 220px; }
  .st-key-card_input [data-testid="stTextAreaRootElement"] textarea { height: 100% !important; }

  /* Kennzahlen: ein Streifen, durch Haarlinien geteilt, keine Kacheln */
  .st-key-kpis_mine { border-top: none !important; padding-top: 0 !important; }
  [class*="st-key-kpis"] { gap: 0 !important; border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule); padding: 12px 0; }
  [class*="st-key-kpis"] > [data-testid="stElementContainer"] { flex: 1 1 0; min-width: 0; padding: 0 16px; }
  [class*="st-key-kpis"] > [data-testid="stElementContainer"]:first-child { padding-left: 0; }
  [class*="st-key-kpis"] > [data-testid="stElementContainer"] + [data-testid="stElementContainer"] {
    border-left: 1px solid var(--rule); }
  @media (max-width: 640px) {
    [class*="st-key-kpis"] { flex-wrap: wrap !important; row-gap: 12px !important; }
    [class*="st-key-kpis"] > [data-testid="stElementContainer"] { flex: 1 1 40%; padding-left: 0; }
    [class*="st-key-kpis"] > [data-testid="stElementContainer"] + [data-testid="stElementContainer"] {
      border-left: none; }
  }
  [data-testid="stMetric"] { padding: 0 !important; border: none !important; background: none; }
  [data-testid="stMetricLabel"] p { font-size: 12px; color: var(--muted); }
  .st-key-kpis_ticket > [data-testid="stElementContainer"]:nth-child(2) { flex-grow: 2; }
  .st-key-kpis_ticket [data-testid="stMetricValue"] { font-size: 16px; }
  .st-key-kpis_ticket > [data-testid="stElementContainer"]:nth-child(3) { flex-grow: 1.4; }
  [data-testid="stMetricValue"] * { overflow-wrap: normal; word-break: normal; hyphens: auto; }
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
  .stTextInput input { font-size: 14px; }

  /* Primär-Button: Tinte, im Dunkeln invertiert; Druck-Feedback statt Schatten */
  button[kind="primary"], button[kind="primaryFormSubmit"] { font-weight: 500; }
  button[kind="primary"], button[kind="primary"] *, button[kind="primaryFormSubmit"],
  button[kind="primaryFormSubmit"] * { color: light-dark(#ffffff, #0a0a0a) !important; }
  button[kind="primary"]:disabled, button[kind="primary"]:disabled * { color: var(--muted) !important; }
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

  /* Seitenleiste: Petrol-Schiene (Farben aus [theme.*.sidebar]), aktive Seite mit heller Marke links */
  [data-testid="stSidebarNavLink"] { border-radius: 6px; position: relative;
    transition: background-color 150ms ease; }
  [data-testid="stSidebarNavLink"][aria-current="page"] { background: rgba(255, 255, 255, 0.10); }
  [data-testid="stSidebarNavLink"][aria-current="page"]::before { content: ""; position: absolute; left: -8px;
    top: 8px; bottom: 8px; width: 3px; border-radius: 2px; background: #a8dde4; }
  @media (hover: hover) and (pointer: fine) {
    [data-testid="stSidebarNavLink"]:hover { background: rgba(255, 255, 255, 0.06); }
  }
  [data-testid="stSidebarUserContent"] { padding-top: 4px; }
  [data-testid="stSidebarUserContent"] [data-testid="stCaptionContainer"] p { color: #a9c3c8; }
  .st-key-side_who { border-top: 1px solid rgba(255, 255, 255, 0.10); padding-top: 12px; gap: 12px; }

  /* Browser-Flächen im Ton der App: Auswahl, Fokus, Scrollbalken */
  ::selection { background: light-dark(#cfe0fa, #1d3b66); }
  .stApp :focus-visible { outline: 2px solid var(--hue); outline-offset: 2px; }
  .stApp * { scrollbar-width: thin; scrollbar-color: light-dark(#c6cad0, #3a3a3a) transparent; }
  [data-testid="stSidebarResizeHandle"] { background-image: none !important; }
  [data-testid="stSidebar"] * { scrollbar-color: rgba(255, 255, 255, 0.2) transparent; }

  /* Übersicht: Kopf mit Aktion rechts */
  .st-key-dash_head { gap: 12px; flex-wrap: nowrap; }
  .st-key-dash_head > [data-testid="stLayoutWrapper"]:first-child { flex: 1 1 0; min-width: 0; width: auto; }

  /* Streamlit zieht Markdown um 1rem nach oben; in dichten Listen und Haltestellen ohne Überlappung */
  [class*="st-key-scroll"] [data-testid="stMarkdownContainer"],
  [class*="st-key-scroll"] [data-testid="stCaptionContainer"],
  [class*="st-key-stop_"] [data-testid="stMarkdownContainer"],
  [class*="st-key-stop_"] [data-testid="stCaptionContainer"] { margin-bottom: 0; }
  [class*="st-key-scroll"] [data-testid="stCaptionContainer"] p,
  [class*="st-key-stop_"] [data-testid="stCaptionContainer"] p { margin-bottom: 0; }

  /* Signatur: der Lebenszyklus als Linie mit Haltestellen. Gefüllt = dort liegen Tickets. */
  .st-key-line { position: relative; gap: 0 !important; flex-wrap: nowrap; }
  .st-key-line::before { content: ""; position: absolute; left: 6px; right: 0; top: 11px; height: 2px;
    background: var(--line); }
  .st-key-line > [data-testid="stLayoutWrapper"] { flex: 1 1 0; min-width: 0; }
  [class*="st-key-stop_"] { position: relative; padding: 26px 8px 0 0; gap: 0 !important; }
  [class*="st-key-stop_"]::before { content: ""; position: absolute; top: 5px; left: 0; width: 14px; height: 14px;
    box-sizing: border-box; border-radius: 50%; background: var(--surface); border: 2px solid var(--line); }
  [class*="st-key-stop_on"]::before { background: var(--hue); border-color: var(--hue); }
  [class*="st-key-stop_"] [data-testid="stMarkdownContainer"] p { font-size: 22px; line-height: 28px;
    font-variant-numeric: tabular-nums; margin: 0; }
  [class*="st-key-stop_off"] [data-testid="stMarkdownContainer"] p { color: var(--muted); }
  [class*="st-key-stop_"] [data-testid="stCaptionContainer"] p { font-size: 12px; line-height: 16px; }
  @media (max-width: 760px) {
    .st-key-line { flex-wrap: wrap; row-gap: 12px !important; }
    .st-key-line::before { display: none; }
    .st-key-line > [data-testid="stLayoutWrapper"] { flex: 1 1 30%; }
  }

  /* Ähnliche Treffer füllen die Spalte bis zur Unterkante der Vorgabemaske und scrollen darin */
  .st-key-card_similar > [data-testid="stLayoutWrapper"]:has(> .st-key-scroll_similar) {
    flex: 1 1 0; min-height: 200px; contain: size; }
  .st-key-scroll_similar { height: 100% !important; }

  /* Listen in Widgets fester Höhe: Haarlinie zwischen Zeilen, ruhiger Hover nur mit Maus */
  [class*="st-key-scroll"] > [data-testid="stVerticalBlock"],
  [class*="st-key-scroll"] { gap: 0 !important; }
  [class*="st-key-scroll"] [data-testid="stElementContainer"],
  [class*="st-key-bugrow"] { padding: 8px 6px; border-radius: 6px; transition: background-color 150ms ease; }
  [class*="st-key-scroll"] > [data-testid="stElementContainer"] + [data-testid="stElementContainer"],
  [class*="st-key-scroll"] > [data-testid="stLayoutWrapper"] + [data-testid="stLayoutWrapper"] {
    border-top: 1px solid var(--rule); }
  [class*="st-key-bugrow"] [data-testid="stElementContainer"] { padding: 0; }
  [class*="st-key-scroll"] [data-testid="stMarkdownContainer"] p { margin: 0; line-height: 20px; }
  .st-key-scroll_mine > [data-testid="stElementContainer"]:has(.stProgress) { padding-top: 0;
    border-top: none !important; }
  @media (hover: hover) and (pointer: fine) {
    [class*="st-key-scroll"] > [data-testid="stElementContainer"]:hover,
    [class*="st-key-bugrow"]:hover { background: light-dark(#f5f6f8, #171717); }
  }
  [class*="st-key-bugrow"] { flex-wrap: nowrap !important; }
  [class*="st-key-bugrow"] > [data-testid="stElementContainer"]:first-child { flex: 1 1 0; min-width: 0; }
</style>
"""


def apply_theme() -> None:
    st.markdown(_CSS, unsafe_allow_html=True)
    st.logo(str(ASSETS / "logo.svg"), icon_image=str(ASSETS / "icon.svg"), size="large")
