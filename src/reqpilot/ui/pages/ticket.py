"""Ticketersteller: Freitext → Vorgabemaske, Stream/Epic/Priorität, Duplikatprüfung, Anlage in Jira.

Frage der Seite: "Ist mein Ticket im Standard, und gibt es das Thema schon?" Links die Eingabe, rechts die
Vorgabemaske, automatisch befüllt und editierbar. Vor dem ersten Lauf zeigt rechts die neuesten Tickets.
Regeln: genau ein Stream je Ticket, neue Epics nur für Rollen aus epic_create_roles, Autor = angemeldete Person.
"""

from dataclasses import replace

import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable, WriteDisabled
from reqpilot.services.jira_payload import OneStreamOnly, issue_fields
from reqpilot.services.ticket_writer import to_jira_markup
from reqpilot.ui.components import badge_md, card_title, confidence_badge_md, kpi_strip, page_header
from reqpilot.ui.i18n import t
from reqpilot.ui.state import current_country, current_role, current_user, display_name, get_container

c = get_container()
EXAMPLES = ("ticket.example_1", "ticket.example_2", "ticket.example_3")
RECENT_ROWS = 8
NEW_EPIC = "__new__"

page_header("ticket")
work, result_col = st.columns([5, 7])

with work, st.container(key="card_input"):
    card_title("ticket.input_card", "ticket.input_card_help")
    example = st.pills(
        t("ticket.examples"), EXAMPLES, format_func=lambda k: t(f"{k}_label"), help=t("ticket.examples_help")
    )
    if example and st.session_state.get("_example_used") != example:
        st.session_state["ticket_text"] = t(example)
        st.session_state["_example_used"] = example

    with st.form("ticket_form", border=False):
        countries = list(c.app_config.countries)
        country = st.selectbox(
            t("ticket.country"),
            countries,
            index=countries.index(current_country()) if current_country() in countries else 0,
            help=t("ticket.country_help"),
        )
        text = st.text_area(
            t("ticket.input"),
            key="ticket_text",
            height=300,
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
    st.session_state["ticket_result"] = (draft, classification, duplicates, dup_error, text)
    # Vorgabemaske mit dem Entwurf vorbelegen; danach gehören die Felder der Person
    top_stream = classification.suggestions[0].stream
    seed = dict(
        f_title=draft.title,
        f_role=draft.role,
        f_goal=draft.goal,
        f_benefit=draft.benefit,
        f_criteria="\n".join(draft.acceptance_criteria),
        f_background=draft.background,
        f_priority=draft.priority,
        f_country=draft.country,
        f_stream=None if classification.uncertain else top_stream.id,
        f_epic=classification.epic.key if classification.epic and not classification.uncertain else None,
        f_new_epic="",
    )
    st.session_state["ticket_seed"] = seed
    st.session_state.update(seed)
    st.session_state.pop("ticket_created", None)

if "ticket_result" not in st.session_state:
    with result_col, st.container(key="card_recent"):
        card_title("ticket.recent_title", "ticket.recent_help")
        try:
            recent = sorted(c.jira.search_issues(), key=lambda i: i.updated, reverse=True)[:RECENT_ROWS]
        except SourceUnavailable as exc:
            recent = []
            st.error(t("error.source", detail=str(exc)))
        for issue in recent:
            st.markdown(
                t(
                    "ticket.recent_row",
                    key=issue.key,
                    url=issue.url,
                    summary=issue.summary,
                    stream=issue.stream or "–",
                    status=issue.status.capitalize(),
                )
            )
    st.stop()

draft, classification, duplicates, dup_error, source_text = st.session_state["ticket_result"]
# Streamlit räumt Widget-Werte beim Seitenwechsel ab; dann gilt wieder der Entwurf
for name, value in st.session_state["ticket_seed"].items():
    st.session_state.setdefault(name, value)
likely_dupes = [d for d in duplicates if d.level == "duplicate"]
streams = {s.id: s for s in c.streams.active()}
scores = {s.stream.id: s.confidence for s in classification.all_scores}
user, role = current_user(), current_role()
may_create_epic = c.app_config.may_create_epic(role)

with result_col, st.container(key="card_result"):
    card_title("ticket.result_title")
    if likely_dupes:
        st.error(t("ticket.duplicate_found"), icon=":material/content_copy:")
    if classification.multi_stream:
        st.warning(t("ticket.multi_stream"), icon=":material/call_split:")
        for part in classification.split_proposal:
            st.markdown(t("ticket.split_part", stream=part.stream.name, text=part.text))
    if draft.notice:
        st.info(draft.notice, icon=":material/info:")
    kpi_slot = st.container()

    tab_mask, tab_export = st.tabs([t("ticket.tab_mask"), t("ticket.tab_export")])

    with tab_mask:
        st.text_input(t("ticket.f_title"), key="f_title", max_chars=120, help=t("ticket.f_title_help"))
        r1, r2 = st.columns([3, 1])
        r1.text_input(t("ticket.f_role"), key="f_role", help=t("ticket.f_role_help"))
        r2.selectbox(t("ticket.country"), c.app_config.countries, key="f_country", help=t("ticket.country_help"))
        st.text_area(t("ticket.f_goal"), key="f_goal", height=68, help=t("ticket.f_goal_help"))
        st.text_input(t("ticket.f_benefit"), key="f_benefit", help=t("ticket.f_benefit_help"))
        st.text_area(t("ticket.f_criteria"), key="f_criteria", height=110, help=t("ticket.f_criteria_help"))
        st.text_area(t("ticket.f_background"), key="f_background", height=68, help=t("ticket.f_background_help"))

        s1, s2, s3 = st.columns([4, 4, 3])
        stream_id = s1.selectbox(
            t("ticket.f_stream"),
            list(streams),
            key="f_stream",
            format_func=lambda sid: streams[sid].name,
            placeholder=t("ticket.f_stream_pick"),
            help=t("ticket.f_stream_help"),
        )
        if stream_id:
            s1.markdown(confidence_badge_md(scores.get(stream_id, 0.0)))
        epic_options = [e.key for e in streams[stream_id].epics] if stream_id else []
        if may_create_epic:
            epic_options.append(NEW_EPIC)
        if st.session_state.get("f_epic") not in epic_options:
            st.session_state["f_epic"] = None
        epics = {e.key: e.title for s in streams.values() for e in s.epics}
        epic_key = s2.selectbox(
            t("ticket.f_epic"),
            epic_options,
            key="f_epic",
            format_func=lambda k: t("ticket.f_epic_new") if k == NEW_EPIC else f"{k} · {epics.get(k, '')}",
            placeholder=t("ticket.f_epic_pick"),
            help=t("ticket.f_epic_help"),
        )
        if not may_create_epic:
            s2.caption(t("ticket.epic_locked", role=role))
        priority = s3.selectbox(
            t("ticket.f_priority"), c.app_config.priorities, key="f_priority", help=t("ticket.f_priority_help")
        )
        if epic_key == NEW_EPIC:
            st.text_input(t("ticket.f_new_epic"), key="f_new_epic", help=t("ticket.f_new_epic_help"))

        criteria = [x.strip("-* ").strip() for x in st.session_state["f_criteria"].splitlines() if x.strip()]
        edited = replace(
            draft,
            title=st.session_state["f_title"].strip() or draft.title,
            role=st.session_state["f_role"],
            goal=st.session_state["f_goal"],
            benefit=st.session_state["f_benefit"],
            acceptance_criteria=criteria,
            background=st.session_state["f_background"],
            priority=priority,
            country=st.session_state["f_country"],
        )
        advice = c.priority_advisor.assess(f"{source_text} {edited.as_text()}", priority)
        reasons = " ".join(advice.reasons)
        order = c.app_config.priorities  # höchste zuerst
        if advice.agrees:
            st.caption(t("ticket.priority_ok", priority=priority, reasons=reasons))
        else:
            higher = order.index(advice.recommended) < order.index(priority)
            st.warning(
                t(
                    "ticket.priority_higher" if higher else "ticket.priority_check",
                    chosen=priority,
                    recommended=advice.recommended,
                    reasons=reasons,
                ),
                icon=":material/flag:",
            )

    new_epic = st.session_state.get("f_new_epic", "").strip()
    epic_ref = (t("ticket.epic_new_ref", title=new_epic) if new_epic else None) if epic_key == NEW_EPIC else epic_key
    stream_name = streams[stream_id].name if stream_id else None
    markup = to_jira_markup(edited, stream_name=stream_name, epic_key=epic_ref)

    with kpi_slot:
        kpi_strip(
            "ticket",
            [
                (
                    t("ticket.m_format"),
                    t("ticket.m_complete")
                    if edited.acceptance_criteria and not draft.open_questions
                    else t("ticket.m_questions", n=max(len(draft.open_questions), 1)),
                    None,
                ),
                (t("ticket.m_stream"), stream_name.split(" (")[0] if stream_name else t("ticket.m_unclear"), None),
                (t("ticket.m_priority"), advice.recommended, t("ticket.m_priority_help")),
                (t("ticket.m_similar"), len(duplicates), t("ticket.m_similar_help")),
            ],
        )

    # Ähnliche Tickets und Seiten links unter der Eingabe: sichtbar neben der Maske, mit Link zum Öffnen
    with work, st.container(key="card_similar"):
        card_title("ticket.similar_title", "ticket.similar_help", n=len(duplicates))
        if dup_error:
            st.error(t("error.source", detail=dup_error))
        elif not duplicates:
            st.caption(t("ticket.no_similar"))
        with st.container(height=260, border=False, key="scroll_similar"):
            for d in duplicates:
                is_dup = d.level == "duplicate"
                level = badge_md(
                    t("ticket.level_duplicate") if is_dup else t("ticket.level_similar"),
                    "red" if is_dup else "gray",
                    ":material/content_copy:" if is_dup else ":material/link:",
                )
                kind = t(f"source.{d.hit.source}")
                row = t("ticket.similar_row", title=d.hit.title, url=d.hit.url, pct=round(d.hit.score * 100), kind=kind)
                st.markdown(f"{level}  \n{row}")

    with tab_export:
        st.markdown(t("ticket.author", user=display_name(user) or t("ticket.author_unknown"), role=role))
        if draft.open_questions:
            st.caption(t("ticket.questions_line", questions=" · ".join(draft.open_questions)))
        st.code(markup, language=None, wrap_lines=True)
        try:
            fields = issue_fields(
                edited,
                project=c.app_config.jira_project,
                reporter=user,
                stream_id=stream_id,
                stream_name=stream_name,
                epic_key=None if epic_key == NEW_EPIC else epic_key,
                epic_link_field=c.app_config.epic_link_field,
                multi_stream=classification.multi_stream,
            )
            blocked = None
        except OneStreamOnly as exc:
            fields, blocked = None, str(exc)
        if not c.jira_writer.enabled:
            blocked = t("ticket.create_disabled")
        b1, b2 = st.columns(2)
        b1.download_button(
            t("ticket.download"),
            markup,
            file_name="ticket.txt",
            mime="text/plain",
            icon=":material/download:",
            width="stretch",
        )
        if b2.button(
            t("ticket.create_in_jira"),
            type="primary",
            disabled=blocked is not None,
            help=blocked,
            icon=":material/lock:" if blocked else ":material/send:",
            width="stretch",
        ):
            try:
                st.session_state["ticket_created"] = c.jira_writer.create_issue(fields)
            except (WriteDisabled, SourceUnavailable) as exc:
                st.error(t("error.source", detail=str(exc)))
        if blocked and c.jira_writer.enabled:
            st.caption(blocked)
        if created := st.session_state.get("ticket_created"):
            st.success(t("ticket.created", key=created), icon=":material/check_circle:")
