"""Ticketersteller: Freitext → Standardformat, Stream-Vorschlag, Duplikatprüfung.

Aufbau als Arbeitsfläche: links die Eingabe, rechts das Ergebnis, damit nichts unter der Falz verschwindet.
"""

import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.services.ticket_writer import to_jira_markup
from reqpilot.ui.components import badge_md, card_title, confidence_badge_md, page_header, tile
from reqpilot.ui.i18n import t
from reqpilot.ui.state import get_container

c = get_container()
EXAMPLES = ("ticket.example_1", "ticket.example_2", "ticket.example_3")

page_header("ticket", "ticket.steps")
work, result_col = st.columns([5, 7], gap="medium")

with work, st.container(key="card_input"):
    card_title("ticket.input_card", "ticket.input_card_help")
    example = st.pills(
        t("ticket.examples"), EXAMPLES, format_func=lambda k: t(f"{k}_label"), help=t("ticket.examples_help")
    )
    if example and st.session_state.get("_example_used") != example:
        st.session_state["ticket_text"] = t(example)
        st.session_state["_example_used"] = example

    with st.form("ticket_form", border=False):
        country = st.selectbox(t("ticket.country"), c.app_config.countries, help=t("ticket.country_help"))
        text = st.text_area(
            t("ticket.input"),
            key="ticket_text",
            height=280,
            placeholder=t("ticket.placeholder"),
            help=t("ticket.input_help"),
        )
        submitted = st.form_submit_button(
            t("ticket.submit"), type="primary", icon=":material/auto_awesome:", width="stretch"
        )

if submitted:
    with st.spinner(t("ticket.working")):
        draft = c.ticket_writer.draft(text, country)
        classification = c.classifier.classify(text)
        try:
            duplicates, dup_error = c.duplicates.check(draft.as_text()), None
        except SourceUnavailable as exc:
            duplicates, dup_error = [], str(exc)
    st.session_state["ticket_result"] = (draft, classification, duplicates, dup_error)

if "ticket_result" not in st.session_state:
    with result_col, st.container(key="card_empty"):
        st.markdown(f"### {t('ticket.empty_title')}")
        st.caption(t("ticket.empty_text"))
        tile("format", ":material/description:", "ticket.tile_format", "ticket.tile_format_text")
        tile("stream", ":material/category:", "ticket.tile_stream", "ticket.tile_stream_text")
        tile("dupes", ":material/content_copy:", "ticket.tile_dupes", "ticket.tile_dupes_text")
    st.stop()

draft, classification, duplicates, dup_error = st.session_state["ticket_result"]
top = classification.suggestions[0]
likely_dupes = [d for d in duplicates if d.level == "duplicate"]
markup = to_jira_markup(
    draft,
    stream_name=None if classification.uncertain else top.stream.name,
    epic_key=classification.epic.key if classification.epic else None,
)

with result_col:
    m1, m2, m3 = st.columns([2, 3, 2])
    m1.metric(
        t("ticket.m_format"),
        t("ticket.m_complete") if not draft.open_questions else t("ticket.m_questions", n=len(draft.open_questions)),
        border=True,
    )
    m2.metric(
        t("ticket.m_stream"),
        t("ticket.m_unclear") if classification.uncertain else top.stream.name,
        border=True,
    )
    m3.metric(t("ticket.m_similar"), len(duplicates), border=True, help=t("ticket.m_similar_help"))

    if draft.notice:
        st.info(draft.notice, icon=":material/info:")
    if likely_dupes:
        st.error(t("ticket.duplicate_found"), icon=":material/content_copy:")
    if classification.multi_stream:
        st.warning(t("ticket.multi_stream"), icon=":material/call_split:")

    with st.container(key="card_result"):
        tab_ticket, tab_stream, tab_similar, tab_export = st.tabs(
            [
                t("ticket.tab_ticket"),
                t("ticket.tab_stream"),
                t("ticket.tab_similar", n=len(duplicates)),
                t("ticket.tab_export"),
            ]
        )

        with tab_ticket:
            badges = [
                badge_md(t("ticket.priority_badge", priority=draft.priority), "violet", ":material/flag:"),
                badge_md(t("ticket.country_badge", country=draft.country), "gray", ":material/public:"),
            ]
            if draft.source == "gemini":
                badges.append(badge_md(t("ticket.ai_badge"), "blue", ":material/auto_awesome:"))
            st.markdown(" ".join(badges))
            st.subheader(draft.title)
            st.markdown(t("ticket.story", role=draft.role, goal=draft.goal, benefit=draft.benefit or "…"))
            crit_col, q_col = st.columns(2) if draft.open_questions else (st.container(), None)
            with crit_col:
                st.markdown(f"**{t('ticket.criteria')}**")
                if draft.acceptance_criteria:
                    st.markdown("\n".join(f"- {crit}" for crit in draft.acceptance_criteria))
                else:
                    st.caption(t("ticket.criteria_missing"))
            if q_col:
                with q_col:
                    st.markdown(f"**{t('ticket.questions')}**")
                    st.markdown("\n".join(f"- {q}" for q in draft.open_questions))

        with tab_stream:
            if classification.uncertain:
                st.caption(t("ticket.stream_uncertain"))
            for s in classification.suggestions:
                st.markdown(f"**{s.stream.name}**  {confidence_badge_md(s.confidence)}")
                if s.matched_keywords:
                    st.caption(t("ticket.keywords", words=", ".join(s.matched_keywords)))
            if classification.epic:
                st.markdown(t("ticket.epic", key=classification.epic.key, title=classification.epic.title))
            if classification.multi_stream:
                st.markdown(f"**{t('ticket.split_title')}**")
                for part in classification.split_proposal:
                    st.markdown(t("ticket.split_part", stream=part.stream.name, text=part.text))

        with tab_similar:
            if dup_error:
                st.error(t("error.source", detail=dup_error))
            elif not duplicates:
                st.caption(t("ticket.no_similar"))
            for d in duplicates:
                is_dup = d.level == "duplicate"
                level = badge_md(
                    t("ticket.level_duplicate") if is_dup else t("ticket.level_similar"),
                    "red" if is_dup else "blue",
                    ":material/content_copy:" if is_dup else ":material/link:",
                )
                row = t("ticket.similar_row", title=d.hit.title, url=d.hit.url, pct=round(d.hit.score * 100))
                st.markdown(f"{level}  \n{row}")

        with tab_export:
            st.caption(t("ticket.export_help"))
            st.code(markup, language=None)
            b1, b2 = st.columns(2)
            b1.download_button(
                t("ticket.download"),
                markup,
                file_name="ticket.txt",
                mime="text/plain",
                icon=":material/download:",
                width="stretch",
            )
            b2.button(
                t("ticket.create_in_jira"),
                disabled=not c.jira_writer.enabled,
                help=t("ticket.create_disabled") if not c.jira_writer.enabled else None,
                icon=":material/lock:",
                width="stretch",
            )
