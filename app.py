"""Einstieg für Databricks Apps und lokal: streamlit run app.py"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

import streamlit as st  # noqa: E402

from lidlalign.config import ConfigError  # noqa: E402
from lidlalign.ui.i18n import t  # noqa: E402
from lidlalign.ui.pages_registry import PAGES  # noqa: E402
from lidlalign.ui.state import get_container  # noqa: E402
from lidlalign.ui.theme import apply_theme  # noqa: E402

PAGES_DIR = Path(__file__).parent / "src" / "lidlalign" / "ui" / "pages"

st.set_page_config(page_title=t("app.title"), page_icon=":material/fact_check:", layout="wide")
apply_theme()

try:
    container = get_container()
except ConfigError as exc:
    st.error(t("error.config", detail=str(exc)))
    st.stop()

with st.sidebar:
    st.markdown(f"### {t('app.title')}")
    st.caption(t("app.tagline"))
    data_mode = t("app.mode_mock") if container.settings.data_source == "mock" else t("app.mode_live")
    llm_mode = t("app.llm_gemini") if container.llm.available else t("app.llm_offline")
    st.caption(f"{data_mode} · {llm_mode}")
    for notice in container.notices:
        st.warning(notice)

nav = st.navigation(
    [st.Page(PAGES_DIR / f"{p.module}.py", title=t(p.title_key), icon=p.icon, url_path=p.module) for p in PAGES]
)
nav.run()
