"""Einstieg für Databricks Apps und lokal: streamlit run app.py"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

import streamlit as st  # noqa: E402

from reqpilot.config import ConfigError  # noqa: E402
from reqpilot.ui.i18n import t  # noqa: E402
from reqpilot.ui.pages_registry import PAGES  # noqa: E402
from reqpilot.ui.state import current_role, display_name, get_container, header_user  # noqa: E402
from reqpilot.ui.theme import ASSETS, apply_theme  # noqa: E402

PAGES_DIR = Path(__file__).parent / "src" / "reqpilot" / "ui" / "pages"

st.set_page_config(page_title=t("app.title"), page_icon=str(ASSETS / "icon.svg"), layout="wide")
apply_theme()

try:
    container = get_container()
except ConfigError as exc:
    st.error(t("error.config", detail=str(exc)))
    st.stop()

nav = st.navigation(
    [
        st.Page(PAGES_DIR / f"{p.module}.py", title=t(p.title_key), icon=p.icon, url_path=p.module, default=n == 0)
        for n, p in enumerate(PAGES)
    ]
)

with st.sidebar:
    st.caption(t("app.tagline"))
    live = container.settings.data_source == "live"
    cfg = container.app_config
    with st.container(key="side_who"):
        user = header_user()
        if user:
            st.markdown(t("app.signed_in", user=display_name(user)))
        elif hasattr(container.jira, "reporters"):
            st.selectbox(
                t("app.pick_user"),
                container.jira.reporters(),
                key="sb_user",
                format_func=display_name,
                help=t("app.pick_user_help"),
                on_change=lambda: st.session_state.pop("sb_role", None),
            )
        if live:
            st.badge(t("app.role", role=current_role()), color="gray", icon=":material/badge:")
        else:
            st.segmented_control(
                t("app.pick_role"),
                list(cfg.roles),
                key="sb_role",
                default=cfg.role_for(st.session_state.get("sb_user")),
                help=t("app.pick_role_help"),
            )
        st.selectbox(t("app.country"), list(cfg.countries), key="sb_country", help=t("app.country_help"))
    st.badge(
        t("app.mode_live") if live else t("app.mode_mock"),
        color="green" if live else "gray",
        icon=":material/database:",
    )
    st.badge(
        t("app.llm_gemini") if container.llm.available else t("app.llm_offline"),
        color="blue" if container.llm.available else "gray",
        icon=":material/auto_awesome:",
    )
    for notice in container.notices:
        st.warning(notice)

nav.run()
