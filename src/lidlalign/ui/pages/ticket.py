"""Ticketersteller: Freitext → Standardformat, Stream-Vorschlag, Duplikatprüfung."""

import streamlit as st

from lidlalign.adapters.errors import SourceUnavailable
from lidlalign.services.ticket_writer import to_jira_markup
from lidlalign.ui.i18n import t
from lidlalign.ui.state import get_container
from lidlalign.ui.theme import confidence_label

c = get_container()

st.title(t("ticket.title"))
st.caption(t("ticket.intro"))

with st.form("ticket_form"):
    country = st.selectbox(t("ticket.country"), c.app_config.countries, help=t("ticket.country_help"))
    text = st.text_area(t("ticket.input"), height=180, placeholder=t("ticket.placeholder"), help=t("ticket.input_help"))
    submitted = st.form_submit_button(t("ticket.submit"), type="primary")

if submitted:
    with st.spinner(t("ticket.working")):
        draft = c.ticket_writer.draft(text, country)
        classification = c.classifier.classify(text)
        try:
            duplicates = c.duplicates.check(draft.as_text())
            dup_error = None
        except SourceUnavailable as exc:
            duplicates, dup_error = [], str(exc)
    st.session_state["ticket_result"] = (draft, classification, duplicates, dup_error)

if "ticket_result" not in st.session_state:
    st.stop()

draft, classification, duplicates, dup_error = st.session_state["ticket_result"]
if draft.notice:
    st.info(draft.notice, icon=":material/info:")

if classification.multi_stream:
    st.warning(t("ticket.multi_stream"), icon=":material/call_split:")
    for part in classification.split_proposal:
        st.markdown(t("ticket.split_part", stream=part.stream.name, text=part.text))

if any(d.level == "duplicate" for d in duplicates):
    st.error(t("ticket.duplicate_found"), icon=":material/content_copy:")

left, right = st.columns([3, 2], gap="large")

with left, st.container(border=True):
    st.subheader(draft.title)
    st.markdown(t("ticket.story", role=draft.role, goal=draft.goal, benefit=draft.benefit or "…"))
    st.markdown(f"**{t('ticket.criteria')}**")
    if draft.acceptance_criteria:
        for crit in draft.acceptance_criteria:
            st.markdown(f"- {crit}")
    else:
        st.caption(t("ticket.criteria_missing"))
    st.markdown(t("ticket.priority", priority=draft.priority))
    if draft.open_questions:
        st.markdown(f"**{t('ticket.questions')}**")
        for q in draft.open_questions:
            st.markdown(f"- {q}")

with right:
    with st.container(border=True):
        st.markdown(f"**{t('ticket.streams')}**")
        if classification.uncertain:
            st.caption(t("ticket.stream_uncertain"))
        for s in classification.suggestions:
            label = t("ticket.confidence", pct=round(s.confidence * 100), word=confidence_label(s.confidence))
            st.progress(min(max(s.confidence, 0.0), 1.0), text=f"{s.stream.name} · {label}")
            if s.matched_keywords:
                st.caption(t("ticket.keywords", words=", ".join(s.matched_keywords)))
        if classification.epic:
            st.markdown(t("ticket.epic", key=classification.epic.key, title=classification.epic.title))

    with st.container(border=True):
        st.markdown(f"**{t('ticket.similar')}**")
        if dup_error:
            st.error(t("error.source", detail=dup_error))
        elif not duplicates:
            st.caption(t("ticket.no_similar"))
        for d in duplicates:
            level = t("ticket.level_duplicate") if d.level == "duplicate" else t("ticket.level_similar")
            st.markdown(
                t(
                    "ticket.similar_row",
                    level=level,
                    title=d.hit.title,
                    url=d.hit.url,
                    pct=round(d.hit.score * 100),
                )
            )

top = classification.suggestions[0]
markup = to_jira_markup(
    draft,
    stream_name=None if classification.uncertain else top.stream.name,
    epic_key=classification.epic.key if classification.epic else None,
)
st.subheader(t("ticket.export"))
st.code(markup, language=None)
st.download_button(t("ticket.download"), markup, file_name="ticket.txt", mime="text/plain")
st.button(
    t("ticket.create_in_jira"),
    disabled=not c.jira_writer.enabled,
    help=t("ticket.create_disabled") if not c.jira_writer.enabled else None,
)
