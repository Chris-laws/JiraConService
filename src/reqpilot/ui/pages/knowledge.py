"""Wissensabfrage über Jira und Confluence."""

import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.ui.i18n import t
from reqpilot.ui.state import get_container

c = get_container()

st.title(t("knowledge.title"))
st.caption(t("knowledge.intro"))

with st.form("knowledge_form"):
    question = st.text_input(t("knowledge.question"), placeholder=t("knowledge.placeholder"), help=t("knowledge.help"))
    asked = st.form_submit_button(t("knowledge.submit"), type="primary")

if asked and question.strip():
    try:
        with st.spinner(t("knowledge.working")):
            answer = c.knowledge.ask(question)
    except SourceUnavailable as exc:
        st.error(t("error.source", detail=str(exc)))
        st.stop()
    if answer.notice:
        st.info(answer.notice, icon=":material/info:")
    with st.container(border=True):
        st.markdown(answer.text)
    if answer.sources:
        st.markdown(f"**{t('knowledge.sources')}**")
        for n, hit in enumerate(answer.sources, 1):
            st.markdown(t("knowledge.source_row", n=n, title=hit.title, url=hit.url, source=hit.source))
