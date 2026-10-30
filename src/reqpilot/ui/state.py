"""Gemeinsamer Zustand der Seiten: Container (einmal pro Prozess) und angemeldete Person."""

from __future__ import annotations

import streamlit as st

from reqpilot.config import load_settings
from reqpilot.container import Container, build_container
from reqpilot.ui.i18n import t

USER_HEADER = "X-Forwarded-Email"  # setzt Databricks Apps nach dem Workspace-Login


@st.cache_resource(show_spinner=False)
def get_container() -> Container:
    return build_container(load_settings())


def header_user() -> str | None:
    try:
        value = st.context.headers.get(USER_HEADER)
    except Exception:  # noqa: BLE001 - außerhalb eines Requests (z. B. Tests) gibt es keine Header
        return None
    return value.strip().lower() if value else None


def current_user() -> str | None:
    """Angemeldete Person: aus dem Databricks-Login, im Testbetrieb aus der Auswahl in der Seitenleiste."""
    return header_user() or st.session_state.get("sb_user")


def current_role() -> str:
    """Rolle laut settings.yaml. Im Testbetrieb lässt sie sich in der Seitenleiste umschalten."""
    c = get_container()
    if c.settings.data_source == "mock" and st.session_state.get("sb_role"):
        return st.session_state["sb_role"]
    return c.app_config.role_for(current_user())


def current_country() -> str:
    c = get_container()
    return st.session_state.get("sb_country") or c.app_config.countries[0]


def phase_label(status: str) -> str:
    """Kurzer Name einer Jira-Phase (phase.<status> in strings), sonst der Status selbst."""
    key = "phase." + status.lower().replace(" ", "_")
    label = t(key)
    return status.capitalize() if label == key else label


def display_name(email: str | None) -> str:
    """Anzeigename aus der E-Mail (vorname.nachname@… → Vorname Nachname); Jira bekommt weiter die E-Mail."""
    if not email:
        return ""
    local = email.split("@", 1)[0]
    return " ".join(part.capitalize() for part in local.replace("_", ".").split(".") if part)
