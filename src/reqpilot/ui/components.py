"""Wiederkehrende UI-Bausteine, damit alle Seiten gleich aufgebaut sind."""

from __future__ import annotations

import streamlit as st

from reqpilot.ui.i18n import t

HIGH = 0.7
MEDIUM = 0.4


def page_header(prefix: str, extra_key: str | None = None) -> None:
    """Hero-Band mit <prefix>.title, <prefix>.intro und optional einer Zusatzzeile."""
    with st.container(key="hero"):
        st.title(t(f"{prefix}.title"))
        st.caption(t(f"{prefix}.intro"))
        if extra_key:
            st.markdown(t(extra_key))


def card_title(title_key: str, caption_key: str | None = None) -> None:
    """Kopfzeile einer Karte: fetter Titel, optional eine Erklärung darunter."""
    st.markdown(f"**{t(title_key)}**")
    if caption_key:
        st.caption(t(caption_key))


def tile(key: str, icon: str, title_key: str, text_key: str) -> None:
    """Kleine Info-Kachel für leere Zustände."""
    with st.container(key=f"tile_{key}"):
        st.markdown(f"{icon} **{t(title_key)}**")
        st.caption(t(text_key))


def confidence_level(confidence: float) -> str:
    if confidence >= HIGH:
        return "high"
    if confidence >= MEDIUM:
        return "medium"
    return "low"


def confidence_label(confidence: float) -> str:
    """Konfidenz als Wort, damit die Aussage nicht nur über Farbe/Zahl transportiert wird."""
    return t(f"conf.{confidence_level(confidence)}")


_BADGE_COLOR = {"high": "green", "medium": "orange", "low": "gray"}
_BADGE_ICON = {"high": ":material/verified:", "medium": ":material/help:", "low": ":material/remove:"}


def badge_md(text: str, color: str, icon: str = "") -> str:
    """Markdown-Badge, damit mehrere Badges in einer Zeile neben Text stehen können."""
    safe = text.replace("[", "(").replace("]", ")")
    return f":{color}-badge[{icon} {safe}]" if icon else f":{color}-badge[{safe}]"


def confidence_badge_md(confidence: float) -> str:
    level = confidence_level(confidence)
    label = t("conf.badge", pct=round(confidence * 100), word=confidence_label(confidence))
    return badge_md(label, _BADGE_COLOR[level], _BADGE_ICON[level])


def confidence_badge(confidence: float) -> None:
    st.markdown(confidence_badge_md(confidence))


def section(title_key: str, caption_key: str | None = None) -> None:
    st.markdown(f"#### {t(title_key)}")
    if caption_key:
        st.caption(t(caption_key))
