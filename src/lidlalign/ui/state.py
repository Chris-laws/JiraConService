"""Gemeinsamer Zustand der Seiten: Container (einmal pro Prozess) und angemeldete Person."""

from __future__ import annotations

import streamlit as st

from lidlalign.config import load_settings
from lidlalign.container import Container, build_container

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
